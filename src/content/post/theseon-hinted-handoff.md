---
title: "Buffering Writes for Dead Replicas: Hinted Handoff"
description: "How Theseon stores writes destined for dead nodes and replays them on recovery — the capacity accounting race, the iterator deadlock, and why skipping fsync is the right call for ephemeral data."
publishDate: "2026-04-09"
updatedDate: "2026-04-09"
tags: ["go", "databases", "theseon", "distributed-systems", "hinted-handoff", "replication", "consistency"]
series: "Building Theseon"
part: 8
order: 8
---

At the end of the [last post](/posts/theseon-quorum-coordinator/), the coordinator could fan out writes to replicas and meet quorum. But when a replica was dead, the write was simply skipped. The coordinator logged a warning, the quorum succeeded on live replicas, and the dead node stayed stale until... nothing. Read repair only fires on reads. If no one reads that key before the node recovers, the stale data persists.

This post covers hinted handoff: the mechanism that buffers writes destined for dead replicas and replays them when the target comes back. It's the fast-path repair — anti-entropy with merkle trees is the safety net for longer outages, but most failures are short. A node reboots, a network partition heals, and hinted handoff delivers the missed writes within seconds of recovery.

The implementation was straightforward in concept and produced three interesting problems in practice: a capacity accounting race, an iterator deadlock, and a WAL sync decision that required thinking about what durability actually means for ephemeral data.

## The Hook Point

The coordinator's write path already had the right structure. When fanning out to replicas, it checks liveness:

```go
if node.ID == c.selfID {
    writeErr = c.localDB.Put(key, encoded)
} else if c.membership.IsRoutable(node.ID) {
    writeErr = c.remoteWrite(ctx, node.Addr, key, value, ts, deleted)
} else {
    // Dead node — store hint for later replay.
    if c.hintStore != nil {
        if hintErr := c.hintStore.Add(node.ID, key, encoded, ts); hintErr != nil {
            c.logger.Warn("failed to store hint", "node", node.ID, "err", hintErr)
        }
    }
    writeErr = fmt.Errorf("node %s is not routable", node.ID)
}
```

The hint doesn't count toward W. Quorum is met by live replicas only. If the hint store is full or the write fails, the write still succeeds if quorum is met — the hint is best-effort. Anti-entropy catches anything that slips through.

The important detail is *what* gets stored. The hint value is the raw output of `EncodeEnvelope` — the same bytes that would have been written to the local LSM engine. The drainer replays these bytes as-is, preserving the original HLC timestamp and delete bit. No reconstruction, no re-encoding. Duplicates are harmless because the system uses last-writer-wins with HLC timestamps. If a hint is replayed twice, the second write is a no-op because the timestamp is identical to the first.

## The Hint Store

Hints are stored in a separate `db.DB` instance — its own directory, WAL, memtable, compaction pipeline. This isolation is deliberate. Hint writes shouldn't interfere with the main database's flush scheduling or compaction budget. And hints have different lifecycle properties: they're ephemeral (24-hour TTL), capped (256MB default), and acceptable to lose on crash.

The key format is binary, designed for efficient per-target prefix scans:

```
[nodeID_len:2BE][nodeID][walltime:8BE][logical:4BE][user_key]
```

Length-prefixing the nodeID (instead of using a delimiter) handles arbitrary node ID content — `us-east/1` works without escaping. The fixed 12-byte timestamp sorts temporally. The user key suffix ensures uniqueness for concurrent writes at the same HLC timestamp.

To iterate all hints for a given target, the drainer builds a prefix from the first two fields (`[nodeID_len][nodeID]`) and calls `ScanPrefix`, which I added to the DB layer as a thin wrapper over `ScanRange` with a computed successor bound.

### The capacity race

The hint store has a byte cap. Before storing a hint, it checks whether the new entry would exceed the limit. The naive approach:

```go
s.mu.Lock()
if s.size + entrySize > s.cfg.MaxBytes {
    s.mu.Unlock()
    return ErrCapacityExceeded
}
// db.Put happens here, under the lock
s.size += entrySize
s.mu.Unlock()
```

This works but serializes all hint writes through one mutex, and each `db.Put` does a WAL write. Every hint write blocks every other hint write for the duration of a disk operation.

The fix is a reserve-then-write pattern. Reserve capacity under the lock (fast path — just arithmetic), then write outside the lock (slow — disk I/O), and roll back if the write fails:

```go
// Reserve capacity under lock (fast path — no I/O).
s.writeMu.Lock()
if s.size+entrySize > s.cfg.MaxBytes {
    s.writeMu.Unlock()
    return ErrCapacityExceeded
}
s.size += entrySize
s.writeMu.Unlock()

// Write outside lock.
if err := s.db.Put(hintKey, envelope); err != nil {
    s.writeMu.Lock()
    s.size -= entrySize
    s.writeMu.Unlock()
    return err
}
```

The lock hold time drops from milliseconds (WAL fsync) to nanoseconds (integer comparison and addition). Multiple hint writes from different goroutines — each fan-out to a dead replica runs in its own goroutine — can proceed concurrently through the actual `db.Put`.

`Remove` uses the symmetric pattern but in reverse: delete first, then decrement on success. If the delete fails, the size tracker still reflects the entry on disk. No accounting drift.

One subtlety: the in-memory target index (which tracks which node IDs have hints) is updated *after* a successful `db.Put`, not before. If the put fails, we don't want a stale entry in the index claiming hints exist for a target that has none. The sweep loop cleans up lazily if a target entry becomes stale for other reasons.

## Skipping fsync

The hint store's `db.DB` is opened with `DisableWALSync: true`. This skips the `file.Sync()` call after every WAL write. The effect: writes are buffered in the OS page cache and flushed to disk at the kernel's discretion, not on every operation.

This sounds dangerous for a database. It is dangerous — for a primary database. But hints are ephemeral data with a 24-hour TTL, a 256MB cap, and a safety net (anti-entropy) that catches anything lost. If the node crashes and loses some hints, the dead target node will eventually be repaired by anti-entropy anyway. The hints are an optimization, not a correctness requirement.

The implementation adds a `noSync` field to the WAL struct and a single conditional in `WriteEntries`:

```go
if !w.noSync {
    if err := w.file.Sync(); err != nil {
        return fmt.Errorf("wal: sync: %w", err)
    }
}
```

The `DisableWALSync` option in `db.Options` passes this flag through to `wal.Create` and `wal.Open`. Existing callers pass `false`. The main database's durability is unchanged.

Combined with the reserve-then-write pattern, hint writes become: fast lock (capacity check) followed by uncontended `db.Put` (no fsync). On my machine this brings per-hint write latency from ~2ms (fsync-per-write) down to microseconds.

## The Drainer

When a dead node recovers — transitions from Dead to Alive in SWIM — the drainer replays its buffered hints. The trigger mechanism is `TriggerDrain(nodeID)`, which spawns a goroutine. A `sync.Mutex`-protected set of in-progress targets prevents duplicate drains for the same node.

The drain loop is conceptually simple: scan hints for the target, collect a batch, send it via `ReplicateWriteBatch`, delete the sent hints, repeat until empty. But the details matter.

### Batch sizing

The original plan used a count-based batch size: collect 100 hints, send them. But Theseon stores vectors (~3KB per 768-dimensional embedding) alongside regular KV values (~100 bytes). A batch of 100 vectors is 300KB — reasonable. A batch of 100 tiny KV values is 10KB — underutilizing the network.

The fix is dual-bounded batching: a primary byte limit (`MaxBatchBytes`, default 512KB) and a secondary count limit (`MaxBatchItems`, default 500). The batch terminates when either limit is hit. Large payloads produce small batches by count; small payloads produce large batches by count but stay within the byte budget.

### The iterator deadlock

This was the most instructive bug. The drain loop needs to delete expired hints during iteration — hints older than the TTL should be purged, not replayed. My first implementation deleted them inline:

```go
iter := store.Iterate(targetNodeID)
defer iter.Close()
for iter.IsValid() {
    if isExpired(hint) {
        store.Remove(hintKey, envSize) // BUG: deadlock
    }
    iter.Next()
}
```

The iterator holds the DB's read lock (via `ScanPrefix` → `ScanRange` → `SnapshotIterator`, which snapshots state under `RLock`). Actually — that's not quite right. The `SnapshotIterator` takes a snapshot of the memtable and SSTable state under `RLock`, then releases it. But the underlying memtable iterator still reads from the active memtable's skip list, which uses its own `RWMutex`. When `store.Remove` calls `db.Delete`, it needs the memtable's write lock. If the iterator is positioned on the same memtable, the write lock can't be acquired while the read lock is held.

The result: the drain goroutine hangs forever. The test timed out after 15 seconds with a clear stack trace showing the deadlock: `memtable.Put` waiting for `RWMutex.Lock` while `SkipListIterator` is mid-traversal.

The fix is a two-phase approach: collect expired keys during the scan, close the iterator (releasing all locks), then delete:

```go
// Phase 1: scan under iterator (holds read state).
iter := store.Iterate(nodeID)
for iter.IsValid() {
    if isExpired(hint) {
        expired = append(expired, entry{key, envSize})
    } else {
        batch = append(batch, hint)
    }
    iter.Next()
}
iter.Close()

// Phase 2: delete expired (needs write lock).
for _, e := range expired {
    store.Remove(e.key, e.envSize)
}
```

The same pattern applies to the periodic TTL sweep. Any code path that iterates and mutates must close the iterator before mutating.

### Membership-gated sweep

The drainer runs a periodic sweep (every 60 seconds by default) that checks `Store.Targets()` and considers retriggering drains. An early version triggered drains for all non-empty targets. This wasted work: if a node is still Dead, the drain will immediately fail to resolve its address and bail out.

The fix is a membership gate: the sweep only triggers drains for targets that are currently Alive. Dead and Suspect targets are skipped. The sweep still purges expired hints for all targets regardless of liveness — you don't want hints for a long-dead node consuming cap space indefinitely.

### Tombstone visibility

One more gotcha from the LSM architecture: `db.Delete` doesn't remove a key. It writes a tombstone — a marker that the key is deleted. The actual removal happens later during compaction. Between the delete and compaction, the key is still visible to iterators, but with a nil value.

This means that after `Store.Remove`, the hint's key still appears in prefix scans. Without filtering, the drain loop would try to replay nil envelopes. The `tombstoneFilter` iterator wrapper handles this: it wraps the inner iterator and skips entries where `Value()` returns nil. It also strips the internal key suffix (the sequence number appended by the LSM engine) so callers see clean hint keys.

## Breaking the Import Cycle

The coordinator (`cluster` package) imports the hint store (`cluster/hintedhandoff` package). The drainer needs a dialer (to send RPCs) and a membership querier (to check liveness) — both defined in `cluster`. This creates a cycle: `cluster` → `hintedhandoff` → `cluster`.

The solution is interface-based decoupling. The drainer defines its own minimal interfaces:

```go
type ReplicaDialer interface {
    GetClient(addr string) (pb.InternalServiceClient, error)
    Close()
}

type MembershipQuerier interface {
    IsAlive(nodeID string) bool
    GetMemberInfos() []MemberInfo
}
```

The `cluster.Membership` and `cluster.PeerPool` types satisfy these interfaces without importing them. The drainer also takes an `EnvelopeDecoder` function instead of importing `cluster.DecodeEnvelope` directly. The coordinator wires everything together at construction time.

The test file uses the `_test` external package (`package hintedhandoff_test`) to import both `cluster` (for `EncodeEnvelope` and liveness constants) and `hintedhandoff` without creating a cycle in the test build graph.

## What I Learned

The reserve-then-write pattern for capacity accounting is a general technique I'll use again. Any time you have a shared resource check (quota, rate limit, connection pool size) followed by a slow operation (I/O, network call), holding the lock across both serializes everything through the slow path. Reserving under the lock and rolling back on failure keeps the critical section fast while maintaining the invariant.

The fsync decision was interesting because it required thinking about what the data *means*, not just what the code *does*. The WAL exists to survive crashes. Hints exist to survive node failures. These are different failure modes with different recovery mechanisms. Applying the same durability guarantee to both is a false consistency — it's treating all data as equally important when the system has already decided it isn't.

The iterator deadlock reinforced something I keep relearning: in LSM storage engines, the read and write paths share state (the active memtable), and iterators hold references into that shared state for their entire lifetime. Any design that interleaves iteration and mutation on the same store needs to account for this. The two-phase pattern — scan, close, mutate — is the safe default.

## What's Next

Hinted handoff handles the fast case: a node dies, comes back quickly, and receives its missed writes. But hints have a TTL (24 hours) and a capacity cap (256MB). For longer outages — a node down for days, or a new node joining the cluster — the hints are gone. Anti-entropy with merkle trees is the final layer: a background process that systematically compares data between replica pairs and repairs any divergence it finds, regardless of how or when it occurred.

---

### Read next
[**Building HNSW from Scratch**](/posts/theseon-hnsw-scratch/)

---

### In this series
1. [Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go](/posts/building-theseon/)
2. [Storage Foundation: SSTables, Memtables, and the WAL](/posts/theseon-storage-foundation/)
3. [Sequence Numbers, the Merge Iterator, and Wiring It All Together](/posts/theseon-wiring-it-together/)
4. [Making the Engine Self-Maintaining](/posts/theseon-self-maintaining/)
5. [Snapshots, Transactions, and the Art of Not Blocking Writers](/posts/theseon-mvcc-transactions/)
6. [Who's Alive? Building SWIM Failure Detection from Scratch](/posts/theseon-swim-protocol/)
7. [Quorum Reads, Quorum Writes, and the Repair That Follows](/posts/theseon-quorum-coordinator/)
8. **Buffering Writes for Dead Replicas: Hinted Handoff**
9. [Building HNSW from Scratch](/posts/theseon-hnsw-scratch/)
10. [Making Vectors Durable](/posts/theseon-vector-kv-integration/)
11. [Fan-Out, Merge, Repair: Distributed Vector Search](/posts/theseon-distributed-vector-search/)
12. [Starting, Joining, Activating: The Node Orchestrator](/posts/theseon-node-orchestrator/)
13. [Benchmarking Theseon: KV, Cluster, Chaos, and HNSW on SIFT-1M](/posts/theseon-benchmarks/)

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- DeCandia, G., Hastorun, D., Jampani, M., et al. (2007). *Dynamo: Amazon's Highly Available Key-value Store*. SOSP '07. The original hinted handoff design: "a node that detects a failure will store the hints locally until the failed node recovers."
- Lakshman, A. & Malik, P. (2010). *Cassandra — A Decentralized Structured Storage System*. LADIS '09. Production hinted handoff with configurable TTL and handoff scheduling.
- Ellis, J. (2012). *Understanding Hinted Handoff*. DataStax blog. Practical discussion of hint storage limits, replay ordering, and interaction with repair.
