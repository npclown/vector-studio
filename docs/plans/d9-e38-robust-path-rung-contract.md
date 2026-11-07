# D9 E38: a robust last rung so pen paths always draw

Status: **DONE 2026-11-07** (merged #530 `a6c28fb`; headed run PASS after the spec re-baseline). Adopted 2026-11-07 (recommended option auto-adopted under the user's standing instruction of 2026-10-24; the user's thread of 2026-11-07 on node-5). Identity: `geometry-wasm/fill-v0+r6`, `geometry-wasm/stroke-v0+r9`. Evidence: [E38 record](../evidence/e38-robust-path-rung-2026-11-07.md).

This is rendering-track item E38 ([D9 rendering track](d9-rendering-track.md#status-index)). The user asked on 2026-11-07 for the cause of their vanishing pen paths to be found and fixed for good, after four piecemeal fixes (#520, #522, #524, #528). The goal, as the coordinator read it: **any path drawn with the pen tool (large, with sharp turns, self-crossing, with short handles) always draws, both its fill and its stroke.** Full tier: it changes fill and stroke output, both operation ids and the renderer's failure handling. It changes no threshold of the P3 acceptance table, no tolerance bucket and no exact-rung cap.

## 1. Cause

The fill and stroke kernels resolve each path's planar arrangement exactly, on the CPU, under fixed caps: the stroke's `max_input_vertices` (1,024) and `max_nodes` (8,192), the fill's exact-rung edge, command and work caps (E14-U2's large tier). The work grows with the path's length over the tolerance and with its crossings. A large pen path, or any path at a high enough zoom, meets a cap; the kernel answers `work-limit` and the path draws nothing.

Every earlier fix moved a cap or added a retry inside the exact rungs (E35's hairpin retry, E14-U2's large tier, #522's three coarser exponents). Each one moved the edge, and the next path past it vanished again. The user's node-5 and node-7 (2026-11-07) fail at the editor's exponents on `main` d9b5f88 ([record §1](../evidence/e38-robust-path-rung-2026-11-07.md#1-the-defect)): node-7's stroke fails at every `e` from 0 down to −6.

## 2. The rule

An exact rung keeps every answer it gives today. Only when the exact build of a path ends in `work-limit` or `unsupported-geometry` does the kernel build the path once more with a **robust rung** (`robust_mesh.rs`) and publish its mesh instead. Nothing that is `ok` today changes, bit for bit.

- **E38-R1, flattening.** Each cubic becomes `n` chords by Wang's bound at `tol = 2^(e-1)`, at most 4,096 per cubic.
- **E38-R2, stroke pieces.** Each chord gives a quad of half width `r`. Each chord corner gives a join: the request's join (miter with its limit, round or bevel) at a verb boundary, round inside a cubic. Open subpaths get the request's caps. Each piece is a convex polygon oriented counterclockwise, so their nonzero union is the stroke.
- **E38-R3, slab sweep.** The directed edges (the fill's chords under its rule, or the stroke's pieces under nonzero) are cut at every endpoint `y` and at every crossing of two neighbouring edges. In each slab the spans whose winding passes the rule become trapezoids, and a span bounded by the same two edges in the next slab extends its trapezoid. The output is a set of non-overlapping triangles, so a stroke under opacity blends once.
- **E38-R4, fixed budget.** All buffers are reserved once with the engine (`RobustMesh::reserve`, 7.1 MB per engine), so a build never allocates and the `process` calls never move linear memory. The sweep also has a work budget, `MAX_SWEEP_WORK` = 2^24 edge visits (about 130 ms natively), which bounds its time where stroke pieces overlap deeply (wide strokes). A build that would overflow a buffer starts again at twice the tolerance; one over the work budget starts again at a tolerance projected from its overrun (work grows about as `tol^-1.5`), by a power of two up to 2^16. When a coarsening leaves the chord count as it was (a path of lines, which a tolerance cannot simplify), that attempt runs without the budget: its work is then the path's own crossings, for example 0.27 s natively for a 201-point star polygon whose edges all cross. It refuses (the exact status is kept) only when the path does not fit even at one chord per verb, which takes more than 8,192 source points.
- **E38-R5, no fringe.** The robust mesh has no boundary edges. The renderer draws a mesh with no boundary edges without the coverage fringe, so its edges are the 4x MSAA edges.

Plain binary64 arithmetic, no exact predicate: a rounding slip moves a trapezoid corner by about one ulp of the coordinates, which the 1/8 device px tolerance budget absorbs.

## 3. Renderer

Two failure paths no longer hide a path (`path-mesh-pipeline.ts`):

- A mesh with no boundary edges is drawn without a fringe and posts no notice.
- A joint fill and stroke pair (opacity below 1) where either mesh has no boundary edges is `overlay-unsupported` without an overlay build: the overlay classifies triangles against the boundary, and a robust mesh has none.
- `fringe-unsupported` draws the region without the fringe, and `overlay-unsupported` draws the plain fill and stroke without the joint overlay. Both notices stay, with the text "is drawn without its coverage fringe" or "is drawn without its joint coverage".

The coarser retry (#522) stays. With the robust rung a kernel `work-limit` is now rare (a path over 8,192 source points), so it seldom runs.

## 4. Error argument

Fill: Wang's bound puts every chord within `tol = 2^(e-1)` of its cubic, so the flattened region is within `2^(e-1)` of the ideal region in Hausdorff distance. The sweep is exact up to rounding. Stroke: the union of the chord quads, joins and caps is the stroke of the flattened polyline (each chord's sweep of a disk of radius `r`, with the round joins inside a cubic filling the wedges between chords, and the request's join at the verb corners). The polyline is within `2^(e-1)` of the curve, so the union is within `2^(e-1)` of the ideal stroke, plus each round arc's sagitta (arcs are inscribed, with steps whose sagitta is at most `2^(e-1)`; the 128-step cap only binds for radii above about 3,300 tolerances). The total stays inside the curve share `2^e`. A coarsened build (R4) has a larger tolerance, recorded in its stats and not reported to the renderer: drawing the path coarser is the rung's purpose. None occurred on the user corpus at width 1; wide round strokes coarsen ([record §3](../evidence/e38-robust-path-rung-2026-11-07.md#3-results-native-release-one-container)), for example node-5 at width 100 to 4x at `e = −3`.

## 5. Acceptance

- **E38-A1, the user's paths.** node-3, node-5, node-6, node-7, node-8 and the E35 cases draw fill and stroke at every `e` from 0 to −8 (`e38_user_paths_always_draw`, release), and node-5 and node-7 at the editor's −3 and −4 in the debug suite.
- **E38-A2, reference match.** On a seeded random pen-path fuzz (12 cases in CI, 96 by hand), every sample point farther than the tolerance margin from the ideal boundary is inside the mesh exactly when it is inside a 256-chord-per-cubic reference (fill under both rules, stroke under every cap and join).
- **E38-A3, no refusal.** The fuzz never refuses (3 cases in CI, 40 by hand).
- **E38-A4, no allocation.** A robust build allocates nothing (`e38_build_allocates_nothing`), and through both exports `process` allocates nothing and moves no storage (`e38_robust_rung_through_the_export` in both export test files).
- **E38-A5, identity.** Every existing exact-rung test keeps its status: the robust rung is opt-in in tests (`TestHooks::robust`, `StrokeDefects::robust`) and always on in production. The older baselines (`small_tier_only`, `pre_b1_caps`, the stroke's `unmerged`, `no_band_rule`, `no_family_b`, `no_retry`) never run it.
- **E38-A6, headed.** On the main PC, `pnpm test:gpu` passes after re-baselining the specs that pin the operation ids, and the user's node-5 and node-7 draw in the editor at :4194.

## 6. Not in E38

- **Coarsening is silent and can be large.** A coarsened robust build keeps its status `ok`. On deeply overlapping wide strokes at high zoom the tolerance grows a lot, for example 32x on node-5 at width 100 and `e = −6`, and 8,192x on 40 overlapping loops at width 200 and `e = −8`, so such strokes look faceted. Reporting the published tolerance to the renderer, or a cheaper union for wide strokes, is a follow-up.
- **Pathological line paths are not time-bounded.** An unbudgeted attempt (R4) costs the path's own crossings: a 240-line scribble takes about 120 ms natively, but a 1,001-point star whose edges all cross (about 250,000 crossings) takes 6.4 s. Degrading inside the sweep instead of lifting the budget is a follow-up.
- **Latency before the fallback.** The exact rung still runs to its cap first (up to about 400 ms natively on node-7's stroke at `e = −6`). Skipping it for paths known to be too large is a follow-up.
- **Precision label.** The robust meshes are not certified by the exact predicates; their rows stay UNVERIFIED under E3, as all P3 meshes are.
- **Caps.** E37's decision (2026-11-06, keep the stroke caps) stands: no exact-rung cap changes. E37 and E36 (star outlines, `unsupported-geometry`) are now drawn through the robust rung.
