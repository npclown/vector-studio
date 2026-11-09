# E41 contract: boolean path operations, drop shadows and layer blur

Status: **DRAFT 2026-11-09**, Full tier. The user asked for this work on 2026-11-09 (project chat, item 4 of the post-MVP gap list: "4번도 진행하자"). The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24 unless the user picks otherwise.

This is rendering-track item E41 ([D9 rendering track](d9-rendering-track.md#status-index)). Its editor units (U2, U3, U6) run on the visualization track. It changes shared surface:

- the document schema (v7: an `effects` list on every node);
- the scene contract (`SceneNodeBase.effects`), the renderer mirror options and one new diagnostic code;
- new render passes and pipelines in `renderer-core` and `renderer-webgpu`;
- new editor commands, key bindings and panel controls;
- [requirements.md](../requirements.md): boolean operations, drop shadows and layer blur move from "deferred" to supported.

It adds no runtime dependency, changes no threshold of P3, E25 or E39, and changes no existing draw. Identifiers use the prefix **E41-**.

Owners:

- This file owns E41's execution order, acceptance criteria, fixtures and evidence.
- [graphics-engine-architecture.md](../graphics-engine-architecture.md) owns the compositing model; U4 amends it with section 5's effect layer.
- The [E25 contract](d9-e25-isolated-opacity-contract.md) owns layers, the layer tile set and the layer budget that E41 extends.
- A PNG/SVG export thread runs in parallel. Section 5.6 fixes the effect semantics so that its SVG mapping is exact; the mapping itself is the export work's.

## 1. Scope

In scope:

- **Boolean operations** on two or more selected shapes: union, subtract, intersect and exclude. The result is one new path node that replaces the inputs (destructive, E41-Q1 (a)). Curves stay curves: every result segment is a piece of an input segment.
- **Drop shadow**: colour, offset, blur radius, visible toggle; up to 8 per node.
- **Layer blur**: blur radius, visible toggle; at most one per node.
- Effects on every node type: shapes, paths, lines, text, instances, groups, frames, mask groups and symbols.
- Editor commands, key bindings, context-menu entries and a panel section for both features.

Out of scope (backlog, section 10): non-destructive boolean groups, inner shadow, shadow spread, background blur, blend modes, booleans on text, groups or strokes (outline stroke), and path simplification.

## 2. Boolean operations

### 2.1 Inputs

- Two or more selected leaves of types `rectangle` (with corner radii), `ellipse`, `path` and `custom` path-shaped nodes, and star paths. They must share one parent (E41-Q3 (a)).
- Every input contributes its **fill area** under its own fill rule. Strokes are ignored (as in Figma and Illustrator Pathfinder). An input without a fill still contributes its area.
- Any other selection (a line, text, instance, container, a single node, nodes in different parents) rejects the command with no document change and an editor notice `boolean-unsupported`.

### 2.2 Operations

Inputs are taken in paint order, bottom first: `A₀` (bottom), `A₁`, …, `Aₙ`.

| Operation | Result region | Figma / Illustrator name |
| --- | --- | --- |
| `union` | `A₀ ∪ A₁ ∪ … ∪ Aₙ` | Union / Unite |
| `subtract` | `A₀ \ (A₁ ∪ … ∪ Aₙ)` | Subtract / Minus Front |
| `intersect` | `A₀ ∩ A₁ ∩ … ∩ Aₙ` | Intersect |
| `exclude` | points covered by an odd number of inputs | Exclude |

### 2.3 Result node

- **E41-B1 geometry.** The result is one `path` node in the shared parent, with `fillRule: 'nonzero'`, `rotation: 0` and a frame that is the axis-aligned bound of the result curves in the parent's space. Contours are oriented so that outer boundaries and holes give the same region under `nonzero` and `evenodd`.
- **E41-B2 style.** Fill, stroke, opacity, effects and name come from the bottom input `A₀` (E41-Q4 (a)). Its paint position is the topmost input's slot.
- **E41-B3 transaction.** One undoable transaction removes the inputs and inserts the result. The selection becomes the result. Undo restores the inputs, their order and the previous selection.
- **E41-B4 empty result.** An empty region (for example, intersect of disjoint shapes) rejects the command with `boolean-empty` and no change.
- **E41-B5 size.** Inputs above 4,096 segments in total, or more than 16,384 intersections, reject with `boolean-too-large` and no change.

### 2.4 Algorithm (E41-Q2 (a): TypeScript in `editor-core`)

The engine is a deterministic, synchronous module `packages/editor-core/src/boolean/`, with plain-data inputs and outputs and no WASM, so commands stay synchronous. ARCHITECTURE.md gets a one-line note that this edit-time operation is not a geometry-port request.

1. **Segments.** Each input becomes closed contours of lines and cubics in parent space. Rectangles with radii and ellipses use the projector's cubic arcs. Rotation is applied exactly to control points.
2. **Intersections.** Line-line in closed form; line-cubic by the cubic's roots on the line; cubic-cubic by recursive bounding-box subdivision down to `ε`, then Newton refinement. `ε = 1e-9 × D`, with `D` the diagonal of the union of input bounds. Overlapping collinear or coincident pieces are split at the end points of their overlap.
3. **Split.** Segments are cut at their sorted parameters by de Casteljau subdivision. Pieces shorter than `ε` are merged into their neighbour.
4. **Classify by sides.** For each piece, take two probe points at `±δ` along its normal at the midpoint (`δ = 1e-6 × D`). Each probe's membership in each input is its winding number under that input's fill rule (ray crossings with exact cubic roots). The operation gives `in(left)` and `in(right)`. A piece is kept when they differ and is oriented with the result on its left. Coincident duplicates keep one piece. This rule handles shared edges and touching shapes without special cases.
5. **Chain.** Kept pieces are joined end to end within `ε` into closed contours. A piece that cannot be chained fails the command with `boolean-failed` and no change (fail closed).

## 3. Effects model (schema v7)

- **E41-S1.** Every v7 node has `effects: readonly Effect[]`, default `[]`. The v6 to v7 migration adds `[]`. If another schema change (for example image nodes) merges first, E41 takes the next free version; the rule "whoever merges first takes vN+1" from M4 applies.
- **E41-S2.**

```ts
type Effect =
  | { kind: 'dropShadow'; visible: boolean; color: Color; offsetX: number; offsetY: number; radius: number }
  | { kind: 'layerBlur'; visible: boolean; radius: number };
```

- **E41-S3 limits.** At most 8 effects, at most one `layerBlur`. `radius` is finite in `[0, 1000]`; offsets are finite in `[−10000, 10000]`; `color` follows the model's colour rules. Validation rejects anything else.
- **E41-S4 units.** Values are in the node's local units. Offsets rotate with the node and its ancestors. Resizing a node does not change its effects. The blur's standard deviation is `σ = radius / 2`, as in CSS `box-shadow` and Figma.

## 4. Scene contract

- **E41-S5.** `SceneNodeBase` gains optional `effects?: readonly SceneEffect[]`, the visible effects only, with offsets and σ already in the node's scene-local space. Absent and empty mean no effects; scenes without effects are accepted and drawn exactly as before (E41-A06).
- **E41-S6 gate.** A renderer option `effects: 'none' | 'v0'` (default `'none'`), as E25's `groups`. With `'none'`, a change set with effects is rejected with `unsupported-feature`. `'v0'` requires `groups: 'isolated'`.
- **E41-S7 diagnostic.** New code `effect-over-budget`, raised once per node on its transition into the over-budget state (the E25 notice rule).

## 5. Rendering

### 5.1 Semantics

For a node `N` with effects, let `L` be `N`'s content, including its subtree, rendered isolated at opacity 1. Then:

1. Each visible drop shadow `i`, in list order, gives `Sᵢ = colorᵢ × alpha(G_σᵢ ∗ L)`, translated by its offset.
2. `R = L over Sₙ over … over S₁` (later shadows paint above earlier ones; all shadows paint below the content).
3. With a visible layer blur, `R ← G_σ ∗ R`.
4. `R` is composited into the parent target scaled by `N.opacity`.

`G_σ` is the 2D Gaussian with transparent black outside the layer. A shadow shows through translucent content, as CSS `filter: drop-shadow()` and SVG `feDropShadow` do (E41-Q6 (a)). Ancestor clips and masks apply to `R` as to any content; `N`'s own clip applies to its children inside `L`.

### 5.2 Effect layers

- A node with at least one visible effect is a layer root, even at opacity 1 and even when it is a leaf. E25's layer plan, tile set and post-order apply; the layer variants are reused unchanged.
- **E41-K1 bounds.** In device pixels, with `s = zoom × DPR`, the margin is `m = max over effects of (⌈3 σ s⌉ + |offset| s)`. The layer bound is the content bound grown by `m`, intersected with the viewport grown by `m`, then E25-K5's even rounding. A node whose content is off screen but whose shadow reaches the viewport is drawn.
- **E41-K2 blur.** Separable Gaussian, horizontal then vertical, between two ping-pong textures of the layer's size, at 1 sample. Kernel half-width `⌈3σ_px⌉`, at most 32 taps per side. For larger `σ_px`, the source is downsampled by 2 up to 3 times (σ up to 256 px), blurred, and upsampled bilinearly. Above `σ_px = 256` the blur is clamped to 256 and the frame reports it once (renderer statistics, no diagnostic).
- **E41-K3 composite.** A new pipeline `effect-composite-v0` draws a shadow (tinted alpha at an offset) or the content; the existing E25 composite applies opacity. Shadow and content share one record buffer per frame.
- **E41-K4 invalidation.** An effect edit changes composite records and pass parameters only: 0 fill or stroke port calls, 0 geometry builds.

### 5.3 Budget

Effect textures (the layer, 2 ping-pong textures and the downsample chain) count against E25's 96 MiB layer budget. A node over the budget draws its content without effects (as an ordinary layer, or directly when it needs none) and raises `effect-over-budget` (E41-Q7 (a)).

### 5.4 Editor visual bounds

`visual-bounds.ts` grows a node's visual bound by `1.5 × radius + |offset|` per visible effect, in local units, before transform. Culling and export bounds use it; hit testing and the selection box do not.

### 5.5 Performance budget

On the reference PC (GTX 1660 SUPER, Chrome, 1920 × 1080, DPR 1, 4x), scene `e41-cards`: 50 cards, each with one drop shadow (`radius 16`) and every tenth with a layer blur (`radius 8`):

- typical view median frame ≤ 16.7 ms, and dragging one card median ≤ 16.7 ms;
- GPU time of the effect passes reported per frame (observation).

Results follow [benchmarks/README.md](../benchmarks/README.md). A miss is disclosed in the exit record and the user decides (the pre-alpha pattern).

### 5.6 Export

PNG export through the renderer includes effects with no extra work. For SVG, `dropShadow` maps to `feDropShadow dx dy stdDeviation = radius / 2 flood-color flood-opacity`, `layerBlur` to `feGaussianBlur stdDeviation = radius / 2`, each from `SourceGraphic` and merged with `feMerge` in section 5.1's order, with the filter region grown by section 5.4's margin. Booleans need nothing: the result is a plain path.

## 6. Editor

- **Commands.** `boolean.union`, `boolean.subtract`, `boolean.intersect`, `boolean.exclude`; `effects.add` (`dropShadow` default: black at alpha 0.25, offset (0, 4), radius 8; `layerBlur` default radius 4), `effects.set`, `effects.remove`, `effects.toggle`. Each is one undo step; numeric field drags coalesce as other panel fields do.
- **Keys** (configurable): Ctrl/Cmd+Alt+U, S, I, X for the four booleans.
- **UI.** Context menu and the property panel show the four boolean actions when the selection qualifies (2.1). The property panel gets an "Effects" section: add (shadow or blur), per-effect visible toggle, colour, X, Y, blur, remove. With several nodes selected, add appends to each; fields show "Mixed" where values differ.

## 7. Acceptance criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| E41-A01 | Schema v7: parse, validate (S2, S3 limits, each refusal), migrate v6 → v7, serialize round trip; every v6 fixture loads | Unit tests (model) |
| E41-A02 | Boolean correctness. Fixtures B1 to B12 (section 8) and 1,000 seeded random cases (polygons, cubic blobs, rects with radii, ellipses, rotated inputs, evenodd self-crossing inputs). For each, a 256 × 256 grid over the input bounds: every sample farther than `4δ` from any input edge has `in(result) = op(in(Aᵢ))` under both fill rules. Every result piece lies on an input segment within `ε`. Every contour is closed | Unit tests (editor-core) |
| E41-A03 | Boolean command behaviour: B1 to B5 of section 2.3, each rejection with no document change and its code, one undo step restores inputs, order and selection | Unit tests (editor-core) |
| E41-A04 | Boolean cost: two inputs of 512 cubic segments each, 1,000 crossings, finish in ≤ 100 ms in the CI container (Node 24, median of 5) | Unit test with timing record under `docs/evidence/e41/` |
| E41-A05 | Effect rendering against a CPU oracle (exact Gaussian convolution of the oracle's coverage): fixtures F1 to F10. Interior tolerance 3/255; F9 (downsampled) 6/255 | Headed GPU spec on the reference PC |
| E41-A06 | Identity, against `main` at U4's merge base: scenes without effects give byte-identical captures with `effects: 'none'` and `'v0'`, unchanged shader hashes and pipeline keys, an unchanged E10-A1 golden log; full `pnpm test:gpu` passes | SwiftShader (U5), headed (U6) |
| E41-A07 | Invalidation per E41-K4; pan and zoom with effects cost no port calls; `effectPasses` counts per frame | Unit (U4), GPU counters (U6) |
| E41-A08 | Budget and gate: S6 rejection, S7 notice once per transition, content drawn without effects over budget | Unit (U4), headed (U6) |
| E41-A09 | Resources: effect textures in accounting, released after submission, on resize, dispose and device loss, back to baseline when effects are removed | Unit with the fake device (U5), GPU spec (U6) |
| E41-A10 | Performance per section 5.5, committed record | Benchmark record on the reference PC (U6) |
| E41-A11 | Editor flows in next-host: the four booleans from the context menu and keys, undo; add, edit, hide and remove a shadow and a blur from the panel; an off-screen shadow caster draws (K1) | Headed spec `test:e41-next-host`, Chrome and Edge |

## 8. Fixtures

- **Booleans.** B1 two overlapping circles, every operation; B2 rectangle minus circle; B3 star intersect circle; B4 two rectangles sharing an edge (union gives one rectangle, no seam); B5 shapes touching at one point; B6 identical inputs; B7 a circle inside a rectangle (subtract makes a hole); B8 rotated rectangles; B9 rounded rectangles; B10 an evenodd self-crossing pen path; B11 three inputs in order (subtract uses `A₀`); B12 tangent cubics.
- **Effects.** F1 shadow on a rectangle; F2 the same rotated 30°; F3 layer blur on a group; F4 three shadows of different colours and offsets; F5 shadow under a 50 %-alpha fill; F6 shadowed child in a clipping frame; F7 shadow on text; F8 shadow plus layer blur plus opacity 0.5; F9 zoom 8 with radius 40 (downsample); F10 caster off screen, shadow on screen.

## 9. Open choices (recommended option first)

- **E41-Q1 boolean kind.** (a) destructive: one path replaces the inputs; undo restores them. (b) non-destructive boolean group node, recomputed on each edit. (a) keeps the schema, the renderer and export unchanged for booleans, and is how Illustrator Pathfinder works; (b) is Figma's default and is backlog.
- **E41-Q2 engine place.** (a) TypeScript in `editor-core` (sync, exact cubic pieces). (b) a new geometry-port request in the Rust kernel (async, batched; the kernels' arrangement code works on flattened edges).
- **E41-Q3 different parents.** (a) reject. (b) move the result into the topmost input's parent.
- **E41-Q4 result style.** (a) bottom input `A₀`. (b) topmost input.
- **E41-Q5 effect set.** (a) drop shadow and layer blur. (b) also inner shadow and background blur now.
- **E41-Q6 shadow under translucent content.** (a) visible, CSS `drop-shadow` semantics, exact in SVG. (b) knocked out under the content.
- **E41-Q7 over budget.** (a) draw content without effects plus a notice. (b) draw nothing for the node (E25's rule).

## 10. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | This contract; requirements.md, track rows | Independent review READY |
| U2 | Visualization | Boolean engine `editor-core/src/boolean/`, fixtures B1 to B12, random corpus | E41-A02, A04; CI |
| U3 | Visualization | Boolean commands, keys, context menu and panel buttons in next-host | E41-A03, the boolean half of A11 |
| U4 | Rendering | Schema v7 and migration (model), projector and `SceneEffect`, gate, diagnostic, layer plan for effect roots, K1 bounds, budget, visual bounds; architecture note | E41-A01, A07 and A08 unit parts |
| U5 | Rendering | Blur, downsample and effect composite passes, accounting, `effectPasses`, SwiftShader captures | E41-A06 and A09 on SwiftShader |
| U6 | Visualization | Effects panel, headed page and spec with the CPU oracle, cards benchmark | E41-A05, A08, A10, A11 on the reference PC |
| U7 | Rendering | Evidence index `docs/evidence/e41/`, exit record for the user | Index merged; user accepts |

U2 and U4 can run in parallel; U5 follows U4; U3 follows U2; U6 follows U3 and U5.

**Backlog after E41:** non-destructive boolean groups, booleans on strokes (outline stroke) and on groups, inner shadow, shadow spread, background blur, blend modes, effect-layer caching for still frames.

## 11. Risks

- **Boolean robustness.** Near-tangent cubics and almost-coincident edges are where curve booleans break. The side-probe rule and fail-closed chaining keep the document safe; A02's random corpus measures the failure rate, and any `boolean-failed` case it finds becomes a fixture.
- **Effect cost.** Each shadow costs two blur passes over its layer, and a dragged node re-renders its layer every frame. Section 5.5 measures it; layer caching is backlog.
- **Memory.** Full-screen blurred groups at 4K and 4x use three layer-sized textures. They share E25's budget and degrade to no effects, never to missing content.
