---
title: "Building HNSW from Scratch: Graph Construction, Beam Search, and What Recall Actually Measures"
description: "Implementing the HNSW approximate nearest neighbor algorithm from the original paper in Go — the insert and search algorithms, neighbor selection heuristics, tombstone-aware traversal, and building an evaluation framework to prove it works."
publishDate: "2026-04-05"
updatedDate: "2026-04-05"
tags: [ "go", "databases", "theseon", "vector-search", "hnsw", "approximate-nearest-neighbors" ]
order: 10
---

The previous posts built Theseon's storage engine and distributed layer — from the LSM write path through SWIM gossip,
quorum coordination, hinted handoff, and anti-entropy. This post starts the vector layer. The goal: add approximate
nearest neighbor search to a distributed KV store, with the index built from scratch.

The core algorithm is HNSW (Hierarchical Navigable Small World), introduced by Malkov and Yashunin in 2018. It's the
same algorithm behind Qdrant, Weaviate, and parts of Milvus. The idea is a multi-layer graph where each layer is a
progressively coarser view of the dataset, allowing search to "zoom in" from a rough global position to precise local
neighbors.

This post covers the graph construction, search algorithm, the neighbor selection heuristic that makes or breaks recall,
tombstone handling, and the evaluation framework that validates all of it.

## Why a Graph Index?

Nearest neighbor search in high dimensions is hard. Brute force — computing the distance from a query to every vector —
is O(N) per query. At a million vectors and 768 dimensions, that's ~3 billion float operations per search. Unacceptable
for interactive latency.

Tree-based indexes (KD-trees, ball trees) work well in low dimensions but degrade to linear scan above ~20 dimensions.
The curse of dimensionality: in high-dimensional space, all points are roughly equidistant, so tree partitions don't
prune the search space.

Graph-based indexes sidestep this entirely. Instead of partitioning space, they build a network of connections between
vectors. Search is a walk through the graph, hopping from neighbor to neighbor, getting closer to the query at each
step. The graph structure captures the local geometry of the dataset — nearby vectors are connected, and the search
exploits that connectivity.

HNSW adds a hierarchy to this: multiple layers of decreasing density. The top layer has very few nodes (a coarse map),
the bottom layer has all of them (the full dataset). Search starts at the top and descends, narrowing the search region
at each layer.

```
Layer 3:   [A] ────────────────────── [B]         (2 nodes)

Layer 2:   [A] ──── [C] ──── [D] ──── [B]         (4 nodes)

Layer 1:   [A]─[E]─[C]─[F]─[D]─[G]─[B]─[H]        (8 nodes)

Layer 0:   all nodes, densely connected           (N nodes)
```

## The Graph Structure

Each node in the graph has a vector, a level (which layers it appears in), and a neighbor list per layer:

```go
type Node struct {
ID        uint64
Vector    []float32
Level     int
Neighbors [][]uint64 // neighbors[layer] = neighbor IDs
}
```

The graph maintains a single entry point — the node with the highest level — and tracks the current maximum level. Two
capacity constants control neighbor connectivity:

- `maxM = M` for upper layers (>= 1)
- `maxM0 = 2 * M` for layer 0

Layer 0 gets double the connections because it contains every node and is where the final precise search happens. More
connections at layer 0 mean better recall.

A node's level is assigned randomly at insert time using a geometric distribution: `floor(-ln(rand()) / ln(M))`. With
M=16, about 94% of nodes land at level 0, ~6% at level 1, ~0.4% at level 2. This creates the pyramid shape — each layer
is roughly M times sparser than the one below.

## Insert: Building the Graph

Inserting a new vector is a two-phase process (Algorithm 1 from the paper):

**Phase 1 — Greedy descent.** Starting from the entry point at the top layer, walk greedily toward the new vector. At
each layer above the new node's assigned level, move to whichever neighbor is closest to the new vector. This is fast —
one greedy walk per layer, no beam search.

**Phase 2 — Search and connect.** From the new node's level down to layer 0, run a proper beam search to find the
efConstruction nearest candidates. Select the best neighbors from those candidates, then add bidirectional edges between
the new node and each selected neighbor.

```
Insert vector Q at level 1:

Phase 1 (greedy descent from layer 3 to 2):
  Layer 3: start at entry → greedy walk → closest node
  Layer 2: continue from closest → greedy walk → closest node

Phase 2 (search + connect from layer 1 to 0):
  Layer 1: beam search (ef=200) → select M neighbors → connect
  Layer 0: beam search (ef=200) → select 2*M neighbors → connect
```

When adding a reverse edge would overflow a neighbor's capacity, the neighbor's list is pruned by keeping the closest
nodes to that neighbor — not to the query. This ensures every node maintains high-quality local connections.

## Neighbor Selection: Simple vs. Heuristic

The paper describes two strategies for selecting which candidates become neighbors. This choice matters more than any
other implementation detail for recall quality.

**Simple selection** sorts candidates by distance to the query and takes the closest M. This is intuitive but has a
flaw: if the candidates cluster in one direction from the query, all M neighbors point the same way. The graph becomes
poorly connected — there's no "bridge" to reach vectors in other directions.

**Heuristic selection** (Algorithm 4) picks diverse neighbors. A candidate is only selected if it's closer to the query
than to any already-selected neighbor. If a candidate is in the "shadow" of an existing neighbor — meaning it's
redundant — it's skipped in favor of a candidate in a different direction.

```
Query Q, candidates ranked by distance: [A, B, C, D, E]

Simple: select [A, B, C] (3 closest)

Heuristic:
  A selected (first candidate, always selected)
  B: dist(B, A) < dist(B, Q)? No → B selected
  C: dist(C, A) < dist(C, Q)? Yes → C skipped (redundant with A)
  D: dist(D, A) < dist(D, Q)? No, dist(D, B) < dist(D, Q)? No → D selected
  Result: [A, B, D] (diverse directions)
```

After the heuristic pass, if fewer than M neighbors were selected, discarded candidates fill the remaining slots by
distance order. This is `keepPrunedConnections` in the paper — it ensures the node gets its full neighbor quota even
when the heuristic is highly selective.

The impact on recall is significant. On 10K random 128-dim vectors with M=16 and efSearch=200, simple selection produced
recall @10 between 0.88 and 0.91. Adding the heuristic brought it to 0.95+. The heuristic costs more distance
computations during insert, but graph quality determines search quality, and the insert is a one-time cost.

**Where the heuristic applies matters too.** I tested using the heuristic both for initial neighbor selection during
insert and for overflow pruning when a neighbor's list exceeds capacity. The result: heuristic-in-insert gives most of
the recall benefit. Adding it to overflow pruning improved recall by another 1-2% but made index construction 2.5x
slower. Production HNSW implementations (hnswlib) use the heuristic only for initial selection and simple closest-N for
overflow. The eval framework made this tradeoff visible.

## Search: Beam Search with Tombstones

Search (Algorithm 5) mirrors insert's two phases:

**Phase 1 — Greedy descent** from the top layer down to layer 1, finding a good starting position.

**Phase 2 — Beam search on layer 0** with configurable ef (beam width). The beam search maintains two heaps: a min-heap
of candidates to explore and a max-heap of the ef best results seen so far. For each candidate, examine all its
neighbors. If a neighbor is closer than the worst current result (or results aren't full yet), add it to both heaps.

```go
for candidates.Len() > 0 {
    c := heap.Pop(candidates) // closest unexplored

    if results.Len() >= ef && c.dist > results.peek().dist {
         break // remaining candidates only farther
    }

    for _, neighbor := range node.Neighbors[layer] {
         if visited[neighbor] { continue }
         visited[neighbor] = true

         d := dist(query, neighbor.Vector)
         if results.Len() < ef || d < results.peek().dist {
             heap.Push(candidates, neighbor)
             heap.Push(results, neighbor)
             if results.Len() > ef {
                 heap.Pop(results) // evict farthest
             }
         }
    }
}
```

**Tombstone handling** is the subtlety. When a vector is deleted, it's marked as a tombstone rather than removed from
the graph. During search, tombstoned nodes are added to the candidate heap (their neighbors are explored) but never
added to the result heap. This preserves graph navigability — a tombstoned node can be a bridge to reach live nodes
beyond it.

```
Query → [Live] → [Tombstoned] → [Live] → [Target]
                       ↑
            Explored but not returned.
            Without this, Target is unreachable.
```

Cleanup physically removes tombstoned nodes later, scrubbing them from all neighbor lists. No neighbor repair is done in
the current implementation — the eval framework measures recall degradation after cleanup, and for tombstone ratios
under 10%, degradation is under 1%.

## The Evaluation Framework

Building the index is half the work. Proving it works correctly is the other half. The eval framework has four
components:

**Brute-force ground truth.** For every test query, compute exact distances to all N vectors using a max-heap of size k.
O(N log k) per query. This is the reference answer.

**Recall @k.** The fraction of true top-k neighbors that appear in the approximate result. If brute force returns {1, 2,
3, 4, 5} and HNSW returns {1, 2, 3, 7, 8}, recall @5 = 3/5 = 0.6.

Recall is the right metric because HNSW is approximate — it's allowed to miss some neighbors. The question is how many
it misses at what search cost. A recall of 0.95 means 5% of results are slightly wrong, which is acceptable for most
retrieval applications.

**Benchmark harness.** Builds the graph, runs `runtime.GC()` (to avoid GC pauses polluting latency), computes ground
truth, times each search individually, and reports P50/P95/P99 latency, QPS, indexing throughput, and memory usage.

**Parameter sweep.** Iterates over combinations of M, efConstruction, and efSearch. For each (M, efConstruct) pair, the
index is built once, then queried with each efSearch value. The output is a table:

```
M     efC    efS    Recall @10   P50       P95       QPS       Memory
16    200    50     0.8920      0.08ms    0.21ms    12340     48.2MB
16    200    100    0.9510      0.14ms    0.38ms    7120      48.2MB
16    200    250    0.9680      0.23ms    0.52ms    4350      48.2MB
```

This table is the single most useful output of the entire phase. It shows the fundamental tradeoff: recall costs
latency. Every efSearch increase buys more recall at the cost of more graph traversal. The right operating point depends
on the application — low-latency search tolerates lower recall, high-precision retrieval tolerates higher latency.

## The Bugs

### Entry points carried wrong between layers

During insert, after running beam search at a given layer, the selected neighbors become entry points for the next lower
layer. My initial implementation carried forward only the M selected neighbors. The HNSW paper carries forward the
entire search result set (up to efConstruction candidates).

The difference: M neighbors provide M starting positions for the next layer's search. efConstruction candidates provide
up to 200 starting positions. With M entry points, the lower-layer search starts from a narrow region. With
efConstruction entry points, it starts from a broad one.

Impact: recall @10 at efSearch=200 went from 0.85 to 0.88 after the fix. Not huge, but measurable. The eval framework
caught it immediately — without automated recall testing, this would have been invisible.

### Level distribution surprise

My first recall test expected ~64% of nodes at level 0, based on an incorrect mental model. The actual distribution for
M=16: P(level 0) = 1 - 1/M = 93.75%. The formula `floor(-ln(u) / ln(M))` produces a geometric distribution where the
probability of level >= 1 is exactly 1/M.

For 10K nodes with M=16: ~9,375 at level 0, ~586 at level 1, ~37 at level 2, ~2 at level 3. This is correct — the upper
layers are supposed to be very sparse. The "pyramid" is much steeper than intuition suggests.

### Heuristic overflow tradeoff

As described in the neighbor selection section, I tested using the diversity heuristic for overflow pruning (when a
neighbor's list exceeds capacity during insert). Recall improved by 1-2% but build time increased 2.5x. The heuristic
calls `selectNeighborsHeuristic` for every overflow, which does O(selected * candidates) distance computations.

The eval framework made this a data-driven decision rather than a gut call: 260s vs 100s build time for 0.96 vs 0.95
recall. Not worth it. The heuristic is used only for initial neighbor selection.

## What I Learned

The HNSW paper is well-written and the algorithm is elegant, but the paper leaves several implementation choices open.
Neighbor selection (simple vs heuristic) has the largest impact on recall. Entry point propagation between layers is
easy to get subtly wrong. The geometric level distribution is steeper than expected.

The evaluation framework was the most important thing I built in this phase — more important than the graph itself.
Without automated recall measurement, every bug listed above would have been invisible. The graph would have "worked" (
returned results) without being correct (returning the right results). This is the fundamental challenge of approximate
algorithms: wrong answers look like right answers unless you have ground truth to compare against.

The design choice to store HNSW as a secondary index over the KV store — rather than an independent data structure —
pays off in the next phase. Vectors become regular KV entries flowing through WAL, memtable, and SSTables. Hinted
handoff and anti-entropy replicate them for free. The graph is always reconstructible from KV data.

## What's Next

The HNSW graph is standalone — it lives in memory with no connection to the storage engine. The next step is KV
integration: storing vectors as durable entries, wiring HNSW insert/delete into the write path, adding snapshot
persistence so the graph survives restarts, and connecting it to the distributed coordinator for fan-out search across
replicas.

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- Malkov, Y. A. & Yashunin, D. A. (2018). *Efficient and Robust Approximate Nearest Neighbor Using Hierarchical
  Navigable Small World Graphs*. IEEE TPAMI. The original HNSW paper.
- Malkov, Y., Ponomarenko, A., Logvinov, A., & Krylov, V. (2014). *Approximate Nearest Neighbor Algorithm Based on
  Navigable Small World Graphs*. Information Systems. The earlier NSW paper that HNSW builds on.
- [hnswlib](https://github.com/nmslib/hnswlib) — The reference C++ implementation by the paper authors. Informed the
  decision to use the heuristic only for initial selection, not overflow pruning.
- [ANN Benchmarks](https://ann-benchmarks.com/) — Standard benchmark suite for approximate nearest neighbor algorithms.
  Context for understanding where HNSW sits in the performance landscape.
