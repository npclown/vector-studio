# V-36 contract: inner shadow and background blur

Status: **ADOPTED 2026-11-12** (review round 3 READY; section 12), Full tier. Exit: **DONE 2026-11-12**, accepted by the user with A10's disclosed miss ([exit record](../evidence/v36/exit-2026-11-12.md)); the background-blur cost reduction is backlog E42 ([rendering track](d9-rendering-track.md)). The user asked for this on 2026-11-12 (item 6 of the Figma gap list, "1~10번까지 다 진행해줘"), which lifts the [requirements.md](../requirements.md) deferral of inner shadows and background blur. The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24 (추천안 자동 채택 2026-11-12) unless the user picks otherwise.

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

- **V36-S3.** `SceneEffect` gains `{ kind: 'innerShadow'; color; offsetX; offsetY; sigma }` (a drop shadow's fields) and `{ kind: 'backgroundBlur'; sigma }`. Validation adds the kinds and the one-background-blur rule; `effectsEqual` compares kinds first.
- **V36-S4 gate.** The renderer option `effects` gains `'v1'`: `'v0'` accepts only E41's kinds and reports a scene with a new kind as `unsupported-feature`; `'v1'` accepts all four and, as `'v0'`, requires `groups: 'isolated'`. Until U3 lands, a `'v1'` renderer draws a background-blur root without its blur and counts it in `backgroundBlurSkipped` (section 5.4's fallback). The scene mirror takes the same three values (tests only).
- **V36-S5 projector.** `EditorOptions.projectEffects` takes `true` (E41's kinds only: the new kinds are left out of the scene, so a host on `'v0'` keeps drawing the node) or `'v1'` (all kinds). next-host and `webgpu-host` move to `'v1'` in U2. `docs/host-api.md` documents the option (U2).
- A node whose only visible effects are new kinds is an effect root in E41's sense (E41-S7 depth, E41 section 5.2).

## 4. Inner shadow rendering

### 4.1 Semantics (V36-Q1 (a))

E41 section 5.1 with `L` the root's content at opacity 1 and `c` a leaf root's content opacity (1 for a container). Inner shadows use the **hardened coverage** `h(p) = min(127 × α(L)(p) / c, 1)`, Figma's `hardAlpha`: any paint at alpha ≥ 1/127 covers fully, so a translucent fill gets an edge shadow, not a tinted interior, as in Figma and CSS `inset`. Each visible inner shadow `j`, in list order:

`Iⱼ(p) = colorⱼ × h(p) × (1 − (G_σⱼ ∗ h)(p − offsetⱼ))`

and `R = Iₖ over … over I₁ over L over Sₙ over … over S₁` (inner shadows over the content, drop shadows under it). A layer blur then blurs `R`, and the composite is E41's step 4. `h` is 0 outside `C`, so `C`'s edge casts the full colour inward; an offset larger than the shape gives the full colour everywhere in it.

### 4.2 Bounds and passes

- **V36-K1 reach.** Inner shadows add nothing to E41-K1's output margin `m` (they stay inside `C`). E41-K3's cull reach (U4b's world reach) becomes `3 σ_blur + max(maxᵢ(3 σᵢ + |offsetᵢ|) over drop shadows, maxⱼ(3 σⱼ + |offsetⱼ|) over inner shadows)`: inner shadows join the same max under the layer-blur term, so content the shadow samples is drawn. E41-K2's source bound adds `(V − offsetⱼ) ⊕ (⌈3 σⱼ s⌉ + b)` per inner shadow, as for drop shadows.
- **V36-K1b cut sides.** Where the source bound is cut short of `C` (E41-K2's mask-group target clamp, a backend without off-target layers, E41's layer reach limit), the record carries those sides, and `harden` reads `L` with edge mode `clamp` on them (per side), so the cut is not taken for an edge of the shape. Because `harden` writes over the whole level-0 region its readers use (K2), no later pass reads past it. Fixture G8 covers it.
- **V36-K2 passes.** After `L` is merged into `R`, per inner shadow: `harden` (replace) writes `h` into `scratch1` over `H`, the level-0 region that the shadow's first reader reads (E41-K4's chain region for the first downsample or the horizontal blur, or `sampledRegion(O, offsetⱼ)` when σ is below `EFFECT_SIGMA_EPSILON_PX`), reading `L` with K1b's edge mask; E41-K4's blur chain blurs it at `offsetⱼ` (from `scratch1`, as from `L`); `innerTint` (replace) writes `colorⱼ × (1 − min(b, 1))`, `b` the blurred `h` sampled bilinearly at `p − offsetⱼ`, over the output bound into the scratch texture the blur did not end in (with σ below epsilon, it reads `scratch1` unblurred and writes `scratch0`); `coverage` (blend `dst × src.a`, a new render state) multiplies it by `h(p)` read from `L` (scale 127 / c); `merge` draws it over `R` at scale 1. E41's drop-shadow skip rule (reach + 2 px) does not apply. `H` lies within `O ⊕ (⌈3 σⱼ s⌉ + |offsetⱼ| + 2)` plus the chain's slack (5.5).
- **V36-K3 module.** The effect module becomes `e41-effect-v1`, a deliberate re-pin of the effect module's shader key only: kinds `harden`, `innerTint` and `coverage`, and an edge mask in the pass record (bit per side; 0 is E41's transparent rule). Non-effect pipeline keys and shader hashes are unchanged, and E41's F1-F12 captures are byte-identical before and after on SwiftShader (V36-A05).

## 5. Background blur rendering

### 5.1 Semantics

For an effect root `N` with a visible background blur of σ, composited into its parent target `P`: let `D` be `P` just before `N`'s composite (everything below `N` in paint order, not `N`'s own shadows), `h` the hardened coverage of 4.1, and `o` the root's composite opacity (E41 U5a: layer opacity × c for a leaf). Before `R` is composited:

`P ← (G_σ ∗ D) × h × o  over  P`, clipped by `N`'s ancestor clip chain (E41-Q8 (a)),

then `R` composites as in E41 (with `N`'s blend mode, V-35, over `P` as the background blur left it; the background blur itself is source-over). Under an opaque part nothing changes; under a translucent fill the blurred backdrop shows through, Figma's frosted glass. A 0 % fill shows no blur (`h` = 0). `N`'s drop shadows are in `R`, so under E41-Q6 (a) they show through the glass over the blurred backdrop (V36-Q5 (a), fixture G9); with a layer blur, `h` comes from the unblurred `L`. With σ below `EFFECT_SIGMA_EPSILON_PX` there is no snapshot, split or pass.

### 5.2 Passes

At `N`'s composite slot in the parent's pass:

1. **Snapshot.** V-35's backdrop snapshot (V35-K4 in `docs/plans/viz-v35-fills-blend-contract.md`, as amended there: `snapshotBackdrop(encoder, parent, rect, margin, into, record)` in `renderer-webgpu/src/backdrop-pipeline.ts`, which fills the root's snapshot texture `into` and returns it, or null for an empty rectangle; the caller ends the parent pass before it and resumes it after; packet field `backdrop: { margin }`) with `rect = O` (`N`'s output bound inside `P`) and `margin = backdropMargin(σ_px)`, a bound on the level-0 extent of E41-K4's read chain for σ beyond `O` (downsample blocks, taps and bilinear slack), clamped to `P`: a single-sample `D` and its device origin. The main target's snapshot usage is V-35's (amended 2026-11-12, U3): the backend creates V-35's blend set (snapshot and composite pipelines; background blur draws only when the whole set exists, V35-K7) and gives the main attachment `TEXTURE_BINDING` under `effects: 'v1'` as under V-35's `blend: 'v0'` (scene validation still refuses blend modes without `blend: 'v0'`), so E41-A06 holds for the other options.
2. **Blur.** E41-K4's chain on `D` (surface `backdrop`), its first reader with every edge `clamp` (Q3: only `P`'s edge is ever reached), into `B` (surface `blurred`) at `O`.
3. **Coverage.** A `coverage` pass reading `L` (scale 127 / c) multiplies `B` by `h`.
4. **Blend roots.** When `N` is also a V-35 blend root, a `merge` pass at scale `o` draws `B` over `D` inside `O`, so the blend composite of `R` reads `P` as the background blur left it.
5. **Composite.** The parent pass resumes; `B` draws with `effect-composite-v0` at `o`, with the root's clip state and stencil variant, then `R` as before (with its mode for a blend root).

### 5.3 Top-level roots (V36-Q2 (a))

The snapshot with a margin reads the main target only. A background blur draws only when `N`'s composite is in the main pass: no ancestor of `N` is an E25 layer (a container with `0 < opacity < 1`) or an effect root. Otherwise `N` draws without its background blur in v1 and the frame statistic `backgroundBlurSkipped` counts it. The panel applies the same rule on the document (an ancestor with opacity < 1, visible effective effects (E41-S10: an instance without effects of its own counts with its symbol's) or a V-35 blend mode other than pass-through, which makes it a layer too; inside a symbol, each of its instances' ancestry counts) and shows "Background blur shows only outside groups with opacity or effects" on that effect. Nested parents are backlog (the backdrop would cross tiles).

### 5.4 Fallbacks

`backgroundBlurSkipped` counts a root whose blur is not drawn: nested (5.3), when the backdrop snapshot pipeline is unavailable (V35-K7) or its snapshot rectangle is empty, or on a `'v1'` renderer without U3. The backend exposes it beside E41's `effectPasses` (a per-generation count of drawn roots per frame, read by tests and benches); a host-visible statistic is backlog. V-35 has no per-frame split limit (amended 2026-11-12, U3): a background-blur root costs one split per frame, counted in V35-K8's split counter, and is not counted in V35-K6's 64-blend-root limit; its bytes count in the budget (5.5). When the `harden`, `innerTint` or `coverage` pipeline is unavailable, roots draw as E41 section 5.3 says (content without effects).

### 5.5 Budget

E41 section 5.4 with: each inner shadow's `H` counts in the scratch term, `4 × (2 + 2/3) × max(maxᵣ Oᵣ, maxᵣ,ⱼ |Hᵣⱼ|, max |D|)`; per background-blur root, `D` at `4 × |(O ⊕ margin) ∩ P|` and `B` at `4 O`, counted per root (conservative: they are used one root at a time). These count against the same 96 MiB tree admission; a tree over budget drops all its effects with one `render.effect-resource-limit`, as today.

## 6. Editor

- **Commands.** E41's `addEffect`, `setEffect` and `removeEffect` take the new kinds. Defaults (Figma's): inner shadow black at alpha 0.25, offset (0, 4), radius 4; background blur radius 4. A second background blur refuses with `editor.effect-limit` (its notice says "at most one layer blur and one background blur").
- **Kind change.** `setEffect` accepts a `kind` patch within a family: drop shadow and inner shadow keep colour, offsets and radius; layer blur and background blur keep the radius. A change that would give any selected node a second blur of one kind refuses the whole command with `editor.effect-limit` at that node's `/effects` and no change, as `addEffect` does. With several nodes selected, a node whose effect at the index is in the other family is left unchanged; one undo step.
- **Visual bounds.** E41 section 5.5 unchanged: inner shadows and background blur add no margin.
- **Panel.** The add control lists Drop shadow, Inner shadow, Layer blur, Background blur (testids `effects-add-shadow`, `effects-add-inner-shadow`, `effects-add-blur`, `effects-add-background-blur`); the `EffectsModel` takes the kinds its host projects, so the list never offers a kind the host does not draw. Each row has a kind select (`effect-<i>-kind`) over its family, "Mixed" and disabled when selected rows differ in family; other fields as in E41.

## 7. Acceptance criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| V36-A01 | Model: parse, validate (S1, S2, each refusal incl. a second background blur and new kinds in v7), migrate, serialize round trip | Unit (model) |
| V36-A02 | Scene, gate and projector: S3 to S5 (`'v0'` rejects, `'v1'` accepts, projector `true` leaves new kinds out) | Unit |
| V36-A03 | Planner against the CPU oracle of 4.1 (pass-by-pass twin, binary64): 1-3 inner shadows with drop shadows and layer blur, σ 0, an offset past the shape, a leaf at c 0.5, a container root, downsampled σ, cut sides (K1b: no inner-shadow band along a cut side, against an oracle on the uncut `L`); K1 cull reach; background-blur pass list, margin and budget per 5.5 | Unit (renderer-core, renderer-webgpu) |
| V36-A04 | GPU against the CPU oracle (E41-A05's method and tolerances; the oracle hardens the exact `L` read back, and the headed run may exclude texels with `0 < α(L) < 2/255`, where the 127× gain amplifies device differences; for background blur the oracle reads `D` from a capture without `N`): G1 inner shadow on a rectangle, G2 rotated 30°, G3 two inner shadows and a drop shadow on a 50 %-alpha fill, G4 on text, G5 background blur radius 20 of a 30 % fill over stripes, G6 G5 in a clipping frame, G7 G5 at the target edge, radius 40 (downsampled, clamp), G8 an inner-shadowed group holding a mask group across the target edge, G9 background blur with a drop shadow on a leaf at opacity 0.5 | SwiftShader in the container; headed reference PC |
| V36-A05 | Identity: E41's F1-F12 and scenes without the new kinds give byte-identical captures under `'v0'` and `'v1'` and before and after the module re-pin; scenes without effects unchanged (E41-A06) | SwiftShader, headed |
| V36-A06 | Fallbacks: a nested background blur, one without the snapshot pipeline and one on a pre-U3 renderer draw without the blur and count `backgroundBlurSkipped`; pipeline failure per 5.4 | GPU spec, unit |
| V36-A07 | Invalidation and resources: editing either kind costs 0 port calls and 0 geometry builds (E41-A07); `D` and `B` in accounting, released after submission, on device loss and dispose (E41-A09) | Unit, GPU counters |
| V36-A08 | Commands: defaults, limits and notice, kind changes and their refusals, multi-select across families, undo | Unit (editor-core) |
| V36-A09 | next-host: add, edit, hide and remove an inner shadow and a background blur from the panel, pixel probes show each; the nested message shows inside a 50 % group | Headed, Chrome and Edge |
| V36-A10 | Performance: `e41-cards` with every fifth card a 30 %-fill glass card with background blur radius 20 and one inner shadow: typical view and drag medians ≤ 16.7 ms on the reference PC; a miss is disclosed and the user decides | Benchmark record |

## 8. Fixtures

G1 to G9 above in `tests/gpu/e41-effects.spec.ts` beside F1-F12 (U4 adds G10 and G10b, a background blur on a blend root), and a `v36-glass` variant of the E26 `e41-cards` scenario.

## 9. Open choices (recommended first; (a) adopted 2026-11-12, 추천안 자동 채택)

- **V36-Q1 coverage.** (a) Figma's hardened alpha `h` for inner shadows and background blur alike: edge-only inner shadows on translucent fills, whole-shape glass, no projector field; (b) raw `α(L)` (tints a translucent interior; a 20 % fill gives a 20 % blur); (c) a geometry-only second render of each root (exact, doubles layer cost).
- **V36-Q2 nested parents.** (a) background blur only for roots composited in the main pass in v1, disclosed and counted; (b) backdrops across layer tiles now (a tile-set redesign).
- **V36-Q3 backdrop edge.** (a) clamp to the target's edge pixels, as browsers do for `backdrop-filter`; (b) transparent (darkens toward the screen edge).
- **V36-Q4 backdrop mechanism.** (a) V-35's snapshot, one mechanism for blend modes and background blur; if V-35 has not merged when U3 starts, U3 implements it to V-35's contract; (b) a separate copy path.
- **V36-Q5 own shadow under glass.** (a) `D` excludes `N`'s drop shadows, which show through the glass (E41-Q6 (a)); (b) composite shadows before the snapshot (splits `R` in two).

## 10. Units

| Unit | Scope | Gate |
| --- | --- | --- |
| U1 | This contract, requirements.md, track row | Independent review READY |
| U2 | Inner shadow end to end: model kinds (v8), scene, gate and projector `'v1'`, K1-K3, the pre-U3 fallback, commands, panel (inner shadow only), hosts on `'v1'`, host-api.md, SwiftShader G1-G4, G8 | V36-A01-A03, A05, A07, A08 (inner-shadow half), A06's pre-U3 case (a `backgroundBlur` scene on `'v1'`, unit); CI |
| U3 | Background blur: snapshot use, 5.2 passes, 5.3-5.5 (`backgroundBlurSkipped` stays a counter beside `effectPasses`, see 5.4), panel kind and message | V36-A02-A04, A06, A07 (background half); CI |
| U4 | Headed A04/A09 on the reference PC, `v36-glass` bench, evidence index and exit record | V36-A04, A09, A10; user accepts |

U2 can merge before V-35; U3 follows V-35's snapshot (or Q4 (a)'s fallback).

U4 status (2026-11-12, merged as #598 `c863fa6`; the headed reference-PC runs at `366d34e` and the exit record are in [exit-2026-11-12.md](../evidence/v36/exit-2026-11-12.md): A04 and A09 pass in Chrome and Edge, A10 a disclosed miss awaiting the user's decision):

- **A09.** `tests/e41-next-host/v36-effects.spec.ts` in `playwright.e41-studio.config.ts` (headed Chrome and Edge; the shapes are set up with editor commands, every effect step goes through the panel): an inner shadow added (the defaults), edited to opaque blue at offset (0, 20) and radius 0, hidden, shown and removed, with a probe in the band under the top edge (blue) and at the centre (red); a background blur on a white 20 % rectangle over 10 px black and white stripes, added (no nested note at the top level), widened to radius 20, hidden, shown and removed, with probes over a black and a white stripe (sharp 51 and 255, blurred about 153); a background blur inside a group at 50 % opacity shows `effect-0-nested-note` with the section 5.3 text, which goes at opacity 1. The add steps are checked by panel and model state; the pixels are probed from the edit step on (as in `e41-effects.spec.ts`; the default inner shadow and a radius-4 background blur change too little to probe robustly), recorded at review 2026-11-12. The pixel probes follow `e41-effects.spec.ts`' rule (the smoke project checks them when its renderer starts). Run headless on SwiftShader in the container with the geometry WASM built: 3 passed with the probes checked (blue `[0, 0, 255]` in the band; stripes `[51, 51, 51]` and `[255, 255, 255]` sharp, `[152, 152, 152]` and `[154, 154, 154]` blurred). Reference-PC command (PowerShell, repository root, after `pnpm build`): `pnpm test:e41-next-host tests/e41-next-host/v36-effects.spec.ts`; expected 6 tests pass (3 tests, Chrome and Edge).
- **A10.** The scene is `v36-glass` in the E26 harness (`tests/e26/scenarios.ts`, `generateV36GlassDocument` and `V36_GLASS`; scenarios `v36-glass-view/v1` and `v36-glass-drag/v1`, `e41-cards`' fitted camera, 16.7 ms median ceiling; `tests/unit/v36-glass.test.ts`): `e41-cards`' 50 cards, every fifth (index 0, 5, ...; 10 cards) a glass card whose background's one fill is white at alpha 0.3 and whose card root, a group on the page (a main-pass root, 5.3), appends the editor's default inner shadow and a background blur of radius 20 to `e41-cards`' effects (the glass cards at index 0, 10, ... keep their layer blur). The unit test checks that the 10 roots project with `backgroundBlur` under `projectEffects: 'v1'` and none under `true`, that the panel rule marks none nested, and that the packet asks a main-pass backdrop for each. The harness checks the effect and backdrop pipelines exist, `effectPasses` is 50 per submitted frame, the splits (V35-K8, here the background blurs' snapshots, as the scene has no blend roots) are 10 per submitted frame and `backgroundBlurSkipped` is 0, and records `blendSplits` and `backgroundBlurSkipped` over the window; the snapshot and blur GPU time is the frame's `vs-gpu`. Two readings, recorded at review 2026-11-12: the A10 row's "typical view" is the `fitted` camera scenario (as E41-A10 and V35-A10; E26's separate `typical` camera is not used), and the drag scenario drags `card-22`, `e41-cards`' drag target, which is not a glass card, so the drag median measures 10 background blurs redrawn under a moving card rather than a moving glass card. Reference-PC command (PowerShell, repository root, after `pnpm build`): `$env:M8_N3_BASELINE='docs/evidence/m8-a14-2026-11-01/17a2b0a-main-pc-headed.json'; $env:E26_SCENARIOS='v36'; $env:E26_RESULTS_DIR='test-results/v36-a10'; pnpm test:e26 --project=chrome-dpr1 --project=chrome-dpr2`. Expected: 20 tests pass (2 scenarios, 5 repetitions, 2 projects) and `test-results/v36-a10/` holds one JSON per run (`chrome-dpr1--v36-glass-view_v1--r1.json` and so on) with `measurements`, `framesSubmitted`, `effectPasses`, `blendSplits`, `backgroundBlurSkipped` and the pipeline flags; the verdict is at DPR 2, DPR 1 is an observation, and the records go under `docs/evidence/v36/`. The container's smoke run (`E26_CHROMIUM=/opt/pw-browsers/chromium E26_SCENARIOS=v36 pnpm test:e26`, with the geometry WASM built) loads the scene (50 roots) and renders it on SwiftShader: 2 passed (the `-v2` projects skip), 50 effect passes and 10 splits per frame, 0 skipped; not evidence.
- **A04, blend roots.** U3's disclosure (4) is closed by G10 and G10b in `tests/gpu/e41-effects.spec.ts` (`blend=v0` pages): a background blur of radius 20 on a `multiply` leaf with a 50 % amber fill, and one of radius 16 on a `screen` leaf at opacity 0.6 with a drop shadow (5.2 step 4), against the oracle `P ← B × o over D`, then `R × o` composited with the mode over it (V35-R2 on an opaque backdrop), at 1x and 4x, with one split per frame, the blend composite drawn every frame, 0 skipped, and more than 500 pixels changed by the mode and by the blur. SwiftShader: worst error 0.86/255 (G10) and 1.06/255 (G10b) at 1x and 4x (tolerance 3/255). Reference-PC command: `$env:VS_GPU_EDGE='1'; pnpm test:gpu tests/gpu/e41-effects.spec.ts`.

## 11. Risks

- **Pass splits.** Each background blur ends and resumes the main pass and copies its backdrop: bandwidth with MSAA stored. A10 measures it; the 96 MiB budget bounds its bytes (V-35 has no split limit).
- **Hardened edges.** `h` saturates at alpha 1/127, so antialiased edges of very faint content look harder than `α(L)` would; this matches Figma's export and is disclosed.
- **Schema race.** v8 is shared by the Figma-gap items; the U2 PR rebases onto whatever v8 is on `main` at its merge slot.

## 12. Review record

- **Round 1 (2026-11-12): NOT READY**, 3 blocking and 12 should-fix findings, all applied: B1 the inner-shadow formula tinted translucent interiors, now Figma's hardened coverage (Q1 rewritten, `coverageAlpha` removed); B2 inner shadows now extend the cull reach and clamp at cut sides (K1, K1b, G8); B3 the pre-U3 fallback and the panel's projected kinds (S4, S5, section 6, hosts on `'v1'` in U2); S1 pass details (K2); S2 the snapshot margin from K4's read chain; S3 own shadows and layer blur with background blur (5.1, Q5, G9); S4 tiny σ; S5 dropped with `coverageAlpha`; S6 "top-level" defined (5.3, requirements); S7 kind changes (section 6); S8 budget terms (5.5); S9 the module re-pin and byte identity (K3, A05); S10 criteria A03, A04, A06, A07; S11 host-api.md (U2); S12 the composite opacity `o`.
- **Round 2 (2026-11-12): NOT READY**, 1 blocking, 5 should-fix, 1 nit, all applied: N1 the K1b clamp sat on a pass that never read past its region, now `harden` writes over its readers' whole region `H` (K1b, K2, 5.5); N2 the pre-U3 fallback test moved into U2's gate; N3 the cull reach formula; N4 effective (inherited) effects in the panel rule; N5 whole-command refusal of kind changes; N6 the track row; the nit on the 127× gain (A04).
- **Round 3 (2026-11-12): READY**, one nit (5.5's wording now names `H`), applied.
- **U3 amendments (2026-11-12, d16cd61 and the U3 PR)**: 5.2 names V-35's real seam (`snapshotBackdrop(encoder, parent, rect, margin, into, record)`), the `backdrop` and `blurred` surfaces, the blend-root merge (step 4) and the usages under `effects: 'v1'` (also recorded in V35-K4 and E10 section 3.2); 5.4 drops "V-35's per-frame split limit" (V-35 has none) for the missing snapshot pipeline, and `backgroundBlurSkipped` stays a counter beside `effectPasses` (a host-visible statistic is backlog); A06 follows; 5.3's panel rule also counts container blend modes and, inside a symbol, each instance's ancestry.
- **U3 review (2026-11-12, independent reviewer): READY**, no blocking items. Applied: the V-35 K4 and E10 records, this record and the track row, the evidence wording on loss and dispose. Disclosed: (1) the blend-root merge into `D` (step 4) is not clipped, so a clipped background-blur root that is also a blend root differs from 5.1 in its clip's antialiased edge band (0 < clip coverage < 1); (2) a root whose parent layer was dissolved (V35-K6's fallback turning a `normal` container into `passThrough`) is still treated as nested and draws without its blur, counted; (3) the panel counts a container's `normal` blend mode as a layer even on a host that does not project blend, where it may show the nested note for a blur that draws; (4) no SwiftShader fixture combines a background blur with a blend mode (step 4 has unit and CPU-twin coverage only); U4's headed run adds one.
