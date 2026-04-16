---
title: "Sequence Numbers, the Merge Iterator, and Wiring It All Together"
description: "How the storage foundation pieces are wired into a working engine, including internal key encoding and the merge iterator."
publishDate: "2026-03-15"
updatedDate: "2026-03-15"
tags: ["go", "databases", "lsm-tree", "theseon", "merge-iterator"]
order: 3
---

This is the third post in my series on building [Theseon](https://github.com/ulixert/theseon). The [previous post](/posts/theseon-storage-foundation/) covered the building blocks: memtable, WAL, and SSTables. This post covers the decision that reshaped the project mid-build, the merge iterator that ties everything together, and the bugs I caught along the way.

## The Decision That Changed Everything

The original plan deferred multi-version support to much later in the project. During implementation, I changed my mind.

Every LSM engine needs to answer "which version of this key is newest?" When a user overwrites a key, the old value exists in an SSTable on disk and the new value exists in the memtable. The read path checks the memtable first, so it returns the correct result. But what about during compaction, when two SSTables contain different versions of the same key? Or during a scan that merges data from five sources?

The standard approach is a monotonically increasing sequence number assigned to every write. Pebble, Badger, and LevelDB all do this. If I waited to add it later, I'd need to change the SSTable key format — which means changing the block encoder, decoder, binary search logic, bloom filter hashing, and every test that constructs a key. That's a painful retrofit.

Instead, I added sequence numbers to the internal key encoding before building the flush path and read path.

## Internal Key Encoding

Every key stored in Theseon is an internal key:

```
Internal Key:
┌──────────────────────┬──────────────────────────────┐
│      user_key        │  inverted_seq (8B, big-end.) │
└──────────────────────┴──────────────────────────────┘

invert(seq) = math.MaxUint64 - seq
```

The sequence number is stored as `math.MaxUint64 - seq`. This is the key insight: standard `bytes.Compare` on internal keys produces the correct ordering with zero custom comparator code.

For the same user key, the entry with the highest sequence number (newest) has the smallest inverted bytes, so it sorts first:

```
user_key = "abc"

  seq 10 → invert(10) = large - 10 = ...F5  ← smaller bytes
  seq  5 → invert(5)  = large - 5  = ...FA  ← larger bytes

  bytes.Compare("abc|F5", "abc|FA") < 0

  Result: seq 10 sorts before seq 5 ✓ (newest first)
```

This means the skip list, SSTable blocks, merge iterator heap, and index binary search all use plain `bytes.Compare` and get correct results. No custom comparators anywhere in the codebase.

For point lookups, I construct a "search key" with `MaxSeqNum` (which inverts to all zeros, the smallest possible suffix). This sorts before all real versions of the user key, so a seek to the search key lands on the newest version:

```
Search for "abc":
  search_key = "abc" + invert(MaxSeqNum) = "abc" + 0x0000000000000000

  Sorted order:
    "abc|00000000"  ← search key lands here
    "abc|...F5"     ← seq 10 (newest real version)
    "abc|...FA"     ← seq 5
    "abd|..."       ← different user key

  First entry ≥ search key → "abc" @ seq 10 → newest version ✓
```

The cost is 8 bytes per key and slightly larger SSTable files. The payoff is that when MVCC snapshots are added later, the format is already correct. A snapshot just records a sequence number and filters reads to `seq <= snapshot.seq`. No format changes needed.

## The Merge Iterator

The merge iterator is the core read-path abstraction. It takes N sorted iterators (memtable, immutable memtables, SSTables) and produces a single sorted stream, emitting only the newest version of each user key.

```
  Source 0 (memtable):        a @10  b @9   d @8
  Source 1 (immutable):       a @5   c @4
  Source 2 (SSTable):         a @2   b @1   c @3

        ┌──── min-heap ────┐
        │  a @10  (src 0)  │ ◄── smallest internal key
        │  a @5   (src 1)  │
        │  a @2   (src 2)  │
        └──────────────────┘

  Pop a @10 → emit "a" with value from src 0
  Drain a @5, a @2 (same user key, older) → advance src 1, src 2
  Push b @9 from src 0, c @4 from src 1, c @3 from src 2

        ┌──── min-heap ─────┐
        │  b @9   (src 0)   │ ◄── next
        │  b @1   (src 2)   │
        │  c @4   (src 1)   │
        │  c @3   (src 2)   │
        │  d @8   (src 0)   │
        └───────────────────┘

  Pop b @9 → emit "b"
  Drain b @1 ...
```

The implementation uses Go's `container/heap`. Each entry on the heap is an internal key plus the index of the iterator it came from. The heap is ordered by internal key bytes, which (thanks to the encoding) means smallest user key first, then highest sequence number first.

### The Bug

The deduplication logic is where the interesting bug lived. There were actually two bugs, layered on top of each other.

**Bug 1: Comparing full internal keys instead of user keys.** With the original implementation, deduplication worked by comparing full internal key bytes. Two entries with the same user key but different sequence numbers have different bytes, so the drain loop missed them. The fix was straightforward — compare user key prefixes instead of full bytes.

**Bug 2: Within-iterator duplicates.** Consider a memtable with three versions of the same key: `key @seq=3`, `key @seq=2`, `key @seq=1`. The memtable iterator has all three in sorted order. When the merge iterator pops `key @seq=3` from the heap, `key @seq=2` is not on the heap yet — it's the next entry in the memtable iterator that hasn't been advanced.

After `key @seq=3` is emitted and the memtable iterator advances, `key @seq=2` gets pushed onto the heap. On the next call to `advance`, it would be emitted as if it were a new user key.

```
State after emitting key @3:

  Heap: [key @2, ...]     ← pushed after advancing memtable iterator
  Last emitted: "key"

  Without fix: pop key @2, different internal key bytes, emit it ✗
  With fix:    pop key @2, same user key as lastEmitted, skip it ✓
```

The fix: track the last emitted user key and keep advancing past entries with the same user key. This handles deduplication both across iterators (memtable vs SSTable) and within a single iterator (multiple versions in one memtable).

## The Write Path

When the engine receives a `Put("user-key", "value")`:

```
  db.Put("user-key", "value")
    │
    ├─ 1. seq = nextSeq.Add(1)        atomic increment
    │
    ├─ 2. WAL.Put("user-key", "value", seq)
    │      └─ encode → write → fsync
    │
    ├─ 3. ikey = MakeInternalKey("user-key", seq)
    │
    ├─ 4. memtable.Put(ikey, value)
    │
    └─ 5. if memtable full → rotateMemtable()
              ├─ freeze active memtable
              ├─ close WAL
              ├─ move to immutables list
              ├─ create new memtable + WAL
              └─ signal flush goroutine
```

Deletes follow the same path, but write a tombstone value instead. At the memtable level, there's no difference between a put and a delete — both are inserts of a new node in the skip list, because every internal key is unique.

## The Flush Path

A background goroutine watches for frozen memtables and flushes them to SSTables:

```
  flush goroutine
    │
    ├─ wait on flushCh signal
    │
    └─ flushImmutables() loop:
         │
         ├─ pick oldest immutable (last in slice)
         │
         ├─ iterate in internal key order
         │    └─ feed entries → SSTableBuilder
         │         └─ blocks → bloom → index → footer → .sst file
         │
         ├─ open SSTable reader for L0
         │
         ├─ mu.Lock()
         │    ├─ add reader to l0 (prepend = newest first)
         │    └─ remove memtable from immutables
         │  mu.Unlock()
         │
         └─ delete WAL file
```

The flush goroutine drains all pending immutable memtables in a loop, oldest first. This means a single signal is enough to flush the entire backlog, even if multiple memtables were frozen between signals.

One concurrency subtlety I hit: reading `len(db.immutables)` and accessing `db.immutables[n-1]` must happen under the same lock acquisition. If you read the length under one lock, release it, then access the element under a second lock, another flush could complete between the two, making `n-1` out of bounds. The fix was trivial — hold the lock across both operations. The bug was invisible in single-threaded tests and only manifested under the race detector with high concurrency.

## Recovery

On startup:

```
  db.Open()
    │
    ├─ 1. CleanupTempFiles()         remove .sst.tmp leftovers
    │
    ├─ 2. RecoverDir()               find all .wal files, sorted by ID
    │       └─ for each WAL:
    │            ├─ read file, decode records
    │            ├─ for each entry:
    │            │    ikey = MakeInternalKey(entry.Key, entry.Seq)
    │            │    memtable.Put(ikey, entry.Value)
    │            │    track max(seq)
    │            └─ older WALs → immutables, last WAL → active
    │
    ├─ 3. nextSeq = max recovered seq
    │
    └─ 4. start flush goroutine
```

There's a known limitation: recovery only replays WALs. SSTables that were flushed before the crash are not rediscovered, because there's no manifest yet to track which SSTables exist. The manifest is the fix — it becomes the source of truth for the LSM tree state. That's the next major component to build.

## Benchmarks

With the storage foundation and engine wired together, here are the baseline numbers on an Apple M1, 64MB memtable, 4KB block size, 100-byte values:

| Operation | Throughput | Allocs/op |
|---|---|---|
| Put (sequential) | 266 K ops/sec | 5 |
| Put (random) | 262 K ops/sec | 6 |
| Get (hit) | 2.9 M ops/sec | 1 |
| Get (miss) | 4.6 M ops/sec | 2 |
| Scan (10K keys) | 900 scans/sec | 30,005 |

Get misses are faster than hits because the bloom filter rejects absent keys without reading any data blocks — the lookup short-circuits before touching any SSTable data. This validates the bloom filter design: 10 bits per key, ~1% false positive rate, and the difference shows up clearly in the numbers.

Put throughput is dominated by `fsync` on every WAL write. Sequential and random puts have nearly identical throughput because the skip list's O(log n) insert cost is trivial compared to the I/O. The 30K allocations per scan reflect the merge iterator creating heap entries and copying keys — a clear target for optimization later.

## What I Learned

The sequence number decision was the most impactful choice in the initial build, and it wasn't in the original plan. It came from studying how Pebble and Badger encode keys — both embed a version identifier from day one. The "add it later" approach works in theory, but in practice it means rewriting every format, encoder, decoder, and test. I'm glad I caught this before building the flush path.

The merge iterator deduplication bug taught me something about testing strategy. The within-iterator dedup case only occurs when a single source has multiple versions of the same key — which only happens with sequence numbers. If I'd written the merge iterator before adding sequence numbers, the bug would have been latent until much later, when it would have been much harder to diagnose.

The TOCTOU bug in `flushImmutables` was humbling. The fix was trivial (read length and access element under the same lock), but it was invisible in single-threaded tests. Running `go test -race` on every change is not optional for a concurrent system.

---

### Read next
[**Making the Engine Self-Maintaining**](/posts/theseon-self-maintaining/)

---

### In this series
1. [Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go](/posts/building-theseon/)
2. [The Storage Foundation](/posts/theseon-storage-foundation/)
3. **Wiring It All Together**
4. [Making the Engine Self-Maintaining](/posts/theseon-self-maintaining/)
5. [Snapshots, Transactions, and the Art of Not Blocking Writers](/posts/theseon-mvcc-transactions/)
6. [Who's Alive? Building SWIM Failure Detection from Scratch](/posts/theseon-swim-protocol/)
7. [Quorum Reads, Quorum Writes, and the Repair That Follows](/posts/theseon-quorum-coordinator/)
8. [Buffering Writes for Dead Replicas: Hinted Handoff](/posts/theseon-hinted-handoff/)
9. [Building HNSW from Scratch](/posts/theseon-hnsw-scratch/)
10. [Making Vectors Durable](/posts/theseon-vector-kv-integration/)
11. [Fan-Out, Merge, Repair: Distributed Vector Search](/posts/theseon-distributed-vector-search/)

---

*The codebase is tagged `v0.1.0` at this point. Next up: the manifest file and leveled compaction — the parts that make an LSM tree actually manage its disk layout instead of just growing forever.*

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- O'Neil, P., Cheng, E., Gawlick, D., & O'Neil, E. (1996). *The Log-Structured Merge-Tree (LSM-Tree)*. Acta Informatica, 33(4), 351–385.
- Lu, L., Pillai, T. S., et al. (2016). *WiscKey: Separating Keys from Values in SSD-Conscious Storage*. FAST '16.
- Peng, D., & Dabek, F. (2010). *Large-scale Incremental Processing Using Distributed Transactions and Notifications*. OSDI '10.
- Luo, C., & Carey, M. J. (2020). *LSM-based Storage Techniques: A Survey*. VLDB Journal, 29(1).
