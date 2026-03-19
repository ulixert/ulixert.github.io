---
title: "Making the Engine Self-Maintaining: Compaction, Caching, and Durability"
description: "How the manifest, leveled compaction, block cache, and write batches turned LithicDB into a self-maintaining storage engine."
publishDate: "2026-03-18"
updatedDate: "2026-03-18"
tags: ["go", "databases", "lsm-tree", "lithicdb", "compaction", "manifest", "caching"]
---

At the end of the [last post](/posts/lithicdb-wiring-it-together/), [LithicDB](https://github.com/ulixert/lithicdb) could write keys, flush memtables to SSTables, and recover from crashes via the WAL. It worked, but it had two problems that made it useless for anything beyond a demo:

1. **Flushed data disappeared on restart.** The engine wrote SSTables to disk, then deleted the WAL. On restart, it had no record of those SSTables. The data was sitting right there in `.sst` files, invisible.

2. **L0 grew without bound.** Every flush added another SSTable to L0. Nothing ever cleaned up. After enough writes, point lookups degraded linearly — a `Get` that missed bloom filters on 100 L0 files did 100 block reads.

This post covers everything that turned LithicDB from a working prototype into a self-maintaining storage engine: a manifest for persistent state, leveled compaction, a block cache, write batches, backpressure, and benchmarks to prove it all works.

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

Here are the numbers on an Apple M1 (v0.3.0, `go test -bench`):

```
BenchmarkMemtable_Put_Sequential     321    3,731,371 ns/op      309 B/op      5 allocs/op
BenchmarkMemtable_Get_Hit        2,446,668        412.1 ns/op    207 B/op      2 allocs/op
BenchmarkSSTable_Get_Hit         1,118,451      1,016 ns/op      208 B/op      2 allocs/op
BenchmarkSSTable_Get_Miss          770,326      1,512 ns/op      208 B/op      3 allocs/op
BenchmarkSSTable_Get_CacheHit    1,172,491      1,084 ns/op      207 B/op      2 allocs/op
BenchmarkSSTable_Scan                  577  1,850,472 ns/op    1.3 MB     30,019 allocs/op
BenchmarkPut_WithFlush               319    3,978,317 ns/op    2,311 B/op     11 allocs/op
BenchmarkWriteBatch_100              259    4,576,243 ns/op   54,176 B/op    411 allocs/op
```

A few things worth noting.

**Memtable get (412 ns) vs SSTable get (1016 ns).** The skip list lookup is pure in-memory pointer chasing. The SSTable path has to check the bloom filter, binary-search the index, then binary-search the data block. The 2.5x gap is the cost of structured disk reads — and this is with the data already in the OS page cache.

**SSTable miss (1512 ns) is slower than SSTable hit (1016 ns).** In the v0.1.0 benchmarks, misses were faster because the only data structure was the memtable — a miss was just a failed skip list lookup. Now with SSTables in the read path, a miss has to check the bloom filter on every SSTable before giving up. The bloom filter is cheap per-file, but it adds up across multiple files. This is exactly why compaction matters: fewer L0 files means fewer bloom filter checks on every miss.

**Cache hit (1084 ns) barely beats a cold hit (1016 ns).** This looks like the block cache isn't helping, but it's misleading. The benchmark's working set fits comfortably in the OS page cache, so "cold" reads are actually served from kernel memory anyway. The block cache's real value appears when the working set exceeds available RAM — data that would cause a page fault gets served from the application-level cache instead. Benchmarking this properly requires a working set larger than physical memory, which is hard to do in a `go test -bench` run.

**Write batch amortization.** `WriteBatch_100` at 4.6ms means ~46µs per key. A single `Put_WithFlush` is 3.98ms for one key. The batch writes 100 keys with a single WAL record and one fsync — that's roughly 86x better per-key throughput for the WAL path. The memtable insertions are the same cost either way.

## What's Next

The engine can now manage its own disk layout, cache hot data, batch writes, and bound memory usage under sustained load. The next milestone is MVCC — timestamped keys, snapshot isolation, and optimistic transactions. The groundwork is already in place: internal keys carry sequence numbers from the beginning, and the key encoding sorts multiple versions of the same user key newest-first. No format migration needed.

---

*LithicDB is open source at [github.com/ulixert/lithicdb](https://github.com/ulixert/lithicdb).*

**References:**

- O'Neil, P., Cheng, E., Gawlick, D., & O'Neil, E. (1996). *The Log-Structured Merge-Tree (LSM-Tree)*. Acta Informatica, 33(4), 351–385.
- Luo, C., & Carey, M. J. (2020). *LSM-based Storage Techniques: A Survey*. VLDB Journal, 29(1).
- [LevelDB implementation notes](https://github.com/google/leveldb/blob/main/doc/impl.md) — manifest format, compaction strategy, and recovery. LithicDB's manifest design and leveled compaction follow LevelDB's approach closely.
- [RocksDB Wiki: Leveled Compaction](https://github.com/facebook/rocksdb/wiki/Leveled-Compaction) — the L0 trigger, size ratio between levels, and file picking strategy. RocksDB's documentation is the most thorough public explanation of how leveled compaction works in practice.
- [RocksDB Wiki: Block Cache](https://github.com/facebook/rocksdb/wiki/Block-Cache) — sharded LRU design, cache key format, and the tradeoffs around caching index/filter blocks vs data blocks.
- [RocksDB Wiki: Write Batch](https://github.com/facebook/rocksdb/wiki/WriteBatch) — atomic multi-key writes, WAL integration, and the single-fsync optimization.
- [Pebble (CockroachDB)](https://github.com/cockroachdb/pebble) — reference-counted SSTables and deferred file deletion during compaction. Pebble's `TableHandle` lifecycle influenced LithicDB's approach to safe file deletion while iterators are active.
- [Badger (Dgraph)](https://dgraph.io/blog/post/badger/) — Badger's design doc covers practical tradeoffs in LSM engine design, especially around value separation and compaction I/O.
