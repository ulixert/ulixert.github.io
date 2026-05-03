---
title: "Making Vectors Durable: KV Integration, Snapshot Persistence, and the Bugs Along the Way"
description: "Storing HNSW vectors as regular LSM entries in Theseon — the encoding format, key layout, per-collection concurrency model, a graph connectivity bug, and binary snapshot persistence to avoid full rebuilds on restart."
publishDate: "2026-04-07"
updatedDate: "2026-04-07"
tags: [ "go", "databases", "theseon", "vector-search", "hnsw", "lsm-tree" ]
series: "Building Theseon"
part: 10
order: 10
---

The [last post](/posts/theseon-hnsw-scratch/) built a standalone HNSW graph — insert, search, tombstone-aware beam
search, and an evaluation framework to measure recall. But the graph lived entirely in memory. Kill the process, lose
every vector. This post makes vectors durable by storing them as regular entries in the LSM engine and wiring the HNSW
graph into the write and read paths.

The key insight is architectural: vectors are just bytes. If you encode a vector into a KV value and assign it a KV key
with a known prefix, it flows through the existing WAL, memtable, SSTable, and compaction pipeline. It gets replicated by
hinted handoff and repaired by anti-entropy — all without a single line of vector-specific replication code. The HNSW
graph becomes a secondary in-memory index, always reconstructible from KV data.

This post covers the encoding format, the key layout (and a collision bug that forced a redesign), the per-collection
concurrency model, and a graph connectivity bug that was invisible until the evaluation framework caught it.

## The Encoding

Every vector needs to be serialized to bytes for KV storage. The format is compact, little-endian, and self-describing:

```
[version:1][dim:2][float32s: dim*4][num_fields:2]
  per field: [name_len:2][name][type:1][val_len:2][val]
```

The version byte enables forward-compatible format changes. The dimension is stored explicitly so the decoder doesn't
need external context. Five metadata types are supported: string (1), int64 (2), float64 (3), bool (4), and raw bytes
(5). Each field carries its own type tag and length — no schema, no external catalog.

One subtlety: metadata is a Go map, and map iteration order is random. Encoding the same vector twice could produce
different bytes, which would confuse checksums, caching, and debugging. The fix is simple: sort metadata keys before
encoding. Deterministic output for identical input.

```go
keys := make([]string, 0, len(metadata))
for k := range metadata {
    keys = append(keys, k)
}
slices.Sort(keys)
```

## The Key Layout

Every vector key starts with a prefix byte (`0x02`) that separates the vector namespace from regular KV data. After the
prefix, a length-prefixed collection name identifies which index the vector belongs to. Then a kind byte, then the
vector's UUID.

```
Config key:  [0x02][name_len:2][name][0x00]
Vector key:  [0x02][name_len:2][name][0x01][uuid:16]
```

The kind byte (`0x00` for config, `0x01` for vector) makes keys self-describing. A `ScanRange` over `[0x02, 0x03)` hits
every vector-related key. Within that range, config entries sort before vector entries for the same collection (because
`0x00 < 0x01`), which matters during recovery.

### The sentinel collision

The original design from the instruction document used a different approach: the collection config was stored with 16
zero bytes where the UUID would go — a "sentinel" value. Vector keys had a real UUID. Config vs. vector was
distinguished by whether the UUID was all zeros.

The problem: `[16]byte{}` is a valid Go zero value. If a caller passes an uninitialized UUID to `Put`, it collides with
the config key. The write overwrites the collection configuration with vector data. Silent corruption.

The fix was the kind byte. Instead of distinguishing config from vector by the UUID value, distinguish them by an
explicit tag. No value of UUID can collide with the config key because the config key has kind byte `0x00` while every
vector key has kind byte `0x01`. The distinction is structural, not dependent on what the caller passes.

## The VectorStore

The `VectorStore` wraps `db.DB` and maintains a per-collection HNSW graph:

```go
type collectionState struct {
    graph  *hnsw.Graph
    config CollectionConfig
    ids    map[[16]byte]uint64  // UUID → HNSW internal ID
    nextID uint64
    mu     sync.Mutex           // serializes writes
}

type VectorStore struct {
    db          *db.DB
    collections map[string]*collectionState
    config      VectorStoreConfig
    metrics     Metrics
    mu          sync.RWMutex     // protects the collections map
    logger      *slog.Logger
}
```

Two levels of locking. The `VectorStore.mu` read-write lock protects the `collections` map — acquired briefly to look up
a collection, then released. The `collectionState.mu` mutex serializes writes within a single collection. Different
collections don't contend with each other. Reads (search) don't hold either lock during the actual graph traversal.

### The ID mapping

HNSW uses `uint64` IDs internally. The KV layer uses `[16]byte` UUIDs. These need to be connected.

The original instruction suggested using the first 8 bytes of the UUID as the uint64. Simple, but birthday paradox:
with N vectors, collision probability is approximately N^2 / 2^64. At 2^32 (~4 billion) vectors, there's a ~50% chance
of collision. At realistic collection sizes (under 10 million) this is fine, but it's an uncomfortable bound for
something that silently corrupts data.

The chosen approach: auto-incrementing uint64 IDs with a forward map (`ids map[[16]byte]uint64`). No collisions, ever.
The uint64 IDs are ephemeral — rebuilt from scratch on every restart. Different restarts may assign different uint64 IDs
to the same UUID, which is fine because the HNSW graph is also rebuilt on restart.

Going the other direction — looking up a UUID from a uint64 after search — originally required a reverse map. That's
eliminated by adding an `ExternalID [16]byte` field to the HNSW `Node` struct. When search returns results, each
`SearchResult` carries its `ExternalID`. The reverse lookup happens in the graph, not in an external data structure.

## The Write Path

A vector write is a KV write followed by an HNSW update, inside the same per-collection lock:

```
Put(collection, uuid, vector, metadata):
  1. RLock VectorStore.mu → get collectionState → RUnlock
  2. Validate dimensions, encode vector+metadata
  3. col.mu.Lock()
     a. db.Put(vectorKey, encoded)
     b. graph.Insert(newID, uuid, vector)
     c. If this was an update: graph.MarkDeleted(oldID)
     d. Update forward map
     col.mu.Unlock()
```

The KV write happens first. If it fails, the HNSW graph is untouched — consistent. If the KV write succeeds but the
HNSW insert fails (memory limit, for instance), the vector is durable on disk but not searchable. The caller gets
`ErrIndexingFailed`, and the next restart rebuilds the graph from KV, picking up the un-indexed vector. Self-healing.

### Per-collection, not global

The early design held `db.Put` outside any VectorStore lock, since the DB has its own internal synchronization. The
problem: two concurrent Puts for the same UUID can interleave their KV writes and HNSW updates in different orders. KV
ends up with vector B while HNSW has vector A. Moving the KV write inside the per-collection lock makes the pair atomic.

The cost: writes to the same collection serialize. But `db.Put` is fast — it's a WAL append plus a memtable insert,
both in-memory operations with an fsync at the end. The lock is held for microseconds. And different collections are
fully independent.

### Delete

Delete follows the same pattern: KV first, HNSW second, inside the per-collection lock.

```
Delete(collection, uuid):
  1. RLock VectorStore.mu → get collectionState → RUnlock
  2. col.mu.Lock()
     a. Look up uint64 ID from forward map
     b. db.Delete(vectorKey)
     c. graph.MarkDeleted(uint64ID)
     d. Remove from forward map
     col.mu.Unlock()
```

If the KV delete fails, the HNSW graph is untouched. If a UUID doesn't exist, the delete is a no-op — idempotent. The
ordering guarantee is the same: KV is always updated before the in-memory index.

## The Search Path

Search is where the KV-as-source-of-truth model pays for itself:

```
Search(collection, query, k):
  1. graph.Search(query, k*2)      ← 2x oversample
  2. For each candidate:
     a. db.Get(vectorKey)
     b. If tombstoned or not found: skip
     c. Append to results
     d. If len(results) == k: break
  3. Return results
```

The HNSW graph returns 2k candidates, already sorted by distance. Each candidate is verified against KV — the source of
truth. Tombstoned entries (deleted in KV but still live in the graph) are filtered out. The 2x oversample compensates for
stale candidates.

The early break at step (d) matters: since candidates arrive pre-sorted from HNSW, once k verified results are
collected, every remaining candidate is farther away. No post-sort needed, no wasted KV lookups.

Why not trust the graph alone? Because the graph is a secondary index. A crash between a KV delete and a graph
tombstone, or a write that succeeded in KV but failed in the graph, creates divergence. The KV verification catches
all of it. The cost is one `db.Get` per candidate — a memtable lookup or a bloom-filtered SSTable read, typically
sub-microsecond.

## Recovery

On startup, `NewVectorStore` calls `loadCollections()`, which rebuilds every HNSW graph from KV data:

```
1. ScanRange([0x02], [0x03])
2. For each entry:
   - If kind == kindConfig: create HNSW graph with stored parameters
   - If kind == kindVector: decode vector, insert into graph
3. Config keys sort before vector keys → graph exists before vectors arrive
```

The ordering guarantee is structural: `kindConfig (0x00) < kindVector (0x01)`, so a collection's configuration is always
seen before its vectors in a sorted scan. No second pass needed.

This full rebuild is O(N * M * log(N)) per collection — fine for thousands of vectors, expensive for millions. The
snapshot persistence section below eliminates this cost for steady-state restarts.

## The Bug: Insert-Before-Tombstone

The most interesting bug was invisible without the evaluation framework.

When updating a vector (same UUID, new data), the original write path was:

```
1. graph.MarkDeleted(oldID)   ← tombstone old node
2. graph.Insert(newID, vec)   ← insert new node
```

This seems logical: remove the old one, add the new one. But HNSW insert uses beam search to find neighbors for the
new node. Beam search skips tombstoned nodes as results. If the old node was the only nearby live node — say, the only
vector in the collection, or the closest neighbor in a sparse region — tombstoning it first means the new node's beam
search finds no live candidates. The new node gets inserted with zero connections. It's isolated.

An isolated node in HNSW is catastrophic: no search will ever reach it. The vector exists in KV, it exists in the graph,
but it's disconnected from the navigable structure. A search query has no path to it.

The fix: insert first, tombstone second.

```
1. graph.Insert(newID, vec)   ← new node connects to old (still live) node
2. graph.MarkDeleted(oldID)   ← tombstone old node after new is wired in
```

The new node's beam search finds the old node as a live candidate and connects to it. After the new node is wired into
the graph, tombstoning the old node is safe — the new node's connections are already established.

This bug was caught by a test that inserted a vector, updated it, then searched. The search returned zero results. In a
single-vector collection, the only neighbor for the new node was the old node. Tombstoning first left the new node with
no connections, and the search couldn't reach it.

The general case is subtler: in a dense graph, other live nodes are nearby and the new node would still connect. The bug
only manifests in sparse regions or small collections. The eval framework's recall tests would catch the degradation
statistically — a drop from 0.95 to 0.93 recall — but the targeted test caught the degenerate case directly.

### What about the failure case?

With insert-before-tombstone, if the insert fails (memory limit), the old node is still live. KV has the new vector
(the `db.Put` already succeeded), but the graph still points to the old node. Search finds the old node, verifies
against KV, gets the new vector. The data is consistent from the caller's perspective. On restart, `loadCollections`
rebuilds the graph from KV, producing the correct state.

With tombstone-before-insert, if the insert fails, the old node is tombstoned and the new node doesn't exist. The
vector has no HNSW entry at all — it's durable but completely unsearchable until restart. Worse.

## What I Learned

The key architectural decision — vectors as regular KV entries — made almost everything simpler than expected. Durability
comes from the WAL. Recovery comes from `ScanRange`. Replication will come from the distributed layer. The HNSW graph is
a performance optimization, not a storage layer.

The per-collection locking model was driven by a concurrency bug, not by upfront design. The first implementation held
`db.Put` outside any lock, and the race condition between two concurrent UUID overwrites was immediately obvious in
review. Moving to per-collection locks fixed it without adding contention between independent collections.

The insert-before-tombstone ordering is the kind of bug that papers don't mention because it's an implementation detail,
not an algorithm detail. The HNSW paper describes insert and delete as independent operations. When you combine them into
"update," the order matters, and the correct order is counterintuitive: create the replacement before removing the
original.

The evaluation framework — built in Phase 1 for a different purpose — caught the connectivity bug within minutes. Recall
dropped to zero on a single-vector update test. Without automated recall measurement, every bug listed above would have been invisible. The graph would have "worked" (
returned results) without being correct (returning the right results). This is the fundamental challenge of approximate
algorithms: wrong answers look like right answers unless you have ground truth to compare against.

The snapshot work reinforced that file formats deserve more thought than they usually get. The first draft had header-only
CRC, buffered the entire graph to memory, used a shared sequence number across collections, and skipped updates during
reconciliation. Each of these was individually defensible and each would have caused a real problem: undetected
corruption, OOM on large graphs, duplicate entries after interleaved writes, and silently stale vectors after updates.
The lesson is that persistence code has more edge cases than in-memory code — the combination of crash recovery, partial
writes, and concurrent mutations creates failure modes that don't exist when data lives only in a process's heap.

## Snapshot Persistence

The full graph rebuild on startup is O(N * M * log(N)) per collection. Each Insert() runs beam search to find neighbors,
and there are N of them. For a million 768-dimensional vectors, that's reading ~3GB of KV data and running a million beam
searches. On a production restart, this dominates startup time.

The fix: serialize the HNSW graph to a binary snapshot file. On restart, deserialize in O(N) — just reading bytes into
structs, no graph construction — then replay only the KV entries written since the snapshot. The expensive Insert() calls
happen only for the delta, not the entire dataset.

### The binary format

The snapshot format puts nodes first, then a metadata header, then a footer:

```
[node_0][node_1]...[node_{n-1}]
[header block]
[footer: 33 bytes]
```

Each node is self-contained:

```
Node: [id:8][externalID:16][level:1][dim:2][vector: dim*4]
      per layer: [num_neighbors:2][neighbor_ids: N*8]
```

The footer lives at the end of the file and points backward to the header. This means a reader can validate the file by
reading only the last 33 bytes — check the magic number (`0x484E5357`, "HNSW" in ASCII), verify the version, then use
the header offset to locate the metadata. If any of this fails, the snapshot is corrupt and recovery falls back to a full
rebuild.

One early draft stored a `num_layers` byte alongside the `level` field in each node. Since `num_layers` always equals
`level + 1`, this was purely redundant — it was there as a cross-check during deserialization. But byte-offset arithmetic
already catches structural corruption (you'd read past the end of the node or into the header), and the whole-file CRC32
catch bitrot. A validation field that only catches bugs in the serializer itself isn't worth the cost of an extra byte
per node.

### CRC32 scope

The original design from the instruction document had CRC32 covering only the header block. This misses corruption in the
node data — a flipped bit in a vector or a neighbor ID would pass checksum validation. Since the nodes make up >99% of
the file, this seemed backward.

The implemented design computes CRC32 over everything before the footer: all nodes plus the header. The checksum is
written into the footer as the last step. On read, the entire prefix is loaded and hashed before any parsing begins. If
the checksum fails, the snapshot is rejected without attempting to deserialize any nodes.

### Streaming writes

An earlier approach serialized the graph to a `bytes.Buffer` under RLock, then wrote the buffer to disk outside the lock.
This minimizes lock hold time but doubles memory usage — a million 768-dim vectors occupy ~3GB in the graph and another
~3GB in the buffer. At scale, this OOMs.

The implemented approach streams directly to disk via `io.Writer`. A `crc32.NewIEEE()` hasher and `io.MultiWriter` tee
every byte to both the file and the hasher simultaneously. Memory usage is O(1) per node — just the bufio buffer (4MB)
plus a scratch buffer for integer encoding. The RLock is held for the full write including disk I/O, but since RLock
allows concurrent readers, search continues unimpeded. Only writers (Put/Delete) block, and snapshots trigger on shutdown
or after compaction — times when writes are already idle or nearly so.

### Sequence numbers and reconciliation

The snapshot records the DB's sequence number at the time it was written. On recovery, the engine needs to find entries
written after the snapshot and reconcile them. The naive approach — "skip entries whose UUID is already in the snapshot" —
has a bug: if a vector was updated after the snapshot (same UUID, new vector data), the skip logic silently keeps the
stale snapshot version.

The fix uses the LSM engine's internal sequence numbers. Every KV entry carries a sequence number assigned at write time.
The `ScanRange` iterator exposes this via `kv.SeqNum(iter.Key())`. During reconciliation:

```
For each KV entry in the collection:
  seq := kv.SeqNum(iter.Key())

  If tombstone:   → the vector was deleted after the snapshot
  If seq <= snap: → unchanged since snapshot, skip
  If seq > snap and UUID in snapshot: → updated, tombstone old + insert new
  If seq > snap and UUID not in snapshot: → new insert
```

One edge case: a vector deleted after the snapshot whose tombstone was compacted away by the LSM engine. The entry doesn't
appear in the scan at all — not as a tombstone, not as a live value. The reconciliation handles this with an "unseen" set:
start with every UUID from the snapshot, remove each UUID encountered during the scan, and anything remaining was deleted
and compacted away.

### Per-collection sequence capture

`SnapshotAll` writes one snapshot file per collection. An early version took a single `currentSeq` parameter, captured
once before iterating collections. This is only safe if writes are fully quiesced — otherwise a write to collection B at
seq 101 can happen between snapshotting collection A and collection B, while the manifest records seq 100 for both. On
recovery, the replay of `seq > 100` re-applies the seq 101 entry to B's graph, which already contains it from the
snapshot.

The fix: capture the sequence number per-collection, under that collection's write lock. When `SnapshotAll` processes
collection B, it acquires `col.mu.Lock()`, reads `db.CurrentSeq()`, then serializes the graph. At that moment, no writes
to B can be in-flight, so the captured seq is a true boundary for B's graph state. Other collections can continue writing
concurrently. The lock is released after serialization completes, before the slower fsync and rename.

### Manifest integration

The manifest — the append-only log that tracks which SSTables exist and at what levels — now also tracks HNSW snapshots.
A new record type (type 5) stores the collection name, sequence number, and snapshot filename. On recovery, the manifest
tells the VectorStore which snapshot files are valid. Old snapshot files not referenced by the manifest are garbage
collected on startup.

One consideration: the manifest's periodic state snapshot (type 3, written every 64 records to bound replay time)
originally captured only SSTable state. HNSW snapshot records accumulated in the log without being compacted into the
periodic snapshot. Each record is tiny (~40 bytes) and replay is a single map assignment, so this wouldn't be a problem
for a long time. But including HNSW state in the type 3 snapshot makes it self-contained — the full engine state after
any type 3 record, without needing to replay earlier entries. A small change now that avoids a subtle correctness gap
later if manifest compaction (rewriting the log to a fresh file) is added.

### Crash safety

The snapshot file is written using the same pattern as SSTable creation: write to a temp file, fsync, atomic rename,
fsync the directory. If the process crashes during the write, the temp file is cleaned up on startup. If it crashes after
the rename but before the manifest records the snapshot, the manifest doesn't reference the file, and it's cleaned up as
an orphan. In both cases, recovery falls back to a full rebuild — slower, but correct.

Corrupt snapshots (bitrot, partial write) are detected by the CRC32 check. The VectorStore logs a warning and falls back
to the full rebuild path. No manual intervention needed.

## What's Next

Metadata filtering (post-filter in beam search, secondary indexes for high-selectivity queries) and distributed fan-out
search across replicas via the existing coordinator.

---

### Read next
[**Fan-Out, Merge, Repair: Distributed Vector Search**](/posts/theseon-distributed-vector-search/)

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
10. **Making Vectors Durable**
11. [Fan-Out, Merge, Repair: Distributed Vector Search](/posts/theseon-distributed-vector-search/)
12. [Starting, Joining, Activating: The Node Orchestrator](/posts/theseon-node-orchestrator/)
13. [Benchmarking Theseon: KV, Cluster, Chaos, and HNSW on SIFT-1M](/posts/theseon-benchmarks/)
14. [Merkle Anti-Entropy: Catching Drift That Read Repair and Hinted Handoff Miss](/posts/theseon-anti-entropy/)

---

*Theseon is open source at [github.com/ulixert/theseon](https://github.com/ulixert/theseon).*

**References:**

- Malkov, Y. A. & Yashunin, D. A. (2018). *Efficient and Robust Approximate Nearest Neighbor Using Hierarchical
  Navigable Small World Graphs*. IEEE TPAMI. The original HNSW paper — insert and search algorithms, neighbor selection
  heuristic.
- DeCandia, G., Hastorun, D., et al. (2007). *Dynamo: Amazon's Highly Available Key-Value Store*. SOSP '07. The
  architectural inspiration for storing vectors as regular KV entries — if everything is bytes, the replication layer
  doesn't need to know about vector semantics.
