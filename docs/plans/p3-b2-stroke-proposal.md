# P3 B2 stroke semantics and contract proposal

Status: PROPOSAL, awaiting independent review and user approval. Drafted 2026-10-20. This is D8 checkpoint B2 ([D8](p3-d8-parallel-tracks.md#two-tracks)), full tier: it proposes a public scene field, a new geometry port, a new kernel export family and new visible behavior. It is documentation only. No code, run or record follows from it. Implementation starts only after an independent review and the user's approval of the decisions in [section 7](#7-decisions-for-the-user), followed by a frozen B2 contract (unit ST-U1).

**Evidence label.** Every stroke result that follows this proposal is functional evidence. Until B4 has A04 evidence, every report, PR description and screenshot states that precision is **UNVERIFIED** against the 0.25 physical-pixel target, as D8 [requires](p3-d8-parallel-tracks.md#rules). Stroke work closes no A01-A08 criterion and no C03-C05 item.

## 1. Authority and scope

- **D8.** B2 is "Begin stroke: a stroke semantics and contract proposal". The user deferred only stroke-bound refinement; B2 needs its own approval before implementation ([D8 Track B](p3-d8-parallel-tracks.md#two-tracks)). D8 lists B2 as full tier ([process tiers](p3-d8-parallel-tracks.md#roadmap-changes-adopted-with-d8)).
- **Resumption.** On 2026-10-20 the user resumed feature development in chat, so B2 may proceed. The user also skipped independent reviews for that day only. The status above keeps the independent review as a step; whether it is waived is the user's call.
- **The earlier deferral.** On 2026-09-29 the user deferred the tighter regular-stroke candidate bound and its follow-up numerical experiment ([execution plan](p3-fill-stroke-meshes.md#user-deferral-and-independent-p31b-entry-2026-09-29)). That decision did not resolve stationary or join behavior and did not permit coarse production output. Decision [B2-Q7](#7-decisions-for-the-user) proposes how B2 treats it.

**In scope.** Stroke semantics for paths, the precision split, a comparison of three algorithm families, kernel versus renderer placement, the operation identity and transport, renderer composition with V3, a delivery plan and the user decisions.

**Out of scope.** Dashes (section [3.5](#35-dashes)). Non-scaling strokes. Stroke outlining as an editor command and Boolean operations, which [requirements](../requirements.md#path-editing) defer. Stroke-aware hit testing, which belongs to the editor milestones ([graphics architecture](../graphics-engine-architecture.md#culling-and-hit-testing)). Gradients on strokes. P1 primitive strokes, which keep their analytic P1 contract. The K1 carrier and E1-E3. The C04 layout, which stays open.

## 2. Inputs and what each says about stroke

This proposal changes none of these texts. Where a B2 unit later amends a frozen contract, it appends a dated amendment note, as the [Alt-A1 contract](p3-alt-a1-fill-ladder-contract.md#14-documents-that-change-with-the-code) did for V2 and V3.

| Source                                                                                                                                                | What it fixes for stroke                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Requirements, path editing](../requirements.md#path-editing)                                                                                         | Butt, round and square caps; miter, round and bevel joins; open and closed subpaths. Stroke outlining is deferred                                                                                                                                                                                     |
| [Requirements, initial appearance model](../requirements.md#initial-appearance-model)                                                                 | Stroke color and width, dash pattern, stroke join and cap. No non-scaling stroke is listed                                                                                                                                                                                                            |
| [Prototype plan P3](../prototype-plan.md#p3-fill-and-stroke-meshes)                                                                                   | Caps and joins, thin strokes and extreme miter cases, zoom 1% to 6400%, the 0.25-pixel exit gate                                                                                                                                                                                                      |
| [Graphics architecture, WASM boundary](../graphics-engine-architecture.md#wasm-boundary)                                                              | Stroke tessellation for the required joins and caps is a kernel responsibility. The cache key includes a stroke-style identity                                                                                                                                                                        |
| [Graphics architecture, primitive rendering](../graphics-engine-architecture.md#primitive-rendering)                                                  | Arbitrary path fills and strokes use WASM-produced meshes                                                                                                                                                                                                                                             |
| [Approved visible semantics](p3-visible-semantics-proposal.md#approved-decision), 2026-09-29                                                          | Seams and caps, miter-limit rule with equality keeping the miter, valid values, MOVE-only and zero-length subpaths, repeated points, collinear continuation and exact reversal, solid strokes only in P3, centered local-space stroke transformed by the node affine, no constant-screen-width stroke |
| [Approved composition invariant](p3-visible-semantics-proposal.md#composition-invariant-and-technical-work)                                           | Stroke over fill, then node opacity once. Fill and stroke attribution kept separate until composition. A self-intersecting stroke is one region, with no repeated alpha                                                                                                                               |
| [P1 D2](p1-instanced-primitives.md#d2--approved-p1-visual-behavior)                                                                                   | `L = S + F·(1 − S.a)`, then `P = L·opacity`, then source-over                                                                                                                                                                                                                                         |
| [Private contract, numeric compatibility](p3-private-contract.md#numeric-compatibility-decision)                                                      | Total 0.25 physical px: 0.125 curve to fill or stroke boundary, including normal, cap and join displacement; 0.0625 topology, intersections and round arcs; 0.0625 Float32 storage and projection. Centerline closeness alone does not bound a stroke edge                                            |
| [Private contract, transport](p3-private-contract.md#private-transport-and-lifetime-requirements)                                                     | C04 items 1-6, including "actual stroke values require identity checking", and the D8 carve-out, which covers V2 and V3 only                                                                                                                                                                          |
| [P3.0b-s1 stroke certificate](p3-stroke-boundary-certificate.md#regular-leaf-sufficient-condition-in-exact-arithmetic)                                | The width-aware regular-leaf bound `sigma·(delta + 2·r·sin(alpha)) ≤ share`, the independent second-derivative verifier, the counterexample to centerline-only refinement and the open proof boundaries (stationary points, resolved-region topology, miter tips, round arcs)                         |
| [P3.0b-s2 experiment](../evidence/p3.0b-s2/README.md)                                                                                                 | Experimental completion PASS, candidate-wide feasibility PARTIAL: 50 of 59 regular cases certified at ≤ 1/8 px; nine hit the candidate node cap (R4, R5, R6 at zoom 64); three stationary probes unsupported                                                                                          |
| [V1 proposal](p3-v1-path-scene-port-proposal.md#a-path-node-in-the-scene-contract) and [ADR 0002](../decisions/0002-path-scene-and-fill-mesh-port.md) | No stroke field in V1 (V1-Q3). B2 adds a stroke field to `PathStyle` with cap, join and miter limit; `SceneStroke` is not reused. B2 adds a separate `StrokeMeshPort` or a new port version; the fill port does not grow optional stroke fields                                                       |
| [V2 identity rule](p3-v2-fill-mesh-transport-contract.md#identity)                                                                                    | An `operationId` names an operation and its budget. A change that can alter an `ok` mesh changes it                                                                                                                                                                                                   |
| [V3 contract](p3-v3-renderer-mesh-pipeline-contract.md#scope)                                                                                         | Fill only; stroke composition waits for B2. Cache key, tolerance and fringe buckets, A5 coverage on K4, mesh packet part, paint order, D8-interim failure outcome                                                                                                                                     |
| [Alt-A1 contract](p3-alt-a1-fill-ladder-contract.md#31-rungs-and-stages)                                                                              | The fill ladder: a fast rung that certifies a simple polygon set, then V2's exact cascade. It makes no claim on stroke (AL-OB2)                                                                                                                                                                       |
| `cubic_fill.rs` and `FILL_V0_LIMITS` in `fill_export.rs`                                                                                              | Fill caps: 24 source verbs, 16 source segments, 4 contours, 68 contour points; `RoundedFillLimits` with 4 contours, 64 input vertices and 64 edges                                                                                                                                                    |

## 3. Semantics

### 3.1 The stroke region

For one path with stroke width `w ≥ 0` and half-width `r = w/2`, all in node-local units, the stroke region is the union of the following closed sets. Each set is defined per subpath, after the approved rule that exact zero-length edges are ignored when finding tangents.

1. **Segment sweeps.** For each drawing segment with parameter `t`, the union over regular `t` of the normal segments `[C(t) − r·N(t), C(t) + r·N(t)]`, where `N` is the unit left normal of `C'(t)`. For a line this is the rectangle of the segment. A collinear forward continuation adds nothing, as approved.
2. **Joins.** At each source join (the point between two drawing segments, and the CLOSE seam), a join region built from the incoming and outgoing one-sided unit tangents, per section [3.3](#33-joins-and-miter-limit).
3. **Caps.** At each end of an open subpath, a cap region per section [3.4](#34-caps).
4. **Interior stationary points of a cubic**, per decision [B2-Q2](#7-decisions-for-the-user).

The fill's implicit closing edge is never part of the stroke, and the fill rule does not affect the stroke region, as approved. Because the region is a union, an overlap of pieces is covered once: the approved invariant that self-intersecting pieces do not accumulate alpha is a property of this definition, and each algorithm in section 4 must preserve it.

Generated subdivision knots inside a source segment are not joins. The [P3.0b-s1 note](p3-stroke-boundary-certificate.md#regular-leaf-sufficient-condition-in-exact-arithmetic) states this, and it is binding here: a user join at a generated knot would change the stroke.

### 3.2 Width

As approved: finite and `≥ 0`; width 0 produces no stroke; negative or nonfinite width fails. In the scene, a failing value is `invalid-value` for the transaction, as V1's validation table treats other invalid path data. A path with width 0 makes no stroke port call. There is no minimum width; decision [B2-Q3](#7-decisions-for-the-user) proposes to keep it so.

### 3.3 Joins and miter limit

- **Bevel.** The triangle between the join point and the two outer offset points, on the outer side of the turn.
- **Round.** The disk of radius `r` at the join point. Only its outer sector adds area; the definition uses the whole disk for simplicity.
- **Miter.** The bevel plus the triangle to the miter tip, when the approved test keeps the miter; otherwise the bevel.
- **Miter test.** As approved: miter iff (distance from join point to tip) / r ≤ miterLimit, equality keeping the miter. With unit tangents of dot `d`, the ratio is `sqrt(2/(1+d))`, so miter iff `2 ≤ miterLimit²·(1 + d)` ([P3.0b-s1 proof boundaries](p3-stroke-boundary-certificate.md#proof-boundaries-and-next-numerical-checkpoint)). For Float64 direction vectors `u` and `v` that are not unit, the test is `miterLimit²·(u·v) ≥ (2 − miterLimit²)·|u|·|v|`. The kernel decides it with an exact predicate on the Float64 inputs (sign cases, then squared comparison in exact arithmetic), never with an epsilon. An undecidable rounding case does not arise because the inputs are exact dyadic values.
- **Exact reversal.** As approved: miter falls back to bevel; bevel is the union of the two segment rectangles; round adds the disk once.
- **Miter limit validity.** As approved: finite and `≥ 1`, required for every join kind, because the approved rows add no public defaults.

### 3.4 Caps

- **Butt.** No region beyond the segment end.
- **Square.** The rectangle of length `r` beyond the end, along the one-sided end tangent, and width `w`.
- **Round.** The disk of radius `r` at the end point.
- **All-zero-length open subpath.** As approved: butt empty, round a disk, square a local-axis-aligned square of side `w`. MOVE-only is empty; a fully collapsed closed subpath is empty.

### 3.5 Dashes

Out of scope for P3, as the approved semantics state ("P3 implements solid strokes only"). The requirement for a dash pattern stays in the [appearance model](../requirements.md#initial-appearance-model) and moves to the later appearance plan with its units and phase. The approved rule "reject unsupported dash intent once a path API is proposed" is met by decision [B2-Q5](#7-decisions-for-the-user): either the field does not exist, so no intent can be expressed, or it exists and a non-null value is rejected.

### 3.6 Coordinate space and zoom

Strokes are **scaling**: the stroke region is defined in node-local units and mapped by the node's world affine, the camera and the DPR, as the approved semantics and P1's local-space strokes require. A non-uniform or sheared world map therefore makes the screen-space stroke width vary with direction. Zoom changes the screen width of a stroke proportionally. Non-scaling (constant screen width) strokes are not in the requirements and are out of scope; adding them later would make the stroke region depend on the camera, which changes the cache identity, and needs its own requirement.

A singular world linear map draws nothing, including the stroke, as P1 D2 and V3 section c fix for fills.

### 3.7 Degenerate cases

| Case                                                        | Output                                                                                                                                        | Owner                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Width 0                                                     | No stroke, no port call                                                                                                                       | Approved                                            |
| MOVE-only subpath; fully collapsed closed subpath           | Empty                                                                                                                                         | Approved                                            |
| Open subpath whose segments are all zero length             | Butt empty, round disk, square local-axis square                                                                                              | Approved                                            |
| Repeated points                                             | Ignored for tangents; same region as without them                                                                                             | Approved                                            |
| Collinear continuation; exact reversal at a source join     | No join region; bevel fallback and the round disk                                                                                             | Approved                                            |
| Cubic with a stationary endpoint (`P0 = P1`, or more)       | The one-sided tangent is the direction of the first nonzero derivative at that end (`P2 − P0`, else `P3 − P0`); the end is then a regular end | New, Primary: it is the limit tangent, no new shape |
| Cubic whose controls are all equal                          | A zero-length segment; treated as the approved zero-length row                                                                                | New, Primary                                        |
| Interior stationary point of a cubic (cusp or continuation) | Decision [B2-Q2](#7-decisions-for-the-user)                                                                                                   | User                                                |
| Regular near-reversal                                       | Refined as a regular curve; never snapped to a reversal by an epsilon, as P3.0b-s1 requires. Work beyond the stroke caps is `work-limit`      | P3.0b-s1                                            |
| Curvature radius below `r` (inner offset folds back)        | The union definition of section 3.1 covers it; the fold is interior to the region                                                             | Section 3.1                                         |
| Stroke thinner than a physical pixel                        | Decision [B2-Q3](#7-decisions-for-the-user)                                                                                                   | User                                                |
| Path with `fill: null` and a stroke                         | Stroke only                                                                                                                                   | Section 5.6                                         |

A cubic interior stationary point is either an exact reversal (the derivative changes sign through a simple zero) or a continuation (a zero of even order); the B2 contract fixes how the kernel isolates it with exact arithmetic on the Float64 controls, as P3.0b-s1 requires.

### 3.8 Composition with fill

Unchanged from the approved invariant: `L = S + F·(1 − S.a)`, `P = L·opacity`, source-over. Fill and stroke stay separately attributed until that composition. Section [5.6](#56-renderer-composition-with-v3) shows which draw schemes satisfy it exactly, and decision [B2-Q6](#7-decisions-for-the-user) proposes the order in which they land.

### 3.9 Precision obligations

The total stays 0.25 physical px with the private contract's three rows. Inside them, the stroke operation uses this split. Choosing a split inside an existing row is an ordinary technical decision ([private contract](p3-private-contract.md#numeric-compatibility-decision)); it changes no threshold.

| Private-contract row        |  Share | Stroke use                                                                                                                                                                    |
| --------------------------- | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Curve to intended boundary  |  0.125 | Offset chords of segment sweeps, by the P3.0b-s1 bound `delta + 2·r·sin(alpha) + g ≤ 2^e` local; `g` includes endpoint normal evaluation and the miter-tip construction error |
| Topology and round arcs     | 0.0625 | Round joins and caps as inscribed polygons with sagitta ≤ 2^(e−2) local (1/32 px); arrangement rounding at 2^(e−2) local (1/32 px)                                            |
| Float32 storage, projection | 0.0625 | Unchanged; V3's packing                                                                                                                                                       |

- `e` is V3's tolerance bucket, `2^e·sigmaMax(S) ≤ 0.125` ([V3 section c](p3-v3-renderer-mesh-pipeline-contract.md#c-tolerance-and-fringe-buckets)). A local bound of `2^e` therefore maps to at most 0.125 physical px under any direction of a non-uniform map.
- The fill export uses 2^(e−1) for its topology rounding ([V2 section d](p3-v2-fill-mesh-transport-contract.md#d-tolerance)), the whole 0.0625 row, because a fill has no arcs. A stroke shares that row with arcs, so it rounds at 2^(e−2). The fill export is unchanged.
- **Miter tips.** A tip lies at up to `miterLimit·r` from its join point, so error in the tangents is amplified by up to `miterLimit`. The construction must bound the tip error inside `g`; a tip whose bound does not fit fails `numeric-range`, never a silent bevel.
- **Region, not only position.** As P3.0b-s1 states, a positional bound on raw offsets does not prove the resolved region. The arrangement in section 4 resolves the region exactly from the emitted polygon set, so the remaining obligation is that the polygon set lies within the curve share of the ideal pieces, piece by piece. Since a union of sets each within Hausdorff distance `h` of its ideal set lies within `h` of the ideal union, the per-piece bound carries to the region.
- **Evidence method.** Under D8, A04 is evidenced by measurement on a frozen corpus against an independent oracle; a certificate is optional ([D8](p3-d8-parallel-tracks.md#roadmap-changes-adopted-with-d8)). Decision [B2-Q7](#7-decisions-for-the-user) proposes using that method for stroke.

## 4. Candidate algorithms

### 4.1 The three families

**A. Outline to fill, as a polygon set.** The kernel emits each piece of section 3.1 as a positively oriented simple polygon: per regular cubic leaf, the band `O+(t0), O+(t1), O−(t1), O−(t0)` with shared canonical endpoint samples (P3.0b-s1); per line segment, its rectangle; per join, its bevel, miter or polygonal disk; per cap, its rectangle or polygonal disk. Adjacent bands share an exact edge, so there is no gap at a knot. The kernel then resolves the union with V2's exact arrangement (the `RoundedFillWorkspace` path used by line-only fills) under the nonzero rule. With every piece positive and simple, the winding number is at least 1 exactly inside some piece, so nonzero gives the union. The result is a conforming region mesh with `boundaryEdges`, the same shape the V3 pipeline consumes.

**B. Direct stroke tessellation.** The kernel emits triangles for each piece (two per band, a fan per join or cap) and resolves overlap locally, for example by clipping the two inner offset sides at an inner join. It is fast and simple. Without a global argument, distant pieces of one stroke can still overlap (a loop, a tight curve, a self-crossing path), which would blend alpha twice and give V3 no region boundary for its fringe. B is sound only with a certificate that the emitted triangles are interior-disjoint, as the Alt-A1 fast rung certifies a fill polygon. Paths the certificate cannot prove fall back to A.

**C. GPU analytic.** The renderer draws coarse hulls and the fragment shader evaluates distance to the centerline (a degree-5 problem for a cubic), joins and caps. It needs no retessellation on zoom. To avoid double blending each pixel must evaluate the union over all nearby segments, which needs per-tile segment lists: a new path-renderer architecture. It also moves stroke geometry out of the kernel.

### 4.2 Comparison

| Criterion                             | A. Outline to fill (polygon set)                                                                                        | B. Direct tessellation                                                       | C. GPU analytic                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Union semantics (no repeated alpha)   | Exact: the arrangement resolves the union                                                                               | Only with a non-overlap certificate; otherwise wrong                         | Only with per-pixel union over all segments (tile lists)                                                           |
| V3 reuse (A5 fringe, `boundaryEdges`) | Full: same mesh shape, fringe builder unchanged                                                                         | Full when certified (conforming by construction, boundary = edges used once) | None: a new pipeline and coverage rule                                                                             |
| Precision argument                    | P3.0b-s1 per piece, plus the exact arrangement; union carries Hausdorff bounds (section 3.9)                            | Same per-piece bound, plus the certificate                                   | Float32 distance evaluation at zoom 64 and DPR 3, unproved; the 0.0625 GPU share would carry the whole curve error |
| Kernel reuse                          | Exact arrangement, predicates, rounding, conforming refinement, boundary scan                                           | Alt-A1 style certificate machinery; new triangulation of pieces              | None                                                                                                               |
| Cost                                  | High: every stroke has many touching pieces, so the exact arrangement always runs. Exact arithmetic is B0's cost driver | Low on certified paths                                                       | Low CPU, high fragment cost                                                                                        |
| Caps                                  | `FILL_V0_LIMITS` cannot hold a three-segment polyline (five pieces > four contours); needs its own stroke limits        | Its own limits                                                               | None in the kernel                                                                                                 |
| Architecture                          | Within ADR 0002 and the graphics architecture                                                                           | Within them                                                                  | Contradicts "path fills and strokes use WASM-produced meshes"; needs an ADR and approval under `AGENTS.md`         |

### 4.3 Can the stroke outline reuse the fill ladder?

- **The exact rung, yes.** V2's exact line arrangement accepts the polygon set as LINE contours, handles crossings and coincident edges with winding, and returns a conforming mesh with `boundaryEdges`. The offset geometry is already flattened by the stroke front end, so the arrangement sees a line-only input. Two parameters differ from fill: the topology rounding tolerance (2^(e−2), section 3.9) and the limits. The arrangement code itself stays unchanged; the stroke engine passes its own `RoundedFillLimits`.
- **The fast rung, no, not on the raw pieces.** Rung 0 requires a simple polygon set with a clearance above 2δ between non-consecutive edges ([Alt-A1 stages](p3-alt-a1-fill-ladder-contract.md#31-rungs-and-stages)). Adjacent pieces share edges by construction, so FR5 returns `CROSSING` or `CLEARANCE` on every stroke with more than one piece. A single resolved outline could pass, but computing it is the union problem itself.
- **A stroke fast rung, later.** Family B with a non-overlap certificate is the stroke analog of rung 0, with A as its fallback and test oracle. It is worth building only if measurement shows A too slow (decision [B2-Q8](#7-decisions-for-the-user)).

### 4.4 Recommendation

Family A as the production baseline and oracle, with B added later as a certified fast rung if measurement asks for it, in the same ladder pattern as Alt-A1. C is not recommended: it contradicts the accepted architecture and moves the precision burden to the least-proved stage. This is decision [B2-Q1](#7-decisions-for-the-user).

## 5. Placement and identity

### 5.1 Kernel versus renderer

The stroke region is built in the kernel (`geometry-wasm`, Rust), as the [graphics architecture](../graphics-engine-architecture.md#wasm-boundary) assigns stroke tessellation and as ARCHITECTURE.md's [geometry contract](../../ARCHITECTURE.md#geometry-contract) assigns tessellation. `renderer-core` requests stroke meshes through a port, caches them, builds their fringes and packs them. `renderer-webgpu` draws them with V3's mesh pipeline. The dependency direction of ADR 0002 is unchanged: contracts define the port, `geometry-wasm` implements it, the host injects it, and `renderer-core` still imports contracts only.

### 5.2 Scene contract

Sketch for decision [B2-Q4](#7-decisions-for-the-user); ST-U6 lands it.

```ts
export type SceneStrokeCap = 'butt' | 'round' | 'square';
export type SceneStrokeJoin = 'miter' | 'round' | 'bevel';
export type PathStroke = Readonly<{
  color: SceneColor;
  /** Node-local units, finite, >= 0. */
  width: number;
  cap: SceneStrokeCap;
  join: SceneStrokeJoin;
  /** Finite, >= 1, required for every join. */
  miterLimit: number;
}>;
export type PathStyle = Readonly<{ fill: SceneColor | null; stroke: PathStroke | null }>;
```

- `stroke` is required and explicitly `null` when absent, as P1 requires for primitives ("missing fill/stroke is explicitly null"). This is a breaking change to V3's `PathStyle`; the playground and tests update in the same unit.
- Validation adds rows to V1's table: an unknown cap or join, a nonfinite or negative width, a nonfinite miter limit or one below 1 is `invalid-value`. A path with a non-null stroke of positive width while no stroke port is injected is `unsupported-feature`, mirroring V1's fill row.
- Replay equality includes every stroke field. Color does not affect the mesh; width, cap, join and miter limit do, so they enter the stroke cache key (section 5.5). The mirror compares them exactly; no caller hash is trusted ([C04 item 5](p3-private-contract.md#private-transport-and-lifetime-requirements)).
- `SceneStroke` (primitive strokes) is unchanged.

### 5.3 Port

V1 leaves the choice open between a separate `StrokeMeshPort` and a new port version, and rules out optional stroke fields on the fill port ([V1 section b](p3-v1-path-scene-port-proposal.md#b-fill-mesh-port-in-packagescontracts)). This proposal takes the separate port, a Primary decision: it leaves `FillMeshPort` v0, its conformance suite and its cache keys untouched, and a host can inject fill without stroke.

```ts
export interface StrokeMeshRequest {
  readonly requestId: number;
  readonly verbs: Uint8Array;
  readonly points: Float64Array;
  readonly width: number;
  readonly cap: 'butt' | 'round' | 'square';
  readonly join: 'miter' | 'round' | 'bevel';
  readonly miterLimit: number;
  /** The same integer e as V3's fill bucket; curve share 2^e local. */
  readonly toleranceExponent: number;
}

/** Same shape and meaning as FillMesh (V1 rule 5), for the stroke region. */
export type StrokeMesh = FillMesh;

export type StrokeMeshFailureCode = FillMeshFailureCode | 'invalid-stroke';

export interface StrokeMeshPort {
  readonly portVersion: 0;
  /** For example 'geometry-wasm/stroke-v0'. */
  readonly operationId: string;
  buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult;
}
```

The result and batch types mirror V1's, with `status: 'ok' | 'empty' | 'failed'` per path and `batch-failed` for the batch. V1 rules 1-8 apply unchanged, with the region of rule 5 being section 3.1's stroke region. `invalid-stroke` is a per-path failure for stroke values that pass the batch-framing checks but fail section 3.2-3.3 validity; the renderer never sends one, because scene validation rejects them first.

### 5.4 Kernel export family

A new family `stroke_v0_*` beside `fill_v0_*` and P2 ABI v1, with its own magics, transport version 0, revision 1 and a module-level `StrokeEngine` that shares no field, epoch, arena or workspace with `FillEngine` or the P2 `Engine`. This mirrors [V2 section b](p3-v2-fill-mesh-transport-contract.md#b-instance-and-arena-c04-item-4) and keeps the two families' identity and lifetime evidence independent. The stroke engine reuses the arrangement's types with its own `STROKE_V0_LIMITS`. Exact framing, status mapping, precedence, limits and the C04 item table are fixed in the frozen B2 contract (ST-U1), following V2's structure. Extending `fill_v0` framing instead would change its transport version and its frozen conformance evidence for no gain.

The alternative of a fill port version 1 that takes an optional stroke would carry two operations behind one `operationId` and one cache key, so a stroke change would invalidate fill meshes. It is not proposed.

### 5.5 Operation identity and cache key

- `operationId` `'geometry-wasm/stroke-v0'`, kernel revision 1. V2's identity rule applies: a change that can alter an `ok` stroke mesh changes both.
- Stroke cache key: `(portVersion, operationId, nodeId, geometryRevision, width, cap, join, miterLimit, toleranceExponent)`. The fill key is unchanged. A stroke color change, an opacity change or a fill change builds no stroke mesh.
- V3's reuse rule (a finer entry within two levels serves a coarser request) and its failure memo apply per key, unchanged in meaning.

### 5.6 Renderer composition with V3

- **Draws.** A stroked path emits up to two mesh draws at the same `position` in V3's packet: fill first, then stroke. V3 already keeps array order for equal positions ([V3 section f](p3-v3-renderer-mesh-pipeline-contract.md#f-the-mesh-packet-part-and-the-mesh-draw)). The stroke draw uses V3's pipeline, coverage rule and fringe builder unchanged, because a stroke mesh has the fill mesh's shape. Its instance record carries the stroke color; the B2 contract fixes whether a path slot gets a second record or a widened one.
- **Exactness of two draws.** For premultiplied coverage-adjusted `F` and `S`, drawing `F` then `S` with source-over gives `S + F·(1 − S.a) + D·(1 − F.a)·(1 − S.a)`, which equals `L + D·(1 − L.a)`. So two draws are exact when node opacity is 1, for any fill and stroke alpha, and a stroke-only or fill-only path is exact at any opacity, because each region mesh is resolved. With opacity `o < 1` and both paints, two draws of `o·F` and `o·S` apply opacity twice in the overlap, which the approved invariant excludes.
- **Opacity below 1 with both paints.** One exact scheme keeps two draws: the stroke draw outputs `o·S'`, and the fill draw outputs `o·F'·(1 − S'.a)/(1 − o·S'.a)`, with `F' = F·c_F` and `S' = S·c_S`; this reproduces `P + D·(1 − P.a)` exactly. It needs the stroke coverage `c_S` in the fill draw, so fill triangles need stroke feature lists and roles: an overlay of the two meshes. That is unit ST-U7. Decision [B2-Q6](#7-decisions-for-the-user) proposes landing it after the first stroke draws, with the uncovered case reported as a D8-interim failure meanwhile.
- **Culling bounds.** A stroked path's conservative world bounds are the box of its points expanded by `r·k` in local units before mapping, with `k = max(1, miterLimit if join = 'miter', sqrt(2) if cap = 'square')`, rounded outward. A miter tip lies within `miterLimit·r` of its join point and a square-cap corner within `sqrt(2)·r` of its end.
- **Failures.** Stroke failures reuse V3's D8-interim notice with a new context key `paint: 'fill' | 'stroke'` and the stroke failure codes. That is an amendment to V3 section h, appended in the unit that lands it.
- **Device loss** rebuilds stroke GPU data from cached CPU meshes, as V3 section i does for fills.

### 5.7 Documents that change with the code

| Document                               | Change                                                                                                                       | Unit         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `ARCHITECTURE.md`                      | The V1 paragraph: the port family gains `StrokeMeshPort`; "fill only until stroke has its own approved contract" is replaced | ST-U5        |
| `docs/decisions/0002-*.md`             | None: ADR 0002 already says stroke gets its own port after B2. A dated note links the B2 contract                            | ST-U5        |
| `docs/graphics-engine-architecture.md` | A short paragraph on the stroke operation beside the fill operation paragraph                                                | ST-U5        |
| V2 and V3 contracts                    | Dated amendment notes only (section h context key; draw order with stroke)                                                   | ST-U6, ST-U7 |
| `docs/plans/p3-fill-stroke-meshes.md`  | B2 status, unit entries and evidence                                                                                         | Every unit   |
| `docs/requirements.md`                 | None, unless the user's answers to B2-Q2 or B2-Q3 are recorded there; the visible rows go into the B2 contract               | ST-U1        |

## 6. Delivery plan

### 6.1 Units

| Unit  | Tier  | Content                                                                                                                                                                                                | Needs         |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| ST-U1 | Full  | The frozen B2 contract: the approved decisions, the export framing, limits, status mapping, fixtures and oracles, the C04 item table for stroke. Independent review READY and user approval            | This proposal |
| ST-U2 | Light | Test-only independent stroke-region oracle in `geometry-reference`: exact membership for line strokes and approved rows, interval verification for cubic sweeps (P3.0b-s1 verifier), positive controls | ST-U1         |
| ST-U3 | Light | Kernel front end for line-only strokes: pieces, joins, caps, zero-length rows, exact miter predicate, polygon set into the arrangement with `STROKE_V0_LIMITS`; native tests against ST-U2's fixtures  | ST-U1         |
| ST-U4 | Light | Cubic offset generator: Float64 regular-leaf bound with guards, stationary isolation and B2-Q2's rule, work limits; native tests including the s2 families                                             | ST-U3         |
| ST-U5 | Full  | `stroke_v0_*` export, `createStrokeMeshPort` adapter, `StrokeMeshPort` types, boundary checker, a stroke conformance suite, and the documents of section 5.7                                           | ST-U3         |
| ST-U6 | Full  | Scene `PathStroke`, renderer-core stroke cache and batch, the stroke draw after the fill draw, culling bounds, notices; exact for opacity 1 and single-paint paths                                     | ST-U5         |
| ST-U7 | Full  | The joint-coverage fill draw for opacity below 1 with both paints (section 5.6)                                                                                                                        | ST-U6         |
| ST-U8 | Light | Playground stroke page with headed screenshots (UNVERIFIED label); stroke rows proposed for the B4 corpus                                                                                              | ST-U6, V4     |
| ST-U9 | Full  | Conditional: a certified stroke fast rung (family B), only if B2-Q8's probe shows the need                                                                                                             | ST-U4, probe  |

ST-U3 and ST-U4 are kernel internals behind no export, so they are light tier; the export, the port and the scene are full tier, as D8's tiers fix. ST-U3 gives a visible line-stroke result early once ST-U5 and ST-U6 land on top of it; ST-U4 can follow without changing the port.

### 6.2 Acceptance criteria

Fixed now in outline; ST-U1 freezes the exact fixtures and counts.

- **ST-A1, semantics.** Every approved visible row with a stroke component (seams, caps, miter limit including the equality fixture at `5/4`, valid values, MOVE-only, zero-length, repeated points, reversal) has a fixture whose kernel region equals ST-U2's exact expected region.
- **ST-A2, union.** Self-overlapping strokes (a loop, a figure eight, a tight curve with `r` above the curvature radius) produce a conforming mesh with interior-disjoint triangles and area equal to the oracle's union area; no triangle overlap is accepted.
- **ST-A3, curve share.** On the s2 families R1-R6 at zoom 0.01/1/64 and DPR 1/2/3, every `ok` stroke mesh lies within 0.125 physical px of the oracle's ideal pieces before arrangement rounding, by ST-U2's independent verifier. A case that does not finish within the stroke limits is `work-limit` and is listed, never accepted coarse.
- **ST-A4, joins and tips.** The miter predicate is exact on the equality fixture and on its Float64 neighbours; miter tips at `miterLimit` 1, `sqrt(2)`, 4 and 100 stay within the curve share or fail `numeric-range`.
- **ST-A5, transport.** V2's framing, capacity, epoch, dispose and limit-and-limit-plus-one obligations hold for `stroke_v0_*`, with P2 identity (`pnpm test:p2-identity`) and fill conformance unchanged.
- **ST-A6, port.** The stroke conformance suite passes on the real adapter and on a test double, including `boundaryEdges` against the region boundary.
- **ST-A7, renderer.** Paint order, the two-draw composition at opacity 1, single-paint paths at opacity 0.5, culling bounds and notices match their fixtures; the stroke-over-fill example of the approved semantics (red fill, blue stroke, opacity 0.5, overlap `(0, 0, 0.5, 0.5)`) passes after ST-U7, and before it the path reports the interim failure if B2-Q6 (a) is chosen.
- **ST-A8, labels.** Every report and screenshot carries the UNVERIFIED label; no A01-A08 criterion is closed.

### 6.3 Evidence plan

- **Native and WASM.** `pnpm test:geometry` extended with stroke fixtures, the oracle comparison and limit fixtures; real-WASM conformance through the adapter.
- **Unit and boundary.** `pnpm test:unit` for scene validation, cache keys and composition; `pnpm check` for the boundary checker.
- **Headed.** `pnpm test:gpu` stroke fixtures, and the playground screenshots of ST-U8, labelled UNVERIFIED.
- **Precision.** A04 for strokes by B4's method: stroke rows in the frozen corpus (thin strokes, extreme miters, wide strokes on curves, zoom 0.01/1/64, DPR 1/2/3) against ST-U2's oracle. This proposal does not define B4; it asks B4 to include those rows.
- **Performance.** No claim. B2-Q8's probe is a native scaling observation, reported without a threshold; any later performance claim needs a committed result under [`docs/benchmarks/README.md`](../benchmarks/README.md).

### 6.4 Risks

- **Cost of the exact arrangement.** Every stroke takes the exact path, and B0 found exact arithmetic to be the fill cost driver. A 32-cubic stroke may produce hundreds of pieces. The roadmap workload with strokes may be infeasible on family A alone; ST-U9 is the planned answer, gated by measurement.
- **Limits.** `STROKE_V0_LIMITS` must be far above the fill caps (`max_pairs` grows quadratically with edges). A stroke beyond them is `work-limit`, visible as an interim failure. B1's fill-cap work does not raise stroke limits.
- **Work near cusps and at high zoom.** s2's nine candidate-cap outcomes (wide strokes, inflections, near reversals at zoom 64) show that the conservative cone bound can need many leaves. ST-U4 may need the deferred tighter bound after all; B2-Q7 keeps that decision open behind evidence.
- **Thin strokes and A5.** O02's coverage rule was measured on fills; its behavior on regions narrower than a pixel is untested. ST-U8 and B4 must include sub-pixel strokes.
- **Overlay for ST-U7.** The joint-coverage draw needs stroke feature lists in fill triangles. Its fringe builder cost adds to V4's builder-cost gate.
- **Fill and stroke seams.** A fill boundary and the stroke center coincide; the fill draw's fringe extends under the stroke. With opacity 1 the stroke covers it exactly; under ST-U7 the joint rule handles it.

### 6.5 Open obligations carried

- P3.0b-s1's proof boundaries other than those this proposal assigns: resolved-region topology is discharged by the exact arrangement; stationary handling by ST-U4 and B2-Q2; miter tips by section 3.9; round arcs by section 3.9's 1/32 share.
- C04 items 1-6 stay open; the stroke transport is a functional v0 only if the user extends the D8 carve-out to B2 (B2-Q9), because the existing carve-out names V2 and V3 only.
- A04 for strokes, through B4.

## 7. Decisions for the user

Each question lists the recommended option first, as (a).

| Id    | Question                                     | (a) Recommended                                                                                                                                                                                                                                               | Alternatives                                                                                                                                                                                                            |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2-Q1 | Algorithm direction                          | Family A, outline to fill as a polygon set through the exact arrangement, as the baseline and oracle; a certified direct-tessellation fast rung (B) later only if measurement needs it                                                                        | (b) Family B only, with a non-overlap certificate and failure otherwise: faster, but many ordinary strokes would fail. (c) Family C, GPU analytic: needs a new architecture decision and moves stroke out of the kernel |
| B2-Q2 | Interior stationary point of a cubic         | Limit-consistent: at an interior reversal (cusp), add the disk of radius `w/2`, which is the limit of the regular sweep as a curve approaches the cusp; at a continuation, add nothing; no user join at either                                                | (b) Pure normal sweep: a flat tip at a cusp, discontinuous with nearby regular curves. (c) Apply the user's join at a cusp: treats a generated point as a source join, which P3.0b-s1 rejects                           |
| B2-Q3 | Strokes thinner than a pixel                 | Exact local geometry with no minimum width; coverage by A5; thin strokes fade with their area                                                                                                                                                                 | (b) A minimum physical width (hairline): a new, camera-dependent visible behavior that conflicts with the approved local-space stroke and changes cache identity                                                        |
| B2-Q4 | Scene shape                                  | `PathStyle.stroke: PathStroke \| null`, required and explicit null, with color, width, cap, join and miterLimit; the geometric fields are compared exactly for the cache                                                                                      | (b) Split: stroke width, cap, join and limit on the geometry, stroke color on the style. Mirrors `fillRule`, but scatters one appearance value across two objects                                                       |
| B2-Q5 | Dash in P3                                   | No dash field in P3; the later appearance plan adds one with units and phase                                                                                                                                                                                  | (b) Reserve `dash: readonly number[] \| null` now and reject non-null with `unsupported-feature`; fixes a field shape before its semantics, as V1-Q3 declined for stroke                                                |
| B2-Q6 | Fill plus stroke under node opacity below 1  | Staged: ST-U6 ships two exact draws for opacity 1 and single-paint paths; a path with both paints at opacity below 1 is a D8-interim failure (not drawn, notice emitted) until ST-U7                                                                          | (b) Build ST-U7 before any stroke draw ships: no interim gap, but later visible stroke. (c) Offscreen isolation per path: an architecture change the private contract does not approve                                  |
| B2-Q7 | Precision method and the deferred refinement | Float64 regular-leaf bound with guards in production; A04 evidence by B4's measurement (D8); the deferred tighter bound stays deferred unless ST-U4's work limits or B4's measurement show the need                                                           | (b) Resume the exact rational certificate line (s3) before ST-U4: stronger evidence, but it reopens the precision iteration the user deferred                                                                           |
| B2-Q8 | Performance gate                             | A native scaling probe on line strokes after ST-U3, within the stroke limits, reported to the user with a recommendation on ST-U9; no threshold                                                                                                               | (b) A full benchmark contract with a decision rule before ST-U3, as B0 had: earlier certainty, more contract work before any visible stroke                                                                             |
| B2-Q9 | C04 for the stroke transport                 | Extend the D8 [C04 carve-out](p3-private-contract.md#private-transport-and-lifetime-requirements) to B2: `stroke_v0` is a functional transport v0 and the stroke draw a functional packet, both disposable and UNVERIFIED, with a per-item C04 table in ST-U1 | (b) Freeze C04 items 1-6 jointly before any stroke transport, as the private contract requires outside the carve-out: no visible stroke until the C04 layout exists                                                     |

Primary technical decisions stated above, not asked: the separate `StrokeMeshPort` (section 5.3), the separate `stroke_v0_*` family and engine (section 5.4), the stroke precision split inside the existing rows (section 3.9), the endpoint-stationary tangent rule (section 3.7) and the culling bound (section 5.6).

## 8. Review and approval record

- 2026-10-20: drafted by a Primary-delegated agent on branch `claude/p3-b2-stroke-proposal`. Independent review: not yet run. User approval: pending.
