---
title: "Starting, Joining, Activating: The Node Orchestrator"
description: "How Theseon goes from a pile of components to a runnable cluster — the voter/learner split that plugs a read-after-write hole, atomic ring rebuild, and why the first cluster node has no seeds."
publishDate: "2026-04-17"
updatedDate: "2026-04-17"
tags: ["go", "databases", "theseon", "distributed-systems", "orchestration", "cli", "grpc"]
series: "Building Theseon"
part: 12
order: 12
---

The [last post](/posts/theseon-distributed-vector-search/) finished distributed vector search. Coordinator fan-out, exact reranking, post-merge validation, read repair. That completed the headline feature. But to actually *run* any of it — standalone KV, distributed KV, vector search — you had to write a Go program. Open the database, construct the vector store, create the HLC, instantiate SWIM, wire the coordinator, register services, start the gRPC server, hope you got the ordering right. Eleven components, each with their own lifecycle and dependencies, and no single place that knew how to bring them up cleanly.

This post covers the release that closes the gap: a `Node` orchestrator that owns the startup sequence, an `AdminService` that lets operators form rings and promote members, and a CLI with `serve` and `admin` subcommands. Three problems showed up along the way that I didn't expect: a read-after-write visibility hole created by the ring's own design, a ring rebuild that could be observed mid-swap, and a panic from an all-zero config that the defaults system was supposed to prevent.

## The Startup Order Problem

Eleven components, and most of them depend on each other. The database backs the vector store. The vector store needs the database open first. The HLC needs a node ID. The hash ring needs to be swapped atomically when SWIM propagates ring descriptor changes. The coordinator needs the ring, the membership, the clock, the database, and a dialer for peer RPCs. The hint store needs its own database at a different path. The drainer needs the hint store, the dialer, and membership for liveness queries. The gRPC server needs all of these to serve a meaningful RPC. SWIM needs the gRPC listener to be up before it announces the node to peers.

The naive answer is "do it in the right order." That's what the original `cmd/theseon/main.go` did for standalone mode — 61 lines, one linear path, no error recovery. Scaling that to cluster mode meant a strict two-phase sequence: a *construct* phase where every component is created but nothing runs in the background, followed by a *go* phase where everything starts in the right order.

```
Start(ctx):
  ── construct phase ──
  1.  Open database
  2.  Create vector store
  3.  Create TCP listener                ← resolves :0 to an actual port
  4.  Create HLC clock
  5.  Create empty hash ring
  6.  Create SWIM membership             (not started)
  7.  Create peer pool
  8.  Create coordinator + wire hints
  9.  Create hint store + drainer        (not started)
 10.  Wire OnRingChange, OnLivenessChange
 11.  Create gRPC server + register services

  ── go phase ──
 12.  Start gRPC server                  ← now accepting RPCs
 13.  Start SWIM membership              ← node discoverable
 14.  Start drainer sweep loop
```

The listener moves to step 3 — before SWIM is even constructed — because SWIM's config needs the resolved address. If you pass `--addr=:0` for ephemeral ports (the integration test does this constantly), `net.Listen` returns a listener bound to some port the kernel picked. SWIM needs to know what that port is so it can advertise a real address to peers. If SWIM is constructed before the listener, you're gossiping an address nobody can connect to.

The gRPC server starts *before* SWIM, not after. This is the subtler ordering rule: a node shouldn't announce itself to peers before it's ready to serve their RPCs. If SWIM starts first and the peer sees a gossip message, it might try to reach the node for a gossip sync or an indirect ping before the gRPC server is accepting connections. You get spurious probe failures at boot time. Start the server first, let the port be reachable, *then* let SWIM tell the world you exist.

## Rollback on Partial Start

A fourteen-step startup has fourteen places to fail. The database opens fine, then the vector store fails to rebuild HNSW from disk, and now you've got an open database, a goroutine pool, and no way to shut down cleanly. The old standalone main didn't care — it called `log.Fatalf` and let the process die. The cluster node has too much state for that. Dropped file locks on Badger databases, unflushed memtables, orphan goroutines — these aren't OK to leak even for a doomed process.

The fix is a cleanup stack. Each successful construction pushes its cleanup function. On failure, unwind in reverse:

```go
func (n *Node) Start(ctx context.Context) error {
    var cleanups []func()
    cleanup := func() {
        for i := len(cleanups) - 1; i >= 0; i-- {
            cleanups[i]()
        }
    }

    database, err := db.Open(opts)
    if err != nil { return err }
    cleanups = append(cleanups, func() { database.Close() })

    vs, err := vector.NewVectorStore(database, n.cfg.Vector)
    if err != nil {
        cleanup()              // unwinds database.Close
        return err
    }
    cleanups = append(cleanups, func() { vs.Close() })

    // ... eleven more steps, same pattern ...

    // Success — Stop() handles teardown from here.
    n.cleanups = nil
    return nil
}
```

The "success — nil the cleanups" step is important. After `Start` returns, the node is running and `Stop` takes over teardown. You don't want the cleanup stack to fire twice. And `Stop` itself runs in reverse order: `GracefulStop` the gRPC server first (so no new RPCs arrive), then `drainer.Stop` (no more hint dispatches), then `membership.Stop` (no more SWIM traffic), then `peerPool.Close` (severs outbound connections), then the stores — hint store, vector store, database — in that order.

The reasoning for that shutdown order mirrors startup: stop accepting work before tearing down dependencies. A gRPC handler holding a lock on the vector store while the vector store is mid-close is a crash. A drainer mid-replay while the peer pool is being torn down is a deadlock. Work first, dependencies last.

## The Voter/Learner Split

This one took a minute to see.

The ring descriptor has two active states: `RingJoining` (a new node that's been added but isn't ready to serve) and `RingActive` (a fully-participating replica). The coordinator's read path has always treated these differently:

```go
// From coordinator.go, unchanged since day one of the cluster PR:
for _, r := range replicas {
    if c.membership.IsRoutable(r.ID) && c.membership.RingStateOf(r.ID) != RingJoining {
        readable = append(readable, r)
    }
}
```

Reads skip JOINING replicas. They may not have all the data yet. The vector search path does the same thing. Makes sense.

The write path didn't make the distinction:

```go
// Before:
for _, replica := range replicas {
    go sendWrite(replica)           // everyone gets the write
}
// ... wait for W acks ...
```

Every replica the ring returned got a write. Every ack counted toward W. If N=3, W=2, and two of the three returned replicas were JOINING, a write could succeed with two JOINING acks and zero Active acks. The write is "committed." Quorum met. The coordinator returns success to the client.

Then the client reads. The read path filters JOINING out. It only consults the Active replicas. But Active has never seen this write. **The read returns "not found" for a value that was successfully written thirty milliseconds ago.**

Read-after-write visibility, broken. Not in a race condition, not under load — in the happy path of a ring with a joining node.

The fix is what I'm calling the voter/learner split, borrowed from Raft terminology for non-voting members. JOINING nodes in the ring are *learners*: they receive writes for data seeding, but their acks don't count toward quorum. Only Active nodes are *voters*. Quorum is measured against voters:

```go
replicas := c.ring.GetNodes(key, c.cfg.ReplicationFactor)

var voters, learners []hashring.Node
for _, r := range replicas {
    if c.membership.RingStateOf(r.ID) == RingJoining {
        learners = append(learners, r)
    } else {
        voters = append(voters, r)
    }
}

if len(voters) < c.cfg.WriteQuorum {
    return fmt.Errorf("%w: have %d voters, need %d",
        ErrNotEnoughReplicas, len(voters), c.cfg.WriteQuorum)
}

// Fire-and-forget to learners. No quorum impact, no hints on failure.
for _, node := range learners {
    go func(n hashring.Node) {
        if !c.membership.IsRoutable(n.ID) { return }
        c.remoteWrite(ctx, n.Addr, key, value, ts, deleted)
    }(node)
}

// Normal quorum write to voters. Hints stored for dead voters only.
// ... existing quorum machinery, but only len(voters) replicas ...
```

The same fix applies to `VectorWrite` and `VectorDelete`. Two small structural changes, same pattern.

What learners buy: a JOINING node receives live writes while it's joining. By the time the operator runs `admin activate`, the node has every write that occurred during the join window. The gap — historical data that was written *before* the join — still needs a separate backfill mechanism (streaming from peers, anti-entropy reconciliation), but the gap is bounded.

What learners cost: nothing in the common case. A JOINING node that's about to become Active can't slow down writes, can't block quorum, can't cause a committed write to be invisible to reads. If a learner is dead or slow, nobody waits for it. No hints are stored for dead learners — if the operator is doing a join and the target dies, the operator notices and does a `remove` + `join` retry.

The fix is under a hundred lines of actual code. Most of the diff is moving existing code from "iterate replicas" to "iterate voters." But the correctness delta is large: a two-phase rollout (`join` → `activate`) that was quietly broken in the middle phase is now sound.

## Atomic Ring Rebuild

The hash ring has always had `AddNode` and `RemoveNode` methods that take a write lock and modify the underlying vnodes slice. That works fine when changes are incremental. It doesn't work when the ring descriptor flips from one membership set to a completely different one.

The ring descriptor comes in via SWIM gossip. A peer might accept a `JoinRing` admin RPC, bump the descriptor version, and gossip the new descriptor. By the time our node sees it, the ring might have gained two members and lost one. The `OnRingChange` callback needs to converge the local `*hashring.Ring` to match.

The obvious approach:

```go
// DON'T DO THIS.
for _, oldNode := range ring.Members() { ring.RemoveNode(oldNode.ID) }
for _, newNode := range newMembers { ring.AddNode(newNode) }
```

This is visibly wrong. Between the loop that removes old nodes and the loop that adds new ones, the ring is *empty*. Any concurrent `GetNodes` call — from a coordinator write, a vector search, a read — sees zero replicas. `ErrNotEnoughReplicas`. Returns a failure to the client.

You could do it under a single write lock by exposing `ring.mu` to callers. That's awful API design.

The right fix is `ReplaceMembers`: build the new ring state entirely *outside* the lock, then swap both internal fields under a single `mu.Lock`:

```go
func (r *Ring) ReplaceMembers(nodes []Node) {
    // All construction happens outside the lock.
    newNodes := make(map[string]Node, len(nodes))
    newVnodes := make([]vnode, 0, len(nodes)*r.vnodesPerNode)
    for _, n := range nodes {
        newNodes[n.ID] = n
        for i := range r.vnodesPerNode {
            newVnodes = append(newVnodes, vnode{
                hash:   hashVnode(n.ID, i),
                nodeID: n.ID,
            })
        }
    }
    slices.SortFunc(newVnodes, func(a, b vnode) int {
        return cmp.Compare(a.hash, b.hash)
    })

    // Atomic swap. Readers either see the old ring or the new ring. Never both.
    r.mu.Lock()
    r.nodes = newNodes
    r.vnodes = newVnodes
    r.mu.Unlock()
}
```

The critical section is two pointer assignments. Concurrent `GetNodes` callers holding the read lock see either the fully-old ring or the fully-new ring. They never observe an empty ring, a half-populated ring, or an unsorted vnodes slice. The SHA-256 work for building vnodes happens without holding the lock — building the new ring for a three-node cluster with 150 vnodes per node is 450 hashes, not something to do inside a critical section that blocks every read.

The swap is O(1). The build is O(N × vnodesPerNode × log). Readers pay O(1) extra latency in the worst case — one lock acquisition — regardless of how large the ring is.

## The Defaults Panic

The Node struct takes a `Config` with sub-structs: `ClusterConfig` for SWIM parameters, `CoordinatorConfig` for quorum. Each has a `DefaultXxxConfig()` constructor that returns sensible values — 1s gossip interval, 500ms ping timeout, N=3, W=2, R=2, 5s per-replica timeout. The CLI was supposed to populate these.

The CLI populated `Coord` with the flags (`--replication-factor`, `--write-quorum`, `--read-quorum`), but didn't set `Cluster` at all. It also didn't set `Coord.PerReplicaTimeout` — no CLI flag for it. The assumption was that `Config.defaults()` on the Node side would fill in missing fields.

`defaults()` filled in `HintDir` (default `DataDir/hints`) and `Logger` (default `slog.Default()`). Nothing else. The Cluster field stayed at its zero value. The Coord timeout stayed at zero.

The first `theseon serve` crashed immediately:

```
panic: non-positive interval for NewTicker

goroutine 16 [running]:
time.NewTicker(0x0?)
    /opt/homebrew/opt/go/libexec/src/time/tick.go:38 +0xbc
github.com/ulixert/theseon/cluster.(*Membership).probeLoop(...)
    /Users/matt/Developer/GolandProjects/theseon/cluster/swim.go:17 +0x54
```

`time.NewTicker(m.cfg.GossipInterval)` with a zero interval. Go's `time` package rejects non-positive durations by panicking. The SWIM probe loop dies on its first tick attempt, and the whole node with it.

There are two ways to handle this. One is "whole-struct replacement": if `GossipInterval` is zero, replace the whole `Cluster` struct with `DefaultClusterConfig`. Simple, but it clobbers any individual overrides. If someone set only `PingTimeout`, it gets wiped when we detect `GossipInterval == 0`.

The other is "per-field defaults": check each field individually. More verbose, but it clobbers partial configs:

```go
func (c *Config) defaults() {
    // ... HintDir, Logger ...

    dcc := cluster.DefaultClusterConfig(c.NodeID, c.Addr)
    if c.Cluster.GossipInterval == 0 {
        c.Cluster.GossipInterval = dcc.GossipInterval
    }
    if c.Cluster.PingTimeout == 0 {
        c.Cluster.PingTimeout = dcc.PingTimeout
    }
    if c.Cluster.SuspectTimeout == 0 {
        c.Cluster.SuspectTimeout = dcc.SuspectTimeout
    }
    // ... five more fields ...

    dco := cluster.DefaultCoordinatorConfig()
    if c.Coord.ReplicationFactor == 0 {
        c.Coord.ReplicationFactor = dco.ReplicationFactor
    }
    // ... three more ...
}
```

Verbose. But the CLI can now set N/W/R from flags and leave `PerReplicaTimeout` unset — the defaults fill it in without trampling the CLI's values. A test can set `GossipInterval = 100 * time.Millisecond` for fast gossip and let everything else default. Partial overrides compose.

The lesson isn't about the defaults system itself — it's about where configuration meets invariants. `time.NewTicker(0)` is a precondition violation the ticker doesn't tolerate. The defaults system is the boundary between "user gave me a config" and "everything downstream assumes sane values." That boundary needs to be thorough, not convenient.

## First Node Has No Seeds

The original plan said `--seeds` empty means standalone mode. That makes sense for operator ergonomics — don't run SWIM if there's nobody to gossip with. Until you remember the bootstrap: the *first* cluster node has no seeds. There's literally nothing to connect to. SWIM starts with an empty member list and waits for someone to discover it.

The tension is real. `--seeds=""` could mean either:
- "I'm running standalone. Don't start SWIM."
- "I'm the first cluster node. Start SWIM with no seeds; peers will find me when they start."

The original plan inferred standalone from `len(--seeds) == 0`. That would make it impossible to bootstrap a cluster without lying about seeds.

The fix is to use `--node-id` as the cluster-mode signal instead:

```
theseon serve --addr=:50051 --data-dir=./data1                         # standalone
theseon serve --addr=:50051 --data-dir=./data1 --node-id=node-1        # first cluster node
theseon serve --addr=:50052 --data-dir=./data2 --node-id=node-2 \
              --seeds=localhost:50051                                   # joining node
```

`--node-id` has no default — no hostname fallback, no UUID generation. If you don't explicitly give your node an identity, you're not in a cluster. Standalone mode is the default, and it stays the default even if you ever copy-paste a `--seeds` line without thinking about it.

The secondary benefit: the node ID is no longer a runtime-derived value that might differ across restarts. Hostname-based node IDs become wrong when the hostname changes, which happens silently under Kubernetes, container restarts, or DHCP. Forcing the operator to pick an ID makes it explicit: this filesystem, this data, this node ID. They come as a set.

## Admin Identity and CAS

`JoinRing` takes the new node's address. The original proto returned the discovered node_id — the idea was that the admin handler would look the node up in SWIM by address and return its ID. That's the opposite of explicit. What if SWIM hasn't discovered the node yet? What if two nodes advertised the same address (a config mistake that should be caught, not smoothed over)? Reverse lookups by address are fragile.

I added `node_id` to `JoinRingRequest`. The CLI now requires both:

```
theseon admin join --target=localhost:50051 --node-id=node-2 --addr=localhost:50052
```

The admin handler validates that `node_id` is known to SWIM — they must have already discovered each other via gossip — then adds the `(nodeID, addr)` pair to the ring descriptor as `Joining`. If the node isn't in SWIM yet, the handler returns a clear `FailedPrecondition` with "node not yet discovered" instead of silently failing or doing a probe.

All ring-mutating admin RPCs — `JoinRing`, `ActivateNode`, `RemoveNode` — take an `expected_version` field for compare-and-swap. The handler reads the current descriptor, compares versions, builds the new descriptor at version+1, and applies via `membership.ApplyRingDescriptor` (which has its own idempotent version check). On mismatch, the handler returns `FailedPrecondition` with the current version so the operator can retry:

```go
rd := s.membership.GetRingDescriptor()
if req.ExpectedVersion != rd.Version {
    return nil, status.Errorf(codes.FailedPrecondition,
        "version mismatch: expected %d, current %d",
        req.ExpectedVersion, rd.Version)
}
```

The CLI wraps this: `theseon admin join` calls `GetClusterStatus` first, pulls the current version, and passes it as `expected_version`. If two operators run `join` concurrently, one succeeds and one gets a clear retry-with-new-version error. No lost writes to the descriptor.

## Integration Testing, For Real

Previous tests used `bufconn` — in-memory gRPC, no TCP, no port allocation, no SWIM gossip over the wire. That's great for unit testing handler logic. It's useless for testing whether three nodes can actually form a cluster.

The new integration test uses real listeners on `localhost:0`, real TCP connections, real SWIM gossip, real hinted handoff:

```go
//go:build integration

func TestIntegration_ClusterFormation(t *testing.T) {
    dir := t.TempDir()
    n1 := startNode(t, node.Config{
        NodeID:  "node-1", Addr: "localhost:0",
        DataDir: filepath.Join(dir, "n1"),
        Cluster: testClusterConfig("node-1"),  // 100ms gossip
    })
    n2 := startNode(t, node.Config{
        NodeID:    "node-2", Addr: "localhost:0",
        DataDir:   filepath.Join(dir, "n2"),
        SeedPeers: []string{n1.Addr()},
        Cluster:   testClusterConfig("node-2"),
    })
    // ... n3 the same way ...

    // Wait for SWIM to see all 3 members.
    waitUntil(t, 5*time.Second, func() bool {
        return len(getClusterStatus(t, n1).Members) == 3
    })

    // Form the ring: join + activate both new nodes.
    adminJoin(t, n1.Addr(), "node-2", n2.Addr())
    adminActivate(t, n1.Addr(), "node-2")
    adminJoin(t, n1.Addr(), "node-3", n3.Addr())
    adminActivate(t, n1.Addr(), "node-3")

    // Coordinator write through node-1, read through node-2.
    put(t, n1.Addr(), key, value)
    got := get(t, n2.Addr(), key)
    require.Equal(t, value, got)
}
```

The `//go:build integration` tag keeps this out of the default `go test ./...` run — it binds real ports and takes a few seconds to converge. `go test -tags=integration ./node/...` runs it explicitly. That's the right tradeoff: fast unit tests for the inner loop, realistic integration tests for CI and release validation.

Gossip interval is 100ms for the test instead of 1s — three rounds of gossip in 300ms is enough for three nodes to discover each other, but still plenty fast for a human running `go test`. The `waitUntil` helper polls with a 5s deadline. If convergence takes longer than that, the test fails with a clear error instead of hanging.

A second integration test covers hinted handoff on node restart: start 3 nodes, form the ring, stop node-3, write keys that hash to node-3 (hints get stored on the coordinators), restart node-3, verify the hints drain. That path exercises SWIM's Dead→Alive liveness transition, the `OnLivenessChange` callback that triggers the drainer, the drainer's replay loop, and the target node's `ReplicateWrite` handler — a full slice of the distributed stack. Running it as a real integration test caught a shutdown race that wouldn't have appeared in a mocked test: the drainer was dispatching a hint while the node it targeted was being stopped, producing a context-canceled error that the drainer treated as a real failure and retried indefinitely. Fixed with a proper check-then-dispatch under the drainer's stop signal.

## What I Learned

The voter/learner thing is what I'll take away. It's the kind of bug that doesn't look like a bug: every piece of the system was working as designed. The ring returned replicas. The coordinator sent writes to replicas. The quorum counter counted acks. Reads filtered JOINING out — that filter was intentional, had its own comment, passed its tests. But nobody ever asked whether *both* paths were consistent. The write path and the read path disagreed about which replicas matter, and that disagreement created a hole.

The general lesson: when you have two paths that make decisions based on the same membership information, check that they make *consistent* decisions. Reads say "don't consult X." Writes say "but X got the data." The data is there, but it's not there. Membership-based filtering needs to be symmetric or clearly asymmetric-with-intent. Ours was asymmetric-by-accident.

The atomic ring rebuild is a different flavor. The fix is obvious once you see it — build outside the lock, swap under the lock, two assignments — but the *first* version of the code that I almost wrote was the clear-then-readd version, because that's what `AddNode` and `RemoveNode` already do. Composing existing primitives gave me an incoherent operation. The composed operation needed its own atomicity guarantee, which meant its own method. That's a pattern I keep running into: concurrency invariants don't compose. Two thread-safe operations back-to-back are not a thread-safe operation.

The defaults panic is more mundane but also more universal. The boundary between "user input" and "core invariants" is where panics live. Zero-valued configs, nil maps, empty strings — any place the system assumes validity is a place validation needs to be exhaustive. Per-field defaults are more code than struct-level replacement, but they let you enforce validity without clobbering legitimate overrides.

## What's Next

Two big things. First, anti-entropy: the background merkle-tree reconciliation that catches long-term replica divergence. Hinted handoff handles short outages; read repair handles staleness observed at search time. Neither fixes a replica that's been out of sync for longer than the hint TTL, or a vector that nobody ever searches for. Anti-entropy closes both gaps and, as a side effect, gives us the mechanism to backfill historical data to JOINING replicas.

Second, data streaming on topology change. Right now a JOINING node receives live writes (the learner path) but never catches up on historical data. The operator has to run `admin activate` and accept that the node might be missing anything written before the join. Real migration — copying the existing data from the old owners to the new node before activation — turns JOINING from a fire-and-forget window into a proper handoff phase. This is the last piece before Theseon can do rolling topology changes without losing data visibility.

---

### Read next
[**Benchmarking Theseon: KV, Cluster, Chaos, and HNSW on SIFT-1M**](/posts/theseon-benchmarks/)

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
12. **Starting, Joining, Activating: The Node Orchestrator**
13. [Benchmarking Theseon: KV, Cluster, Chaos, and HNSW on SIFT-1M](/posts/theseon-benchmarks/)

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- Ongaro, D. & Ousterhout, J. (2014). *In Search of an Understandable Consensus Algorithm*. USENIX ATC '14. Raft introduced the voter/learner distinction for joint consensus and single-server changes — non-voting members that receive log entries but don't count toward the majority. Theseon's voter/learner split for ring membership is the Dynamo-style analogue.
- Das, A., Gupta, I., & Motivala, A. (2002). *SWIM: Scalable Weakly-consistent Infection-style Process Group Membership Protocol*. DSN '02. The membership protocol Theseon uses — informs the startup ordering and liveness callback design.
- Lamport, L. (1998). *The Part-Time Parliament*. ACM TOCS. The original Paxos paper includes the compare-and-swap-style version discipline that the ring descriptor's CAS guards mirror.
