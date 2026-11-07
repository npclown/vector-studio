# E39 contract: path fills and strokes through GPU stencil-then-cover

Status: **DRAFT 2026-11-07**. The user chose this direction on 2026-11-07 (15:16Z, thread "경로 렌더링을 GPU 스텐실로 전환": "지금 스텐실 전환을 진행하자"), after the comparison in the plan doc [경로 렌더링을 GPU 스텐실 방식으로 바꾸는 계획](https://claude.ai/artifact/68n1sQ6wGsnoDrYMRZAXrN). The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24.

This is rendering-track item E39 ([D9 rendering track](d9-rendering-track.md#status-index)). It is full tier. It changes:

- both operation ids and the production output of the fill and stroke kernels;
- the fill-mesh port, by one optional field;
- the renderer's path draws, which no longer use the E17 write-once state, the P3 coverage fringe or the ST-U7 joint overlay;
- the anti-aliasing of path edges, from the A5 fringe to 4x MSAA.

It changes no acceptance threshold of P3, no tolerance bucket and no primitive (rectangle, ellipse, line, text) draw. Identifiers use the prefix **E39-**.

## 1. Cause

The kernels resolve each path's planar arrangement on the CPU. The exact rungs do it under fixed caps and give up with `work-limit`. E38's robust last rung (slab sweep) catches what they refuse, but three costs remain ([E38 contract §6](d9-e38-robust-path-rung-contract.md#6-not-in-e38)):

- **Latency.** The exact rung runs to its cap first. Native release, one container, 2026-11-07: node-5 stroke at `e = −2` 478 ms exact-first against 1.9 ms robust-only; the E35 triangle stroke at `e = −3` 542 ms, even though the exact rung succeeds there; node-7 fill at `e = −3` 60 ms against 0.2 ms. A path's size does not predict the exact rung's cost.
- **Coarsening.** Where stroke pieces overlap deeply (wide strokes, high zoom), the sweep exceeds its work budget and the robust rung coarsens silently: 32x on node-5 at width 100 and `e = −6`.
- **Unbounded crossings.** A path of lines cannot be coarsened, so the sweep pays its own crossings: 6.4 s for a 1,001-point star stroke.

All three come from computing the region on the CPU. Figma, Skia's GPU backend and Illustrator's GPU mode do not. They count the winding number per sample in the stencil buffer and paint where it passes the fill rule (stencil-then-cover). E39 moves the region computation to the GPU in the same way.

## 2. The rule

The production kernels stop resolving the region. They return **winding meshes**: triangles whose signed coverage counts the path's winding number. The renderer resolves the fill rule per sample in the stencil buffer.

- **E39-K1, fill winding mesh.** Each closed subpath, flattened by E38-R1 (Wang's bound at `tol = 2^(e−1)`, at most 4,096 chords per cubic), becomes a fan from its first point: for consecutive flattened points `p_i, p_{i+1}`, the triangle `(p_0, p_i, p_{i+1})`, in that vertex order. A triangle whose three points are collinear in binary64 is left out (it covers no sample). The signed sum of the fan's coverage at any point not on an edge is the subpath's winding number there. Open subpaths are closed implicitly, as the fill rule already treats them.
- **E39-K2, stroke winding mesh.** The stroke's pieces are E38-R2's: a quad per chord of half width `r`, the request's join at verb corners, round joins inside a cubic, the request's caps on open subpaths, each a convex polygon oriented counterclockwise. Each piece becomes a fan from its first vertex. Every triangle is counterclockwise, so the nonzero union of the pieces is the stroke.
- **E39-K3, no sweep, no arrangement.** Neither kernel runs an exact rung or E38's slab sweep in production. They remain in the crate, behind the test hooks, as the oracle (E38-A2's reference, A04) and for the older baselines.
- **E39-K4, bounded size.** A winding mesh has at most 2^18 vertices (`MAX_WINDING_VERTICES`, 262,144). Buffers are reserved once with the engine, as E38-R4 requires, so a build allocates nothing. A path whose flattening would exceed the bound is flattened again at twice the tolerance, up to 2^16 times; its work is linear in its flattened points, so this costs little. It refuses with `work-limit` only when one chord per verb exceeds the bound (more than 2^18 source points).
- **E39-K5, the port.** `FillMesh` gains an optional field `coverage?: 'winding'`. Absent means today's partition mesh (non-overlapping triangles with boundary edges). A winding mesh has `coverage: 'winding'`, empty `boundaryEdges`, and `bounds` that contain every vertex. `portVersion` stays 0, since the field is optional. A renderer before E39 would draw a winding mesh as if it were a partition (overlapping triangles painted several times), so the kernel and renderer change in one merge (section 7, U1 with U2).
- **E39-K6, identity.** `geometry-wasm/fill-v0+r7` and `geometry-wasm/stroke-v0+r10`.

Plain binary64 arithmetic. A rounding slip moves a fan vertex by about one ulp of the coordinates, which the 1/8 device px budget absorbs, as in E38.

## 3. Renderer: stencil-then-cover

A winding mesh is drawn in two passes over the existing `stencil8` attachment. Partition meshes (tests, older baselines) keep the E17 path unchanged.

- **E39-R1, stencil pass.** The mesh's triangles, no color writes (write mask 0), no culling. Front faces `increment-wrap`, back faces `decrement-wrap`, compare `always`. The winding number accumulates per sample, modulo 256. A mirrored transform flips every triangle's facing, which negates the count; neither fill rule depends on its sign, so no pipeline variant is needed.
- **E39-R2, cover pass.** One quad over the mesh's `bounds`, transformed like the mesh, with the path's paint shader (solid or gradient, coverage 1 per sample). Stencil test: nonzero compares `not-equal 0` with read mask `0xff`; even-odd compares `equal 1` with read mask `0x01`. Pass and fail both write `zero`. So each sample is painted at most once, and every sample the stencil pass touched is 0 again after the cover (all fan triangles lie inside the convex hull of the path's points, so inside `bounds`).
- **E39-R3, sharing the stencil with E17.** E17's write-once draws leave their references in the stencil. Before the first winding draw after a write-once draw, the renderer issues E17's reset draw. In production, where every path is a winding mesh, this never happens.
- **E39-R4, joint fill and stroke (opacity below 1).** The stencil bits split: the low 7 bits count winding (modulo 128), bit 7 marks the stroke.
  1. Stroke stencil pass (R1), write mask `0x7f`.
  2. Stroke mark: a cover quad with no color, read mask `0x7f`, `not-equal 0`; pass `replace` with reference `0x80`, fail `keep`.
  3. Fill stencil pass (R1), write mask `0x7f`.
  4. Joint cover, over the union of the two `bounds`: a new joint paint shader that composites stroke over fill and multiplies by opacity. Nonzero: reference `0x80`, compare `less` (passes for 0x81 to 0xff, stroke and fill both cover), read mask `0xff`. Even-odd: read mask `0x81`, `equal 0x81`. Pass `zero`, fail `keep`.
  5. Stroke-only cover: read mask `0x80`, `equal 0x80`, stroke paint times opacity. Pass `zero`, fail `keep`.
  6. Fill-only cover: the fill rule on read mask `0x7f`, fill paint times opacity. Pass `zero`, fail `zero`.

  Each sample is painted once, by the case that holds there, so opacity applies once to stroke over fill. The joint overlay (`path-joint-overlay.ts`) and its `overlay-unsupported` state are not used for winding meshes.
- **E39-R5, masks.** A mask source (P4-K2) drawn as a winding mesh uses R1 and R2 in the mask pass, writing opaque white coverage times the pass's clip coverage into the `r8unorm` mask texture. The mask pass already has its stencil attachment (E17).
- **E39-R6, anti-aliasing.** A winding draw's edges are the 4x MSAA edges. No coverage fringe is built (`path-fringe.ts` is not used for winding meshes). At sample count 1 the edges are aliased.
- **E39-R7, caching.** A winding mesh is cached under the same keys as today (paint, geometry, tolerance bucket); a transform-only change rebuilds nothing. The coarser retry (#522) and the failure notices stay for the remaining `work-limit` case.

## 4. Error argument

Fill: Wang's bound puts every chord within `2^(e−1)` of its cubic, so the flattened region is within `2^(e−1)` of the ideal region in Hausdorff distance. The fan resolves the flattened region exactly, per sample, up to the rasterizer's own rules. Stroke: the union of the pieces is E38's, within `2^(e−1)` of the ideal stroke plus each round arc's sagitta, inside the curve share `2^e` ([E38 §4](d9-e38-robust-path-rung-contract.md#4-error-argument)). Unlike E38, no coarsening runs below the size bound of K4, so wide strokes at high zoom keep the requested tolerance.

The winding count wraps at 256 (128 in a joint draw). A sample whose true winding number is a nonzero multiple of 256 (or 128) is drawn as outside under nonzero. A pen path cannot reach this without winding the same point 128 times; the fuzz of A3 includes such a case and the record names it.

## 5. What changes elsewhere

- **E17.** Unchanged for partition meshes. Winding draws do not use write-once; R2 already paints each sample once.
- **The A5 fringe and the ST-U7 overlay.** Not used in production after U2. Both are D8-interim exceptions that end "when the R2/K1 contract decides the production placement"; E39 does not delete them (tests and baselines still use them). Deleting them is a follow-up.
- **Hit testing.** Unchanged. Precise hit testing is the geometry kernel's, not the meshes' ([architecture, Culling and hit testing](../graphics-engine-architecture.md#culling-and-hit-testing)).
- **Clipping.** Rect clips are analytic and masks are `r8unorm` textures; neither uses the stencil ([architecture, Clipping](../graphics-engine-architecture.md#clipping)).
- **Gradients (E23), isolated opacity (E25), dash (E24), text (E28).** The cover pass uses the same paint shaders; isolated groups composite as before; dashes are expanded before the stroke port; text is a separate pipeline.
- **A04 and precision.** A04's evidence measures the exact rungs, which become test-only. The production meshes are not certified by exact predicates; their precision rows stay UNVERIFIED, as all P3 meshes already are. Re-measuring precision on rendered pixels is a follow-up, not part of E39 (the user set A04 to low priority on 2026-11-04).
- **Architecture text.** "MSAA-only output is not considered sufficient for the final path renderer" ([Anti-aliasing](../graphics-engine-architecture.md#anti-aliasing)) is amended by E39-Q1: MSAA-only is accepted for path edges until the analytic coverage follow-up (E40) decides otherwise.

## 6. Acceptance

| Id | Criterion | Where |
| --- | --- | --- |
| E39-A1 | The user corpus (node-3, node-5, node-6, node-7, node-8, the E35 cases, the E36 star) builds a winding mesh, fill and stroke, at every `e` from 0 to −8, with no refusal | Rust release test |
| E39-A2 | Winding meshes match the 256-chord-per-cubic reference: on a seeded pen-path fuzz (12 cases in CI, 96 by hand), every sample point farther than the tolerance margin from the ideal boundary has winding number passing the rule exactly when it is inside the reference (fill under both rules, stroke under every cap and join) | Rust test |
| E39-A3 | No refusal and bounded time: the fuzz never refuses; the 1,001-point star stroke and node-5 at width 100 and `e = −6` build in under 16 ms natively, the latter at the requested tolerance (no coarsening) | Rust release test |
| E39-A4 | No allocation: a build allocates nothing, and `process` moves no storage through both exports | Rust test, both export test files |
| E39-A5 | Encoding: with a recording fake pass, a winding path records the stencil pass, then the cover pass with the states of R1 and R2 (both fill rules, a mirrored transform); a joint path records R4's six steps; a write-once draw before a winding draw adds one reset draw | Unit |
| E39-A6 | Painted once: the E10 count pass reports at most 1 for every sample of the winding fixtures, joint fixtures included | Headed |
| E39-A7 | Identity: every existing exact-rung and E38 test keeps its status through the test hooks; tests that pin production operation ids are re-baselined with the reason "E39" | CI |
| E39-A8 | Cost: on the E26/E30 10k-node benchmark scenes the main-pass frame time on the main PC is at most 1.1x of `main` before E39; node-7 at zoom 4 draws within one frame | Headed, main PC |
| E39-A9 | Headed: `pnpm test:gpu` passes on the main PC after the re-baseline, and node-5 and node-7 draw fill and stroke in the editor at :4194 | Headed, main PC |

## 7. Units

Each unit is one PR, merged in order after review READY and CI green.

| Unit | Content | Acceptance |
| --- | --- | --- |
| E39-U0 | This contract, the rendering-track row | Review READY |
| E39-U1 | Kernel: K1 to K6 (winding meshes for fill and stroke, the size bound, `coverage: 'winding'`, the new ids), production switched to winding meshes, exact and E38 rungs behind test hooks | A1 to A4, A7 (kernel part) |
| E39-U2 | Renderer: R1 to R3, R6, R7 for winding meshes in the main pass. U1 and U2 are reviewed separately but merge together (K5) | A5 (plain), A7 |
| E39-U3 | Renderer: R4 joint fill and stroke | A5 (joint), A6 |
| E39-U4 | Renderer: R5 masks | A5 (mask), P4 evidence re-run |
| E39-U5 | Cost: measure A8; if it misses, batch cover draws of paths whose bounds do not overlap | A8 |
| E39-U6 | Headed re-baseline and record, architecture amendments | A6, A9 |

## 8. Not in E39

- **Analytic coverage for path edges (E40).** 4x MSAA gives five coverage levels per pixel; nearly horizontal edges can look stepped beside the A5 fringe. A cover-pass coverage estimate (or a compute rasterizer) is a follow-up, opened if the headed comparison in U6 shows it is needed.
- **Deleting the exact fringe and overlay builders**, and the exact rungs from the production WASM.
- **Precision re-measurement** on rendered pixels (A04 successor).
- **Overdraw.** A fan from the first point can cover a large area for a long scribble; the stencil pass then touches many samples. U5 measures it; a better pivot (the bounds' centre) or splitting is a follow-up if A8 misses.

## 9. Decisions

| Id | Question | Options | Adopted |
| --- | --- | --- | --- |
| E39-Q1 | Path edge anti-aliasing | (a) 4x MSAA now, analytic coverage as follow-up E40 (recommended); (b) build analytic coverage before switching | (a), 2026-11-07, recommended option auto-adopted under the standing instruction of 2026-10-24 |
| E39-Q2 | The exact rung in production | (a) removed from the production path, kept as the test oracle (recommended); (b) kept as an idle upgrade to the fringe-quality mesh | (a), 2026-11-07, same |
