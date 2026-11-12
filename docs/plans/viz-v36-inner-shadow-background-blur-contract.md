# V-36 contract: inner shadow and background blur

Status: **PROPOSED 2026-11-12**, Full tier. The user asked for this on 2026-11-12 (item 6 of the Figma gap list, "1~10번까지 다 진행해줘"), which lifts the [requirements.md](../requirements.md) deferral of inner shadows and background blur. The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24 (추천안 자동 채택 2026-11-12) unless the user picks otherwise.

This is visualization-track item V-36 ([status index](d9-visualization-track.md#status-index)). It extends the [E41 contract](d9-e41-boolean-effects-contract.md) (effects model, effect roots, effect passes, budget) and reuses the backdrop snapshot of V-35 (multiple fills and blend modes, developed in parallel). It changes shared surface:

- the document schema: two new `Effect` kinds in the unreleased **v8** (the first Figma-gap item to merge introduces v8; later items add to it without another bump, coordinator rule of 2026-11-12);
- the scene contract (`SceneEffect`), scene validation and the renderer effects gate;
- the E41 effect module and pass planner in `renderer-core` and `renderer-webgpu`;
- editor commands, limits and the Effects panel section.

It adds no runtime dependency and changes no threshold of E25, E39 or E41. Identifiers use the prefix **V36-**.

## 1. Scope

In scope:

- **Inner shadow**: colour, offset, blur radius, visible toggle. A shadow cast inward from the node's content edge, painted over the content, as Figma's "Inner shadow" and CSS `box-shadow: inset`.
- **Background blur**: radius, visible toggle; at most one per node. The pixels behind the node, inside its shape, are blurred, as Figma's "Background blur" and CSS `backdrop-filter: blur()`.
- Both on every node type that takes E41 effects, with E41's rules for mask sources (S4) and instances (S10).
- Commands, limits, panel controls, the headed spec and a benchmark scene.

Out of scope (backlog): shadow spread (both shadow kinds), background blur on a root whose parent is a layer texture (section 5.4), SVG and PNG export of effects (open since V-30; the E41 export follow-up owns it), effect-layer caching.

## 2. Model (v8)

- **V36-S1 kinds.**

```ts
type Effect =
  | DropShadowEffect | LayerBlurEffect // E41-S2, unchanged
  | { kind: 'innerShadow'; visible: boolean; color: Color; offsetX: number; offsetY: number; radius: number }
  | { kind: 'backgroundBlur'; visible: boolean; radius: number };
```

- **V36-S2 limits.** E41-S3's limits hold for the whole list (at most 8 effects, at most one `layerBlur`), plus at most one `backgroundBlur`. Inner-shadow fields have drop-shadow ranges; `backgroundBlur.radius` is finite in `[0, 1000]`. Units and `σ = radius / 2` per E41-S4. A v7 document cannot hold the new kinds (parse rejects them); v7 to v8 migration leaves `effects` as they are.

## 3. Scene contract and gate

- **V36-S3.** `SceneEffect` gains `{ kind: 'innerShadow'; color; offsetX; offsetY; sigma }` and `{ kind: 'backgroundBlur'; sigma; coverageAlpha }`. `coverageAlpha` in `(0, 1]` is the projector's coverage reference of section 5.2. Validation adds the kinds and the one-background-blur rule.
- **V36-S4 gate.** The renderer option `effects` gains `'v1'`: `'v0'` accepts only E41's kinds and reports a scene with a new kind as `unsupported-feature`; `'v1'` accepts all four and, as `'v0'`, requires `groups: 'isolated'`. The projector option `EditorOptions.projectEffects` takes `true` (E41's kinds only: new kinds are left out of the scene, so a host on `'v0'` keeps drawing the node) or `'v1'` (all kinds). next-host and `webgpu-host` move to `'v1'` in U4.
- A node whose only visible effects are new kinds is an effect root in E41's sense (E41-S7 depth, section 5.2 of E41).

## 4. Inner shadow rendering

### 4.1 Semantics

E41 section 5.1 with `L` the root's content at opacity 1 and `α(·)` its alpha. Each visible inner shadow `j`, in list order:

`Iⱼ(p) = colorⱼ × (1 − α(G_σⱼ ∗ L)(p − offsetⱼ)) × α(L)(p)`

and `R = Iₖ over … over I₁ over L over Sₙ over … over S₁` (inner shadows paint over the content, drop shadows under it). A layer blur then blurs `R`, and the composite is E41's step 4. Content outside the layer reads transparent, so an edge of the content casts the full colour inward, as in Figma.

### 4.2 Bounds and passes

- **V36-K1.** Inner shadows add nothing to E41-K1's margin (they stay inside `C`). E41-K2's source bound adds `(V − offsetⱼ) ⊕ (⌈3 σⱼ s⌉ + b)` per inner shadow, as for drop shadows, so the samples at `p − offsetⱼ` for every output pixel are rendered.
- **V36-K2 passes.** Per inner shadow, after `L` is merged into `R`: blur `α(L)` as for a drop shadow (E41-K4, at `offsetⱼ`) into a scratch texture; an `innerTint` pass (replace) writes `colorⱼ × (1 − α_blurred(p − offsetⱼ) / c)` over the output bound into the other scratch texture; a `coverage` pass multiplies it by `min(α(L)(p) / c, 1)` (blend: `dst × src.a`); a `merge` pass draws it over `R`. `c` is a leaf root's content opacity (E41-K5 "Leaf roots").
- **V36-K3 module.** The E41 effect module becomes `e41-effect-v1`: kinds `innerTint` and `coverage`, and an edge mode in the pass record (`transparent`, E41's rule, or `clamp`, section 5.3). Drop-shadow and layer-blur passes keep their arithmetic: E41-A05's fixtures must still pass (V36-A04).

## 5. Background blur rendering

### 5.1 Semantics

For an effect root `N` with a visible background blur of σ, composited into its parent target `P`: let `D` be `P` just before `N`'s composite (everything below `N` in paint order), and `m(p) = min(α(L)(p) / (c × a_ref), 1)` the coverage, with `a_ref = coverageAlpha`. Then, before `R` is composited:

`P ← (G_σ ∗ D) × m × N.opacity  over  P`, clipped by `N`'s ancestor clip chain (E41-Q8 (a)).

So under an opaque part of the node nothing changes, and under a translucent fill the blurred backdrop shows through, which is Figma's frosted-glass result. Then `R` composites as in E41 (and with `N`'s blend mode when V-35 lands; the background blur itself is always source-over).

### 5.2 Coverage reference (V36-Q1 (a))

`L` holds paint, not geometry: a 20 % white fill has `α(L) = 0.2` inside the shape. To blur the whole shape, the projector sets `coverageAlpha` to the node's own fill alpha: a solid fill's alpha, the largest stop alpha of a gradient, or 1 for a node without a fill (groups, text, strokes only); below 1/255 the background blur is left out of the scene (a 0 % fill shows no blur, disclosed). Antialiased edges keep their fractional coverage. Strokes and children over the fill raise `α(L)` and clamp at 1.

### 5.3 Passes

At `N`'s composite slot in the parent's pass:

1. **Snapshot.** V-35's backdrop snapshot (V35-K4 in `docs/plans/viz-v35-fills-blend-contract.md`, `snapshotBackdrop(encoder, parent, rect, margin)` in `renderer-webgpu/src/backdrop-pipeline.ts`, plan field `backdrop: { margin }` on the root's layer scope in `renderer-core/src/backdrop-plan.ts`) with `rect = O` (`N`'s output bound) and `margin = ⌈3 σ s⌉`, clamped to `P`: a single-sample texture `D` and its device origin. The snapshot ends and resumes the parent pass as V-35 specifies; its extra texture usages are set only under `effects: 'v1'` or V-35's blend option, so E41-A06 holds.
2. **Blur.** E41-K4's chain on `D` with edge mode `clamp` (a backdrop is not transparent past the target edge), into `B` at `O`.
3. **Coverage.** A `coverage` pass reading `L` multiplies `B` by `m` (`1 / (c × a_ref)` scale).
4. **Composite.** `B` draws with E41's `effect-composite-v0` (opacity `N.opacity`, the root's clip state and stencil variant), then `R` as before.

### 5.4 Parents (V36-Q2 (a))

The snapshot reads the main target only. A root whose parent is an E25 layer or another effect root (its composite runs inside a tiled layer pass) draws without its background blur in v1; the frame statistic `backgroundBlurSkipped` counts it and the panel shows "Background blur needs a top-level layer here" on that effect. Nested parents are backlog (the backdrop would cross tiles).

### 5.5 Budget and limits

- Per background-blur root, E41 section 5.4 adds `D` at `4 × |(O ⊕ ⌈3 σ s⌉) ∩ P|` and `B` at `4 O`, and the scratch pair covers `D`'s blur chain; these count against the same 96 MiB tree admission, so a tree over budget drops all its effects with one `render.effect-resource-limit` as today.
- Pass splits per frame follow V-35's snapshot limit; a background-blur root past it draws without its blur and counts in `backgroundBlurSkipped`.

## 6. Editor

- **Commands.** E41's `addEffect`/`setEffect`/`removeEffect` take the new kinds. Defaults (Figma's): inner shadow black at alpha 0.25, offset (0, 4), radius 4; background blur radius 4. Adding a second background blur refuses with `editor.effect-limit`. `setEffect` may change `kind` between the two shadow kinds (fields kept) and between the two blur kinds (radius kept), one undo step.
- **Visual bounds.** E41 section 5.5 unchanged: inner shadows and background blur add no margin.
- **Panel.** The Effects section's add control lists Drop shadow, Inner shadow, Layer blur, Background blur (testids `effects-add-shadow`, `effects-add-inner-shadow`, `effects-add-blur`, `effects-add-background-blur`); each row has a kind select (`effect-<i>-kind`) over its family, and the existing fields. "Mixed" rules unchanged.

## 7. Acceptance criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| V36-A01 | Model: parse, validate (S1, S2, each refusal incl. a second background blur and new kinds in v7), migrate, serialize round trip | Unit (model) |
| V36-A02 | Scene and gate: S3, S4 (`'v0'` rejects, `'v1'` accepts, projector `true` leaves new kinds out, `coverageAlpha` per 5.2 incl. the 1/255 cut) | Unit |
| V36-A03 | Planner: K1 bounds, K2 pass list for 1-3 inner shadows with and without drop shadows and layer blur; background-blur pass list and budget per 5.5 | Unit (renderer-core, renderer-webgpu) |
| V36-A04 | GPU against the CPU oracle (E41-A05's method and tolerances): G1 inner shadow on a rectangle, G2 rotated 30°, G3 two inner shadows plus a drop shadow on a 50 %-alpha fill, G4 inner shadow on text, G5 background blur (radius 20) of a 30 % fill over a striped backdrop, G6 G5 inside a clipping frame, G7 G5 at the target edge (clamp); E41's F1-F12 still pass | SwiftShader in CI container, headed reference PC |
| V36-A05 | Identity: scenes without the new kinds give byte-identical captures under `'v0'` and `'v1'`; scenes without effects unchanged (E41-A06) | SwiftShader, headed |
| V36-A06 | Nested background blur draws the node without the blur and counts `backgroundBlurSkipped` | GPU spec |
| V36-A07 | Commands: defaults, limits, kind changes, multi-select, undo | Unit (editor-core) |
| V36-A08 | next-host: add, edit, hide and remove an inner shadow and a background blur from the panel; pixel probes show each | Headed, Chrome and Edge |
| V36-A09 | Performance: `e41-cards` with every fifth card a 30 %-fill glass card with background blur radius 20 and one inner shadow: typical view and drag medians ≤ 16.7 ms on the reference PC; a miss is disclosed and the user decides | Benchmark record |

## 8. Fixtures

G1 to G7 above, in `tests/gpu/e41-effects.spec.ts` beside F1-F12, and a `v36-glass` variant of the E26 `e41-cards` scenario.

## 9. Open choices (recommended first; (a) adopted 2026-11-12, 추천안 자동 채택)

- **V36-Q1 background-blur coverage.** (a) `α(L)` normalized by the node's fill alpha (5.2), no extra render; (b) raw `α(L)` (a 20 % fill gives a 20 % blur, not Figma's look); (c) a second geometry-only render of each root (exact coverage, doubles the layer cost).
- **V36-Q2 nested parents.** (a) main target only in v1, disclosed and counted; (b) backdrop across layer tiles now (a tile-set redesign).
- **V36-Q3 backdrop edge.** (a) clamp to the target's edge pixels, as browsers do for `backdrop-filter`; (b) transparent (darkens toward the screen edge).
- **V36-Q4 backdrop mechanism.** (a) V-35's snapshot, one mechanism for blend modes and background blur; if V-35 has not merged when U3 starts, U3 implements the snapshot to V-35's contract; (b) a separate copy path for background blur.

## 10. Units

| Unit | Scope | Gate |
| --- | --- | --- |
| U1 | This contract, requirements.md, track row | Independent review READY |
| U2 | Inner shadow end to end: model kinds (v8), scene, gate `'v1'`, K1-K3, commands, panel, SwiftShader G1-G4 | V36-A01-A05 (inner-shadow half), A07; CI |
| U3 | Background blur: snapshot use, passes 5.3, coverage, 5.4 skip, budget, commands and panel | V36-A02-A06 (background half); CI |
| U4 | Hosts on `'v1'`, headed A04/A08 on the reference PC, `v36-glass` bench, evidence index and exit record | V36-A04, A08, A09; user accepts |

U2 can merge before V-35; U3 follows V-35's snapshot (or Q4 (a)'s fallback).

## 11. Risks

- **Pass splits.** Each background blur ends and resumes the main pass and copies its backdrop: bandwidth with MSAA stored. A09 measures it; the split limit bounds it.
- **Coverage approximation.** Gradient fills with varying alpha get partial blur where the alpha is below the largest stop (5.2); disclosed.
- **Schema race.** v8 is shared by the Figma-gap items; the U2 PR rebases onto whatever v8 is on `main` at its merge slot.
