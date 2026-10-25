# E17 contract: write-once sample coverage for mesh draws (sliver flips under rasterizer snapping)

This is rendering-track item E17 ([D9 rendering track](d9-rendering-track.md#status-index)). It is full tier: it changes the mesh draw's render state, which [V3 section g](p3-v3-renderer-mesh-pipeline-contract.md#g-paint-order-and-composition) fixes ("No offscreen isolation, stencil or extra pass is used"), and the E10 count pass that measures it ([E10 section 5](d9-e10-renderer-test-hooks-contract.md#5-count-pass)). It changes no threshold, no acceptance criterion, no packet byte, no WGSL of `MESH_FILL_SHADER` and no kernel output. Identifiers use the prefix **E17-**.

## 1. Cause

V-4's first headed A08 run (PRE-FREEZE, main 3ee6c20, WASM `8bac62c3…`, Chrome and Edge, DESKTOP-DKVUSAV) failed VZ4-A7 (G3) on four fringe-4x keys, identically in both browsers. V-4's diagnosis (2026-10-25; V-4 commits its evidence record under `docs/evidence/`) found one mechanism:

- The rasterizer snaps each vertex to an 8-bit subpixel grid (1/256 px), independently per vertex. A drawn triangle whose device-space height is below the snap displacement (up to `2^-9·√2 ≈ 0.0028` px per vertex) can invert or collapse. The inverted triangle, the neighbour across the crossed edge and the neighbour that now extends over the wedge all cover the same samples: count 3.
- A simulated rasterizer (8-bit snap, top-left rule, WebGPU's standard 4x pattern) reproduces the four failing count images with 0 mismatching samples at 1x and 4x. Snaps of 4, 6, 10, 12 and 16 bits do not.
- Over the 1,802 gated V-4 case-variants the model predicts 25 with count > 1, on 3ee6c20 and again on 516f377 (E17-A4). 24 are in the run record (4 FAIL, 20 hidden in UNDECIDED by the no-flip veto); 1 (`C4/n06/T0` dpr1.5 fringe-1x) is predicted only.

| Fixtures (fringe-4x unless noted)                                                                    | Triangles that invert or collapse at the snap | Effect                                                       |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `C4/n06/T2/z1-d1/center/k0@dpr1.5`, pixel (491,268); `C4/n06/T0` dpr1.5 fringe-1x, pixel (492,257)   | exterior 11x; port vertices 0.008 px apart    | counts [1,3,1,1] and [3]; T2: obs 165 against rule 143, **+22/255 visible** |
| `C1/s04-I/T7` dpr2; C3 `c01`-`c05`, `c13`, `c14`, `c17`, `c24`, `c26`, `c28`, `c29` (T7, dpr1.5 or 2) | region and exterior (4 to 125 region, 1 to 75 exterior); exterior fans to frame corners about 8,000 px away, 3·10^-4 px wide | count 3 on far-field samples (c = 0, invisible, counted by G3) |
| `C4/n07`, `n11` (T2 dpr1.5)                                                                          | region and exterior                           | count 3                                                      |
| `C3/c11/T2` dpr1; `C4/n12/T2` dpr1, dpr2 (1x and 4x); `C4/n13/T2` dpr1, dpr2                         | **region only** (kernel triangles)            | count 3                                                      |

Out of scope: `C1/s22-I` and `s23-I` (count > 1 at β ≫ 1 px, far-offscreen vertices, E3-R3 class A); their mechanism is not verified (E17-R3).

## 2. Why the fix is in the draw state, not in the meshes

- **Region slivers come from the kernel.** Five fixtures flip only region triangles, which `fill-v0` emits. Changing them is a fill revision and moves A01-A08 (E11 section 3.2).
- **No local-space triangulation is safe under every transform.** The fringe is built once per mesh and fringe bucket in node-local space and reused for every transform in that bucket. An affine map with condition number `k` turns a triangle of angle `θ` into one of angle about `θ/k`; T7 has `k = 2^12`. A boundary edge shorter than the snap displacement (C4's 0.008 px pair, or any edge at a smaller zoom) can flip with any third vertex.
- **Culling the inverted triangle does not help.** For the snapped image of a set of triangles that partition a region, every sample inside it has (covers in the exact orientation) − (inverted covers) = 1. Dropping the inverted triangle leaves two covers.

## 3. The rule

**E17-K1 (write-once per mesh draw).** Within one mesh draw, a sample is written by at most one fragment: the first that survives the fragment shader.

**Why it is exact where G3 requires "equal to 1".**

- *What a draw covers.* A variant's region and exterior triangles partition its frame (V3 section e's exact check, path-fringe.ts), but exterior triangles with an empty feature list are dropped from the draw (V3 section e). Each draw is one instance. So over the drawn triangles the signed cover sum is 1 at every sample outside the snapped images of the dropped triangles. A dropped triangle has no feature within `ρ ≥ 2` physical px, so its snapped image stays more than `2 − 0.003` px from the boundary. G3's "equal to 1" class lies within 1.104 px of the boundary or inside the region, so there every sample has at least one cover, and E17-K1 leaves exactly one. Elsewhere E17-K1 gives at most one cover, as G3's "at most 1" requires; a sample under a dropped triangle may stay uncovered there, as it is today, at `c = 0`.
- *Which triangle wins does not matter.* The shader evaluates O02's rule at the pixel centre over the winning triangle's feature list. Every feature within reach of a triangle is in its list, and the snap displacement (0.003 px) is inside O02's 0.104 px margin, so every cover of a pixel lists the true nearest feature when `d* < 1`. The far-field clamp to the role constant (`d* ≥ 1`) depends on the role, but a region cover and an exterior cover of one sample both lie within the snap displacement of their exact triangles, hence within `2 × 0.003` px of the boundary, where `d* < 1`. So covers of different roles never meet in the clamped zone.
- *Joint draws.* The ST-U7 joint fill draw is the same argument over the overlay's exact partition, with its fill and stroke lists and the stroke draw's reach; the joint fill draw and the stroke draw stay two draws, each write-once on its own.
- *No legitimate self-overlap.* Every variant passes the exact partition check before publication, so no correct draw covers a sample twice on the exact geometry; E17-K1 changes nothing there. The `msaa-4x` (fringe-off) baseline draws region triangles only and also stays at most 1. Overlap between separate draws (two nodes, fill then stroke, E10-A7 (d)'s two rectangles) is unaffected, because every draw has its own reference.
- *Discard.* A fragment the shader discards (`alpha == 0`) writes nothing. A later cover of that sample evaluates the same pixel centre at `c = 0` and also discards, or writes 0 coverage.

**Realization (E17-K2).**

- **Which generations.** A generation created with the mesh pipeline option (V3 section f's `requiresMeshPipeline`) draws its main pass with a `stencil8` attachment, whether or not its mesh pipelines are later created. Its analytic pipeline is created up front, before the 4x fallback decision, with the stencil format declared (`compare: 'always'`, every op `'keep'`, `stencilWriteMask: 0`) under its own render-state key, so no pipeline in the pass is incompatible with it. A generation without the option keeps P1's pass, pipeline and keys unchanged.
- **Attachment.** `stencil8`, the scene's sample count, the target's size at 1x and 4x (at 1x it matches the presentation texture), `stencilLoadOp: 'clear'` (0), `stencilStoreOp: 'discard'`, no depth load or store op. It is created and tracked by resource accounting in `setTarget` (`bytesPerTexel: 1`), and released with the target on resize, zero size, dispose and device loss.
- **Mesh pipelines** (plain and joint), keyed by render state `premultiplied-source-over/stencil8-write-once/no-cull/triangle-list-v1`: `depthStencil = { format: 'stencil8', depthWriteEnabled: false, depthCompare: 'always', stencilFront = stencilBack = { compare: 'not-equal', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' }, stencilReadMask: 0xff, stencilWriteMask: 0xff }`. Cull mode stays `none`.
- **Reset pipeline.** A fullscreen triangle from a separate small module (`p3-mesh-stencil-reset-v0`), with a colour target of `writeMask: 0` and `compare: 'always'`, `passOp: 'zero'`. It is created inside the mesh pipelines' creation step: if it fails, the mesh path is unavailable for the generation, its tracked objects are released, and a forced 4x scene reports as it does for a mesh pipeline failure today.
- **References.** The frame's mesh draws, in encoded order, get ordinals `k = 0, 1, …`. Draw `k` sets `setStencilReference((k mod 255) + 1)`. Before draw `k` when `k > 0` and `k mod 255 = 0`, one reset draw sets every sample's stencil to 0. Draws with equal references are therefore always separated by a reset.
- **Composition.** Otherwise unchanged: P1's premultiplied source-over and paint order.
- **WGSL.** `MESH_FILL_SHADER` and its E3-recorded SHA-256 are unchanged.
- **Counters.** With the mesh path, `shaderModulesCreated` grows by 1 (reset module) and `pipelinesCreated` by 1 (main reset); with the count pass, `pipelinesCreated` grows by one more (count reset). The E10-A1 golden GPU log changes for the stated reason "E17-K2 stencil state, attachment, references and resets".

**Count pass (E10 section 5, amended).** The count pass has its own `stencil8` texture (same sample count, owned and released by the capture), count pipelines with the mesh pipelines' depth-stencil state, and the same reference sequence and reset draws (a reset pipeline for the `rgba16float` target over the same module). The count fragment never discards, so it counts covers capped at one by its own replay; its winning triangle can differ from the product's, which does not change the count. G3's "equal to 1" keeps detecting holes. G3's "at most 1" checks the replay, not the product's encoding: the product's encoding is checked by E17-A2 and by the visible-pixel checks of E17-A5.

## 4. Identity, the E11 snapshot and the stencil budget

- E11-K1 row **Renderer mesh part** gains "mesh draw state E17-K2 (write-once stencil)". The mesh packet layout version stays 0, packets are byte-identical, and the shader hash is unchanged. No fill or stroke revision and no release WASM change.
- Under E11 section 3.2 this is a "mesh part" change: its row (A01 crack report, A04, A07, A08) applies as written. E17 is an E11 snapshot precondition (E11 section 3.2, note of 2026-10-25 in #251), so every snapshot run already includes it.
- **Stencil budget (E17-K3).** E17 uses all eight stencil bits of the main pass. The architecture reserves stencil for transformed and arbitrary clips in P4 ([graphics-engine-architecture.md, Clipping](../graphics-engine-architecture.md#clipping)). The P4 clip contract must allocate the bits: for example `w` low bits for write-once with a reset every `2^w − 1` mesh draws and the rest for clip depth, or a `depth24plus-stencil8` attachment with write-once moved to a per-draw depth value. A dated note in the Clipping section records this.

## 5. Acceptance

| ID      | Check                                                                                                                                                                                                                                                                                                                                                       | Where               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| E17-A1  | Pipeline descriptors and keys: plain and joint mesh, analytic in a mesh generation, reset and count pipelines carry the depth-stencil state of section 3; a generation without the mesh option has P1's analytic pipeline with no `depthStencil` and P1's key                                                                                                | Unit                |
| E17-A2  | Encoding with a recording fake pass: the main pass has the stencil attachment (no depth ops); references follow `(k mod 255) + 1`; a reset draw precedes ordinals 255 and 510 in a 600-draw frame and nowhere else; the count pass has its own stencil texture and replays the same sequence                                                               | Unit                |
| E17-A3  | The stencil attachment is tracked and released on resize, zero size, dispose and device loss, at 1x and 4x; a reset pipeline failure leaves the mesh path unavailable with nothing tracked                                                                                                                                                                 | Unit                |
| E17-A4  | Snap model on the 1,802 gated V-4 case-variants (`pnpm e17:snap-model`): near every triangle that changes orientation, the signed cover sum equals the frame's orientation at every sample inside the snapped frame, and no sample of G3's "equal to 1" class is uncovered. Checking near those triangles is enough: elsewhere every snapped triangle keeps its orientation, so the snapped draw still partitions its region there. Reported with the model's limits (it does not clip) | Cloud, evidence     |
| E17-A5  | Headed, Chrome and Edge, DESKTOP-DKVUSAV: the section 1 fixtures at fringe-1x and fringe-4x have every sample count ≤ 1 and G3's "equal to 1" class holds. Product side: `C4/n06/T2` dpr1.5 pixel (491,268) at 4x and `C4/n06/T0` dpr1.5 pixel (492,257) at 1x are within 2/255 of the rule value. Reset path: a headed frame of 511 mesh draws (two resets) draws one rectangle at ordinals 0, 255 and 510, which share reference 1; its interior counts exactly 3 (the count pass adds across draws) and the frame shows no page or console error. The existing headed specs that draw meshes (E10, V-2, V-3, E11-U4, E2 rebaseline) pass | PC, evidence record |
| E17-A6  | `pnpm check`, `pnpm build`, `pnpm test:geometry`, unit tests                                                                                                                                                                                                                                                                                                | CI                  |

A08 itself is re-run by V-4 on the E11 snapshot. E17 makes no performance claim; A07 re-runs at the snapshot.

## 6. Risks

- **E17-R1 memory.** One more attachment of 1 B per sample (some backends store `stencil8` in a 4-byte texel; accounting records the WebGPU format size). A generation that asks for the mesh pipeline but cannot have it (device limits or a failed pipeline) still carries the attachment and the stencil analytic pipeline; its output is P1's.
- **E17-R2 cost.** One `setStencilReference` per mesh draw and one fullscreen reset per 255 mesh draws. Not measured; A07 decides.
- **E17-R3 clipping.** Clip-space clipping of far-offscreen vertices is outside the snap argument. E17-K1 still caps the count at 1; a hole stays a G3 failure attributed to O01's clipping limit.
- **E17-R4 discard and early tests.** E17-K1 relies on a discarded fragment not writing stencil, which WebGPU's pipeline semantics guarantee.
- **E17-R5 stencil budget.** P4 clips must share the attachment (E17-K3).

## 7. Units

- **E17-U1** (one pull request with this contract): sections 3 and 4 in `renderer-webgpu` (`primitive-pipeline.ts`, `mesh-pipeline.ts`, `native-primitive-scene.ts`, `frame-capture.ts`), unit tests E17-A1 to A3, the snap-model check and its record (E17-A4), the regenerated E10-A1 golden log, and dated notes in V3 section g, E10 section 5, and the Anti-aliasing and Clipping sections of `docs/graphics-engine-architecture.md`.
- **E17-U2**: the headed run E17-A5 on the PC and its evidence record.

## 8. Decisions

Recommended options auto-adopted 2026-10-25 under the user's standing instruction of 2026-10-24.

- **E17-Q1 fix location.** (a) **Recommended, adopted:** write-once stencil per mesh draw (sections 3-4); it covers region and exterior slivers under every transform. (b) A snap-aware exterior triangulation: leaves the five region-only fixtures and fails under strong anisotropy. (c) Record snapping as a stated limit: leaves a visible +22/255 error and contradicts V3-A14's "no double coverage" condition of the V3-Q1 adoption.
- **E17-Q2 what the count pass counts.** (a) **Recommended, adopted:** covers under E17-K2 replayed (E10's rule that the count pass rasterizes what the main pass rasterizes), with the product's encoding checked by E17-A2 and E17-A5. (b) Raw rasterizer covers without stencil: would keep failing G3 on a product that writes each sample once.

## 9. Review record

- **Round 1 (2026-10-25), independent reviewer: NOT READY**, two blocking items. B1: the drawn triangles do not partition the frame (empty-list exterior triangles are dropped), the far-field clamp depends on the role, and the joint draw was not covered. B2: E17 takes the eight stencil bits that the architecture reserves for P4 clips. Should-fix: S1 build order and failure handling, S2 counters and the E10-A1 golden log, S3 the A04 exemption against E11's table, S4 what the count pass measures and a product-side check, S5 WebGPU details, S6 the mesh pipeline key, S7 the fixture table and `C4/n06/T0`, S8 the self-overlap conclusion. All applied in revision 2 (sections 1, 3, 4, 5, 6). The reviewer also noted that code had been drafted in the working tree before the review; nothing was committed before it.
- **Round 2 (2026-10-25): READY.** Every round 1 item resolved. Two minor should-fix items, applied: a headed check of the reset path (E17-A5, at least 300 mesh draws) and the reason E17-A4 only scans near triangles that change orientation; E17-R1 names the memory of a generation whose mesh path is unavailable.
- **Diff review (2026-10-25), PR #260: READY.** Should-fix items applied: the reset-path check now reuses a reference across a reset (a broken reset would count 1, not 3); a failed 4x resize keeps the previous colour and stencil pair; `shaderModulesCreated` again counts every module created before a mesh failure; the count stencil's sample count is asserted. Device loss releases the attachment through dispose (not separately tested).
