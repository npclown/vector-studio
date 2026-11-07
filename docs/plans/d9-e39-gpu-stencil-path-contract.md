# E39 contract: path fills and strokes through GPU stencil-then-cover

Status: **ADOPTED 2026-11-07** (review round 2 READY WITH FOLLOW-UPS, follow-ups applied). The user chose this direction on 2026-11-07 (15:16Z, thread "경로 렌더링을 GPU 스텐실로 전환": "지금 스텐실 전환을 진행하자"), after the comparison in the plan doc [경로 렌더링을 GPU 스텐실 방식으로 바꾸는 계획](https://claude.ai/artifact/68n1sQ6wGsnoDrYMRZAXrN). The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24.

This is rendering-track item E39 ([D9 rendering track](d9-rendering-track.md#status-index)). It is full tier. It changes:

- both operation ids and the production output of the fill and stroke kernels;
- the fill-mesh port, by two optional fields, and the mesh packet layout;
- the renderer's path draws, which no longer use the E17 write-once state, the P3 coverage fringe or the ST-U7 joint overlay, except for paths past the winding bound (K5);
- the anti-aliasing of path edges, from the A5 fringe to 4x MSAA.

It changes no acceptance threshold of P3, no tolerance bucket and no primitive (rectangle, ellipse, line, text) draw. Identifiers use the prefix **E39-**.

## 1. Cause

The kernels resolve each path's planar arrangement on the CPU. The exact rungs do it under fixed caps and give up with `work-limit`. E38's robust last rung (slab sweep) catches what they refuse, but three costs remain ([E38 contract §6](d9-e38-robust-path-rung-contract.md#6-not-in-e38)):

- **Latency.** The exact rung runs to its cap first. Native release, one container, 2026-11-07: node-5 stroke at `e = −2` 478 ms exact-first against 1.9 ms robust-only; the E35 triangle stroke at `e = −3` 542 ms, even though the exact rung succeeds there; node-7 fill at `e = −3` 60 ms against 0.2 ms. A path's size does not predict the exact rung's cost.
- **Coarsening.** Where stroke pieces overlap deeply (wide strokes, high zoom), the sweep exceeds its work budget and the robust rung coarsens silently: 32x on node-5 at width 100 and `e = −6`.
- **Unbounded crossings.** A path of lines cannot be coarsened, so the sweep pays its own crossings: 6.4 s for a 1,001-point star stroke.

All three come from computing the region on the CPU. Figma, Skia's GPU backend and Illustrator's GPU mode do not. They count the winding number per sample in the stencil buffer and paint where it passes the fill rule (stencil-then-cover). E39 moves the region computation to the GPU in the same way.

## 2. The rule

The production kernels stop resolving the region. They return **winding meshes**: triangles whose signed coverage counts the path's winding number (fill) or whose union is the region (stroke). The renderer resolves the fill rule per sample in the stencil buffer.

- **E39-K1, fill winding mesh.** Each subpath, flattened by E38-R1 (Wang's bound at `tol = 2^(e−1)`, at most 4,096 chords per cubic), becomes a fan from its first point: for consecutive flattened points `p_i, p_{i+1}`, the triangle `(p_0, p_i, p_{i+1})`, in that vertex order. A triangle whose three points are collinear in binary64 is left out (it covers no sample). The signed sum of the fan's coverage at any point not on an edge is the subpath's winding number there. Open subpaths are closed implicitly, as the fill rule already treats them.
- **E39-K2, stroke union mesh.** The stroke's pieces are E38-R2's: a quad per chord of half width `r`, the request's join at verb corners, round joins inside a cubic, the request's caps on open subpaths, each a convex polygon. Each piece becomes a fan from its first vertex. The stroke is the union of the pieces; the renderer marks it (R1) and never counts it, so neither the pieces' orientation nor their overlap depth matters.
- **E39-K3, no sweep, no arrangement.** Neither kernel runs an exact rung or E38's slab sweep for a winding mesh. They remain in the crate, behind the test hooks, as the oracle (E38-A2's reference, A04) and for the older baselines, and the fill's E38 rung also serves K5.
- **E39-K4, bounded size, reported coarsening.** A winding mesh has at most 2^17 vertices (`MAX_WINDING_VERTICES`, 131,072; U1 halved the draft's 2^18 so the reserved buffers stay within the engine's linear-memory budget). Buffers are reserved once with the engine, as E38-R4 requires, so a build allocates nothing. A path whose flattening would exceed the bound is flattened again at twice the tolerance, up to 64 times (E38-R4's `MAX_COARSENINGS`); its work is linear in its flattened points. The served exponent is part of the result (section 2, K6) and the renderer posts one `path-coarsened` notice per cache entry when it is above the requested one. The build refuses with `work-limit` only when one chord per verb exceeds the bound (more than 2^17 source points).
- **E39-K5, winding bound for fills.** The stencil counts modulo 256, and modulo 128 in a joint draw (R6). The fill kernel therefore computes a conservative bound `W` on the absolute winding number, on the binary64 local coordinates:
  - Per subpath `i`: `N_i` is the largest number of its flattened edges whose closed `y`-span contains one `y`, over all `y`. A horizontal line at the height of any point `p` meets each such edge once, on the left or on the right of `p`, and the winding number is the same whichever way the ray points, so `|w_i(p)| ≤ min(L, R) ≤ floor(N_i / 2) = W_i`.
  - Over the path: `w_i(p) = 0` outside subpath `i`'s bounding box, so `W` is the largest sum of `W_i` over the subpaths whose boxes contain one point, found by a sweep over the boxes (a rectangle-depth maximum, O(m log m) for m subpaths, in the reserved buffers).

  If `W ≥ 120` (128 less a margin for the f32 rounding of transformed vertices, which can reorder nearly equal `y` values), the path is built by E38's robust rung instead (a partition mesh, drawn by E17's write-once path). E36's 1,001-point star outline (rings up to about 500) is such a path; an outlined text row of 64 or more glyphs is not, since its glyphs' boxes are disjoint. Strokes need no bound (K2).
- **E39-K6, the port.** `FillMesh` gains two optional fields: `coverage?: 'winding' | 'union'` and `servedExponent?: number`. Absent `coverage` means today's partition mesh (non-overlapping triangles with boundary edges). A fill winding mesh has `coverage: 'winding'`, a stroke mesh `coverage: 'union'`; both have empty `boundaryEdges` and `bounds` that contain every vertex. `portVersion` stays 0, since the fields are optional. A renderer before E39 would draw a winding mesh as if it were a partition, so the kernel and renderer change in one merge (section 7, U1 with U2).
- **E39-K7, identity.** `geometry-wasm/fill-v0+r7` and `geometry-wasm/stroke-v0+r10`.

Plain binary64 arithmetic. A rounding slip moves a fan vertex by about one ulp of the coordinates, which the 1/8 device px budget absorbs, as in E38.

## 3. Renderer: stencil-then-cover

A winding or union mesh is drawn in two or more passes over the existing `stencil8` attachment. Partition meshes (K5's fallback, tests, older baselines) keep the E17 path unchanged.

- **E39-R1, stencil pass.** The mesh's triangles, no color writes (color write mask 0), no culling, compare `always`, stencil write mask `0xff`:
  - fill (`winding`): front faces `increment-wrap`, back faces `decrement-wrap`. A mirrored transform negates the count; neither fill rule depends on its sign, so no variant is needed.
  - stroke (`union`): both faces `replace` with reference 1.
- **E39-R2, cover pass.** Two triangles over the cover quad (R3), with the path's paint shader (solid or gradient) at coverage 1 per sample. Stencil test, with the reference and masks below; pass and fail both write `zero` with write mask `0xff`. So each sample is painted at most once, and every sample the stencil pass touched is 0 again after the cover.

  | Draw | Compare | Reference | Read mask |
  | --- | --- | --- | --- |
  | fill, nonzero | `not-equal` | 0 | `0xff` |
  | fill, even-odd | `equal` | 1 | `0x01` |
  | stroke | `equal` | 1 | `0xff` |

- **E39-R3, cover quad.** The mesh's `bounds` contain every fan triangle (each triangle lies in the convex hull of its points). Their four corners are stored with the mesh, geometry-owned like its vertices. The cover vertex shader transforms them and moves each corner outward by 1 device px along both screen axes, so the f32 rounding of the corners can never leave a stencilled sample uncovered; the stencil test keeps the margin unpainted. The dilation depends on no cache bucket, so a transform-only change rebuilds nothing.
- **E39-R4, no discard.** A cover shader never discards; a transparent paint writes alpha 0. A discarded fragment skips its stencil operation and would leave a count behind for the next path. This applies to the plain, joint, layer and mask cover shaders. The stencil pass has no fragment output and no discard.
- **E39-R5, E17 alongside.** Winding and union draws do not consume E17 reference ordinals; `meshStencilStep` counts only partition draws. A partition draw leaves its reference in the stencil, so before the first winding or union draw after a partition draw the renderer issues E17's reset draw. In production this happens only around K5's fallback paths.
- **E39-R6, joint fill and stroke (opacity below 1).** The stencil bits split: bit 7 marks the stroke, the low 7 bits count the fill's winding (modulo 128, safe by K5).
  1. Stroke stencil: the stroke mesh, `replace` with reference `0x80`, write mask `0x80`.
  2. Fill stencil: R1's fill state with write mask `0x7f`.
  3. Joint cover over the union of both padded quads, with a joint paint shader that composites stroke over fill and multiplies by opacity. Nonzero: compare `less`, reference `0x80`, read mask `0xff` (passes for `0x81` to `0xff`). Even-odd: compare `equal`, reference `0x81`, read mask `0x81`. Pass `zero`, fail `keep`.
  4. Stroke-only cover over the stroke's padded quad: compare `equal`, reference `0x80`, read mask `0x80`, stroke paint times opacity. Pass `zero`, fail `keep`.
  5. Fill-only cover over the fill's padded quad, fill paint times opacity. Nonzero: `not-equal`, reference 0, read mask `0x7f`. Even-odd: `equal`, reference 1, read mask `0x01`. Pass `zero`, fail `zero`.

  All `zero` and `keep` operations use write mask `0xff`. Each sample is painted once, by the case that holds there, so opacity applies once to stroke over fill, and step 5 clears every sample the earlier steps left, since its quad and step 3's together cover both meshes. The joint overlay (`path-joint-overlay.ts`) and its `overlay-unsupported` state are not used for these draws. A fill that fell back to a partition mesh (K5) is drawn jointly as today.
- **E39-R7, every pass that draws meshes.** R1 to R6 apply in the main pass, in isolation layer passes (`#encodeLayerPassDraws`, E25), and in mask tile passes (P4-K2, E22): each mask tile pass that draws a source runs R1 and R2 with the mask cover shader (opaque white coverage times the pass's clip coverage, no discard). The mask pass already has a stencil attachment when its source is a mesh, at the scene's sample count.
- **E39-R8, packet and pipelines.** A mesh draw record gains `coverage` (`partition`, `winding`, `union`) and, for `winding`, the fill rule; `MESH_PACKET_LAYOUT_KEY` becomes `p3-mesh-packet-v1` (layout version 1). Compare and read masks are pipeline state in WebGPU, so the pipeline set grows. The stencil states are four stencil passes (fill, stroke, joint stroke, joint fill) and eight covers (fill nonzero, fill even-odd, stroke, joint step 3 in two rules, step 4, step 5 in two rules). Covers multiply by the paint variant (solid, E23 gradient), the clip variant (P4) and the target (main and layer color format, the mask pass's `r8unorm`), and everything by the sample count (1, 4). U2 records the exact total and the pipeline cache keys (render-state key `premultiplied-source-over/stencil8-<state>/no-cull/triangle-list-v1`). All are created with the mesh pipelines, never in the interaction path, and A8 includes their creation time at startup.
- **E39-R9, the E10 count pass.** The count pass replays winding and union draws with count pipelines of the same stencil and cover states (its own `stencil8` texture, as today), so the count image is the painted region after the fill rule: 1 where the reference region is, 0 outside. Its reset rules follow R5.
- **E39-R10, anti-aliasing.** A winding or union draw's edges are the 4x MSAA edges. No coverage fringe is built (`path-fringe.ts` is not used for these meshes). At sample count 1 the edges are aliased.
- **E39-R11, caching.** These meshes are cached under the same keys as today (paint, geometry, tolerance bucket); a transform-only change rebuilds nothing. The coarser retry (#522) and the failure notices stay for the remaining `work-limit` case.

## 4. Error argument

Fill: Wang's bound puts every chord within `2^(e−1)` of its cubic, so the flattened region is within `2^(e−1)` of the ideal region in Hausdorff distance. The fan resolves the flattened region exactly, per sample, up to the rasterizer's own rules, because K5 keeps the winding number below the stencil's modulus. Stroke: the union of the pieces is E38's, within `2^(e−1)` of the ideal stroke plus each round arc's sagitta, inside the curve share `2^e` ([E38 §4](d9-e38-robust-path-rung-contract.md#4-error-argument)), and the stencil marks the union exactly, with no modulus. A build coarsened by K4 serves a larger tolerance and says so (`servedExponent`, `path-coarsened`); A3 asserts that the named cases are not coarsened.

## 5. What changes elsewhere

- **E17.** Unchanged for partition meshes. Winding and union draws do not use write-once; R2 already paints each sample once.
- **The A5 fringe and the ST-U7 overlay.** Used in production only for K5's fallback paths after U2. Both are D8-interim exceptions; E39 does not delete them. Deleting them is a follow-up.
- **Hit testing.** Unchanged. Precise hit testing is the geometry kernel's, not the meshes' ([architecture, Culling and hit testing](../graphics-engine-architecture.md#culling-and-hit-testing)).
- **Clipping.** Rect clips are analytic and masks are `r8unorm` textures; neither uses the stencil ([architecture, Clipping](../graphics-engine-architecture.md#clipping)).
- **Gradients (E23), isolated opacity (E25), dash (E24), text (E28).** The cover pass uses the same paint math, without discard; isolated groups composite as before (R7); dashes are expanded before the stroke port; text is a separate pipeline.
- **A04 and precision.** A04's evidence measures the exact rungs, which become test-only. The production meshes are not certified by exact predicates; their precision rows stay UNVERIFIED, as all P3 meshes already are. Re-measuring precision on rendered pixels is a follow-up (the user set A04 to low priority on 2026-11-04).
- **Architecture text.** "MSAA-only output is not considered sufficient for the final path renderer" ([Anti-aliasing](../graphics-engine-architecture.md#anti-aliasing)) is amended by E39-Q1: MSAA-only is accepted for path edges until the analytic coverage follow-up (E40) decides otherwise.

## 6. Acceptance

| Id | Criterion | Where |
| --- | --- | --- |
| E39-A1 | The user corpus (node-3, node-5, node-6, node-7, node-8, the E35 cases, the E36 star) builds fill and stroke at every `e` from 0 to −8 with no refusal; the E36 star fill takes K5's fallback and its stroke a union mesh | Rust release test |
| E39-A2 | Reference match: on a seeded pen-path fuzz (12 cases in CI, 96 by hand), every sample point farther than the tolerance margin from the ideal boundary passes the rule on the fan's winding number (fill, both rules) or lies in a piece (stroke, every cap and join) exactly when it is inside the 256-chord-per-cubic reference | Rust test |
| E39-A3 | Bounds and time: the fuzz never refuses; K5's bound is at least the true winding number on every fuzz case and on a 130-turn spiral, which falls back; an outlined text row of 64 glyphs does not fall back; the record states the fallback rate on the user corpus; the 1,001-point star stroke and node-5 at width 100 and `e = −6` build in under 16 ms natively with `servedExponent` equal to the requested one | Rust release test |
| E39-A4 | No allocation: a build allocates nothing, and `process` moves no storage through both exports | Rust test, both export test files |
| E39-A5 | Encoding, with a recording fake pass: a fill (both rules, a mirrored transform) and a stroke record R1 then R2 with the states of section 3; a joint path records R6's five steps; a partition draw before a winding draw adds one reset draw and winding draws take no E17 ordinal; the same holds in a layer pass and a mask tile pass; the packet has layout version 1 | Unit |
| E39-A6 | Painted once and no stencil leak: the E10 count pass (R9) reports exactly the reference region for the winding, union and joint fixtures; a fixture with a fully transparent fill and a zero-alpha gradient stop, followed by an opaque path over the same pixels, draws the second path correctly | Headed |
| E39-A7 | Identity: every existing exact-rung and E38 test keeps its status through the test hooks; tests that pin production operation ids are re-baselined with the reason "E39" | CI |
| E39-A8 | Cost: on the E26/E30 10k-node benchmark scenes the main-pass frame time on the main PC is at most 1.1x of `main` before E39; node-7 at zoom 4 draws within one frame | Headed, main PC |
| E39-A9 | Headed: `pnpm test:gpu` passes on the main PC after the re-baseline; the record lists every re-baselined fixture at 4x and at 1x (aliased path edges at 1x are expected); node-5 and node-7 draw fill and stroke in the editor at :4194 | Headed, main PC |

## 7. Units

Each unit is one PR, merged in order after review READY and CI green.

| Unit | Content | Acceptance |
| --- | --- | --- |
| E39-U0 | This contract, the rendering-track rows | Review READY |
| E39-U1 | Kernel: K1 to K7 (winding and union meshes, the size bound, the winding bound and fallback, the port fields, the new ids), production switched to these meshes, exact and E38 rungs behind test hooks | A1 to A4, A7 (kernel part) |
| E39-U2 | Renderer: R1 to R5, R7 to R11 for plain draws in the main pass, layer passes and mask tile passes, the packet v1 and the pipelines, the count-pass replay. U1 and U2 are reviewed separately but merge together (K6) | A5 (plain, layer, mask), A7 |
| E39-U3 | Renderer: R6 joint fill and stroke, in main and layer passes | A5 (joint), A6 |
| E39-U4 | Cost: measure A8; if it misses, batch the stencil and cover draws of consecutive paths whose padded quads do not overlap | A8 |
| E39-U5 | Headed re-baseline and record, P4 evidence re-run, architecture amendments | A6, A9 |

Until U3 merges, a joint path (fill and stroke at opacity below 1) with winding meshes draws its two paints plainly, as E38 does for `overlay-unsupported` (opacity twice in the overlap). Merge rule: U1, U2 and U3 merge back to back, and no release, alpha build or editor relaunch on the main PC is cut between U2 and U3.

## 8. Not in E39

- **Analytic coverage for path edges (E40).** 4x MSAA gives five coverage levels per pixel; nearly horizontal edges can look stepped beside the A5 fringe. A cover-pass coverage estimate (or a compute rasterizer) is a follow-up, opened if the headed comparison in U5 shows it is needed.
- **Deleting the exact fringe and overlay builders**, and the exact rungs from the production WASM.
- **Precision re-measurement** on rendered pixels (A04 successor).
- **Paths past K5's bound** draw through E38's partition mesh, with its costs (sweep time, coarsening). A two-pass split of the fan is a follow-up if real files hit it.
- **Overdraw.** A fan from the first point can cover a large area for a long scribble; the stencil pass then touches many samples. U4 measures it; a better pivot or splitting is a follow-up if A8 misses.

## 9. Decisions

| Id | Question | Options | Adopted |
| --- | --- | --- | --- |
| E39-Q1 | Path edge anti-aliasing | (a) 4x MSAA now, analytic coverage as follow-up E40 (recommended); (b) build analytic coverage before switching | (a), 2026-11-07, recommended option auto-adopted under the standing instruction of 2026-10-24 |
| E39-Q2 | The exact rung in production | (a) removed from the production path, kept as the test oracle (recommended); (b) kept as an idle upgrade to the fringe-quality mesh | (a), 2026-11-07, same |

## 10. Progress

### 10.1 U1 and U2 record (2026-11-07)

U1 (kernel) and U2 (renderer) ship together, as K6 requires. What they implement departs from sections 2 and 3 in these points; none changes a guarantee.

- **Exact rungs on the release WASM.** K3 keeps the exact and E38 rungs "behind the test hooks", but those hooks exist only in native test builds. The harnesses that measure the exact rungs run on the release WASM (A04's harness and GPU readback, the C01-C18 and SC01-SC22 conformance suites, the adapters' fail-closed byte tests). So request header word 11 (offset 44, reserved and zero until now) becomes the exact flag, 0 or 1, for fill and stroke; the adapter factories set it only with `exactRungsForTesting: true`. Production never sets it. `tests/geometry/e39-winding-port.test.ts` checks the production meshes: coverage word, no boundary edges, and sampled coverage against the independent fill oracle (both rules) and against the exact stroke rung.
- **Cover states.** The stroke cover uses `not-equal` 0 with read mask `0xff` and the even-odd cover `not-equal` 0 with read mask `0x01`. They pass on the same samples as the table's `equal` 1 (a union stencil holds only 0 or 1; `x & 1 != 0` is `x & 1 == 1`), so one nonzero and one even-odd cover pipeline serve fills and strokes.
- **Cover records.** A coverage mesh packs its four bounds corners after its vertices (bounds minus the midpoint, in binary64 like the vertices). The packet adds two triangle records per variant with role 2 (cover); record word 7 is 1 (no discard) on every triangle record of a winding or union variant, and every fragment shader that can discard (mesh, paint, mask) skips its discard there (R4).
- **Zero-area fills.** A fan does not resolve the region, so a fill whose region is empty (two opposite copies of a square; a doubled square under even-odd) is an `ok` winding mesh that paints no sample, not `empty`.
- **Pipelines (R8).** Per sample count, the E39 additions are: 2 stencil-pass pipelines (winding, union) and 2 covers (nonzero, even-odd) in the main pass and again in the count pass; 5 in the clip set (clip cover pair, and the mask tile pass's stencil and cover); 2 covers per paint variant (times 2 with the analytic clip); 2 covers per mesh layer module. Keys: render-state `premultiplied-source-over/stencil8-cover-nonzero/no-cull/triangle-list-v1` and `…-cover-evenodd/…` for covers, `no-color/stencil8-stencil-winding/…` and `…-union/…` for stencil passes. With every feature on, `pipelinesCreated` goes from 27 to 48 at one sample count in the ST-U7 fixture.
- **Coarsening report (review, 2026-11-07).** `servedExponent` counts tolerance doublings, not retries: a K5 fallback whose slab sweep overruns its budget multiplies the tolerance by up to 2^16 in one retry, and the record reports every doubling. When the drawn flattening has the requested chord count (a path of lines, which no tolerance changes), nothing is reported and no `path-coarsened` notice is posted. The adapters fail closed on a record whose doublings would make the tolerance infinite.
- **Contours.** The winding and union builds hold up to 2^17 subpaths (one per point at most). K5 keeps at most 8,192 boxes at once: past that, neighbouring boxes merge in pairs (the box around both, the sum of their bounds), which keeps the bound conservative and the workspace inside the 48 MiB stroke heap cap. So a compound path of more contours than E38's 8,192 chords (an outlined text block) draws. A stroke's pieces take several vertices per chord, so a stroke reaches K4's bound at fewer source points than a fill.
- **A1 tests.** The user-corpus test (`e39_user_paths_always_draw`) and the full fuzz are `#[ignore]` release tests run by hand (`cargo test --release -- --ignored e39`), as E38's were; CI runs the bounded fuzz.
- **Notice outcome.** `path-coarsened` is outcome O2 in `docs/requirements.md` (the paint draws, from a coarser mesh).
- **Ids.** `geometry-wasm/fill-v0+r7` and `geometry-wasm/stroke-v0+r10`; tests that pinned r6 and r9 are re-baselined with the reason "E39" (A7).

### 10.2 U3 record (2026-11-07)

U3 draws R6's joint paths in the main pass, layer passes and the count pass. It departs from R6's steps 3 to 5 in these points; the composite and the cleared stencil are unchanged.

- **Covers and order.** No cover quad is recorded for the union of both meshes, and a cover shader that composites stroke over fill would need both paints (solid or gradient) in one entry point. So the three covers are: (3) `joint-both-<rule>` over the fill's quad, which paints ST-U7's joint fill colour `X = o · f · (1 − s.a) / (1 − o · s.a)` where both hold (new entry point `meshJointCoverFragmentMain`, no discard) and clears the low 7 bits (write mask `0x7f`, fail `keep`); (4) `joint-fill-<rule>` over the fill's quad, `o · f` where only the fill holds, pass and fail `zero` with write mask `0x7f`; (5) `joint-stroke` over the stroke's quad, `o · s` where bit 7 is set, pass and fail `zero` with write mask `0xff`. Where both hold the sample is painted twice, `X` then the stroke over it, which is exactly ST-U7's pair (`o · s + X · (1 − o · s.a) = o · (s over f)`), so the count pass reports ST-U7's joint counts there. `tests/unit/e39-u3-joint-stencil.test.ts` simulates the five steps per sample (both rules, fill windings −3 to 129, stroke crossings 0 to 5, three opacities) against `o · (s over f)` and checks the stencil ends at 0.
- **Packet.** A winding fill and its union stroke at `0 < o < 1` emit the fill draw with `composite: 'joint-fill'` and its coverage, then the stroke's union draw; no overlay is built and record word 15 names the stroke record. The backend accepts such a draw only when the next draw is that union draw (instance word 15 − 1, same position, same clip state) and draws the pair as one. A pair whose fill and stroke both are partition meshes keeps the ST-U7 overlay. A fill that fell back to a partition mesh (K5, `W >= 120`) with a union stroke has no overlay (ST-U7 treats a mesh with no boundary edges as robust) and draws as two plain draws with the `overlay-unsupported` notice, so the overlap takes the opacity twice; this is U2's behaviour too, and only K5's fallback paths reach it. A joint draw over coverage meshes releases any overlay an earlier ST-U7 pair left on its slot, so the record's bases are its own variant's.
- **Pipelines (R8).** Per sample count: 2 more stencil passes (joint stroke, joint fill) in the main and count passes, and 5 joint covers per mesh cover set (main, clip, each paint variant, each layer module; the count pass has its own five count covers). The mask tile pass has none (a mask source is never joint). With every feature on, `pipelinesCreated` goes from 48 to 90 at one sample count; the mesh-only generation from 8 to 15.

### 10.3 U5 record, part 1: watertight union strokes and the headed re-baseline (2026-11-07)

The first `pnpm test:gpu` run on the main PC after U3 (DESKTOP-DKVUSAV, Chrome) found one product defect and the expected re-baselines.

- **Pinholes in union strokes (fixed, `stroke-v0+r11`).** Thick strokes at high zoom showed single-pixel holes along the centre line (e24 D7 at DPR 2). Cause: a union stroke piece was the quad `a+n, b+n, b−n, a−n`, and the next piece and the round join fan meet it at `a` and `b`, which lie on the quad's edges but are not its vertices. Rasterized in f32 these T-junctions leave sample-sized cracks, which the nonzero union stencil cannot fill. Union pieces now carry the centre-line points `a` and `b` as vertices where a neighbour joins (`joined_start` / `joined_end`), and the round join and round cap fans start and end on the shared vertices, so every shared edge is drawn with the same vertex pair. Partition (K5) strokes are unchanged. The test `e39_union_strokes_are_watertight` maps the meshes to f32 device space at zoom 8 and probes rings around each interior vertex: 177 holes before the fix, 0 after. The stroke revision is now `stroke-v0+r11`; the fill revision stays `fill-v0+r7`.
- **Re-baselined headed fixtures.** The fringe-cap and overlay notices that partition meshes raised no longer occur, so `p3-b2-strokes` (every case), `viz-v1-appearance` (`s4`) and `viz-v2-path-data` (`p3q`, `p3s`, `p3qc`, `a13`, `t`) expect none, and `e24-stroke-dash` expects no O3 outcome at any DPR and checks D6 with its overlay. `e17-write-once` reads MSAA coverage at 4x: an edge pixel has some samples uncovered and its red is the covered fraction (C4/n06/T2 pixel (491,268) is now `255 × covered / 4`, not the fringe's 143), and a T7 sliver may cover no sample, which is nothing to compare. `p4-clip-mask` asks for no edge probe at 1x when the content's clip levels are all path masks, since a path mask is aliased at one sample.
- **A6 fixtures.** `tests/gpu/e39-painted-once.spec.ts` on the new `e39-painted-once.html` check page draws winding (nonzero and evenodd stars), union (a self-crossing round-capped stroke) and filled-and-stroked star fixtures (opacity 1, two draws; opacity 0.5, R6's joint draw) at 1x and 4x, DPR 1 and 2, zoom 1, 4 and 8. Pixels 1 device pixel inside the reference region have the paint's colour and each sample counts once per region holding it (so 2 where fill and stroke both hold, as section 10.2 records for the joint draw), and pixels 1 device pixel outside count 0. A leak fixture draws a fully transparent star and a zero-alpha gradient rectangle under an opaque rectangle and checks the opaque one's colour.

### 10.4 U5 record, part 2: the final headed run (2026-11-07)

Main PC (DESKTOP-DKVUSAV), Chrome, at 8713ebc (#535), kernel WASM rebuilt (stroke-v0+r11):

- `pnpm test:gpu` tier 2: 91 passed, 6 failed, 29.0 min. No failure was wrong content and none was infrastructure. The failures were test-side:
  - `e39-painted-once` (4 tests): the check page lacked `paints: 'gradient'`, so the leak fixture's scene was rejected as `unsupported-feature`;
  - `viz-v1-appearance` N2 (2 tests): the round-capped zigzag is a union mesh with no fringe, so the `fringe-work-cap` notice no longer arrives. The images show the zigzag drawn.
  Both are fixed in #536; on the PC both specs then passed 6/6 (1.1 min). E39-A6 passes for every fixture at 1x and 4x, DPR 1 and 2, zoom 1, 4 and 8, including the leak fixture (4 draws, no diagnostics).
- E24 D7 at DPR 2 shows no pinholes: worst 0.339 against a limit of 1, and the zoom-8 worst absolute is 0.00009.
- Editor at :4194 relaunched at 8713ebc and serves HTTP 200. A filled and stroked pen path draws, and a user's 18-cubic 1 px stroke path rendered with no zero-coverage holes at DPR 1 and 2, zoom 0.5, 1 and 2 (18,018 centre-line samples).
- E39-A9 passes: `pnpm test:gpu` passes after the re-baseline (sections 10.3 and 10.4 list the re-baselined fixtures), and aliased path edges at 1x are expected.
