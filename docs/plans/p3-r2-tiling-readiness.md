# P3.1p R2 bounded-extent and guard readiness

Status: READY, 2026-10-07, revision 2 plus confirmation fixes. Independent Astra high review: revision 1 NOT READY; revision 2 NOT READY with two one-line factual fixes, after which it is READY with no further round.

This note inventories constraints, candidates and decisions, and proposes a first experiment. It freezes no contract, adopts no mechanism and authorizes no implementation.

**Authorization.** Primary started this note under the user's U2 direction (R3, then R0, then R2). The user has not yet chosen this unit explicitly, and the active plan lists R2 clipping among the items that need user direction. D1 below is therefore a user decision.

**Purpose.** It prepares the Q10 clipping and guard contract that R2 depends on. The [O02 evidence](../evidence/p3.1o-o02/review-2026-10-07.md) supplies the coverage rule that contract builds on.

**Ownership.**

- The [private contract](p3-private-contract.md) owns C03-C05 and the user decisions.
- The [raster coverage readiness note](p3-raster-coverage-readiness.md) owns Q1, Q10 and Q11.
- The [active plan](p3-fill-stroke-meshes.md) owns status.

Stroke stays deferred.

## Question

How do meshes with large physical extent stay correct within the U1 domain (the visible region plus a guard)? This is failure class A, where far vertices make the M01 Shader term grow. Which of the choices involved are user decisions or architecture decisions?

## Inherited constraints

| Source | Constraint |
| ------ | ---------- |
| [U1](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06) | The 1/16-px position obligation covers only the visible region plus a guard. Topology across the guard boundary needs its own argument. A successor certificate must restate the domain before any runtime use. Plan unit 3: "An R2 tiling contract with the visible-plus-guard successor certificate." |
| [U2 proposal](p3-u2-failure-path-proposal.md) | U1 alone is unsound: a triangle that crosses the visible region has offscreen vertices whose rounding moves its visible edge. R2 as chosen: "split meshes on a tile grid fixed in local space and independent of the camera". Re-meshing on pan is rejected, because it contradicts P2's rule that translation does not rebuild geometry |
| [Position certificate](p3-position-certificate-contract.md) (M01) | E = Pack + Shader + Phi (Phi = 2^-40 px). Class A fails `position:0` because the **Shader** term grows with the physical magnitude of far vertices. Camera, zoom and scene data are never clamped; the lane guards define a domain only. The certificate's reference R comes from the original binary64 inputs |
| U3 and [R3](p3-r3-origin-window-contract.md) | Mesh-specific origin with O-PX(128) selected. P1's origin rule is unchanged |
| C2 ([R0a](p3-r0a-wedge-clearance-contract.md)) and the R3 window clearance | Topology clearance (vertex, edge, triangle, wedge) is required alongside position |
| U2 floors | Rasterizer subpixel snapping and the about 2^-24·W/2 NDC term are floors that no binary32 carrier removes |
| U4 | `render.submission-failed` only as a last resort |
| Private contract | Transform-only changes must avoid geometry rebuild. Cache keys include every mesh-affecting input. Fringe data has its own invalidation obligation (C04 item 5) |
| O02 (PASS) | Vertices are host-computed f32 NDC rounded once, the O01 path. **O02's evidence therefore contains no M01 Shader term, the class A cause, and its partition and G3 results do not cover the production carrier's shader error.** Its far-field clamp proof and its exemption of exterior triangles from C2 rely on "drawn mesh = reference mesh" (Q1). GPU clipping of out-of-volume vertices is implementation-defined; `clipOutside` was set on 137 of 143 rows, and G3 was clean on one machine. Frame corners are bounded by `FRAME_DEFERRED` at an NDC magnitude of 2^10 |

## Key observation

The O02 rule separates per-pixel ramp values from triangle geometry, but only partly.

1. **Ramp values (`d* < 1`).** These depend on the features and the pixel center only. The sign comes from features, not from the triangle.
2. **Role-side correctness.** The role constant applies only when `d* ≥ 1`. It is sound only if every covered sample at least 0.604 px from the reference boundary lies on the role's side.
3. **Non-inversion.** No double coverage holds while the drawn mesh stays conforming and non-inverted. Edge displacement alone does not cause overlap; inversion or fold-over does. That is a clearance condition.

Under Q1, a far vertex moves the reference boundary itself, and features follow it exactly. Under the production carrier, that displacement is dominated by the Shader term. Features are crop-relative only in the O02 test realization; production storage belongs to C04 and Q11.

## Candidate mechanisms

**K1. Local fixed-grid hierarchical tiling** (R2 as chosen). Region triangles are clipped by a power-of-two grid fixed in local space. The level is chosen per zoom bucket so that the physical extent of a tile stays at most T_tile. Each tile has its own origin.

- **Fit:** it matches the U2 direction. Camera independence within a level supports transform-only reuse per level.
- **Risks:**
  - Boundary Steiner points generally cannot be represented exactly; see D3.
  - It needs re-certification per tile, covering position and C2 clearance.
  - Grid lines near boundary vertices create slivers, which are new C2 failures.
  - At high zoom only visible tiles can be built, so tiles entering on pan are translation-triggered builds. That conflicts with P2's rule unless a tile cache bounds it.
  - Seams across tiles need features from the neighbour tile within R, plus a conforming partition.
  - Draws and uploads grow with zoom, and cache identity is per level (Q11).

**K2. Feature-decoupled boundary.** A5 features come from the exact projected boundary, not from rounded vertices.

- **Fit:** it removes far-vertex dependence from the ramp values (`d* < 1`). It reuses the O02 rule and its oracle.
- **Risks:**
  - Role assignment, list reach and non-inversion still depend on the displacement ε of the drawn triangles, which includes the Shader term. That requires clamp threshold `1 + ε`, reach `R ≥ 1.5 + ε`, lists built against the drawn triangles, and a non-inversion certificate over region and exterior triangles in the window.
  - O02's exemption of exterior triangles from C2 no longer holds.
  - Implementation-defined GPU clipping and the `FRAME_DEFERRED` bound remain.
  - K2 alone is therefore bounded by a far magnitude M_max(ε), and needs coarse bounding beyond it: coarse clipping to a local-space grid, that is, coarse K1.
  - It amends Q1 (D2), and its features must stay valid under transform-only reuse.

**K3. Per-frame CPU clipping to the screen window.** Rejected in the U2 proposal ("re-meshing on pan contradicts P2's rule that translation does not rebuild geometry").

**K4. GPU clip-space only** (status quo). Unsound per U2; it is the baseline.

**K5. f32-pair (double-float) shader transform.**

- **Fit:** it removes most of the Shader term without changing geometry.
- **Risks:**
  - The f32 NDC output rounding (about 2^-24·|x| px) and implementation-defined clipping remain, so 1/16 px is reached near 2^20 px offscreen.
  - It adds ALU cost, and it changes the vertex-shader numeric contract (P1/M01).

**K6. Whole-triangle tile assignment with interior refinement.**

- **Fit:** it bounds non-boundary triangles without clipping boundary edges.
- **Risk:** long boundary edges remain, so it only works together with K2.

**K7. Per-frame compute-shader clipping to the guard window.**

- **Fit:** it needs no CPU rebuild.
- **Risks:**
  - It is camera-dependent, and it needs indirect draws and output buffers.
  - Clipped boundary Steiner points need K2.
  - It adds new GPU pipeline architecture.

**Excluded.** Vertex-shader-only clipping is impossible, because the vertex shader has no access to the primitive. Full-window evaluation from features alone, with no mesh partition, is a path-renderer architecture change, which AGENTS.md excludes without an architecture decision.

The candidates can combine: K2 with coarse K1, K2 with K6, or K5 with K1. None is adopted.

## Open decisions

The "D" prefix avoids a clash with O02's gates G1-G3.

| ID  | Decision | Owner |
| --- | -------- | ----- |
| D1  | Mechanism, or a combination. If K2, K5 or K7 is chosen without K1, that departs from the user-chosen R2 text, so D1 revisits the U2 direction itself | User decision (U2 direction), with architecture approval |
| D2  | For K2: amend Q1 so that the exact projected boundary is the coverage reference, and define the error budget for features. This changes the basis of the user's Q4 verdict, which was measured under Q1, so O02-style evidence must be re-run | Primary contract (Q1 owner), user check advised |
| D3  | For K1, how boundary Steiner points are handled. See the options below | Per option |
| D4  | T_tile, level selection, hysteresis, the interaction with O-PX(128), and the tile cache that bounds pan-triggered builds | Primary contract |
| D5  | Guard width (Q10), and the clamp threshold and reach as functions of ε | Primary contract |
| D6  | Cache identity and invalidation (Q11), and draw and upload budgets | Primary contract, C04 |
| D7  | Evidence method | Primary contract |

**D3 options.**

| Option | Approach | Consequence | Owner |
| ------ | -------- | ----------- | ----- |
| (a) | Use the exact rational Steiner point as the certificate reference R | Rounding is charged to the 0.0625 position and storage row through a successor-certificate amendment; Q1 is unchanged | Primary contract |
| (b) | Keep an unsplit exact reference | Equivalent to D2 | Same owner as D2 |
| (c) | Charge a region deviation | The same topology-row amendment as R1 | User decision |

## Proposed first experiment (T01)

T01 is test-only, offline and exact, with no GPU. It compares K1 (with D3(a)), K2 with coarse K1, and K5. It may also include K6.

Its contract must fix the following in advance:

- **Error model.** The production carrier: M01 E including the Shader term, under the R3 O-PX(128) window. For K5 it is a stated f32-pair model. O02's host-NDC model is not used.
- **Domain.**
  - Corpus: the 143 O02-renderable variants per DPR (O01 corpus, DPR 1/1.5/2), plus the C2 fixture corpus of 158 rows (which includes the 2 class A stress rows) and the P3.1m literal rows, including EXT-65536.
  - Synthetic carriers: their zoom, DPR and magnitude ranges are derived from the M01 lane guards, not chosen ad hoc.
  - DPR 3 is observation only.
- **Parameters.** A provisional guard width, or a declared sweep, since Q10 is open. The clamp threshold and reach are expressed as functions of ε.
- **Metrics.**
  - Per candidate: admission under position, C2 and window clearance per tile or per mesh.
  - Inversion counts inside the window.
  - The boundary Steiner deviation.
  - M_max(ε).
  - Tile, draw and upload counts, and the number of pan-triggered builds on fixed trajectories.
- **Limits.** Offline exact evidence cannot certify GPU clipping of out-of-volume vertices; this is stated.
- **Decision rule.** The comparison metrics for D1 are stated before results exist, and no threshold is tuned after them.

T01 needs its own frozen contract and independent review. D1 is decided only after T01, with an alternatives comparison, as U2 was.

## Dependency order and acceptance

`O02 integrated -> this readiness reviewed -> user selects the unit -> T01 contract freeze -> T01 exact evidence -> D1 decision -> R2 contract with the successor certificate (U1 domain) -> C04 layout`.

This note passes when Primary and an independent Astra high reviewer agree on the constraints, candidates, decisions and owners, and the Markdown, link and scope checks pass. It needs no product test or GPU run.
