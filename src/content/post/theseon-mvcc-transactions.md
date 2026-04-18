---
title: "Snapshots, Transactions, and the Art of Not Blocking Writers"
description: "How Theseon gained MVCC snapshot isolation and optimistic transactions — by separating merge from dedup and making versioning a first-class feature."
publishDate: "2026-03-22"
updatedDate: "2026-03-22"
tags: ["go", "databases", "lsm-tree", "theseon", "mvcc", "transactions", "snapshot-isolation"]
order: 5
---

At the end of the [last post](/posts/theseon-self-maintaining/), Theseon was a self-maintaining storage engine: manifest-backed persistence, leveled compaction, block cache, write batches, and backpressure. But it treated multi-version keys as an implementation detail. `Get` always returned the absolute newest version. No snapshots, no transactions, no way to read a consistent view of the data while writes are happening.

This post covers the changes that made versioning a first-class feature: refactoring the iterator stack, building snapshot isolation, teaching compaction to respect active readers, and adding optimistic transactions with conflict detection.

## The Architectural Insight: Separate Merge from Dedup

The `MergeIterator` was doing two things in one pass: merging N sorted streams into one (heap-based), and deduplicating — keeping only the newest version of each user key. For a simple storage engine, this is fine. For MVCC, it's wrong.

Snapshot reads need to see all versions so they can pick the right one (the newest with `seq ≤ snapshot.seq`). MVCC-aware compaction needs all versions so it can decide which to drop based on the GC watermark. If the merge iterator throws away old versions before anyone else sees them, neither feature can work.

The refactor was clean:

```
Before:
  MergeIterator = merge + dedup (one version per user key)

After:
  MergeIterator = pure merge (all versions in sorted order)
  SnapshotIterator = version filter + dedup (on top of merge)
```

`MergeIterator.advance()` went from 30 lines (heap pop + drain same-user-key entries + skip if already emitted) to 10 lines (heap pop + drain byte-identical keys as a defensive measure). All deduplication moved to `SnapshotIterator`, which filters to `seq ≤ maxSeq`, deduplicates to one version per user key, and optionally skips tombstones.

The payoff: `db.Get` and `snapshot.Get` now share the exact same code path — they differ only in which `maxSeq` they pass. `db.Scan` and `snapshot.Scan` work the same way.

## Snapshot Isolation

A snapshot captures a point in time — the current sequence number — and sees exactly the versions that existed at that moment.

```
db.GetSnapshot()
│
▼
Read current seq (under lock)
Register in snapshot registry
Return &Snapshot{seq: 42}
│
├─── snap.Get("user-key")
│        Same read path as db.Get, but skip entries with seq > 42
│
├─── snap.Scan()
│        MergeIterator → SnapshotIterator(maxSeq=42, skipTombstones=true)
│
└─── snap.Close()
         Deregister from registry (compaction watermark may advance)
```

The snapshot registry is a sorted slice of active sequence numbers. A sorted slice, not a min-heap — the registry is tiny (typically 0-10 entries) and rarely mutated. The watermark (oldest active snapshot) is just `active[0]`.

The `closed` flag is an `atomic.Bool` for lock-free checks on the hot path. `Close()` is idempotent. `Get`/`Scan` on a closed snapshot panics — it's a programming error, same philosophy as Go's mutex.

### The point-lookup fast path

Wrapping a full `MergeIterator` + `SnapshotIterator` for a single `Get` would be overkill. The existing layered approach — check memtable, then immutables, then L0, then L1+ — short-circuits on the first match, skipping everything else.

For `getAt(key, maxSeq)`, each layer uses the same logic: seek to the user key's newest version, walk forward through versions until finding one with `seq ≤ maxSeq`. The memtable, immutable memtables, and SSTable reader all gained a `GetAt` method alongside the existing `Get`. The cost is one extra `uint64` comparison per version visited — which the benchmarks confirm is negligible.

## MVCC-Aware Compaction

Snapshots promise readers a consistent view. Compaction must not delete versions that an active snapshot still needs.

The solution is a GC watermark derived from the oldest active snapshot:

```
User key "foo" has versions: @seq=10, @seq=7, @seq=3, @seq=1
Active snapshot at seq=5
Watermark = 5

@seq=10: newest version              → KEEP (always keep the newest)
@seq=7:  seq ≥ watermark (7 ≥ 5)    → KEEP (snapshot at seq=5 might need seq=7)
@seq=3:  seq < watermark (3 < 5)    → DROP (no active snapshot can see this)
@seq=1:  seq < watermark (1 < 5)    → DROP
```

Three rules govern what the compaction executor keeps:

1. **Always keep the newest version of each key** — unless it's a tombstone at the bottommost level with no active snapshots above it (the tombstone serves no purpose since nothing exists below to shadow).

2. **Keep old versions at or above the watermark** — an active snapshot might read them.

3. **Drop old versions below the watermark** — no snapshot can see them.

The `isBottommost` check is a per-compaction property, not global. The executor asks: "does any SSTable in a level below my output level overlap my key range?" If not, tombstones can be dropped because there's nothing below to shadow. If there is data below, the tombstone must survive to prevent a deleted key from reappearing when that lower level is read.

When no snapshots are active, the watermark doesn't exist, and the compaction can GC freely — one version per key, tombstones dropped at the bottom.

## Optimistic Transactions

Transactions use snapshot isolation with optimistic conflict detection:

```
tx := db.BeginTransaction()
│
├─ Captures readSeq = current sequence number
├─ Registers in snapshot registry (same as GetSnapshot)
│
├─ tx.Get("key")     → check write buffer, then snapshot read at readSeq
├─ tx.Put("key", v)  → buffer in memory (map[string]txWrite)
├─ tx.Delete("key")  → buffer tombstone
│
└─ tx.Commit()
     │
     ├─ Acquire db.mu.Lock()
     ├─ For each key in write set:
     │    Check if any version with seq > readSeq exists in memtables
     │    If yes → return ErrConflict (another writer modified this key)
     │
     ├─ No conflicts:
     │    Assign sequence numbers (one per write, atomic batch)
     │    Write all entries to WAL (single record, one fsync)
     │    Apply to memtable
     │    Rotate memtable if full
     │
     └─ Release lock, deregister snapshot
```

### Why conflict detection only checks memtables

The conflict check scans the active memtable and immutable memtables for versions newer than `readSeq`. It does not check SSTables. This is correct for short-lived transactions because any write with `seq > readSeq` happened during the transaction's lifetime, and writes always go to the active memtable first. Even if the memtable was frozen, the immutable copy still exists until it's flushed — and we hold `db.mu` during commit, so no flush can happen mid-check.

The edge case: if a transaction lives long enough for a conflicting write to be flushed to L0 *and* the immutable memtable to be removed, the conflict is missed. We accept this limitation — long-lived write transactions are an anti-pattern. Documenting the boundary is more valuable than engineering around it.

### Transaction scans

Transaction scans need to merge two views: the snapshot of stored data and the transaction's buffered writes. The write buffer might add new keys, overwrite existing ones, or delete keys the snapshot can see.

The layering:

```
Step 1: rawScan → all versions from all sources
Step 2: SnapshotIterator(raw, readSeq, skipTombstones=true)
        → filtered to snapshot view, deduped, tombstones hidden
Step 3: writeBufferIterator(syntheticSeq)
        → sorted write buffer with seq = MaxSeqNum - 1
Step 4: MergeIterator([buffer, snapshot])
        → buffer entries sort first for same user key (higher seq → smaller inverted bytes)
Step 5: SnapshotIterator(merged, syntheticSeq, skipTombstones=true)
        → dedup (buffer wins), hide tombstones from buffer deletes
```

The key trick is assigning synthetic high sequence numbers to write buffer entries. Since the internal key encoding inverts the sequence number, a higher seq produces smaller bytes, which sorts before real entries for the same user key. The `SnapshotIterator` on top deduplicates — for each user key, the first entry (from the buffer if present, otherwise from the snapshot) wins. If the buffer has a `Delete`, the tombstone is hidden by `skipTombstones=true`.

This reuses the existing `MergeIterator` and `SnapshotIterator` with zero new iterator types. The `WriteBufferIterator` is a simple sorted-slice iterator that wraps the transaction's `map[string]txWrite` entries.

## Benchmarks

Here are the MVCC numbers on Apple M1 (v0.4.0):

```
BenchmarkSnapshot_Get              3,247,916      331.3 ns/op       206 B/op      2 allocs/op
BenchmarkSnapshot_Scan                11,107     98,392 ns/op   128,569 B/op  3,007 allocs/op
BenchmarkTransaction_ReadWrite           366  3,466,661 ns/op     3,814 B/op     51 allocs/op
```

**Snapshot Get (331 ns) is faster than regular memtable Get (418 ns).** Not because snapshots are magic — the benchmark uses 1K keys versus 10K for the baseline, making the skip list shallower. In an apples-to-apples comparison, the overhead is ~1-2 ns per seek: one `uint64` comparison for the sequence number check.

**Transaction throughput (289 txns/sec) is fsync-bound.** Each commit does one WAL `fsync`. The conflict check — scanning `GetNewest` on active + immutable memtables for each key in the write set — completes in microseconds. With 5 reads + 5 writes per transaction, the per-operation cost is ~350µs. Batching more writes per transaction amortizes the fsync: a 100-write transaction would still be ~3.5ms total.

**Snapshot Scan (98µs for 1K keys) matches regular scan per-key cost.** 3,007 allocs for 1K keys = 3.0 allocs/key, identical to the regular scan's 30,020 allocs for 10K keys. The `SnapshotIterator`'s seq filter and user-key dedup are simple comparisons that don't allocate.

## What I Learned

The iterator refactor was the highest-leverage change in the project so far. Separating merge from dedup unlocked three features simultaneously: snapshot reads, MVCC compaction, and transaction scans. Each one would have been painful to build on top of a deduplicating merge iterator.

The conflict detection boundary — checking memtables only, not SSTables — was an explicit tradeoff. The temptation to handle the long-lived transaction edge case was real, but the complexity (scanning L0 SSTables during commit, under the write lock) wasn't justified by the use case. Documenting the limitation was the right call.

The transaction scan layering took the most design iteration. The first three approaches each had subtle ordering or filtering bugs. The final design — filter the snapshot first, merge with the buffer second, dedup on top — fell out naturally once I stopped trying to do everything in one pass and embraced the layered iterator model.

## What's Next

The single-node engine is feature-complete: durable writes, leveled compaction, mmap'd reads, MVCC snapshots, and optimistic transactions. The next milestone is the distributed layer — leaderless replication over gRPC, with consistent hashing, SWIM gossip for failure detection, quorum coordination, and anti-entropy repair. All built from scratch.

---

### Read next
[**Who's Alive? Building SWIM Failure Detection from Scratch**](/posts/theseon-swim-protocol/)

---

### In this series
1. [Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go](/posts/building-theseon/)
2. [The Storage Foundation](/posts/theseon-storage-foundation/)
3. [Wiring It All Together](/posts/theseon-wiring-it-together/)
4. [Making the Engine Self-Maintaining](/posts/theseon-self-maintaining/)
5. **Snapshots, Transactions, and the Art of Not Blocking Writers**
6. [Who's Alive? Building SWIM Failure Detection from Scratch](/posts/theseon-swim-protocol/)
7. [Quorum Reads, Quorum Writes, and the Repair That Follows](/posts/theseon-quorum-coordinator/)
8. [Buffering Writes for Dead Replicas: Hinted Handoff](/posts/theseon-hinted-handoff/)
9. [Building HNSW from Scratch](/posts/theseon-hnsw-scratch/)
10. [Making Vectors Durable](/posts/theseon-vector-kv-integration/)
11. [Fan-Out, Merge, Repair: Distributed Vector Search](/posts/theseon-distributed-vector-search/)
12. [Starting, Joining, Activating: The Node Orchestrator](/posts/theseon-node-orchestrator/)

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- Berenson, H., Bernstein, P., et al. (1995). *A Critique of ANSI SQL Isolation Levels*. SIGMOD '95. The paper that clarified snapshot isolation vs. serializable, and defined write skew.
- Peng, D., & Dabek, F. (2010). *Large-scale Incremental Processing Using Distributed Transactions and Notifications*. OSDI '10. Percolator's model — distributed transactions on top of versioned key-value storage — informed the design even though Theseon's transactions are local.
- [Badger Transactions](https://dgraph.io/docs/badger/get-started/#using-transactions) — Badger's optimistic transaction API and conflict detection approach.
- [CockroachDB MVCC](https://www.cockroachlabs.com/docs/stable/architecture/storage-layer.html) — how Pebble's MVCC layer interacts with CockroachDB's transaction protocol.
