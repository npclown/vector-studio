# E23 contract: linear and radial gradient paint

Status: APPROVED 2026-10-29 (recommended options auto-adopted, section 10), Full tier (shared surface: `packages/contracts` scene paint types, renderer draw state, a new diagnostic code). Rendering-track item [E23](d9-rendering-track.md#status-index), MVP rendering need R-G ([MVP plan, section 5](mvp-editor-plan.md#5-rendering-track-needs)), needed by MVP M4.

Owners: this file owns E23 execution order, acceptance criteria, fixtures and evidence. [requirements.md](../requirements.md#initial-appearance-model) owns "one linear or radial gradient"; [graphics-engine-architecture.md](../graphics-engine-architecture.md#approved-p1-visual-behavior) owns colour and compositing rules (amended by this contract, section 4); [mvp-editor-plan.md](mvp-editor-plan.md#m4-appearance) owns the editor half of M4.

## 1. Scope

In scope:

- A paint type `ScenePaint`: a solid `SceneColor` or one `SceneGradient` (linear or radial). Every colour slot of a drawn style takes a paint: primitive fill and stroke, path fill and stroke. One gradient per paint.
- Stops (1 to 16), spread (`pad`, `reflect`, `repeat`), elliptical and rotated gradients through one gradient affine.
- The realization for P1 analytic primitives, P3 mesh fill and stroke draws, the ST-U7 joint fill draw and their P4 clip variants.
- Headed fixtures whose probes are the references the MVP M4 exit gate names ("headed pixel probes for gradient … against references written in the rendering items' contracts").

Out of scope (stated so the exit does not imply them):

- Multiple fills per node, conic or mesh gradients, a radial focal point (SVG `fx`/`fy`), per-stop opacity separate from the stop colour, dithering, interpolation in linear light or other colour spaces.
- Object-bounding-box gradient units in the renderer (E23-Q2): producers convert to node-local space.
- Gradient strokes on primitives other than the existing P1 stroke (no joins or caps change), dashes (E24), isolated group opacity (E25).
- The document model, commands and panel controls of M4 (visualization track).

## 2. Scene contract (shared surface)

```ts
export type SceneGradientSpread = 'pad' | 'reflect' | 'repeat';
export type SceneGradientStop = Readonly<{ offset: number; color: SceneColor }>;
/**
 * `transform` maps gradient space to the node's local space. Linear: t = x in gradient space,
 * so t runs from 0 at the y-axis to 1 at x = 1. Radial: t = |g|, the unit circle is t = 1.
 */
export type SceneGradient = Readonly<{
  kind: 'linear' | 'radial';
  transform: SceneAffine;
  stops: readonly SceneGradientStop[];
  spread: SceneGradientSpread;
}>;
export type ScenePaint = SceneColor | SceneGradient;
export const SCENE_MAX_GRADIENT_STOPS = 16;

// Widened fields (names unchanged, E23-Q5):
PrimitiveStyle = { fill: ScenePaint | null; stroke: SceneStroke | null };
SceneStroke = { color: ScenePaint; width: number };
PathStyle = { fill: ScenePaint | null; stroke: PathStroke | null };
PathStroke = { color: ScenePaint; width; cap; join; miterLimit };
```

- **E23-S1 discrimination.** A paint with exactly the fields `r`, `g`, `b`, `a` is a solid colour, validated as today. A paint with exactly `kind`, `transform`, `stops`, `spread` is a gradient. Anything else is `invalid-value`.
- **E23-S2 gradient values.** `kind` is `'linear'` or `'radial'`; `spread` one of the three names. `transform` is six finite numbers whose determinant `a·d − b·c`, computed in binary64, is non-zero and whose binary64 inverse is finite. `stops` is an array of 1 to 16 entries, each exactly `{ offset, color }`, `offset` finite in `[0, 1]`, offsets non-decreasing in array order, `color` a valid `SceneColor`. A violation is `invalid-value` in `copyNode`. More than 16 stops is `unsupported-feature` (a structural limit, like clip depth 33): every stop is validated first, so 17 stops with a decreasing offset is `invalid-value`, and the stop count travels as the node's unsupported flag, which is reported after the graph checks (a 17-stop node in a change set that also has a cycle reports `cycle`), as P4-S3 orders them. Validation bounds `M` only; the binary32 range of the composed map is a packing rule (E23-K8).
- **E23-S3 support gate.** The mirror gains the option `paints: 'solid' | 'gradient'` (default `'solid'`). Under `'solid'` a change set with any gradient paint is rejected with `unsupported-feature`, as P4 U1 did with `clips`. The service option `paints: 'gradient'` sets it (U3); see section 4, Unavailable variants.
- **E23-S4 compatibility.** Every existing producer stays valid: a `SceneColor` is a `ScenePaint`. Consumers that read `.r`, `.g`, `.b`, `.a` from a style field narrow it first; they fail type-checking until they do, so U1 narrows them all: `primitive-scene-source.ts` (style lanes), `path-mesh-pipeline.ts` (`Evaluated.color`, `PathMeshDraw.fill`), `path-mesh-packet.ts`, `scene-validation.ts`, and the test supports and oracles (`p1-visual-oracle.ts`, `p1-visual-corpus.ts`, `viz-v3-oracle.ts`, `p4-clip-oracle.ts`, `st-u6-stroke-gpu.ts`, `st-u6-stroke-harness.ts`, `v3c-mesh-smoke.ts`) and the playground appearance page. The editor projector passes the model's colour through unchanged. A scene with only solid paints renders exactly as before (E23-A08).
- **Gradient space.** The gradient's space is the node's local space, after the node's own `transform`, the same space as its geometry: for a rectangle or ellipse, `[0, width] × [0, height]`; for a path, its `points`; for a line primitive, the space of its `start` and `end`. The projector's fill-mode line outline (`fill: stroke.color`) keeps the line's local space, so a stroke gradient carries over unchanged. So a gradient moves, rotates and scales with its node, and a camera change never changes which colour a document point gets. An editor that stores gradients relative to the bounding box (Figma's model) composes that box into `transform` when it projects (M4). A box axis of size 0 (a horizontal path, P5's zero-size axes) is folded as size 1 for that composition, so `M` stays invertible and the node is not rejected; M4's contract restates this rule.

## 3. Rendering semantics

Notation as P1 D2 and P3: encoded-sRGB, premultiplied, source-over. For a stop colour `c = (r, g, b, a)` its premultiplied value is `P(c) = (r·a, g·a, b·a, a)`.

- **E23-K1 gradient coordinate.** At pixel centre `p` (physical pixels), the document point is `w = p / (zoom · DPR) + camera`; the gradient point is `g = M⁻¹ · W⁻¹ · w`, with `W` the node's world affine and `M` the gradient `transform`. Linear: `t = g.x`. Radial: `t = |g|`.
- **E23-K2 spread.** `pad`: `t' = clamp(t, 0, 1)`. `repeat`: `t' = t − floor(t)`. `reflect`: `u = t − 2·floor(t / 2)`, `t' = 1 − |u − 1|`.
- **E23-K3 stop lookup.** With stops `(o_i, c_i)`, `i = 0 … n−1`: if `t' < o_0` the paint is `P(c_0)`; if `t' ≥ o_{n−1}`, `P(c_{n−1})`; otherwise take the largest `i` with `o_i ≤ t'`, so `o_{i+1} > t'`, and interpolate premultiplied: `Q(t') = P(c_i) + w · (P(c_{i+1}) − P(c_i))`, `w = (t' − o_i) / (o_{i+1} − o_i)` (E23-Q3). Equal offsets make a hard edge; at the shared offset the later stop wins. One stop is a solid paint.
- **E23-K4 composition.** The paint value `Q(p)` replaces the constant premultiplied colour in each existing formula, and nothing else changes. P1 analytic primitive: `fill = Q_F(p) · c_fill`, `stroke = Q_S(p) · c_stroke`, `local = stroke + fill · (1 − stroke.a)`, output `local · opacity`. P3 mesh fill or stroke draw: `o · c · Q(p)`. ST-U7 joint fill draw: `X = o · c_F · Q_F(p) · (1 − a_S) / (1 − o · a_S)` with `a_S = c_S · Q_S(p).a`, followed by the stroke draw `o · c_S · Q_S(p)`. P4 clip coverage multiplies as before.
- **E23-K5 mask sources.** A mask source's paint is ignored: the mask is its fill area (P4-S2), drawn white. A gradient on a mask source is valid and changes no pixel.
- **E23-K6 invalidation.** A paint change (solid to gradient, gradient to solid, any gradient field) rewrites only paint records and the draw's pipeline choice: 0 fill and stroke port calls and 0 geometry builds, the architecture's "colour and opacity changes do not rebuild vertices" rule. A camera pan or zoom rewrites no gradient record.
- **E23-K7 precision.** `g` and `Q` are evaluated in binary32 in the fragment shader. No colour-precision threshold beyond the fixture tolerances of section 6 is claimed, and no dithering is applied, so 8-bit banding of long, low-contrast ramps is expected.
- **E23-K8 binary32 range.** If any lane of a gradient record (section 4) is not finite in binary32, that paint contributes 0 and reports nothing, a per-node state like P3's `packing-range` state. In a P1 analytic draw, which carries both paints, the out-of-range paint's term in E23-K4 is 0 and the other still draws. A path with separate fill and stroke draws skips the draw of the out-of-range paint. A path drawn with the ST-U7 joint fill draw (`0 < o < 1` with fill and stroke) draws neither its fill nor its stroke when either record is out of range, because the joint draw reads both.

## 4. Realization (E23-Q1 (a))

- **Pipelines.** A draw with at least one gradient paint uses a pipeline variant keyed `+paint-v0`: P1 analytic, P3 mesh fill, ST-U7 joint, and each combined with the P4 clip variant (`+paint-v0+clip-v0`). The base modules, keys, the E3-recorded `MESH_FILL_SHADER` SHA-256 and the clip and mask variants are unchanged; a draw with only solid paints always uses today's pipeline. Mask variants need no paint variant (E23-K5).
- **Paint bind group.** Group 2 (group 0 is the packet, group 1 the clip), with the gradient record table (storage) and an index table mapping a primitive slot's fill and stroke, or a mesh draw record, to its gradient record (0 for solid). Group 2 is set only by paint variants, so base pipeline layouts are unchanged; three bind groups fit WebGPU's default limit of four. A paint variant without a clip has an empty group-1 layout and binds an empty bind group there (no null layout slot), and the draw encoder rebinds group 2 after every pipeline switch, as `bindClip` does for group 1.
- **Uniformity.** The paint index and stop count are read from storage per slot or instance, so they are non-uniform. The paint is evaluated after every coverage derivative (`analyticCoverage`, `clipCoverage`), with no `return` or `discard` before those calls; U3 gates a compile check of every variant on Chrome's WGSL compiler and in the container's SwiftShader.
- **Gradient record.** Per gradient paint of a drawn record: kind, spread, stop count, the composed map `G = M⁻¹ · W_o⁻¹` from the document point relative to the packet origin to gradient space (composed in binary64, rounded once to binary32), 16 stop offsets and 16 premultiplied stop colours (premultiplied in binary64, rounded once). The shader computes `w − origin = p / (zoom · DPR) − (origin − camera)` from the frame uniform it already has, so a camera change rewrites no record; an origin rebase rewrites the records it moves, as for clip records. An analytic primitive may instead map its interpolated `localPosition` through `M⁻¹` alone (then its record does not depend on the origin); U2 picks one realization per draw kind and A02 tests the one picked. About 368 bytes; U2 fixes the exact layout and stride.
- **Draw order and batching.** Draws stay in paint order. Consecutive analytic primitives with the same pipeline variant and clip state stay one instanced run; a paint-variant change starts a new run, never a reorder. Mesh draws choose their pipeline per draw, as they do for the joint and clip variants. The E17 write-once stencil and reset draws are unchanged.
- **Count pass (E10).** Paint changes colour only, so the count pass replays gradient draws with today's count pipelines, unchanged.
- **Unavailable variants.** The service option `paints` sets the mirror once, at construction; the variants are built later, at attach and at recovery. If a paint variant fails to build, the paint variants this attempt cached are evicted (the E22-K5 rule), the scene comes up without them, the backend emits `render.paint-unavailable` (new, warning) once per generation (the E22-K4 rule), and draws with a gradient paint fail closed (not drawn, not drawn in a solid fallback colour), while solid draws are unchanged.
- **Resources.** The record and index tables are tracked by `resource-accounting.ts` and released on dispose and device loss. They grow with drawn gradient paints, at most two per drawn record: 10,000 nodes with gradient fill and stroke need about 7.4 MB, within the 256 MB working-memory ceiling, so no separate budget is set.
- **Architecture amendment (with this contract).** The P1 visual-behavior section gains: a fill or stroke paint is a solid colour or one gradient evaluated per pixel in node-local space and interpolated premultiplied in encoded sRGB; the paint replaces the constant colour in every coverage and composition formula.

Alternatives: (b) a 256-texel ramp texture per gradient in an atlas, sampled with `t'`: cheaper per fragment, but hard stops blur unless the ramp is sampled nearest, the atlas needs its own budget and eviction, and the oracle must model the ramp. (c) One shader for all draws with solid colour as a one-stop gradient: no variants, but it changes the base modules, their SHA-256 and every pipeline key, so the solid-scene identity (E23-A08) and the E3 shader record are lost.

## 5. Diagnostics

- `render.paint-unavailable` (new, warning): context `{}`; once per generation when the scene was asked for gradient paints and comes up without the paint variants.
- More than 16 stops, and gradients under `paints: 'solid'`: no diagnostic; the change set is rejected with `unsupported-feature`.
- A gradient record outside binary32 range (E23-K8): no diagnostic.

## 6. Acceptance criteria and fixtures

Evidence goes to `docs/evidence/e23/`. Headed runs use the reference PC (DESKTOP-DKVUSAV, Chrome and Edge, DPR 1 and 2), as P4. The oracle evaluates sections 3 K1 to K4 in binary64 from the scene; an **interior** probe is at least 2 physical px from every shape edge and at least 1 physical px (in `p`) from every hard stop and every `reflect` or `repeat` seam; an **edge** probe is on a coverage ramp.

**Fixtures** (`G1` to `G8`, one headed page, each at DPR 1 and 2). They are the M4 exit-gate references. Placement not pinned below (the positions of G4's rectangles, G6's children in their container, G7's camera positions) is chosen by U4 and recorded with its evidence; the oracle derives every probe value from the scene:

| ID | Scene | What it pins |
| --- | --- | --- |
| G1 | 300 × 100 rectangle, linear fill red `(1,0,0,1)` to blue `(0,0,1,1)` with `transform = [200, 0, 0, 200, 50, 0]` (so `t` runs 0 to 1 over `x` 50 to 250), `pad` | Linear `t`, two stops, pad on both ends |
| G2 | 200 × 100 ellipse, radial fill with `transform = [100, 0, 0, 50, 100, 50]`, stops white `(1,1,1,1)` at 0, green `(0,1,0,1)` at 0.5, black `(0,0,0,1)` at 1, `pad` | Elliptical radial, middle stop |
| G3 | Path, `evenodd`: outer `M 0 0 C 80 -40 120 -40 200 0 L 200 120 L 0 120 Z`, hole `M 60 40 L 140 40 L 140 80 L 60 80 Z`. Fill linear at 30°, `transform = [173.205, 100, -100, 173.205, 0, 0]`, yellow `(1,1,0,1)` at 0 to magenta `(1,0,1,1)` at 1, `pad`. Stroke width 12, `round` join, `butt` cap, miter limit 4, linear `transform = [200, 0, 0, 200, 0, 0]`, cyan `(0,1,1,1)` at 0 to `(0,0,0,0.6)` at 1, `pad`. Node opacity 0.5 | Mesh fill, stroke and joint draws (E23-K4 joint formula) |
| G4 | Three 300 × 60 rectangles with `transform = [100, 0, 0, 100, 100, 0]` (`t` 0 to 1 over `x` 100 to 200), stops black to white, spreads `pad`, `repeat`, `reflect` | E23-K2, both seams of each spread |
| G5 | Two 200 × 60 rectangles, linear `transform = [200, 0, 0, 200, 0, 0]`, `pad`. First: red `(1,0,0,1)` at 0, transparent green `(0,1,0,0)` at 1. Second: red at 0 and 0.5, blue `(0,0,1,1)` at 0.5 and 1 (a hard edge at `x = 100`, flat on each side) | Premultiplied interpolation (no dark or green fringe), hard stops |
| G6 | G1 and G3 in a container rotated 20° with clip `{ rect, x: 20, y: 10, width: 240, height: 80 }`; and G1 in a mask container whose source is the G2 ellipse with G2's gradient fill | E23-K5, P4 clip variants with paint variants |
| G7 | G1 with node transforms rotation 15°, x-shear 0.25 and scale (2, 0.5), each at camera zoom 0.25, 1 and 8 and two camera positions | Gradient space follows the node; camera independence |
| G8 | Line primitive from `(0, 0)` to `(200, 0)`, stroke width 16 with G1's stops and `transform = [200, 0, 0, 200, 0, 0]`; a 200 × 100 rectangle, solid white fill, stroke width 10 with the same gradient | Primitive stroke paint and P1 local composition |

| ID | Criterion | Evidence |
| --- | --- | --- |
| E23-A01 | Validation: E23-S1 to S3 accept and reject as written, with reasons (`invalid-value` for each malformed field, singular `transform` and one with a non-finite binary64 inverse, decreasing offsets, 0 stops, 17 stops with a decreasing offset; `unsupported-feature` for 17 stops and for any gradient under `'solid'`; precedence against graph checks as E23-S2) | Unit tests in `pnpm check` |
| E23-A02 | Packing: gradient records equal the binary64 composition rounded once, premultiplied stops; for the realization U2 picks, an origin rebase rewrites only moved records and a camera change rewrites none; a record outside binary32 range (for example `M = [1e-200, 0, 0, 1e-200, 0, 0]`) follows E23-K8 for a P1 primitive (fill out of range, stroke drawn, and the reverse), a path with separate draws, and a joint path | Unit tests |
| E23-A03 | Interior probes of G1 to G8 equal the oracle within 2/255 per channel; edge probes within 4/255 | Headed GPU spec, readback |
| E23-A04 | G5 over the page's opaque black background: the probe at `t = 0.5` of the transparent ramp reads `(0.5, 0, 0)` within 2/255 (premultiplied `(0.5, 0, 0, 0.5)`), more than 24/255 from straight-alpha interpolation's `(0.25, 0.25, 0)` in red and green; the hard-stop probes 1 px on each side equal their stops | Headed GPU spec |
| E23-A05 | Invalidation: E23-K6 measured by port-call and geometry-build counters for solid↔gradient and stop edits on paths; a camera pan writes 0 gradient records | Unit and GPU counters |
| E23-A06 | Batching: N consecutive gradient primitives under one clip state are one run; paint order is kept across variant changes | Draw and batch counters |
| E23-A07 | Unavailable variants: each variant step's failure leaves no paint variant cached, emits `render.paint-unavailable` once per generation, gradient draws are absent and solid draws unchanged | Unit (fake device) |
| E23-A08 | Identity: unchanged shader hashes and pipeline keys of every base and clip variant, and the E10-A1 golden log unchanged, against `main` at U1's merge base; solid-only frame captures (the E10 capture hook on the existing P1, P3 and P4 pages) byte-identical between that commit and U3 on the reference PC; the existing `pnpm test:gpu` suite passes. If the capture comparison cannot run, the hash, key and golden-log parts stand and the gap is disclosed, as P4 U6 did | Headed full `pnpm test:gpu`, hash check |
| E23-A09 | Resources: gradient tables appear in resource accounting and return to the solid baseline after gradients are removed, on dispose and device loss | GPU spec |

## 7. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | Contract types, `SCENE_MAX_GRADIENT_STOPS`, validation, mirror option `paints` (default `'solid'`), consumers narrowed; `render.paint-unavailable` code | E23-A01; CI |
| U2 | Rendering | `renderer-core`: gradient records and index tables, draw-run split on paint variant, invalidation | E23-A02, A05, A06 unit parts |
| U3 | Rendering | `renderer-webgpu`: `+paint-v0` shader variants and bind group 2, clip combinations, variant rollback and diagnostic; container SwiftShader readback against the oracle | E23-A03 (software GPU), A07, A08 hash part |
| U4 | Visualization | Headed playground page for G1 to G8, GPU spec and oracle | Headed run on the reference PC (A03, A04, A05 GPU part, A08, A09) |
| U5 | Rendering | Evidence record `docs/evidence/e23/` with the index of A01 to A09 | Item done; M4 may consume E23 |

Order: U1, U2, U3, U4, U5. WIP limit per track applies.

## 8. Risks

- **Fragment cost.** A 16-stop lookup is a bounded loop per paint per fragment; a gradient fill and stroke on a joint draw evaluates two. Solid draws pay nothing. No threshold; M9 measures the editor workload.
- **Banding.** No dithering (E23-K7); long, low-contrast ramps band at 8 bits. Dithering would change pixels against the oracle and is a later item if users ask.
- **Mesh coordinate precision.** E23-K1 maps the pixel back through binary32 from the packet origin; colour error from that mapping is far below one 8-bit step at the zoom range of the fixtures (G7 covers 0.25 to 8).

## 9. Questions (each with a recommended option)

- **E23-Q1 realization.** (a) Per-pixel shader evaluation in `+paint-v0` variants with a record table (section 4). (b) Ramp textures in an atlas. (c) One unified shader. Recommended (a): exact hard stops, no new texture budget, and solid scenes keep their shaders, keys and captures byte-identical.
- **E23-Q2 gradient space.** (a) Node-local space with one gradient affine for both kinds (linear `t = x`, radial `t = |g|`); producers fold a bounding box into the affine. (b) Explicit start and end, centre and radius fields in node-local space, no affine (no elliptical or skewed radial). (c) Object-bounding-box units in the renderer. Recommended (a): one form covers rotated linear and elliptical radial gradients (Figma's default radial on a non-square box), and the renderer stays free of a bounding-box rule that paths and strokes would make ambiguous.
- **E23-Q3 interpolation.** (a) Premultiplied, in encoded sRGB (CSS Images). (b) Straight alpha (SVG 1.1). (c) Linear light. Recommended (a): matches P1's premultiplied pipeline and avoids dark fringes toward transparent stops; (c) would break the encoded-sRGB rule approved in P1 D2.
- **E23-Q4 reach.** (a) Fill and stroke paints on primitives and paths, up to 16 stops, three spreads. (b) Fills only. (c) `pad` only. Recommended (a): stroke paints reuse the same variants at small marginal cost, and the MVP appearance panel would otherwise need a rule that strokes cannot take gradients.
- **E23-Q5 field names.** (a) Keep `fill` and `color` and widen their types to `ScenePaint`. (b) Rename stroke `color` to `paint`. Recommended (a): every producer and fixture stays valid without edits; the type, not the name, carries the change.

## 10. Decisions

**Review record.** Independent review (fresh context, reviewer role), 2026-10-29. Round 1: NOT READY, two blocking findings (the unavailable-variant fallback relied on a mirror option fixed before variants exist; `near-singular` was undefined and binary32 overflow of the composed map unhandled) and nine further findings (empty group 1, WGSL uniformity, stop-count precedence, zero-size axes and line space, unpinned fixtures, consumer list, A02 realization, architecture amendment order, A08 baseline method), all applied. Round 2: READY WITH FOLLOW-UPS (a leftover sentence in E23-S3, E23-K8 for draws that carry both paints, this record), all applied.

- **2026-10-29, recommended options auto-adopted** under the user's standing instruction of 2026-10-24: E23-Q1 (a), E23-Q2 (a), E23-Q3 (a), E23-Q4 (a), E23-Q5 (a). The architecture's P1 visual-behavior section is amended accordingly (section 4). The user may reopen any of them before U1 merges.
