# E25 contract: isolated container opacity

Status: APPROVED 2026-10-29 (recommended options auto-adopted, section 10), Full tier. It touches shared surface:

- scene validation of `RenderNodeSnapshot` containers;
- the renderer mirror options;
- a new diagnostic code exported from `packages/contracts/src/diagnostics.ts`;
- a new packet part, render passes and pipeline variants in `renderer-core` and `renderer-webgpu`.

This is rendering-track item [E25](d9-rendering-track.md#status-index) and MVP rendering need R-O ([MVP plan, section 5](mvp-editor-plan.md#5-rendering-track-needs)). MVP M4 needs it, under MVP-Q9 (a).

It lifts the P1 rule that rejects non-unit container opacity ([architecture](../graphics-engine-architecture.md#approved-p1-visual-behavior)): "Future non-unit container opacity requires isolated composition and its own implementation plan." It also settles the P4 design-gate row "interaction with container opacity" ([architecture](../graphics-engine-architecture.md#design-gates-before-later-implementation)), which P4-Q4 (a) left out of P4.

Owners:

- This file owns E25's execution order, acceptance criteria, fixtures and evidence.
- [graphics-engine-architecture.md](../graphics-engine-architecture.md#approved-p1-visual-behavior) owns the compositing model. Section 4 lists its amendment.
- The [P4 contract](p4-clip-mask.md) and the [E22 contract](d9-e22-clip-follow-ups-contract.md) own clip and mask coverage, mask textures and the mask tile set. E25 adds no clip rule.
- [mvp-editor-plan.md](mvp-editor-plan.md#m4-appearance) owns the editor half of M4: model fields, commands, projection and panel controls.

## 1. Scope

In scope:

- A `container` node with `0 < opacity < 1` draws its subtree into an offscreen layer and composites the layer once, scaled by its opacity. This is isolated group opacity. It is how Figma group opacity, SVG `<g opacity>` and CSS `opacity` on an element with children behave.
- Containers of every clip kind (`null`, `rect`, `mask`), nested isolated containers, and isolated containers inside clip and mask chains.
- `opacity: 0` on a container.
- A memory budget for layers. A layer over the budget fails closed and raises a diagnostic.

Out of scope:

- Blend modes other than source-over, and "pass-through" groups. Every non-unit container is isolated (MVP-Q9 (a)).
- Layer caching across frames (E25-Q5).
- Luminance masks, soft masks, and filters or effects on layers.
- The editor model, commands and panel. These are MVP M4 work.
- Precision claims beyond the tolerances in section 6. A04 stays as recorded.

## 2. Scene contract (shared surface)

The `RenderNodeSnapshot` type does not change. `SceneNodeBase.opacity` is already a finite number in `[0, 1]` on every node (`copyUnitNumber`). What changes is validation and the renderer options.

- **E25-S1 gate.**
  - `PrimitiveRendererService` gains the option `groups?: 'flat' | 'isolated'`. The default `'flat'` keeps today's rejection.
  - `'isolated'` requires `clips` other than `'none'`. A clipped draw inside a layer needs the clip variants, which only exist with clips; the rule keeps one shape of renderer for layers. Construction with `groups: 'isolated'` and `clips: 'none'` throws a `TypeError`, as the existing option checks do.
  - The service sets the mirror's `groupOpacity` to `'supported'` exactly when `groups` is `'isolated'`.
  - The service gains `requiresLayerPipeline`, true exactly in that case. The backend reads it at attach, as it reads `requiresClipPipeline` and `requiresPaintPipeline`.
  - With `paints: 'gradient'`, the gradient variants also get layer variants (section 4).
  - In `copyNode`, a container whose `opacity` is not 1 is `unsupported` unless `groupOpacity` is `'supported'`. Today it is always `unsupported` (scene-validation.ts, `unsupported: opacity !== 1 || …`).
- **E25-S2 depth.**
  - The *isolation depth* of a node is the number of its proper ancestors that are containers with `0 < opacity < 1` and `visible: true`.
  - A candidate scene in which any node's isolation depth is 33 or more is rejected with `unsupported-feature`.
  - This is a graph rule in `validateCandidateGraph`. It runs in the same walk as P4's clip depth, after it (E25-Q4).
- **E25-S3 compatibility.** A scene whose containers all have opacity 1 is accepted and drawn exactly as before (E25-A08). No producer changes.

## 3. Rendering semantics

Notation follows P1 D2 and P4 section 3:

- `P_n` is a leaf's premultiplied contribution in encoded sRGB, with its own opacity applied once.
- `K_n(p)` is the product of its clipping ancestors' coverages (P4-K1, P4-K2).

The rules:

- **E25-K1 isolated container.** Take a visible container `g` with `0 < α_g < 1`.
  - Let `L_g(p)` be the image that `g`'s subtree produces on a fully transparent target, in paint order. Every rule of P1 to P4, E17, E23 and E24 applies unchanged.
  - A nested isolated container inside `g` contributes its own composite in its paint position.
  - Then `g` contributes `α_g · L_g(p)`, composited source-over at `g`'s paint position. The blend is P1 D2's premultiplied blend.
- **E25-K2 clips across a layer (E25-Q2 (a)).**
  - Inside `L_g`, each leaf is multiplied by its full clip coverage `K_n`, including the clipping ancestors above `g`. This is exactly what P4-K3 does at opacity 1.
  - The composite `α_g · L_g` is not clipped again.
  - Source-over is associative, so the result tends continuously to the opacity-1 rendering as `α_g → 1`, apart from rounding. P4's clip records, mask textures and mask keys are unchanged.
  - SVG instead clips the group's result. The two models differ only on the antialiasing ramp of an ancestor clip, where translucent children of `g` overlap, and by at most the ramp's partial coverage times the overlap. In the interior of a clip (`k = 1` or `k = 0`) they agree.
- **E25-K3 opacity 0 and 1.**
  - A container with `α_g = 0` draws nothing of its subtree and reports nothing. It makes no path request, no layer and no mask pass. This is P4-K2b's rule for `visible: false`.
  - A leaf mask source's own `opacity` still does not affect its mask (P4-S2). But a mask container under an ancestor with opacity 0 draws nothing, so its source is not meshed.
  - A container with `α_g = 1` is not isolated. It draws exactly as today, with no layer.
- **E25-K4 quantization.** `L_g` is stored in the target's colour format: 8 bits per channel, premultiplied. The composite adds one rounding step per isolation level, so a value may drift from a full-precision oracle by at most 1/255 per level.
- **E25-K5 bound and culling.** A layer covers the device rectangle `B_g`, built in five steps:
  1. Take the union of the device bounds of `g`'s drawn descendants. These are P4-K5's leaf bounds after its clip culling, and nested layers contribute their own `B`.
  2. Widen the union by 1 px and intersect it with the P4-K5 chain bound of `g`'s clipping ancestors, including `g`'s own clip.
  3. Round it out to whole pixels.
  4. Move `x` and `y` down to even values and round the width and height up to even values. This keeps 2 × 2 derivative quads on the target's grid (section 4).
  5. Clamp it to the target.

  If `B_g` is empty, `g` draws nothing and costs no layer. A nested layer's `B` is clamped to its parent's `B`. Pixels outside `B_g` get no contribution from `g`: they would be transparent in `L_g` or clipped away.

## 4. Realization (E25-Q1 (a))

**Packet: the `layers` part (renderer-core).** It is optional and absent when no layer is drawn, so packets of scenes without layers are unchanged:

```ts
type LayerPacketPart = Readonly<{
  layoutVersion: 0;
  /** Post-order: every layer comes after the layers nested in it. */
  layers: readonly Readonly<{
    nodeId: string;
    opacity: number;
    /** E25-K5, in target pixels; x and y even; width and height even unless clamped (step 5 or the parent's bound). */
    bound: Readonly<{ x: number; y: number; width: number; height: number }>;
    /** Index of the enclosing layer in `layers`, or -1 for the main pass. */
    parent: number;
    /** The layer's own analytic runs and mesh draws, shaped like the packet's `draws` and `mesh.draws`. */
    draws: readonly PrimitiveDraw[];
    meshDraws: readonly MeshFillDraw[];
  }>[];
  /** Composite draws, each in its target's paint order. */
  composites: readonly Readonly<{
    layer: number;
    /** -1: the main pass; otherwise the index of the parent layer. */
    target: number;
    /** Number of the target's analytic draws that precede it, as `MeshFillDraw.position`. */
    position: number;
    /** Number of the target's mesh draws with an equal `position` that precede it; equal keys keep array order. */
    meshOrder: number;
  }>[];
  notices: readonly LayerResourceNotice[];
}>;
```

- The packet's top-level `draws` and `mesh.draws` hold only main-pass draws. A layer's draws sit in its entry, with `position` counted within the layer.
- The E10 count pass replays `mesh.draws` only. E10-A5 holds because it compares count draws with main mesh draws.
- `layers[i].opacity` is the *composite record* that E25-A04 counts.
- `composites[j].position` and `meshOrder` together fix the composite's place against analytic runs and mesh draws. Batching splits at a composite and never reorders.
- Each layer has exactly one composite, and `composites[j].target` equals `layers[composites[j].layer].parent`. The scene rejects a packet that breaks either rule. A layer draw that is clipped carries its `clipState` into the packet's `clip` part as any clipped draw does; unclipped layer draws need no clip part.

**Layer passes (renderer-webgpu).** Each layer renders into its own *layer texture*. The texture has size `B_g`, the target's format and `TEXTURE_BINDING | COPY_DST` usage, and is cleared to transparent black.

- Planning order (renderer-core): clip culling, then layer bounds (E25-K5), then the layer budget, then P4's `MaskPlan` over the content still drawn, so a dropped layer tree spends no mask budget. A mask level refused inside a layer leaves `B_g` conservative, which is harmless.
- Pass order: the frame's mask passes first, then the layers in post-order, then the main pass. Mask textures are device-aligned (P4 section 4), so a layer's draws read them unchanged.
- Each layer renders through a shared *layer tile set*, as E22-K1 and K2 do for masks:
  - a colour tile at the scene's sample count, in the target's format;
  - at 4x, a 1-sample resolve tile in the same format, with `COPY_SRC`;
  - a `stencil8` tile at the scene's sample count, for E17-K2 write-once draws, present exactly when the main pass has a stencil attachment, so every reused analytic and mesh pipeline is compatible with the tile pass.
- The tile size is `T = 1024`, E22's `P4_MASK_TILE_SIZE`. `layerTileSizeForTesting` overrides it for tests and must be even.
- Each tile is one render pass of the layer's draws:
  - The viewport origin is offset by `−(B_g.origin + tile offset)`, as E22-R1 does.
  - The tile's stencil is cleared at pass start. E17's reset rule restarts in each pass.
  - After the pass, `copyTextureToTexture` copies the 1-sample tile into the layer texture at the tile's offset.
- Tile offsets, `tw`, `th` and `B_g.origin` are all even. Every pixel is therefore shaded in the same 2 × 2 quad as in the main pass, which keeps `fwidth` and the coverage ramps equal to the opacity-1 rendering.

**Layer pipeline variants.** `@builtin(position)` is relative to the attachment. Several shaders read it:

- mesh fringe coverage (`meshCoverage`, `meshJointCoverage`, mesh-fill-shader.ts);
- the gradient position (`paintValue`, `paintContribution`, paint-pipeline.ts);
- the clip block (`clipCoverage`, clip-pipeline.ts).

A draw inside a layer tile therefore uses a *layer variant*, keyed `+layer-v0`. In every one of these reads it replaces the position by `position.xy + layerShift`, where `layerShift = B_g.origin + tile offset` is a per-pass uniform in a layer bind group at group index 3. Groups 0 to 2 keep their roles (scene, clip or empty, paint or empty); layer variants without clip or paint carry empty layouts at 1 and 2, as paint variants do at 1. `requiresLayerPipeline` requires the adapter's `maxBindGroups ≥ 4`; otherwise initialization reports the layer pipeline unavailable and non-unit container opacity stays rejected. Clip records and their `pixelShift` and `maskOffset` stay target-based and unchanged, so no per-tile clip records are needed.

The variants:

- analytic with clip;
- analytic with paint, without and with clip;
- mesh fill and mesh joint, without and with clip;
- mesh paint fill and paint joint, without and with clip.

The plain analytic module reads position only through clip and paint, so an unclipped solid analytic run inside a layer uses the plain module and needs no variant. Existing modules, keys and recorded shader hashes are unchanged (E25-A08). With `layerShift = 0` a layer variant's output equals its main-pass module's output; U3 checks this on SwiftShader (E25-A05).

**Composite pipeline.** A new pipeline, keyed `layer-composite-v0`, draws the quad of `B_child` in its target pass, which is the main pass or the parent layer's tile.

- Its fragment output is `α · textureLoad(layer, floor(position.xy) + shift − B_child.origin)`, where `shift` is the target pass's `layerShift` (0 in the main pass).
- It blends premultiplied source-over (P1 D2).
- It exists with and without a `stencil8` depth-stencil state (write mask 0, compare `always`), chosen as the primitive pipelines choose theirs (`stencilKeepState`), so it matches the pass it draws in.
- It takes a per-composite bind group: the layer texture, `α`, `B_child.origin` and `shift`.
- At a 4x scene every sample of a pixel receives the pixel's value.
- It has no clip variant (E25-K2).

**Lifetime.**

- A layer texture lives from its layer pass until the pass that composites it has been submitted. The tile set lives for the frame.
- Both are created only in frames that draw a layer and are tracked by `resource-accounting.ts`.
- They are released after the frame's submission, after a failed submission, on resize, on dispose and on device loss.
- There is no cache across frames (E25-Q5 (a)), so every frame drawn with a layer re-renders it.
- The renderer counts layer passes (`layerPasses`: one per layer, not per tile) for tests.

**Budget (E25-Q3 (a)).** A *layer tree* is a layer with no enclosing layer, together with every layer nested in it.

- Trees are planned in paint order. A tree is admitted whole when this holds:

  `Σ(width × height × 4 over the admitted trees' layers and this tree's layers) + tileBytes ≤ E25_LAYER_BYTES_MAX = 96 MiB`

  - `tileBytes = tw × th × 24` at 4x: colour 16, resolve 4 and stencil 4 bytes per pixel.
  - `tileBytes = tw × th × 5` at 1x: colour 4 and stencil 1.
  - `tw = min(T, the widest admitted layer)`, and `th` likewise.
- A tree that does not fit is not drawn. Its root container reports `render.layer-resource-limit`; its nested layers report nothing. Later trees, and nodes outside layers, are still planned and drawn.
- Figures at 3840 × 2160 and 4x:
  - A full-screen layer is 33,177,600 bytes, and the tile set is 25,165,824 bytes.
  - A tree of two nested full-screen layers fits: 91,521,024 bytes, against 100,663,296.
  - A tree of three does not fit (124,698,624), so the whole tree is not drawn.
- Mask bytes keep their own E22-K3 budget.

**Count pass (E10).** The count pass replays main-pass mesh draws only, and draws inside a layer are not counted. A08's corpus has no non-unit container opacity, so A08 is unaffected. E10's notes state that a scene with layers is outside the count pass's scope.

**Architecture amendment.**

- The P1 paragraph "P1 structural containers support transform/visibility and require opacity 1 …" gains this text: "Since E25 (2026-10-29), a container with `0 < opacity < 1` is drawn as an isolated layer composited once with its opacity (E25-K1). Clips inside the layer apply per leaf as in P4 (E25-K2). Opacity 0 draws nothing. Descendant alpha multiplication is still not a substitute."
- The P4 design-gate row's "interaction with container opacity" points to E25-K2.

Alternatives:

- (b) Multiply descendants' opacity. This is wrong where children overlap, and the architecture forbids it.
- (c) Full-target layers instead of bound-sized ones. Every layer would cost a full target.

At 1x a layer could render straight into its own texture with no tile or copy. That is a possible later optimization. E25 uses one path at both sample counts, as E22-Q1 (a) did.

## 5. Diagnostics

- **`render.layer-resource-limit`** is a new warning, exported from `packages/contracts/src/diagnostics.ts`.
  - Its context is `{ nodeId, bytes, limit }`: the tree's root container, the tree's bytes plus `tileBytes`, and the limit.
  - It is carried in the `layers` part's `notices`. The part is absent only when no layer is drawn and no notice is pending; a notices-only part has empty `layers` and `composites`.
  - It has its own queue, with the limits of `render.clip-resource-limit` (4,096 queued, 32 per frame, overflow counted).
  - It is raised once per root container, on its transition into the over-budget state. The over-budget set clears for containers that are no longer layer roots, and empties when no layer remains, as P4 U4a does for masks.
- **Isolation depth 33** has no diagnostic. The change set is rejected with `unsupported-feature` (E25-S2).

## 6. Acceptance criteria and fixtures

Evidence goes to `docs/evidence/e25/`.

**Runs.** Headed runs use the reference PC (DESKTOP-DKVUSAV) with Chrome and Edge, at DPR 1 and 2, with sample count 4 and a forced 1x, as P4 did.

**Oracle.** A CPU oracle composes section 3 in Float64 over probe sets:

- *Interior* probes are at least 2 physical px from every shape, clip and layer-bound edge.
- *Edge* probes are on shape or clip ramps.

**Tolerances.**

- Interior: 2/255, plus 1/255 per isolation level (E25-K4).
- Edge: 4/255, plus the same allowance.

**Fixtures.** The CSS surface is 512 × 320 and the camera is at home unless stated.

- **O1 overlap.** A container with opacity 0.5 holds a red rectangle (opacity 1) overlapping a blue ellipse (opacity 1). In the overlap the isolated result shows blue over red at 0.5. On named probes it differs by more than 24/255 from the descendant-multiplied result, where both shapes are drawn at 0.5.
- **O2 paths and paints.** A container with opacity 0.6 holds:
  - a filled and stroked path (joint overlay) at path opacity 0.8;
  - an E23 linear-gradient rectangle;
  - an E23 gradient path fill;
  - an E24 dashed stroke.
- **O3 nesting.** Opacity 0.5 inside opacity 0.5 inside opacity 0.8, with overlapping children at every level: isolation depth 3.
- **O4 frame.** A container with opacity 0.5 and a rectangle `clip`, rotated 30°. Its children cross the clip edge and extend far beyond it, which checks that `B_g` is bounded by the clip.
- **O5 mask group.** A mask container with opacity 0.5 and a path source with a hole.
- **O6 inside a chain.** A container with opacity 0.5 inside a rect clip and a mask, with overlapping children that cross both edges. Edge probes check E25-K2: per-leaf clip coverage inside the layer.
- **O7 extremes.**
  - A container with opacity 0 draws nothing: no layer pass and no path request.
  - A container with opacity 1 and the identity transform draws no layer. It is byte-identical to the same children placed directly under its parent.
- **O8 bound.**
  - An isolated container half off the target, at zoom 0.25 and 8, DPR 1 and 2.
  - An isolated container at an odd device offset, which checks the even origin.
  - A 2100 × 1300 CSS surface at DPR 2, where the layer spans 2 × 2 tiles.
- **O9 budget.** A 3840 × 2160 surface at 4x, with two parts:
  - A tree of three nested full-screen isolated containers is not drawn, and its root reports `render.layer-resource-limit` once. A later sibling leaf, and a later sibling tree of two nested full-screen layers, both draw.
  - With the three-layer tree reduced to two layers, the plan fits only one tree of two, so the later tree reports instead.

**Criteria.**

| ID | Criterion | Evidence |
| --- | --- | --- |
| E25-A01 | Validation. With `groups: 'isolated'`, non-unit container opacity is accepted; without it, the change set is rejected with `unsupported-feature` as today. `groups: 'isolated'` with `clips: 'none'` throws. Isolation depth 32 is accepted and 33 is rejected, also through a change set that only reparents or only changes an opacity. Hidden containers and containers with opacity 0 or 1 do not count toward the depth | Unit tests |
| E25-A02 | Layer plan. Layers are listed in post-order, with bounds per E25-K5 (even origin and size, clip-bounded). Composites have their position and `meshOrder`. Main-pass `draws` and `mesh.draws` exclude layer draws. The `layers` part is absent without layers and notices; composites satisfy the one-per-layer and target rules. Opacity 0 gives no layer and no path request. An empty bound gives no layer. The budget admits and reports per tree as section 4 states, with the O9 figures | Unit tests (renderer-core) |
| E25-A03 | O1 to O8. Interior and edge probes equal the oracle within the section 6 tolerances. O1's named probes differ from the descendant-multiplied oracle by more than 24/255 | Headed GPU spec, readback |
| E25-A04 | Invalidation. An opacity edit on an isolated container (0.5 to 0.7) costs 0 fill and stroke port calls and 0 geometry builds, and changes one composite record. Edits from 1 to 0.5 and from 0.5 to 1 also cost 0 port calls. An edit from 0 to 0.5 costs what making the same subtree visible costs. Pan and zoom cost what they cost without the container. `layerPasses` equals the number of drawn layers per frame | Unit (U2), GPU counters (U4) |
| E25-A05 | Variants and tiles. On SwiftShader, with no content under the layer and the clear colour as backdrop (so a single rounding of `L` changes nothing), three captures are byte-identical: the main pass, the same content drawn through layer variants into a layer at opacity 1 and composited (test hook `isolateUnitOpacityForTesting`, which makes an opacity-1 container a layer), and the same layer at tile size 1024 and at `layerTileSizeForTesting` 64. On hardware, every seam pixel matches the oracle within the interior tolerance | SwiftShader in the container (U3), headed spec (U4) |
| E25-A06 | Resources. Layer textures and the tile set appear in resource accounting. They are released after submission, after a failed submission, on resize, on dispose and on device loss, and accounting returns to the baseline when the isolated containers are removed. After device loss the recovered frame equals the pre-loss capture | Unit with the fake device (U3), GPU spec (U4) |
| E25-A07 | Budget. O9 as stated, with one notice per over-budget tree root on the transition, and none after the root's opacity returns to 1 | Unit (U2), headed GPU spec (U4) |
| E25-A08 | Identity, against `main` at U1's merge base. Scenes with every container at opacity 1, rendered with `groups: 'flat'` and with `groups: 'isolated'` (P4-A09's option on and off), give byte-identical frame captures, unchanged shader hashes and pipeline keys, and an unchanged E10-A1 golden log. The existing `pnpm test:gpu` passes | SwiftShader captures (U3), headed full `pnpm test:gpu` (U4) |

## 7. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | E25-S1 gate (`groupOpacity` mirror; the `groups` option and `requiresLayerPipeline` moved to U3, see the U1 record), E25-S2 depth, the diagnostic code, the architecture and E10 note amendments | E25-A01; CI |
| U2 | Rendering | Layer plan in `renderer-core`: traversal, bounds, the `layers` part, composites, opacity 0, budget, notices | E25-A02; the unit parts of A04 and A07 |
| U3 | Rendering | Layer passes, tile set, layer variants, composite pipeline, accounting and lifetime in `renderer-webgpu`; the `groups` option, its `clips: 'none'` `TypeError` and `requiresLayerPipeline` (moved from U1), with E25-A01's option-wiring cases; the test hooks `layerTileSizeForTesting` and `isolateUnitOpacityForTesting` (E10 naming rules) | E25-A05 and A08 on SwiftShader; the unit part of A06 |
| U4 | Visualization | Headed page with `groups: 'isolated'` and a spec with the CPU oracle for O1 to O9 | E25-A03, the GPU parts of A04 to A08; headed run on the reference PC |
| U5 | Rendering | Evidence index `docs/evidence/e25/` of E25-A01 to A08 | Index merged; MVP M4 may start its R-O half |

Order: U1, U2, U3, U4, U5. The WIP limit per track applies.

**Unit records.** U1 (2026-10-29):

- The mirror option `groupOpacity` (`'unsupported'` by default) carries E25-S1 into validation. A container with opacity other than 1 is `unsupported-feature` unless the option is `'supported'`.
- E25-S2 runs in P4's clip-depth walk, against `SCENE_MAX_ISOLATION_DEPTH = 32` (a `packages/contracts` export).
- `render.layer-resource-limit` is reserved in `DIAGNOSTIC_CODES`.
- The architecture's P1 paragraph and P4 design-gate row are amended, and E10 has its count-pass note.
- Tests: `tests/unit/e25-u1-group-opacity.test.ts`.
- **Departure, as P4 U1 did with `clips`:** the service option `groups`, its `TypeError` with `clips: 'none'`, and `requiresLayerPipeline` move to U3. Until layers draw, no service sets the mirror's `groupOpacity` and no shipped consumer builds a mirror with it, so non-unit container opacity stays rejected in every product path. The option's comment marks it tests-only until U2 and U3, since `PrimitiveSceneSource` does not yet draw container opacity. E25-A01's option-wiring cases are checked in U3.

## 8. Risks

- **Memory.** Bound-sized layers keep ordinary groups small. But full-screen groups at 4K and 4x admit only two nesting levels within 96 MiB (E25-Q3). Deeper full-screen stacks report instead of drawing. Two remedies are open if real documents hit this: re-rendering per tile together with the composite (no full layer texture), or a cache with eviction.
- **Working memory.** Layers (96 MiB) and masks (64 MiB) can together hold about 168 MB offscreen, on top of the main targets. At 3840 × 2160 and 4x, the multisample colour attachment alone is about 133 MB. A stress scene that maxes both budgets at 4K and 4x therefore exceeds prototype-plan constraint 4's 256 MB working-memory ceiling. E25 does not claim that ceiling for such scenes. U4 records peak accounted bytes for O9 as an observation.
- **Re-render cost.** Without a cache, every drawn frame re-renders every visible layer, tile by tile. Typical documents have few isolated groups. U4 records the cost as an observation, with no threshold.
- **Clip ramp model.** E25-K2 differs from SVG's group-result clipping on clip ramps where translucent children overlap (section 3). O6 pins the chosen model.
- **Quantization.** There is one 8-bit rounding per isolation level (E25-K4). A wider layer format is the remedy if a fixture needs it.
- **Viewport offsets.** Layer tiles move the viewport origin as E22 tiles do (E22-R1). E25-A05 checks the seams, and checks that the even origin keeps the main pass's quads.

## 9. Questions (each with a recommended option)

- **E25-Q1 realization.**
  - (a) A bound-sized offscreen layer per isolated container. Layers render through a shared tile set and layer variants before the main pass, and a new pipeline composites them (section 4).
  - (b) Descendant alpha multiplication.
  - (c) Full-target layers.

  Recommended: (a). Option (b) is wrong where children overlap, and the architecture forbids it. Option (c) costs a full target per layer.
- **E25-Q2 clips across a layer.**
  - (a) Leaves inside the layer keep their full clip coverage, including ancestors above the group, and the composite is not clipped (E25-K2).
  - (b) Only clips at or below the group apply inside the layer, and the composite is clipped by the ancestors' chain. This is SVG's group-result model.

  Recommended: (a). It is continuous with the opacity-1 rendering, leaves P4's clip records, mask chains and keys unchanged, and needs no clipped composite pipeline. The two options differ only on clip ramps where translucent children overlap.
- **E25-Q3 budget.**
  - (a) 96 MiB for layer textures and the layer tile set, with `T = 1024`. A layer tree that does not fit fails closed and reports `render.layer-resource-limit` once, on its root.
  - (b) Share P4's 64 MiB mask budget.
  - (c) No budget.

  Recommended: (a). It fits a tree of two nested full-screen 4K layers at 4x, and it keeps the mask figures (E22-K3) as approved. The working-memory risk is stated in section 8.
- **E25-Q4 nesting.**
  - (a) Reject isolation depth 33 with `unsupported-feature`, as for clip depth.
  - (b) No structural limit; the budget alone bounds it.

  Recommended: (a). Where layers are small the budget would not bound the layer passes per frame, and (a) does. It also matches P4-Q2.
- **E25-Q5 cache.**
  - (a) No layer cache across frames; every drawn frame re-renders its layers.
  - (b) Cache layers under a key of the subtree's revisions, camera, DPR and target.

  Recommended: (a). Frames are drawn only on invalidation, and a pan re-renders anyway, as masks do. A correct subtree key is a larger change than M4 needs. A cache is the remedy if U4's observation shows the need.

## 10. Decisions

- **2026-10-29, recommended options auto-adopted** under the user's standing instruction of 2026-10-24: E25-Q1 (a), Q2 (a), Q3 (a), Q4 (a), Q5 (a). The architecture's P1 paragraph and P4 design-gate row are amended in U1 (section 4). The user may reopen any of them before U1 merges.

**Review record.** Independent review (fresh context), 2026-10-29.

- Round 1: NOT READY, with three blocking findings and twelve further ones:
  - Blocking: draws in a layer read unshifted positions; the packet shape and ordering were unspecified; the budget rule disagreed with O9.
  - Further: mask offsets and frame lanes, quad parity, the clip-bounded `B_g`, 1x tile bytes, the 256 MB claim, the composite pipeline, misplaced normative rules, opacity 0, the O7 comparison, unit coverage, the diagnostic, and the A01 cases.
- Round 2: READY WITH FOLLOW-UPS (composite and tile stencil shape, A05 backdrop, clip-part rule, notices-only part, planning order, clamped sizes, bind group index 3, composite ties and redundancy, A08 option settings), all applied.
- Applied in round 1:
  - Layer variants with a per-pass `layerShift`, so clip records stay target-based.
  - The `layers` packet part with composites ordered against mesh draws.
  - A per-tree budget with one notice on the root.
  - An even, clip-bounded `B_g`.
  - The remaining findings as listed.
