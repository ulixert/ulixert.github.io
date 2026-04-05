---
title: "Who's Alive? Building SWIM Failure Detection from Scratch"
description: "How Theseon detects node failures without a leader — implementing the SWIM gossip protocol from the paper, the bugs that emerged, and why liveness and data ownership must be decoupled."
publishDate: "2026-03-29"
updatedDate: "2026-03-29"
tags: ["go", "databases", "theseon", "distributed-systems", "swim", "gossip", "failure-detection"]
order: 6
---

At the end of the [last post](/posts/theseon-mvcc-transactions/), Theseon was a complete single-node storage engine. This post starts the distributed layer. Before quorum reads, replicated writes, or anti-entropy repair, the cluster needs to answer a more basic question: *who's alive?*

A node that can't reach a peer needs to know whether the peer is temporarily slow or permanently gone. Get it wrong in one direction and you route traffic to a dead node. Get it wrong in the other and you start expensive data migration for a node that was just rebooting.

This post covers how I implemented the SWIM protocol for decentralized failure detection — the algorithm, the implementation, the bugs, and a design decision that turned out to be more important than the protocol itself.

## The Failure Detection Design Space

Failure detection has three properties in tension. You can optimize for any two, but the third suffers.

**Detection speed** — how quickly a failed node is identified. **Accuracy** — how rarely a healthy node is falsely declared dead. **Bandwidth** — how many messages per second the protocol consumes.

Heartbeating (every node broadcasts "I'm alive" to every other node) gives fast detection and reasonable accuracy, but costs O(N²) messages per round. At 100 nodes, that's 9,900 messages per second for liveness alone. At 1,000, nearly a million.

A centralized coordinator (one node tracks everyone) costs O(N) messages, but the coordinator is a single point of failure. If it goes down, the entire cluster loses failure detection until a new coordinator is elected — which itself requires a failure detection mechanism.

SWIM (Das et al. 2002) targets a different point: O(N) messages, no central coordinator, with detection speed that scales logarithmically. The tradeoff is *consistency* — different nodes may temporarily disagree about who's alive. For a database using quorum coordination, this is acceptable. The coordinator doesn't need a globally consistent membership view; it needs a *local* liveness signal that's accurate enough to decide "should I send an RPC to this node, or store a hint?"

SWIM achieves this with two mechanisms: a probe-based failure detector and epidemic-style gossip dissemination.

## The Probe Cycle

Every gossip interval (default: 1 second), a node runs one probe cycle against a single peer:

```
                    ┌──────────────────────┐
                    │  Pick probe target   │
                    │  (round-robin over   │
                    │   shuffled members)  │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │    Direct Ping       │──── ack ──→ Alive ✓
                    │  (PingTimeout=500ms) │
                    └──────────┬───────────┘
                               │ timeout
                               ▼
                    ┌──────────────────────┐
                    │   Indirect Ping      │──── any ack ──→ Alive ✓
                    │  (ask K=3 random     │
                    │   peers to relay)    │
                    └──────────┬───────────┘
                               │ all fail
                               ▼
                    ┌──────────────────────┐
                    │   Mark Suspect       │
                    │  (SuspectTimeout=5s) │──── refuted ──→ Alive ✓
                    └──────────┬───────────┘
                               │ timer fires
                               ▼
                    ┌──────────────────────┐
                    │     Mark Dead        │
                    └──────────────────────┘
```

The direct ping is the common case — one RPC roundtrip per probe round, O(N) messages cluster-wide per round. The indirect ping path activates only on failure, adding K additional RPCs. Even during failures, message cost stays O(N).

**Why indirect pings matter.** A single dropped packet or a brief network asymmetry between two specific nodes shouldn't trigger a false positive. If Node A can't reach Node B, but Node C can reach both, C's indirect ping proves B is alive. This is SWIM's key insight over simple heartbeating: the cluster's *collective* reachability is more reliable than any single node's perspective.

**Why Suspect exists.** Declaring a node Dead immediately on ping failure would be too aggressive — a GC pause, a loaded network interface, or a transient routing problem would cause false positives. The Suspect state is a probationary period. The suspected node continues receiving probes from other members, giving it multiple chances to respond and prove it's alive. Only after `SuspectTimeout` (default: 5 seconds) with no response from any path does the node transition to Dead.

The tradeoff is detection latency. A truly dead node takes `PingTimeout + SuspectTimeout` (5.5 seconds with defaults) to be declared Dead. During that window, the coordinator may still attempt RPCs to it (they'll fail with timeouts, reducing quorum response speed but not correctness). For Theseon's use case — coordinating quorum reads and writes — a few seconds of detection delay is acceptable. The coordinator treats RPC failures as missing quorum acks, and hinted handoff ensures writes aren't lost.

### Target selection

Targets aren't chosen uniformly at random each round. Instead, the member list is shuffled and probed round-robin. When the list is exhausted, it's reshuffled and the cycle starts over.

This is more than an optimization — it's a correctness property. Random selection can, by bad luck, skip a node for many rounds. In a 10-node cluster with random selection, the probability of not probing a specific node for 50 consecutive rounds is (9/10)^50 ≈ 0.5%. That's a 50-second detection blind spot. Round-robin guarantees every member is probed exactly once per full round — the complete detection time is bounded by N × GossipInterval.

## Agreeing on State Without Consensus

In a decentralized system, different nodes can have different views of who's alive. Node A thinks Node B is Suspect; Node C thinks Node B is Alive (because B responded to C's indirect ping). When A and C gossip, whose view wins?

Consensus protocols like Raft would give a definitive answer — the leader decides. But SWIM explicitly avoids consensus. The goal isn't a globally consistent view; it's *convergence*. Given enough gossip rounds, all nodes should agree. SWIM achieves this with incarnation numbers and a deterministic merge rule.

### Incarnation numbers

Each node has a monotonic incarnation counter, starting at 1. The merge rule for resolving conflicts:

1. **Higher incarnation always wins**, regardless of liveness state.
2. **Same incarnation**: Dead > Suspect > Alive.

Rule 2 means that once a node is suspected, the suspicion propagates. But what if the node is actually fine? SWIM gives the suspected node a way to fight back: increment its incarnation and broadcast that it's Alive.

```
Node B receives gossip: {B, Suspect, incarnation=5}

B is alive. B refutes:
  B.incarnation = 5 + 1 = 6
  Broadcast: {B, Alive, incarnation=6}

All nodes merge: incarnation 6 > 5 → Alive wins.
```

This creates a protocol-level guarantee: only a node itself can increment its own incarnation. No other node ever modifies it. This invariant is critical — violating it (as I discovered when ring state changes accidentally bumped incarnation) breaks the convergence property. If Node A can increment Node B's incarnation, the merge rule can't determine which update is authoritative.

The tradeoff: a truly dead node can't refute. Once a node actually fails, the Suspect→Dead transition is irreversible (until the node recovers, which starts a new lifecycle with a higher incarnation from the recovered node's perspective).

## Gossip Dissemination

SWIM doesn't use separate gossip messages. State changes — "node-3 is now Suspect," "node-5 refuted with incarnation 12" — are piggybacked on the ping and ack messages that the probe cycle already sends. This means dissemination costs zero extra messages.

Each state change enters a retransmit buffer with a counter set to `RetransmitMult × ⌈log₂(N)⌉`. Every outgoing message selects updates with the highest remaining retransmit count (freshest first) and attaches them. Only piggybacked items get their counter decremented. When the counter reaches zero, the update is removed.

```
Node A detects: node-3 is Suspect (cluster size = 10)
  → retransmits = 4 × ⌈log₂(10)⌉ = 4 × 4 = 16

Round 1: A pings node-7, piggybacks {node-3, Suspect}
  → node-7 merges, queues own retransmit

Round 2: A pings node-4, piggybacks again
  → meanwhile, node-7 pings node-2, piggybacks

After ⌈log₂(10)⌉ ≈ 4 rounds:
  → all 10 nodes have merged the update
```

The retransmit multiplier determines the redundancy factor. Higher values mean updates are piggybacked on more messages, increasing the probability that every node receives them even with packet loss. The tradeoff is bandwidth: each piggybacked update is ~50 bytes (node ID, address, liveness, ring state, incarnation), so 10 updates × 50 bytes = 500 bytes per message. At the default multiplier of 4 with 10 nodes, the buffer rarely exceeds 30-40 entries.

When the retransmit buffer overflows (capped at `MaxBroadcasts`, default 128), entries are sorted by retransmit count and the lowest-count items — those that have been most widely disseminated already — are dropped. Anti-entropy (a separate background process comparing merkle tree digests between replicas) serves as a safety net for any updates that didn't fully propagate.

## The Bugs

Implementing the algorithm from the paper was straightforward. Getting the implementation correct took several rounds of review. Here are the bugs that mattered.

### Ring state overwritten by gossip

Theseon tracks two independent axes per node: SWIM liveness (Alive/Suspect/Dead) and ring ownership (None/Joining/Active). The original `mergeLocked` did `*local = remote` on higher incarnation — a full struct copy. This overwrites the ring state.

The problem: Node A runs an admin command setting node-2 to RingActive. Node B hasn't seen the admin command yet, so its gossip for node-2 still says RingNone. If Node B has a higher incarnation (because node-2 refuted a suspicion), the merge overwrites RingActive with RingNone.

The fix: preserve local ring state during merge. Ring state only changes via the versioned ring descriptor, never via SWIM gossip.

```go
localRing := local.Ring
*local = remote
local.Ring = localRing
```

### Callbacks under a write lock

Liveness change callbacks (`OnLivenessChange`) were originally fired inside `setLivenessLocked`, which runs under the membership write lock. If a callback called `GetMembers()` — which acquires a read lock — deadlock.

In Go, `sync.RWMutex` is not reentrant. A goroutine holding a write lock cannot acquire a read lock on the same mutex, even from the same goroutine. The callback pattern seemed safe because callbacks received all necessary data as arguments. But it's fragile — a future callback that calls back into Membership would deadlock silently.

The fix: `setLivenessLocked` returns a `*livenessEvent` struct. Callers collect events during the locked section, then fire them after `mu.Unlock()`:

```go
m.mu.Lock()
event := m.setLivenessLocked(target.NodeID, Suspect)
cb := m.onLivenessChange
m.mu.Unlock()

if event != nil && cb != nil {
    cb(event.nodeID, event.from, event.to)
}
```

### Gossip-learned liveness changes silently swallowed

`setLivenessLocked` handled all the side effects of a liveness transition: tracking when nodes die (for reaping), cancelling suspect timers, incrementing the membership generation counter, firing callbacks. But `mergeLocked` — the function that applies gossip updates — was changing liveness by direct field assignment, bypassing all of it.

If Node C detected a failure, marked node-2 Dead, and gossiped it to us, our `mergeLocked` would update `local.Liveness = Dead` but never fire the callback, never track deadSince, never cancel the suspect timer if we had one running locally.

The fix: `mergeLocked` routes all liveness transitions through `setLivenessLocked`. On higher-incarnation merge, the struct copy sets liveness to the old value first, then calls `setLivenessLocked` for the transition if needed:

```go
if remote.Incarnation > local.Incarnation {
    oldLiveness := local.Liveness
    *local = remote
    local.Ring = localRing
    local.Liveness = oldLiveness  // restore old
    m.memberGen++

    if newLiveness != oldLiveness {
        return m.setLivenessLocked(remote.NodeID, newLiveness)
    }
    m.queueBroadcastLocked(*local)
    return nil
}
```

### Retransmit counter decremented for unsent items

The original `getBroadcastsLocked` decremented every item's retransmit counter, even items that weren't piggybacked because the limit was reached:

```go
for i := range m.broadcasts {
    if len(result) < limit {
        result = append(result, m.broadcasts[i].state)
    }
    m.broadcasts[i].retransmits--  // ALL decremented
}
```

With 20 broadcasts and a limit of 10, the last 10 lose a retransmit opportunity without ever being sent. Under sustained churn, updates can expire before being disseminated.

### Probe order ABA bug

The probe order was rebuilt when the number of alive members didn't match the order's length. But if one node died and another joined simultaneously, the count stayed the same. The order contained the dead node and was missing the new one.

The fix: a monotonic generation counter that increments on any membership change. The probe order stores the generation it was built at and rebuilds when the generation advances — no counting, no ABA.

## Decoupling Liveness from Ownership

The most important design decision wasn't in the protocol implementation — it was the separation between SWIM liveness and ring ownership.

Most distributed databases couple the two. When a node is declared dead, it's removed from the hash ring. Its key ranges shift to surviving nodes, triggering data migration. When the node recovers, it re-joins as a fresh member and rebalances again.

The problem: most failures are transient. A node reboots in 30 seconds, a network link flaps for 10 seconds, a GC pause triggers a false positive. Each time, the cluster moves gigabytes of data to surviving nodes, then moves it back when the node recovers. In the worst case, the rebalance is still running when the node comes back — causing a second rebalance that conflicts with the first.

Theseon decouples the two into independent axes:

```
Liveness (SWIM, automatic):       Alive ←→ Suspect ←→ Dead
Ring ownership (admin, explicit):  None  →  Joining  →  Active
```

When SWIM marks a node Dead, the ring is untouched. The dead node still owns its virtual nodes. The coordinator routes around it: reads skip dead replicas, writes go to hinted handoff (a local buffer that replays when the node recovers). No data moves. When the node comes back, SWIM marks it Alive, the hint drainer replays buffered writes, and anti-entropy fixes any remaining divergence.

Ring changes only happen via explicit admin commands: `join`, `activate`, `remove`. An operator decides when a node is permanently gone. This is a deliberate choice to prefer manual intervention over automated ring management. The tradeoff:

- **What you gain:** Zero data migration on transient failures. No cascading rebalances. A network partition that heals in 60 seconds causes zero ring churn.
- **What you give up:** An operator must run `admin remove` for permanent failures. If a disk dies at 3 AM, the cluster operates with degraded redundancy until someone acts. For a resume project, this is acceptable. For production, you'd add a policy engine that auto-removes after a configurable threshold (e.g., dead for 1 hour with no recovery).

The node join lifecycle makes this explicit:

```
1. New node boots, discovers cluster via SWIM    → Liveness: Alive, Ring: None
   (receives gossip, but can't serve reads or writes — not in ring)

2. Operator runs: theseon admin join --addr=X   → Ring: Joining
   (receives replicated writes + anti-entropy bootstrap, still skipped for reads)

3. Operator monitors progress, then:
   theseon admin activate node-4                → Ring: Active
   (full participant — reads and writes)
```

The ring descriptor that tracks these states is versioned and piggybacked on every gossip message. Admin commands include a CAS guard (`expected_version`) to prevent concurrent commands from creating conflicting descriptors. The cost is ~100 bytes per gossip message for a 10-node cluster — negligible compared to the probe itself.

## Testing Without a Network

The SWIM protocol logic is decoupled from networking via a `Transport` interface:

```go
type Transport interface {
    Ping(ctx context.Context, addr string, msg *PingMessage) (*PingMessage, error)
    PingReq(ctx context.Context, addr string, targetID, targetAddr string) (bool, error)
    GossipSync(ctx context.Context, addr string, members []MemberState, ringDesc *RingDescriptor) ([]MemberState, *RingDescriptor, error)
}
```

In production, `GRPCTransport` implements this via gRPC. In tests, a `mockTransport` with configurable function fields controls exactly what each RPC returns:

```go
tp := &mockTransport{
    pingFn: func(addr string, msg *PingMessage) (*PingMessage, error) {
        if addr == "10.0.0.2:9090" {
            return nil, errors.New("timeout")
        }
        return &PingMessage{SenderID: "node-3", SenderAddr: addr}, nil
    },
}
```

This makes every SWIM scenario deterministic. Testing the suspect timeout uses `time.AfterFunc` with short durations (50ms) and `time.Sleep` to wait for the timer to fire. The race detector runs on every test — it caught the `getBroadcastsLocked` mutation under `RLock` that a unit test wouldn't.

35 tests cover merge logic, probe cycles, suspect/dead transitions, refutation, gossip sync, ring descriptor propagation, callback safety, dead node reaping, probe order generation, broadcast priority, and concurrent safety under the race detector.

## What I Learned

The SWIM paper is clear and the core algorithm is simple. The difficulty isn't in the protocol — it's in the interactions between the protocol and the rest of the system. Ring state overwritten by gossip. Callbacks deadlocking under a lock. Liveness changes from gossip bypassing side effects. These are integration bugs, not algorithm bugs.

The two-axis design (liveness vs. ownership) turned out to be more important than any particular protocol detail. In a distributed database, the most expensive operation is data migration. Any design that triggers migration on transient failures — and in practice, most failures are transient — is going to cause more problems than the failures themselves.

The Transport interface was a force multiplier for testing. Every SWIM scenario — asymmetric failure, indirect ping success, self-refutation, gossip convergence — became a 20-line test function with a mock that controls exactly which RPCs succeed and fail. Without it, testing would require spinning up real gRPC servers and introducing flaky timing dependencies.

## What's Next

The cluster knows who's alive. The next step is making it useful: wrapping values in HLC-timestamped envelopes, building a quorum coordinator that fans out reads and writes to replicas, and implementing read repair so stale replicas converge on every read.

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- Das, A., Gupta, I., & Motivala, A. (2002). *SWIM: Scalable Weakly-consistent Infection-style Process Group Membership Protocol*. DSN '02. The original SWIM paper.
- Gupta, I., Chandra, T., & Goldszmidt, G. (2001). *On Scalable and Efficient Distributed Failure Detectors*. PODC '01. Foundational work on gossip-style failure detection.
- [HashiCorp memberlist](https://github.com/hashicorp/memberlist) — Production SWIM implementation in Go. Informed several design choices, particularly retransmit counting and suspicion sub-protocol.
- [Serf](https://www.serf.io/docs/internals/gossip.html) — HashiCorp's gossip agent built on memberlist. The documentation on convergence and protocol tuning was helpful.
