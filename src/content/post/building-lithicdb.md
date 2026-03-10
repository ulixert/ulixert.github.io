---
title: "Building LithicDB: Writing a Distributed LSM Storage Engine from Scratch in Go"
description: "A deep dive into the design and implementation of LithicDB, an LSM-based storage engine exploring durability, MVCC, and distributed partitioning."
publishDate: "2026-03-10"
tags: ["go", "databases", "lsm-tree", "lithicdb", "distributed-systems"]
pinned: true
---

I've been building [**LithicDB**](https://github.com/ulixert/lithicdb), an LSM-based key-value storage engine in Go.

The project starts with the core pieces of a single-node storage engine: an in-memory memtable, a write-ahead log for durability, SSTables on disk, and background compaction. From there, I want to explore MVCC transactions and, eventually, a distributed layer that shards data across multiple nodes. I'm currently in the early stages of Phase 1 — the iterator contract and skip list memtable are in place, and I'm working on the write-ahead log.

"Lithic" comes from the Greek *lithos*, meaning stone. The name felt right for an LSM tree: writes arrive in layers, then get compacted over time into deeper, denser structures on disk.

This project is partly about building something useful, but mostly about understanding how storage engines actually work by implementing one myself. Reading papers and source code helps. Building the thing is different.

This post is about why I'm building LithicDB, what the architecture looks like, and what I expect to learn along the way.

## Why an LSM Tree?

Most general-purpose storage engines are built around one of two ideas: **B-trees** or **LSM trees**. PostgreSQL and SQLite are classic B-tree systems. LevelDB, RocksDB, Cassandra, and many modern write-heavy systems are built around LSM trees.

The core idea behind an LSM tree, introduced in *The Log-Structured Merge-Tree* (O'Neil et al., 1996), is simple: instead of updating records in place on disk, buffer writes in memory and periodically flush them to disk as large, sorted, immutable files. Reads then merge results from memory and disk.

That tradeoff matters because in-place updates tend to produce a lot of small random writes, while LSM trees turn many small writes into larger sequential ones. In return, reads become more complicated, because the same key may exist in memory and in multiple files on disk. To keep reads efficient, the system needs indexing, filtering, caching, and a background compaction process that merges files over time.

At a high level, that means:

- writes land in an in-memory **memtable**
- every write is also appended to a **write-ahead log** for recovery
- full memtables flush to disk as immutable **SSTables**
- background **compaction** merges SSTables into larger, better-organized levels

That combination makes LSM trees a natural fit for write-heavy workloads, and it also makes them a great way to learn how real storage engines balance performance, persistence, and complexity.

## What I'm Building

LithicDB starts as a single-node storage engine, but I'm designing it with three goals in mind: a solid storage foundation, transactional semantics, and a path toward distribution.

The first goal is a serious **single-node LSM engine**: memtable, WAL, SSTable format, bloom filters, block-based reads, checksums, compaction, a manifest for recovery, and a block cache for hot data. That alone is already enough to explore most of the interesting mechanics of an LSM tree.

The second goal is **MVCC and transactions**. Each key version will carry a timestamp, allowing readers to operate on a consistent snapshot without blocking writers. On top of that, write transactions can use optimistic conflict detection to determine whether they can commit safely. This general approach — versioned keys, snapshot reads, optimistic conflict detection — appears in systems like Badger and, at a larger scale, in Google's Percolator (*Large-scale Incremental Processing Using Distributed Transactions and Notifications*, Peng & Dabek, 2010), which builds distributed transactions on top of a versioned key-value store. I want to understand that model from the inside out.

The third goal is a **distributed layer**. Multiple LithicDB nodes will form a cluster, with data partitioned across nodes using consistent hashing and exposed over gRPC. Since MVCC is built into the local engine, single-shard transactions can stay local to one node, avoiding the coordination cost that cross-shard transactions would require.

This is intentionally ambitious, but the project is phased. I'm not trying to build everything at once.

## How a Read Works

To make this more concrete, here's what happens when LithicDB handles a lookup like `Get("user:1234")`.

First, the engine checks the active memtable. If the key exists there, return the newest visible version immediately. If not, check any immutable memtables that are waiting to be flushed.

If the key is not in memory, the read continues into the SSTables on disk. For each candidate SSTable, the engine first checks the file's **bloom filter**. If the bloom filter says the key is definitely not present, the file can be skipped without reading a data block. That eliminates most irrelevant files quickly, especially for negative lookups.

If the bloom filter indicates the key might exist, the engine uses the SSTable's index to locate the relevant data block, then reads only that block from disk or from the block cache if it is already hot.

In the lower levels of a leveled LSM tree, SSTables are arranged so that key ranges do not overlap, which means at most one SSTable per level needs to be examined. That is one of the main reasons compaction matters: it is not just reclaiming space, it is preserving read performance.

In a well-compacted database, a point lookup should usually require only a small number of block reads.

## What "From Scratch" Means

"From scratch" does not mean rebuilding the entire world.

I'll happily use Go's standard library, gRPC for networking, and normal tooling for testing, benchmarking, and profiling. What I mean is that the storage engine itself is mine: the memtable, WAL, SSTable format, read path, compaction logic, manifest, and MVCC layer.

I also want to be clear about what LithicDB is **not**, at least initially. It is not a SQL database, not a Raft-based replicated store, and not an attempt to replace RocksDB. The goal is narrower and more educational: build a serious storage engine, understand its tradeoffs, and then push it far enough to learn where the real complexity begins.

## The Plan

I'm breaking the project into five phases:

1. **Storage foundation** — memtable, WAL, SSTable format, bloom filters, and the basic read/write path
2. **Compaction and persistence** — leveled compaction, manifest, block cache, write batches, benchmarking
3. **MVCC and transactions** — versioned keys, snapshot reads, optimistic conflict detection, MVCC-aware compaction
4. **Distributed layer** — gRPC interface, consistent hashing, cluster membership, shard migration
5. **Performance hardening** — block compression, prefix encoding, value separation (inspired by *WiscKey*, Lu et al., 2016), parallel compaction, rate limiting

I plan to write a post after each phase: what I built, what broke, and what I learned.

## Why Go?

Go is the language I want to build systems in, and a project like this is a good way to learn its strengths and weaknesses properly.

It maps well to the shape of a storage engine: concurrent background workers, explicit coordination, strong tooling for profiling and benchmarking, and a relatively small language surface area. It is also the language behind several serious storage systems, including Badger and Pebble, so there is a strong ecosystem of ideas to learn from.

It also forces some interesting tradeoffs. Allocation patterns and garbage collection matter a lot in a system that wants predictable latency, which is one reason data structures like skip lists are often paired with arena-style allocation. That is exactly the kind of engineering constraint I want to understand better.

## What's Next

Phase 1 is underway. The iterator interface and skip list memtable are working, and the write-ahead log is next.

The first really consequential design choice is the on-disk layout. Once data starts landing in SSTables, future decisions about bloom filters, caching, compression, and compaction all depend on that format. So before worrying about distribution or fancy optimizations, I want to get the core invariants right: writes are durable, reads are correct, and recovery is trustworthy.

That's the foundation everything else depends on. The next post will be about how Phase 1 went.

---

*LithicDB is open source at [GitHub](https://github.com/ulixert/lithicdb). If you're interested in storage engines, LSM trees, or building databases from scratch, follow along.*

## References

- O'Neil, P., Cheng, E., Gawlick, D., & O'Neil, E. (1996). *The Log-Structured Merge-Tree (LSM-Tree)*. *Acta Informatica*, 33(4), 351–385.
- Lu, L., Pillai, T. S., Gopalakrishnan, H., Arpaci-Dusseau, A. C., & Arpaci-Dusseau, R. H. (2016). *WiscKey: Separating Keys from Values in SSD-Conscious Storage*. *FAST '16*.
- Peng, D., & Dabek, F. (2010). *Large-scale Incremental Processing Using Distributed Transactions and Notifications*. *OSDI '10*.
