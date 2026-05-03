---
title: "Merkle Anti-Entropy: Catching Drift That Read Repair and Hinted Handoff Miss"
description: "How Theseon's third repair layer reconciles silent divergence — the design of an XOR-leaf Merkle tree, a deadlock between local iterators and local Puts, and the proto field that quietly told both sides they were already in sync."
publishDate: "2026-04-19"
updatedDate: "2026-04-19"
tags: ["go", "databases", "theseon", "distributed-systems", "anti-entropy", "merkle-trees", "replication", "consistency"]
series: "Building Theseon"
part: 14
order: 14
pinned: false
---

Theseon already had two repair mechanisms before this post. [Read repair](/posts/theseon-quorum-coordinator/) fixes stale replicas when divergence is observed during a quorum read — but only for keys someone reads. [Hinted handoff](/posts/theseon-hinted-handoff/) buffers writes for dead replicas and replays them on recovery — but hints have a 24-hour TTL and a 256MB cap, and they're never written when the *coordinator* dies before storing the hint.

That leaves a gap. Cold keys that nobody reads. Hints that expired or were never created. Transient bugs where a quorum write succeeded but actually missed a replica because of a one-off network blip the SWIM layer never noticed. Anti-entropy is the safety net for all of these: a periodic background process that reconciles divergent replicas without needing to know how the divergence happened.

This post covers the implementation. The mechanism is a Merkle tree per replica-pair, exchanged over a small set of new RPCs, with repairs flowing through the same envelope-preserving path read repair already uses. The design was straightforward enough on paper. Two real bugs surfaced during the integration test, and a third — the most insidious — would have shipped silently if I hadn't bothered to build the test at all.

## The Three-Layer Picture

It's worth being explicit about what each repair mechanism does and doesn't do, because the relationships matter:

| Mechanism | Triggers on | Coverage | Cost |
|---|---|---|---|
| Read repair | Each quorum read | Keys being read | Free (piggybacks on reads) |
| Hinted handoff | Coordinator detects dead replica during write | Writes the coordinator handled, while hints stay within TTL/cap | Local hint-store I/O |
| **Anti-entropy** | **Periodic + on-recovery + admin** | **All keys, regardless of access pattern** | **Background scan** |

Anti-entropy is the only one that catches divergence on cold keys. It's also the only one that closes the "the coordinator crashed before writing a hint" hole. If a node has been dead for a week and just came back, hinted handoff has long since dropped its hints; anti-entropy is what brings the recovered node back into sync.

The price is the scan. Each round walks the local DB, hashes each key's `(timestamp, deleted)` triple into a Merkle tree, and exchanges that tree with one peer. With reasonable parameters this is cheap enough to run every ten minutes by default, but it's still a real cost — which is why anti-entropy ships disabled by default and is opt-in via the `AntiEntropy.Enabled` config flag.

## Tree Design

The tree is fixed-fanout, fixed-depth, and stored level-by-level as flat `[]uint64` slices. Defaults: fanout 16, depth 4, giving 65,536 buckets at the leaves. A serialized tree is 512 KB. Small enough to send wholesale on a full-mismatch fallback; small enough that I don't have to worry about per-bucket memory.

Each leaf is a commutative XOR accumulator over its bucket's entries:

```go
func entryHash(e Entry) uint64 {
    keyH := xxhash.Sum64(e.Key)
    tsBytes, _ := e.Timestamp.Encode()
    tsH := xxhash.Sum64(tsBytes)
    var delByte uint64
    if e.Deleted {
        delByte = 1
    }
    return keyH ^ tsH ^ delByte
}
```

Three things to flag about that hash:

**xxhash, not SHA-256.** I'm not defending against an adversary, just detecting unequal data. xxhash is 10–20× faster on commodity hardware and produces 64-bit outputs that match the tree's storage format directly. Go's runtime already pulls in `cespare/xxhash/v2` transitively, so it's free.

**XOR for accumulation.** Order-independent. The bucket hash depends only on the *set* of entries, not the order they were scanned. This matters because the underlying storage is an LSM with concurrent compaction — scan order isn't even guaranteed to be stable across runs of the same DB. Using XOR means I never have to sort within a bucket.

**Value bytes are excluded from the hash.** The LWW conflict resolution looks at `(timestamp, deleted)` only. If two replicas agree on the timestamp and tombstone bit, they agree on the result of conflict resolution, regardless of whether the bytes happen to match. Hashing the value would waste CPU on data the resolution layer doesn't care about.

Internal nodes use position-sensitive hashing — `xxhash` over the concatenation of child hashes — because divergence localization needs to know *which* child differs:

```go
func hashChildren(children []uint64) uint64 {
    buf := make([]byte, 8*len(children))
    for i, h := range children {
        binary.BigEndian.PutUint64(buf[i*8:], h)
    }
    return xxhash.Sum64(buf)
}
```

### Grace period

There's one filter applied symmetrically on both sides: any entry whose HLC wall time is within a grace period of "now" (default 30 seconds) is excluded from the tree. This prevents in-flight writes — a write that hit replica A but hasn't yet reached replica B — from looking like persistent divergence. The grace cutoff is computed by the initiator and pinned in the digest sent over the wire, so both sides apply the *same* cutoff. Otherwise A and B could disagree about which entries count.

This is the standard Cassandra trick. Without it, anti-entropy would generate a steady stream of false repair events on any cluster taking writes faster than the round-trip time of the slowest replica.

## Range Model

The hash ring uses a uint64 hash space. The LSM scan API works on byte-ordered keys. These don't compose naturally, and the obvious move — scanning in hash space — would require sorting the entire dataset per round. Untenable for any real workload.

The actual approach: scan the local DB byte-ordered, filter to keys where both `selfID` and `peerID` are in the top-N replica set for the key, and bucket by `xxhash(userKey) % numLeaves`. Both sides build identical trees because:

- The ring descriptor version is pinned in the digest, so ownership agrees.
- The bucket-assignment function is deterministic and depends only on the user key.
- The LSM merge iterator emits one latest-version envelope per user key (this is invariant #1 from the design — see below).

The "co-replicas under N" lookup is delegated to a new method on the ring:

```go
func (r *Ring) CoReplicas(nodeID string, n int) []string
```

The first version of this method had a subtle bug worth calling out. I started with a sampling-based probe: enumerate each member, ask the ring `GetNodes(memberID, n)` for a few synthetic keys per member, and union the windows that contained `nodeID`. It passed the small-cluster tests. Then I asked Claude to push back on it, and it pointed out that with 10 nodes and N=3, samples can easily miss peer pairs whose vnodes happen to land outside the sampled windows.

The fix is exhaustive: walk every vnode position on the ring, compute the N-distinct-owner window starting there, and union all windows that contain `nodeID`. O(V·N) where V is total vnodes — fine for a method called once per reconcile round. The ground-truth test that catches the regression is one of the more valuable tests in the package: build a 20-node N=3 cluster, run `CoReplicas` for each node, and compare against the union of windows produced by 50,000 random key probes through `GetNodes`. The two must match. The old probe-based version failed it. The new one passes.

## Three Invariants

There are three correctness properties anti-entropy has to preserve, and they're worth being explicit about because each one is a place LWW can go subtly wrong:

**1. Snapshot-filtered iteration only.** The tree must be built from the latest visible version of each key, never from the all-versions raw iterator. If you accidentally hash an old version of a key alongside its current version, you'll produce a leaf hash that no other replica can ever match. The DB's `Scan()` wraps `SnapshotIterator`, which filters to one entry per latest user key — this is what the source uses. There's a unit test that writes a key twice with different timestamps and asserts only the newer version contributes to the leaf hash.

**2. Verbatim envelope on repair — no re-stamping.** This is the critical one. Repair must write the *source replica's* HLC timestamp and tombstone bit, byte for byte. It must *not* go through `Coordinator.Write` or `Coordinator.Delete`, which stamp `clock.Now()` and would create a new LWW-winning version that silently overwrites concurrent writes elsewhere in the cluster.

The fix is to extract the existing `localRepair` code path that read repair already used into a shared helper:

```go
func (c *Coordinator) ApplyRepair(
    ctx context.Context,
    targetID, targetAddr string,
    key, value []byte,
    ts hlc.Timestamp,
    deleted bool,
) error {
    if targetID == c.selfID {
        encoded, err := EncodeEnvelope(Envelope{
            Timestamp: ts, Deleted: deleted, Value: value,
        })
        if err != nil {
            return err
        }
        return c.localDB.Put(key, encoded)
    }
    return c.remoteWrite(ctx, targetAddr, key, value, ts, deleted)
}
```

Now read repair and anti-entropy share a single repair path, and the invariant lives in one place. The unit tests for `ApplyRepair` verify that local, remote, and tombstone repairs all preserve `(wall, logical, nodeID, deleted)` exactly across the round trip.

**3. Bounded-memory streaming.** The server-side leaf-listing RPC (`GetAELeafKeys`) is a server-stream, written one entry at a time as the server iterates its bucket. It must not buffer the full bucket in memory. The leaf-by-leaf comparison on the initiator must consume the peer's stream incrementally and emit repair operations as it goes — never materializing both sides into slices for diffing.

This last invariant turned out to be more subtle than I expected, and gets its own bug story below.

## RPC Protocol

Three new RPCs on `InternalService`:

```protobuf
rpc ComputeAERoot(AERootRequest) returns (AERootResponse);
rpc GetAESubtree(AESubtreeRequest) returns (AESubtreeResponse);
rpc GetAELeafKeys(AELeafRequest) returns (stream AELeafEntry);
```

The flow on the initiator side:

1. Build the local tree.
2. Call `ComputeAERoot` on the peer. If roots match, done.
3. BFS descent: enqueue the root path `[]`, call `GetAESubtree(path)`, compare the peer's child hashes against the local tree's children at the same path. For each child index that differs, enqueue the extended path. Stop descending at the leaf level and record the bucket index.
4. For each divergent bucket, stream `GetAELeafKeys(bucket)` from the peer. Stream-merge the peer's keys against the local bucket in user-key order. For each `(key, peerTs, peerDel)` vs `(localTs, localDel)`:
   - Both sides have the key, peer is newer → `ReplicateRead` to fetch the value, then `ApplyRepair` locally.
   - Both sides have the key, local is newer → batch into `ReplicateWriteBatch` and push to peer.
   - Only peer has it → pull as above.
   - Only local has it → push as above.

Everything routes through `ReplicateWriteBatch` and `ApplyRepair`. No new repair primitives.

### The proto field that quietly broke everything

The first version of the digest message had a single `peer_id` field meaning "the other replica we're reconciling with". The initiator sets `peer_id = "node-1"` (the target it's talking to) and ships the digest. The receiver reads `digest.PeerId == "node-1"` and uses it to filter — except on the receiver, "the other end" isn't `"node-1"`, it's the *initiator*.

What this meant in practice: both sides built trees filtered against `(self="node-1", peer="node-1")`. Because no key has itself as a co-replica, the filter rejected every entry. Both trees were empty. Both roots matched. The reconcile returned "in sync, 0 keys repaired" in microseconds and the integration test failed with no obvious error message — just `divergent=0 repaired=0` and a cheerful exit code.

The fix is to identify both endpoints unambiguously:

```protobuf
message AEKeyspaceDigest {
  uint64 ring_version = 1;
  string initiator_id = 2;       // node that started this round
  string target_id = 3;          // node serving this RPC
  uint32 depth = 4;
  uint32 fanout = 5;
  int64  grace_cutoff_wall = 6;
  int32  replication_factor = 7;
}
```

Each side now computes the "other" endpoint from its own perspective:

```go
func (d keyspaceDigest) OtherFrom(selfID string) string {
    switch selfID {
    case d.InitiatorID:
        return d.TargetID
    case d.TargetID:
        return d.InitiatorID
    default:
        return ""
    }
}
```

The bug was caught by an `Info`-level debug log added to the AE service that printed `self=X peer=Y scanned=N`. The first run after wiring everything together printed `self=node-1 peer=node-1 scanned=1` — and the typo-shaped impossibility of "self equals peer" made it obvious. Without that log line I'd have spent a long time staring at the BFS descent code looking for the wrong bug.

The lesson, generalized: any wire format that names a peer is ambiguous unless it names *both* endpoints. "The peer" is a relative pronoun. Protocols should not contain relative pronouns.

## Two Bugs From the Integration Test

Once the digest semantics were fixed, the integration test made forward progress and immediately surfaced two more bugs. Both are the kind of thing that's hard to catch with unit tests alone — they only emerge when the storage layer, the iterator, and the RPC layer are all live simultaneously.

### Bug 1: Iterator slices invalidated by Next

The DB's iterator interface documents that `iter.Key()` and `iter.Value()` return slices that are valid only until the next call to `iter.Next()`. The first version of `DBSource.Next` did this:

```go
for s.iter.IsValid() {
    ikey := s.iter.Key()
    userKey := kv.UserKey(ikey)
    val := s.iter.Value()
    s.iter.Next()                       // invalidates ikey, val
    // ... filter, decode envelope, hash with values now invalid
}
```

The hashes computed downstream were over whatever bytes had ended up in those slices' backing memory after `Next()` overwrote them. Sometimes valid data from the next entry; sometimes garbage; never the entry I thought I was hashing.

The bug was invisible in single-process tests because the iterator was running on a freshly-built memtable and the slices happened to remain pointing at the right bytes long enough to produce the correct hash. It manifested only when the LSM had compaction activity overlapping with the scan — exactly the workload an integration test produces.

The fix is the boring discipline iteration always demands: copy out the key and value bytes *before* calling Next.

```go
userKey := kv.UserKey(s.iter.Key())
keyCopy := make([]byte, len(userKey))
copy(keyCopy, userKey)

val := s.iter.Value()
valCopy := make([]byte, len(val))
copy(valCopy, val)

s.iter.Next()
```

I've made this mistake before and I'll make it again. Rust's borrow checker would flag it; Go's documentation comments don't.

### Bug 2: The local iterator and the local Put

This one was more interesting and took the longest to diagnose.

The reconciler's `reconcileBucket` function originally stream-merged the local bucket against the peer's bucket: open a `BucketSource` (an iterator over the local LSM filtered to one bucket), open the gRPC stream, walk both in lock-step, and emit `ApplyRepair` calls as divergences are found.

The integration test hung. The goroutine dump showed:

```
goroutine 144 [sync.RWMutex.Lock]:
sync.(*RWMutex).Lock(...)
github.com/ulixert/theseon/memtable.(*Memtable).Put(...)
github.com/ulixert/theseon/db.(*DB).Put(...)
github.com/ulixert/theseon/cluster.(*Coordinator).ApplyRepair(...)
github.com/ulixert/theseon/cluster/antientropy.(*reconciler).reconcileBucket.func3(...)
```

A single goroutine was simultaneously holding the memtable's read lock (via the open `BucketSource` iterator) and trying to acquire its write lock (via `db.Put` from `ApplyRepair`). Go's `sync.RWMutex` is not reentrant. The writer waits forever for itself to release the read lock.

The Memtable's `Scan()` documentation actually says this directly:

> The returned iterator holds a read lock on the memtable. Callers MUST call Close() when done to release the lock. While the iterator is open, writes to this memtable will block.

Reading this after the fact, the design constraint is obvious. Reading it before, with an architecture in mind that wanted to interleave streaming and Puts, it didn't register.

The fix is a phase boundary inside `reconcileBucket`: drain the local bucket fully into memory, close the iterator, *then* stream-merge against the peer.

```go
// Drain local bucket into memory, then close the iterator. After
// this the memtable is unlocked and Puts can run.
localEntries, err := r.drainLocalBucket(bucket)
if err != nil {
    return 0, err
}

// Peer leaf stream — server side stays fully streaming.
stream, err := client.GetAELeafKeys(ctx, &pb.AELeafRequest{
    Digest:      digest.toProto(),
    BucketIndex: uint32(bucket),
})
```

This is a partial retreat from invariant #3 — the initiator now buffers a whole bucket. With fanout 16 and depth 4 that's roughly `total_keys / 65536` per bucket on average, which is acceptable for a v1. The peer side stays fully streaming. The asymmetry feels ugly, but the alternative — a Go-level reentrant lock, or a separate snapshot copy of the bucket — is both more invasive and less honest about the actual cost.

## What I Got Right (Mostly)

The Merkle tree itself, the BFS descent, and the repair-helper extraction all worked the first time and didn't need to change after the integration test surfaced the harder bugs. A few specific things I'd do the same way again:

**The pure-Merkle-tree package has no dependency on anything cluster-aware.** The `Tree` type knows about `Entry`, `Source`, and `hlc.Timestamp` — nothing else. That meant the unit tests (determinism, commutativity, divergence localization, grace filter) could be written against an in-memory `sliceSource` without touching networking, RPC, or the storage layer. By the time I wired the tree into the reconciler, I trusted it.

**The `AntiEntropyTrigger` interface in the cluster package.** The natural place to put the admin RPC handler is `cluster/admin.go`, but that creates a cycle: `cluster` depends on `cluster/antientropy`, which already depends on `cluster` for the envelope helpers and the `Coordinator.ApplyRepair` method. The fix is the same shape as the hinted-handoff cycle break — define an interface in `cluster`, let `*antientropy.Manager` satisfy it structurally, and the parent package never names the child type:

```go
// In cluster/admin.go:
type AntiEntropyTrigger interface {
    Trigger(peerID string)
    TriggerAll()
    TriggerSync(ctx context.Context, peerID string) (AntiEntropyReconcileStat, error)
    TriggerSyncAll(ctx context.Context) []AntiEntropyReconcileStat
}
```

This is a pattern I keep using. Whenever the obvious wiring creates an import cycle, the answer is almost always "an interface in the parent, a structural impl in the child." Go's structural typing does its best work here.

**Forward-compat for the tombstone GC invariant.** Today, Theseon's compaction never drops tombstones — it's deferred to "MVCC-aware compaction" that doesn't exist yet. That means the tombstone-resurrection risk anti-entropy theoretically exposes (an old replica still holds the pre-tombstone value, peer GC'd the tombstone, anti-entropy resurrects the key) is impossible in the current build. The code has a placeholder log line where the invariant check belongs:

```go
n.logger.Debug("anti-entropy tombstone-retention check skipped: " +
    "tombstones currently never GC'd")
```

When MVCC-aware compaction lands, that log line becomes a real check that fails Start when `compactionTombstoneGrace ≤ AntiEntropy.Interval + safetyMargin`. Better to leave a marker now than to forget about the dependency in six months.

## What I Learned

A few things were genuinely new lessons, not just instances of patterns I already knew:

**Build the integration test even when the unit tests are passing.** The three real bugs in this change — the digest field, the slice invalidation, the memtable deadlock — were all invisible to unit tests. The Merkle tree tests passed. The ranges tests passed. The repair invariant tests passed. The full unit suite was green when the integration test first failed. That gap between "all units pass" and "the system actually works" is where every interesting bug lives.

The corollary: the cost of writing the integration test was tiny compared to the cost of shipping any one of those three bugs. The pull-repair test took maybe forty lines and caught the digest semantic problem in the first run.

**Wire-format ambiguity is a class of bug.** Once you've named a field "the peer" or "the other side" or "the source" without explicitly saying "from whose perspective", you've encoded a relative reference into an absolute medium. Both sides then interpret it absolutely, which means at most one of them is right. The fix isn't more documentation; it's making the field name impossible to misread.

**LSM iterators and LSM writers don't compose without thought.** This is the second time I've hit this in Theseon — once in [hinted handoff](/posts/theseon-hinted-handoff/) (delete-during-iterate deadlock in the drain loop), once here. Both times the fix was the same shape: collect under iteration, close the iterator, then mutate. Both times I knew the rule and forgot it because the architecture I was designing wanted to be streaming.

If there's a meta-lesson, it's that "streaming from start to finish" is a tempting design goal that fights the storage layer in any LSM with concurrent compaction. A phase boundary — drain, close, mutate — is sometimes the right answer, even when it costs you a little memory.

## What's Next

Anti-entropy ships disabled by default. Turning it on for a real workload requires running the integration test on representative data sizes, measuring the per-round scan cost, and deciding whether the default 10-minute interval is appropriate for the cluster's drift tolerance. None of those decisions belong in a v1.

The vector store doesn't have anti-entropy yet. The HNSW index has its own consistency model that doesn't compose cleanly with the per-key Merkle approach used here — divergent vector graphs aren't reconciled by writing newer versions of individual entries; they need either a full graph rebuild or a different repair primitive. That's a separate post.

And there are still the cleanups I mentioned at the end of the [benchmarks post](/posts/theseon-benchmarks/): coordinator-side vector-search drivers in the benchmark harness, snapshot restart latency for HNSW on 1M-vector graphs, eviction policy for the block cache. The list keeps getting shorter.

---

### In this series

1. [Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go](/posts/building-theseon/)
2. [Storage Foundation: SSTables, Memtables, and the WAL](/posts/theseon-storage-foundation/)
3. [Sequence Numbers, the Merge Iterator, and Wiring It All Together](/posts/theseon-wiring-it-together/)
4. [Making the Engine Self-Maintaining](/posts/theseon-self-maintaining/)
5. [Snapshots, Transactions, and the Art of Not Blocking Writers](/posts/theseon-mvcc-transactions/)
6. [Who's Alive? Building SWIM Failure Detection from Scratch](/posts/theseon-swim-protocol/)
7. [Quorum Reads, Quorum Writes, and the Repair That Follows](/posts/theseon-quorum-coordinator/)
8. [Buffering Writes for Dead Replicas: Hinted Handoff](/posts/theseon-hinted-handoff/)
9. [Building HNSW from Scratch](/posts/theseon-hnsw-scratch/)
10. [Making Vectors Durable](/posts/theseon-vector-kv-integration/)
11. [Fan-Out, Merge, Repair: Distributed Vector Search](/posts/theseon-distributed-vector-search/)
12. [Starting, Joining, Activating: The Node Orchestrator](/posts/theseon-node-orchestrator/)
13. [Benchmarking Theseon: KV, Cluster, Chaos, and HNSW on SIFT-1M](/posts/theseon-benchmarks/)
14. **Merkle Anti-Entropy: Catching Drift That Read Repair and Hinted Handoff Miss**

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- DeCandia, G., Hastorun, D., Jampani, M., et al. (2007). *Dynamo: Amazon's Highly Available Key-value Store*. SOSP '07. The original three-layer repair model: read repair, hinted handoff, and Merkle-tree-based anti-entropy as the safety net.
- Lakshman, A. & Malik, P. (2010). *Cassandra — A Decentralized Structured Storage System*. LADIS '09. Production Merkle anti-entropy with the grace-period trick to suppress in-flight-write false positives.
- Demers, A., Greene, D., Hauser, C., et al. (1987). *Epidemic Algorithms for Replicated Database Maintenance*. PODC '87. The original anti-entropy framing — "rumor mongering" and "anti-entropy" as complementary repair strategies.
- Merkle, R. (1988). *A Digital Signature Based on a Conventional Encryption Function*. CRYPTO '87. The hash-tree construction that makes incremental divergence localization possible.
- [`cespare/xxhash`](https://github.com/cespare/xxhash) — non-cryptographic 64-bit hash used for tree leaves and bucket assignment.
