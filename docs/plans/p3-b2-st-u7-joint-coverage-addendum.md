# P3 B2 ST-U7 addendum: joint fill and stroke coverage at node opacity below 1

Status: **DRAFT 2026-10-21, revision 2.** It is for independent re-review and the user's answers to ST7-Q1 to ST7-Q8. Independent review round 1 was **NOT READY**: three blocking items, seven SHOULD-FIX and four minor items, all applied in revision 2 (section 9).

This addendum is the design document that unit ST-U7 of the frozen [B2 stroke contract](p3-b2-stroke-contract.md#121-units) requires before any ST-U7 code ([B2 contract :733](p3-b2-stroke-contract.md#121-units)). It is full tier, because it:

- removes a D8-interim failure;
- adds a renderer draw kind;
- extends a time-bounded architecture exception;
- changes the exported `PathMeshFailureCode` union of `renderer-core` (`packages/renderer-core/src/index.ts:18`);
- supersedes one clause of the frozen ST-A10.

It is documentation only, and no code, run or record follows from it until it is frozen. The [P3 plan](p3-fill-stroke-meshes.md) owns status. Line citations refer to `main` at `4713307`.

**Evidence label.** Every result under this addendum is functional evidence. Precision stays **UNVERIFIED** against the 0.25 physical-pixel target until B4 has A04 evidence ([B2 contract :48](p3-b2-stroke-contract.md)). ST-U7 closes no A01-A08 criterion and no C03-C05 item.

**Identifiers.** This addendum prefixes its own IDs with **ST7-**:

| Kind           | IDs               |
| -------------- | ----------------- |
| Options        | ST7-A to ST7-E    |
| Requirements   | ST7-J1 to ST7-J9  |
| Fixtures       | ST7-F1 to ST7-F15 |
| Seeded defects | ST7-D1 to ST7-D11 |
| Questions      | ST7-Q1 to ST7-Q8  |
| Risks          | ST7-R1 to ST7-R11 |

Its units are ST-U7a to ST-U7d. Its acceptance rows continue the contract's series as ST-A13 to ST-A18, with ST-A11 refined and ST-A10 amended. Every other ID keeps its owner's meaning.

## 1. Authority, scope and inputs

### 1.1 What this addendum may and may not change

**What it implements.** The frozen ST-U7 row: "Joint-coverage fill draw for both paints at `0 < opacity < 1`, removing `composition-unsupported`. Starts with its own design addendum (overlay of the two meshes, feature lists, roles), independently reviewed and approved before code" ([B2 contract :733](p3-b2-stroke-contract.md#121-units)).

**The direction is already approved.** The approved [B2 proposal §5.6](p3-b2-stroke-proposal.md#56-renderer-composition-with-v3) chose the joint two-draw scheme (`docs/plans/p3-b2-stroke-proposal.md:235`). B2-Q6 (a) staged it as ST-U7 (`:316`, `:326`). What B2 left open is how the overlay is produced and represented. That is the substance of this addendum and of ST7-Q2.

**What it changes.** No requirement, threshold or user decision. Specifically:

- **Decisions unchanged:**
  - B2-Q1 to B2-Q9, all (a) ([proposal :326](p3-b2-stroke-proposal.md#8-review-and-approval-record));
  - V3-Q1 to V3-Q3 ([V3 :659-661](p3-v3-renderer-mesh-pipeline-contract.md#review-record));
  - the V3-Q2 (c) note for `fringe-work-cap` ([V3 :665](p3-v3-renderer-mesh-pipeline-contract.md#review-record)).
- **Rule and tolerances unchanged:** the O02 rule and the 2/255 tolerances stay as written.
- **No requirements text.** **No `docs/requirements.md` text is affected.** Its only relevant line is "Opacity" in the appearance model (`docs/requirements.md:92`). Nothing in it names the producer of path meshes.
- **The one frozen-text change.** ST-A10's `composition-unsupported` clause (`docs/plans/p3-b2-stroke-contract.md:751`) is superseded by a dated note (section 5.1). The ST-U7 row's own words, "removing `composition-unsupported`", require that.

### 1.2 Inputs

**Composition and opacity**

| Input                                                                                          | What it fixes for ST-U7                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [P1 D2](p1-instanced-primitives.md#d2--approved-p1-visual-behavior)                            | `L = S + F·(1 − S.a)`, then `P = L·opacity`, then `P + destination·(1 − P.a)`; "must not simulate this by blending fill and stroke separately with node opacity" (`docs/plans/p1-instanced-primitives.md:154`)                                                        |
| [Visible semantics](p3-visible-semantics-proposal.md#composition-invariant-and-technical-work) | The approved example: opaque red fill, opaque blue stroke, opacity 0.5 over transparent black gives `(0, 0, 0.5, 0.5)` in the overlap; "not approval of an offscreen architecture" (`docs/plans/p3-visible-semantics-proposal.md:31`)                                 |
| [Private contract](p3-private-contract.md#private-transport-and-lifetime-requirements)         | Safe directions are "region-partitioned fill/stroke evaluation or another proven single-opacity mesh scheme"; "No offscreen isolation, stencil reinterpretation or alternative path-renderer architecture is approved here" (`docs/plans/p3-private-contract.md:183`) |
| Same, next paragraph                                                                           | The union of fill and stroke is not one undifferentiated paint; region attribution and boundary reconstruction need evidence (`docs/plans/p3-private-contract.md:185`)                                                                                                |
| [B2 contract §2.3](p3-b2-stroke-contract.md#23-rows)                                           | "Composition with fill. Unchanged from the approved invariant ... fill and stroke attributed separately until composition" (`docs/plans/p3-b2-stroke-contract.md:138`)                                                                                                |
| [B2 contract §9.6](p3-b2-stroke-contract.md#96-composition-and-the-opacity-staging-b2-q6)      | Two-draw exactness at `o = 1` and for one paint; the interim `composition-unsupported` for both paints at `0 < o < 1`; whole-path failure when one paint fails (`:564-568`)                                                                                           |
| [B2 proposal §5.6](p3-b2-stroke-proposal.md#56-renderer-composition-with-v3)                   | The exact two-draw scheme: the stroke draw outputs `o·S'`, the fill draw `o·F'·(1 − S'.a)/(1 − o·S'.a)`; "fill triangles need stroke feature lists and roles: an overlay of the two meshes" (`docs/plans/p3-b2-stroke-proposal.md:235`)                               |
| B2-Q6                                                                                          | Option (c), "Offscreen isolation per path: an architecture change the private contract does not approve", was not chosen; (a) staged ST-U7 was (`docs/plans/p3-b2-stroke-proposal.md:316`, `:326`)                                                                    |

**Coverage and the V3 renderer**

| Input                                                                                               | What it fixes for ST-U7                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [O02 contract](p3-o02-a5-coverage-contract.md#coverage-rule-q2-q3)                                  | `c = clamp(0.5 − s/w, 0, 1)` at the pixel center (`:100-104`); value a function of the pixel center only (`:115`); global order with strict `<` (`:139`); far-field clamp and its 0.104 px margin (`:141-149`); the frame partition check (`:188`); the GPU partition assumption (`:193`) |
| [V3 section d](p3-v3-renderer-mesh-pipeline-contract.md#d-mesh-cache-failure-memo-and-their-bounds) | Budget, working set (`:229-230`) and its pending-sibling amendment: the published entries of a path held back only by a missing sibling paint stay in the working set (`:250`)                                                                                                            |
| [V3 section e](p3-v3-renderer-mesh-pipeline-contract.md#e-a5-coverage-on-k4)                        | O02 reused unchanged (`:254`); list reach `ρ = 2^f` mapping to at least 2 px (`:264`); empty-list exterior triangles dropped (`:265`); frame corners at exact `m + k` (`:269`); exact partition check (`:282`); "Region triangles are the port's, unchanged" (`:284`)                     |
| [V3 section f](p3-v3-renderer-mesh-pipeline-contract.md#f-the-mesh-packet-part-and-the-mesh-draw)   | `MeshFillDraw` (`:300-306`); `u = fround(v − m)` (`:335`); 32-byte triangle records with two zero words (`:360`); 64-byte instance records with one zero word (`:363`); the draw and fragment formula (`:371-378`); the pipeline, bindings and creation rules (`:382-387`)                |
| [V3 section g](p3-v3-renderer-mesh-pipeline-contract.md#g-paint-order-and-composition)              | Opacity reaches each sample once because region and exterior triangles partition the frame; "No offscreen isolation, stencil or extra pass is used" (`:404`)                                                                                                                              |
| V3 sections h and i                                                                                 | The D8-interim notice, codes and removal rule (`:410-441`); `fringe-work-cap` draws region-only (`:410`); device loss rebuilds from CPU entries without a port call (`:451`)                                                                                                              |
| V3-Q3 (c)                                                                                           | The exact TypeScript fringe builder runs as a time-bounded D8-interim exception to `ARCHITECTURE.md:52-54` and private contract line 8; the builder "adds no fill region, moves no vertex, adds no Steiner point" (`docs/plans/p3-v3-renderer-mesh-pipeline-contract.md:577`, `:583`)     |

**Architecture texts, code and evidence**

| Input                                                                           | What it fixes for ST-U7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Graphics architecture](../graphics-engine-architecture.md#primitive-rendering) | The texts this addendum touches: "Arbitrary path fills and strokes use WASM-produced meshes" (`docs/graphics-engine-architecture.md:147`); "Style data is stored separately from geometry so color and opacity changes do not rebuild vertices" (`:155`); a screen-space coverage fringe (`:179`); "Offscreen textures are reserved for future filters, blend isolation" (`:244`); container opacity stays 1 (`:256`)                                                                                                                                                                                                                                      |
| B2 proposal family C                                                            | Renderer-side stroke geometry as the production method "Contradicts 'path fills and strokes use WASM-produced meshes'; needs an ADR and approval under `AGENTS.md`" (`docs/plans/p3-b2-stroke-proposal.md:145`)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [Requirements](../requirements.md#initial-appearance-model)                     | Opacity is in the initial appearance model (`docs/requirements.md:92`); blend modes are deferred (`:96`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ST-U6 code on `main` (`4713307`)                                                | The interim test (`packages/renderer-core/src/path-mesh-pipeline.ts:439-457`); the fringe cap 128 (`:182`); the pending-sibling working set (`:530-536`); record words (`packages/renderer-core/src/path-mesh-packet.ts:717-737`, word 15 zero at `:735`) and compare-and-write (`:648-649`); triangle words (`:610-620`); the fringe's pre-drop partition (`packages/renderer-core/src/path-fringe.ts:89-95`) and the empty-list drop (`:988-990`); the clear and one mesh pipeline per pass (`packages/renderer-webgpu/src/native-primitive-scene.ts:393`, `:409-420`); the fragment output (`packages/renderer-webgpu/src/mesh-fill-shader.ts:196-207`) |
| ST-U6 tests                                                                     | `composition-unsupported` is asserted in `tests/gpu/p3-st-u6-stroke.spec.ts:25`, `:73-75`, `:149`, `:165-174`; `tests/support/st-u6-stroke-gpu.ts:16`, `:53`, `:71`, `:160`, `:237-239`; `tests/unit/st-u6-stroke-pipeline.test.ts:34`, `:674-715`                                                                                                                                                                                                                                                                                                                                                                                                         |
| ST-U6 evidence                                                                  | Gate 2/255, observed maximum 0.5/255 over the gated pixels of the two-draw fixtures (`docs/plans/p3-fill-stroke-meshes.md:2805`). The 0.5/255 is an observation, not a gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 2. Problem

**Notation.** For one path node with opacity `o`, at a pixel center `p`:

- `f = (f.r, f.g, f.b, f.a)` and `s` are the straight fill and stroke colors;
- `c_F(p)` and `c_S(p)` are the O02 coverages of the fill region and of the stroke region, each from its own boundary ([O02 :100-104](p3-o02-a5-coverage-contract.md#coverage-rule-q2-q3));
- `F' = c_F·(f.rgb·f.a, f.a)` and `S' = c_S·(s.rgb·s.a, s.a)` are coverage-adjusted premultiplied paints;
- `D` is the destination before the path.

**The target**, fixed by P1 D2 (`docs/plans/p1-instanced-primitives.md:154`) and restated by the B2 contract (`docs/plans/p3-b2-stroke-contract.md:138`):

```text
L = S' + F'·(1 − S'.a)
P = o·L
result = P + D·(1 − P.a)
```

**What ST-U6 does.**

- **At `o = 1`, exact.** Two source-over draws, fill then stroke, give `S + F·(1 − S.a) + D·(1 − F.a)·(1 − S.a) = L + D·(1 − L.a)` ([B2 contract :564](p3-b2-stroke-contract.md#96-composition-and-the-opacity-staging-b2-q6)).
- **At `0 < o < 1`, opacity twice.** Drawing `o·F'` then `o·S'` gives `o·S' + o·F'·(1 − o·S'.a) + D·(…)`. In the overlap the fill term carries `(1 − o·S'.a)` instead of `(1 − S'.a)`, so the stroke hides the fill only partly.
- **The approved example.** The overlap becomes `(0.25, 0, 0.5, 0.75)` instead of `(0, 0, 0.5, 0.5)` (`docs/plans/p3-visible-semantics-proposal.md:31`).
- **Today's outcome.** ST-U6 therefore reports `composition-unsupported` and draws neither paint (`packages/renderer-core/src/path-mesh-pipeline.ts:439-457`).

**Where the difficulty is.**

- **`c_S` varies inside one fill triangle.** The stroke boundary crosses fill triangles, and the stroke's AA band lies over fill pixels.
- **What an exact scheme must know.** `c_S` (or `c_F`) at every pixel where both are nonzero, with the two paints attributed separately (`docs/plans/p3-private-contract.md:185`).
- **What it must keep.** Opacity reaches each sample once (`docs/plans/p3-v3-renderer-mesh-pipeline-contract.md:404`).

## 3. Design options

### 3.1 Requirements every option must meet

| ID     | Requirement                                                                                                                                    | Source                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ST7-J1 | The result equals `P + D·(1 − P.a)` per pixel center, up to unorm storage and f32 evaluation                                                   | P1 D2 :154; B2 :138                                                          |
| ST7-J2 | `c_F` and `c_S` are O02 coverages of the two resolved regions, kept separate until composition                                                 | O02 :100-115; private contract :185                                          |
| ST7-J3 | Each sample is covered by at most one primitive of each draw (G3), so a draw's own output reaches a sample once                                | O02 :193; V3 :404                                                            |
| ST7-J4 | The 2/255 interior and exterior tolerance of V3's visual contract and smoke, and the double-opacity separation of more than 20/255, hold       | V3 :478, :535-536                                                            |
| ST7-J5 | Opacity and color changes make no port call                                                                                                    | V3-A3 (V3 :508); B2 §9.3 (B2 :549)                                           |
| ST7-J6 | Device loss reconstructs from CPU state without a port call                                                                                    | V3 :451; B2 :560                                                             |
| ST7-J7 | No offscreen isolation, stencil reinterpretation or new path-renderer architecture without a new architecture decision and the user's approval | Private contract :183; `AGENTS.md` working rules                             |
| ST7-J8 | Fill-only, stroke-only and opacity-1 paths keep ST-U6's output and packet bytes                                                                | B2 :559 ("A fill-only scene packs byte-identically to V3"); ST-A10 (B2 :751) |
| ST7-J9 | The D8 carve-out conditions: disposable, UNVERIFIED, no C04 layout claim                                                                       | Private contract :174-181; B2 §10 (B2 :582-591)                              |

### 3.2 Why the fill draw must carry `c_S`

Three draw orders were checked against ST7-J1 with P1's premultiplied `one / one-minus-src-alpha` blend (`docs/plans/p3-o02-a5-coverage-contract.md:201`):

- **Fill draw corrected (fill first, then stroke).** This is the proposal's scheme (`docs/plans/p3-b2-stroke-proposal.md:235`).
  - The stroke draw outputs `o·S'` unchanged; the fill draw outputs `X = o·F'·(1 − S'.a)/(1 − o·S'.a)`.
  - After both draws the result is `o·S' + (X + D·(1 − X.a))·(1 − o·S'.a)`.
  - Color term: `o·S' + o·F'·(1 − S'.a) = P`.
  - Destination term: `(1 − X.a)·(1 − o·S'.a) = 1 − o·S'.a − o·F'.a·(1 − S'.a) = 1 − P.a`.
  - For `0 < o < 1` the denominator is at least `1 − o > 0`, and `X` is a valid premultiplied color with `0 ≤ X ≤ o·F'`.
- **Stroke draw corrected (fill outputs `o·F'`, then stroke).** Not exact.
  - The stroke draw would need `src = P − k·o·F'` with `src.a = 1 − k` and `k = (1 − P.a)/(1 − o·F'.a)`.
  - On the approved example `k = 1` and `src = (−0.5, 0, 0.5, 0)`.
  - A unorm target clamps a negative premultiplied output.
- **Stroke first, fill second.** Valid, but it also needs `c_S`: the fill draw would output `Y = o·F'·(1 − S'.a) + o·S'·o·F'.a·(1 − S'.a)/(1 − o·S'.a)`.

So in every single-pass scheme the fill draw needs `c_S` at its own pixels. The first order is the simplest, and it keeps the stroke draw exactly as ST-U6 emits it.

**Error transfer.** Suppose the fill draw uses `c̃_S = c_S + δ` while the stroke draw uses `c_S`.

- Expanding the result exactly, the fill contribution changes by `o·F'·s.a·δ·(o − 1)/(1 − o·c̃_S·s.a)`.
- Because `(1 − o)/(1 − o·c̃_S·s.a) ≤ 1`, that change is at most `o·c_F·f.a·s.a·|δ| ≤ |δ|`. The destination factor changes by the same amount.
- So a mismatch between the two draws' `c_S` moves the result by at most `|δ|`, at every opacity. It is not amplified as `o → 1`.
- Round 1's reviewer confirmed this numerically on 10^6 random cases: the worst observed ratio of result change to `|δ|` was 0.571 (section 9).

### 3.3 Option ST7-A: joint-coverage fill draw over a split overlay

**What it is.**

- **Meshes.** Both meshes stay exactly as the ports return them.
- **The overlay.** For a path with both paints drawable and `0 < o < 1`, the renderer derives a **joint overlay**: the fill draw's triangles, re-split along the stroke region's boundary edges into faces that each lie on one side of the stroke boundary.
- **What each triangle carries.** Each overlay triangle keeps the fill role and fill list of its parent fill triangle, and gets its own stroke role and stroke feature list.
- **The draws.** A joint fill draw over these triangles evaluates `c_F` and `c_S` with the O02 rule and outputs `X` (section 3.2). The stroke draw that follows is ST-U6's, unchanged.

Section 4 states it in full.

| Aspect                  | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Correctness             | **Composite:** exact by section 3.2. **Clamp:** `c_F` and `c_S` are each O02's rule on its own boundary, with lists of reach at least `ρ ≥ 2` px (V3 :264), so the far-field clamp stays sound on every overlay triangle (section 4.3). **Once per sample:** the overlay triangles partition the fill draw's domain exactly (checked), and the stroke draw's triangles are unchanged (ST7-J3)                                                                            |
| AA and fringe under O02 | The rule and features are unchanged. The fill draw's `c_S` uses the stroke variant's own feature records, anchor and list order, so it repeats the stroke draw's f32 operations, up to compiler contraction (ST7-R3). By section 3.2, any residual difference moves the result by at most that difference                                                                                                                                                                |
| Gates                   | Two unorm writes, as ST-U6's two draws at `o = 1` (observed 0.5/255 against the 2/255 gate, plan :2805). The first write's rounding is scaled by `(1 − o·S'.a) ≤ 1`, so storage adds at most two half-steps, 1/255 in all, inside 2/255                                                                                                                                                                                                                                  |
| GPU cost and memory     | No extra pass, attachment or texture. One pipeline switch at each joint draw. Each joint fragment evaluates the fill list plus the stroke list; lists are short because each covers only features within `ρ′` of a small piece (estimate in section 3.7). Overlay bytes count in V3's 64 MiB budget                                                                                                                                                                      |
| CPU cost                | Exact BigInt arrangement work per crossed fill triangle in TypeScript, in the same class as the fringe builder's quadratic cost (V3 :546). Bounded by a work cap (ST7-Q5)                                                                                                                                                                                                                                                                                                |
| V3 packet, slots, draws | Fits:<br>• the same six bindings (V3 :382);<br>• the same four geometry regions;<br>• the 32-byte triangle stride, with all eight words used;<br>• the fill slot's record, whose spare word 15 names the stroke slot;<br>• an optional draw field that selects a second fragment entry point                                                                                                                                                                             |
| Device loss             | CPU-derived variant, rewritten byte for byte with no port call and no rebuild (ST7-J6)                                                                                                                                                                                                                                                                                                                                                                                   |
| WASM and kernel         | None: no port, export, ABI, identity or limit change                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ST-U7 row and §1.3      | It is the row's "overlay of the two meshes, feature lists, roles" (B2 :733) and the proposal's scheme (proposal :235). It needs V3 notes of the B2 §1.3 kind (B2 :86) plus one graphics-architecture note (section 5.4), because the drawn joint triangles are TypeScript re-splits of port triangles with Steiner points. Three texts do not cover that: graphics architecture :147, V3 :284 and V3-Q3 (c)'s exception, whose builder "adds no Steiner point" (V3 :577) |

### 3.4 Option ST7-B: offscreen layer at opacity `o`

**What it is.** The path's two ST-U6 draws render at opacity 1 into a cleared offscreen texture, exact by §9.6 at `o = 1`. That texture is then composited once at `o`. Per group instead of per path, the same mechanism would also be the isolated group composition that container opacity needs (`docs/plans/p1-instanced-primitives.md:155`; `docs/graphics-engine-architecture.md:256`).

| Aspect                | Assessment                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness           | Exact by construction. AA is unchanged inside the layer, and the composite quad covers each pixel once                                                                                                                                                                                                                                    |
| Gates                 | An `rgba8unorm` layer adds one storage rounding before the composite, about 1/255 in total. An `rgba16float` layer reduces it                                                                                                                                                                                                             |
| GPU cost and memory   | The layer covers the path's screen bounds, up to the full target: about 33 MB at 3840×2160 in `rgba8`, and four times that as a 4x multisampled attachment. The main pass ends and resumes around each such path, so `n` such paths cost about `2n + 1` passes                                                                            |
| V3 packet and backend | Does not fit unchanged. It needs a new resource kind, layer begin and end draws, a composite pipeline and pass splitting in `native-primitive-scene.ts`. V3 says "No offscreen isolation, stencil or extra pass" (V3 :404)                                                                                                                |
| Device loss           | Transient texture, recreated per generation                                                                                                                                                                                                                                                                                               |
| WASM and kernel       | None                                                                                                                                                                                                                                                                                                                                      |
| Approvals             | Needs a new architecture decision and the user's approval:<br>• the private contract approves no offscreen isolation (`:183`);<br>• the visible semantics approve none (`:31`);<br>• the user did not choose B2-Q6 (c) (proposal :316, :326).<br>The graphics architecture reserves offscreen textures for later blend isolation (`:244`) |

### 3.5 Option ST7-C: stencil or depth

**What it is.** A first pass marks stroke pixels in a stencil (or depth) attachment. The fill is then drawn where the mark is absent, or a second fill draw handles the marked pixels.

| Aspect            | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness       | **Not exact under A5.** A stencil value is binary per sample, and WebGPU core cannot write a stencil reference from the fragment shader, so the mark cannot carry the AA band's fractional `c_S`. In the band the fill is either fully hidden, an aliased internal edge, or fully shown, which is double opacity. MSAA sample masks are not a way out: they contradict O02's "no sample interpolation or alpha-to-coverage" (`:115`) and V3's reading that MSAA-only output is a baseline, never accepted output (V3 :479; `docs/graphics-engine-architecture.md:234`) |
| GPU cost          | A depth-stencil attachment on the main pass changes every pipeline's render-state key, P1's included                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Conflicts         | P4 owns stencil for clips (`docs/graphics-engine-architecture.md:241`, `:269`). The private contract approves no stencil reinterpretation (`:183`)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Variant           | Clipping each fill triangle to each stroke triangle with hardware clip distances would avoid CPU Steiner points. But clip distances are an optional WebGPU feature, and WebGPU states no tie rule for complementary clip planes, so G3 could not be argued                                                                                                                                                                                                                                                                                                             |
| WASM, device loss | No WASM change; attachments are recreated per generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### 3.6 Option ST7-D: kernel overlay (Boolean regions or a labelled joint mesh)

**What it is.** The kernel resolves the fill contours and the stroke pieces in one arrangement. It returns either three regions (`F ∖ S`, `F ∩ S`, `S ∖ F`) or one conforming mesh whose triangles carry (in fill, in stroke) labels.

| Aspect                                 | Assessment                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness, three regions drawn alone | **Not exact under A5.** Adjacent regions' fringes overlap across the internal boundary, for example red `F ∖ S` against blue `F ∩ S`. A sample in the band then receives two source-over draws with opacity in each. Dropping the fringes there instead leaves an aliased color edge. Exactness still needs both coverages per pixel, as in ST7-A |
| Correctness, labelled mesh             | Exact with a joint shader that computes `c_F` and `c_S` from the label boundaries. The kernel's snap-rounded conforming refinement replaces TypeScript Steiner points, and a single joint draw would have one storage rounding                                                                                                                    |
| Cost                                   | The joint arrangement adds the fill contours to the stroke arrangement, which already reaches its caps on cubic strokes (`work-limit` cases, B2 :14-17, :36). The Alt-A1 fill fast rung cannot be used for the joint mesh                                                                                                                         |
| Keys and reuse                         | The joint mesh key is the union of both keys. A fill geometry or fill-rule change would rebuild stroke-dependent geometry, and a width change would rebuild fill-dependent geometry. That is against B2 §9.3's paint-separate keys (B2 :548-549)                                                                                                  |
| WASM, port, C04                        | A new port request and result shape (labels), a new export or a stroke revision, new limits and a new identity. "Region labels across paints" is a C04 item left open (B2 :587)                                                                                                                                                                   |
| Device loss                            | As any port result                                                                                                                                                                                                                                                                                                                                |
| Fit                                    | The renderer still needs ST7-A's joint shader; only the overlay's producer moves. It is a candidate for the C04 layout and K1, not for the ST-U7 interim                                                                                                                                                                                          |

### 3.7 Option ST7-E: no split; complete stroke lists on crossing triangles

**What it is.** No triangle is re-split and no Steiner point is added.

- **Two kinds of triangle.** Each fill-draw triangle is classified, exactly, as either **one-sided** (its closed triangle meets no stroke boundary edge) or **crossing**.
- **One-sided triangles** carry an exact stroke role and a stroke list within `ρ′`, as in ST7-A.
- **Crossing triangles** carry a **complete** stroke list and no far-field clamp: `c_S` is O02's rule at the nearest listed feature, saturating beyond 0.707 px.
- **When that is sound.** The sign is right whenever the list holds the true nearest feature (O02 :113).
- **The "complete" list.** For a point `p` of a crossing triangle `T`, the nearest stroke boundary point is within the screen diameter of `T`. Features that close are within local distance `κ·diam(T)` of `T`, with `κ = sigmaMax/sigmaMin` of the node's map. The complete list is therefore the stroke features within `max(ρ′, κ·diam(T))`. Alternatively it is all stroke features, which is transform-independent.

| Aspect                   | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness              | Exact composite as ST7-A, with the same `c_S` consistency argument where both lists contain the nearest feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Architecture             | Placement-neutral. Region triangles stay the port's (V3 :284), meshes stay WASM-produced (graphics architecture :147), and no Steiner point is added, so V3-Q3 (c)'s exception covers it as written (V3 :577). Only derived attributes are added, as the fringe builder adds lists                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| List identity            | With the `κ·diam(T)` list, the list depends on the transform's anisotropy, not only on `f`, so a rotation or shear change can rebuild lists. With all features it does not, but it is longer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Region-only stroke       | Needs stroke feature records that a region-only stroke does not have (its builder is skipped above the cap, V3 :410). Its AA-ramped `c_S` would then disagree with the stroke draw's hard `c ∈ {0, 1}` across a band about 0.7 px wide along the whole boundary, not only in slivers                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Fragment cost (estimate) | **Long crossing triangles inherit long lists.** The fill draw's triangles are the port's, and the fast rung's monotone triangulation (`docs/graphics-engine-architecture.md:151`) gives long triangles that span the shape. The inner stroke boundary, `r` inside the fill boundary, crosses almost all of them. **Worked example, estimated:** a 256-vertex near-circular fill of radius 200 px with a 256-vertex stroke ring has about 1,000 stroke features. Its crossing triangles cover most of about 125,000 px² of fill area, which gives about 1.2·10^8 feature evaluations per frame for one path. ST7-A's pieces carry an estimated 2-10 features each, about 10^6 evaluations. Both figures are estimates to be measured in ST-U7d |
| Hybrid                   | Split only crossing triangles whose complete list would exceed a cap (for example 64 features). It brings back Steiner points on exactly the large paths where cost matters, and it keeps two code paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Assessment.** ST7-E's merit is placement neutrality. Its costs are fragment cost on large curved paths (estimated two orders of magnitude above ST7-A), list rebuilds under rotation and shear, and a band-wide mismatch for region-only strokes, which are common above the 128-vertex fringe cap. On the merits ST7-A is better; ST7-E is shown to the user as a placement-neutral alternative in ST7-Q2.

### 3.8 Comparison

| Option                | Exact at `0 < o < 1` with A5 | Approvals beyond this addendum                                                                         | GPU change                               | Kernel change | Main cost (estimates)                                              |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------- | ------------------------------------------------------------------ |
| ST7-A split overlay   | Yes                          | Extend V3-Q3 (c)'s D8 exception to graphics architecture :147 and V3 :284 with Steiner points (ST7-Q2) | One entry point, one optional draw field | None          | TypeScript BigInt overlay (capped)                                 |
| ST7-E complete lists  | Yes                          | None                                                                                                   | As ST7-A                                 | None          | Long lists: about 100× ST7-A's fragment work on large curved paths |
| ST7-B offscreen layer | Yes                          | New architecture decision; reverses B2-Q6                                                              | Layers, pass splits, composite pipeline  | None          | Passes and layer memory per path or group                          |
| ST7-C stencil, depth  | No (binary per sample)       | Stencil reinterpretation; conflicts with P4                                                            | Depth-stencil attachment for all         | None          | —                                                                  |
| ST7-D kernel overlay  | Only with ST7-A's shader     | Port and export change; C04 item 2                                                                     | As ST7-A                                 | Large         | Joint exact arrangement, key coupling                              |

## 4. Recommendation: ST7-A

ST7-A is the approved direction (section 1.1) in the representation that is exact under A5 at bounded fragment cost. It fits the V3 packet and slot model and needs no kernel or port change. It is a "proven single-opacity mesh scheme" with separately attributed paints (`docs/plans/p3-private-contract.md:183-185`), not independent full-alpha draws.

What it adds beyond the approved texts is TypeScript re-splitting of port triangles with Steiner points. ST7-Q2 puts that to the user, with ST7-E as the alternative that needs no new exception.

### 4.1 Drawable condition and order

- **Joint condition.** A path draws joint exactly when all three hold in this `prepare`:
  - its fill and its stroke are both drawable (B2 §9.2, :540-544);
  - neither paint fails (§9.6, :568);
  - `0 < o < 1`.

  A path with only one drawable paint, for example a culled fill, stays a single-paint draw, exact at any opacity (B2 :564).

- **Order.** The joint fill draw takes the fill draw's place: the same `position`, before the stroke draw, consecutive in `draws` (B2 :558). The stroke draw is ST-U6's, unchanged in bytes.
- **Unchanged cases.** At `o = 1` and at `o = 0`, and for every single-paint path, the packet is ST-U6's (ST7-J8).

### 4.2 The joint overlay

**Domain.**

- **Fill with a fringe variant.** The domain is the variant's **pre-drop frame partition**: its region triangles and all its exterior triangles, before empty-list triangles are dropped (`packages/renderer-core/src/path-fringe.ts:89-95`). Its outer boundary is the four axis-aligned frame edges at the exact corner values `m + k` (V3 :269).
- **Region-only fill** (`fringe-work-cap`). The domain is its region triangles. Their outer boundary is the fill region boundary, with sloped edges in general.
- **Why it suffices.** Pixels outside the domain have `c_F = 0`, where `X = 0`, so nothing outside it is needed.

**Splitting edges.** The stroke region's `boundaryEdges` (port rule 5), which are exactly the stroke region boundary (V3 :275-277).

**Construction.** All predicates are exact on the Float64 positions and exact rationals.

1. **Insertion points per domain edge.** Compute, once per domain edge `e`, every point where a stroke boundary edge meets `e`:
   - a proper crossing, which is a Steiner point;
   - a stroke vertex lying exactly on `e`, which is an existing Float64 vertex, not a Steiner point;
   - an endpoint of a stroke edge collinear with `e`.

   A crossing exactly at an endpoint of `e` reuses that domain vertex and adds no point. Each point found on `e` is inserted into **both** triangles that share `e`, whether or not the stroke edge enters the second one's interior. The split is therefore conforming, with no T-junction.

2. **Triangles to split.** A domain triangle `T` is split when any stroke boundary edge meets the closed `T`, or any point was inserted on one of its edges. Otherwise it is one face with its parent's data.
3. **Faces.** The faces of a split `T` are the faces of the exact arrangement of `T`'s three edges (subdivided at their inserted points) with the stroke boundary edges clipped to `T`. A stroke edge collinear with an edge of `T` adds no new edge. A face may be non-convex, for example at a join inside a large fill triangle. It may have holes, for example a whole stroke ring inside one fill triangle.
4. **Rounding.** Each Steiner point is rounded once per coordinate to the nearest Float64, with one exception: a point on an axis-aligned frame edge keeps that edge's exact coordinate (the corner value `m + k`, which packs exactly as `k`). It is rounded once and shared by every face that uses it.
5. **Triangulation.** Each face is triangulated with V3's exact bridging and ear-clipping triangulator (V3 :280; the fringe builder's code) under exact predicates on the rounded positions. A triangulator failure (no ear, failed bridge) is `overlay-unsupported`.
6. **Sloped outer edge.** A Steiner point that lands on a **sloped outer domain edge** cannot keep the edge exactly after rounding. It is `overlay-unsupported`, fixture ST7-F14. Only a region-only fill has sloped outer edges, so this rule applies only there (consequence and alternative in ST7-Q8).

**Roles.**

- **Fill role.** Each overlay triangle keeps its parent's fill role: 0 region, 1 exterior.
- **Stroke role.** It is the stroke-region membership of an exact interior point of its unrounded face, decided by exact winding over the stroke boundary loops.

**Lists.**

- **Fill list.** The parent's list, unchanged. An overlay triangle lies inside its parent up to rounding, so every fill feature within `ρ_F′` of it is listed.
- **Stroke list.** Every stroke feature within local distance `ρ_S′ = 2^f′` of the closed overlay triangle. These are the stroke variant's EDGE and VERTEX records (V3 :360-362). They are decided exactly, as the fringe builder decides its lists (V3 :264; V3-A11's brute-force check), and sorted by `(kind, global id)` (O02 :139).
- **Region-only stroke.** If the stroke paint is drawn region-only (`fringe-work-cap`, V3 :410), the stroke list is empty and the stroke role decides `c_S ∈ {0, 1}`.
- **Region-only fill.** Every fill list is empty and the fill role decides `c_F`.

**Exact partition check, over the domain's boundary edge multiset.** O02's rules (`docs/plans/p3-o02-a5-coverage-contract.md:188`) are applied with the domain boundary in place of the frame (V3 :282). On the rounded positions, in exact arithmetic:

- every overlay triangle is positively oriented;
- their areas sum exactly to the domain's area;
- every interior edge is used exactly twice, in opposite directions;
- the edges used once form exactly the multiset of domain boundary edges, each subdivided at its inserted points.

A failure is `overlay-unsupported` (section 4.6).

**Drop after the check.** Overlay triangles whose parent was an empty-list exterior triangle (fill role exterior, empty fill list) have `c_F = 0`. They are dropped after the check, as V3 drops their parents (V3 :265).

**Determinism.** The same fill variant, stroke variant and order give identical bytes.

### 4.3 Why the far-field clamp stays sound on each overlay triangle

O02's clamp returns the role constant when the nearest listed feature is at least 1.0 px away. It is sound when the list holds every feature within 1.5 px and the primitive does not cross the boundary (O02 :141-149).

- **Reach.** Each list holds every feature within local `ρ′ ≥ ρ = 2^f`, which maps to at least 2 px in every direction (V3 :178, :264). That is above 1.5 px.
- **One side.** Each unrounded face lies on one side of the stroke boundary by construction, and inside its parent fill triangle.
- **Rounding.** Rounding moves each Steiner coordinate by at most `2^-53·|x|`, where `x` is a coordinate on a stroke boundary edge and a domain edge.
  - **Stroke boundary coordinates** are bounded two ways: by ST-G1, `16·2^-53·(M + r) ≤ 2^(e−4)` (B2 :275), which gives `2^-53·(M + r) ≤ 2^(e−8)`; and, at kept miter tips `‖B‖∞ + r·ρ` with ratio bound `ρ ≤ 2^24`, by ST-G3, `64·2^-53·(‖B‖∞ + r·ρ³) ≤ 2^(e−1)` (B2 :24-25), which gives `2^-53·(‖B‖∞ + r·ρ) ≤ 2^(e−7)`.
  - **Local displacement.** Hence at most `√2·2^(e−7)` local units.
  - **On screen.** With `2^e·sigmaMax(S) ≤ 0.125` (V3 :176), that is `√2·2^-10 < 2^-9` physical px, about 0.002 px.
  - **Frame-edge points.** Their free coordinate can also reach the frame's `±ρ` margin. Its rounding adds about `2^-50·κ` px, which is negligible for `κ < 2^40`.
- **Conclusion.** A point on the wrong side of its role lies within that distance of the boundary, where `d* < 1` and the rule, not the role, decides. O02's 0.104 px margin (`:149`) absorbs it, together with the binary32 packing that V3 already accepts without a certificate (V3 :353).

### 4.4 Consistency with each paint's own draw

The joint fill draw's `c_S` must equal what the stroke draw computes at the same pixel, and must be 0 wherever the stroke draw paints nothing.

- **Stroke with a fringe.**
  - At a pixel the stroke draw paints, its triangle's list and the overlay triangle's list both hold every stroke feature within 1.5 px.
  - Both select the nearest feature by identical f32 distances in global order with strict `<` (O02 :139), using the stroke record's lanes and anchor.
  - Where the stroke draw paints nothing (an empty-list exterior triangle, or outside its frame), every stroke feature is more than `ρ` (2 px) away, so the rule gives 0 in the joint draw too.
- **Stroke region-only.**
  - The stroke draw covers exactly the samples of its region triangles, with `c = 1`.
  - The overlay is split along the same boundary edges, so a sample's covering overlay triangle has that sample's stroke membership, up to the f32 positions of the two meshes.
  - **Bit-identical stroke vertices (S1).** Overlay vertices that are stroke boundary vertices are packed **bit-identically to the stroke draw's**: the same `u_S = fround(v − m_S)` lanes, mapped with the stroke record's anchor `B_S`, selected per vertex by bit 31 of the position index in the joint triangle record. Their clip-space positions then repeat the stroke draw's expression on identical inputs.
  - **What stays different.** Steiner points (ST-U7 must not skip this). A Steiner point lies on a stroke edge only in exact arithmetic. After rounding, the sub-edges `a–s` and `s–b` are not the f32 line `a–b` that the stroke draw rasterizes. So bit-identity of the split edges is **not achievable**, and a sliver of samples along region-only stroke edges near Steiner points can disagree by one sample's coverage (ST7-R4). ST-A16 therefore reports those pixels instead of gating them (section 5.5).
- **Fill region-only.** The fill draw covers its region triangles with `c = 1` (V3 :410). The joint draw covers the same domain with `c_F = 1`.
- **Bound.** Any residual mismatch `δ` moves the composite by at most `|δ|` (section 3.2).

### 4.5 Packet, shader and backend

All changes are additive and functional v0 under the carve-out (ST7-J9).

| Item                   | ST-U7 rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlay variant ranges | Its own ranges in the four geometry regions (V3 :366):<br>• **positions:** the fill variant's vertices copied, then the Steiner points, all as `u = fround(v − m_F)` from the fill mesh midpoint;<br>• **triangles;**<br>• **lists:** fill and stroke lists, variant-relative.<br>No features of its own. Stroke boundary vertices are read from the stroke variant's own position range (section 4.4)                                                                                                                                                                                                                                                                                                                                                                     |
| Joint triangle record  | 32 bytes, all eight u32 words used:<br>• `i0, i1, i2`: bit 31 clear for an overlay-relative position, bit 31 set for an index into the stroke variant's positions;<br>• `fillListOffset`, `fillListCount`;<br>• `strokeListOffset`, `strokeListCount`;<br>• `roles`: bit 0 fill role, bit 1 stroke role, each 0 region, 1 exterior.<br>Fill list entries index the fill variant's features, stroke list entries the stroke variant's                                                                                                                                                                                                                                                                                                                                       |
| Instance record        | The fill slot's 64-byte record (V3 :363), with:<br>• words 12 and 13: the overlay's position and list bases;<br>• word 14: the fill variant's feature base;<br>• word 15: stroke slot + 1.<br>The stroke slot's record is ST-U6's. Outside the joint condition, word 15 is 0 and words 12-14 are V3's, so the record returns to ST-U6's bytes                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Word 15 rewrite        | All 16 words are recomputed in every `prepare` from the current slot maps and served variants, and written by the existing compare-and-write (`packages/renderer-core/src/path-mesh-packet.ts:648-649`). A stroke slot reallocation or release, or a change of the joint condition, therefore changes word 15 and rewrites the record in the same packet. A released stroke slot ends the joint condition, so word 15 becomes 0 before the slot can be reused. Seeded defect ST7-D9                                                                                                                                                                                                                                                                                        |
| Draw                   | `MeshFillDraw` gains an optional `composite?: 'joint-fill'`, absent on every draw ST-U6 emits. `layoutVersion` stays 0. Under the v0 carve-out the packet's producer and consumer ship together from one repository revision, and no version skew between `renderer-core` and `renderer-webgpu` is supported, so a backend that ignored the field does not exist. Packets without the field keep their shape (ST7-J8). The backend validates the field as V3-A13 validates the other fields                                                                                                                                                                                                                                                                                |
| Shader and pipeline    | **One module.** The joint fragment entry point lives in the **same module** as `meshCoverage` and the fill entry point, sharing that function (M2). **Two pipelines** over that module: `'p3-mesh-fill-v0'` (unchanged behavior) and `'p3-mesh-joint-v0'`, with V3's layout key and the same bind group layout (five storage bindings and one uniform, V3 :382). Both are created at initialization and recovery, never in a frame (V3 :385). **Creation failure:** if either fails, the mesh path is unavailable for that generation (`mesh-pipeline-unavailable`, V3 :387). That is intended: both pipelines share one module and layout, so a failure of either indicates a device problem, and a joint path cannot fall back to two plain draws without double opacity |
| Fragment               | `c_F` by `meshCoverage` over the fill list with the fill record. `c_S` by the same function over the stroke list with the stroke record (its anchor `B_S` and its `featureBase`). Then `a_S = c_S·s.a` and `X = o·c_F·(f.rgb·f.a, f.a)·(1 − a_S)/(1 − o·a_S)`, discarding when `X.a = 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Encoding               | The backend switches to the joint pipeline at a joint draw and back after it; the bind group is shared                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 4.6 Cache, accounting, timing and failures

- **Identity.** An overlay variant belongs to one pair: the fill entry with its served `e′` and fringe variant (or region-only mode), and the stroke entry with its served `e′` and fringe variant (or region-only mode). It becomes unreachable when either parent variant does.
- **Accounting.**
  - Its typed-array bytes count in V3's 64 MiB budget and its eviction order (V3 :220-230).
  - At most two overlay variants per node; the least recently served goes first.
  - Evicting a parent evicts the overlay.
- **Pending-sibling working set.** Under the #186 amendment (V3 :250; `path-mesh-pipeline.ts:530-536`), a path held back only because a sibling paint's entry is missing keeps its published entries in the working set. Overlay variants need no such rule: an overlay is reachable only when both parent entries are resident, so a path with a missing paint has no reachable overlay. Its overlay was evicted with the missing parent, or never built. The protected sibling entry's own overlay variants stay accounted under the normal budget order.
- **Timing.** Built on demand in the first `prepare` that needs it (ST7-Q3), then cached. Opacity toggles between 1 and below 1 reuse it. No port call is made in any case (ST7-J5).
- **Failure.** Any of these is the renderer-scope state `overlay-unsupported`, with `paint: null` (ST7-Q4):
  - a failed partition check;
  - a triangulator failure;
  - a Steiner point on a sloped outer edge;
  - an overlay over the work cap (ST7-Q5).

  Then the path is not drawn, both cached meshes stay, and the overlay variant is marked as V3 marks a failed fringe variant (V3 :213). One notice is queued per mark. The state clears when either parent variant or the opacity condition changes.

- **Whole-path failure.** Unchanged: if either paint fails, the path is not drawn (B2 :568).
- **Removal.**
  - `composition-unsupported` is removed from the code, the `PathMeshFailureCode` union and the notice table in one change, following the V3 :441 pattern.
  - `overlay-unsupported` is D8-interim. It is removed with the TypeScript builder at the R2/K1 placement decision, as `fringe-work-cap` is (V3 :410).

### 4.7 Consequences

- **Visible.** Paths with both paints at `0 < o < 1` draw, with opacity once, instead of vanishing with `composition-unsupported`.
- **New interim failure.** `overlay-unsupported` can hide such a path. The causes are rounding inversions, triangulator failures, the work cap, and, under ST7-Q8 (a), every region-only fill whose boundary the stroke crosses. It is reported, never silent.
- **CPU.** A one-time exact overlay per node and served variant pair. Its cost adds to V4's builder-cost gate and to B0's E3 observations (V3 :546).
- **GPU.** Joint fragments evaluate two lists. No pass, attachment or texture is added.
- **Architecture.**
  - A D8-interim exception covering graphics architecture :147, V3 :284 and V3-Q3 (c)'s "no Steiner point" wording (ST7-Q2).
  - Under ST7-Q3 (a), a reading of `docs/graphics-engine-architecture.md:155` for derived overlay vertices.
  - Container opacity stays 1 (ST7-Q7).
  - No `docs/requirements.md` text changes.
- **Disposable.** Under K1 the overlay has to be rebuilt per tile; the R2 contract's per-tile partition carries it.

## 5. Contract amendments ST-U7 would make

**How each lands.** Each amendment is a dated note appended under the frozen text; no frozen text is rewritten (`docs/plans/p3-b2-stroke-contract.md:78`). `<date>` is the merge date of the unit named.

**When.** The notes land in **ST-U7c**, with the code that changes behavior. Section 5.4's note is the exception: it lands in **ST-U7a**, before any code, because `AGENTS.md`'s working rules require a behavior change's architecture update before or with the code.

### 5.1 B2 stroke contract

**Header**, after the last dated note:

> Amended `<date>` by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md): a path with both paints drawable at `0 < opacity < 1` is drawn by a joint-coverage fill draw over a renderer-derived overlay followed by the unchanged stroke draw; `composition-unsupported` is removed and the D8-interim code `overlay-unsupported` is added. See the dated notes in §§9.5, 9.6, 9.8, 10, 12 and 13.

**§9.5**, after its bullets:

> Amended `<date>` by ST-U7 ([addendum §4.5](p3-b2-st-u7-joint-coverage-addendum.md#45-packet-shader-and-backend)): under the joint condition of §9.6's ST-U7 note, the fill draw becomes a joint fill draw. It is a `MeshFillDraw` with the optional field `composite: 'joint-fill'`, at the fill draw's position and before the stroke draw. It draws the overlay variant's triangles with pipeline `'p3-mesh-joint-v0'`. The fill slot's record points at the overlay's position and list bases and names the stroke slot in word 15 (stroke slot + 1). The record is recomputed every `prepare`, so a stroke slot change rewrites it. Outside that condition every draw and record keeps ST-U6's bytes.

**§9.6**, after "Failures of one paint":

> Amended `<date>` by ST-U7 ([addendum §§3.2, 4](p3-b2-st-u7-joint-coverage-addendum.md#4-recommendation-st7-a)): the interim rule is superseded.
>
> - **Composite.** When the fill and the stroke are both drawable and `0 < o < 1`, the fill draw outputs `X = o·F'·(1 − S'.a)/(1 − o·S'.a)`, with `F' = c_F·F` and `S' = c_S·S`. The stroke draw outputs `o·S'` as before. The result is `P + D·(1 − P.a)` exactly, up to storage.
> - **Overlay.** `c_S` in the fill draw is O02's rule over the stroke variant's features. It is evaluated on overlay triangles: the fill draw's triangles re-split along the stroke `boundaryEdges`. Each keeps the fill role and fill list of its parent triangle and carries its own stroke role and stroke list. A paint drawn region-only contributes its role constant.
> - **Codes.** `composition-unsupported` is removed. An overlay that fails its exact partition check or its triangulation, puts a Steiner point on a sloped outer edge, or exceeds the overlay work cap is the renderer state `overlay-unsupported` (`paint: null`). The path is then not drawn, and both cached meshes stay.
> - **Unchanged.** The whole-path rule for a failing paint.

**§9.8**, after its paragraph:

> Amended `<date>` by ST-U7: the failure-code table loses `composition-unsupported` and gains `overlay-unsupported` (renderer scope, `paint: null`, one notice per marked overlay variant). It is D8-interim and is removed with the TypeScript builder at the R2/K1 placement decision.

**§10**, after the table:

> Amended `<date>` by ST-U7: item 2's "joint fill and stroke coverage (ST-U7)" is now fixed functionally: the renderer-derived overlay, the joint triangle record, word 15 of the fill slot's record and the joint pipeline. Region labels across paints, a kernel overlay and the C04 layout stay open.

**§12.1**, after the table:

> Amended `<date>`: ST-U7's files and units are fixed by the [ST-U7 addendum §6](p3-b2-st-u7-joint-coverage-addendum.md#6-units): ST-U7a (freeze and architecture note), ST-U7b (overlay and composite, CPU), ST-U7c (packet, shader, backend, renderer and the dated notes), ST-U7d (headed fixtures and evidence). The ST-U6 test edits that ST-U7 makes are listed in the addendum's allow-list.

**§12.2**, after the last note:

> Amended `<date>` by ST-U7: ST-A10's clause "`composition-unsupported` at 0.5 with both paints" and its check "the interim failure for its overlap case" are superseded by ST-A15 and ST-A11. That case now draws, through the joint fill draw, and `composition-unsupported` no longer exists. ST-A10's other clauses are unchanged. ST-A11 is refined, and ST-A13 to ST-A18 are added, as in [addendum §5.5](p3-b2-st-u7-joint-coverage-addendum.md#55-acceptance-criteria). ST-A9 gains U7 in its units column, and ST-A12 applies to every ST-U7 unit unchanged.

The note carries the table of section 5.5.

**§12.3**, under item 4:

> Amended `<date>`: the addendum's independent review ran (verdicts and dates recorded in the addendum's review record) before ST-U7b's first commit; ST-U7b to ST-U7d each get a diff review, and ST-U7c and ST-U7d an evidence review.

**§13**, under ST-OB5 and the "Fill and stroke seams" risk:

> Amended `<date>`: ST-OB5 is discharged by the ST-U7 addendum (frozen `<date>`) and ST-U7c/d. The fill fringe under the stroke at `0 < o < 1` is handled by the joint fill draw (addendum §4.4).

**§14**, after its paragraph:

> Amended `<date>`: the Primary technical choices of the ST-U7 addendum are listed in its section 4 and were open to its review:
>
> - the fill-first correction;
> - the arrangement split, with Float64 Steiner points and exact frame coordinates;
> - inherited fill lists;
> - bit-identical stroke vertices;
> - the record word 15;
> - the optional draw field, with `layoutVersion` 0;
> - one shader module;
> - two overlay variants per node.

### 5.2 V3 renderer mesh pipeline contract

Each note opens with "Amended `<date>` by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md):", followed by:

- **Section d:** "overlay variants are cache data of their fill entry; their bytes count in the budget; at most two per node; evicting either parent variant evicts them; a failed overlay is a mark like a failed fringe variant. An overlay is reachable only when both parent entries are resident, so the pending-sibling working-set amendment above needs no overlay rule."
- **Section e:** "in joint draws only, the port's fill triangles are re-split by the overlay builder:
  - the faces are the exact arrangement of each crossed triangle with the clipped stroke `boundaryEdges`;
  - the faces are triangulated by this section's triangulator;
  - Steiner points are rounded once to Float64, except on axis-aligned frame edges, where the exact frame coordinate is kept.

  Each overlay triangle keeps its parent's fill list and role and carries a stroke list of every stroke feature within the stroke variant's `ρ′`, decided exactly, and a stroke role from exact membership. The overlay passes this section's exact partition check over the domain's boundary edge multiset. The sentence 'Region triangles are the port's, unchanged' (above) still holds for every fill and stroke draw. The joint draw's overlay triangles are an exception under the D8-interim exception recorded in `docs/graphics-engine-architecture.md` by ST-U7a."

- **Section f:** "the joint triangle record (eight u32 words: three indices with bit 31 selecting the stroke variant's positions, fill list, stroke list, roles in bits 0 and 1); word 15 of the fill slot's record, which is stroke slot + 1 under the joint condition and 0 otherwise, recomputed every `prepare`; `MeshFillDraw.composite?: 'joint-fill'`; the pipeline `'p3-mesh-joint-v0'`, created beside the fill pipeline from the same module. `layoutVersion` stays 0; packets without joint draws are unchanged in bytes and shape."
- **Section g**, after the ST-U6 note: "both paints at `0 < opacity < 1` are drawn by the joint fill draw and the stroke draw, exact by the addendum's section 3.2; each draw still covers each sample at most once. No offscreen isolation, stencil or extra pass is used."
- **Section h:** "the table loses `composition-unsupported` and gains `overlay-unsupported` (renderer scope, `paint: null`), D8-interim, removed with the TypeScript builder."
- **Section i:** "overlay variants are reconstructed from CPU entries byte for byte, with no port call and no rebuild."
- **Section j**, item 2: "joint fill and stroke coverage is fixed functionally by ST-U7; the C04 layout stays open."

### 5.3 Private contract

After line 183's paragraph, a pointer note only, with the paragraph's text unchanged:

> ST-U7 realizes the second direction, a proven single-opacity mesh scheme, with no offscreen isolation or stencil; see the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md).

### 5.4 Graphics engine architecture (ST-U7a)

**Placement.** In the anti-aliasing section, after the V3-Q3 (c) exception, with a pointer from the primitive-rendering paragraph that holds line 147. The text below is for ST7-Q2 (a) and ST7-Q3 (a). Under ST7-Q2 (b) the note keeps only its first sentence and the list-attribute wording.

> **P3 joint fill and stroke coverage (`<date>`; ST-U7 addendum, linked as `plans/p3-b2-st-u7-joint-coverage-addendum.md` from that file).**
>
> - **The draws.** For a path with fill and stroke at node opacity below 1, the renderer draws a joint-coverage fill draw over a derived overlay, then the stroke draw, so opacity applies once to the stroke-over-fill result.
> - **The builder.** The exact TypeScript builder in `renderer-core` re-splits the port's fill triangles along the stroke boundary. It adds Steiner points, rounded once to Float64, and passes an exact partition check.
> - **What the exception covers.** For the joint draw only, this departs from "Arbitrary path fills and strokes use WASM-produced meshes" above, from V3's "Region triangles are the port's, unchanged", and from V3-Q3 (c)'s builder that "adds no Steiner point".
> - **Its terms.** It is a time-bounded D8-interim exception in the pattern of V3-Q3 (c), removed at the R2/K1 placement decision. The port meshes stay WASM-produced, and every other draw uses them unchanged.
> - **Opacity and vertices.** Overlay vertices are derived cache data, built once per pair of served variants. Color and opacity changes rebuild no port mesh, which is how the "do not rebuild vertices" rule above applies.
> - **Requirements.** No requirement text changes.

**Why an exception suffices, when proposal :145 asked for an ADR.**

- **What :145 concerned.** It concerned family C, renderer-side stroke geometry as the **production** stroke method. That would contradict line 147 permanently, so it needed an ADR.
- **What the overlay is.** A D8-interim, disposable derivation of WASM meshes, with a fixed removal point. It is the situation V3-Q3 (c) settled for the fringe builder, whose exception to `ARCHITECTURE.md:52-54` and private contract line 8 needed no ADR (V3 :583, :661).
- **What would need an ADR.** A permanent TypeScript overlay, which is ST7-Q2 (c).

### 5.5 Acceptance criteria

| ID     | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Validation                                                                                                                                                                                                          | Units         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| ST-A11 | **Refined.** The approved example (opaque red fill, opaque blue stroke, opacity 0.5) gives `(0, 0, 0.5, 0.5)` premultiplied in the overlap, composited over the test background, within 2/255 at pixel centers at least 3 physical px from every fill and stroke boundary. Fill-only and stroke-only centers likewise. The overlap differs from the double-opacity value by more than 20/255. The same at opacity 0.25                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `pnpm test:gpu` (`tests/gpu/p3-st-u7-joint.spec.ts`), Chrome and Edge, 1x and 4x, DPR 1 and 2, the V3-A14 classes (V3 :535-536)                                                                                     | U7d           |
| ST-A13 | **Composite formula.** Over a grid (`c_F, c_S ∈ {0, 1/8, …, 1}`, `o ∈ {1/8, …, 7/8}`, paint alphas `{0, 0.5, 1}`, several destinations), fill-then-stroke source-over with `X` equals `P + D·(1 − P.a)`: exactly in BigInt rationals, within `2^-40` in Float64. `X` is a valid premultiplied color, and the denominator is at least `1 − o`. Seeded defects ST7-D1, ST7-D2 and ST7-D10 fail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `pnpm test:unit` (`tests/unit/path-joint-composite.test.ts`), against an independent rational model in the test                                                                                                     | U7b           |
| ST-A14 | **Overlay**, on ST7-F1 to ST7-F10, ST7-F13 and ST7-F15:<br>• the overlay passes an independent exact partition check over the domain's boundary edge multiset;<br>• every unrounded face lies on one side of the stroke boundary (independent exact membership);<br>• stroke lists equal a brute-force exact list within `ρ′`;<br>• fill lists and roles equal the parent's;<br>• Steiner points are within one Float64 rounding of the exact intersection, and frame-edge points keep the exact frame coordinate;<br>• stroke boundary vertices are referenced by bit-31 indices;<br>• bytes are deterministic.<br>ST7-F14 is `overlay-unsupported`. Seeded defects ST7-D3 to ST7-D6 and ST7-D11 fail                                                                                                                                                                                                                                                                           | `pnpm test:unit` (`tests/unit/path-joint-overlay.test.ts`); the oracle side imports nothing from the builder                                                                                                        | U7b           |
| ST-A15 | **Renderer.**<br>• `composition-unsupported` is never emitted and is absent from the union;<br>• a joint draw is emitted exactly under the joint condition;<br>• packets at `o = 1`, at `o = 0` and for single-paint paths are byte-identical to ST-U6's goldens;<br>• opacity changes make zero port calls;<br>• one overlay build per variant pair, reused across opacity toggles;<br>• overlay bytes appear in accounting and eviction;<br>• `overlay-unsupported` is emitted once per mark, with `paint: null`;<br>• word 15 follows a stroke slot change in the same packet (ST7-D9);<br>• ST7-F11 and ST7-F12 at the work cap                                                                                                                                                                                                                                                                                                                                              | `pnpm test:unit` (renderer-core joint tests)                                                                                                                                                                        | U7c           |
| ST-A16 | **Joint consistency, including AA bands.** At each `o ∈ {0.5, 0.25}`, the scene rendered at `o` equals `o ×` its rendering at `o = 1`, in every RGB channel, within 2/255. It is rendered over the backend's opaque black clear (`packages/renderer-webgpu/src/native-primitive-scene.ts:393`), also under a 30° rotation, a reflection and a 3 × 0.5 scale. The gate covers every pixel of the crop except the **excluded band**: pixels whose center is within 1 physical px of a region-only boundary edge. Those are reported, not gated. The test computes the band exactly and asserts it holds at most `3·L + 8·E` pixels, with `L` the boundary's length in physical px and `E` its edge count. That bound is the lattice-point bound `N ≤ A + P/2 + 1` for convex sets, applied to each edge's radius-1 stadium. The half-opacity path over an opaque primitive is within 2/255 of the single-opacity value at its overlap center. Seeded defect ST7-D10 fails (ST7-Q6) | `pnpm test:gpu` (`tests/gpu/p3-st-u7-joint.spec.ts`), Chrome and Edge, 1x and 4x, DPR 1 and 2                                                                                                                       | U7d           |
| ST-A17 | **Device loss.** After an injected loss, the probed pixels of ST-A11 and ST-A16 equal the pre-loss capture exactly, with zero new calls on either port and zero overlay builds. In unit form, the reconstruct packet's joint writes equal the pre-loss bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `pnpm test:gpu` (same spec) and `pnpm test:unit`                                                                                                                                                                    | U7c, U7d      |
| ST-A18 | **Nothing else changes.**<br>• ST-A9's commands for ST-U7;<br>• every V3, V4 and ST-U6 GPU spec passes unchanged, **except the listed ST-U6 assertions**, which ST-A15 and ST-A11 expectations replace (allow-list in section 6);<br>• P1 packets are byte-identical;<br>• `renderer-core` imports only `contracts`;<br>• UNVERIFIED in every PR and plan entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `pnpm test:p2-identity`; `pnpm test:p3-fill-identity` (plain, with `--allow-test-change` for exactly the allow-listed files); the `git diff --exit-code` dependency check; `pnpm check:boundaries`; `pnpm test:gpu` | U7b, U7c, U7d |

### 5.6 Fixtures and seeded defects

**Fixtures.** Each has a fill, a stroke and `o = 0.5` unless stated. Each expectation is fixed before its first run, in the unit that adds it.

| ID      | Input                                                                                                                     | Checks                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| ST7-F1  | The approved example of ST-U6's GPU spec, also at `o = 0.25`                                                              | ST-A11, ST-A14, ST-A16                         |
| ST7-F2  | ST-F11's square ring, miter, with a square fill triangulated by one diagonal: the ring's inner corners lie exactly on it  | ST-A14; points on a shared edge, no T-junction |
| ST7-F3  | ST-F14 (b), a self-overlapping stroke, with a fill                                                                        | ST-A14; overlap counted once                   |
| ST7-F4  | ST-F12's open subpath with a fill: the implicit closing edge is fill boundary with no stroke                              | ST-A14; fill fringe outside the stroke         |
| ST7-F5  | An even-odd star with a stroke                                                                                            | ST-A14; fill holes under the stroke            |
| ST7-F6  | ST-F3 with round caps and a fill (disk polygons)                                                                          | ST-A14, ST-A16                                 |
| ST7-F7  | A stroke above the fringe cap (region-only stroke) with a fringed fill                                                    | ST-A14, ST-A16 (excluded band); section 4.4    |
| ST7-F8  | A fill above the fringe cap with a fringed stroke that does not cross the fill boundary (a stroke wholly inside the fill) | ST-A14, ST-A16                                 |
| ST7-F9  | ST7-F1 under a reflection (`σ = −1`)                                                                                      | ST-A14, ST-A16                                 |
| ST7-F10 | A stroke and a fill with translucent colors (`f.a = s.a = 0.5`)                                                           | ST-A13, ST-A16                                 |
| ST7-F11 | An overlay at the work cap                                                                                                | ST-A15: built                                  |
| ST7-F12 | An overlay at the work cap + 1                                                                                            | ST-A15: `overlay-unsupported`                  |
| ST7-F13 | A bevel join inside one large fill triangle: a reflex face                                                                | ST-A14: triangulated, check passes             |
| ST7-F14 | A region-only fill whose sloped boundary the stroke crosses                                                               | ST-A14: `overlay-unsupported` (ST7-Q8 (a))     |
| ST7-F15 | A small closed ring subpath stroked wholly inside one large fill triangle: a face with a hole                             | ST-A14: bridged, check passes                  |

**Seeded defects.** Each is a test-only variant or switch, listed with its failing test in the unit's PR.

| ID      | Defect                                                                     | Caught by                     |
| ------- | -------------------------------------------------------------------------- | ----------------------------- |
| ST7-D1  | Fill output `o·F'` (opacity twice)                                         | ST-A13; ST-A11's 20/255 check |
| ST7-D2  | Fill output `o·F'·(1 − S'.a)` without the denominator                      | ST-A13; ST-A16                |
| ST7-D3  | An overlay triangle dropped before the check                               | ST-A14 partition check        |
| ST7-D4  | A face's stroke role inverted                                              | ST-A14 membership check       |
| ST7-D5  | A stroke list truncated to features within `ρ/2`                           | ST-A14 brute-force list       |
| ST7-D6  | A Steiner point computed and rounded separately by each neighbour          | ST-A14 edge matching          |
| ST7-D7  | Word 15 left at 0 under the joint condition                                | ST-A15 packet bytes           |
| ST7-D8  | The joint draw placed after the stroke draw                                | ST-A15 order; ST-A11 overlap  |
| ST7-D9  | Word 15 kept from the previous frame after the stroke slot moves           | ST-A15 packet bytes           |
| ST7-D10 | `o` and `1 − o` swapped in the shader and in the TypeScript model          | ST-A13; ST-A16 at `o = 0.25`  |
| ST7-D11 | An inserted point added to one triangle of a shared edge only (T-junction) | ST-A14 edge-multiset check    |

## 6. Units

Each unit is its own PR from an updated `main`, full tier under the frozen addendum. ST-U7b and ST-U7c are high-risk exact-geometry and packet work, so the Primary or an Opus implementer does them.

**ST-U7a.** Documentation only.

- **Scope:** freeze this addendum with its review record and the user's answers; the architecture note of section 5.4; the plan entry.
- **Files:** this file, `docs/graphics-engine-architecture.md`, `docs/plans/p3-fill-stroke-meshes.md`.
- **Acceptance:** ST-A12.

**ST-U7b.** CPU only; no packet or draw change.

- **Scope:** the composite formula and its rational test model; the overlay builder of section 4.2, with its arrangement faces, triangulation, exact partition check, stroke lists, roles, Steiner rounding and work cap; its independent checks; seeded defects ST7-D1 to ST7-D6, ST7-D10 (TypeScript model) and ST7-D11.
- **Files:**
  - `packages/renderer-core/src/path-joint-overlay.ts` (new);
  - `packages/renderer-core/src/path-fringe.ts` (its exact helpers and triangulator, exported internally);
  - `tests/unit/path-joint-overlay.test.ts` (new);
  - `tests/unit/path-joint-composite.test.ts` (new).
- **Acceptance:** ST-A13, ST-A14, ST-A12.

**ST-U7c.** Behavior change.

- **Scope:**
  - overlay cache, accounting and timing; the joint condition;
  - removal of `composition-unsupported`; `overlay-unsupported` and its notices;
  - the joint record, triangle layout, word-15 rewrite, draw field, shader entry point and pipeline;
  - backend encoding and validation; device loss in unit form;
  - the dated notes of sections 5.1 to 5.3; the allow-listed unit test edits.
- **Files:**
  - `packages/renderer-core/src/path-mesh-pipeline.ts`, `path-mesh-packet.ts`, `primitive-scene-source.ts`, `index.ts`;
  - `packages/contracts/src/diagnostics.ts` (comment only);
  - `packages/renderer-webgpu/src/mesh-fill-shader.ts` (the joint entry point in the same module), `mesh-pipeline.ts`, `native-primitive-scene.ts`, `webgpu-backend.ts`;
  - renderer-core and backend unit tests; `tests/unit/st-u6-stroke-pipeline.test.ts` (allow-listed);
  - `docs/plans/p3-b2-stroke-contract.md`, `docs/plans/p3-v3-renderer-mesh-pipeline-contract.md`, `docs/plans/p3-private-contract.md`.
- **Acceptance:** ST-A15, ST-A17 (unit), ST-A18.

**ST-U7d.** Headed evidence.

- **Scope:** the playground's V3 smoke page gains a joint mode with static test-double ports (no WASM); the GPU spec for ST-A11, ST-A16 and ST-A17; artifacts with `UNVERIFIED.txt`; the `docs/validation.md` `pnpm test:gpu` row; the allow-listed GPU edits; re-baselining the ST7-Q5 cap estimates from fixture counts; plan evidence.
- **Files:**
  - `apps/playground/src/p3-v3-mesh.ts`;
  - `tests/gpu/p3-st-u7-joint.spec.ts` (new);
  - `tests/gpu/p3-st-u6-stroke.spec.ts` and `tests/support/st-u6-stroke-gpu.ts` (allow-listed);
  - `docs/validation.md`, `docs/plans/p3-fill-stroke-meshes.md`.
- **Acceptance:** ST-A11, ST-A16, ST-A17, ST-A18.

ST-U7c and ST-U7d may share one PR if the reviewer prefers the behavior change and its headed evidence together; the acceptance rows do not change.

**Allow-list of ST-U6 test edits (B1).** These edits, and only these, replace ST-U6 assertions that the frozen ST-U7 row reverses. No other assertion in these files may be weakened. `pnpm test:p3-fill-identity` gets `--allow-test-change` for exactly these files.

| File                                       | Lines on `4713307`               | Edit                                                                                                                                                                                    |
| ------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/gpu/p3-st-u6-stroke.spec.ts`        | `:25`, `:149`                    | Comment and description: the both-half node is drawn jointly instead of reporting `composition-unsupported`                                                                             |
| Same                                       | `:73-75`                         | Expected mesh draws per frame: 4 becomes 6 (the both-half node adds its joint fill draw and its stroke draw); the expectation is taken from the fixture constant, which changes with it |
| Same                                       | `:165-174`                       | The expected `composition-unsupported` diagnostic is replaced by the expectation of no D8-interim diagnostic for `both-half`                                                            |
| `tests/support/st-u6-stroke-gpu.ts`        | `:16`, `:53`, `:160`             | Comments                                                                                                                                                                                |
| Same                                       | `:71`                            | `both-half`: `drawn: false` becomes `true`                                                                                                                                              |
| Same                                       | `:237-239`                       | The three `interim-*` probes become joint probes with ST-A11's expected values (stroke-only, overlap and fill-only at opacity 0.5)                                                      |
| `tests/unit/st-u6-stroke-pipeline.test.ts` | `:34`, `:674-715`                | The comment, and the ST-A10 `composition-unsupported` test, replaced by the ST-A15 joint-condition test: a joint draw, no port call on opacity changes, cached meshes and overlay reuse |
| `tests/gpu/p3-b2-strokes.spec.ts`          | (ST-U8, if merged before ST-U7d) | Its `composition-unsupported` expectation on `both-half` is replaced by the joint expectation; its line numbers are recorded in the ST-U7d PR. Not on `main` at `4713307`               |

## 7. Open questions for the user

Each lists the recommended option first.

**ST7-Q1. Confirm the approved direction.** The approved B2 proposal §5.6 (`docs/plans/p3-b2-stroke-proposal.md:235`), B2-Q6 (a) (`:316`, `:326`) and the frozen ST-U7 row (B2 :733) already chose the joint scheme. This asks only for confirmation.

| Option                                             | What it means                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: confirm the joint scheme**      | Section 4; ST7-Q2 decides how the overlay is produced and represented                                                                                                     |
| (b) Reversal: offscreen layer instead              | Reverses B2-Q6 (a). It needs a new architecture proposal first (private contract :183); costs passes and layer memory; would also serve future container opacity          |
| (c) Kernel overlay                                 | Keeps the joint scheme but moves the overlay into the kernel through a new port shape and export, coupling the fill and stroke keys. Better kept as a C04 or K1 candidate |
| (d) Reversal: keep `composition-unsupported` in P3 | Contradicts the frozen ST-U7 row ("removing `composition-unsupported`"). Such paths stay invisible with a notice                                                          |

**ST7-Q2. How is the overlay produced, and under which exception? This is the decision B2 left open.**

ST7-A's drawn joint triangles are TypeScript re-splits of port triangles with Steiner points. Three approved texts do not cover that:

- "Arbitrary path fills and strokes use WASM-produced meshes" (`docs/graphics-engine-architecture.md:147`);
- "Region triangles are the port's, unchanged" (V3 :284);
- V3-Q3 (c)'s exception, whose builder "adds no Steiner point" (V3 :577).

No `docs/requirements.md` text is affected.

| Option                                                            | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: ST7-A under an extended D8-interim exception** | The exact TypeScript builder in `renderer-core` re-splits fill triangles in joint draws only, with Float64 Steiner points and the exact partition check. The exception covers `:147`, V3 :284 and V3-Q3 (c)'s wording. It is recorded in `docs/graphics-engine-architecture.md` (section 5.4) and removed at the R2/K1 placement decision, like the fringe builder. No ADR is needed. Unlike proposal :145's family C, this is not a permanent production method: it is disposable, with a fixed removal point, as V3-Q3 (c) was |
| (b) ST7-E, the placement-neutral alternative                      | No split and no Steiner point: crossing triangles carry complete stroke lists, with no far-field clamp for `c_S`. Covered by V3-Q3 (c) as written, with no new exception. Costs (section 3.7, estimates): about two orders of magnitude more fragment work on large curved paths; list rebuilds under rotation and shear; a band-wide mismatch with region-only strokes. A hybrid that splits only above a list cap brings Steiner points back where cost matters                                                                |
| (c) ST7-A as production placement in TypeScript now               | An ADR and an amendment of `:147`, `ARCHITECTURE.md:52-54` and private contract line 8, permanent before K1 exists                                                                                                                                                                                                                                                                                                                                                                                                               |
| (d) The kernel builds the overlay                                 | ST7-Q1 (c): a port amendment and kernel work before any visible result                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**ST7-Q3. When is an overlay built?**

| Option                                          | What it means                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: on first need, then cached** | Built in the first `prepare` where the joint condition holds, and reused across opacity toggles while both parent variants are resident. An opacity change makes no port call and rebuilds no port mesh, but its first occurrence builds derived overlay vertices. Section 5.4 records this reading of `docs/graphics-engine-architecture.md:155` |
| (b) Eagerly, for every path with both paints    | No build on any opacity change, at the cost of CPU and memory for every filled and stroked path, including the common opacity-1 case                                                                                                                                                                                                              |

**ST7-Q4. What happens when an overlay cannot be built?** Causes: the exact partition check or triangulation fails after Steiner rounding, a Steiner point lands on a sloped outer edge, or the work cap is exceeded.

| Option                                                              | What it means                                                                                                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: one new D8-interim code, `overlay-unsupported`** | Renderer scope, `paint: null`; the path is not drawn and both meshes stay cached; one notice per marked overlay variant (V3's fringe class); removed with the TypeScript builder |
| (b) Keep reporting `composition-unsupported` for these causes       | One code fewer, but the code would then mean "the overlay failed" rather than "not implemented", and the ST-U7 row says it is removed (B2 :733)                                  |
| (c) Draw the two ST-U6 draws anyway                                 | Opacity twice in the overlap, which P1 D2 forbids (`p1-instanced-primitives.md:154`). Listed only to reject it                                                                   |

**ST7-Q5. What is the overlay work cap?** It bounds the TypeScript BigInt work per build. **All values below are estimates, with no measured basis yet; ST-U7d re-baselines them from its fixture counts and the playground scene.**

| Option                                            | What it means                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: a current-cap pair of limits** | Starting values (estimates): 1,048,576 exact segment-edge tests and 4,096 Steiner points per build, counted during the build after the bounding-box prefilter. At either limit the build stops with `overlay-unsupported`. The values are labelled current-cap, re-baselined in ST-U7d as `fringeBoundaryVertexCap` was (V3 :410) |
| (b) Tie it to the fringe cap                      | Build only when both paints have at most 128 boundary vertices. Simple, but it would refuse every path above the cap. How many strokes exceed 128 is not measured; ST-U7d reports the count on its fixtures and the playground                                                                                                    |
| (c) No cap                                        | Unbounded CPU in one `prepare` for large paths                                                                                                                                                                                                                                                                                    |

**ST7-Q6. May ST-A16 gate AA bands by the relative check at the existing 2/255?** V3-A14 captures edge pixels without gating them (V3 :539). ST-A16 compares the render at `o` with `o ×` the `o = 1` render at every pixel, which needs no analytic edge geometry.

| Option                                                           | What it means                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: gate it at 2/255, outside the excluded band** | The existing tolerance on a new comparison. Each render's storage error is at most 1/255 (section 3.3), scaled by `o` on the `o = 1` side, so the expected difference is at most 1.5/255 at `o = 0.5` plus the f32 mismatch of section 3.2. A failure points at a joint defect. Pixels within 1 px of a region-only boundary are reported, not gated, with the stated count bound (section 4.4). No threshold changes |
| (b) Observation only                                             | Reported without a gate, so the AA bands have no gated joint evidence                                                                                                                                                                                                                                                                                                                                                 |

**ST7-Q7. Is container or group opacity in scope?**

| Option                                                     | What it means                                                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: no; only the node opacity of one path** | Container opacity stays exactly 1, as P1 requires (`docs/graphics-engine-architecture.md:256`). Isolated group composition keeps its own later plan |
| (b) Design ST7-B now for paths and groups                  | One isolation mechanism for both, but it needs an architecture proposal first and a P1 scope change                                                 |

**ST7-Q8. What happens when a region-only fill's sloped boundary meets the stroke?** A region-only fill (above the 128-vertex fringe cap) has the fill region boundary as its domain boundary. The stroke straddles that boundary wherever it is stroked, so Steiner points land on sloped outer edges.

| Option                                                                                 | What it means                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended (Primary decision for revision 2): fail with `overlay-unsupported`** | The rule of section 4.2 step 6, with fixture ST7-F14. Simple and checkable. **Consequence:** in practice, every region-only fill with a stroke that crosses its boundary stays hidden at `0 < o < 1`. ST-U7d reports how often that happens                                                                                                                                                        |
| (b) Check exactly, round only at packing                                               | The overlay keeps exact rational Steiner points, and the partition check runs on them. The only rounding is the binary32 packing `u = fround(exact − m_F)`, the same class V3 already accepts for port vertices without a certificate (V3 :335, :544). This removes the sloped-edge failure for every fill. It moves rounding inversions from a checked failure to V3's stated, unchecked f32 risk |
| (c) Build a frame for region-only fills                                                | Run the fringe builder's complement for joint paths even above the cap. That reverses the purpose of the 128-vertex cap (V3-Q2 (c), V3 :665)                                                                                                                                                                                                                                                       |

## 8. Risks

| ID      | Risk                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST7-R1  | **CPU cost.** The overlay is exact BigInt arrangement and triangulation work, quadratic in the worst case. Fan-like fill triangulations crossed by the inner stroke boundary produce many Steiner points. It adds to V4's builder-cost gate and B0's E3 (V3 :546). No performance claim                             |
| ST7-R2  | **Rounding inversions.** Float64 Steiner points can invert a tiny triangle or break a face; the check then fails and the path is `overlay-unsupported`. Frequency is unknown until ST-U7d's fixtures and the playground report it                                                                                   |
| ST7-R3  | **Cross-pipeline f32.** The joint and fill entry points share one module, but they are compiled into two pipelines, and WGSL does not forbid different contraction. `c_S` (and `c_F`) may therefore differ by a few f32 ulps between draws, which moves the result by the same amount (section 3.2)                 |
| ST7-R4  | **Ties and region-only edges.** At a medial-axis f32 tie (O02 :113), a pixel can differ by up to one coverage step. Along region-only stroke edges near Steiner points, a sample can do the same: split sub-edges are not the stroke draw's f32 edge, even with bit-identical vertices. ST-A16 reports those pixels |
| ST7-R5  | **G3 assumption.** Each draw relies on WebGPU's shared-edge rule, which is not normative (O02 :193). The joint draw inherits it                                                                                                                                                                                     |
| ST7-R6  | **Fragment cost.** Joint fragments evaluate two lists, and anisotropic transforms enlarge both (V3 :547)                                                                                                                                                                                                            |
| ST7-R7  | **Memory.** Overlay variants copy fill vertices and lists. With two per node they add to the 64 MiB budget and can push a working set over it (counted in `overBudgetFrames`, V3 :230)                                                                                                                              |
| ST7-R8  | **Thin strokes.** O02's rule on regions narrower than a pixel is untested (B2 :776); the joint draw inherits that                                                                                                                                                                                                   |
| ST7-R9  | **Disposable.** The overlay, record word 15 and the joint pipeline are D8-interim. K1 and the C04 layout may replace them, and K1 needs a per-tile overlay                                                                                                                                                          |
| ST7-R10 | **New interim failure.** `overlay-unsupported` adds a hide-with-notice outcome, which must be removed with the TypeScript builder (V3 :441). Under ST7-Q8 (a) it covers a whole class: region-only fills with strokes                                                                                               |
| ST7-R11 | **Test churn.** The ST-U6 allow-list edits replace assertions in three ST-U6 test files, four with ST-U8. Each edit is listed, and any other assertion change fails review                                                                                                                                          |

## 9. Review and approval record

- **2026-10-21, DRAFT revision 1** (`aef8fe1`). Written by a Primary-delegated agent from the frozen B2 contract, the approved B2 proposal, the V3 and O02 contracts and the ST-U6 code at `e172a0f`.
- **2026-10-21, independent review round 1: NOT READY.**
  - **Confirmed:** the math, by hand and on 10^6 random cases. Fill-first and stroke-first maximum error was 4.4·10^-16; there was no invalid `X`; the worst result change per `|δ|` was 0.571. The approved example gives `X = 0` and `(0, 0, 0.5, 0.5)`; the double-opacity result is `(0.25, 0, 0.5, 0.75)`.
  - **Findings:** three BLOCKING, seven SHOULD-FIX and four MINOR. All are applied in revision 2, on `main` at `4713307`, with these dispositions:

| Item | Finding                                                         | Disposition in revision 2                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | ST-A18 contradicted the ST-U6 specs; ST-A10 not amended         | **Applied.** ST-A18 now excepts the listed ST-U6 assertions; a §12.2 dated note supersedes ST-A10's clause (section 5.1); an allow-list of the three ST-U6 test files, plus ST-U8's `p3-b2-strokes.spec.ts` if it merges first, is in section 6                                                                                                                                                                                   |
| B2   | Convex split and fan fail on reflex faces and holes             | **Applied.** Faces are the exact arrangement of `T` with the clipped stroke edges, triangulated by V3's bridging and ear-clipping triangulator (section 4.2). Fixtures ST7-F13 (reflex face) and ST7-F15 (hole)                                                                                                                                                                                                                   |
| B3   | `:147` and V3 :284 not named; ADR precedent not addressed       | **Applied.** Both are named in §1.2, ST7-Q2 and §5.4. A V3 section e note is added (section 5.2). §5.4 explains why a time-bounded D8 exception suffices against proposal :145. Section 1.1 states that no `docs/requirements.md` text is affected                                                                                                                                                                                |
| S1   | Region-only edges conflict with an every-pixel gate             | **Applied.** Stroke boundary vertices are packed bit-identically, through bit-31 indices into the stroke variant's positions. Split edges near Steiner points cannot be made bit-identical (section 4.4). ST-A16 reports the 1 px band around region-only boundaries, with the count bound `3·L + 8·E`                                                                                                                            |
| S2   | A single opacity hides `o`/`1 − o` swaps                        | **Applied.** ST-A11 and ST-A16 add `o = 0.25`; seeded defect ST7-D10                                                                                                                                                                                                                                                                                                                                                              |
| S3   | Partition check and degenerate cases underspecified             | **Applied.** The check runs over the domain's boundary edge multiset. Vertex hits reuse the vertex, a stroke vertex on an edge splits both neighbours, collinear edges add no Steiner point, and every point on a shared edge goes to both triangles. Fringed fills use the pre-drop frame with exact frame coordinates. A Steiner point on a sloped outer edge is `overlay-unsupported` (ST7-F14, ST7-Q8). Seeded defect ST7-D11 |
| S4   | Stale word 15                                                   | **Applied.** Rewrite trigger stated (section 4.5); seeded defect ST7-D9                                                                                                                                                                                                                                                                                                                                                           |
| S5   | Citations drift after the rebase; #186 working set              | **Applied.** Rebased onto `4713307` and re-cited (V3 +2 from :249, plan :2805, `path-mesh-pipeline.ts:530-536`); the overlay sentence on the pending-sibling working set is in section 4.6. ST-U8 (#188) is not on `main`; it is handled conditionally in the allow-list                                                                                                                                                          |
| S6   | The no-Steiner-point option is not assessed                     | **Applied** as ST7-E (section 3.7), with the hybrid and labelled estimates, and shown as ST7-Q2 (b). ST7-A stays recommended on the merits                                                                                                                                                                                                                                                                                        |
| S7   | ST7-Q1 reopened a settled decision                              | **Applied.** ST7-Q1 is now a confirmation, with (b) and (d) marked as reversals; ST7-Q2 is the open decision                                                                                                                                                                                                                                                                                                                      |
| M1   | `composite` field and version semantics; pipeline failure scope | **Applied.** No version skew is supported, so `layoutVersion` 0 is explicit; generation-wide unavailability is confirmed as intended, with reasons (section 4.5)                                                                                                                                                                                                                                                                  |
| M2   | Same module for both entry points                               | **Adopted** (section 4.5); ST7-R3 is reworded                                                                                                                                                                                                                                                                                                                                                                                     |
| M3   | The rounding bound used `M + r`, missing miter tips             | **Applied.** The bound now uses ST-G1 and ST-G3 together: below `2^-9` px, about 0.002 px (section 4.3)                                                                                                                                                                                                                                                                                                                           |
| M4   | Unsupported cap numbers and the 128 claim                       | **Applied.** Labelled as estimates to re-baseline in ST-U7d; the claim is replaced by "not measured"                                                                                                                                                                                                                                                                                                                              |

- **Revision 2's new open item:** ST7-Q8. It records the consequence of the sloped-edge rule that S3's disposition fixes as (a).
- **Owed:** an independent re-review before freeze (B2 :767), and the user's answers to ST7-Q1 to ST7-Q8.
