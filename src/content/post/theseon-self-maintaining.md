---
title: "Making the Engine Self-Maintaining: Compaction, Caching, and Durability"
description: "How the manifest, leveled compaction, block cache, and write batches turned Theseon into a self-maintaining storage engine."
publishDate: "2026-03-18"
updatedDate: "2026-03-22"
tags: ["go", "databases", "lsm-tree", "theseon", "compaction", "manifest", "caching", "mmap"]
order: 4
---

At the end of the [last post](/posts/theseon-wiring-it-together/), [Theseon](https://github.com/ulixert/theseon) could write keys, flush memtables to SSTables, and recover from crashes via the WAL. It worked, but it had two problems that made it useless for anything beyond a demo:

1. **Flushed data disappeared on restart.** The engine wrote SSTables to disk, then deleted the WAL. On restart, it had no record of those SSTables. The data was sitting right there in `.sst` files, invisible.

2. **L0 grew without bound.** Every flush added another SSTable to L0. Nothing ever cleaned up. After enough writes, point lookups degraded linearly — a `Get` that missed bloom filters on 100 L0 files did 100 block reads.

This post covers everything that turned Theseon from a working prototype into a self-maintaining storage engine: a manifest for persistent state, leveled compaction, a block cache, write batches, backpressure, and benchmarks to prove it all works.

## The Manifest

The manifest is an append-only log that records every structural change to the LSM tree. On startup, replay the manifest to reconstruct which SSTables exist, what level they're in, and what key ranges they cover. This is the source of truth — if a `.sst` file exists on disk but isn't in the manifest, it's garbage from a failed operation.

```
Manifest Record Format:

  [checksum: 4 bytes]  CRC32 of everything after checksum
  [length:   4 bytes]  byte length of (type + payload)
  [type:     1 byte]
  [payload:  ...]

Record Types:
  1 = SSTableAdded    { id, level, first_key, last_key }
  2 = SSTableRemoved  { id, level }
  3 = Snapshot        { full list of all live SSTables }
  4 = NextIDs         { next_mem_id, next_seq }
```

The snapshot record exists to bound replay time. Without it, recovery would replay every add and remove since the beginning of time. With periodic snapshots (every 64 records), recovery jumps to the last snapshot and replays only what came after.

The `NextIDs` record solves a subtle problem. Before the manifest, `next_seq` was recovered by scanning WAL entries for the highest sequence number. But once a memtable flushes, its WAL gets deleted. If *all* memtables flush and the engine restarts, there are no WAL entries to scan — `next_seq` resets to zero, and new writes collide with old ones in the SSTables. Persisting `next_seq` and `next_mem_id` in the manifest means they survive WAL deletion.

### The crash safety rule

The manifest must be written *before* the in-memory state is updated. If the engine crashes between the manifest write and the memory update, recovery replays the manifest and reaches the correct state. If the order were reversed — update memory first, then write the manifest — a crash after the memory update but before the manifest write would lose the structural change.

```
Flush Path (crash-safe ordering):

  1. Write SSTable to disk (write → fsync → rename → fsync dir)
  2. Append SSTableAdded to manifest (fsync)
  3. Update in-memory state (add to L0 array, remove from immutables)
  4. Delete WAL file

Crash at any point:
  After 1, before 2 → orphan .sst file, manifest doesn't know about it, ignored
  After 2, before 3 → manifest has the SSTable, recovery reconstructs it
  After 3, before 4 → WAL replayed on recovery, duplicate writes are idempotent
```

### Recovery order

```
  Manifest (SSTables + level assignments + next IDs)
      │
      ▼
  Open SSTables listed in manifest
      │
      ▼
  Replay WAL files (rebuild unflushed memtables)
      │
      ▼
  Reconcile: max(manifest next_seq, WAL max_seq) + 1
```

The reconcile step handles the edge case where the manifest's `next_seq` is stale because writes happened after the last manifest update but before the crash.

## Leveled Compaction

With the manifest in place, the engine can track SSTables persistently. Now it needs to clean up after itself.

```
L0:  [SST-5] [SST-4] [SST-3]     ← overlapping key ranges (from flushes)
       │        │        │
       └────────┼────────┘
                │  compact when count > 4
                ▼
L1:  [SST-10      ][SST-11      ][SST-12      ]   ← sorted, non-overlapping
                                    │
                                    │  compact when level size > target (10x ratio)
                                    ▼
L2:  [SST-20          ][SST-21          ]          ← sorted, non-overlapping
```

L0 is special: its SSTables have overlapping key ranges because each one is a direct flush from a memtable. L1 and below are sorted runs — non-overlapping within each level, which means a point lookup needs to check at most one file per level.

**L0 → L1:** Pick all L0 files. Compute the union of their key ranges. Find every L1 file that overlaps that range. Merge everything through the `MergeIterator`, write new L1 files, remove the old ones.

**Ln → Ln+1:** Pick one file from Ln. Find all overlapping files in Ln+1. Merge, write new outputs, remove old inputs.

The overlap check uses user key comparison, not internal key comparison. Internal keys include sequence number suffixes, and comparing those would produce false negatives — two files covering the same user key range might appear non-overlapping because of different sequence numbers.

### The picker/executor split

Compaction is split into two pieces that don't know about each other:

The **picker** decides *what* to compact. It scans the LSM state and returns a task: "compact these L0 files with these overlapping L1 files" or "compact this L1 file with these overlapping L2 files." Priority: L0 first (if file count exceeds the trigger), then whichever level's total size exceeds its target.

The **executor** does the merge. It takes a task, creates a `MergeIterator` over all inputs, writes new SSTables (splitting at the target file size), and returns the results. It doesn't touch any shared state — the caller handles manifest writes and in-memory state swaps atomically.

This separation matters because the executor runs without holding the DB lock. It reads from input files (which are immutable) and writes to new files. Only the final step — swapping the old files out and the new files in — needs the lock, and it's fast.

### Reference counting

This is the hardest part of compaction, and the place where a subtle bug cost me time.

The problem: compaction wants to delete old SSTables, but active iterators might still be reading them. You can't delete a file that an open `mmap` or `Read` call depends on.

The solution is `TableHandle` — a wrapper around the SSTable reader with an atomic reference count and an obsolete flag:

```
TableHandle lifecycle:

  NewTableHandle(reader)     refcount = 1 (DB's ownership)
       │
       ├─── Iterator opens ──► Ref()    refcount = 2
       │
       ├─── Compaction ──► MarkObsolete() + Unref()
       │                       │
       │                       ▼
       │                   refcount = 1 (iterator still holds it)
       │
       └─── Iterator closes ──► Unref()  refcount = 0
                                  │
                                  ▼
                              File deleted (refcount 0 + obsolete)
```

The initial bug: `MarkObsolete` was called without `Unref`. The DB's reference (refcount=1 from creation) was never released. Even after all iterators closed, the refcount sat at 1 and the file was never deleted. The fix is to call `Unref` after removing the handle from the DB's arrays — the DB is releasing its ownership. If no iterators hold a reference, the file is deleted immediately. If an iterator is active, deletion is deferred until it calls `Close`.

### The compaction loop

A background goroutine runs alongside the flush goroutine. After each flush, a signal triggers compaction. The loop: pick a task → ref all input handles (so they aren't deleted mid-merge) → execute → unref inputs → apply the result (manifest write + in-memory swap + mark obsolete + unref).

```
compactionLoop:

  for {
      wait for signal (flush completed or timer)
      │
      ▼
      picker.Pick(state) → task?
      │                     │
      no task               task found
      │                     │
      continue              ▼
                        Ref all input handles
                            │
                            ▼
                        executor.Run(task) → new SSTables
                            │
                            ▼
                        Unref input handles
                            │
                            ▼
                        Apply result:
                          1. Write manifest (add outputs, remove inputs)
                          2. Swap in-memory state
                          3. MarkObsolete + Unref old handles
  }
```

## Block Cache

Every `Get` that hits an SSTable reads a block from disk — even if the same block was read a millisecond ago. The block cache fixes this.

```
Read path with cache:

  Get("user-key")
      │
      ▼
  Memtable (miss)
      │
      ▼
  L0 SSTables:
    Bloom filter ──► negative → skip
                 ──► positive → index lookup → block offset
                                                    │
                                                    ▼
                                          Cache.Get(sst_id, offset)
                                                │           │
                                              hit         miss
                                                │           │
                                                ▼           ▼
                                           return      read from disk
                                                        insert into cache
                                                        return
```

The cache is a sharded LRU. Sharding reduces lock contention — instead of one mutex guarding the entire cache, each shard has its own. The cache key is `(sst_id, block_offset)`, the value is the decoded block.

One design choice worth noting: flushed memtables don't populate the cache. Flush writes are cold data — they hit the disk once and might not be read for a long time. Letting them fill the cache would evict hot blocks that are actively serving reads.

## mmap and Memory Discipline

After building the block cache, I noticed something uncomfortable about the SSTable reader. `OpenReader` called `os.ReadFile(path)` — the entire file was loaded into a heap-allocated `[]byte`. Every SSTable held open by the engine (and they're all held open) consumed its full size on the Go heap. With default level sizing:

```
L0:  4 files  × 25MB  = ~100MB
L1:  10 files × 25MB  = ~256MB
L2: 100 files × 25MB  = ~2.5GB
```

That's nearly 3GB of raw bytes on the heap, on top of memtables and the block cache. This wasn't a problem for test databases, but it would be the moment anyone loaded real data. And in the upcoming distributed layer, each node will hold its partition's full SSTable set plus a second `db.DB` for the hinted handoff store — roughly doubling the footprint.

The fix: `syscall.Mmap(fd, 0, size, PROT_READ, MAP_PRIVATE)`. Instead of copying the file into the Go heap, the OS maps it into the process's virtual address space. Physical pages are loaded on demand and managed by the kernel's page cache. Cold pages get evicted under pressure. The Go heap stays small.

The change was surprisingly contained — the existing code already treated `Reader.data` as a `[]byte` and indexed into it everywhere. Since an mmap'd region is also a `[]byte`, all block reads, index decoding, and checksum verification worked unchanged. Three things needed attention:

The **bloom filter** is a sub-slice of `Reader.data`. With mmap, it would be invalidated when the mapping is released. Since it's checked on every point lookup, I copy it to a separate heap allocation on open (~1KB per SSTable — negligible).

**`Reader.Close()`** calls `syscall.Munmap`, protected by `sync.Once` for idempotency. `DB.Close()` calls it on every live handle.

**Deleted-but-still-mapped files** are safe on Unix — `os.Remove` while a file is mmap'd keeps the inode alive until the last mapping is released. This means compaction can delete old SSTables while scan iterators safely continue reading from the mmap'd region. The `munmap` only happens at `DB.Close()`, not during compaction — adding `Ref`/`Unref` to every read path would be the correct long-term fix but is a larger refactoring for later.

The mmap switch also made the block cache actually useful — more on this in the benchmarks below.

## Structured Error Logging

The codebase had three `// TODO: log error` stubs in critical paths — flush failure, compaction execution failure, compaction apply failure. All three silently swallowed errors. A disk-full condition or corrupted SSTable would cause the background goroutine to exit without any indication, and writes would eventually block on backpressure with no error message explaining why.

The fix was adding `*slog.Logger` to `db.Options` (defaulting to `slog.Default()`) and replacing the stubs with structured `db.logger.Error(...)` calls. Small change, but important for debuggability as more moving parts are added.

## Write Batches

Individual `Put` and `Delete` calls each write a WAL record and fsync. If you need to update ten keys atomically, that's ten fsyncs. The write batch API groups them:

```go
batch := db.NewWriteBatch()
batch.Put(key1, val1)
batch.Put(key2, val2)
batch.Delete(key3)
err := batch.Commit()
```

All entries are written to the WAL as a single record (one fsync), then applied to the memtable. If the process crashes mid-apply, WAL replay re-applies the complete batch — either all entries are visible or none are. This is the atomicity guarantee that transactions in a later milestone will build on.

If the same key appears multiple times in a batch, only the last operation wins. Deduplication happens at commit time, not during `Put`/`Delete` — the batch just appends, keeping the hot path allocation-free.

## Write Backpressure

Without backpressure, writes never block. If flushes are slow (disk I/O, large memtables), immutable memtables pile up in memory without bound. The backpressure mechanism is simple: block writers when the immutable memtable count exceeds a threshold.

```go
// Inside Put and Delete:
for len(db.immutables) >= maxImmutableCount {
    db.flushDone.Wait()  // releases mu, suspends, re-acquires
}
```

`sync.Cond` is the right tool here. `Wait()` atomically releases `db.mu` and suspends the goroutine. The flush goroutine acquires `mu`, updates state, and calls `Broadcast()` to wake blocked writers. No busy-waiting, no deadlock, bounded memory.

This also surfaced a TOCTOU bug in the flush loop. The original code did two separate lock acquisitions:

```go
// Bug: TOCTOU between the two locks
db.mu.RLock()
n := len(db.immutables)
db.mu.RUnlock()       // ← another goroutine could modify immutables here

db.mu.RLock()
mt := db.immutables[n-1]  // ← index might be stale
db.mu.RUnlock()
```

The fix is one lock acquisition:

```go
db.mu.RLock()
n := len(db.immutables)
if n == 0 {
    db.mu.RUnlock()
    return
}
mt := db.immutables[n-1]
db.mu.RUnlock()
```

Check the length and access the element under the same lock. This passed 100 consecutive runs of `go test -race`.

## Benchmarks

Here are the numbers on an Apple M1 (v0.5.0 with mmap reader, `go test -bench`):

```
BenchmarkMemtable_Put_Sequential       318    3,796,776 ns/op      309 B/op      5 allocs/op
BenchmarkMemtable_Get_Hit          2,639,632        418.4 ns/op    207 B/op      2 allocs/op
BenchmarkSSTable_Get_Hit           1,085,707      1,092 ns/op      207 B/op      2 allocs/op
BenchmarkSSTable_Get_Miss            836,486      1,461 ns/op      208 B/op      2 allocs/op
BenchmarkSSTable_Get_CacheHit      1,199,043      1,008 ns/op      207 B/op      2 allocs/op
BenchmarkSSTable_Scan                    640  1,846,533 ns/op    1.3 MB     30,020 allocs/op
BenchmarkPut_WithFlush                 313    3,983,520 ns/op    2,092 B/op     11 allocs/op
BenchmarkWriteBatch_100                283    4,029,229 ns/op   54,256 B/op    419 allocs/op
```

A few things worth noting.

**Memtable get (418 ns) vs SSTable get (1,092 ns).** The skip list lookup is pure in-memory pointer chasing. The SSTable path has to check the bloom filter, binary-search the index, then binary-search the data block. The 2.6x gap is the cost of structured reads through the mmap'd file.

**SSTable miss (1,461 ns) is slower than SSTable hit (1,092 ns).** In the v0.1.0 benchmarks, misses were faster because the only data structure was the memtable — a miss was just a failed skip list lookup. Now with SSTables in the read path, a miss has to check the bloom filter on every SSTable before giving up. The bloom filter is cheap per-file, but it adds up across multiple files. This is exactly why compaction matters: fewer L0 files means fewer bloom filter checks on every miss.

**The block cache now shows a real win.** Cache hit (1,008 ns) is 8% faster than a cache miss (1,092 ns). Before the mmap switch, the cache was roughly break-even — "cold" reads were served from heap memory anyway, so the cache just added hash + mutex overhead without saving real work. With mmap, a cache miss goes through the mmap'd region (potentially a page fault for cold data), re-verifies the CRC32 checksum, and re-decodes the block. The block cache skips all of this — it returns an already-decoded `*Block` pointer directly. For truly cold data that requires disk I/O, the gap would be much larger.

**Write batch amortization.** `WriteBatch_100` at 4.0ms means ~40µs per key. A single `Put_WithFlush` is 3.98ms for one key. The batch writes 100 keys with a single WAL record and one fsync — that's roughly 100x better per-key throughput for the WAL path. The memtable insertions are the same cost either way.

## What's Next

The engine can now manage its own disk layout, cache hot data, batch writes, bound memory usage under sustained load, and manage memory efficiently via mmap. The next milestone is MVCC — timestamped keys, snapshot isolation, and optimistic transactions. The groundwork is already in place: internal keys carry sequence numbers from the beginning, and the key encoding sorts multiple versions of the same user key newest-first. No format migration needed.

The [next post](/posts/theseon-mvcc-transactions/) covers how that went — including the iterator refactor that unlocked three features at once.

---

### Read next
[**Snapshots, Transactions, and the Art of Not Blocking Writers**](/posts/theseon-mvcc-transactions/)

---

### In this series
1. [Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go](/posts/building-theseon/)
2. [The Storage Foundation](/posts/theseon-storage-foundation/)
3. [Wiring It All Together](/posts/theseon-wiring-it-together/)
4. **Making the Engine Self-Maintaining**
5. [Snapshots, Transactions, and the Art of Not Blocking Writers](/posts/theseon-mvcc-transactions/)
6. [Who's Alive? Building SWIM Failure Detection from Scratch](/posts/theseon-swim-protocol/)
7. [Quorum Reads, Quorum Writes, and the Repair That Follows](/posts/theseon-quorum-coordinator/)
8. [Buffering Writes for Dead Replicas: Hinted Handoff](/posts/theseon-hinted-handoff/)
9. [Building HNSW from Scratch](/posts/theseon-hnsw-scratch/)
10. [Making Vectors Durable](/posts/theseon-vector-kv-integration/)
11. [Fan-Out, Merge, Repair: Distributed Vector Search](/posts/theseon-distributed-vector-search/)

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- O'Neil, P., Cheng, E., Gawlick, D., & O'Neil, E. (1996). *The Log-Structured Merge-Tree (LSM-Tree)*. Acta Informatica, 33(4), 351–385.
- Luo, C., & Carey, M. J. (2020). *LSM-based Storage Techniques: A Survey*. VLDB Journal, 29(1).
- [LevelDB implementation notes](https://github.com/google/leveldb/blob/main/doc/impl.md) — manifest format, compaction strategy, and recovery. Theseon's manifest design and leveled compaction follow LevelDB's approach closely.
- [RocksDB Wiki: Leveled Compaction](https://github.com/facebook/rocksdb/wiki/Leveled-Compaction) — the L0 trigger, size ratio between levels, and file picking strategy. RocksDB's documentation is the most thorough public explanation of how leveled compaction works in practice.
- [RocksDB Wiki: Block Cache](https://github.com/facebook/rocksdb/wiki/Block-Cache) — sharded LRU design, cache key format, and the tradeoffs around caching index/filter blocks vs data blocks.
- [RocksDB Wiki: Write Batch](https://github.com/facebook/rocksdb/wiki/WriteBatch) — atomic multi-key writes, WAL integration, and the single-fsync optimization.
- [Pebble (CockroachDB)](https://github.com/cockroachdb/pebble) — reference-counted SSTables and deferred file deletion during compaction. Pebble's `TableHandle` lifecycle influenced Theseon's approach to safe file deletion while iterators are active.
- [Badger (Dgraph)](https://dgraph.io/blog/post/badger/) — Badger's design doc covers practical tradeoffs in LSM engine design, especially around value separation and compaction I/O.
