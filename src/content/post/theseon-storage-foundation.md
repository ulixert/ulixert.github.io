---
title: "The Storage Foundation: Memtable, WAL, and SSTables"
description: "A deep dive into the bottom half of the Theseon stack: data structures and on-disk formats."
publishDate: "2026-03-12"
updatedDate: "2026-03-12"
tags: ["go", "databases", "lsm-tree", "theseon", "storage-foundation"]
order: 2
---

This is the second post in my series on building [Theseon](https://github.com/ulixert/theseon), a distributed LSM storage engine in Go. The [first post](https://ulixert.github.io/posts/building-theseon/) covered why I'm building it and what the architecture looks like. This post covers the bottom half of the stack: the data structures and on-disk formats that everything else is built on.

## The Iterator Contract

Every readable component in Theseon — memtables, SSTable blocks, merge iterators — implements the same interface:

```go
type Iterator interface {
    Key() []byte
    Value() []byte
    Next()
    IsValid() bool
    Err() error
    Close() error
}
```

Two decisions worth explaining.

`Close()` is on the interface from the start. The memtable iterator doesn't hold any resources — its `Close` just returns nil. But SSTable iterators hold references to cached blocks and file handles. Putting `Close` on the interface means every consumer can write `defer iter.Close()` without type-checking. The alternative — a separate `Closer` interface — pushes the cost of remembering onto every call site, and the one time someone forgets on an SSTable iterator, you leak a file handle.

`Value()` returns `nil` for tombstones and `[]byte{}` for legitimate empty values. This convention carries through the entire read path. A tombstone means "this key was deleted." An empty value means "this key exists with no data." Confusing the two would silently corrupt query results.

## The Skip List

The memtable needs an ordered, mutable data structure. A hash map won't work — you need sorted iteration for range scans and for flushing to an SSTable (which requires sorted input). A balanced binary tree works but has poor cache locality. A skip list gives O(log n) insert and search, supports ordered iteration natively, and is straightforward to implement.

```
Level 3:  HEAD ──────────────────────────────────► 42 ──────────────────────► NIL
Level 2:  HEAD ──────────► 17 ──────────────────► 42 ──────────► 71 ──────► NIL
Level 1:  HEAD ────► 9 ──► 17 ──────────► 35 ──► 42 ──► 58 ──► 71 ──────► NIL
Level 0:  HEAD ► 3 ► 9 ► 17 ► 21 ► 28 ► 35 ► 42 ► 50 ► 58 ► 63 ► 71 ► 89 ► NIL
```

The bottom level (Level 0) is a sorted linked list of all entries. Higher levels act as express lanes — a search starts at the top and drops down when it overshoots. The probabilistic height assignment (each node has a 25% chance of being promoted one level) gives O(log n) expected time without the rebalancing cost of a tree.

I built Theseon's skip list from scratch rather than importing Badger's. The implementation uses `maxHeight=12` with promotion probability `p=0.25`, which supports roughly 16 million entries. Each node stores an internal key and a `kv.Value`, with forward pointers at each level.

The skip list is not thread-safe by itself. The `Memtable` wrapper holds a `sync.RWMutex` — writes take the exclusive lock, reads take the shared lock. Iterators hold the read lock for their entire lifetime and release it on `Close()`. This means scans block writes, but since a memtable is typically at most 64MB, scans are fast. And for the important case — flushing a frozen memtable to an SSTable — the memtable is immutable, so there's no contention at all.

## The Write-Ahead Log

Every write hits the WAL before the memtable. If the process crashes, the WAL is replayed on restart to rebuild the memtable state.

```
WAL Record:
┌──────────┬──────────┬─────────┬─────────────────────────┐
│ Checksum │  Length  │  Count  │  Entries ...            │
│  4 bytes │  4 bytes │ 2 bytes │                         │
└──────────┴──────────┴─────────┴─────────────────────────┘
                                         │
    ┌────────────────────────────────────┘
    ▼
WAL Entry:
┌──────┬─────────┬─────────┬───────────┬──────┬─────────┐
│ Flag │   Seq   │ Key Len │ Value Len │ Key  │  Value  │
│  1B  │   8B    │   2B    │    4B     │      │         │
└──────┴─────────┴─────────┴───────────┴──────┴─────────┘
  0=put                                         (omitted
  1=tombstone                                    for tombstones)
```

A single `Put` or `Delete` is a batch of one. This means the write batch API (coming later) requires no encoding changes — you just write multiple entries per record and fsync once.

The checksum covers everything from the length field through the last entry byte. On recovery, if a record has a bad checksum, the reader stops — that's the crash point. Everything before it was fully synced.

Recovery is intentionally permissive: a corrupt or truncated tail is treated as the end of the log, not an error. The reasoning is simple — the only way a WAL ends with a partial record is if the process crashed while writing that record. Everything before it was synced. So the correct behavior is to return all valid records and stop.

One detail worth noting: the WAL stores **user keys and sequence numbers separately**, not internal keys. During recovery, the engine reconstructs the internal key from the user key and sequence number. This keeps the WAL format independent of the internal key encoding — if the encoding strategy changes, the WAL format doesn't need to.

## The SSTable

The SSTable is the most consequential format decision in the project because it's the hardest to change later. Bloom filters, caching, compression, and compaction all depend on the block layout.

### Blocks

A data block is a fixed-size (~4KB) container of sorted key-value entries:

```
Data Block:
┌─────────┬─────────┬─────┬─────────┬─────────────────────────┬──────────────┐
│ Entry 0 │ Entry 1 │ ... │ Entry N │ Offsets (2B × N)        │ Count (2B)   │
└─────────┴─────────┴─────┴─────────┴─────────────────────────┴──────────────┘
 ◄──── entry data region ────►  ◄─── offset table + count ───►

Entry:
┌──────────┬───────────┬──────┬──────┬─────────┐
│ Key Len  │ Value Len │ Flag │ Key  │  Value  │
│   2B     │    2B     │  1B  │      │         │
└──────────┴───────────┴──────┴──────┴─────────┘
```

The offset table at the end enables binary search within the block without scanning every entry — jump to the offset of the midpoint, read the key, compare, repeat.

The offset table is validated on decode: offsets must be within the entry data region and strictly ascending. This was a late addition prompted by reviewing my own code — I realized that a corrupt key length could cause `readEntry` to read past the entry region into the offset table itself, returning garbage bytes as key data without any error. The fix was tracking where the entry region ends (`entryRegionEnd`) and checking every bound against it.

Every block gets a CRC32 checksum appended by the SSTable builder and verified on read. Silent disk corruption becomes a loud, clear error.

### Bloom Filters

Each SSTable has a bloom filter built from all the user keys it contains. Before reading any blocks on a point lookup, the engine checks the bloom filter. With 10 bits per key, the false positive rate is approximately 1%, meaning 99% of irrelevant SSTables are skipped without touching disk.

```
Bloom Filter Probe:

  Hash("user:1234") = h
  delta = rotate_right(h, 17)

  for j in 0..k:
      check bit at position (h % num_bits)
      h += delta

  Any bit is 0? → key DEFINITELY absent (skip this SSTable)
  All bits are 1? → key MAYBE present (read the block)
```

The implementation follows the LevelDB approach: one hash per key with `k` rotated probe positions. The value of `k` is stored as the last byte of the filter, making it self-describing.

One important detail: the bloom filter hashes **user keys**, not internal keys (which include the sequence number suffix). Point lookups search by user key, so the bloom filter must match on user key. If it hashed internal keys, every lookup would fail the bloom check because the query hash wouldn't include the right sequence bytes.

### File Layout

```
SSTable File:
┌───────────────────────────────────┐
│  Data Block 0  │  CRC32 (4B)      │
├───────────────────────────────────┤
│  Data Block 1  │  CRC32 (4B)      │
├───────────────────────────────────┤
│  ...                              │
├───────────────────────────────────┤
│  Data Block N  │  CRC32 (4B)      │
├───────────────────────────────────┤
│  Bloom Filter                     │
├───────────────────────────────────┤
│  Index Block                      │
│  (first key + per-block metadata: │
│   last key, offset, size)         │
├───────────────────────────────────┤
│  Footer (33 bytes)                │
│  bloom_offset, bloom_len,         │
│  index_offset, index_len,         │
│  version, checksum, magic "LTDB"  │
└───────────────────────────────────┘
```

The footer is the entry point. The reader reads the last 33 bytes first, verifies the magic number (`LTDB`) and checksum, then uses the offsets to find the bloom filter and index block. The index maps key ranges to block positions: for each data block, it stores the last key and the block's offset and size.

The footer includes a format version byte. When MVCC timestamps change the key encoding later, this version gets bumped. The reader can detect the mismatch cleanly rather than producing garbage.

### Atomic Writes

SSTables are written atomically: data goes to a `.tmp` file first, which is fsynced, then renamed to the final `.sst` path, then the directory is fsynced. This guarantees that if a `.sst` file exists, it's complete and correct.

```
Write path:
  1. Write data to  000001.sst.tmp
  2. fsync(file)     ← data is durable
  3. rename → 000001.sst
  4. fsync(directory) ← rename is durable
```

A crash at any step is safe: step 1-2 leaves a `.tmp` file (cleaned up on startup), step 3 is atomic (the file either has the old name or the new one), step 4 ensures the rename survives a power loss.

## Tombstones

In an LSM tree, deletes don't remove data immediately. Instead, a tombstone marker is written. The actual removal happens during compaction, once the tombstone has propagated below all older versions of the key.

Theseon uses a `kv.Value` type with an explicit `Tombstone` flag rather than encoding tombstones as empty values. This keeps the semantics unambiguous: an empty value is a legitimate value, not a deletion. The distinction matters in compaction (tombstones can be dropped once they've propagated), in MVCC (a snapshot needs to know "this key was deleted at this point in time"), and at every point in the read path where the engine decides what to return.

## What I Learned

The on-disk format is the thing to get right early. Every decision about block size, checksum placement, key encoding, and filter design ripples through the rest of the system. I spent more time on SSTable encoding than on any other component, and that was the correct allocation of effort.

The offset validation in blocks was a late addition that prevented a real corruption bug — a corrupt key length silently reading into the offset table. Small change, huge difference in corruption detection.

The bloom filter was simpler to implement than I expected. The LevelDB approach (single hash with rotated probes) is elegant — you get `k` hash functions from one hash computation, and the `k` value is stored in the filter itself so it's self-describing.

---

### Read next
[**Wiring It All Together**](/posts/theseon-wiring-it-together/)

---

### In this series
1. [Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go](/posts/building-theseon/)
2. **The Storage Foundation**
3. [Wiring It All Together](/posts/theseon-wiring-it-together/)
4. [Making the Engine Self-Maintaining](/posts/theseon-self-maintaining/)
5. [Snapshots, Transactions, and the Art of Not Blocking Writers](/posts/theseon-mvcc-transactions/)
6. [Who's Alive? Building SWIM Failure Detection from Scratch](/posts/theseon-swim-protocol/)
7. [Quorum Reads, Quorum Writes, and the Repair That Follows](/posts/theseon-quorum-coordinator/)
8. [Buffering Writes for Dead Replicas: Hinted Handoff](/posts/theseon-hinted-handoff/)
9. [Building HNSW from Scratch](/posts/theseon-hnsw-scratch/)
10. [Making Vectors Durable](/posts/theseon-vector-kv-integration/)
11. [Fan-Out, Merge, Repair: Distributed Vector Search](/posts/theseon-distributed-vector-search/)
12. [Starting, Joining, Activating: The Node Orchestrator](/posts/theseon-node-orchestrator/)

---

*The next post covers the integration layer: internal key encoding with sequence numbers, the merge iterator, and how everything gets wired into a working engine.*

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*
