# P3 V2 fill-mesh WASM export and adapter: functional transport v0

Status: FROZEN 2026-10-12 after independent review READY; see the [review record](#review-and-approval-record). It needs no user decision (section n). This is D8 checkpoint V2 ([D8](p3-d8-parallel-tracks.md)), full tier, because it adds a kernel ABI and lands the port types. It implements the approved [V1 proposal](p3-v1-path-scene-port-proposal.md) and [ADR 0002](../decisions/0002-path-scene-and-fill-mesh-port.md). It changes no requirement, no threshold, no earlier user decision and nothing V1 fixed. No code lands with this document.

**Evidence label.** V2 results are functional evidence. Every V2 report and PR states that precision is **UNVERIFIED** against the 0.25 physical-pixel target until B4 has A04 evidence, as D8 [requires](p3-d8-parallel-tracks.md#rules). V2 closes no A01-A08 criterion and no C03-C05 item.

## Scope

V2 lands, in one work unit:

- the port types of V1 section b in `packages/contracts/src/geometry.ts`, exactly as sketched there;
- a kernel export family `fill_v0_*` beside the unchanged P2 ABI v1;
- a `geometry-wasm` adapter that implements `FillMeshPort` over that export;
- the boundary-checker extensions P-B1 and P-B2;
- one shared port conformance suite (P-C1), and the P2 identity evidence (P-C2).

V2 does not touch `renderer-core`, `renderer-webgpu`, the scene contract or the playground source. It adds no cache, no GPU layout, no coverage data and no stroke. It does not raise any kernel cap; that is B1.

## a) Kernel export beside P2 v1

### Identity

| Item               | v0 value                                                                          |
| ------------------ | --------------------------------------------------------------------------------- |
| Export prefix      | `fill_v0_`                                                                        |
| Transport version  | `fill_v0_version() == 0`, also in both headers                                    |
| Input magic        | `0x30464756` (bytes `VGF0`)                                                       |
| Output magic       | `0x304D4756` (bytes `VGM0`)                                                       |
| Port `operationId` | `'geometry-wasm/fill-v0'`                                                         |
| Kernel revision    | `fill_v0_revision() == 1`; the adapter accepts only the revision it was built for |

Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md): the port `operationId` is `'geometry-wasm/fill-v0+r2'` and the kernel revision is `fill_v0_revision() == 2` (that contract's section 2.1). The transport version, the magics, the framing and every export name and signature are unchanged.

`abi_version()` stays 1. Every P2 export keeps its name, signature, byte layout and behavior, and P2 code paths never call fill code. The fill family is new names only; nothing is renamed or removed.

**Operation identity rule.** The `operationId` names the operation and its error budget (V1 rule 6 and the [numeric compatibility decision](p3-private-contract.md#numeric-compatibility-decision)). Any change that can alter an `ok` mesh for some request (flattening, the tolerance relation in section d, the topology cascade, the refinement or the vertex/triangle order) must change the `operationId` and the kernel revision together, for example to `'geometry-wasm/fill-v0+r2'`. A change that only turns a failure into a success, such as a B1 cap raise, keeps them, because failed results are never cached (V1 section d).

### Exports

All parameters and returns are `u32`, as in P2. `memory` is the existing exported memory.

| Export                                              | Meaning                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `fill_v0_version()`                                 | 0                                                                                                    |
| `fill_v0_revision()`                                | Kernel revision of the fill operation                                                                |
| `fill_v0_reserve(inputBytes, outputBytes)`          | Grows the input and output arenas and, on first use, the fill workspace; never shrinks; batch status |
| `fill_v0_input_ptr()`, `fill_v0_input_capacity()`   | Absolute byte offset and capacity of the input arena                                                 |
| `fill_v0_output_ptr()`, `fill_v0_output_capacity()` | Same for the output arena                                                                            |
| `fill_v0_memory_epoch()`                            | Epoch of the fill engine                                                                             |
| `fill_v0_process(inputLength)`                      | Runs one batch; batch status                                                                         |
| `fill_v0_result_len()`                              | Readable output bytes; 0 means no readable output                                                    |
| `fill_v0_required_output_bytes()`                   | Exact output size after `OUTPUT_CAPACITY`, else 0                                                    |
| `fill_v0_dispose()`                                 | Terminal and idempotent; returns `OK`                                                                |

A second module-level engine, `FillEngine`, owns this state. It shares no field, epoch, arena or workspace with the P2 `Engine` in `GLOBAL_ENGINE`. v0 has no statistics export; B0 and B4 measure through native harnesses.

Batch statuses reuse the P2 numbering and meaning: `OK=0`, `INVALID_BATCH=1`, `OUTPUT_CAPACITY=2`, `ALLOCATION_FAILED=3`, `DISPOSED=4`, `RESOURCE_LIMIT=5`, `INTERNAL_ERROR=6`. Path statuses are a fill namespace: `OK=0`, `EMPTY=1`, `INVALID_PATH=2`, `INVALID_TOLERANCE=3`, `NUMERIC_RANGE=4`, `WORK_LIMIT=5`, `UNSUPPORTED_GEOMETRY=6`. Failure is a status, never a trap used as control flow.

### Input framing

Little-endian. Offsets are relative to the input block; sections are in the listed order, non-overlapping, each at its required alignment, with zero padding. The layout is fully determined by the counts, so every offset field must equal its computed value.

Header, twelve `u32` (48 bytes):

| Offset | Field                              |
| -----: | ---------------------------------- |
|      0 | magic `0x30464756`                 |
|      4 | version 0                          |
|      8 | totalBytes, equal to `inputLength` |
|     12 | pathCount                          |
|     16 | verbCount                          |
|     20 | pointScalarCount                   |
|     24 | requestsOffset, = 48               |
|     28 | pathOffsetsOffset                  |
|     32 | pointOffsetsOffset                 |
|     36 | verbsOffset                        |
|     40 | pointsOffset                       |
|     44 | reserved, 0                        |

Sections:

1. Requests at 48, 8-aligned, 16 bytes each: `requestId u32`, `fillRule u32` (0 nonzero, 1 evenodd), `toleranceExponent i32`, `reserved u32 = 0`.
2. Path offsets, 4-aligned, `pathCount + 1` `u32` indexing verbs.
3. Point offsets, 4-aligned, `pathCount + 1` `u32` indexing Float64 scalars.
4. Verbs, `verbCount` bytes.
5. Points, 8-aligned, `pointScalarCount` Float64.

Offset tables follow the P2 rules: start at 0, nondecreasing, terminate exactly at the counts. An empty batch still carries both terminal entries. Every range, sum and product is computed with checked arithmetic before use; overflow never wraps.

`INVALID_BATCH` for the whole input: wrong magic or version, `totalBytes` mismatch, an offset field unequal to its computed value, a misaligned or overlapping section, nonzero padding or reserved bytes, a malformed offset table, `fillRule` other than 0 or 1, or `inputLength` above the input capacity. Verb bytes, point values, point counts per path and the exponent value are path content, not envelope; they give per-path statuses (section e). The adapter never produces an `INVALID_BATCH` input, so it treats that status as an ABI breach.

### Output framing

Header, sixteen `u32` (64 bytes): magic `0x304D4756`, version 0, totalBytes, pathCount, resultsOffset (= 64), dataOffset (= 64 + 80 · pathCount), then ten reserved `u32 = 0`.

After the header come the result records (80 bytes each, 8-aligned) and then one data area. The data area holds **one block per `OK` path, in request order**. A block is the path's positions (Float64), then its indices (`u32`), then its boundary pairs (`u32`), with zero padding to the next multiple of 8 bytes at the end of the block. Blocks are contiguous: the first starts at `dataOffset` and each next one starts where the previous padded block ends. `totalBytes` ends exactly at the end of the last block, or at `dataOffset` when no path is `OK`.

This per-path interleaving lets one pass write each path's block at its final place as soon as the path is computed: a block's offset depends only on the blocks before it.

Result record, 80 bytes, 8-aligned:

| Offset | Field                                                 |
| -----: | ----------------------------------------------------- |
|      0 | requestId `u32`, echoed                               |
|      4 | path status `u32`                                     |
|      8 | toleranceExponent `i32`, echoed                       |
|     12 | reserved `u32 = 0`                                    |
|     16 | blockOffset `u32`, bytes from the start of the output |
|     20 | vertexCount `u32`                                     |
|     24 | indexCount `u32`, a multiple of 3                     |
|     28 | boundaryIndexCount `u32`, a multiple of 2             |
|     32 | blockBytes `u32`, including the end padding           |
|     36 | three reserved `u32 = 0`                              |
|     48 | minX, minY, maxX, maxY (`f64`)                        |

Inside a block, positions start at `blockOffset`, indices at `blockOffset + 16 · vertexCount`, boundary pairs right after the indices. `blockBytes` equals `16 · vertexCount + 4 · (indexCount + boundaryIndexCount)` rounded up to 8. Every non-`OK` record has zero `blockOffset`, counts, `blockBytes` and bounds. Indices and boundary pairs are local to their path: 0 is the path's first vertex.

### Capacity, sizing and publication

`fill_v0_process` makes one pass over the paths. Each path is computed once into the fill scratch (section a, "Memory and allocation"). A result record or block is written only when its final offset plus its size is at most the output capacity; otherwise only its size is counted, and the call ends with `OUTPUT_CAPACITY`. This includes a capacity smaller than `dataOffset`, such as the first call. If the total exceeds the capacity, the call returns `OUTPUT_CAPACITY` with the exact `required_output_bytes`, and `result_len = 0`. The computation is deterministic (section c), so a retry with identical input after `fill_v0_reserve` to that size publishes exactly that size. Because a reserve can move the arenas, the adapter copies the input again after every reserve, as the P2 adapter does; the kernel does not promise to preserve input bytes across a reserve. The adapter retries once; a second `OUTPUT_CAPACITY` is an ABI breach. The adapter's output capacity only grows, so in steady state no retry occurs.

Transport caps follow P2: input at most 64 MiB, output at most 256 MiB, including headers and padding. `fill_v0_reserve` above either returns `RESOURCE_LIMIT` before allocating. A required output above 256 MiB or above `u32` range returns `RESOURCE_LIMIT` with `required_output_bytes = 0`. These are per-call safeguards, not supported-document limits. The caller may split a batch at path boundaries; the adapter does not chunk automatically.

The header is written last. No header and no `result_len` are published until every path has been written. Any failure leaves `result_len = 0`.

### Memory and allocation

`fill_v0_reserve` allocates the arenas, the `CubicFillWorkspace` and the fill scratch below. `fill_v0_process` allocates nothing and never grows memory, as P2's `process` does; a native test asserts zero allocations during `process`, as `engine.rs` does for P2. Workspace or scratch construction failure maps to `ALLOCATION_FAILED` when the allocator refuses, and to `INTERNAL_ERROR` for an invalid static limit configuration (`InvalidLimits`, `ByteLimit`, `CombinedByteLimit`). If a reserve grew the arenas but then failed to build the workspace or scratch, the engine keeps no workspace, and a later `fill_v0_process` returns `ALLOCATION_FAILED` without computing anything; the next reserve tries again.

The workspace is built from a runtime constant `FILL_V0_LIMITS`, equal today to the test constant `LIMITS` in `native_cubic_fill_tests.rs`. Runtime code may not import that `cfg(test)` constant. B1 changes these values without a port change. Every attempt passes `command_capacity = MAX_FLAT_COMMANDS`, as the native tests and B0 do.

**Fill scratch.** All sizes derive from `FILL_V0_LIMITS`, with `V = max_vertices` and `T = max_triangles`, and are reserved once:

| Scratch                               | Capacity                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Refined triangles (section f)         | `T + 2V` triangles, `3 · (T + 2V)` `u32`                                                                                         |
| Directed edges for the once-only test | `3 · (T + 2V)` records, sorted in place by undirected key                                                                        |
| Boundary pairs                        | `3 · (T + 2V)` pairs                                                                                                             |
| Ledger cross-check split edges        | `max_boundaries + max_nodes` directed node pairs                                                                                 |
| Vertex-to-node map                    | none: the kernel's `RoundedNode.vertex` gives node to vertex, and the reverse uses a binary search over each column's nodes by y |

The combined fill heap stays under the workspace's own 16 MiB combined cap plus this scratch; both totals are checked with checked arithmetic at reserve, and both are included in the linear memory that `linearMemoryBytes()` reports.

## b) Instance and arena (C04 item 4)

**Decision: the fill adapter instantiates its own `WebAssembly.Instance`.** It shares no linear memory, arena or engine with any P2 session. The host may compile the module once and pass the same `WebAssembly.Module` to both factories.

Reasons:

- The kernel state is a module-level singleton (`GLOBAL_ENGINE`), so two operations in one instance would share one heap.
- P2's adapter treats any storage change during `process` as an ABI breach and fails closed. The fill workspace allocates up to its 16 MiB combined cap at first reserve and the fill arenas grow independently, so a shared instance would detach P2 views and break P2 sessions.
- A fill fail-closed disposal must not dispose a P2 session, and the reverse.
- V1 section c already says the host does not call the P2 session factory for fill.

Calling both export families on one instance is unsupported. P2 code is not changed to guard against it; the P2 adapter would detect the resulting storage change and fail closed.

Lifetime rules, matching the P2 contract:

- **Epochs.** Every `fill_v0_reserve`, `fill_v0_process` and `fill_v0_dispose` call advances the fill epoch by exactly one, saturating at `u32::MAX` as P2 does, and invalidates every borrowed view, with or without physical growth. Before the epoch would wrap, the engine fails closed: it marks itself disposed and returns `DISPOSED`.
- **Borrowed views.** The adapter re-reads `memory.buffer`, pointers and capacities after every mutating call, checks the epoch advanced exactly once, and checks that `process` changed no storage. It never keeps a view across a call.
- **Owned copies.** Every buffer in a port result is a fresh `Float64Array` or `Uint32Array` copied from the output view before the next kernel call. It survives later batches, memory growth and disposal unchanged.
- **Dispose.** `fill_v0_dispose` is terminal and idempotent. It releases arenas and workspace; the linear memory itself is released when the host drops the instance. After dispose every operation returns `DISPOSED`, and the adapter returns `batch-failed: disposed` without calling the kernel.
- **New instance isolation.** Each factory call creates a new instance. Disposing one never affects another.
- **Stale and revision conflict.** The port carries no source revision; `renderer-core` derives geometry revisions (V1 section d). The adapter has no cache, so it has no stale or conflict outcome.
- **Accounting.** The adapter exposes `linearMemoryBytes()` (the current `memory.buffer.byteLength`) outside the port interface, so the host can account for the second instance. No hidden arena exists.

## c) Topology mode selection and determinism

The four `CubicFillWorkspace` entries differ only in the topology certificate stage. Decoding, flattening, contour collection and the rounded tessellation do not depend on the mode, and the tessellation input is the same contour point list in every mode. **The mesh of a path that succeeds is therefore the same whichever certificate admits it.** The mode affects only which paths are admitted, and the failure reported.

Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md): the sentence "the mesh of a path that succeeds is therefore the same whichever certificate admits it" holds for the exact rung only. A path that the fast rung admits gets the fast-rung mesh of that contract's section 3.5, which may differ from the exact-rung mesh.

**Decision: a fixed two-step cascade.**

1. Call `attempt` (legacy mode: exact simple-topology certificate, then the rounded-knot certificate after `KnotMismatch`).
2. Only if step 1 returns `Err(CubicFillError::Topology(e))` with `e` equal to `KnotMismatch` or `Unresolved`, call `attempt_triangle_free` on the same input. Other topology errors are not retried.

The final result is that of the last call made. No other retry exists.

Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md): a fast rung precedes this cascade (that contract's section 3.1). The cascade runs unchanged, on the same input, only when the fast rung falls back.

Reasons:

- Legacy is the route B0 measures and the one most simple, non-crossing curved paths take.
- Triangle-free admits crossing curved paths. Its contract proves the crossing graph is triangle-free, which every matching (one partner per leaf) is, and its frozen 42-row carrier certifies all 31 rows that the mixed mode certifies. It also takes explicit LINE kinds, which the plain transverse mode lacks (that mode treats a LINE as a stationary cubic and rejects LINE crossings).
- The plain transverse and mixed modes are not used. Mixed is covered: `certify_mixed_with_policy` (`simple_cubic_topology.rs:819-965`) differs between mixed and triangle-free only in the crossing-graph policy, a matching is triangle-free, and both share the 32-crossing ceiling, so every path mixed admits, triangle-free admits. Whether triangle-free admits every path plain transverse admits is not proved; B3 may add a step if a fixture shows a gap, which would change the `operationId` only if an `ok` mesh changed.

**Line-only paths.** A path with no `CUBIC` verb skips the topology stage in every mode (`all_line_eligible`), so step 1 is the only call.

**Determinism (V1 rule 6).** Each attempt resets all workspace state, so a path's result does not depend on other paths in the batch, on its position or on earlier batches. Equal requests give bit-identical results within one kernel revision.

## d) Tolerance

The accepted range is **`-1021 <= toleranceExponent <= 1023`**. Inside it:

- flattening tolerance `2^e` local units, passed as the P2 request tolerance (V1: "exactly 2^e");
- topology (rounded embedding) tolerance `2^(e-1)`.

Both are normal positive binary64 values throughout the range. The kernel builds them from the exponent bits, `f64::from_bits(((e + 1023) as u64) << 52)`, not with `pow` or `log2`. No overflow or underflow can occur, and the values are exact.

**Why topology = flatten / 2.** The private contract allocates 0.125 physical pixel to curve-to-boundary error and 0.0625 to boundary topology and arc tessellation. The renderer picks `e` from the 0.125 share (V1 section d), so half of `2^e` is the matching topology share. Today's native tests use the same pair, 0.125 and 0.0625. This is the allocation the contract names, not a precision claim; precision stays UNVERIFIED.

**Edges.** A value outside the range is `invalid-tolerance` for that path. A non-integer or non-finite exponent is `invalid-request` for the batch (V1 rule 8). The adapter encodes an integer outside the `i32` range as `-2^31`, which the kernel rejects as out of range, and echoes the caller's original number.

A cubic path at a very small `e` can still fail `numeric-range`: P2 flattening returns `NUMERIC_RANGE` when its rounding guard (at least `128 * 2^-52`) reaches the tolerance. That is a computation result, not a tolerance-range failure.

## e) Status mapping and precedence

### Per-path stage order

For each path, the first failing stage decides the status:

1. **Grammar and values.** The P2 grammar and finiteness check (`validate_path` in `geometry.rs`), run by the export before any cap. Failure: `invalid-path`. This keeps P2's order even though `attempt_body` checks its cheap caps before calling `run_path`.
2. **Tolerance range.** Section d. Failure: `invalid-tolerance`.
3. **Empty.** No verbs: `empty`.
4. **Workspace cascade** (section c), in the workspace's own frozen stage order: cheap source caps, flattening sizing, source decoding, emission, contour collection, leaf partitions, topology, rounded tessellation.
5. **Refinement and boundary** (section f).
6. **Empty region.** A successful mesh with zero triangles is `empty`; it then has zero vertices too.

### Mapping table

Every variant has exactly one outcome. Rows marked _batch_ make the whole call return `INTERNAL_ERROR`: they mean the kernel's own self-check failed, not that the input is unsupported.

| Kernel value                                                                                                                                                                                                                            | Port outcome                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Sizing `flat_status` `INVALID` (unreachable after stage 1)                                                                                                                                                                              | `invalid-path`                                                                                                                              |
| Sizing `flat_status` `INVALID_TOLERANCE` (unreachable after stage 2)                                                                                                                                                                    | `invalid-tolerance`                                                                                                                         |
| Sizing `flat_status` `EMPTY` (unreachable after stage 3)                                                                                                                                                                                | `empty`                                                                                                                                     |
| Sizing `flat_status` `NUMERIC_RANGE`                                                                                                                                                                                                    | `numeric-range`                                                                                                                             |
| Sizing `flat_status` `WORK_LIMIT`                                                                                                                                                                                                       | `work-limit`                                                                                                                                |
| `SourceLimit`, `CommandLimit`, `ContourLimit`, `PointLimit`, `OwnerLimit`                                                                                                                                                               | `work-limit`                                                                                                                                |
| `UnsupportedSource`, `ZeroLengthLeaf`                                                                                                                                                                                                   | `unsupported-geometry`                                                                                                                      |
| `Topology(KnotMismatch)`, `Topology(Unresolved)`                                                                                                                                                                                        | `unsupported-geometry`                                                                                                                      |
| `Topology(WorkLimit)`, `Topology(ByteLimit)`                                                                                                                                                                                            | `work-limit`                                                                                                                                |
| `Rounded(InputLimit \| EdgeLimit \| PairLimit \| EventLimit \| SectionLimit \| NodeLimit \| CellLimit \| BoundaryLimit \| ContributorLimit \| WorkLimit \| OutputLimit)`                                                                | `work-limit`                                                                                                                                |
| `Rounded(TopologyAmbiguous)`                                                                                                                                                                                                            | `unsupported-geometry`                                                                                                                      |
| `Rounded(InvalidTolerance)` (unreachable: tau is normal and positive)                                                                                                                                                                   | `invalid-tolerance`                                                                                                                         |
| `EmissionStatus`, `Rounded(InvalidInput)` (a non-finite point after P2 flattening already rejected non-finite output), `PlanMismatch`, `BoundsMismatch`, `InvalidCommand`, `InvalidProvenance`, `TopologyOwnership`, `RoundedOwnership` | _batch_ `internal-error`                                                                                                                    |
| `Topology(InvalidInput)`, `Topology(InvalidProvenance)`, `Rounded(InternalInvariant)`, a refinement or boundary self-check failure                                                                                                      | _batch_ `internal-error`                                                                                                                    |
| `Topology(InvalidLimits \| AllocationFailed)`, `Rounded(InvalidLimits \| AllocationFailed \| ByteLimit)`, `CombinedByteLimit`                                                                                                           | at `fill_v0_reserve`: `INTERNAL_ERROR` or `ALLOCATION_FAILED`, section a; returned by an attempt during `process`: _batch_ `internal-error` |

The mapping is one exhaustive Rust `match` with no wildcard arm, so a new kernel variant fails to compile until it is mapped.

`Topology(InvalidInput)` is internal because every way this pipeline reaches it is an internal inconsistency (empty contours, cubics or leaves, a partition error, a non-finite point, a duplicate source verb, a wrong mixed kind; `simple_cubic_topology.rs:1009-1129`); the input-side causes are caught earlier as `ZeroLengthLeaf` or `UnsupportedSource`. It is not retried by the cascade.

**v0 limitation: MOVE-only subpaths in a curved path.** A path that contains a `CUBIC` and also a MOVE-only subpath (`M M C ...`, or a trailing `M`) fails `UnsupportedSource`, so the whole path is `unsupported-geometry` (`cubic_fill.rs:528-530`). The approved semantics say such a subpath contributes nothing, so this is a kernel limitation, reported under the V1-Q4 interim and recorded for B3. A line-only path with a MOVE-only subpath is unaffected. The native status-mapping fixtures include this case.

**Precedence.** Batch failure beats every per-path status: a batch failure publishes no result. Inside a path, the stage order above decides, then the workspace's frozen order inside stage 4. In the cascade the second attempt's error is reported. Inside the batch class, `process` reports the first of: `DISPOSED`; `INVALID_BATCH`; `ALLOCATION_FAILED` for a missing workspace; `INTERNAL_ERROR` from the first path self-check failure in path order, returned at once; `RESOURCE_LIMIT` for an output total above the cap; `OUTPUT_CAPACITY`.

**Caps are not port behavior.** Today's caps (24 source verbs, 104 source scalars, 16 source segments, 4 contours, 72 flat commands, 68 contour points, 64 edge owners, 16 MiB combined heap, and the rounded `LIMITS`) are kernel internals. B1 changes them. No port test, conformance case or adapter check depends on their values. A conformance case that needs `work-limit` uses a path that exceeds a frozen **P2** limit instead: 65,537 `LINE` verbs exceed P2's 65,536 output verbs per path, whatever B1 does.

## f) Boundary edges

### The kernel mesh is not conforming

`RoundedFillWorkspace` builds one trapezoid cell per filled interval of each vertical slab and emits it as at most two triangles from its four corner nodes. Nodes exist only on columns. A cell's vertical side can therefore pass through a vertex that belongs only to a neighboring cell: a hanging node. The [conforming-mesh oracle contract](p3-conforming-mesh-oracle-contract.md) records this for the P3.2z mesh. Two consequences:

- **Interior split edges.** For squares `[0,4]x[0,4]` and `[4,8]x[1,3]`, the left cell's edge `(4,0)-(4,4)` is used by one triangle, and so is the right cell's edge `(4,1)-(4,3)`. Counting edges used once would report both as boundary, although `(4,1)-(4,3)` is interior.
- **Boundary T-junctions.** For same-orientation squares `[0,10]^2` and `[-5,0]x[0,5]`, the region boundary contains `(0,10)-(0,5)`. That segment is not a mesh edge: it is part of edge `(0,10)-(0,0)`, which is half interior.

So V1 rule 5 ("a mesh edge is a boundary edge when filled area lies on exactly one side of it") has no consistent answer on the raw kernel mesh.

### Decision: conforming refinement in the export

After a successful tessellation, the export refines each cell without moving or adding coordinates:

1. Its left side is column `slab` from corner `n0` up to `n3`; its right side is column `slab + 1` from `n1` up to `n2`. The hanging vertices of a side are the nodes of that column strictly between the two corners (node indices are contiguous by rank within a column) that have a mesh vertex.
2. With the chains `L0..Lp` and `R0..Rq` sorted by y, emit a ladder: from `(i, j) = (0, 0)`, while `i < p` or `j < q`, emit `(L_i, R_j, R_{j+1})` and advance `j` if `j < q` and (`i == p` or `y(R_{j+1}) < y(L_{i+1})`); otherwise emit `(L_i, R_j, L_{i+1})` and advance `i`.
3. Check every emitted triangle with the exact `orient2d` as strictly positive. A failure is a refinement self-check failure.

All nodes in a column share one exact x (`build_sections_and_nodes` gives every node the column's embedded x) and y increases strictly with rank. So each ladder triangle has two vertices on one vertical line and one on the other, its cross product is `dx * dy > 0`, and the ladder tiles the cell. The cell keeps its region and its triangle count rises by one per hanging vertex. Vertices, their order and their bits are unchanged.

Refined triangles are at most `max_triangles + 2 * max_vertices`, because a vertex lies on at most one cell side in each of its two adjacent slabs. The scratch is reserved at that size; exceeding it is a self-check failure.

**Boundary edges.** In the refined mesh, triangles are positive and interior-disjoint and every contact is a shared vertex or a whole shared edge. An interior edge then appears in exactly two triangles, in opposite directions, and a region-boundary edge in exactly one. The export lists each edge that occurs once, as `(a, b)` in that triangle's counter-clockwise order, scanning triangles in output order and edges `(i0,i1), (i1,i2), (i2,i0)`. An undirected edge seen twice in the same direction, or more than twice, is a self-check failure.

This satisfies V1 rule 5 as written: the third vertex `c` gives `(b - a) x (c - a) > 0`, a collinear boundary appears once per mesh edge, and the kernel emits no zero-area triangle.

**Kernel cross-check.** The export also checks its boundary list against the kernel's own ledger. Split every listed edge at every column node, vertex or not, strictly inside it. The resulting directed node pairs must equal the ledger's `boundaries` set exactly: lower and upper boundaries are whole cell edges, and vertical boundaries are spans between adjacent column nodes. A mismatch is a self-check failure. This compares two independent derivations inside the kernel; the test-side check below is separate.

The refinement is part of the fill export, not a change to `RoundedFillWorkspace`, whose behavior and tests are unchanged.

Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md): the cell-ladder refinement and the ledger cross-check apply to exact-rung meshes only. A fast-rung mesh is conforming by construction and is not refined; its `boundaryEdges` come from the same once-only scan, run on its triangles in output order (that contract's section 3.5).

### Test-side independent check

Tests do not trust the kernel's list. A test helper outside `packages/geometry-wasm`, using the exact predicates of `geometry-reference`, checks every `ok` mesh in the suite:

- all triangles strictly positive and interior-disjoint, and no vertex strictly inside any triangle edge (conformity);
- `boundaryEdges` equals, as a multiset of directed pairs, the edges used by exactly one triangle;
- on fixtures with exactly representable output (the integer fixtures below), the union of boundary edges equals the boundary of the independent fill-region oracle, and the triangle area equals its exact area.

Positive controls: the unrefined kernel mesh of both hanging fixtures fails conformity; a list built by naive edge counting on that mesh fails the region-boundary comparison; a dropped, duplicated or reversed boundary pair fails.

## g) Positions, bounds and indices

- `positions`: Float64 node-local x, y per vertex, copied bit-for-bit from the kernel vertices, in kernel vertex order.
- `indices`: `Uint32Array`, three per triangle, in refinement order (cells in kernel order, ladder order inside each). Every triangle is counter-clockwise: positive `(b - a) x (c - a)` in node-local coordinates. The port defines no front-face or cull convention; V3 does.
- `boundaryEdges`: `Uint32Array` of pairs, section f.
- `bounds`: the exact component-wise minimum and maximum of `positions`. It is not the flattened-path bound and not the source-curve bound. The adapter recomputes it from the copied positions and treats a difference from the kernel record as an ABI breach.

Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md): for a fast-rung mesh, `positions` are the boundary contours' flattened polygon vertices in contour order, reversed where the fast rung reverses a contour, and `indices` are the fast rung's triangles in emission order, counter-clockwise (that contract's section 3.5).

## h) TypeScript adapter

```ts
// packages/geometry-wasm/src/fill-adapter.ts, exported from the package index.
import type { FillMeshPort } from '@vector-studio/contracts';

export interface FillMeshAdapter extends FillMeshPort {
  readonly portVersion: 0;
  readonly operationId: 'geometry-wasm/fill-v0';
  /** Terminal and idempotent. Later calls return batch-failed: disposed. */
  dispose(): void;
  /** Current byteLength of this adapter's own linear memory. */
  linearMemoryBytes(): number;
}

export function createFillMeshPort(
  source: WebAssembly.Module | BufferSource,
): Promise<FillMeshAdapter>;
```

Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md): the `operationId` literal type is `'geometry-wasm/fill-v0+r2'`, and the adapter is built for kernel revision 2 (that contract's section 2.1).

The factory instantiates a new instance with no imports, checks that every `fill_v0_*` export exists, that `fill_v0_version()` is 0 and that `fill_v0_revision()` is the revision the adapter was built for. On any failure it disposes the instance and rejects. `packages/geometry-wasm/package.json` gains `@vector-studio/contracts` as a dependency, which the boundary policy already allows; its `tsconfig.json` gains the matching project reference if `tsc --build` needs it.

**Batch-level checks, in this order:**

1. Disposed adapter: `disposed`, no kernel call.
2. `invalid-request`, the first offending request in order: `requests` not an array, or sparse; an element not an object; `requestId` not an integer in `[0, 2^32 - 1]`; a duplicate `requestId`; `verbs` not a `Uint8Array`; `points` not a `Float64Array`; `fillRule` not exactly `'nonzero'` or `'evenodd'`; `toleranceExponent` not a finite integer.
3. `resource-limit`: the packed input would exceed 64 MiB, the kernel returns `RESOURCE_LIMIT` or `ALLOCATION_FAILED`, or a host typed-array allocation throws `RangeError`. The adapter stays usable.
4. An empty request array returns `{ status: 'ok', results: [] }` without a kernel call.

An exception thrown by the caller's own objects during validation (for example a throwing getter) is `invalid-request`, not a fail-closed breach; the kernel has not been called yet.

Odd point counts, unknown verb bytes and grammar errors are path content and come back as per-path `invalid-path`. The adapter copies request buffers into the input arena at once and keeps no reference after the call (V1 rule 2).

**Kernel self-check failure.** A kernel `INTERNAL_ERROR` from `process` (a per-path self-check of section e) returns `batch-failed: internal-error` but does **not** dispose the adapter. Each attempt resets the whole workspace, so the engine stays consistent, and the next batch runs normally. This keeps one defective path from turning every later path into `disposed`, which would be far wider than the approved V1-Q4 outcome. The same input fails the same way again (determinism), so V3 inherits the obligation to isolate it, for example by splitting a failing batch; see section l.

**Fail closed.** Any of the following returns `batch-failed: internal-error`, disposes the kernel, and makes every later call return `disposed`: a WASM trap; a non-`u32` or unknown status; `INVALID_BATCH`; `INTERNAL_ERROR` from `reserve`; a second `OUTPUT_CAPACITY`; an `OUTPUT_CAPACITY` whose `required_output_bytes` is zero, not larger than the current capacity, or above the 256 MiB cap; a `RESOURCE_LIMIT` that published a nonzero `required_output_bytes`; an epoch that did not advance exactly once; storage that changed during `process`; a failure that published `result_len > 0`; and any output inconsistency (header fields, a `dataOffset` other than `64 + 80 · pathCount`, an `OK` record with zero vertices or zero indices (a mesh with no triangles is `empty`), a nonzero reserved field in any record, offsets, totals, path count, a result echo that differs from the request, an unknown path status, a block offset that is not contiguous with the previous block, a `blockBytes` unequal to the size computed from the counts, a nonzero field in a non-`OK` record, an index or boundary index outside the path's vertices, a length not divisible by 3 or 2, a non-finite position, or bounds unequal to the recomputed bounds).

The adapter has no cache and no retry beyond the one capacity retry.

## i) Boundary checker (P-B1, P-B2)

**P-B1.** `tooling/boundary-policy.mjs` adds `@vector-studio/geometry-wasm` to the playground's allowed set in V2. The playground **manifest** edge is added in V4, when the playground first imports the factory, so V2 adds no unused dependency. `renderer-core` and `renderer-webgpu` stay without it.

Negative fixtures, one per forbidden edge, each checked by `pnpm test:unit`:

| Forbidden edge                                           | Fixture                                        |
| -------------------------------------------------------- | ---------------------------------------------- |
| `renderer-core -> geometry-wasm`, manifest               | Seeded manifest dependency, expect a violation |
| `renderer-core -> geometry-wasm`, alias import           | `@vector-studio/geometry-wasm` and a subpath   |
| `renderer-core -> geometry-wasm`, relative import        | `../../geometry-wasm/src/index.js`             |
| `renderer-webgpu -> geometry-wasm`, the same three       | As above                                       |
| `contracts -> geometry-wasm`                             | Alias and relative import                      |
| `geometry-wasm -> renderer-core` or `geometry-reference` | Alias and relative import                      |

To make manifest fixtures testable, the checker's per-package evaluation moves into an exported function of `boundary-policy.mjs` that takes a manifest object and a list of source files. `check-boundaries.mjs` keeps its command and output. `tests/unit/geometry-boundaries.test.ts` asserts today that no policy entry contains `geometry-wasm`; V2 changes that assertion to allow exactly the playground. This is an intended edit to a boundary test, not to a P2 behavior test.

**P-B2.** A new check in `tooling/check-boundaries.mjs` scans `packages/contracts/src/**/*.ts`:

- no `WebAssembly` identifier, no `GPU[A-Z]\w*` type, and no WASM handle name from an explicit pattern list kept in the policy file: case-insensitive `wasm`, `pointer`, `linearmemory`, `memoryepoch` and `arena`, plus `ptr` as a word or a `Ptr` suffix. The list deliberately omits `memory`, `epoch` and `offset`, which existing contracts use for other meanings (`OUT_OF_MEMORY`, scene epochs); today's contracts sources match none of the patterns;
- every import must be a relative specifier that resolves inside `packages/contracts/src`; a bare specifier (a package name such as `react` or `@vector-studio/geometry-wasm`) is a violation, because `workspaceImportTarget` resolves no path for it.

Comments are stripped with the TypeScript scanner (so a `//` inside a string literal is not taken as a comment) before the name patterns are matched, so the V1 doc comment that names `'geometry-wasm/fill-v0'` as an example `operationId` passes. Seeded negative fixtures must be reported by the exported check function: `WebAssembly.Memory` used in a type position (not a comment), an import of `../../renderer-core/src/index.js`, and a bare import of `react`. The existing `tests/unit/contracts-boundary.test.ts` stays.

## j) Shared conformance suite (P-C1)

One suite, `tests/support/fill-mesh-port-conformance.ts`, exports `describeFillMeshPortConformance(name, createPort)`. It imports only `@vector-studio/contracts` types and the test-side check of section f. Two callers run it:

- `tests/geometry/fill-mesh-port.test.ts` with `createFillMeshPort` over the release WASM selected by `P2_WASM_PATH`, in `pnpm test:geometry`;
- `tests/unit/fill-mesh-port-double.test.ts` with a test double in `tests/support/fill-mesh-port-double.ts`, in `pnpm test:unit`. The double serves hand-written meshes from a fixed table keyed by path content and returns a configured failure code for marked inputs.

Cases. Each is required in both runs unless marked.

| ID  | Case                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C01 | Result length and order equal the request order, for 0, 1 and 5 requests                                                                                                                                           |
| C02 | `requestId` (including 0 and `2^32 - 1`) and `toleranceExponent` echoed on `ok`, `empty` and `failed`                                                                                                              |
| C03 | Empty verbs gives `empty`; a MOVE-only path gives `empty`                                                                                                                                                          |
| C04 | `invalid-path`: grammar error, odd point count, unknown verb byte, NaN coordinate                                                                                                                                  |
| C05 | `invalid-tolerance` at -1022, 1024 and `1e10`; a line square at -1021, 0 and 1023 is not `invalid-tolerance`                                                                                                       |
| C06 | `invalid-path` beats `invalid-tolerance` on one path                                                                                                                                                               |
| C07 | Per-path isolation: a failing path between two good paths leaves both good meshes identical to their single-request results                                                                                        |
| C08 | A failed path carries no mesh field                                                                                                                                                                                |
| C09 | Each `invalid-request` row of section h, with no results                                                                                                                                                           |
| C10 | Owned results: snapshot batch 1, run batch 2, force memory growth (WASM run), dispose; batch-1 arrays unchanged bit-for-bit                                                                                        |
| C11 | After dispose: `disposed`, also for an empty array; dispose twice is harmless                                                                                                                                      |
| C12 | Determinism: the same request twice and in a different batch position gives bit-identical results                                                                                                                  |
| C13 | Mesh checks of section f on every `ok`: conformity, boundary equals edges used once, orientation, bounds equal positions min/max                                                                                   |
| C14 | F01-F07, F10, F11 of the [private contract](p3-private-contract.md#fill-topology-and-independent-verification), both rules: area and region boundary equal the independent oracle; F04 evenodd and F05 are `empty` |
| C15 | Hanging fixtures of section f, both rules: interior split edge absent from `boundaryEdges`, boundary T-junction split at its vertex                                                                                |
| C16 | `work-limit` for 65,537 `LINE` verbs (WASM run); configured code for the double                                                                                                                                    |
| C17 | `numeric-range` for a cubic at `e = -60` (WASM run); configured code for the double                                                                                                                                |
| C18 | Request buffers mutated after the call do not change returned results                                                                                                                                              |

WASM-only native and adapter tests outside the suite cover: each input framing rejection, the status mapping with one fixture per reachable row (using the frozen carriers' `Unresolved` and `KnotMismatch` controls and cap+1 inputs for the current caps, labelled as current-cap fixtures that B1 may re-baseline), the cascade order, capacity retry with exact `required_output_bytes`, transport caps at limit and limit + 1, epoch exhaustion, zero allocation in `process`, and every fail-closed trigger through a wrapped export object, as the P2 adapter tests do.

## k) P2 v1 unchanged (P-C2)

The release WASM changes because it gains exports, so WASM SHA identity with `main` cannot be the evidence. P2 behavior identity is evidenced instead by:

1. `abi_version() == 1`, and the P2 export set present with unchanged signatures (`tests/geometry/kernel.test.ts` already checks presence).
2. `git diff main --name-status -- tests/` lists only added files and the intended edit to `tests/unit/geometry-boundaries.test.ts` (section i). Every existing P2 test file, including `tests/geometry/*`, `tests/geometry-browser/*`, `tests/geometry-benchmark/*` and the `tests/unit/geometry-*` and `tests/unit/p2-benchmark-*` files, is unchanged and passes.
3. `engine.rs`, the P2 exports in `lib.rs`, and the P2 parts of `codec.rs` and `geometry.rs` are unchanged except two additive, behavior-free items: `geometry::validate_path` becomes `pub(crate)`, and `PathInput` gains a non-test `pub(crate) fn from_parts` with the body of the existing `cfg(test)` `from_test_parts`. The reviewer checks this on the diff.
4. All native kernel tests, including `engine.rs` tests and the native P2 differential, pass unchanged.
5. The independent-build reproducibility check in `tooling/test-geometry.mjs` still passes, so the new artifact is reproducible.
6. Output-byte identity: a P2 corpus (the existing differential corpus) is run through the P2 session over `main`'s release WASM and over V2's; the P2 output bytes of every batch are equal. This complements the changed SHA with direct behavior evidence. `main`'s release WASM is built by a tooling step from `git archive` of the merge base into a temporary directory, with the same pinned toolchain and flags as `pnpm test:geometry`; the step and its command are recorded in the PR.

**Reading of the P2 private contract.** [P2](p2-private-contract.md) says one single-threaded WASM instance owns one arena and lists the P2 exports. V2 reads those statements as the scope of the P2 session: the fill family is a second engine with its own arena in a separate instance (section b), as V1 section e approved. V2 adds a one-line pointer to this document beside those P2 statements and changes nothing else there.

## l) C04 items 1-6: what v0 fixes and leaves open

| Item | v0 fixes                                                                                                                                                     | Left open for the C04 layout                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `fill_v0_*` names, version 0, magics, revision, header fields, offsets, alignment, padding, terminal offsets, checked arithmetic, reserved-byte rejection    | Version negotiation beyond exact match; the final operation and budget identity scheme                                                                                                                  |
| 2    | Float64 node-local positions, `u32` per-path indices, counter-clockwise triangles, conforming mesh, `boundaryEdges`, exact vertex bounds                     | Local origin (U3), Float32 packing, coverage or edge-distance attributes, cull convention, region labels, fill and stroke order, the K1 carrier and E1 records                                          |
| 3    | Source echo, complete publication, per-path versus batch precedence, capacity sizing and one retry, no partial mesh, transport caps with limit and limit + 1 | Explicit product limits for edges, intersections, vertices and triangles (kernel caps stay internal until B1); a distinguishable topology-ambiguity failure, which v0 folds into `unsupported-geometry` |
| 4    | Own instance, epochs, borrowed-view invalidation, owned copies, terminal idempotent dispose, instance isolation, memory accounting hook                      | A shared-arena design, if a later layout wants one                                                                                                                                                      |
| 5    | `operationId` for cache keys; no adapter cache                                                                                                               | Cache identity, byte accounting, failed-result exclusion, eviction and derived boundary invalidation, in V3                                                                                             |
| 6    | Nothing; V2 has no GPU resource                                                                                                                              | All of item 6, in V3                                                                                                                                                                                    |

V2's output is a reconstructible cache with no position or coverage certificate. A later C04 layout may replace it without a requirement change.

**Inherited by later units.**

- **V3:** a kernel `INTERNAL_ERROR` fails the whole batch without disposing the adapter (section h); V3 must keep one defective path from blocking the others, for example by splitting a failing batch, and its memo must handle the repeat. V3 also accounts for the fill instance's linear memory (`linearMemoryBytes()`, whose output arena never shrinks, up to 256 MiB) against the [prototype memory limit](../prototype-plan.md).
- **B0 and B4:** the refinement of section f adds up to one triangle per hanging vertex (at most `2V` more), and the cascade spends extra topology work on paths that legacy rejects. B0's E2 payload estimate (16·V + 12·T) uses the unrefined T, and its cost probe calls one mode. Interpretation of B0 against the export must account for both; B0's frozen text is unchanged.

## m) Acceptance criteria and validation

| ID     | Criterion                                                                                                   | Method                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| V2-A1  | This contract reviewed READY before implementation                                                          | Fresh-context `reviewer` review, recorded below                                                                                              |
| V2-A2  | Port types land exactly as V1 section b                                                                     | Diff review against V1; `pnpm check` (typecheck)                                                                                             |
| V2-A3  | Kernel framing, status mapping, precedence, cascade, capacity retry, caps, epochs, dispose, zero allocation | Native tests in `pnpm test:geometry`                                                                                                         |
| V2-A4  | Refinement and boundary rules of section f, with the kernel ledger cross-check                              | Native tests on the hanging fixtures, plus C13-C15                                                                                           |
| V2-A5  | Adapter validation and fail-closed behavior of section h                                                    | `tests/geometry/fill-adapter.test.ts` in `pnpm test:geometry`                                                                                |
| V2-A6  | P-C1: shared suite passes against the WASM adapter and the test double                                      | `pnpm test:geometry` and `pnpm test:unit` (inside `pnpm check`)                                                                              |
| V2-A7  | P-B1 policy and negative fixtures                                                                           | `pnpm check:boundaries` and `pnpm test:unit`                                                                                                 |
| V2-A8  | P-B2 contracts purity check with seeded negative fixtures                                                   | `pnpm check:boundaries` and `pnpm test:unit`                                                                                                 |
| V2-A9  | P-C2: section k items 1-6                                                                                   | `pnpm test:geometry`; the `git diff main --name-status -- tests/` check of section k; reviewer diff check                                    |
| V2-A10 | Whole repository green                                                                                      | `pnpm check`, `pnpm build`, `pnpm test:geometry`                                                                                             |
| V2-A11 | Documentation and plan status                                                                               | `pnpm exec prettier --check` on changed Markdown, local link and anchor check, `git diff --check`; status index row updated; protected PR CI |
| V2-A12 | UNVERIFIED label                                                                                            | Present in the PR description and in the plan's V2 evidence entry                                                                            |
| V2-A13 | Independent review of the evidence                                                                          | `reviewer` review of the diff and test output before merge                                                                                   |

A browser WASM run (`pnpm test:geometry:browser`) is not required for V2; V4 exercises the adapter in a browser.

## n) Decisions for the user

None. Every choice above is a technical decision inside the approved V1 direction: own instance, cascade order, tolerance relation, status mapping, export-side refinement and the V4 manifest edge. V2 introduces no product behavior; what a user sees for a failed path stays the approved V1-Q4 interim.

## Kernel facts relied on

Paths are under `packages/geometry-wasm/kernel/src/` unless stated.

- `lib.rs:83`: the kernel state is one `static GLOBAL_ENGINE` per instance; `lib.rs:94` returns `abi_version` 1.
- `engine.rs` `process`: no allocation, checked by `process_does_not_reallocate_reserved_storage` (`engine.rs:695`); `dispose` is terminal and advances the epoch; an exhausted epoch fails closed.
- `packages/geometry-wasm/src/adapter.ts:644-671`: P2 `mutate` requires one epoch step and, for `process` (`adapter.ts:620`, `allowMemoryChange` false), unchanged storage; `adapter.ts:745` fails closed on `INVALID_BATCH` and `INTERNAL_ERROR`.
- `geometry.rs:146-166`: `run_path` order is invalid path, invalid tolerance, empty, compute; `geometry.rs:176` `validate_path` is private.
- `codec.rs:259-268`: `PathInput::from_test_parts` exists only under `cfg(test)`; `codec.rs` input parsing is hard-wired to P2 magic, version 1 and 24-byte requests.
- `cubic_fill.rs:16-23`: caps 72 flat commands, 24 source verbs, 104 source scalars, 68 contour points, 4 contours, 64 edge owners, 16 source segments, 16 MiB combined heap.
- `cubic_fill.rs:340`: cheap source caps are checked before `run_path`; `cubic_fill.rs:353`: a non-OK sizing status returns `Ok` with no published output.
- `cubic_fill.rs:357,366`: paths without `CUBIC` skip topology; `cubic_fill.rs:385`: the rounded tessellation input is the same contour list in every mode.
- `cubic_fill.rs:671-708`: legacy mode tries the rounded-knot certificate only after `KnotMismatch` and reports `KnotMismatch` if that fails; `cubic_fill.rs:710` onward: arrangement modes select `certify`, `certify_mixed` or `certify_triangle_free`.
- `cubic_fill.rs:95` `CubicFillError` lists the 17 variants mapped in section e; `simple_cubic_topology.rs:81-90` lists the 8 `TopologyError` variants; `rounded_line_fill.rs:15-34` the 18 `RoundedFillError` variants.
- `rounded_line_fill.rs:587-589`: tau must be finite and positive.
- `rounded_line_fill.rs:838-839`: every node takes its column's embedded x.
- `rounded_line_fill.rs:1108-1139`: a cell opens and closes only at fill transitions, with nodes `[lower.left, lower.right, upper_right, upper_left]`.
- `rounded_line_fill.rs:1220-1238`: lower and upper boundaries are directed `n0 -> n1` and `n2 -> n3`; `rounded_line_fill.rs:1341-1359`: vertical boundaries are spans between adjacent column nodes, directed by which side is filled.
- `rounded_line_fill.rs:1400-1442`: vertices are only cell nodes; each cell emits `(n0,n1,n2)` and `(n0,n2,n3)`, omitting a symbolically degenerate one; `rounded_line_fill.rs:1458-1462`: every emitted triangle passes exact `orient2d > 0`.
- `rounded_line_fill.rs:1477-1492`: output bounds are the min/max over vertices, zero when empty.
- `native_cubic_fill_tests.rs:34-55`: test tolerances 0.125 and 0.0625 and the rounded `LIMITS`.
- `tests/geometry/kernel.test.ts:203-222`: the P2 export test checks presence, not the exact export set.
- `tests/unit/geometry-boundaries.test.ts:37-39`: asserts no policy entry allows `geometry-wasm`.
- `packages/geometry-wasm/package.json`: no dependency on `@vector-studio/contracts` today.

## Review and approval record

- **Independent review, round 1.** A fresh-context `reviewer` returned NOT READY with two blocking items, both resolved: B1, one-pass publication did not fit a section-ordered output, fixed with per-path interleaved blocks (section a); B2, the P-B2 name patterns matched the V1 doc comment, fixed by stripping comments (section i). Its eight SHOULD-FIX items are applied: `Topology(InvalidInput)` made internal and not retried; kernel self-check failures no longer dispose the adapter; the MOVE-only subpath limitation; the `tests/` diff criterion and P2 output-byte identity; the P2 contract reading and pointer; the fill scratch table; bare specifiers in P-B2; and the B0 and V3 inherited items (section l). Its minor items are applied too: process-time construction errors, a missing workspace, `command_capacity`, the mixed-mode inclusion, saturating epochs, extra fail-closed checks, the 16 MiB wording, memory accounting, caller exceptions and the `tsc` reference.
- **Independent review, round 2.** The same reviewer confirmed every round-1 fix and returned READY with no blocking items. Its three SHOULD-FIX items are applied: records and blocks are written only within capacity; V2-A9 covers section k items 1-6, with the build of `main`'s WASM; and extra adapter checks for empty `OK` records, reserved fields and `dataOffset`. Its minor items are applied: the missing-workspace precedence, the `linearMemoryBytes()` wording, the capacity wording and a scanner-based comment stripper.

## Addendum, 2026-10-20: B1 caps and failure-status transitions

This addendum records facts that came after approval. The frozen text above is unchanged.

- **Caps (B1, PR #168).** The pre-B1 values this contract states as current are historical: `FILL_V0_LIMITS` "equal today" to `LIMITS` (section b, Memory and allocation), the caps listed under "Caps are not port behavior" (section e), and the `cubic_fill.rs:16-23` item under "Kernel facts relied on". The current values and the pre-B1 cap mode are in the plan's [B1 kernel caps](p3-fill-stroke-meshes.md#b1-kernel-caps) section. `FILL_V0_LIMITS` now dominates `LIMITS` and is no longer equal to it. The contract's statement that no port behavior depends on the cap values still holds.
- **Failure-to-failure status changes keep the revision.** The [operation identity rule](#a-kernel-export-beside-p2-v1) lets a change that only turns a failure into a success keep the `operationId` and the revision, because failed results are never cached (V1 section d). The same reason covers a change from one failure to another: no failed result exists in any cache to become stale, and no `ok` mesh changes. B1 produced both kinds. The operation therefore stays `'geometry-wasm/fill-v0+r2'` at revision 2.
- **Observed transitions.** The plain identity run of B1 (`049ff85`) against its parent (`eca697e`), run `20261020T134953Z-23ca6e02`, over the B0, `p3-b0r-random/v1` and `p3-fill-ladder-random/v1` corpora, shows through `fill_v0` (native cascade, 15,270 cases): 13,453 unchanged, including all 9,465 cases whose status is `ok` (byte-identical output); 1,355 `work-limit` (5) to `ok` (0); 462 `work-limit` (5) to `unsupported-geometry` (6); no `ok` case changed or failed. Through the release WASMs (6,041 cases): 5,179 unchanged, including all 4,107 `ok` cases; 813 `work-limit` to `ok`; 49 `work-limit` to `unsupported-geometry`. The 49 are among the 462 native cases. The `work-limit` to `unsupported-geometry` cases are paths that the pre-B1 caps rejected with `OwnerLimit` or `CommandLimit` and that the B1 caps now carry to a topology or rounded-fill failure (`KnotMismatch`, `Unresolved` or `InputLimit`). The per-family counts and the method are in the plan's [B1 review follow-ups](p3-fill-stroke-meshes.md#b1-review-follow-ups).
