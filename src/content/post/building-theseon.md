---
title: "Building Theseon: Architecture of a Distributed LSM and Vector Engine in Go"
description: "Architecture and design decisions behind a hand-built distributed LSM engine with HNSW vector search: from skip lists and SSTables to SWIM gossip, quorum coordination, and approximate nearest neighbors."
publishDate: "2026-01-08"
updatedDate: "2026-04-02"
tags: [ "go", "databases", "lsm-tree", "theseon", "distributed-systems", "vector-search" ]
pinned: true
order: 1
---

[**Theseon**](https://github.com/ulixert/theseon) is a distributed LSM-tree storage engine with vector search, built from scratch in Go.

The storage and distributed layers are the foundation: skip list memtable, write-ahead log, SSTable format with bloom filters and checksums, leveled compaction, snapshot isolation, optimistic transactions, consistent hashing, hybrid logical clocks, SWIM gossip, quorum coordination, hinted handoff, and anti-entropy. The vector layer extends it into a hybrid search engine: HNSW graphs for approximate nearest neighbors, product quantization for compression, BM25 for lexical matching, and exact re-ranking on raw vectors.

"Theseon" comes from the Greek *Theseion* — the Temple of Hephaestus in Athens, one of the best-preserved ancient structures. It also evokes Theseus navigating the labyrinth, which is roughly what HNSW does: traversing layers of connections to find nearby vectors.

This post covers the architecture and the design decisions that shaped it. The rest of the series digs into implementation details.

## Why an LSM Tree?

Most storage engines are built around one of two ideas: **B-trees** or **LSM trees**. PostgreSQL and SQLite are B-tree
systems. LevelDB, RocksDB, Cassandra, and most modern write-heavy systems use LSM trees.

The core idea, introduced by O'Neil et al. (1996), is simple: instead of updating records in place on disk, buffer
writes in memory and periodically flush them as large, sorted, immutable files. Reads merge results from memory and
disk.

That tradeoff matters because in-place updates produce small random writes, while LSM trees turn many small writes into
larger sequential ones. In return, reads become more expensive — the same key may exist in memory and in multiple files
on disk. Keeping reads efficient requires bloom filters, block indexes, caching, and background compaction.

At a high level:

- Writes land in an in-memory **memtable** (a skip list)
- Every write is also appended to a **write-ahead log** for crash recovery
- Full memtables are flushed to disk as immutable **SSTables**
- Background **compaction** merges SSTables into fewer, larger, better-organized levels

```
               Put("key", "val")
                        │
                        ▼
  ┌──────────┐     ┌──────────┐
  │   WAL    │◄────│  Engine  │
  │ (append) │     └────┬─────┘
  └──────────┘          │
                        ▼
                 ┌─────────────┐
                 │  Memtable   │  (skip list, in memory)
                 │  (mutable)  │
                 └──────┬──────┘
                        │ freeze when full
                        ▼
                 ┌─────────────┐
                 │  Memtable   │  (immutable, waiting to flush)
                 └──────┬──────┘
                        │ flush to disk
                        ▼
           ┌────────────────────────┐
     L0    │ [SST] [SST] [SST]      │  (overlapping)
           └────────────┬───────────┘
                        │ compaction
                        ▼
     L1    [  SST  ][  SST  ][  SST  ]   (sorted, non-overlapping)
     L2    [    SST    ][    SST     ]
           ...
```

## Architecture

Theseon has four layers, each building on the one below.

### Single-node storage engine

The foundation is a complete LSM engine: memtable with skip list, WAL with CRC32 framing and batch writes, SSTable
format with ~4KB data blocks, bloom filters (10 bits per key, ~1% false positive rate), a block index for binary search,
and a 33-byte footer with magic number validation. Flushing, leveled compaction, a manifest for crash recovery,
mmap-based SSTable reads, and a sharded block cache are all in place.

### MVCC and transactions

Every key version carries a sequence number encoded directly in the internal key format. Readers operate on consistent
snapshots without blocking writers. Optimistic transactions buffer writes locally, then check for conflicts at commit
time — if another writer modified the same key after the transaction started, the commit fails and the caller retries.

### Distributed layer

Multiple Theseon nodes form a leaderless cluster. Any node can handle any request — it acts as the coordinator for that
request, fanning out to the appropriate replicas.

```
                    ┌─────────────────────────┐
   Client ────────► │  Coordinator (any node) │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌──────────┐      ┌──────────┐        ┌──────────┐
        │  Node A  │◄────►│  Node B  │◄──────►│  Node C  │
        │          │ SWIM │          │  SWIM  │          │
        │ Theseon  │gossip│ Theseon  │ gossip │ Theseon  │
        │  Engine  │      │  Engine  │        │  Engine  │
        └──────────┘      └──────────┘        └──────────┘
              │                  │                   │
         Hash Ring          Hash Ring           Hash Ring
         HLC Clock          HLC Clock           HLC Clock
```

Key components of the distributed layer:

- **Consistent hash ring** with virtual nodes (150 per physical node) maps keys to replica sets. When a node joins or
  leaves, only ~1/N of keys move.
- **Hybrid logical clocks** (Kulkarni et al., 2014) provide deterministic cross-node timestamp ordering for
  last-writer-wins conflict resolution. HLC combines physical wall time with a logical counter — causally related events
  are correctly ordered, concurrent events get a deterministic total order via NodeID tie-breaking.
- **SWIM gossip** (Das et al., 2002) detects node failures without a single point of failure. Randomized probing (direct
  ping → indirect ping via K peers → suspect → dead) converges in O(log N) rounds. State changes are piggybacked on
  probe messages — no dedicated gossip channel needed.
- **Quorum coordination** with tunable consistency: writes require W acks, reads require R responses. When R + W > N,
  reads observe the most recent quorum-acknowledged write. Async read repair fixes stale replicas after returning to the
  client.
- **Hinted handoff** buffers writes for temporarily unreachable nodes and replays them on recovery.
- **Anti-entropy** with Merkle trees periodically compares replica digests and repairs any remaining drift that read
  repair and hinted handoff missed.

### Vector layer

The top layer adds vector search on top of the distributed KV store. Vectors are stored as regular KV entries (prefix `0x02`), which means hinted handoff and anti-entropy replicate vector data for free — no special vector replication protocol.

```text
                    Query: "fast storage" + [0.12, -0.45, ...]
                                          │
                                          ▼
                                ┌───────────────────┐
                                │ Coordinator Node  │
                                └─────────┬─────────┘
                                          │ (Scatter)
                 ┌────────────────────────┼────────────────────────┐
                 ▼                        ▼                        ▼
           ┌──────────┐             ┌──────────┐             ┌──────────┐
           │ Replica A│             │ Replica B│             │ Replica C│
           ├──────────┤             ├──────────┤             ├──────────┤
           │ BM25 Idx │             │ BM25 Idx │             │ BM25 Idx │
           │ HNSW + PQ│             │ HNSW + PQ│             │ HNSW + PQ│
           └─────┬────┘             └─────┬────┘             └─────┬────┘
                 │                        │                        │
                 │ (Gather Top-K)         │                        │
                 └──────────┐             │             ┌──────────┘
                            ▼             ▼             ▼
                           ┌─────────────────────────────┐
                           │ 1. Reciprocal Rank Fusion   │
                           │ 2. Deduplication            │
                           │ 3. Exact SIMD Re-ranking    │
                           └──────────────┬──────────────┘
                                          ▼
                                    Final Top-K
```

Key components:

- **HNSW graph** (Malkov & Yashunin, 2018) — a hierarchical navigable small world index for approximate nearest neighbor
  search, implemented directly in Go with beam search, SELECT-NEIGHBORS-HEURISTIC for diverse graph connectivity,
  tombstone-aware traversal, and snapshot persistence.
- **Product quantization** compresses 768-dim vectors from 3KB to 96 bytes (~32x), enabling 10M+ vectors in memory.
  K-means codebook training and asymmetric distance computation (ADC) are implemented without external ML libraries.
- **BM25 inverted index** stored in the KV layer with RRF (Reciprocal Rank Fusion) score fusion for hybrid vector + text
  retrieval.
- **Distributed vector search** fans out to R replicas, each running local HNSW search, then the coordinator
  deduplicates and exact-reranks with raw vectors.

Each HNSW replica maintains its own graph independently, rebuilt from local KV data. The graph is a secondary index —
the KV store is always the source of truth.

### Liveness vs. ring ownership

This is the most important architectural decision in the distributed layer: **SWIM liveness and ring ownership are
completely independent**.

SWIM answers "can I reach this node right now?" The hash ring answers "who owns this data?" When SWIM marks a node as
dead, the ring is *not* modified — the dead node still owns its virtual nodes. The coordinator routes around it using
hinted handoff. When the node recovers, it resumes owning its keys with zero ring churn.

Ring changes only happen via explicit admin commands (`join`, `activate`, `remove`). This prevents cascading topology
changes during network partitions, which is the failure mode that kills most distributed systems.

## Design Decisions

### Internal key encoding: inverted sequence numbers

Each key version is stored as `user_key | inverted_seq` where `inverted_seq = MaxUint64 - seq`, encoded as 8 bytes
big-endian. This means:

- **Newest versions sort first.** A higher sequence number produces a smaller inverted value, so `bytes.Compare`
  naturally returns the newest version of a key before older versions.
- **No custom comparator.** The merge iterator, SSTable index, and block binary search all use standard `bytes.Compare`.
  No special MVCC-aware comparison logic needed anywhere in the read path.
- **User key grouping for free.** All versions of the same user key are physically adjacent, which is exactly what
  MVCC-aware compaction needs to decide which versions to keep.

### Leveled compaction with MVCC-aware garbage collection

Theseon uses leveled compaction with a 10x size ratio between levels. L0 triggers compaction at 4 files. Each level
beyond L0 has sorted, non-overlapping key ranges.

The compaction GC policy is snapshot-aware: the newest version of every key is always kept. Older versions are kept if
any active snapshot might read them (sequence number at or above the oldest active snapshot's watermark). Versions below
the watermark are dropped. Tombstones are only removed at the bottommost level when no data exists below them —
otherwise the tombstone could be dropped while an older value still lives in a deeper level, causing the deleted key to
reappear.

### mmap for SSTable reads

SSTables are memory-mapped with `syscall.Mmap(PROT_READ, MAP_PRIVATE)` instead of being read into the Go heap. The OS
manages the page cache — only actively-read pages consume physical memory, and cold pages are evicted under pressure.
The bloom filter (~1KB per SSTable) is copied to the heap on open because it's accessed on every point lookup.

### Leaderless replication: why not Raft

Raft provides strong consistency (linearizability) but requires a leader for every write. Leader election adds latency
during failures, and the leader is a throughput bottleneck. For a key-value store where last-writer-wins is an
acceptable conflict resolution policy, leaderless replication (Dynamo-style) is a better fit: any node can accept
writes, availability during partitions is higher, and the implementation complexity shifts from consensus to
convergence.

The tradeoff is weaker consistency — Theseon provides eventual consistency with tunable quorum, not linearizability. For
the use cases this project targets, that's the right tradeoff.

### HLC for conflict resolution: why not vector clocks

Vector clocks detect conflicts (concurrent writes) but don't resolve them — the application must. HLC timestamps provide
a deterministic total order: the write with the highest HLC wins. This is simpler for clients (no conflict resolution
callbacks) and simpler for the storage engine (no need to store multiple concurrent versions per key).

The cost is that HLC's ordering is only causally consistent for events connected by message passing. Two independent
writes on different nodes get a deterministic order, but that order may not reflect real-time causality. For a key-value
store with last-writer-wins semantics, this is acceptable.

## How a Read Works

Here's what happens when Theseon handles `Get("user:1234")`:

```
Get("user:1234")
  │
  ├─► Active Memtable ──── found? ──► return
  │
  ├─► Immutable Memtables ── found? ──► return (newest first)
  │
  ├─► L0 SSTables (newest first)
  │     ├─ Bloom filter: "not here" ──► skip (99% of files)
  │     ├─ Bloom filter: "maybe"
  │     │    ├─ Binary search index ──► find block
  │     │    └─ Binary search block ──► found? return
  │     └─ ...
  │
  ├─► L1, L2, ... (one SSTable per level)
  │
  └─► Not found
```

The engine checks memory first (active memtable, then immutables), then disk. Each SSTable has a bloom filter that
rejects ~99% of irrelevant files with zero I/O. For the SSTables that pass, binary search finds the right block, which
is read from the mmap'd region (or the block cache if recently accessed).

In a well-compacted database, a point lookup touches one or two disk blocks at most.

## What "From Scratch" Means

Not "no dependencies at all." I use Go's standard library, gRPC for networking, and protobuf for serialization. What it means is that every storage, distributed, and vector primitive is mine: memtable, WAL, SSTable format, bloom filter, compaction, manifest, MVCC, snapshot isolation, transactions, consistent hashing, HLC, SWIM gossip, quorum coordination, read repair, hinted handoff, Merkle-tree anti-entropy, HNSW graph, product quantization, and BM25 scoring.

Theseon is not a SQL database, not a Raft-based replicated store, and not an attempt to replace RocksDB. The goal is to build a serious distributed storage engine with vector search and understand where the real complexity lies — by implementing it.

## The Rest of the Series

Each post covers a layer of the system, building from the bottom up:

1. **This post** — Architecture and design decisions across all three layers
2. [**The Storage Foundation**](/posts/theseon-storage-foundation/) — Memtable, WAL, SSTable format, bloom filters, and
   the iterator contract
3. [**Wiring It All Together**](/posts/theseon-wiring-it-together/) — Internal key encoding, the merge iterator, write
   path, flush, and crash recovery
4. [**Making the Engine Self-Maintaining**](/posts/theseon-self-maintaining/) — Manifest, leveled compaction, block
   cache, mmap, write batches, and backpressure
5. [**Snapshots, Transactions, and the Art of Not Blocking Writers**](/posts/theseon-mvcc-transactions/) — MVCC,
   snapshot isolation, optimistic transactions, and version-aware compaction GC
6. [**Who's Alive? Building SWIM Failure Detection from Scratch**](/posts/theseon-swim-protocol/) — SWIM probe cycle,
   incarnation-based CRDT merge, gossip dissemination, and decoupling liveness from ring ownership
7. [**Quorum Reads, Quorum Writes, and the Repair That Follows**](/posts/theseon-quorum-coordinator/) — Coordinator
   fan-out, quorum latency, two-phase read repair, and the bugs in testing impossible states
8. **Product Quantization** *(coming soon)*
9. **Hybrid Retrieval and Reranking** *(coming soon)*
10. [**Building HNSW from Scratch**](/posts/theseon-hnsw-scratch/) — Graph construction, beam search, neighbor selection
    heuristics, and recall evaluation
11. [**Making Vectors Durable**](/posts/theseon-vector-kv-integration/) — KV integration, snapshot persistence, and the
    bugs in concurrent updates and graph connectivity

## References

- O'Neil, P., Cheng, E., Gawlick, D., & O'Neil, E. (
  1996). [The Log-Structured Merge-Tree (LSM-Tree)](https://www.cs.umb.edu/~poneil/lsmtree.pdf). Acta Informatica, 33(
  4), 351-385.
- DeCandia, G., Hastorun, D., et al. (
  2007). [Dynamo: Amazon's Highly Available Key-Value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf).
  SOSP '07.
- Das, A., Gupta, I., & Motivala, A. (
  2002). [SWIM: Scalable Weakly-consistent Infection-style Process Group Membership Protocol](https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf).
  DSN '02.
- Kulkarni, S., Demirbas, M., et al. (
  2014). [Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases](https://cse.buffalo.edu/tech-reports/2014-04.pdf).
  OPODIS '14.
- Malkov, Y. A. & Yashunin, D. A. (
  2018). [Efficient and Robust Approximate Nearest Neighbor Using Hierarchical Navigable Small World Graphs](https://arxiv.org/abs/1603.09320).
  IEEE TPAMI.
- Jégou, H., Douze, M., & Schmid, C. (
  2011). [Product Quantization for Nearest Neighbor Search](https://doi.org/10.1109/TPAMI.2010.57). IEEE TPAMI.
- Cormack, G. V., Clarke, C. L., & Buettcher, S. (
  2009). [Reciprocal Rank Fusion outperforms Condorcet and Individual Rank Learning Methods](https://doi.org/10.1145/1571941.1572114).
  SIGIR.
- Lakshman, A. & Malik, P. (
  2010). [Cassandra: A Decentralized Structured Storage System](https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf).
  LADIS '09.
- Kleppmann, M. (2017). *Designing Data-Intensive Applications*. O'Reilly. Chapters 3 (Storage), 5 (Replication), and
  7 (Transactions).
- Petrov, A. (2019). *Database Internals*. O'Reilly. Part I (Storage Engines) and Part II (Distributed Systems).
- [LevelDB](https://github.com/google/leveldb) — The original LSM implementation by Ghemawat and Dean. Theseon's SSTable
  format and compaction strategy are directly influenced by LevelDB's design.
- [Pebble](https://github.com/cockroachdb/pebble) — CockroachDB's Go LSM engine. Reference for Go-specific patterns:
  iterator lifecycle, block cache sharding, and compaction picker/executor separation.
- [Badger](https://github.com/dgraph-io/badger) — Dgraph's Go key-value store. Reference for MVCC design and transaction
  API.

---

*This project was originally called LithicDB. The rename to Theseon happened when the vector layer changed the project's scope beyond a pure storage engine.*
