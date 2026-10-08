# P3 private mesh contract: preparation draft

Status: PARTIAL, 2026-09-29. This is the technical owner for P3 C03-C05, not a completed implementation freeze. [Visible semantics](p3-visible-semantics-proposal.md) were approved on 2026-09-29. The independent [line-fill oracle slice](p3-line-oracle-contract.md), [triangle-mesh invariants](p3-mesh-oracle-contract.md) and [line-fill region equality](p3-fill-region-oracle-contract.md) have separate test-only contracts while remaining mesh/stroke/GPU obligations stay open. The [execution plan](p3-fill-stroke-meshes.md) owns task status, the user-directed deferral of further stroke-bound refinement and independent slice entry. No product code, private mesh ABI export or public GeometryPort is introduced here.

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

The separately frozen [P3.1d cubic boundary oracle](p3-cubic-boundary-oracle-contract.md) specifies test-only exact rational verification of the 0.125 physical-pixel curve-to-polyline share. It retains independent local knot/provenance checks and leaves P2's oracle unchanged. Positional certification does not establish curved fill topology, stroke-offset error or production cubic integration; those obligations remain open.

The [P3.1e simple cubic topology contract](p3-simple-cubic-topology-contract.md) prepares a separate restricted certificate using exact source knots, monotone projection and disjoint control hulls. Its continuous family of embedded contours preserves orientation/nesting without claiming exact curved/polygon region equality. This sufficient condition does not settle general crossings, tangencies, close hull bands or rounded-knot topology, and introduces no product rejection policy.

The [P3.2f native compatibility bridge](p3-native-cubic-bridge-contract.md) prepares test-only evidence linking actual Rust flattening, source/closure provenance and rounded mesh output under the separate1/8 and1/16 shares. Its frozen-family compatibility checks do not substitute for a native topology gate or define a production operation, cache identity or mesh ABI.

The [P3.2g native topology contract](p3-native-cubic-topology-contract.md) freezes a bounded private implementation of the P3.1e sufficient condition and a dependent test-only guard for the compatibility bridge. Its exact common-grid arithmetic adds no dependency or product rejection policy. General cubic topology and the production operation/source/transport contract remain open.

The [P3.2h workspace contract](p3-native-cubic-workspace-contract.md) prepares a private canonical-input composition of these validated helpers, replacing the test-only composition with a thin fixture adapter. Its restricted source grammar and resource caps are private preparation limits; it creates no exported operation, ABI or final product rejection envelope.

The [P3.0b-s1 regular stroke certificate](p3-stroke-boundary-certificate.md) derives a width-aware bound for raw regular offset generators, an independent second-derivative verifier and an exact counterexample to centerline-only refinement. This analytic review does not freeze machine-arithmetic guards, work limits, stationary/cusp handling or resolved-region topology. C03 remains incomplete; the next bounded numerical experiment needs those executable details specified prospectively.

The [P3.0b-s2 experiment contract](p3-stroke-numeric-experiment.md) supplies exact rational/outward arithmetic, independent interval verification, a fixed 62-case diagnostic corpus, limits and evidence rules for the next bounded experiment. Its emitted samples are rational diagnostic data, not production Float64 vertices. Experimental completion and candidate-wide feasibility are separate outcomes; no failed family or downstream gate is waived.

Coverage fringe changes sample coverage around the geometric boundary; it is not an extra allowance to move that boundary. Define geometric edge location and coverage comparisons separately. Finite but numerically unresolved topology fails explicitly, while named ordinary fixtures must succeed. The final singular-transform and GPU precision handling must stay consistent with existing scene behavior.

A connectivity change cannot be excused by a small positional bound. Finalize a distinguishable topology-ambiguity failure and exact precedence before ABI freeze; generic NUMERIC_RANGE/WORK_LIMIT is not permission to reject supported coincident edges. The geometric edge convention (including the existing P1 region-transition approach where applicable), ramp/reference, corner rule and permitted coverage/color errors are still C03/C04 blockers.

## Fill topology and independent verification

The separately frozen [P3.2e rounded line-fill contract](p3-rounded-fill-mesh-contract.md) extends the private line subset with shared monotone Float64 embedding and exact source/boundary displacement certificates. Its bounded line-contour evidence does not certify the topology of a preceding cubic flattening stage. The active plan records its integrated acceptance separately from full C03-C05.

The separately frozen [P3.2d line-fill contract](p3-line-fill-mesh-contract.md) composes exact predicates/event positions into bounded private line-contour meshes, with independent complete-region checks on 32 fixed cases. Exact representability is a private v0 restriction, not a product rejection envelope. No P2 arena/export, public mesh ABI, stroke or coverage behavior changes; full C03-C05 remain open.

The separately frozen [P3.2c event position contract](p3-fill-event-order-contract.md) compares endpoint/proper-crossing symbols exactly using bounded private signed scratch. It is independent of approximate placement and returns exact lexicographic position equality/order without source tie-breaking. It introduces no event store, rational output representation, path limits or topology acceptance. Arrangement construction and complete ordinary-corpus obligations remain separate.

The separately frozen [P3.2b intersection contract](p3-fill-intersections-contract.md) follows exact predicates with certified local Float64 point placement and exact endpoint/overlap handling. Its outward boxes and explicit Unresolved result do not establish event equality/order or connectivity. No uncertain events may be epsilon-merged, and the later topology/arc caller still owns the combined physical error allocation. This isolated private module is not a mesh operation or P2 v1 behavior change.

The separately frozen [P3.2a fill predicate contract](p3-fill-predicates-contract.md) prepares exact orientation and segment relations inside the private Rust kernel without changing P2 v1 or selecting intersection placement, event sorting, tessellation, coverage or transport. Its fixed unsigned scratch implements exact signs of Float64 inputs; it is not a new document representation, arbitrary-precision dependency or mesh arena. The active plan owns the narrowed implementation entry and P01-P06 evidence. All subsequent topology and full-corpus obligations below remain open.

Classify all contours of a path together using the explicitly selected fill rule. Nonzero uses signed winding; evenodd uses parity. Do not infer holes only from contour orientation or triangulate each contour independently. Exact coincident/reversed edges, touching vertices, T-junctions, crossings and zero-area contours are mandatory cases. Closure/degenerate behavior follows the separately approved visible-semantics decision.

The independent oracle should classify sample points by a direct ray-crossing/winding calculation on source line contours, with a separate exact-on-edge result and a fixed half-open endpoint convention. Use exact integer/rational fixtures for topology where practical; the production topology algorithm must not supply the oracle's intersections or classification. Preserve boundary samples as boundary, not arbitrary inside/outside successes. Add analytic areas and region coverage/multiplicity checks; matching a finite point grid alone cannot prove no holes or overlapping triangle interiors.

The production-algorithm feasibility review must compare a bounded arrangement/decomposition approach against simpler contour-only triangulation. Reject a contour-only choice if it cannot represent crossings/coincident edges. Record predicate uncertainty handling, intersection ordering, collinear overlap handling, memory/work complexity and deterministic ties. No third-party tessellation package is authorized. A non-accepting executable spike needs its own frozen inputs, expected membership, limits and output artifacts before execution.

A deterministic vertical-slab decomposition uses endpoint/intersection x events, groups coincident directed crossings, applies winding/parity inside each open slab and triangulates the resulting disjoint regions. P3.2d selects this algorithm only for its separately frozen bounded exact-output slice; full P3 support remains unvalidated. Pairwise intersection enumeration has quadratic per-path cost; limits cannot be frozen from the average path size. Preserve a zero-signed-area self-intersecting contour when its lobes have filled area. Robust predicates, near-degenerate intersection placement and worst-case corpus work remain feasibility obligations.

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

## User decisions on mesh position representation (2026-10-06)

After the integrated P3.1m [position certificate](p3-position-certificate-contract.md) and its [evidence](../evidence/p3.1m-position-certificate-review-2026-10-06.md), the user selected the recommended option for each decision listed in that contract.

| ID  | Decision                                                                                                                                                                                            | Consequence                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | The position obligation domain is the visible region plus a guard band, as in P1, not the whole mesh.                                                                                               | Distant offscreen vertices are outside the 1/16-pixel position obligation. Topology preservation across the guard boundary still needs its own argument, and it depends on the open clipping and raster-coverage contracts. A successor certificate must restate the domain before any runtime use. |
| U2  | Failure behavior is decided only after a separate proposal compares alternative paths.                                                                                                              | Candidates include a minimum-scale exception, sub-pixel simplification, mesh splitting and per-mesh re-anchoring. No user-visible rejection is introduced by default.                                                                                                                               |
| U3  | Meshes get a mesh-specific physical-window origin, separate from the packet origin.                                                                                                                 | P1's shared origin rule, transform counters and benchmark evidence stay unchanged. The mesh frame needs its own origin lanes. Exact lanes and rebase accounting remain C04 layout work.                                                                                                             |
| U4  | Reuse of P1's existing `render.submission-failed` numeric-preparation outcome for meshes is allowed only as a last resort, after every U2 alternative fails. No new public result variant is added. | The requirements must state which meshes can reach this outcome before any implementation depends on it.                                                                                                                                                                                            |

U2 follow-up, 2026-10-06: after the reviewed [failure-path proposal](p3-u2-failure-path-proposal.md), the user chose the planning direction R3 (tighter mesh-origin window), then R0 (clearance-aware triangulation for generator-induced slivers), then R2 (bounded-extent tiling with the U1 domain). R5 is limited to documented residual inputs. R1 (bounded region deviation) and R4 (coverage-bounded acceptance) are not opened. Classes B and C may remain uncertified until one of them is decided.

Raster coverage follow-up, 2026-10-07: after the accepted [O01 observations](../evidence/p3.1o-coverage/review-2026-10-07.md), the user made two choices.

- **Q5.** The user chose A5, the symmetric straddling ramp, as the P3 mesh antialiasing mechanism; it is recorded in the [architecture](../../ARCHITECTURE.md) companion [graphics-engine anti-aliasing section](../graphics-engine-architecture.md#anti-aliasing).
- **Q4.** P3 coverage acceptance inherits P1's thresholds:
  - interior and exterior error at most 2/255;
  - edge location within 1 px;
  - acceptance corpus axes DPR 1, 1.5 and 2, with DPR 3 as an observation only.

No numeric partial-coverage tolerance is adopted yet; it is decided after the next coverage experiment. A5's O01 interior deficit of 30/255 comes from the line-not-segment distance rule. It exceeds 2/255, so the Q3 corner and segment rule must remove it before A5 can pass.

A5 realization follow-up, 2026-10-07: these choices were made in chat, after the independent reviews of the [O02 contract](p3-o02-a5-coverage-contract.md) draft. The user accepted all three, each as the recommended option.

1. **A5 realization.** The test-only realization of A5 uses:
   - distance to boundary segments and vertices, not edge lines;
   - an outer fringe built as a triangulation of the complement within a frame, not per-edge quads;
   - an analytic ramp width instead of `fwidth`.
2. **Q3.** Screen-space distance is accepted, including circular corner isolines under nonuniform scale or shear and reflex corners.
3. **Q12.** P1's encoded-sRGB premultiplied blending applies unchanged.

This decision does not imply production adoption of the complement triangulation. Under [D8](p3-d8-parallel-tracks.md), that adoption is a user decision taken in the V3 contract.

R2 mechanism follow-up, 2026-10-07: after the accepted [T01 evidence](../evidence/p3.1p-t01/review-2026-10-07.md), the user decided D1 in chat by choosing the recommended option: **K1**, a local fixed-grid hierarchical tiling with `T_tile = 256` and exact rational Steiner references (D3(a)).

T01 found it to be the only certified candidate that does all three of the following:

- admits the three class A rows K4 fails;
- loses no row K4 admits;
- reaches M_max ≥ 40.

The cost is up to 45-66 tiles per frame at 1280 × 720.

This keeps the U2 direction as chosen (R2, tiling). Still open, and owned by the R2 contract:

- the U1 successor certificate;
- tile-seam watertightness (seam copies move independently);
- level selection and hysteresis, and the tile cache that bounds builds triggered by panning;
- clearance across tile seams;
- the exterior and complement partition;
- GPU evidence.

R2 contract follow-up, 2026-10-08: the user confirmed three decisions in chat, choosing the recommended option each time, for the [R2 tiling contract](p3-r2-tiling-contract.md), which is now FROZEN:

- **E1.** One shared vertex record per exact position per level, with a per-vertex owner-cell carrier index into a carrier table. This makes tile seams watertight by construction. It changes the C04 position direction from one carrier per mesh to a per-vertex carrier index; the layout itself stays C04 work.
- **E2.** Within an epoch, nothing is built. An epoch is fixed by the origin state, level, DPR, size, object affine and mesh revision, over a zoom band. At an epoch change, only uncached cells are built incrementally, by clipping the existing tessellation; the path is never re-tessellated. A per-level cache replaces hysteresis.
- **E3.** The Q1 coverage reference for the production carrier is the exact reference tiling. Fragment features are evaluated from the shared records, with 2Ē margins. Q4 thresholds are unchanged, and the O03 GPU evidence is re-run against it.

These decisions select directions. They do not freeze a layout, ABI, runtime check or requirement change. Each consequence still needs its own contract, independent review and evidence before implementation.

## Private transport and lifetime requirements

C04 remains open until topology, coverage and composition have a feasible representation. The [P3.1m position readiness note](p3-c04-position-readiness.md) records what the K/L evidence supports for item 2 and the gaps that must close before adoption; it adopts nothing. Freeze all of the following together before a mesh ABI or renderer packet implementation:

1. Private operation/version identity, request/result header fields, exact byte offsets/alignment/padding, lengths and terminal element offsets. Define checked arithmetic for every range and reject unknown flags/versions/reserved bytes.
2. Vertex position representation and local origin, coverage or edge-distance attributes, index width, range units, front-face/cull convention, region labels and fill/stroke ordering. Bind layout to the actual composition method; an opaque `vertices` buffer without attributes is insufficient.
3. Successful source echoes and complete output publication, per-path versus batch failure precedence, capacity sizing/retry and no partial failed-path mesh. Explicit limits for edges, intersections, output vertices/triangles, scratch/arena bytes and retries, including limit and limit+1 fixtures.
4. Per-instance reserve/view epochs, owned-copy publication, terminal idempotent disposal, new-instance isolation and stale/revision conflict behavior. If mesh and P2 operations share an arena, both invalidate each other's borrowed views, while owned results remain valid. No second hidden unaccounted arena.
5. Cache identity for all mesh-affecting inputs, explicit byte accounting, failed-result exclusion and bounded eviction. Actual stroke values require identity checking; a caller's unchecked hash cannot substitute for equality. Color/opacity changes must avoid geometry rebuild. Derived boundary data and any screen-space fringe data have distinct invalidation obligations.
6. Single-owner GPU upload/incarnation receipts, completion-safe retirement, latest-scene reconstruction, simultaneous old/new backing accounting and dispose races. Preserve existing P1/P0 allocator and generation meanings.

**D8 carve-out (2026-10-08).** Under [D8](p3-d8-parallel-tracks.md), and only for its V2 and V3 checkpoints, a mesh transport and a renderer packet may be implemented before the joint freeze of items 1-6 above, under these conditions:

- V2 is a **functional transport v0**. Its contract states, for each item 1-6 above, what v0 fixes and what it leaves open. It is not the C04 layout, it carries no position or coverage certificate, and its output is a reconstructible cache that a later C04 layout may replace without a requirement change.
- V3 is fill only, on the untiled carrier K4, as an interim. K1 with E1-E3 remains the production carrier direction; V3 does not realize E1-E3 and does not change them. Whether the O02 complement-triangulation fringe becomes the production realization of A5 is a user decision taken in the V3 contract; the 2026-10-07 acceptance of the test-only realization does not imply it.
- Every V2-V4 result is labelled UNVERIFIED against the 0.25-pixel target until the A04 corpus measurement (D8 checkpoint B4) has evidence. V2-V4 results close no A01-A08 criterion; acceptance evidence counts only after C03-C05 are complete, on the frozen layout and carrier.
- The joint freeze above still gates C04 completion, P3 A05/A06 and any certificate claim. Nothing else in this section is narrowed.

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
