---
title: "Building LithicDB: A Distributed LSM Storage Engine from Scratch in Go"
description: "Architecture, design decisions, and tradeoffs behind a hand-built distributed key-value store: from skip lists and SSTables to SWIM gossip and quorum coordination."
publishDate: "2026-01-08"
updatedDate: "2026-03-31"
tags: ["go", "databases", "lsm-tree", "lithicdb", "distributed-systems"]
pinned: true
---

[**LithicDB**](https://github.com/ulixert/lithicdb) is a distributed LSM-tree key-value storage engine built from scratch in Go.

Every core component is hand-written: skip list memtable, write-ahead log, SSTable format with bloom filters and checksums, leveled compaction, snapshot isolation, optimistic transactions. The distributed layer is equally from scratch: consistent hashing with virtual nodes, hybrid logical clocks, SWIM gossip protocol, quorum coordination with read repair, hinted handoff, and merkle-tree anti-entropy. Only gRPC and protobuf use external libraries.

"Lithic" comes from the Greek *lithos*, meaning stone. Writes arrive in layers, then compact over time into deeper, denser structures on disk — like sediment becoming rock.

This post covers the architecture, the design decisions that shaped it, and what the distributed layer looks like. The rest of the series digs into implementation details.

## Why an LSM Tree?

Most storage engines are built around one of two ideas: **B-trees** or **LSM trees**. PostgreSQL and SQLite are B-tree systems. LevelDB, RocksDB, Cassandra, and most modern write-heavy systems use LSM trees.

The core idea, introduced by O'Neil et al. (1996), is simple: instead of updating records in place on disk, buffer writes in memory and periodically flush them as large, sorted, immutable files. Reads merge results from memory and disk.

That tradeoff matters because in-place updates produce small random writes, while LSM trees turn many small writes into larger sequential ones. In return, reads become more expensive — the same key may exist in memory and in multiple files on disk. Keeping reads efficient requires bloom filters, block indexes, caching, and background compaction.

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

LithicDB has three layers, each building on the one below.

### Single-node storage engine

The foundation is a complete LSM engine: memtable with skip list, WAL with CRC32 framing and batch writes, SSTable format with ~4KB data blocks, bloom filters (10 bits per key, ~1% false positive rate), a block index for binary search, and a 33-byte footer with magic number validation. Flushing, leveled compaction, a manifest for crash recovery, mmap-based SSTable reads, and a sharded block cache are all in place.

### MVCC and transactions

Every key version carries a sequence number encoded directly in the internal key format. Readers operate on consistent snapshots without blocking writers. Optimistic transactions buffer writes locally, then check for conflicts at commit time — if another writer modified the same key after the transaction started, the commit fails and the caller retries.

### Distributed layer

Multiple LithicDB nodes form a leaderless cluster. Any node can handle any request — it acts as the coordinator for that request, fanning out to the appropriate replicas.

```
                    ┌─────────────────────────┐
   Client ────────► │  Coordinator (any node)  │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
        ┌──────────┐      ┌──────────┐        ┌──────────┐
        │  Node A  │◄────►│  Node B  │◄──────►│  Node C  │
        │          │ SWIM │          │  SWIM  │          │
        │ LithicDB │gossip│ LithicDB │ gossip │ LithicDB │
        │  Engine  │      │  Engine  │        │  Engine  │
        └──────────┘      └──────────┘        └──────────┘
              │                  │                   │
         Hash Ring          Hash Ring           Hash Ring
         HLC Clock          HLC Clock           HLC Clock
```

Key components of the distributed layer:

- **Consistent hash ring** with virtual nodes (150 per physical node) maps keys to replica sets. When a node joins or leaves, only ~1/N of keys move.
- **Hybrid logical clocks** (Kulkarni et al., 2014) provide deterministic cross-node timestamp ordering for last-writer-wins conflict resolution. HLC combines physical wall time with a logical counter — causally related events are correctly ordered, concurrent events get a deterministic total order via NodeID tie-breaking.
- **SWIM gossip** (Das et al., 2002) detects node failures without a single point of failure. Randomized probing (direct ping → indirect ping via K peers → suspect → dead) converges in O(log N) rounds. State changes are piggybacked on probe messages — no dedicated gossip channel needed.
- **Quorum coordination** with tunable consistency: writes require W acks, reads require R responses. When R + W > N, reads observe the most recent quorum-acknowledged write. Async read repair fixes stale replicas after returning to the client.
- **Hinted handoff** buffers writes for temporarily unreachable nodes and replays them on recovery.
- **Anti-entropy** with merkle trees periodically compares replica digests and repairs any remaining drift that read repair and hinted handoff missed.

### Liveness vs. ring ownership

This is the most important architectural decision in the distributed layer: **SWIM liveness and ring ownership are completely independent**.

SWIM answers "can I reach this node right now?" The hash ring answers "who owns this data?" When SWIM marks a node as dead, the ring is *not* modified — the dead node still owns its virtual nodes. The coordinator routes around it using hinted handoff. When the node recovers, it resumes owning its keys with zero ring churn.

Ring changes only happen via explicit admin commands (`join`, `activate`, `remove`). This prevents cascading topology changes during network partitions, which is the failure mode that kills most distributed systems.

## Design Decisions

### Internal key encoding: inverted sequence numbers

Each key version is stored as `user_key | inverted_seq` where `inverted_seq = MaxUint64 - seq`, encoded as 8 bytes big-endian. This means:

- **Newest versions sort first.** A higher sequence number produces a smaller inverted value, so `bytes.Compare` naturally returns the newest version of a key before older versions.
- **No custom comparator.** The merge iterator, SSTable index, and block binary search all use standard `bytes.Compare`. No special MVCC-aware comparison logic needed anywhere in the read path.
- **User key grouping for free.** All versions of the same user key are physically adjacent, which is exactly what MVCC-aware compaction needs to decide which versions to keep.

### Leveled compaction with MVCC-aware garbage collection

LithicDB uses leveled compaction with a 10x size ratio between levels. L0 triggers compaction at 4 files. Each level beyond L0 has sorted, non-overlapping key ranges.

The compaction GC policy is snapshot-aware: the newest version of every key is always kept. Older versions are kept if any active snapshot might read them (sequence number at or above the oldest active snapshot's watermark). Versions below the watermark are dropped. Tombstones are only removed at the bottommost level when no data exists below them — otherwise the tombstone could be dropped while an older value still lives in a deeper level, causing the deleted key to reappear.

### mmap for SSTable reads

SSTables are memory-mapped with `syscall.Mmap(PROT_READ, MAP_PRIVATE)` instead of being read into the Go heap. The OS manages the page cache — only actively-read pages consume physical memory, and cold pages are evicted under pressure. The bloom filter (~1KB per SSTable) is copied to the heap on open because it's accessed on every point lookup.

### Leaderless replication: why not Raft

Raft provides strong consistency (linearizability) but requires a leader for every write. Leader election adds latency during failures, and the leader is a throughput bottleneck. For a key-value store where last-writer-wins is an acceptable conflict resolution policy, leaderless replication (Dynamo-style) is a better fit: any node can accept writes, availability during partitions is higher, and the implementation complexity shifts from consensus to convergence.

The tradeoff is weaker consistency — LithicDB provides eventual consistency with tunable quorum, not linearizability. For the use cases this project targets, that's the right tradeoff.

### HLC for conflict resolution: why not vector clocks

Vector clocks detect conflicts (concurrent writes) but don't resolve them — the application must. HLC timestamps provide a deterministic total order: the write with the highest HLC wins. This is simpler for clients (no conflict resolution callbacks) and simpler for the storage engine (no need to store multiple concurrent versions per key).

The cost is that HLC's ordering is only causally consistent for events connected by message passing. Two independent writes on different nodes get a deterministic order, but that order may not reflect real-time causality. For a key-value store with last-writer-wins semantics, this is acceptable.

## How a Read Works

Here's what happens when LithicDB handles `Get("user:1234")`:

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

The engine checks memory first (active memtable, then immutables), then disk. Each SSTable has a bloom filter that rejects ~99% of irrelevant files with zero I/O. For the SSTables that pass, binary search finds the right block, which is read from the mmap'd region (or the block cache if recently accessed).

In a well-compacted database, a point lookup touches one or two disk blocks at most.

## What "From Scratch" Means

"From scratch" does not mean rebuilding the entire world. I use Go's standard library, gRPC for networking, and protobuf for serialization. What it means is that the storage engine and every distributed primitive is mine: memtable, WAL, SSTable format, bloom filter, compaction, manifest, MVCC, snapshot isolation, transactions, consistent hashing, HLC, SWIM gossip, quorum coordination, read repair, hinted handoff, and merkle-tree anti-entropy.

LithicDB is not a SQL database, not a Raft-based replicated store, and not an attempt to replace RocksDB. The goal is to build a serious distributed storage engine and understand where the real complexity lies — by implementing it.

## The Rest of the Series

Each post covers a layer of the system, building from the bottom up:

1. **This post** — Architecture, design decisions, and the distributed layer overview
2. [**The Storage Foundation**](/posts/lithicdb-storage-foundation/) — Memtable, WAL, SSTable format, bloom filters, and the iterator contract
3. [**Wiring It All Together**](/posts/lithicdb-wiring-it-together/) — Internal key encoding, the merge iterator, write path, flush, and crash recovery
4. [**Making the Engine Self-Maintaining**](/posts/lithicdb-self-maintaining/) — Manifest, leveled compaction, block cache, mmap, write batches, and backpressure
5. [**Snapshots, Transactions, and the Art of Not Blocking Writers**](/posts/lithicdb-mvcc-transactions/) — MVCC, snapshot isolation, optimistic transactions, and version-aware compaction GC
6. [**Who's Alive? Building SWIM Failure Detection from Scratch**](/posts/lithicdb-swim-protocol/) — SWIM probe cycle, incarnation-based CRDT merge, gossip dissemination, and decoupling liveness from ring ownership
7. [**Quorum Reads, Quorum Writes, and the Repair That Follows**](/posts/lithicdb-quorum-coordinator/) — Coordinator fan-out, quorum latency, two-phase read repair, and the bugs in testing impossible states

## References

- O'Neil, P., Cheng, E., Gawlick, D., & O'Neil, E. (1996). [The Log-Structured Merge-Tree (LSM-Tree)](https://www.cs.umb.edu/~poneil/lsmtree.pdf). Acta Informatica, 33(4), 351-385.
- DeCandia, G., Hastorun, D., et al. (2007). [Dynamo: Amazon's Highly Available Key-Value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf). SOSP '07.
- Das, A., Gupta, I., & Motivala, A. (2002). [SWIM: Scalable Weakly-consistent Infection-style Process Group Membership Protocol](https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf). DSN '02.
- Kulkarni, S., Demirbas, M., et al. (2014). [Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases](https://cse.buffalo.edu/tech-reports/2014-04.pdf). OPODIS '14.
- Lakshman, A. & Malik, P. (2010). [Cassandra: A Decentralized Structured Storage System](https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf). LADIS '09.
- Kleppmann, M. (2017). *Designing Data-Intensive Applications*. O'Reilly. Chapters 3 (Storage), 5 (Replication), and 7 (Transactions).
- Petrov, A. (2019). *Database Internals*. O'Reilly. Part I (Storage Engines) and Part II (Distributed Systems).
- [LevelDB](https://github.com/google/leveldb) — The original LSM implementation by Ghemawat and Dean. LithicDB's SSTable format and compaction strategy are directly influenced by LevelDB's design.
- [Pebble](https://github.com/cockroachdb/pebble) — CockroachDB's Go LSM engine. Reference for Go-specific patterns: iterator lifecycle, block cache sharding, and compaction picker/executor separation.
- [Badger](https://github.com/dgraph-io/badger) — Dgraph's Go key-value store. Reference for MVCC design and transaction API.
