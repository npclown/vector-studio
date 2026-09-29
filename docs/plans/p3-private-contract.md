# P3 private mesh contract: preparation draft

Status: PARTIAL, 2026-09-29. This is the technical owner for P3 C03-C05, not a completed implementation freeze. [Visible semantics](p3-visible-semantics-proposal.md) were approved on 2026-09-29. The independent [line-fill oracle slice](p3-line-oracle-contract.md) can proceed under its own frozen test-only contract while remaining mesh/stroke/GPU obligations stay open. The [execution plan](p3-fill-stroke-meshes.md) owns task status and entry. No product code, private mesh ABI export or public GeometryPort is introduced here.

## Inherited boundaries and resolved technical constraints

- Keep canonical MOVE/LINE/CUBIC/CLOSE input, Float64 local numeric work and source identity from [P2](p2-private-contract.md). Existing P2 process/v1 output remains flattened paths with provenance; no caller may decode it as triangles. Fill/stroke are derived geometry, never durable document data.
- Keep Rust as the production geometry owner, geometry-reference as an independently implemented test-only oracle, and host composition as the join point. Renderer-core cannot import geometry-wasm. No dependency or package-direction change is selected.
- Mesh work must batch at the ABI; no per-edge/triangle JS/WASM calls. Host-retained buffers are owned copies. Reserve/process/dispose invalidate every borrowed view; no stale pointer crosses a mutation, cache publication or GPU upload.
- Keep one owner for any future shared Rust codec/engine/export changes and one owner for backend lifecycle integration. GPU device generation is distinct from CPU source revision; device loss rebuilds GPU resources without treating lost GPU data as document truth.
- P3 must preserve local stroke geometry under affine transforms and apply node opacity once to composed fill/stroke. An overlapped triangle soup blended repeatedly is not a correct stroke region. P1's primitive shader/packing contract cannot simply be reused for arbitrary meshes.

## Numeric compatibility decision

P2 adapter `screenTolerance` derives `0.25 / sigmaMax(DPR * zoom * worldLinear)` and quantizes downward. Its raw request accepts a tolerance, but its session API does not expose an independently budgeted P3 operation. The 0.25 budget is already fully allocated; multiplying the supplied zoom/DPR by a hidden factor to force finer geometry would falsify request identity and is not permitted.

There is a second independent compatibility blocker: the P1 private GPU contract permits 0.125 physical pixel for storage plus 0.125 for shader/projection. Its full 0.25 allowance cannot serve as P3's final 0.0625 share. P3 needs mesh-specific packing/projection verification and, if necessary, a reviewed successor private layout. P1's passed primitive fixtures do not prove that tighter obligation.

Primary selects a separately identified private P3 mesh operation/budget, retaining P2 v1 behavior and its tests. It can reuse kernel numeric primitives only after their compatibility and combined error tests; this does not require a new public service or external dependency. Exact raw names, layout and version negotiation remain C04 work below. Reject unknown operation/budget identities rather than silently using P2's allowance. Cache keys include the P3 operation/budget identity as well as geometry/stroke/fill/tolerance identity.

Prospective allocation of the unchanged total <=0.25 physical-pixel geometric error:

| Stage                                                       | Maximum physical error | Required proof/measurement                                                                                                            |
| ----------------------------------------------------------- | ---------------------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical curve to the intended fill/stroke boundary        |                  0.125 | Independent continuous error, including stroke normal/cap/join displacement, not only centerline distance                             |
| Boundary topology, intersections and round-arc tessellation |                 0.0625 | Region preservation plus a bound on generated boundary displacement; polygon interior triangulation must not introduce new boundaries |
| Float32 storage, shader transform and projection            |                 0.0625 | Independent Float64 reference with storage/arithmetic budget and later real GPU evidence                                              |

These are proposed implementation allocations within the existing total, not evidence that an implementation meets them. A boundary budget that cannot support the ordinary corpus must be resolved before freeze. Do not weaken the total target, reduce the ordinary-success corpus or silently return coarse geometry.

Each stage's stated bound includes its numerical guards; guards cannot be added outside the total. Bounds must compose in the same physical norm and against the same intended boundary. Selecting allocations is an ordinary technical decision inside the existing target, not approval to change the target or renderer architecture.

For fill-only flattening, start with a downward power-of-two local bucket <=0.125/sigmaMax(S), with S=DPR*zoom*worldLinear. Keep finite/positive checks, underflow/overflow rejection and conservative guards. Stroke refinement additionally needs tangent/offset analysis: positional closeness of centerlines alone does not bound wide-stroke edges or miter tips. Cusps, near reversals and endpoint tangents require explicit handling. Do not mark C03 complete by substituting the P2 centerline oracle for a stroke-boundary proof.

Coverage fringe changes sample coverage around the geometric boundary; it is not an extra allowance to move that boundary. Define geometric edge location and coverage comparisons separately. Finite but numerically unresolved topology fails explicitly, while named ordinary fixtures must succeed. The final singular-transform and GPU precision handling must stay consistent with existing scene behavior.

A connectivity change cannot be excused by a small positional bound. Finalize a distinguishable topology-ambiguity failure and exact precedence before ABI freeze; generic NUMERIC_RANGE/WORK_LIMIT is not permission to reject supported coincident edges. The geometric edge convention (including the existing P1 region-transition approach where applicable), ramp/reference, corner rule and permitted coverage/color errors are still C03/C04 blockers.

## Fill topology and independent verification

Classify all contours of a path together using the explicitly selected fill rule. Nonzero uses signed winding; evenodd uses parity. Do not infer holes only from contour orientation or triangulate each contour independently. Exact coincident/reversed edges, touching vertices, T-junctions, crossings and zero-area contours are mandatory cases. Closure/degenerate behavior follows the separately approved visible-semantics decision.

The independent oracle should classify sample points by a direct ray-crossing/winding calculation on source line contours, with a separate exact-on-edge result and a fixed half-open endpoint convention. Use exact integer/rational fixtures for topology where practical; the production topology algorithm must not supply the oracle's intersections or classification. Preserve boundary samples as boundary, not arbitrary inside/outside successes. Add analytic areas and region coverage/multiplicity checks; matching a finite point grid alone cannot prove no holes or overlapping triangle interiors.

The production-algorithm feasibility review must compare a bounded arrangement/decomposition approach against simpler contour-only triangulation. Reject a contour-only choice if it cannot represent crossings/coincident edges. Record predicate uncertainty handling, intersection ordering, collinear overlap handling, memory/work complexity and deterministic ties. No third-party tessellation package is authorized. A non-accepting executable spike needs its own frozen inputs, expected membership, limits and output artifacts before execution.

A deterministic vertical-slab decomposition is a candidate: use endpoint/intersection x events, group coincident directed crossings, apply winding/parity inside each open slab and triangulate the resulting disjoint regions. This is not a selected or validated implementation. Pairwise intersection enumeration has quadratic per-path cost; limits cannot be frozen from the average path size. Preserve a zero-signed-area self-intersecting contour when its lobes have filled area. Robust predicates, near-degenerate intersection placement and worst-case corpus work remain feasibility obligations.

Exact analytic fixture candidates follow. Closed-contour fill cases use already accepted nonzero/evenodd meaning; open-contour and stroke rows follow the approved visible-semantics decision:

| ID  | Input                                                                   | Independent expected result                                                                                                                                                                |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01 | Closed square (0,0),(10,0),(10,10),(0,10)                               | Area 100, both rules; interior (1,1), exterior (11,1), boundary (0,5)                                                                                                                      |
| F02 | F01 plus (3,3),(7,3),(7,7),(3,7), same orientation                      | Nonzero area 100; evenodd area 84; center (5,5) distinguishes the rules                                                                                                                    |
| F03 | F02 with reversed inner contour                                         | Area 84 under both rules                                                                                                                                                                   |
| F04 | F01 repeated twice, same orientation                                    | Nonzero area 100; evenodd empty                                                                                                                                                            |
| F05 | F01 followed by its reversed contour                                    | Empty under both rules                                                                                                                                                                     |
| F06 | Closed bowtie (0,0),(4,4),(0,4),(4,0)                                   | Area 8 under both rules; crossing (2,2) is boundary; (2,1) and (2,3) inside                                                                                                                |
| F07 | Adjacent closed squares [0,0]-[2,2] and [2,0]-[4,2]                     | Area 8; shared edge must not create a visible internal fringe                                                                                                                              |
| F08 | Open triangle (0,0),(8,0),(0,8)                                         | Fill area 32; its stroke stays open                                                                                                                                                        |
| F09 | Exact repeated point on F01, then contour-order permutation of F02      | Region unchanged; no zero-length normalization may change winding                                                                                                                          |
| F10 | Same-oriented squares A=[0,0]-[4,4], B=[2,0]-[6,4]                      | Nonzero area 24; evenodd area 16. (3,2) is inside only for nonzero; (1,2),(5,2) are inside both. Reverse B: area 16 under both rules                                                       |
| F11 | Same-oriented squares A=[0,0]-[4,4], B=[2,4]-[6,8]                      | Area 32 under both rules; (3,3.5),(3,4.5) and shared span point (3,4) are interior to the resolved region, with no internal fringe                                                         |
| S01 | Open line (0,0)-(10,0), width 2                                         | Butt area 20; square area 24; round area 20+pi                                                                                                                                             |
| S02 | Open L (0,0),(4,0),(4,4), width 2, butt caps                            | Miter area 16 at limit 2; bevel area 15.5 at limit 1 or explicit bevel; round area 15+pi/4. All have bounds [0,-1,5,4]; verify independent regions, not summed overlapping rectangle areas |
| S03 | MOVE-only, all-zero open and all-zero closed subpaths at (4,5), width 2 | Approved empty/disk/square cases in the visible-semantics table                                                                                                                            |

Add rational near-collinear, partial coincident overlap, endpoint-on-edge, reversed traversal and area-preserving translation/reflection cases before freezing the corpus. Round shapes need analytic arc/area comparisons with declared numerical allowance; do not demand exact polygonal area equal to pi. Continuous curve/stroke fixtures and seeded corpus remain to be specified; these small examples do not replace the roadmap's 1,000 paths x 32 cubics and 1%-6400% zoom.

Distinguish a point on a source contour from a boundary of the final filled region. In F07/F11 the cancelled common edge is interior; the oracle must resolve its adjacent winding states rather than report a visible boundary for every source edge. Miter equality and near-cutoff fixtures require independently specified numeric uncertainty handling before freeze; do not use implementation rounding or a mocked predicate result as the expected visible image.

Positive controls must independently fail a missing triangle, a duplicated overlapping triangle, wrong fill parity, a flipped index, out-of-range indices, NaN vertex, underreported bounds, misplaced cap, wrong miter fallback, stale source echo and lost local ownership. Triangle orientation alone is not evidence of correct region coverage.

## Private transport and lifetime requirements

C04 remains open until topology, coverage and composition have a feasible representation. Freeze all of the following together before a mesh ABI or renderer packet implementation:

1. Private operation/version identity, request/result header fields, exact byte offsets/alignment/padding, lengths and terminal element offsets. Define checked arithmetic for every range and reject unknown flags/versions/reserved bytes.
2. Vertex position representation and local origin, coverage or edge-distance attributes, index width, range units, front-face/cull convention, region labels and fill/stroke ordering. Bind layout to the actual composition method; an opaque `vertices` buffer without attributes is insufficient.
3. Successful source echoes and complete output publication, per-path versus batch failure precedence, capacity sizing/retry and no partial failed-path mesh. Explicit limits for edges, intersections, output vertices/triangles, scratch/arena bytes and retries, including limit and limit+1 fixtures.
4. Per-instance reserve/view epochs, owned-copy publication, terminal idempotent disposal, new-instance isolation and stale/revision conflict behavior. If mesh and P2 operations share an arena, both invalidate each other's borrowed views, while owned results remain valid. No second hidden unaccounted arena.
5. Cache identity for all mesh-affecting inputs, explicit byte accounting, failed-result exclusion and bounded eviction. Actual stroke values require identity checking; a caller's unchecked hash cannot substitute for equality. Color/opacity changes must avoid geometry rebuild. Derived boundary data and any screen-space fringe data have distinct invalidation obligations.
6. Single-owner GPU upload/incarnation receipts, completion-safe retirement, latest-scene reconstruction, simultaneous old/new backing accounting and dispose races. Preserve existing P1/P0 allocator and generation meanings.

Candidate safe composition directions are region-partitioned fill/stroke evaluation or another proven single-opacity mesh scheme. Independent full-alpha draws with node opacity applied twice are excluded by the inherited contract. No offscreen isolation, stencil reinterpretation or alternative path-renderer architecture is approved here. If feasibility requires one, stop with a concrete architecture proposal.

Primary review rejects treating the union of fill and stroke as one undifferentiated paint: fill-only, stroke-only and overlap regions can have different colors/alpha. Likewise, an inside-only one-pixel coverage ramp is not automatically compliant with the geometric edge/coverage contract. Both region attribution and boundary reconstruction need independent evidence before choosing a vertex format or fringe rule.

## Validation map and freeze conditions

| Contract area                             | Validation after freeze                                                                                                | Readiness now                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Line-contour membership/analytic fixtures | Focused geometry-reference unit tests with positive controls; `pnpm check` and `pnpm build`                            | Line subset frozen separately; continuous/mesh fixtures pending |
| Fill/stroke native numeric implementation | `pnpm test:geometry` extended with named native and real-WASM cases; independent continuous/region verification        | Algorithm, exact caps and stroke error proof pending            |
| Browser WASM parity                       | `pnpm test:geometry:browser` with the same frozen corpus in installed Chrome/Edge                                      | Future; no browser result claimed                               |
| Ownership/cache/lifecycle                 | Exact malformed-buffer, reserve/growth, epoch/revision, eviction/dispose fixtures through real and controlled adapters | Layout/limits pending                                           |
| Coverage/paint order/device recovery      | Frozen headed fixtures using `pnpm test:gpu`, independent expected colors/edges and preserved images                   | Public scene API and visual/composition contract pending        |

Before marking C03-C05 complete, replace every pending item with exact decisions and evidence methods, set versioned corpus/seeds/expected failures and validate feasibility. Any newly required command must be introduced and documented in its own runner checkpoint before use. Current root commands alone do not imply these future fixtures exist. No performance run or benchmark acceptance follows from this draft.
