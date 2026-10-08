# P3 V1 path scene and port proposal: a contracts fill-mesh port, implemented by geometry-wasm, injected by the host

**Port direction.** `packages/contracts` defines a fill-mesh port interface with plain-data requests and results. `packages/geometry-wasm` implements it with an adapter over its owned kernel. The host composition root constructs that adapter and injects it into `renderer-core`, which keeps its contracts-only imports. This is the direction [ADR 0001](../decisions/0001-port-composition.md) already fixed; [ADR 0002](../decisions/0002-path-scene-and-fill-mesh-port.md) records the concrete port and the new path scene node.

Status: APPROVED by the user on 2026-10-08, in chat; see the [approval record](#review-and-approval-record). It is D8 checkpoint V1 ([D8](p3-d8-parallel-tracks.md)), full tier. It is documentation only: it changes no code, no requirement, no threshold and no earlier user decision, except the D8-interim exception requested in V1-Q4. With that approval, ADR 0002 is accepted and its `ARCHITECTURE.md` change is applied. Code lands in V2 and V3.

## Scope

V1 fixes the public shape that Track A builds on:

- a path node in the scene contract;
- a fill-mesh port in `packages/contracts`;
- how the host injects the geometry-wasm adapter;
- where `renderer-core` consumes the port, and its cache key.

It is **fill only**. Stroke is marked as an extension point and waits for B2, which needs its own approval. V1 does not choose a mesh ABI, a GPU packet layout, a coverage realization or a carrier; those belong to V2 and V3.

**Evidence label.** V2-V4 results are functional evidence. Until checkpoint B4 has A04 evidence, every V2-V4 screenshot and report states that precision is **UNVERIFIED** against the 0.25 physical-pixel target, as D8 [requires](p3-d8-parallel-tracks.md#rules). V2-V4 close no A01-A08 criterion.

## Inputs this proposal does not change

- **Requirements.** [`docs/requirements.md`](../requirements.md) lists open and closed cubic Bezier paths. Both fill rules come from the [P3 roadmap scope](../prototype-plan.md#p3-fill-and-stroke-meshes) and the [graphics architecture](../graphics-engine-architecture.md#path-representation). V1 adds no product behavior beyond the approved visible semantics, except the D8-interim failure outcome in decision V1-Q4, which needs approval and is recorded in ADR 0002.
- **Approved visible semantics.** The [P3 visible semantics](p3-visible-semantics-proposal.md) own fill closure, fill-rule meaning, degenerate subpaths and composition. A path node renders them; it does not restate them.
- **P2 ABI v1.** Section [e](#e-p2-abi-v1-is-unchanged) below.
- **Private contract.** C03-C05 stay open. The [C04 carve-out](p3-private-contract.md#private-transport-and-lifetime-requirements) applies to V2 and V3 only.
- **User decisions** U1-U4, Q3-Q5, A5, K1 and E1-E3 in the [private contract](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06) are unchanged. This proposal's own decisions are numbered V1-Q1 to V1-Q4 to avoid those IDs. V1-Q4 does not answer U2 or U4; see section h.

## a) Path node in the scene contract

`packages/contracts/src/scene.ts` gains a third node kind. The sketch below is normative for names and meaning; V3 lands it.

```ts
export type ScenePathVerb = 'move' | 'line' | 'cubic' | 'close';
export type SceneFillRule = 'nonzero' | 'evenodd';
export type ScenePathGeometry = Readonly<{
  kind: 'path';
  verbs: readonly ScenePathVerb[];
  /** Interleaved node-local x, y. move and line take one point, cubic three, close none. */
  points: readonly number[];
  fillRule: SceneFillRule;
}>;
export type PathStyle = Readonly<{ fill: SceneColor | null }>;

export type RenderNodeSnapshot = SceneNodeBase &
  (
    | Readonly<{ kind: 'primitive'; geometry: PrimitiveGeometry; style: PrimitiveStyle }>
    | Readonly<{ kind: 'path'; geometry: ScenePathGeometry; style: PathStyle }>
    | Readonly<{ kind: 'container'; children: readonly string[] }>
  );
```

**Path data.** The verbs are the four canonical verbs of the [graphics architecture](../graphics-engine-architecture.md#path-representation). Quadratics and arcs are normalized before they reach the scene. The grammar is the P2 v1 grammar ([P2 private contract](p2-private-contract.md)): a nonempty subpath starts with `move`, `line` and `cubic` need an open subpath, `close` ends one, and repeated `close` is invalid. The points array length equals the sum the verbs consume. Every coordinate is finite. An empty path is valid and draws nothing.

**Fill rule.** `fillRule` is required, with no default, as the approved semantics require. It sits on the geometry, not the style, because it changes the mesh. Color does not.

**Style.** `fill: null` draws nothing and calls no port. `fill` uses the existing straight-alpha `SceneColor` and the P1 D2 composition. Node `opacity` keeps its P1 meaning.

**Scene validation.** The mirror validates synchronously, as it does today:

| Input                                                                       | Result                |
| --------------------------------------------------------------------------- | --------------------- |
| Grammar or point-count violation, unknown verb, nonfinite coordinate        | `invalid-value`       |
| Missing or unknown `fillRule`                                               | `invalid-value`       |
| A path node while the renderer has no fill-mesh port injected               | `unsupported-feature` |
| A path inside the grammar but beyond kernel caps, or one the kernel rejects | Accepted; see V1-Q4   |
| Snapshot equality for replay and `revision-conflict`                        | Includes path data    |

Scene validation does not encode kernel caps. Caps are kernel internals that B1 will change; a scene-level cap would turn every cap change into a contract change.

**Stroke extension point.** V1 has no stroke field (decision V1-Q3). B2 adds stroke to `PathStyle` as a new field with cap, join and miter-limit values from the approved semantics. Today's `SceneStroke` (color and width) is not reused for paths, because it cannot carry those values.

## b) Fill-mesh port in `packages/contracts`

A new file `packages/contracts/src/geometry.ts`, exported from the contracts index. V2 lands it.

```ts
/** Equal to the P2 v1 verb bytes. */
export const PATH_VERB_CODES = Object.freeze({ move: 0, line: 1, cubic: 2, close: 3 } as const);

export interface FillMeshRequest {
  /** u32, unique within one batch; echoed in the result. */
  readonly requestId: number;
  readonly verbs: Uint8Array;
  /** Interleaved node-local x, y. */
  readonly points: Float64Array;
  readonly fillRule: 'nonzero' | 'evenodd';
  /** Integer e; the local flattening tolerance is exactly 2^e local units. */
  readonly toleranceExponent: number;
}

export interface FillMesh {
  /** Node-local x, y per vertex, Float64. */
  readonly positions: Float64Array;
  /** Three vertex indices per triangle. */
  readonly indices: Uint32Array;
  /** Vertex-index pairs (a, b), one per boundary mesh edge; see rule 5 for the orientation. */
  readonly boundaryEdges: Uint32Array;
  readonly bounds: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
}

export type FillMeshFailureCode =
  'invalid-path' | 'invalid-tolerance' | 'numeric-range' | 'work-limit' | 'unsupported-geometry';

type FillMeshEcho = Readonly<{ requestId: number; toleranceExponent: number }>;

export type FillMeshResult =
  | (FillMeshEcho & Readonly<{ status: 'ok'; mesh: FillMesh }>)
  | (FillMeshEcho & Readonly<{ status: 'empty' }>)
  | (FillMeshEcho & Readonly<{ status: 'failed'; code: FillMeshFailureCode }>);

export type FillMeshBatchResult =
  | Readonly<{ status: 'ok'; results: readonly FillMeshResult[] }>
  | Readonly<{
      status: 'batch-failed';
      code: 'invalid-request' | 'disposed' | 'resource-limit' | 'internal-error';
    }>;

export interface FillMeshPort {
  readonly portVersion: 0;
  /** Names the implementation's operation and error budget, for example 'geometry-wasm/fill-v0'. */
  readonly operationId: string;
  buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult;
}
```

**Rules for every implementation.**

1. **Plain data only.** Requests and results are typed numeric buffers and plain values. No WASM memory, pointer, offset, session handle, GPU object or kernel type appears in the port. The boundary checker enforces this (section [g](#g-acceptance-criteria-and-validation)).
2. **Owned results.** Every buffer in a result is an owned copy that the implementation never mutates or reuses after return. A later batch, a memory growth or `dispose` leaves earlier results intact. The caller must not mutate request buffers during the call; the implementation must not retain them after it.
3. **Batch call.** One call carries every path that needs a mesh for a frame. There is no per-path or per-segment port call.
4. **Order and isolation.** On `ok`, `results` has the request count and order. A failed path yields `failed` for that path only and publishes no partial mesh. `batch-failed` means no result at all.
5. **Meaning.** A mesh covers the region the approved semantics define for its `fillRule`, after the fill rule is applied, flattened at the requested tolerance. A mesh edge is a boundary edge when filled area lies on exactly one side of it. A collinear boundary split into several mesh edges is listed once per mesh edge, and zero-area triangles contribute no filled side. `boundaryEdges` lists exactly those edges. Each pair (a, b) is ordered so that the filled side's triangle (a, b, c) has a positive cross product (b - a) × (c - a) in node-local coordinates, whether the host treats y as up or down. The port makes no precision claim; precision is A04's, through B4.
6. **Determinism.** Equal requests give equal results within one implementation version.
7. **Synchronous.** The port is synchronous, like the renderer's frame preparation and the P2 session. A worker or asynchronous port would be a new port version with revision echoes; V1 does not need one.
8. **Batch versus path failure.** A malformed request array (not an array, sparse, wrong buffer types, duplicate `requestId`, non-integer or non-finite `toleranceExponent`) is `invalid-request` for the batch. The content of a well-formed request (grammar, coordinates, an exponent outside the accepted range, kernel limits) gives a per-path `failed`. V2 fixes the exact precedence inside each class, as C04 item 3 requires.
9. **Port v0.** `portVersion: 0`, one mesh per request, and Float64 node-local positions with Uint32 indices are the functional v0 shape. They do not bind the C04 item 2 layout. The K1 carrier, with E2's rule that an epoch change clips cached tessellation per cell, is expected to need a new port version.

**Why `boundaryEdges`.** The approved A5 ramp carries per-edge distance coefficients and an outer screen-space fringe. Its test-only realization also measures distance to boundary segments and vertices. Either needs the region boundary after the fill rule, which a triangle list alone does not state for coincident or cancelling edges. The port carries it as data. V3 decides how coverage uses it, including whether the test-only realization becomes production.

**Stroke extension point.** B2 adds a separate `StrokeMeshPort` or a new port version. The fill port does not grow optional stroke fields. Whatever B2 chooses must keep fill and stroke regions separately attributed until composition, as the [approved semantics](p3-visible-semantics-proposal.md#composition-invariant-and-technical-work) require; V1 does not constrain how.

**Not the editor's GeometryPort.** `ARCHITECTURE.md` reserves a broader geometry contract (bounds, hit testing, snapping) for the editor. `FillMeshPort` is its first member and the only one V1 defines.

## c) Host injection

```text
playground (composition root)
  -> geometry-wasm: a factory, named in V2, that returns a FillMeshPort
  -> renderer-core: renderer service constructed with { fillMesh: FillMeshPort }
  -> renderer-webgpu: backend attached to the core packet source, as in P1.4
```

- The host owns the adapter's lifetime, as it owns the service and backend today. Disposing the renderer service does not dispose the adapter; the host disposes both.
- `renderer-core` receives the port in its service constructor. With no port, path nodes are `unsupported-feature`, as in the table above, and primitive behavior is unchanged.
- That factory is the only `geometry-wasm` entry the host needs. Whether the fill adapter shares the P2 session or its arena is C04 item 4, which V2 answers; the host does not call the P2 session factory for fill.
- The playground manifest and the boundary policy gain `apps/playground -> @vector-studio/geometry-wasm`. Among current packages, only the playground, as host composition, gains it. `renderer-core` and `renderer-webgpu` still may not import `geometry-wasm`.
- Tests compose the same way with a test double or the real adapter. `geometry-reference` stays a test-only oracle; it may implement the port in tests, never in production.

## d) Where `renderer-core` consumes the port, and its cache key

**Consumption point.** During frame preparation, after scene and camera changes are applied and before draw packets are built, `renderer-core` collects every visible path node whose mesh entry is missing, and makes one `buildFillMeshes` call. It then builds packets in paint order, with path meshes interleaved with analytic primitives. V3 fixes the packet and draw contract.

**Geometry revision.** `renderer-core` derives it; the scene contract does not carry one. Whenever the mirror publishes a path node whose `verbs` or `points` are unequal to the resident node's, the node gets a new geometry revision from a counter owned by the mirror that only increases. This covers `applyChanges`, `replaceSnapshot` and a document or page identity switch. A node with no resident predecessor, including one reinserted after removal, also takes a new value. A caller-supplied hash or revision is not trusted; the [C04 item 5](p3-private-contract.md#private-transport-and-lifetime-requirements) rule that "an unchecked hash cannot substitute for equality" applies.

**Cache key.** `(portVersion, operationId, nodeId, geometryRevision, fillRule, toleranceExponent)`. The first two are the P3 operation and budget identity that the [numeric compatibility decision](p3-private-contract.md#numeric-compatibility-decision) requires in cache keys, so a changed operation or budget never serves an old mesh. Color, opacity, visibility and paint order are not in the key; changing them builds no mesh.

**Tolerance bucket.** `renderer-core` computes the exponent from the node's world linear map L, the camera zoom and the DPR, starting from the private contract's fill rule: `e = floor(log2(0.125 / sigmaMax(DPR * zoom * L)))`. The 0.125 share is the private contract's [curve allocation](p3-private-contract.md#numeric-compatibility-decision), not a new allocation. V3 fixes the guards: an exact comparison at bucket boundaries rather than a trusted rounded `log2`, as P2's adapter does; a singular or zero linear map, where sigmaMax is 0; underflow and overflow; the accepted exponent range; and whether a cached finer mesh may serve a coarser request.

**Transform-only changes.** A translation, or a change that leaves `e` the same, reuses the mesh. A change of `e` is a cache miss. This is the untiled K4 interim; the R2 epoch rules (E2) apply when the K1 carrier lands.

**Failures.** A `failed` or `batch-failed` result is never drawn and never enters the mesh cache, as C04 item 5's failed-result exclusion requires. How V3 avoids calling the port every frame for the same failing key, for example with a bounded failure memo that has its own invalidation outside the mesh cache, is a V3 item recorded in V3's C04 table. Decision V1-Q4 fixes what the user sees.

**Recovery.** Meshes are CPU-side reconstructible caches. Device loss rebuilds GPU buffers from them and from the latest accepted scene, without calling the port again, while their keys still match.

## e) P2 ABI v1 is unchanged

- `ABI_VERSION` stays 1. The kernel's exports `abi_version`, `reserve`, `input_ptr`, `input_capacity`, `output_ptr`, `output_capacity`, `memory_epoch`, `process`, `result_len`, `required_output_bytes`, `statistics_ptr` and `dispose` keep their names, signatures and byte layouts.
- `GeometrySession.batch` keeps its request, result, cache and tolerance behavior. Its `fillRule` and `strokeStyleHash` remain cache identity only.
- V2 adds the fill operation **beside** v1, with its own operation identity, as the private contract's [numeric compatibility decision](p3-private-contract.md#numeric-compatibility-decision) requires. Whether it shares the kernel arena is a C04 item 4 question that V2's contract answers.
- The existing P2 tests run unchanged and must pass in V2.

## f) Items V2 and V3 inherit

**V2, fill-mesh export and adapter (functional transport v0).**

1. The new kernel export and its operation identity beside P2 v1.
2. The C04 item 1-6 table: what v0 fixes and what it leaves open, per the carve-out.
3. Mapping from kernel statuses to `FillMeshFailureCode`, including which cap failures give `work-limit` and which topology rejections give `unsupported-geometry`.
4. How `boundaryEdges` is produced, and a test that it matches the triangle mesh's region boundary.
5. The accepted `toleranceExponent` range and its `invalid-tolerance` edge.
6. Owned-copy publication, and its test across a second batch, memory growth and disposal.
7. The adapter implementing `FillMeshPort`, and the port types landing in `packages/contracts`.
8. The boundary-checker extension in section g.
9. One shared port conformance suite run against the WASM adapter and a test double, as ADR 0001's consequence requires.

**V3, renderer mesh pipeline (fill only, untiled carrier K4).**

1. The path node landing in `scene.ts`, its validation table, and replay equality. Today an unknown `kind` is `invalid-value`. V3 makes `path` without a port `unsupported-feature`, which needs a port-presence input to the exported `RetainedSceneMirror`; its constructor takes only `onInvalidate` today.
2. Geometry-revision derivation and the cache key above.
3. Cache byte accounting, eviction, and failed-result handling outside the mesh cache.
4. Exponent guards: exact bucket comparison, singular transforms, range and reuse rule.
5. Packet layout, the mesh-specific origin (U3) and Float32 conversion.
6. A5 coverage on K4, and the user decision on adopting the O02 complement fringe in production.
7. Paint order interleaved with primitives.
8. The D8-interim failure outcome chosen in V1-Q4: its diagnostic code and the failure codes that reach it.
9. Device-loss rebuild from CPU meshes.

**V4** composes the playground as in section c and supplies headed screenshots with the UNVERIFIED label. **B4** measures the V2 export through the V3 pipeline. **B2** extends the scene and the ports for stroke.

## g) Acceptance criteria and validation

**For this proposal (V1).**

| ID    | Criterion                                                                                        | Method                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| V1-A1 | Port direction stated first, consistent with ADR 0001, with ADR 0002 and the architecture change | Independent `reviewer` review, READY                                                                 |
| V1-A2 | Every user decision in section h answered by the user                                            | Chat record, transcribed into this document                                                          |
| V1-A3 | No change to requirements, thresholds, earlier user decisions or P2 ABI v1; V1-Q4 is D8-interim  | Review of the diff                                                                                   |
| V1-A4 | Documentation checks                                                                             | Prettier check of changed Markdown, local link and anchor check, `git diff --check`, protected PR CI |

**For the implementations that conform to this proposal**, checked in V2 and V3, not here:

| ID   | Criterion                                                                                                                                                                                                                                         | Method, landed in                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P-B1 | Policy: among current packages only `apps/playground` may depend on `geometry-wasm`. `renderer-core` and `renderer-webgpu` may not, by manifest, alias or relative import                                                                         | `pnpm check:boundaries`, with a negative fixture per forbidden edge (V2)                                   |
| P-B2 | `packages/contracts/src` names no `WebAssembly`, `GPU*` WebGPU type, or WASM pointer, offset or memory handle, and imports nothing outside `packages/contracts/src`                                                                               | A new check in `tooling/check-boundaries.mjs`, with a seeded negative fixture (V2)                         |
| P-C1 | Port conformance: order and length, `requestId` and exponent echo, per-path isolation, `empty`, no partial mesh, owned results unchanged after a second batch, memory growth and dispose, and `boundaryEdges` equal to the mesh's region boundary | Shared suite against the WASM adapter and a test double, in `pnpm test:unit` and `pnpm test:geometry` (V2) |
| P-C2 | P2 v1 unchanged: `abi_version() == 1` and the existing P2 tests pass without edits                                                                                                                                                                | `pnpm test:geometry`; diff review of P2 test files (V2)                                                    |
| P-S1 | Scene validation rows of section a, including `unsupported-feature` without a port                                                                                                                                                                | Unit fixtures in `renderer-core` (V3)                                                                      |
| P-S2 | Cache key: a color, opacity or order change makes no port call; a geometry, `fillRule`, `operationId` or `portVersion` change rebuilds that node only; a transform change that keeps `e` rebuilds nothing                                         | Unit fixtures with a counting test double (V3)                                                             |
| P-S3 | A failed path is not drawn and not cached, other nodes draw, and the V1-Q4 outcome is observable                                                                                                                                                  | Unit fixtures with a failing test double (V3)                                                              |

## h) Decisions for the user

Each lists the recommended option first. Technical choices inside the approved direction (port synchrony, cache ownership in `renderer-core`, `boundaryEdges`, derived geometry revisions) are Primary decisions, stated above.

| ID    | Decision                                                          | Recommended                                                                                                                                                                               | Alternatives                                                                                                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1-Q1 | Port direction and ADR 0002                                       | Approve: port in `contracts`, geometry-wasm adapter, host injection; playground gains the `geometry-wasm` dependency                                                                      | `renderer-core` imports `geometry-wasm` directly; rejected by ADR 0001                                                                                                                                                                                             |
| V1-Q2 | Path data shape in the scene contract                             | Verb list plus flat point array, matching the canonical verbs and the P2 grammar; the renderer packs it into typed buffers                                                                | Command objects such as `{ kind: 'cubic', c1, c2, to }`: easier to read, larger and slower to copy and compare                                                                                                                                                     |
| V1-Q3 | Stroke in the V1 path node                                        | No stroke field; B2 adds one with cap, join and miter limit                                                                                                                               | Reserve `stroke: SceneStroke \| null` now and reject non-null with `unsupported-feature`; this fixes a stroke type that cannot carry caps or joins                                                                                                                 |
| V1-Q4 | D8-interim outcome, V2-V4 only, for a path the kernel cannot mesh | Accept the scene; do not draw that path; emit a warning through the existing diagnostic channel with a new code, labeled D8-interim and named in V3, giving the node and the failure code | No public code: the failure is visible only to tests through `renderer-core` internals, so a host sees a silently missing path. Or reject the change set with `unsupported-feature`: scene validation would need kernel caps and would still miss numeric failures |

V1-Q4 matters now: under today's caps (24 source verbs, 16 segments, 4 contours) many ordinary paths fail on a kernel cap, which V2 maps to `work-limit`, until B1 raises the caps.

V1-Q4 is an exception scoped to D8's functional, UNVERIFIED V2-V4 slice. It does not answer U2 or U4:

- U2 says no user-visible rejection is introduced by default. U4 allows reusing `render.submission-failed` only as a last resort and adds no public result variant. The recommended option does introduce a visibly missing path and a new public diagnostic code, so it needs explicit approval as an interim exception.
- The production failure behavior stays with U2: the R3, R0 and R2 direction, then R5 and U4 as last resorts. It must be decided before P3 acceptance, with requirements text naming the meshes that can reach it. The interim code is then removed or replaced.
- `render.submission-failed` is not reused.

## Review and approval record

- **Independent review.** A fresh-context `reviewer` agent returned NOT READY with three blocking items: V1-Q4 conflicted with U2 and U4 as first worded, the cache key lacked the operation and budget identity, and failed results were cached against C04 item 5. All three are resolved above, with 15 SHOULD-FIX items. The re-review returned READY with no blocking items; its two minor items, the status line qualifier and a pointer from U4 in the private contract, are applied.
- **User decisions, 2026-10-08, in chat.** The user chose the recommended option for each:
  - V1-Q1: approve the port direction and ADR 0002;
  - V1-Q2: verb list plus flat point array;
  - V1-Q3: no stroke field in V1;
  - V1-Q4: the D8-interim outcome, a missing path with an interim warning diagnostic, for V2-V4 only.
- **What approval does not do.** It closes no A01-A08 criterion and no C03-C05 item. A07 has its scene/API decision; its evidence still needs V3 and later work.
