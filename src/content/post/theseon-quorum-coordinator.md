---
title: "Quorum Reads, Quorum Writes, and the Repair That Follows"
description: "How Theseon's coordinator fans out operations to replicas, resolves conflicts by HLC timestamp, and repairs stale data in the background — plus the latency traps and test design bugs that emerged."
publishDate: "2026-03-31"
updatedDate: "2026-03-31"
tags: ["go", "databases", "theseon", "distributed-systems", "quorum", "read-repair", "coordinator"]
order: 7
---

At the end of the [last post](/posts/theseon-swim-protocol/), the cluster could detect failures and propagate membership changes. Every node had a local view of who's alive. But that's infrastructure — it doesn't serve reads or writes yet.

This post covers the coordinator: the component that receives a client request on any node and turns it into a distributed operation. It fans out writes to N replicas, waits for W acknowledgements, fans out reads to the same replicas, waits for R responses, picks the newest value, and repairs any replica that fell behind. The consistency guarantee comes from a simple arithmetic property: if R + W > N, every read quorum overlaps with every write quorum. There's always at least one replica that saw the most recent write.

The coordinator is conceptually straightforward. The interesting parts are the latency decisions, the repair design, and the bugs — particularly one where my tests were passing for the wrong reasons.

## The Envelope

Before the coordinator can compare values across replicas, it needs a way to determine which value is newer. Raw bytes don't have a natural ordering. The solution is an **envelope** — a thin wrapper that prepends an HLC timestamp and a deleted flag to every value before storing it in the local LSM engine.

```
[version:1][deleted:1][timestamp:variable][value:*]
```

The LSM engine sees only opaque bytes. It doesn't know about timestamps, doesn't know about replicas, doesn't need to. The envelope is decoded at the coordinator layer when comparing replicas, and at the `ReplicateWrite` handler when receiving a write from a remote coordinator.

Conflict resolution is last-writer-wins (LWW): `NewerEnvelope` compares HLC timestamps and returns whichever is higher. Ties are broken by NodeID for determinism — all replicas agree on the same winner without coordination.

Tombstones matter here. A delete is not the absence of a value; it's a value with `Deleted: true` and its own HLC timestamp. If a delete has a higher timestamp than a concurrent write, the delete wins. If the write is newer, it wins. Without timestamped tombstones, a deleted key could be resurrected by a stale replica that still has the old value — a correctness bug that's subtle to detect and expensive to debug.

The tradeoff: every value now has at least 16 bytes of overhead (version, deleted flag, HLC timestamp). For large values this is negligible. For a key-value pair where the value is 8 bytes, it doubles the storage. For Theseon's use case — a general-purpose database, not a counter store — this is acceptable.

## The Write Path

A client calls `Put(key, value)` on any node. That node becomes the coordinator for this operation. It doesn't need to be the "owner" of the key — any node can coordinate any key.

```
Client → Put("user:42", data)
           │
           ▼
     Coordinator (any node)
           │
     clock.Now() → HLC timestamp
     ring.GetNodes(key, N=3) → [node-1, node-3, node-5]
           │
     ┌─────┼──────────┐
     ▼     ▼          ▼
  node-1  node-3    node-5
  (local)  (RPC)     (RPC)
     │     │          │
     ▼     ▼          ▼
  db.Put  ReplicateWrite  ReplicateWrite
           │
     Wait for W=2 acks
           │
     ◄─────┘
     Return success to client
```

The coordinator stamps the write with `clock.Now()`, looks up N replicas from the hash ring, and fans out. If it's one of the replicas itself, it writes locally — no gRPC roundtrip, just `db.Put` with the encoded envelope. For remote replicas, it sends `ReplicateWrite` RPCs.

**Routing decisions.** The coordinator checks each replica's liveness before sending:

- **Alive** — send the RPC. The normal path.
- **Suspect** — still send the RPC. One dropped SWIM ping doesn't mean the node is unreachable for data-plane traffic. The RPC has its own timeout (`PerReplicaTimeout`, default 5 seconds). If the node really is failing, the RPC times out and counts as a failure. If it was a false positive, the write succeeds.
- **Dead** — skip. The write won't reach this replica. Hinted handoff (a future post) will buffer it locally and replay when the node recovers.
- **Joining** — send the write. Joining nodes are catching up on data. They need to receive writes to stay current, even though they're not yet serving reads.

The tradeoff with Suspect routing: you pay a potential 5-second timeout for a node that might be failing. The alternative — skipping Suspect nodes — means that a single dropped SWIM ping causes a replica to miss writes that would otherwise succeed. Since SWIM's Suspect state lasts 5 seconds before transitioning to Dead, and the RPC timeout is also 5 seconds, the worst case is one slow write. The coordinator doesn't wait for it if quorum is already met.

### Quorum latency

The first implementation waited for all N replicas to respond before checking if W succeeded. This is correct but slow. If node-5 is across an ocean and takes 200ms while node-1 and node-3 respond in 5ms, the client waits 200ms for a write that had quorum in 5ms.

The fix: exit the collection loop as soon as W acks arrive, or as soon as quorum becomes impossible.

```go
maxFailures := len(replicas) - c.cfg.WriteQuorum + 1
successes := 0
failures := 0
var errs []error

for successes < c.cfg.WriteQuorum && failures < maxFailures {
    a := <-acks
    if a.err == nil {
        successes++
    } else {
        failures++
        errs = append(errs, fmt.Errorf("node %s: %w", a.nodeID, a.err))
    }
}
```

`maxFailures` is the count at which quorum becomes impossible regardless of what happens next. With N=3 and W=2, `maxFailures = 2`. If two replicas fail, the remaining one can't provide two acks.

The `acks` channel is buffered to `len(replicas)`. After the coordinator returns, the remaining goroutines complete and write their results to the channel without blocking. The channel is garbage collected once all goroutines finish. No goroutine leak, no cleanup code.

What you gain: write latency is determined by the W-th fastest replica, not the slowest. What you give up: nothing for correctness. The remaining RPCs still execute — they contribute to durability even though the client already got its response.

## The Read Path

Reads are more complex than writes because they need to resolve conflicts and trigger repair.

The coordinator fans out `ReplicateRead` to all readable replicas — meaning routable (Alive or Suspect) and not Joining. Joining nodes are excluded because they may not have all data yet; reading from them could return a false "not found."

### Two-phase collection

The first version collected all responses before returning. This has the same latency problem as the original write path — one slow replica delays the read even when R responses are already available.

But reads have an additional constraint that writes don't: the coordinator needs to see all responses to know which replicas are stale and need repair. If it returns after R and discards the rest, slow-but-stale replicas are never repaired.

The solution is a two-phase design:

**Phase 1** collects responses until R successes arrive (or quorum becomes impossible), using the same early-exit pattern as writes. The coordinator picks the newest value from these R responses and returns it to the client immediately.

**Phase 2** runs in a background goroutine. It drains the remaining in-flight responses from the buffered channel, checks whether any late response has a newer value (possible if the write-ack node was slow), and sends repair writes to every stale replica it finds.

```go
// Phase 2 (background): collect remaining and repair all stale.
remaining := len(readable) - len(quorumResponses) - failures
go c.collectAndRepair(key, newest, quorumResponses, results, remaining)

return ReadResult{Value: newest.resp.Value, Found: true, Deleted: newest.resp.Deleted}, nil
```

What you gain: read latency is determined by the R-th fastest replica; repair coverage includes all responding replicas. What you give up: a brief window where the returned value could be slightly stale if the newest replica was slow and only responded in phase 2. Under the R+W>N guarantee this can't happen — the overlap ensures at least one phase-1 response has the newest write — but in degraded scenarios (fewer than N replicas available), it's possible. Anti-entropy handles these edge cases.

### The R+W>N guarantee

With N=3, W=2, R=2: a write succeeds on at least 2 of 3 replicas. A read collects from at least 2 of 3. The Pigeonhole principle guarantees overlap. There's always at least one replica that participated in both the write and the read.

This is why the coordinator can return after R responses and be confident it has the newest value. It doesn't need to see all N. It doesn't need consensus. It just needs the arithmetic to work out.

## Read Repair

When the coordinator finds a stale replica — one that responded with an older timestamp or with "not found" — it fires off a `ReplicateWrite` with the newest envelope. The client doesn't wait. If the repair fails, it's logged and anti-entropy will catch it later.

```
Read quorum:    node-1 → {key: "x", ts: 100}   (stale)
                node-3 → {key: "x", ts: 200}   (newest)
                node-5 → (still in-flight, collected in phase 2)

Phase 2:        node-5 → {key: "x", ts: 100}   (stale)

Repair fires:   ReplicateWrite(node-1, key="x", value=..., ts=200)
                ReplicateWrite(node-5, key="x", value=..., ts=200)
```

Self-repair handles the case where the coordinator's own local data is stale. If the coordinator is node-1 in the example above, the repair is a local `db.Put` — no RPC, just an envelope encode and a write to the LSM engine.

Read repair has a fundamental limitation: it only runs on reads. A key that is written once and never read will stay divergent across replicas forever. If node-5 missed the write and no client ever reads that key, read repair never fires. This is why anti-entropy — a background process that compares merkle tree digests between replica pairs — is necessary. Read repair is opportunistic; anti-entropy is systematic.

## The Connection Pool

The coordinator sends RPCs to replicas. Each RPC needs a gRPC connection. Managing these connections is the PeerPool's job.

The pool is deliberately separate from the SWIM transport. SWIM probes are lightweight, short-lived, and run on a 1-second interval. Data-plane RPCs are heavier, potentially long-lived, and bursty. Sharing connections between the two would create conflicting lifecycle requirements — SWIM's idle detection would close connections that data-plane traffic wants to keep warm, or data-plane traffic would prevent SWIM from detecting truly idle peers.

gRPC multiplexes RPCs over a single connection, so one connection per peer is sufficient. The pool caches connections and stamps a `lastUsed` time on each access. A background goroutine ticks at `IdleTimeout/2` intervals and evicts connections that haven't been used within the timeout. This prevents unbounded growth as nodes join, leave, or change addresses over the cluster's lifetime.

The pool has a proper lifecycle: after `Close()`, `GetClient` returns `ErrPoolClosed`. Without this, background repair goroutines — which outlive the request that spawned them — could create new connections on a pool that's supposed to be shut down.

## The Bugs

### Error swallowing in write failures

The write collection loop stored only the last error:

```go
var lastErr error
for range replicas {
    a := <-acks
    if a.err != nil {
        lastErr = a.err  // overwrites previous
    }
}
```

With N=3 and W=2, if node-2 fails with "connection refused" and node-3 fails with "not routable," the returned error only mentions "not routable." The first failure is logged but lost from the error chain returned to the client.

The fix: collect all errors into a slice, join them with `errors.Join`. The `maxFailures` bound (typically 1-2) keeps the slice tiny.

### Quorum loop waited for all replicas

Already described above. The fix — early exit after W acks — seems obvious in retrospect. The original code was `for range replicas`, which reads all N results from the channel regardless of how many successes have been collected. The intent was "check quorum after collecting all," but the effect was "let the slowest replica determine your latency."

### Read repair blind to late responses

The initial read implementation collected all responses synchronously, then repaired. When I added quorum-latency early exit (return after R), I forgot to handle the remaining responses. The code returned after R, and the slow replicas' results were silently drained by Go's garbage collector — never inspected for staleness, never repaired.

The fix was the two-phase design: return after R, but hand the channel to a background goroutine that collects the rest and repairs.

### Tests with impossible quorum states

This was the most instructive bug. I wrote a test for read repair with three replicas: node-1 had an old value, node-2 had a new value, and node-3 had an old value. The test asserted that node-2's value was returned and the stale replicas were repaired.

The problem: this state is *impossible* under W=2. If the write that produced the "new" value succeeded with W=2, at least two replicas must have it. A state with exactly one new-value replica means W=1, not W=2.

With the original "collect all" implementation, the test passed because all three responses were collected and node-2's value was always seen. After adding quorum-latency early exit, the test became flaky — sometimes the first R=2 responses were node-1 and node-3 (both old), and the coordinator returned "old" because it never saw node-2's response.

The fix was redesigning tests to model valid post-write states. For a W=2 write, at least 2 of 3 replicas have the new value. Under R+W>N, any R=2 selection from those 3 replicas is guaranteed to include at least one new-value replica. The test became deterministic because the property it was testing — "quorum reads see the newest write" — is guaranteed by the arithmetic, not by goroutine scheduling.

### Idle timeout was dead config

The `PeerPoolConfig` had an `IdleTimeout` field. `GetClient` stamped `lastUsed = time.Now()` on every access. The pool never actually checked the timestamps. Connections accumulated forever. The fix was a background goroutine that ticks at `IdleTimeout/2` and evicts stale entries — the same approach used for dead node reaping in the membership layer.

## Dual-Mode Server

The gRPC server operates in two modes with zero feature flags:

```go
func (s *Server) Put(ctx context.Context, req *pb.PutRequest) (*pb.PutResponse, error) {
    if s.coordinator != nil {
        if err := s.coordinator.Write(ctx, req.Key, req.Value); err != nil {
            return nil, status.Errorf(codes.Internal, "coordinator write: %v", err)
        }
        return &pb.PutResponse{}, nil
    }
    // Standalone mode — direct db.Put.
    if err := s.db.Put(req.Key, req.Value); err != nil {
        return nil, status.Errorf(codes.Internal, "put: %v", err)
    }
    return &pb.PutResponse{}, nil
}
```

If a coordinator is wired in, `Put`, `Get`, and `Delete` delegate to it. If not, they call the local `db.DB` directly. Same handler, same gRPC service, same proto messages. The choice is made at server construction via `WithCoordinator(c)`, not at runtime via config flags.

One subtlety: the coordinator returns tombstones as `ReadResult{Found: true, Deleted: true}`. The server handler converts this to `GetResponse{Found: false}` for the client. The coordinator needs to see tombstones for read repair — you can't repair a deletion if you can't see it. But clients don't need to know about tombstones; a deleted key is simply not found.

## What I Learned

The quorum coordinator is conceptually simple — fan out, collect, compare timestamps — but the latency decisions are where the complexity lives. The difference between "wait for all, then check quorum" and "exit as soon as quorum is met" is a single loop condition, but it changes the p99 latency profile from "slowest replica" to "W-th fastest replica." For reads, getting both low latency (return after R) and comprehensive repair (inspect all responses) required a two-phase design that wasn't in the original plan.

The test bug taught me something I should have known: test scenarios need to be reachable states of the system, not arbitrary states that exercise a code path. A test with W=2 and only 1 replica holding the new value is testing a state that the system can't produce. When the implementation changed (quorum-latency early exit), the test broke — not because the implementation was wrong, but because the test was asserting a property that was never guaranteed.

Read repair is valuable but incomplete. It only runs on reads. A key that's written and never read stays divergent across replicas until anti-entropy runs. This is fine — three repair mechanisms (read repair, hinted handoff, anti-entropy) form a layered defense where each catches what the others miss. But it means read repair alone is not a convergence guarantee.

## What's Next

Two holes remain. When a replica is dead during a write, the write is simply skipped — hinted handoff will buffer it locally and replay when the node recovers. And for divergence that neither read repair nor hinted handoff catches — keys that were never read, hints that were lost, replicas that were down for longer than the hint TTL — anti-entropy with merkle trees provides the final safety net.

---

### Read next
[**Buffering Writes for Dead Replicas: Hinted Handoff**](/posts/theseon-hinted-handoff/)

---

### In this series
1. [Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go](/posts/building-theseon/)
2. [The Storage Foundation](/posts/theseon-storage-foundation/)
3. [Wiring It All Together](/posts/theseon-wiring-it-together/)
4. [Making the Engine Self-Maintaining](/posts/theseon-self-maintaining/)
5. [Snapshots, Transactions, and the Art of Not Blocking Writers](/posts/theseon-mvcc-transactions/)
6. [Who's Alive? Building SWIM Failure Detection from Scratch](/posts/theseon-swim-protocol/)
7. **Quorum Reads, Quorum Writes, and the Repair That Follows**
8. [Buffering Writes for Dead Replicas: Hinted Handoff](/posts/theseon-hinted-handoff/)
9. [Building HNSW from Scratch](/posts/theseon-hnsw-scratch/)
10. [Making Vectors Durable](/posts/theseon-vector-kv-integration/)
11. [Fan-Out, Merge, Repair: Distributed Vector Search](/posts/theseon-distributed-vector-search/)
12. [Starting, Joining, Activating: The Node Orchestrator](/posts/theseon-node-orchestrator/)

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- DeCandia, G., Hastorun, D., Jampani, M., et al. (2007). *Dynamo: Amazon's Highly Available Key-value Store*. SOSP '07. The original leaderless quorum design with sloppy quorum, hinted handoff, and anti-entropy.
- Vogels, W. (2009). *Eventually Consistent*. Communications of the ACM, 52(1). Accessible overview of consistency models and the CAP tradeoff.
- Lakshman, A. & Malik, P. (2010). *Cassandra — A Decentralized Structured Storage System*. LADIS '09. Production implementation of Dynamo-style quorum coordination with read repair and anti-entropy compaction.
- Bailis, P. & Ghodsi, A. (2013). *Eventual Consistency Today: Limitations, Extensions, and Beyond*. Communications of the ACM. Clarifies what eventual consistency does and does not guarantee.
