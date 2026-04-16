---
title: "Fan-Out, Merge, Repair: Distributed Vector Search"
description: "How Theseon routes a vector search across replicas — collection-name ring routing, exact reranking to fix HNSW graph divergence, LWW versioning in the encoding layer, and a post-merge validation bug that took three attempts to get right."
publishDate: "2026-04-14"
updatedDate: "2026-04-14"
tags: ["go", "databases", "theseon", "distributed-systems", "vector-search", "hnsw", "replication", "grpc"]
order: 12
---

The [last post](/posts/theseon-hinted-handoff/) built hinted handoff: when a replica is dead, the coordinator buffers writes and replays them on recovery. That completed the distributed KV layer — quorum reads, quorum writes, HLC timestamps, hinted handoff, all wired together. But there was no distributed *vector search*. A client could write vectors through the coordinator, but searching meant calling a single node directly. If your collection was replicated across three nodes, you had to pick one and hope its HNSW graph was up to date.

This post covers the headline feature: distributed vector search. A client sends a search request to any node; the coordinator fans out to replicas, each runs local HNSW search, and the coordinator merges results with exact reranking. The implementation produced three real problems: why you can't reuse the KV write path for vector routing, why post-merge validation can't stop at *k* results, and why read repair needs provenance tracking to avoid unnecessary writes.

## The Routing Problem

The KV coordinator hashes the *key* to determine which replicas store it. Each key lands on a different set of nodes. This is exactly wrong for vectors.

HNSW is a graph. Search starts at an entry point and greedily traverses neighbors. If vectors in a collection are scattered across nodes by key hash, each node has a random subset of the graph. Local search finds nothing useful — the graph is disconnected. For vector search to work, each replica needs the *entire* collection.

The fix is collection-name ring routing. Instead of hashing by vector key, the coordinator hashes by collection name:

```go
// KV: each key hashes to potentially different replicas.
replicas := c.ring.GetNodes(key, c.cfg.ReplicationFactor)

// Vectors: all vectors in a collection hash to the SAME replicas.
replicas := c.ring.GetNodes([]byte(collection), c.cfg.ReplicationFactor)
```

This means `VectorWrite` can't just call the existing `coordinator.Write`. The ring key is different. The write path, the delete path, and the search path all use the collection name for replica placement. A dedicated `VectorWrite` method does the same fan-out, quorum counting, and hinted handoff as the KV write path, but with the collection name as the ring key.

What you gain: each replica holds the full HNSW graph for the collection and can run a complete local search. What you give up: collection size is bound by single-node memory. A collection with 100 million vectors needs all of them on each of N replicas. This is the right tradeoff for the current scale — sharded collections (partitioned HNSW with scatter-gather search) would be a future phase.

## Versioning Vectors

The KV layer resolves conflicts at read time: the coordinator compares HLC timestamps from quorum responses and returns the newest. Writes don't check versions — they just write. Read repair fixes stale replicas after the fact.

This doesn't work for vectors. The HNSW graph is an in-memory structure that gets mutated immediately on `Put` and `Delete`. If a stale `Put` arrives after a newer `Delete`, the vector reappears in the graph. Two concurrent writes arriving in different orders on different replicas produce different graph states. With KV this is fine — read-time comparison picks the winner. With HNSW, the graph is already wrong.

The fix is write-time LWW in the vector encoding layer. I added a `VectorVersion` to the encoding format:

```go
type VectorVersion struct {
    WallTime int64   // nanoseconds since epoch
    Logical  uint32  // HLC logical counter
}
```

The encoding bumps from v1 to v2, adding 12 bytes of big-endian version data after the encoding version byte:

```
v2: [encVersion:1=2][walltime:8 BE][logical:4 BE][dim:2][floats][metadata]
v1: [encVersion:1=1][dim:2][floats][metadata]
```

Big-endian encoding matters: it's naturally lexicographic, so byte-level comparison gives correct ordering. Decoding handles both v1 (zero version implied) and v2 for backward compatibility.

`VectorStore.Put` and `Delete` now compare versions under the per-collection lock:

```go
col.mu.Lock()
defer col.mu.Unlock()

// LWW check: skip stale writes.
if !ver.IsZero() {
    if existing, found := vs.db.Get(vectorKey); found && !existing.Tombstone {
        existingVer, err := DecodeVectorVersion(existing.Data)
        if err == nil && !ver.After(existingVer) {
            return nil // stale write, skip
        }
    }
}
```

The lock is critical. Without it, two goroutines can both read the old version, both decide they're newer, and both apply — producing an inconsistent graph. The per-collection lock was already there (serializing HNSW mutations); the version check just goes inside the existing critical section.

### The packing mistake

My first attempt packed the version into a `uint64`:

```go
func hlcVersion(ts hlc.Timestamp) uint64 {
    return uint64(ts.WallTime)<<16 | uint64(ts.Logical)
}
```

This is wrong. `WallTime` is nanoseconds since epoch — roughly 1.7 * 10^18 as of 2026, which is about 61 bits. Shifting left by 16 overflows a 64-bit integer. The fix was keeping `WallTime` and `Logical` as separate fields. Sometimes the clever encoding is the broken one.

### The standalone version-zero bug

In standalone mode (no coordinator, no HLC), my first plan was to pass `VectorVersion{}` — the zero value. But the LWW rule says "if incoming <= stored, skip." Two writes with version zero: the first succeeds, the second is skipped as stale. Every standalone update after the first insert is silently dropped.

The fix is a per-process monotonic generator — a minimal local HLC:

```go
func (g *localVersionGen) Next() VectorVersion {
    g.mu.Lock()
    defer g.mu.Unlock()
    now := time.Now().UnixNano()
    if now > g.lastW {
        g.lastW = now
        g.lastL = 0
    } else {
        g.lastL++
    }
    return VectorVersion{WallTime: g.lastW, Logical: g.lastL}
}
```

Wall time advances when the clock advances; logical increments on ties. Strictly monotonic within a single process, no HLC dependency. Zero is reserved for legacy v1 records decoded from disk.

## The Search Path

The coordinator's `VectorSearch` fans out to all readable replicas, not just R. The standard KV read path waits for R responses and returns. For vector search, R successful responses guarantee availability, but more responses improve recall. Different replicas have different HNSW graph topologies (different insert order, different tombstone states, different replication lag), so the same vector may be found by one replica and missed by another. Merging all responses casts a wider net.

```
VectorSearch(collection, query, k):
  1. replicas = ring.GetNodes(collection, N)
  2. readable = filter(routable AND not JOINING)
  3. Fan out to ALL readable with k * oversample (default 4x)
  4. Require R successes, merge ALL responses before deadline
  5. Deduplicate, exact rerank, validate, sort, take top-k
```

### Why exact reranking

HNSW search returns approximate distances. These distances depend on the graph structure — the traversal path determines which nodes are visited and in what order. Since replicas have different graph structures, the same vector can have different distances on different replicas. If you merge results and sort by per-replica distances, the ordering is meaningless.

The coordinator recomputes every candidate's distance using the collection's distance function and the raw vector:

```go
distFn, err := c.vectorStore.DistanceFunc(collection)
for i := range deduped {
    deduped[i].Distance = distFn(query, deduped[i].Vector)
}
```

This requires replicas to return raw vectors in the search response. At dim=768, that's ~3KB per candidate. With 2 replicas returning 40 candidates each (k=10, 4x oversample), the total payload is ~240KB. Acceptable. The alternative — coordinator re-fetching vectors by ID — adds round trips.

## The Post-Merge Validation Bug

Post-merge validation checks each candidate against the coordinator's local state. If the local VectorStore has a newer version of a vector (updated or deleted), the result is substituted or removed. This catches stale results from lagging replicas.

My first implementation walked the sorted candidate list and stopped at *k* valid results:

```go
validated := make([]VectorSearchResult, 0, k)
for i := range deduped {
    if len(validated) >= k {
        break  // BUG
    }
    // ... validate, possibly substitute vector with different distance ...
    validated = append(validated, result)
}
slices.SortFunc(validated, cmpDistance) // re-sort after substitutions
```

The bug: when a candidate is substituted with a newer local vector, its distance changes. It might get *worse*. The re-sort after validation handles that — but the early exit at *k* means we never looked at candidates further down the list that might now rank higher than the substituted one.

Concrete example: candidates sorted by distance are A(0.1), B(0.2), C(0.3), D(0.4), E(0.5). With k=3, we validate A, B, C and stop. B gets substituted with a newer vector — new distance 0.9. After re-sort: A(0.1), C(0.3), B(0.9). But D(0.4) was never examined, and it's closer than the substituted B.

The fix: validate *all* candidates, then sort and truncate. The deduped set is small — at most R * k * oversample candidates, typically under 100. The cost of validating all of them is a few dozen KV reads, negligible compared to the HNSW search itself.

## Provenance-Tracked Read Repair

The KV read repair path sends the newest value to all stale replicas after a quorum read. My first plan for vector search was the same: after validation, push the newest version to all replicas that participated in the search. This works but is noisy. If three replicas return a result and two have the latest version, the third needs repair — but you'd send writes to all three.

The fix is provenance tracking. Each search result carries the ID of the node that returned it:

```go
type taggedResult struct {
    VectorSearchResult
    sourceNode string
}
```

During collection, results are tagged. During dedup, the provenance map records every `(UUID, nodeID, version)` tuple. During validation, when `GetLatest` finds a newer local version, the coordinator knows exactly which nodes returned the stale version and only repairs those:

```go
for _, pe := range provenance[r.ID] {
    if pe.nodeID != c.selfID && winningVersion.After(pe.version) {
        repairs = append(repairs, repairTarget{
            nodeID:  pe.nodeID,
            id:      r.ID,
            vec:     r.Vector,
            version: winningVersion,
        })
    }
}
```

Repairs are deduplicated per `(nodeID, vectorID)` pair and dispatched fire-and-forget — same pattern as KV read repair. The receiving replica's LWW check makes duplicate repairs idempotent.

## Config Digest Validation

`CreateCollection` is standalone-only for now — each node must have it called independently. If an operator creates a collection with `dim=768` on node A and `dim=384` on node B, distributed search silently returns garbage. Different dimensions mean different distance computations; different HNSW parameters mean different graph structures. Nothing crashes, the results are just wrong.

The fix is a config digest: an FNV-64a hash of `(dim, metric, M, efConstruct)` included in every internal RPC. The receiving replica computes its own digest and rejects on mismatch:

```go
localDigest := vector.ConfigDigest(cfg)
if req.ConfigDigest != 0 && req.ConfigDigest != localDigest {
    return nil, status.Errorf(codes.FailedPrecondition,
        "config digest mismatch for collection %q: local=%d, remote=%d",
        req.Collection, localDigest, req.ConfigDigest)
}
```

This catches the problem at write/search time with a clear error, not at result-interpretation time with silent corruption. Orchestrated collection creation (ensuring all replicas have matching configs) is deferred to the node orchestrator.

## Hinted Handoff for Vectors

The existing hint store stores raw envelope bytes and replays via `ReplicateWriteBatch`. Vector hints need `ReplicateVectorWrite` instead — the handler calls `vectorStore.Put`, which updates both KV and the HNSW graph.

The approach is type-tagged hint values. A 1-byte prefix identifies the hint type:

```go
const (
    HintKV           byte = 0x00
    HintVectorWrite  byte = 0xF1
    HintVectorDelete byte = 0xF2
)
```

The tag bytes are `0xF1`/`0xF2`, not `0x01`/`0x02`. I originally used low bytes and spent an hour debugging why existing KV hint replay broke. The envelope version byte is `0x01` — the same value as `HintVectorWrite`. Existing KV hints don't have a type prefix; their first byte is the envelope version. `ParseHintType` saw `0x01` and treated every KV hint as a vector write. The high-byte prefix avoids the collision entirely.

The drainer splits batches by type and replays them concurrently — KV hints via `ReplicateWriteBatch`, vector hints via injected callbacks. The `hintedhandoff` package never imports `vector`; the callbacks are wired in at construction.

## The Import Cycle

The coordinator (`cluster` package) needs to call vector store methods. The vector store (`vector` package) doesn't import `cluster`. But if `cluster` imports `vector`, and `vector` ever needs cluster types, we have a cycle.

The solution is the same one that worked for the hint drainer: an interface in `cluster`. The `LocalVectorSearcher` interface defines exactly what the coordinator needs — `Put`, `Delete`, `Search`, `DistanceFunc`, `GetLatest`, `ConfigDigest`, `CollectionReady`. The server layer wires in a `vectorStoreAdapter` that translates between `vector.VectorStore` and the cluster interface. Types like `VectorVersion` are duplicated across packages (same struct, different package paths), and the adapter converts between them.

## What I Learned

The biggest lesson was about the interaction between approximate search and exact validation. HNSW search is approximate by design — it trades recall for speed. When you distribute it, the approximation compounds: different replicas approximate differently because their graph structures diverge. Exact reranking fixes the ordering, but the candidate set is still approximate. Post-merge validation can improve it by substituting fresher data, but this changes distances and invalidates the existing ranking. You have to validate everything and re-sort, not take a shortcut at *k*. The optimization that seems obvious (stop when you have *k* results) is the one that introduces a correctness bug.

The version-packing mistake was a useful reminder that nanoseconds are big numbers. 2026 in nanoseconds is 61 bits. Any bit-shifting scheme that assumes wall time fits in 32 bits is wrong for nanosecond precision. Separate fields, explicit comparison, no cleverness.

Read repair provenance tracking felt like over-engineering at first — why not just broadcast repairs to all participants? Because idempotent doesn't mean free. Every unnecessary `ReplicateVectorWrite` to an already-up-to-date replica triggers a KV read (for the LWW check), a version comparison, and a skip. Harmless, but noisy — especially under read-heavy workloads where every search triggers repairs. Targeted repair turns O(N) writes per stale result into O(1).

## What's Next

Distributed vector search is the headline feature, but there are two gaps in the consistency model. Hinted handoff catches short outages; read repair catches staleness observed during search. But if a node is down longer than the hint TTL, or if a vector is stale on a replica that nobody searches, there's no mechanism to detect and fix it. Anti-entropy — background merkle-tree reconciliation between replica pairs — is the safety net that closes both gaps.

After that, the node orchestrator: orchestrated collection creation across replicas (eliminating the config-digest footgun), ring rebalancing, and an admin CLI for cluster management.

---

### In this series
1. [Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go](/posts/building-theseon/)
2. [The Storage Foundation](/posts/theseon-storage-foundation/)
3. [Wiring It All Together](/posts/theseon-wiring-it-together/)
4. [Making the Engine Self-Maintaining](/posts/theseon-self-maintaining/)
5. [Snapshots, Transactions, and the Art of Not Blocking Writers](/posts/theseon-mvcc-transactions/)
6. [Who's Alive? Building SWIM Failure Detection from Scratch](/posts/theseon-swim-protocol/)
7. [Quorum Reads, Quorum Writes, and the Repair That Follows](/posts/theseon-quorum-coordinator/)
8. [Buffering Writes for Dead Replicas: Hinted Handoff](/posts/theseon-hinted-handoff/)
9. [Building HNSW from Scratch](/posts/theseon-hnsw-scratch/)
10. [Making Vectors Durable](/posts/theseon-vector-kv-integration/)
11. **Fan-Out, Merge, Repair: Distributed Vector Search**

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- Malkov, Y. & Yashunin, D. (2018). *Efficient and Robust Approximate Nearest Neighbor Using Hierarchical Navigable Small World Graphs*. IEEE TPAMI. The HNSW algorithm — graph-based approximate nearest neighbor search with logarithmic search complexity.
- DeCandia, G., Hastorun, D., Jampani, M., et al. (2007). *Dynamo: Amazon's Highly Available Key-value Store*. SOSP '07. Quorum reads/writes, read repair, and the sloppy quorum model that Theseon's coordinator follows.
- Johnson, J., Douze, M., & Jegou, H. (2021). *Billion-Scale Similarity Search with GPUs*. IEEE TBD. Discusses the tradeoffs of distributed approximate search — scatter-gather, result merging, and the recall cost of partitioning.
