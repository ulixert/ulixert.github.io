---
title: "Benchmarking Theseon: KV, Cluster, Chaos, and HNSW on SIFT-1M"
description: "Four benchmark harnesses, five charts, and a couple of findings I didn't expect — from single-node KV parity with Pebble to chaos recovery in under a second."
publishDate: "2026-04-19"
updatedDate: "2026-04-19"
tags: ["go", "databases", "theseon", "distributed-systems", "benchmarks", "hnsw", "vector-search", "kv-store", "chaos-testing"]
pinned: true
series: "Building Theseon"
part: 13
order: 13
---

I spent twelve posts writing about Theseon without any numbers. This is the post that
fixes that. What follows is four benchmark harnesses, five charts, and a couple of
findings I didn't expect — including one I was wrong about twice before I understood
what I was looking at.

All code, CSVs, and scripts are in `benchmarks/` in the repo. You can re-run them.

:::important[TL;DR]

- **Single-node**: Theseon matches Pebble on read throughput (~430K ops/sec) when both engines are given identical cache budgets — the earlier "Theseon wins 3.6×" result turned out to be a cache-sizing artifact.
- **Cluster & chaos**: a 3-node cluster sustains ~1.7K ops/sec on read-heavy workloads at N=3/W=2/R=2, and error rate returns to 0% within ~1 second of a killed-and-restarted node.
- **Vector**: HNSW on SIFT-1M hits 95% recall@10 at ~830 QPS, about 100× behind hnswlib — SIMD on the distance kernel is the next bottleneck.

:::

## What's in scope

Four harnesses, picked to cover the parts of Theseon I most wanted to pressure-test:

- **Single-node KV** — Theseon vs. [Pebble](https://github.com/cockroachdb/pebble) on
  three YCSB-style workloads. The point: is my from-scratch LSM actually competitive
  with a production one under equivalent configuration?
- **Cluster KV** — a 3-node in-process cluster under three quorum configurations.
  Does the coordinator do what the quorum knobs say it does?
- **Chaos** — the same cluster, but with node-2 killed and restarted mid-load. Does
  failure recovery actually work?
- **Vector** — HNSW search on SIFT-1M across a sweep of `ef_search`, the ANN world's
  standard benchmark.

Hardware: M1 MacBook Air, 16 GB RAM, macOS 15, Go 1.26. Everything single-trial,
3-rep medians where repetitions apply.

## Methodology notes worth reading

A few design calls that shape the numbers below:

**Warmup and pre-fill.** Every single-node run does two setup phases before the
measured window. First, a batched pre-fill writes all 2M keys (one fsync per 1024-key
batch, for speed). Second, a same-mix 15-second warmup whose results are discarded.
The warmup catches any cold-cache effects so the measured window isn't reading blocks
for the first time. Both engines get identical treatment. The measured window
itself is 60 seconds, repeated three times per (engine, workload) cell, with
medians reported below. Cluster runs use the same 60-second measured window; the
chaos run uses a 180-second window (60s steady, 60s outage, 60s recovery).

**Why Pebble, not RocksDB.** Pebble is pure Go, actively maintained, and used in
CockroachDB production. RocksDB would need CGo and librocksdb — half a day of build
problems before the first run. Pebble also keeps the comparison honest: "my
hand-built LSM vs. a production LSM" reads cleaner than an FFI-mediated comparison.

**Cluster is in-process.** Three `node.New(...)` instances in the same Go process,
communicating over real gRPC on loopback. Real coordinator fan-out, real quorum
logic, real SWIM membership — just no network partition semantics and no thermal
variation across boxes. Good enough to validate coordinator behavior; not a claim
about scale.

**Single trial, laptop, honest framing.** No confidence intervals. Numbers can shift
±10% between runs from background processes alone. Treat orders of magnitude and
curve shapes as the signal.

---

## Single-node: Theseon vs. Pebble (and a debugging story)

I wasn't planning to write a debugging story here. The plan was "measure both, report
numbers." Then my first run showed Theseon beating Pebble on read-only workloads by
**3.6×** — 442K vs. 123K ops/sec on YCSB-C. I didn't believe it.

### The wrong story

If you run both engines with their defaults, this is what you get:

- Pebble's default block cache is ~8 MB.
- Theseon's SSTables are memory-mapped, so the OS page cache holds them for free.
- My benchmark dataset is 2M × 256-byte values = 512 MB.

That means Pebble's 8 MB cache misses most reads and goes to syscall. Theseon's
mmap'd files live in the 16 GB OS page cache. I wasn't comparing two engines; I was
comparing "small block cache" to "large page cache." No surprise Theseon won.

### The right story

I bumped Pebble's `BlockCacheSize` to 1 GB so both engines had the full working set
in cache, and re-ran. Here are the numbers with matched cache budgets:

| Workload | Theseon | Pebble | Delta |
|---|---|---|---|
| YCSB-A (50/50 r/w) | 497 ops/sec | 481 ops/sec | +3% |
| YCSB-B (95/5 r/w)  | 4,670 ops/sec | 4,665 ops/sec | ~0% |
| YCSB-C (100% read) | 430K ops/sec | 414K ops/sec | +4% |

That's parity within measurement noise on all three workloads.

The YCSB-A and YCSB-B throughput is fsync-bound on both engines (each write commits
the WAL to disk). The 500 ops/sec and 4.7K ops/sec numbers are the floor imposed by
the disk's fsync latency, not the engine. YCSB-C, with no writes, is what actually
measures read-path efficiency. 430K vs. 414K ops/sec is ~2 µs per read on both: a
bloom-filter check plus a hot-cached block fetch.

The punchline isn't "Theseon is as fast as Pebble." It's **"two engines with
identical cache budgets on identical data serve reads within 5% of each other,
because the cache is the dominant variable."** That lesson — that benchmarking two
systems with their defaults is benchmarking two default configurations, not two
systems — is what I'll remember from this exercise.

![Single-node throughput & p99: Theseon vs. Pebble](/benchmarks/chart_kv_single_node.png)

---

## Cluster: three nodes, three quorum knobs

The cluster harness spins up three `node.Node` instances in-process, forms a ring
via the admin API, and drives load against the coordinator on node-1. Three quorum
configurations, each run 3× per workload:

| (N, W, R) | YCSB-A | YCSB-B | YCSB-C |
|---|---|---|---|
| (3, 2, 2) | 196 ops/s, p99=91 ms | 1,687 ops/s, p99=18 ms | 22,800 ops/s, p99=0.74 ms |
| (3, 3, 1) | 189 ops/s, p99=96 ms | 1,911 ops/s, p99=32 ms | 24,400 ops/s, p99=0.71 ms |

Three things to notice:

1. **YCSB-A (50/50) caps at ~200 ops/sec.** Every write now fans out to 2 or 3
   replicas with their own fsyncs, so the single-node fsync floor (~500 ops/sec)
   becomes a multi-node fsync-coordination floor. This is quorum doing its job, not
   a performance problem.
2. **p99 latency is sensitive to W.** (3,3,1) — requiring all three acks on writes —
   pushes write p99 from 18 ms to 32 ms on the write-heavier YCSB-B. The tail gets
   worse the stricter you make your write quorum, because any slow replica blocks
   the ack.
3. **Reads are cheap.** YCSB-C at 22K–24K ops/sec through gRPC + coordinator
   fan-out, with p99 well under a millisecond. The ~10× drop from 430K single-node
   is the gRPC round-trip budget.

![Cluster throughput & p99 by quorum configuration](/benchmarks/chart_kv_cluster.png)

### The config that doesn't work: (3, 1, 3)

I ran a third configuration too: N=3, W=1, R=3. "Cheap writes, strict reads." On
YCSB-C it produced a **100% error rate** with near-zero latency — every read failed,
fast.

I thought I understood why. The coordinator's read path had a pre-filter: if fewer
than R replicas passed a liveness check, fail the read immediately. With R=3 on a
3-node cluster, any transient unroutability of a single node drops the pass count to
2 and every read in that window fast-fails. I wrote a small fix — let the collection
loop handle per-RPC failures instead of gating at dispatch — and re-ran.

Same error count, down to a rounding error. **2.48M errors before the fix, 2.48M
after.** Hypothesis falsified.

What I think is actually happening is something in the concurrent RPC fan-out
itself. With R=N=3, `maxFailures` is 1 — any single RPC failure across any of the
three replicas fails the whole read. Whatever is producing those failures (context
propagation, gRPC stream contention, something I haven't traced yet) is happening
regardless of whether I gate on routability up front or rely on per-RPC errors
later. The symptom — fast fail, ~40K errors/sec — points at something local to the
coordinator's dispatch, not a real network failure.

That's where I stopped, for this post. Proper diagnosis needs per-RPC logging at the
failure sites, and a methodical bisect at `concurrency=1` vs. `concurrency=8` to
separate "logical bug" from "load-induced contention." It's a follow-up post.

The point I want to leave here: **a benchmark surfaced a real semantic/operational
bug that unit tests didn't catch.** R=N on small clusters is brittle in ways that
aren't obvious until you actually push load through it.

---

## Chaos: kill a node under load

This is the chart I'm proudest of.

The harness drives steady YCSB-A at the coordinator. At t=60 s it calls
`node2.Stop()`. At t=120 s it brings up a replacement node-2 using the same data
directory and re-joins via admin RPCs.

![Chaos run: node-2 killed and restarted mid-load](/benchmarks/chart_kv_chaos.png)

Pre-kill: ~190 ops/sec steady, 0% errors.

During the outage: throughput drops to ~150 ops/sec; error rate jumps to ~45%. The
drop is because about one-third of keys have node-2 in their preferred replica set,
and reads/writes targeting those keys can't make R=2 or W=2 without it. The ~45%
failure rate (rather than ~33%) reflects the mix of reads and writes hitting the
affected partition at both directions.

At t=120 s, the replacement starts. **Error rate drops to zero within one second**
of the restart. Throughput recovers to baseline within a few seconds.

Two things this chart shows, and two things it does not:

- **Shows**: SWIM detected the new node, the coordinator's routing picked it up, and
  per-key reads and writes that had been failing now resolve against the live
  replica set. That's membership and routability recovery.
- **Shows**: throughput returning to baseline. The coordinator no longer has a
  blackhole in its fan-out.
- **Does not show**: that hinted handoff drained the data node-2 missed. Draining
  is a separate background process whose progress would need to come from
  `theseon_hint_drain_batches_total` in `/metrics`; the chart above measures only
  what the client sees. In my runs the drain counter did advance after restart, but
  that's a second chart I'm not including here.
- **Does not show**: consistency behavior for keys written during the outage. R=2
  reads will still answer from nodes 1 and 3 (which have the data) until the drain
  catches node-2 up; in the meantime node-2 has missing versions. A read steered
  specifically at node-2 would see that; a quorum read masks it.

That split — "membership recovery" vs. "hint drain" vs. "read-your-writes under
partial recovery" — is worth being careful about. The chart proves the first two
quickly. The third needs a separate harness.

---

## Vector search: HNSW on SIFT-1M

SIFT-1M (1M × 128-dim vectors, the standard ANN benchmark from corpus-texmex.irisa.fr)
is the fairest possible yardstick: every published ANN library reports numbers on
it. I built Theseon's HNSW graph once with M=16, EfConstruct=200, then swept
`ef_search` across six values, running 5000 queries per point against the
dataset-provided ground truth.

![SIFT-1M recall vs. QPS (Theseon HNSW)](/benchmarks/chart_vector_recall_qps.png)

| ef_search | recall@10 | QPS | p99 latency |
|---|---|---|---|
| 20 | 79.5% | 2,701 | 0.63 ms |
| 50 | 90.8% | 1,433 | 1.04 ms |
| **100** | **95.4%** | **831** | **1.76 ms** ← balanced |
| **200** | **97.7%** | **479** | **3.06 ms** ← high-recall |
| 500 | 99.0% | 231 | 6.62 ms |
| 1000 | 99.4% | 133 | 11.71 ms |

**Balanced operating point: ef_search = 100.** 95% recall @ 831 QPS with sub-2 ms
tail latency. This is the knee of the curve.

**High-recall operating point: ef_search = 200.** 97.7% recall @ 479 QPS with ~3 ms
tail. The last place where you get meaningful recall gain per unit QPS before
diminishing returns hit hard.

![Latency vs. ef_search](/benchmarks/chart_vector_latency.png)

How does this compare to production ANN libraries? The
[ann-benchmarks.com](http://ann-benchmarks.com) numbers on SIFT-1M put hnswlib at
roughly 100K QPS at 95% recall, and Qdrant in the 5K–15K range. Theseon at 831 QPS
is ~100× behind hnswlib. That's the right order of magnitude for a pure-Go,
single-threaded, no-SIMD implementation against a vectorized C++ library.
Specifically, the single biggest optimization not yet in Theseon is SIMD for the
distance function — ARM NEON or AVX2 for the inner L2-squared loop would likely
close a 4–8× slice of that gap. The rest is thread-level parallelism for queries.

I'm not claiming Theseon competes with hnswlib. I'm claiming the curve shape is
right, the recall numbers are believable, and the gap to production is a known and
scoped follow-up.

---

## What's still slow and why

Two things I'd attack first if I kept working on this:

**Vector distance without SIMD.** Every hop in the HNSW graph computes an
L2-squared distance between 128-dimensional float32 vectors. In pure Go that's a
tight loop of `diff * diff` accumulations. On ARM NEON you can fuse four lanes and a
multiply-add into a single instruction. Back-of-envelope: 4× speedup on the distance
kernel, which is ~60% of search time, gives you ~2.5× overall QPS at the same
recall. That's the single highest-leverage change.

**Coordinator dispatch under load at R=N.** The (3,1,3) story above. The bug
probably lives in the interaction between concurrent goroutines, context
propagation, and the collection loop. It's not visible at low concurrency or with
R<N, which is why the integration tests don't catch it. A future post will be the
traced, diagnosed version.

A few other items on the list but at lower priority: Merkle-tree anti-entropy does
exist but I haven't benchmarked its convergence time under realistic divergence;
snapshot restart for HNSW is there but I haven't measured its recovery latency on a
1M-vector graph; block cache in Theseon is eager and doesn't evict.

---

## What I'd do differently

If I were starting this benchmark exercise again:

- **Warmup protocol from the start.** The cold-cache vs. hot-cache confusion cost
  me one wrong conclusion and one re-sweep. Always have a warmup window.
- **Matched engine configurations from day one.** Defaults-vs-defaults is a trap.
  Either pick defaults and be explicit that's what you measured, or pick configs
  that match some benchmark-relevant property (working-set-in-cache, here).
- **Record what I expected before running.** I didn't write down my prior, which
  made it harder to notice when a result was suspicious. "Theseon 3.6× over Pebble"
  should have tripped the alarm earlier than it did.

---

### In this series

The earlier posts in this series cover the design decisions that these numbers are
measuring: the LSM, HLC timestamps, leaderless replication, HNSW construction,
failure models, and so on. All benchmark harnesses, CSV outputs, and
chart-generation scripts are in `benchmarks/` in the [GitHub
repo](https://github.com/ulixert/theseon). The `/metrics` endpoint exposes
everything the benchmarks measured and more (SSTable count, hint drain progress,
per-RPC histograms) in Prometheus format.

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
13. **Benchmarking Theseon: KV, Cluster, Chaos, and HNSW on SIFT-1M**

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- [Pebble](https://github.com/cockroachdb/pebble) - A performance-oriented LSM key-value store inspired by LevelDB and RocksDB.
- [YCSB](https://github.com/brianfrankcooper/YCSB) - Yahoo! Cloud Serving Benchmark, used for the single-node and cluster KV tests.
- [SIFT-1M](http://corpus-texmex.irisa.fr/) - The 1M 128-dim vector dataset used for HNSW benchmarking.
