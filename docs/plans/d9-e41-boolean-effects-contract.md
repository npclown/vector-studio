# E41 contract: boolean path operations, drop shadows and layer blur

Status: **DRAFT 2026-11-09, review round 3**, Full tier. The user asked for this work on 2026-11-09 (project chat, item 4 of the post-MVP gap list: "4번도 진행하자"). The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24 unless the user picks otherwise. Review rounds 1 and 2 (NOT READY) are applied; section 12 records them.

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

A deterministic, synchronous module `packages/editor-core/src/boolean/` with plain-data inputs and outputs and no WASM, so commands stay synchronous. `D` is the diagonal of the union of input bounds. Three scales: `ε = 1e-9 D` (intersection refinement), `η = 1e-7 D` (snap and coincidence), `δ = η / 4` (probe distance).

1. **Segments.** Each input becomes closed contours of lines and cubics in parent space, using the projector's cubic arcs for radii and ellipses, with rotation applied exactly to control points.
2. **Intersections.** Line-line in closed form; line-cubic by the cubic's roots on the line; cubic-cubic by bounding-box subdivision to `ε`, then Newton refinement. Candidate points within `η` of each other (tangencies give clusters) merge into **one shared vertex**, which cuts every segment involved. Overlaps are split explicitly: each segment end point within `η` of another segment becomes a shared vertex on it, and subdivision stops on a pair of pieces whose five sample points lie within `η` of each other. Such pieces are **coincident**: one representative is kept for classification.
3. **Split.** De Casteljau cuts at the shared vertices' parameters. Pieces shorter than `η` collapse into their vertex.
4. **Classify.** Membership per input is its winding number under its fill rule, by ray crossings with exact cubic roots and the half-open rule (a crossing counts when the segment spans `[y₀, y₁)`). For the inputs that do not own the piece or a coincident copy of it, membership is evaluated at the piece's midpoint: a split piece crosses no other edge, so this is unambiguous. For the owning input and its coincident group, membership is evaluated at probes `±δ` along the midpoint normal (where the tangent vanishes, the chord direction). The piece is kept when `in(left) ≠ in(right)`, oriented with the result on its left.
   Coordinates are y-down; "left" of a direction `(dx, dy)` is `(dy, −dx)`, and "clockwise" in step 5 is in the same screen convention.
5. **Chain.** Pieces join at shared vertices (exact, no tolerance). At a vertex with four or more kept pieces, an incoming piece continues on the next outgoing piece clockwise from its reversed direction, which gives contours that touch at a point instead of self-touching ones. Any unpaired piece fails the command with `editor.boolean-failed` and no change (fail closed).

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

## 4. Scene contract

- **E41-S5.** `SceneNodeBase` gains optional `effects?: readonly SceneEffect[]`: the visible effects, with offsets and σ in the node's scene-local units. Scene validation adds `effects` to its key allowlists. Absent and `[]` mean no effects, under either option. A frame unit carries its effects on its outer container. Scenes without effects draw exactly as before (E41-A06).
- **E41-S6 gate.** Renderer option `effects: 'none' | 'v0'` (default `'none'`), as E25's `groups`. With `'none'`, a non-empty `effects` is rejected with `unsupported-feature`; `'v0'` requires `groups: 'isolated'`. The projector emits `effects` only when its host sets the matching projector option (off by default; next-host turns it on in U7), so documents with effects never make content disappear in hosts on `'none'`.
- **E41-S7 depth.** A visible node with a non-empty `effects` counts toward `SCENE_MAX_ISOLATION_DEPTH` as an isolating node, so E25-Q4's bound on layer passes per frame holds.
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
- **E41-K2b clips inside an effect layer.** Draws in `L` have their clip chain rebased at `N`: rect levels above `N` are dropped, and mask levels inside `N` are planned as separate `MaskPlan` levels with no parent above `N`, with their own keys, counted against the E22 mask budget and under K2's target clamp. Ancestor clips and masks of `N` apply once, at `N`'s composite (5.1 step 4).
- **E41-K3 culling.** Culling (`cullPrimitives`, `cullTexts`, E30's kept ranges) and path requests use, for an effect root's subtree, the content bound grown by `m`. A node whose content is off screen but whose shadow reaches `V` is drawn.
- **E41-K4 blur.** Separable Gaussian, horizontal then vertical, at 1 sample, between two scratch textures. Half-width `⌈3 σ_px⌉`, at most 32 taps per side, so one level covers `σ_px ≤ 10.6`. Larger σ downsample the source by 2 per level, up to 5 levels (`σ_px ≤ 341`), blur there and upsample bilinearly. `σ_px` is clamped to 256; the frame counts clamped effects (statistics, no diagnostic).
- **E41-K5 composite.** Each root's passes accumulate into its own `R` texture (output bound): the blurred, tinted shadows at their device offsets (sampled bilinearly) in list order, then `L`, then the layer blur. Per-root `R` is needed because E25 runs all layer passes in post-order before the main pass, so shared scratch is overwritten before the parent composites. A new pipeline `effect-composite-v0` draws `R` into the parent target with `N.opacity`. Its variants are {plain, clip} × {main, layer} × {stencil, no stencil}: the clip variant carries rect clips and masks through the clip block, and the layer variant applies E25's `+layer-v0` position shift for roots inside a layer.
- **E41-K6 invalidation.** An effect edit changes composite records and pass parameters only: 0 fill or stroke port calls, 0 geometry builds. An edit that grows `m` so that a culled node comes into reach costs what making that node visible costs (as E25-A04's 0 to 0.5 case).

### 5.3 Unavailable pipeline

When the layer or effect pipeline is unavailable, effect roots draw their content without effects (as ordinary content, or as E25 layers when isolated) and `effectPipelineAvailable` reports it, as E25 U3's departure does for layers.

### 5.4 Budget

Per frame, with `Sᵣ` and `Oᵣ` the pixel areas of root `r`'s source and output bounds and 4 bytes per pixel:

- per root, `L` at `4 Sᵣ` and `R` at `4 Oᵣ`;
- shared scratch, reused root by root in post-order: two textures at the largest source area plus their downsample chain, `4 × (2 + 2/3) × maxᵣ Sᵣ`;
- E25's `tileBytes` (the tile set `L` renders through: 25.2 MB for a 1024² tile at 4x).

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
| E41-A02 | Boolean correctness on B1 to B15 and 1,000 seeded random cases (polygons, cubic blobs, rounded rects, ellipses, rotated inputs, evenodd self-crossing inputs, near-coincident edges within 10 η). On a 256 × 256 grid over the input bounds, every sample farther than `4 η` from any input edge has `in(result) = op(in(Aᵢ))` under both fill rules. Every result piece lies on an input segment within `η`; every contour is closed and has area above `η D`. `boolean-failed`: 0 on B1 to B15, at most 5 per 1,000 random cases, each listed in the record and added as a fixture | Unit (editor-core) |
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

- **Booleans.** B1 two overlapping circles, every operation; B2 rectangle minus circle; B3 star intersect circle; B4 two rectangles sharing an edge (union: one rectangle, no seam); B5 two squares touching at a corner (union: two contours meeting at one vertex); B6 identical inputs (union = intersect = the input, exclude empty); B7 circle inside a rectangle (subtract: a hole); B8 rotated rectangles; B9 rounded rectangles; B10 an evenodd self-crossing pen path; B11 three inputs (subtract uses `A₀`); B12 two unit circles tangent outside (union: two contours touching at one vertex; intersect: `boolean-empty`; subtract: `A₀` unchanged); B13 circles tangent inside; B14 two rectangles whose shared edge is 0.5 η apart (snapped as coincident: union is one rectangle, no seam); B15 two rectangles crossing at 1°.
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
