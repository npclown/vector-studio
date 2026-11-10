# E41 contract: boolean path operations, drop shadows and layer blur

Status: **ADOPTED 2026-11-09** (review round 3 READY WITH FOLLOW-UPS, follow-ups applied), Full tier. The user asked for this work on 2026-11-09 (project chat, item 4 of the post-MVP gap list: "4번도 진행하자"). The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24 unless the user picks otherwise. Section 12 records the three review rounds. E41-Q1 to Q8 take option (a), 추천안 자동 채택 2026-11-09.

This is rendering-track item E41 ([D9 rendering track](d9-rendering-track.md#status-index)). Its editor units (U2, U3, U6, U7) run on the visualization track. It changes shared surface:

- the document schema (v7: an `effects` list on every node);
- the scene contract (`SceneNodeBase.effects`), scene validation, the renderer mirror options and one new diagnostic code;
- new render passes and pipelines in `renderer-core` and `renderer-webgpu`;
- new editor commands, notices, key bindings and panel controls;
- [requirements.md](../requirements.md): boolean operations, drop shadows and layer blur move from "deferred" to supported; [ARCHITECTURE.md](../../ARCHITECTURE.md): one note on the boolean engine (E41-Q2).

It adds no runtime dependency, changes no threshold of P3, E25 or E39, and changes no existing draw. Identifiers use the prefix **E41-**.

Owners: this file owns E41's order, criteria, fixtures and evidence. [graphics-engine-architecture.md](../graphics-engine-architecture.md) owns the compositing model (U4 amends it with section 5). The [E25 contract](d9-e25-isolated-opacity-contract.md) owns layers, the layer tile set and the layer budget that E41 extends. The parallel export work owns its SVG writer; section 5.7 gives the mapping it should use.

## 1. Scope

In scope:

- **Boolean operations** on two or more selected shapes: union, subtract, intersect, exclude. The result is one new path node that replaces the inputs (destructive, E41-Q1 (a)). Curves stay curves: every result segment is a piece of an input segment.
- **Drop shadow**: colour, offset, blur radius, visible toggle; up to 8 per node. **Layer blur**: radius, visible toggle; at most one per node.
- Effects on every node type: shapes, paths, lines, text, instances, groups, frames, mask groups and symbols.
- Editor commands, notices, key bindings, context-menu entries and a panel section for both features.

Out of scope (backlog, section 10): non-destructive boolean groups, inner shadow, shadow spread, background blur, blend modes, booleans on text, groups or strokes (outline stroke), path simplification, effect tiling for 4K full-screen layers.

## 2. Boolean operations

### 2.1 Inputs

- Two or more selected, visible leaves of type `rectangle` (with corner radii), `ellipse`, `path`, or `custom` with a non-null path projection (the star is `ext.star`, a custom node). They share one parent (E41-Q3 (a)), and none is a mask group's first child (the mask source).
- Every input contributes its **fill area** under its own fill rule; open subpaths are implicitly closed. Strokes are ignored, as in Figma and Illustrator Pathfinder. An input without a fill still contributes its area.
- Anything else rejects the command with no document change and the notice `editor.boolean-unsupported`.

### 2.2 Operations

Inputs in paint order, bottom first: `A₀`, `A₁`, …, `Aₙ`.

| Operation | Result region | Figma / Illustrator |
| --- | --- | --- |
| `union` | `A₀ ∪ … ∪ Aₙ` | Union / Unite |
| `subtract` | `A₀ \ (A₁ ∪ … ∪ Aₙ)` | Subtract / Minus Front |
| `intersect` | `A₀ ∩ … ∩ Aₙ` | Intersect |
| `exclude` | points covered by an odd number of inputs | Exclude |

### 2.3 Result node

- **E41-B1 geometry.** One `path` node in the shared parent, `fillRule: 'nonzero'`, `rotation: 0`, its frame and stored points set by the existing control-point renormalization ([`paths.ts` `renormalize`](../../packages/editor-core/src/paths.ts)). Every kept piece has the result on its left, so winding is 0 or 1 and `nonzero` equals `evenodd`.
- **E41-B2 style.** Fill, stroke, opacity, effects, constraints and name come from `A₀` (E41-Q4 (a)). A gradient fill of `A₀`, stored in its unit box, is re-mapped (rotation absorbed) so that it paints the same page pixels in the result's unit box. The result takes the topmost input's paint slot.
- **E41-B3 transaction.** One undoable transaction removes the inputs, inserts the result and refits ancestor groups as other structural edits do. The selection becomes the result. Undo restores inputs, order and selection.
- **E41-B4 empty result.** An empty region rejects with `editor.boolean-empty` and no change.
- **E41-B5 size.** Above 4,096 input segments or 16,384 intersections, reject with `editor.boolean-too-large` and no change.

### 2.4 Algorithm (E41-Q2 (a): TypeScript in `editor-core`)

A deterministic, synchronous module `packages/editor-core/src/boolean/` with plain-data inputs and outputs and no WASM, so commands stay synchronous. `D` is the diagonal of the union of input bounds. Two scales: `ε = 1e-9 D` (intersection refinement) and `η = 1e-7 D` (snap and coincidence).

1. **Segments.** Each input becomes closed contours of lines and cubics in parent space, using the projector's cubic arcs for radii and ellipses, with rotation applied exactly to control points.
2. **Intersections.** Cubics are first split at their x and y extrema, so that a self-crossing cubic shows up as a crossing between its pieces. Line-line in closed form; line-cubic and cubic-cubic by subdivision to `ε` (bounding boxes and fat lines; exact early exits only), then Newton refinement. Candidate points within `η` of each other (tangencies give clusters) merge into **one shared vertex**, which cuts every segment involved. Overlaps are split explicitly: each segment end point within `η` of another segment becomes a shared vertex on it, and subdivision stops on a pair of pieces, either with a bounding box larger than `4096 η`, whose five sample points each way lie within `η` of the other piece. Such pieces are **coincident**: one representative is kept for classification. If the samples change sides of the other piece, the pair crosses at a shallow angle inside the stretch: that crossing is found by bisection on the side and becomes a shared vertex. Running out of the subdivision budget fails the command (fail closed).
3. **Split.** De Casteljau cuts at the shared vertices' parameters. Pieces shorter than `η` collapse into their vertex.
4. **Classify.** Membership per input is its winding number under its fill rule, by ray crossings with exact cubic roots and the half-open rule (a crossing counts when the segment spans `[y₀, y₁)`). For the inputs that do not own the piece or a coincident copy of it, membership is evaluated at the piece's midpoint: a split piece crosses no other edge, so this is unambiguous. For the owning input and its coincident group, the winding is computed at the midpoint with the piece and its coincident copies excluded; left and right are that value plus or minus each copy's signed crossing contribution. This is exact and needs no probe distance. The piece is kept when `in(left) ≠ in(right)`, oriented with the result on its left.
   Coordinates are y-down; "left" of a direction `(dx, dy)` is `(dy, −dx)`, and "clockwise" in step 5 is in the same screen convention.
5. **Chain.** Pieces join at shared vertices (exact, no tolerance). At a vertex with four or more kept pieces, an incoming piece continues on the next outgoing piece clockwise from its reversed direction, which gives contours that touch at a point instead of self-touching ones. Directions that tie within `1e-6` rad (tangent pieces) are ordered by their chords to the points at a common small distance from the vertex. Any unpaired piece fails the command with `editor.boolean-failed` and no change (fail closed).

## 3. Effects model (schema v7)

- **E41-S1.** Every v7 node has `effects: readonly Effect[]`, default `[]`; the v6 to v7 migration adds `[]`. If another schema change (for example image nodes) merges first, E41 takes the next free version (M4's rule).
- **E41-S2.**

```ts
type Effect =
  | { kind: 'dropShadow'; visible: boolean; color: Color; offsetX: number; offsetY: number; radius: number }
  | { kind: 'layerBlur'; visible: boolean; radius: number };
```

- **E41-S3 limits.** At most 8 effects, at most one `layerBlur`. `radius` finite in `[0, 1000]`, offsets finite in `[−10000, 10000]`, `color` per the model's colour rules. Validation rejects anything else.
- **E41-S4 units.** Node-local units. Offsets rotate with the node and its ancestors; resizing does not change effects. `σ = radius / 2`, as CSS `box-shadow` and Figma define the shadow blur radius.
- A mask group's first child keeps its effects in the document but they do not render: the mask uses its fill area only (P4-S2). The panel shows them disabled.
- **E41-S10 instances.** An instance has its own `effects`. It draws with them when the list is non-empty, else with its symbol's (as an instance takes its source's fill and stroke, M7 section 4.1); detaching keeps the same rule, so a detached frame carries the effects it drew with. Expanded nodes carry the source tree's effects.

## 4. Scene contract

- **E41-S5.** `SceneNodeBase` gains optional `effects?: readonly SceneEffect[]`: the visible effects, with offsets and σ in the node's scene-local units. Scene validation adds `effects` to its key allowlists. Absent and `[]` mean no effects, under either option. A frame unit carries its effects on its outer container. Scenes without effects draw exactly as before (E41-A06).
- **E41-S6 gate.** Renderer option `effects: 'none' | 'v0'` (default `'none'`), as E25's `groups`. With `'none'`, a non-empty `effects` is rejected with `unsupported-feature`; `'v0'` requires `groups: 'isolated'`. The projector emits `effects` only when its host sets the matching projector option (off by default; next-host turns it on in U7), so documents with effects never make content disappear in hosts on `'none'`.
- **E41-S7 depth.** A visible node with a non-empty `effects` and opacity above 0 counts toward `SCENE_MAX_ISOLATION_DEPTH` as an isolating node, so E25-Q4's bound on layer passes per frame holds. A container effect root counts for its descendants, as E25-S2's containers do; a leaf effect root draws a layer of its own, so it may have at most `SCENE_MAX_ISOLATION_DEPTH − 1` isolating proper ancestors.
- **E41-S8 diagnostic.** New code `render.effect-resource-limit`, raised once per tree root on its transition into the state of section 5.4.
- **E41-S9 transforms.** σ and offsets map through the node's scene transform. Under a non-similarity transform (allowed by `SceneAffine`, never produced by the editor, whose transforms are rigid times zoom), σ uses the transform's largest singular value.

## 5. Rendering

### 5.1 Semantics

For an effect root `N` (a visible node with non-empty `effects` and `opacity > 0`), let `L` be `N`'s content including its subtree, rendered at opacity 1 and **without** ancestor clips and masks (its own clip applies to its children). Then:

1. Each visible drop shadow `i`, in list order: `Sᵢ = colorᵢ × alpha(G_σᵢ ∗ L)`, translated by its offset.
2. `R = L over Sₙ over … over S₁`.
3. With a visible layer blur: `R ← G_σ ∗ R`.
4. `R` is composited into the parent target scaled by `N.opacity`, **clipped and masked by `N`'s ancestor clip chain** (E41-Q8 (a)).

`G_σ` is the 2D Gaussian with transparent black outside the layer. A shadow shows through translucent content (E41-Q6 (a)). Opacity 0 gives no layer and no effect passes (E25-K3).

### 5.2 Effect layers

- An effect root is a layer root, leaf or container. A leaf root's own opacity is removed from its draws in `L` and applied at the composite. A container with `0 < opacity < 1` and effects is one layer, not two.
- **E41-K1 margin.** In device pixels, with `s` the transform scale: `m = ⌈3 σ_blur s⌉ + maxᵢ(⌈3 σᵢ s⌉ + |offsetᵢ| s)`, with σ after K2's clamp.
- **E41-K2 bounds.** Let `V` be the target, or for a root nested in an effect root or an E25 layer the enclosing layer's source bound, intersected with E25-K5's clip-chain bound of `N`'s ancestors up to that layer. With `b = ⌈3 σ_blur s⌉` and `C` `N`'s content bound, two rectangles, each with E25-K5's even rounding:
  - **source bound** (for `L`): `C ∩ ((V ⊕ b) ∪ ⋃ᵢ ((V − offsetᵢ) ⊕ (⌈3 σᵢ s⌉ + b)))`;
  - **output bound** (for `R` and the composite quad): `(C ⊕ m) ∩ (V ⊕ b)`.

  E25-K5's target clamp does not apply to effect roots, except when `N`'s subtree contains a mask group (mask textures are target-based): then both bounds are clamped to the target and an off-screen caster's shadow is not drawn (disclosed limit). A bound above the device's `maxTextureDimension2D` goes to section 5.4.
- **E41-K2b clips inside an effect layer.** Draws in `L` have their clip chain rebased at `N`: rect levels above `N` are dropped, and mask levels inside `N` are planned as separate `MaskPlan` levels with no parent above `N`, with their own keys, counted against the E22 mask budget and under K2's target clamp. Ancestor clips and masks of `N` apply once, at `N`'s composite (5.1 step 4): the composite carries a `clipState` like a draw, and `MaskPlan` plans that chain's mask levels for it under the E22 budget, in E25's planning order (after the layer budget, so a tree that drops its effects reverts to its leaves' original chains). If that mask level is over budget, the root is not drawn, as for content under that mask.
- **E41-K2c nesting with E25 layers.** An E25 isolated layer inside an effect root is bounded by the enclosing source bound instead of the target (E25-K5 step 5); an effect root inside an E25 layer contributes its output bound, not its content bound, to E25-K5 step 1.
- **E41-K3 culling.** Culling (`cullPrimitives`, `cullTexts`, E30's kept ranges) and path requests test each leaf of an effect root's subtree with the leaf's bound grown by `m` against the enclosing `V`. A node whose content is off screen but whose shadow reaches `V` is drawn.
- **E41-K4 blur.** Separable Gaussian, horizontal then vertical, at 1 sample, between two scratch textures. Half-width `⌈3 σ_px⌉`, at most 32 taps per side, so one level covers `σ_px ≤ 10.6`. Larger σ downsample the source by 2 per level, up to 5 levels (`σ_px ≤ 341`), blur there and upsample bilinearly. `σ_px` is clamped to 256; the frame counts clamped effects (statistics, no diagnostic).
- **E41-K5 composite.** Each root's passes accumulate into its own `R` texture (output bound): the blurred, tinted shadows at their device offsets (sampled bilinearly) in list order, then `L`, then the layer blur. Per-root `R` is needed because E25 runs all layer passes in post-order before the main pass, so shared scratch is overwritten before the parent composites. A new pipeline `effect-composite-v0` draws `R` into the parent target with `N.opacity`. Its variants are {plain, clip} × {main, layer} × {stencil, no stencil}: the clip variant carries rect clips and masks through the clip block, and the layer variant applies E25's `+layer-v0` position shift for roots inside a layer.
- **E41-K6 invalidation.** An effect edit changes composite records and pass parameters only: 0 fill or stroke port calls, 0 geometry builds. An edit that grows `m` so that a culled node comes into reach costs what making that node visible costs (as E25-A04's 0 to 0.5 case).

### 5.3 Unavailable pipeline

When the layer or effect pipeline is unavailable, effect roots draw their content without effects (as ordinary content, or as E25 layers when isolated) and `effectPipelineAvailable` reports it, as E25 U3's departure does for layers.

### 5.4 Budget

Per frame, with `Sᵣ` and `Oᵣ` the pixel areas of root `r`'s source and output bounds and 4 bytes per pixel:

- per root, `L` at `4 Sᵣ` and `R` at `4 Oᵣ`;
- shared scratch, reused root by root in post-order: two textures at the largest output area plus their downsample chain at the same area per level, `4 × (2 + 2/3) × maxᵣ Oᵣ` (blurred shadows spread past `L`, and the layer blur runs over `R`);
- E25's `tileBytes` (the tile set `L` renders through, `tw = min(T, widest admitted layer)`: at most 25.2 MB for a 1024² tile at 4x).

These count against E25's 96 MiB layer budget together with E25 layers. Admission is per tree, as E25's `planLayerBudget` does. A root whose source or output bound exceeds `maxTextureDimension2D` counts as over budget. A tree over the budget drops the effects of all its effect roots (they become ordinary layers when isolated, or draw directly), raises one `render.effect-resource-limit`, and is re-admitted under E25's rule. Figures: one full-screen root at 1920 × 1080 is 8.29 MB per texture, 63.9 MB with `R`, scratch and the tile set; `e41-cards` (50 cards of about 400 × 300 output pixels) is about 74 MB; at 3840 × 2160 one full-screen root is about 180 MB, over budget, so a full-screen effect at 4K draws without effects (disclosed; effect tiling is backlog).

### 5.5 Editor visual bounds

`visualBounds` (used today by the `createSymbol` wrap) grows a node's bound by `1.5 × radius_blur + maxᵢ(1.5 × radiusᵢ + |offsetᵢ|)` in local units. Hit testing and the selection box do not change.

### 5.6 Performance budget

On the reference PC (GTX 1660 SUPER, Chrome, 1920 × 1080, DPR 1, 4x), scene `e41-cards`: 50 cards, each with one drop shadow (radius 16), every tenth also with a layer blur (radius 8): typical-view median frame ≤ 16.7 ms and dragging one card median ≤ 16.7 ms, with effect-pass GPU time per frame as an observation. Results follow [benchmarks/README.md](../benchmarks/README.md); a miss is disclosed in the exit record and the user decides.

### 5.7 Export

PNG export through the renderer includes effects. For SVG, wrap the node in a `<g>` outside its own `clip-path` (SVG filters apply before clip) with a filter in `color-interpolation-filters="sRGB"` and `filterUnits="userSpaceOnUse"`, its region the node's bound grown by section 5.5's margin: per shadow `feGaussianBlur(SourceAlpha, stdDeviation = radius / 2)` → `feOffset` → `feFlood` → `feComposite operator="in"`, then `feMerge` of the shadows in list order and `SourceGraphic` last; a layer blur is one more `feGaussianBlur` over the merge result. Browsers may approximate the Gaussian, so this is equivalent within tolerance, not exact. Booleans need nothing: the result is a plain path.

## 6. Editor

- **Commands.** `boolean.union`, `boolean.subtract`, `boolean.intersect`, `boolean.exclude`; `effects.add` (`dropShadow` default: black at alpha 0.25, offset (0, 4), radius 8; `layerBlur` default radius 4), `effects.set`, `effects.remove`, `effects.toggle`. `effects.add` refuses past S3's limits with `editor.effect-limit`. Each is one undo step; numeric field drags coalesce as other panel fields do. With several nodes selected, add appends to each, and set or remove act on the same index of each node that has it.
- **Keys** (configurable): Ctrl/Cmd+Alt+U, S, I, X for the four booleans.
- **UI.** Context menu and property panel show the four boolean actions when the selection qualifies (2.1). The panel's "Effects" section: add (shadow or blur), per effect a visible toggle, colour, X, Y, blur, remove; "Mixed" where selected nodes differ.

## 7. Acceptance criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| E41-A01 | Schema v7: parse, validate (S2, S3, each refusal), migrate v6 → v7, serialize round trip; every v6 fixture loads | Unit (model) |
| E41-A02 | Boolean correctness on B1 to B15 and 1,000 seeded random cases (polygons, cubic blobs, rounded rects, ellipses, rotated inputs, evenodd self-crossing inputs, near-coincident edges within 10 η). On a 256 × 256 grid over the input bounds, every sample farther than `4 η` from any input edge has `in(result) = op(in(Aᵢ))` under both fill rules. Every result piece lies on an input segment within `η`; every contour is closed and encloses area (`|area| > ε × perimeter`; thin lenses between near-coincident inputs are real geometry). `boolean-failed`: 0 on B1 to B15, at most 5 per 1,000 random cases, each listed in the record and added as a fixture | Unit (editor-core) |
| E41-A03 | Commands: B1 to B5 of section 2.3, gradient re-map (page pixels equal before and after on a sampled grid), group refit, each rejection with no change and its notice, one undo step restores inputs, order and selection | Unit (editor-core) |
| E41-A04 | Boolean cost: two inputs of 512 cubic segments each with 1,000 crossings finish in ≤ 100 ms (median of 5) in the CI container | Unit with timing record under `docs/evidence/e41/` |
| E41-A05 | Effect passes against a CPU oracle: the oracle reads back `L` (test hook `effectContentForTesting`, effects off) and applies section 5.1 with exact Gaussian convolution. Fixtures F1 to F11; tolerance 3/255 per channel, 6/255 for downsampled σ (F9), excluding pixels within 1 px of a radius-0 shadow's edge | Headed GPU spec, reference PC |
| E41-A06 | Identity against `main` at U4's merge base: scenes without effects give byte-identical captures under `'none'` and `'v0'`, unchanged shader hashes and pipeline keys, an unchanged E10-A1 golden log; full `pnpm test:gpu` passes | SwiftShader (U5), headed (U7) |
| E41-A07 | Invalidation per K6; pan and zoom with effects cost no port calls; `effectPasses` counted per frame | Unit (U4), GPU counters (U7) |
| E41-A08 | Gate, depth and budget: S5 to S7 validation cases; section 5.4's formula on its figures, one notice per tree on transition, content drawn without effects over budget; section 5.3's fallback | Unit (U4, U5), headed (U7) |
| E41-A09 | Resources: effect textures in accounting, released after submission, on resize, dispose and device loss; back to baseline when effects are removed | Unit with the fake device (U5), GPU spec (U7) |
| E41-A10 | Performance per section 5.6, committed record | Benchmark record on the reference PC (U7) |
| E41-A11 | Effect commands: defaults, limits and `editor.effect-limit`, multi-select add/set/remove, coalescing, undo; visual bounds per 5.5 | Unit (editor-core) |
| E41-A12 | next-host flows: the four booleans from the context menu and keys, undo; add, edit, hide and remove a shadow and a blur from the panel; an off-screen caster draws (K3) | Headed spec `test:e41-next-host`, Chrome and Edge |

## 8. Fixtures

- **Booleans.** B1 two overlapping circles, every operation; B2 rectangle minus circle; B3 star intersect circle; B4 two rectangles sharing an edge (union: one rectangle, no seam); B5 two squares touching at a corner (union: two contours meeting at one vertex); B6 identical inputs (union = intersect = the input, exclude empty); B7 circle inside a rectangle (subtract: a hole); B8 rotated rectangles; B9 rounded rectangles; B10 an evenodd self-crossing pen path; B10b a self-crossing input whose edges cross at 1°; B11 three inputs (subtract uses `A₀`); B12 two unit circles tangent outside (union: two contours touching at one vertex; intersect: `boolean-empty`; subtract: `A₀` unchanged); B13 circles tangent inside; B14 two rectangles whose shared edge is 0.5 η apart (snapped as coincident: union is one rectangle, no seam); B15 two rectangles crossing at 1°.
- **Effects.** F1 shadow on a rectangle; F2 the same rotated 30°; F3 layer blur on a group; F4 three shadows of different colours and offsets; F5 shadow under a 50 %-alpha fill; F6 shadowed child in a clipping frame, offset past the clip edge (clipped, per 5.1 step 4); F7 shadow on text; F8 shadow, layer blur and opacity 0.5; F9 zoom 8 with radius 40 (`σ_px` 160, 4 levels); F10 caster off screen, shadow on screen; F11 shadowed child of a mask group; F12 a shadowed group inside a clipping frame that contains a mask group (K2b: the shadow is built from unclipped content, then clipped once).

## 9. Open choices (recommended option first)

- **E41-Q1 boolean kind.** (a) destructive: one path replaces the inputs, undo restores them; Illustrator Pathfinder, and schema, renderer and export stay unchanged. (b) a non-destructive boolean group, Figma's default; backlog.
- **E41-Q2 engine place.** (a) TypeScript in `editor-core`: synchronous commands, exact cubic pieces; an edit-time operation, not a render-path geometry request, recorded in ARCHITECTURE.md. (b) a new geometry-port request in the Rust kernel (asynchronous, and its arrangement code works on flattened edges).
- **E41-Q3 different parents.** (a) reject. (b) move the result into the topmost input's parent.
- **E41-Q4 result style.** (a) bottom input `A₀`. (b) topmost input.
- **E41-Q5 effect set.** (a) drop shadow and layer blur. (b) also inner shadow and background blur now.
- **E41-Q6 shadow under translucent content.** (a) visible, as CSS `drop-shadow()` and the SVG mapping of 5.7. (b) knocked out under the content.
- **E41-Q7 over budget.** (a) draw content without effects plus a notice. (b) draw nothing (E25's rule).
- **E41-Q8 ancestor clips.** (a) clip the composite (Figma, SVG): a shadow never leaks past a clipping frame, needing clip and mask variants of the effect composite. (b) E25-K2's per-leaf clips inside the layer, so a shadow can fall outside its frame's clip.

## 10. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | This contract; requirements.md, ARCHITECTURE.md note (Q2), track rows | Independent review READY |
| U2 | Visualization | Boolean engine `editor-core/src/boolean/`, B1 to B15, random corpus, cost record | E41-A02, A04; CI |
| U3 | Visualization | Boolean commands and notices, keys, context menu and panel buttons | E41-A03, the boolean half of A12 |
| U4 | Rendering | Schema v7 and migration, projector `effects` behind its option, `SceneEffect`, validation (S5 to S7, S9), diagnostic, layer plan for effect roots (K1 to K3, K2b rebased clip chains, K6), budget, architecture amendment | E41-A01, A07, A08 unit parts |
| U5 | Rendering | Blur, downsample and effect composite passes with clip and mask variants, fallback, accounting, `effectPasses`, `effectContentForTesting`, SwiftShader captures | E41-A06, A09 on SwiftShader |
| U6 | Visualization | Effect commands and visual bounds in `editor-core` | E41-A11 |
| U7 | Visualization | Effects panel, projector option and renderer `effects: 'v0'` on in next-host and `webgpu-host`, headed page and spec with the CPU oracle, cards benchmark | E41-A05, A08, A10, A12 on the reference PC |
| U8 | Rendering | Evidence index `docs/evidence/e41/`, exit record | Index merged; user accepts |

U2 and U4 can run in parallel; U3 follows U2; U5 and U6 follow U4; U7 follows U3, U5 and U6.

**Backlog after E41:** non-destructive boolean groups, booleans on strokes and groups, inner shadow, spread, background blur, blend modes, effect tiling (4K full-screen effects), effect-layer caching for still frames, off-screen shadows inside mask groups.

## 11. Risks

- **Boolean robustness.** Near-tangent cubics and almost-coincident edges are where curve booleans break. Shared vertices, `η` snapping and fail-closed chaining keep the document safe; A02 bounds the failure rate.
- **Effect cost.** Each shadow costs two blur passes over its layer, and a dragged node re-renders its layer every frame. Section 5.6 measures it; caching is backlog.
- **Memory.** Section 5.4: 4K full-screen effects draw without effects until effect tiling.

## 12. Review record

- Round 1 (2026-11-09, independent reviewer): NOT READY. B1 ancestor clips: E41-Q8 (a), clipped composite with clip and mask variants, K2 bounds and the mask-group clamp. B2 blur levels: 5 levels, clamp 256, F9 re-stated. S1 budget formula and per-tree admission (5.4). S2 margin and texture limit (K1, K2). S3 culling (K3, K6). S4 leaf and container roots (5.2). S5 depth (S7). S6 oracle from `L` readback (A05). S7 SVG mapping rewritten (5.7). S8 scene gaps (S5, S6, S9, 3, 5.3). S9 visual bounds (5.5). S10 names. S11 to S13 tolerances, shared vertices, chaining, thresholds (2.4, A02, B12 to B14). S14 command cases (2.1, B1 to B3). S15 ARCHITECTURE note in U1, projector option, U6 effect commands (A11). Nits applied: phase cell, open subpaths, σ wording, MVP plan pointer.
- Round 2 (2026-11-09): NOT READY. Fixed: 1 K2 split into source and output bounds, nested `V`; 2 K2b rebased clip chains, F12; 3 per-root `R` always (K5), 5.4 figures; 4 composite variant matrix; 5 midpoint membership for non-owning inputs; 6 overlap end points restored; 7 texture-size limit in 5.4; 8 tile set in 5.4; 9 SVG filter region; nits 10 to 13 (handedness, B14 result, B15, renderer option in U7, phase cell `Fix`).
- Round 3 (2026-11-09): READY WITH FOLLOW-UPS, all applied: scratch sized to the output area (5.4); exact owning-input classification without probes (2.4 step 4), B10b; the composite's `clipState` and mask planning (K2b); E25 nesting rule (K2c); per-leaf cull test (K3); tile figure as a cap (5.4).
- U2 amendments (2026-11-09, from the U2 engine review): 2.4 step 2 states the monotone split, subdivision for line-cubic, the coincidence scale, the side-change bisection and budget failure; step 5 states the tie-break; A02 replaces "area above `η D`", which genuine near-coincident lenses fail, with `|area| > ε × perimeter`. U2 re-review: READY WITH FOLLOW-UPS, applied (coincidence-scale wording, bisection leaving the η band subdivides, one chord frame in the tie-break, bounds overflow fails, extra fail-closed cases recorded).
- U4a amendments (2026-11-09): U4 lands in two parts. U4a is schema v7 and its migration, `SceneEffect` and its validation (S5 to S7), the diagnostic code (S8), the mirror option `effects` (tests only, as E25's `groupOpacity` was before its U3) and the projector option (`EditorOptions.projectEffects`, off by default). U4b is the layer plan for effect roots (K1 to K3, K2b, K6), the budget and the service option `effects`, with S9 since it is applied where σ reaches device pixels. Added E41-S10 (instances; a detached paste follows it as `detachInstances` does), and S7 now states the leaf effect root's own layer. A hand-built scene whose mask source carries effects still counts that source as isolating (S7 is conservative there; the projector never emits it). The mirror option does not yet check S6's `groups: 'isolated'` requirement; the U4b service option does. Schema v7 changes every committed document digest built from v6 values: the E26 v1 and M9 v2 configuration hashes, the M9 v2 digest and the view-edit hash are re-pinned with a note at each pin.
- U4b amendments (2026-11-09):
  - **Leaf roots.** A leaf root's draws in `L` keep its opacity α, and its composite is at opacity 1. U5 builds `R` with shadows weighted under `L` by `1 − a_L/α`, which equals 5.1's result for `L` at opacity 1 scaled by α. So dropping its effects needs no re-pack: the leaf draws directly. A leaf root's layer scope is built by a full derivation only (a leaf-only set that touches a node with effects derives in full).
  - **K3 in world units.** Each leaf under effect roots is culled by its bound grown by the roots' summed reach `3 σ_blur + maxᵢ(3 σᵢ + |offsetᵢ|)` in world units (σ by the largest singular value, no clamp), tested against the outermost root's ancestor clip chain. Device rounding of K1's terms can add up to about 3 px past this reach, all beyond 3σ, which is negligible. This applies to primitives, text and path requests.
  - **Budget.** The scratch term is counted at the largest admitted output area. A tree that drops its effects keeps its isolated scopes as E25 layers and dissolves the others into their nearest drawn ancestor. Each top-level isolated scope is then admitted as its own E25 tree, with E25's notice on that scope. `maxTextureDimension2D` comes from a source option, which defaults to 8192 until the backend passes the device limit (U5).
  - **Deferred to U5, with the passes.** K2b (rebased clip chains in `L` and the composite's `clipState` and mask levels) and the `effectPipelineAvailable` report. Until then the packet carries each drawn root's `effect` record with its source and output bounds. The layer's `bound` is the source bound clamped to the target and to its parent, as E25-K5 clamps, so backends composite the root as an E25 layer of its content (5.3). A root whose clamped bound is empty is not in the packet.

- U5a amendments (2026-11-09): U5 lands in two parts. U5a is the effect passes (K4, K5), `effectPipelineAvailable`, `effectPasses`, the `effectContentForTesting` hook, the device texture limit and the SwiftShader check, on the packet as U4b emits it. U5b is K2b (rebased clip chains in `L`, the composite's `clipState` and mask levels, the composite's clip variants) and the unclamped source and output bounds of K2, which need layer passes whose attachment is not inside the target.
  - **Bounds in U5a.** `L` is the layer's `bound` (the source bound clamped to the target and to its parent, as U4b emits it). `R` is the output bound clamped to the target and to its parent layer's bound; a root whose clamped output is empty has no passes and no composite. Until U5b, content just outside the target does not cast its shadow or blur into it, and draws in `L` keep their ancestor clips, so a shadow can reach up to its blur reach past an ancestor rect clip or mask.
  - **Passes.** One module (`e41-effect-v0`) with five single-sample pipelines: downsample, blur and upsample replace their attachment, tint and merge blend over it. Each shadow's alpha is downsampled by 2 per level while K4 needs it, blurred horizontally then vertically between two shared scratch textures and tinted over `R` at its device offset, sampled bilinearly. Then `L` is merged over `R`, and a layer blur runs over `R` in the same way. Every region is planned on the CPU (`planEffectPasses`) so that each pixel of `R` reads exactly what section 5.1 with K4 reads; a texel outside a source's region is transparent.
  - **Leaf roots.** The tint and merge passes scale by `1/c` for a leaf root's content opacity `c`, and the composite draws `R` at the layer's opacity times `c`. This is U4b's `1 − a_L/α` weighting written so that it needs no blend constant.
  - **Composite.** `R` is drawn by E25's composite pipeline at `R`'s bound; K5's `effect-composite-v0` with its clip and layer variants arrives with K2b in U5b.
  - **Scratch.** A root's passes need at most `(W + 2) × (H + 2r + 2)` scratch texels for an output of W × H and a blur half-width r at its level, up to about twice the output area when H is near 2r, which is above section 5.4's term. Roots run one after another, so scratch pairs are shared: largest roots first, a root takes the first pair that fits it, or that fits it when grown to both extents within twice the larger area, else a new pair. Similar roots share one pair, and a wide and a tall root never make one texture of both extents. A root whose scratch would pass `maxTextureDimension2D` draws without effects and without a notice (the packet's budget had admitted it). σ below 0.001 device pixels counts as 0, and a shadow farther from `R` than its blur reach plus 2 px is skipped (downsampled blurs spread under 0.03/255 beyond that). The backend passes the device's `maxTextureDimension2D` to the source on `PrimitiveTarget`, for a source that asks for the effect pipeline (`requiresEffectPipeline`).
  - **Test hook.** `effectContentForTesting` (backend option) composites each effect root's `L` instead of `R`. The A05 oracle reads `L` back by drawing it over black and over a white backdrop.
- U5b amendments (2026-11-09): U5b is split again, decided under the user's standing instruction of 2026-10-24 (recommended option). U5b is K2's unclamped bounds (an off-target caster's shadow and blur reach the target); U5c is K2b (rebased clip chains in `L`, the composite's `clipState` and mask levels) with K5's `effect-composite-v0` and its clip variants.
  - **Shifted layer variants.** E25's layer variants keep each vertex stage and map a layer tile through a target-sized viewport at −shift, so clip space is the target and content past it is clipped. An effect root and every layer inside it draw their tile passes with shifted variants instead (`shifted-layer-pipeline.ts`, suffix `+shift-v0`). Each vertex stage maps a target pixel `p` to clip space as `2 (p − layerPass.shift) / layerPass.size − 1` (y flipped), with the viewport at (0, 0) and the tile's size, and the pass record's size is the tile's. Fragment reads of the position add `layerPass.shift` as E25's do, so fragments see target pixels at any distance from the target. Rect clips, paint and text shade as in the main pass, and a mask texel past the target reads as outside the mask (coverage 0), as content under a mask past the target is not drawn. The source rewrite throws (at module load, caught by the unit tests) if a module maps no vertex, maps one twice or still reads the target size.
  - **Pipelines.** The set is created with the effect pipeline, never on the frame path, and a failure leaves the effect pipeline unavailable (section 5.3). A shifted variant exists exactly where E25's layer variant does, plus the plain analytic one and the four stencil pass pipelines over the plain mesh module: with every path, 11 modules and 47 pipelines (the composite, four analytic, per mesh module a fill, a joint and seven covers, four stencil passes, two text). Their layouts have groups 0 to 3, so the empty groups are bound before the plain analytic and stencil draws in a shifted pass. E25's set is unchanged, and scenes without effect roots never draw with the shifted set (A06).
  - **Bounds.** A backend with the shifted variants sets `PrimitiveTarget.offTargetEffectLayers`. The source then emits an effect root's bound as its source bound and the bound of a layer inside it as K2c's, each inside its drawn parent's bound but not clamped to the target. Without the flag, bounds stay clamped as in U4b. Past the target, a bound stops at `E41_LAYER_REACH_MAX` (2^17 device pixels) on every side, where the shifted variants' binary32 arithmetic is still exact to 1/32 pixel; content beyond it casts nothing (at zoom 256 and DPR 2 that is about 256 scene units). The backend accepts a bound past the target only for such a layer, with each side at most `maxTextureDimension2D` and within that reach. `R` is the output bound inside the target for a root composited in the main pass, else inside its parent layer's bound. K2's mask-group clamp is unchanged. Ancestor rect clips and masks still apply in `L` until U5c.
  - **Cost.** The shifted set adds 47 pipelines to the scene's creation when the effect pipeline is requested, created one after another like the other sets; their compile time on the reference PC is an observation for U7, which may create them concurrently.
  - **Coverage.** The SwiftShader check draws analytic leaves and a nested E25 layer in shifted passes. Mesh paths (stencil, joint and covers), text, clipped and painted draws in a shifted pass are not yet drawn by any GPU test (their layouts and binds follow E25's, checked by review); U7's headed run adds a fixture with them.
- U5c amendments (2026-11-10): K2b and K5's composite clip variants.
  - **Rebased chains.** With `offTargetEffectLayers` set (the backend draws the effect passes), the source rebases the clip chain of every draw inside a drawn effect root at the innermost such root: the levels of the root's ancestors (its `outerChain`, a prefix of every chain under it) are dropped, and the root's own clip and every level inside it stay. A mask level left in a rebased chain takes a level id of its own (`e41`, NUL, the length-prefixed root id, the container id), so its texture is planned apart from the container's own level, with no parent above the root, under the E22 budget. A rebased chain is kept per chain object and root, so the clip-state table and the mask plan see one object per rebased chain, and the frame's resolver is kept while the drawn roots are the same scopes, so the mask plan's reuse holds across frames. An E25 layer inside an effect root is bounded by its chain rebased at the innermost root (K2c's bound no longer stops at the root's ancestor clips), so content past an ancestor clip whose shadow falls inside it is in `L`. That bound is taken at the innermost effect root whether or not the root is drawn and whether or not the backend rebases, so it is never smaller than needed but can be larger (counted against the E25 layer budget); passing the drawn roots and the flag into the layer plan is a follow-up. Without the flag, chains are as before and a root composites as an E25 layer of its clipped content (5.3).
  - **Composite clip state.** An effect root's composite carries `clipState`: its `outerChain` rebased at the drawn root around it (unrebased at top level), so nested roots apply each clip once. Only an effect root's composite carries one; the backend checks it as a draw's state. The composite chains are planned in the mask plan before the content, and content is drawn only when the composite chain of every drawn root around it is admitted; a root under an undrawable level (over budget, empty) has no content and an unclipped composite; its layer entry stays, and its passes run on an empty `L` and draw a transparent `R` (a cost only in that rare case). This orders the composite levels before the content levels in the budget, not in strict paint order.
  - **Pipelines.** The plain composite stays E25's. The clip variant `e41-effect-composite-v0+clip-v0` is E25's composite module with its fragment entry wrapped by P4's clip block at the target pixel (`input.position.xy + layerPass.shift`), layout groups 0 (composite), 1 (clip), 2 (empty) and 3 (layer); one module serves the main pass and E25 layer passes, and its shifted form (`+layer-v0+shift-v0`) a root inside a root. Both are created with the shifted set when the clip variants exist (2 modules and 2 pipelines more: 13 and 49 with every path) and fail with it. Without the clip variants a clipped composite is not drawn (fail closed, as a clipped draw).
  - **Coverage.** The SwiftShader check adds F6 (a shadow past a clipping frame), F11 (a shadowed child of a mask group) and F12 (a mask group in a shadowed group in a clipping frame), each against the oracle on the unclipped `L` with the clip applied once to `R`. The over-budget composite chain is checked by a unit test. The clip-variant composite in a stencil pass (a frame with mesh paths) is created by the same stencil rule as E25's composite but not yet drawn by any test; U7's headed fixture adds it.

- U3a amendments (2026-11-10): U3 is split, decided under the user's standing instruction of 2026-10-24 (recommended option). U3a is the editor-core command, the key action and E41-A03; U3b is the context menu and panel buttons, the notice copy in the hosts and the boolean half of A12 (headed).
  - **Command surface.** Section 6's four commands are one document command, `booleanNodes { ids, op }` with `op` one of `union`, `subtract`, `intersect`, `exclude`, and one built-in key action, `boolean { op }`, bound by default to Mod+Alt+U, S, I and X. The action runs on the selection; an empty selection does nothing.
  - **Failure order.** `editor.invalid-command` (`/ids` not a list of distinct strings, `/op`), `editor.unknown-node`, then `editor.boolean-unsupported` (fewer than two inputs, different parents, a mask source, a hidden input or one that is not a 2.1 type), then the engine's `editor.boolean-empty`, `editor.boolean-too-large` and `editor.boolean-failed`. Every check runs before an ID is drawn, as for `groupNodes`.
  - **Selection.** The command selects its result when run directly as well as through the key action, as `paste` does. A result on a page other than the active one is not selected. Its history step records the selection before and after, and undo and redo restore it (filtered to the active page); other steps keep today's behaviour. Inside a gesture's `update` or `replace`, as for `groupNodes`, the command neither selects nor records a selection.
  - **Frame.** B1's renormalization of points in the parent's space at rotation 0 is `fitPoints(points, 0)` (`geometry.ts`), the bounding box of the points; it equals `renormalize` there up to the sign of a zero frame origin, which serializes as 0.
  - **Custom inputs.** The edit rules gain an optional `geometry(node)` (the extension registry's), the frame-local path of a custom node; without it a custom node is not an input.
  - **Re-map.** With `U` a node's unit box to its parent's space, a gradient transform `G` of `A₀` becomes `U_result⁻¹ · U_A₀ · G`. A gradient stroke is re-mapped the same way. When the product is not invertible (a zero-size `A₀`, which paints no area), the gradient keeps its own transform.
- U3b amendments (2026-11-10): the hosts' boolean actions.
  - **UI.** `ui`'s `boolean-model.ts` decides 2.1's qualification without the custom geometry (a custom node without a path reaches the command, which refuses it). The top toolbar (`EditorToolbar`) shows four icon buttons (`boolean-<op>`) after delete, disabled until the selection qualifies (requested by the user on 2026-11-10); the context menu shows a group of four items (`context-boolean-<op>`) after the grouping items, and the property panel a "Boolean" section with four buttons (`property-boolean-<op>`), only for a qualifying selection; each shows its `boolean { op }` chord.
  - **Notices.** A refused boolean shows a sentence instead of its code: in the context menu's refusal and the property panel's. Other refusals keep their code.
  - **A12, boolean half.** `pnpm test:e41-next-host` (`playwright.e41-studio.config.ts`, the studio page) runs each of the four booleans from the context menu, from its key (Mod as `ControlOrMeta`) and from the toolbar, each undone, the panel button and a refusal notice. U7 adds the effects half to the same config. The headless smoke project passes in the container; the headed Chrome and Edge run is on the reference PC.
- U6 amendments (2026-11-10): the effect commands and visual bounds.
  - **Commands.** Section 6's four commands are three document commands: `addEffect { ids, kind }`, `setEffect { ids, index, patch }` and `removeEffect { ids, index }`. `effects.toggle` is a `setEffect` with a `visible` patch; the panel (U7) picks the value. Each runs on nodes of the active page as `setStyle` does and is one undo step; a change of no value records no step.
  - **Multi-select.** `addEffect` appends to every listed node, and if any one of them is at S3's limit (8 effects, or a second layer blur), the whole command refuses with `editor.effect-limit` at that node's `/effects`. `setEffect` and `removeEffect` act on the effect at `index` of each listed node that has one. A patch key applies to the effects of a kind that has it (`color`, `offsetX` and `offsetY` to shadows only). It is `editor.invalid-command` at `/patch/<key>` when no such effect has the key, and at `/index` when no listed node has an effect there. A value outside S3's range fails the model's check at the node's effect.
  - **Visual bounds.** `|offsetᵢ|` in 5.5 is `max(|offsetX|, |offsetY|)`, since the box grows by the margin on every side. Hidden effects do not count, and an instance without effects of its own takes its symbol's (S10). `visualBounds` grows a group by its children's, effects included, so `createSymbol`'s wrap and export's bounds cover the effects.
  - **Review follow-ups.** "No change" is decided after the model's normalization, so the same colour with its keys in another order records no step. A11's coalescing belongs to the panel (U7): a field commits one `setEffect` per committed value, and a drag would use `setEffect` too, since `addEffect` and `removeEffect` repeat on each gesture `update`, as `duplicateNodes` does. A mask source's effects still count toward its group's visual bounds although they do not render, a safe overestimate. Export's bounds grow with effects before export draws them (5.7, a V-30 follow-up), so until then an exported shadowed node has transparent padding.
- U7a amendments (2026-11-10): U7 is split, decided under the user's standing instruction of 2026-10-24 (recommended option). U7a is the host wiring, the panel's Effects section and the effects half of A12. U7b is the headed GPU work on the reference PC: A05 against the CPU oracle (with the shifted-pass mesh, text and stencil-pass clip fixtures U5b and U5c left to U7), A06 headed, A07 and A09 counters, A08 headed, and the `e41-cards` benchmark (A10).
  - **Hosts.** `@vector-studio/webgpu-host`'s `editorRendererOptions` adds `effects: 'v0'`, so every editor renderer built from the package accepts effects. A renderer on 'v0' draws scenes without effects as on 'none' (A06), so a host whose editor does not project effects draws as before. next-host's editor turns on `projectEffects`. The effect pipelines are created with the scene's other pipelines; their creation time on the reference PC is a U7b observation.
  - **Panel.** The property panel's "Effects" section (`ui`'s `effects-model.ts`) shows two add buttons (`effects-add-shadow`, `effects-add-blur`) and one row per effect index up to the longest selected list (`effect-<i>`, `data-kind` is the shared kind or `mixed`). A row covers the selected nodes with an effect at that index. Each row has a visible checkbox (`effect-<i>-visible`), and for shadows a hex colour field, a picker and an opacity field in percent. It then has X and Y (shadows only), blur (the `radius`) and remove (`effect-<i>-remove`). Each field is labelled "Effect <i+1> <field>". A field shows "mixed" where the row's nodes differ. The toggle shows every node's effect when any is hidden, else hides them. A field commits one `setEffect` per committed value (Enter or blur), so there are no drags to coalesce. A refused add shows "A layer takes at most 8 effects and one layer blur". With a mask source selected, the section is disabled and notes that a mask's effects do not show (section 3).
  - **A12, effects half.** `tests/e41-next-host/e41-effects.spec.ts` in the same config does the following from the panel: adds a shadow (the defaults), edits each field, hides and shows it, adds and widens a blur, is refused a second blur, and removes both with each removal undone. Each step is checked in the document and in the presented frame (E10 capture). The caster left of the view, whose shadow falls inside it, draws (K3) with no `render.effect-resource-limit`. The smoke project now uses SwiftShader WebGPU, so the pixel probes run in the container too when the geometry WASM is built; without the WASM the smoke run records them as not checked.
