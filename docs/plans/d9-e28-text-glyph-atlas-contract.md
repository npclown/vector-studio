# E28 contract: text through a browser-rasterized glyph atlas

Status: DRAFT 2026-10-29 (recommended options auto-adopted, section 10), Full tier. It touches shared surface:

- a new `text` kind in `RenderNodeSnapshot` (`packages/contracts/src/scene.ts`);
- a new `GlyphRasterPort` in `packages/contracts`;
- new diagnostic codes in `packages/contracts/src/diagnostics.ts`;
- renderer service options, a new packet part, an atlas, and a text pipeline with clip and layer variants in `renderer-core` and `renderer-webgpu`.

This is rendering-track item [E28](d9-rendering-track.md#status-index) and MVP rendering need R-T ([MVP plan, section 5](mvp-editor-plan.md#5-rendering-track-needs)). It realizes the glyph route of [ADR 0003](../decisions/0003-browser-text-and-glyph-atlas.md) (M6-Q7 (a)) and honors its "What R-T must honor" list. MVP M6c projects text through it ([M6 text plan](mvp-m6-text-plan.md#8-milestone-split-and-units-m6-q1)).

Outstanding user approval: ADR 0003 and plan route (a) are auto-adopted while the user's M6 decision card is open. If the user picks another glyph route there, this contract is withdrawn before U1 merges.

Owners:

- This file owns E28's scene node shape, atlas keys, size buckets, subpixel phases, the raster cap, eviction, device-loss rebuild, the colour-glyph rule, its acceptance criteria, fixtures and evidence.
- ADR 0003 owns the route. The M6 text plan and the M6a contract own layout: the `TextLayoutPort`, `lang`, font lists (M6-F2) and the layout `generation` (M6-F4). E28 consumes their results as plain data.
- The M6c contract owns DOM and GPU agreement and its tolerance (M6-G2). E28's probes check the GPU against its own raster port, not against DOM.
- P1 D2 owns compositing; P4 and E22 own clips and masks; E25 owns layers. E28 adds no rule to them.

## 1. Scope

In scope:

- A `text` leaf that draws grapheme clusters at given node-local positions, each from an `r8` coverage bitmap made by the browser's 2D canvas, tinted by a solid run colour.
- Text in document paint order under transforms, rect clips, masks and isolated opacity, at 4x and 1x and any DPR.
- The atlas: keys, size buckets, subpixel phases, a raster cap, a memory bound with eviction, a per-frame raster budget, and rebuild after device loss.
- A main-thread canvas implementation of the raster port, shipped by `renderer-webgpu`.

Out of scope:

- Layout, line breaking, fallback selection and font registration (M6a). The renderer never measures text.
- DOM and GPU agreement (M6c), editing, caret and selection (M6b).
- Gradient text fills, text strokes, text as a mask source (MVP-Q12), and colour-glyph fidelity (E28-K6).
- Outline, SDF or MSDF glyphs, including an outline route above the raster cap (M6-Q8 (b)).
- Worker rasterization (E28-Q5).

## 2. Scene contract (shared surface)

```ts
type SceneTextCluster = Readonly<{ text: string; x: number; y: number; advance: number }>;
type SceneTextRun = Readonly<{
  fontList: string; // the M6-F2 CSS font-family list, as the layout used it
  size: number; // node-local units
  color: SceneColor; // straight alpha, as other leaves
  clusters: readonly SceneTextCluster[];
}>;
// added to the RenderNodeSnapshot union:
// | { kind: 'text'; generation: number; lang: string; runs: readonly SceneTextRun[] }
```

- **E28-S1 shape.** `x` and `y` are the node-local pen origin of a cluster on its baseline, in the units of the node's transform: layout's cluster `x` and line baseline, with alignment and letter spacing already applied. `advance` is used for bounds only. `generation` is the layout port's generation, a non-negative safe integer that only increases. `lang` is a non-empty BCP 47 tag of at most 35 characters. Letter spacing, line height and alignment reach the renderer only through positions.
- **E28-S2 limits.** `size` is finite and in `(0, 4096]`; positions and advances are finite; a cluster's `text` is non-empty with at most 32 UTF-16 units and no C0 or C1 control; `fontList` has at most 512 characters; a node has at most 16,384 clusters in all. A text node has no `children` and no `clip`. A shape or limit violation is `invalid-value`, as for any leaf.
- **E28-S3 gate.**
  - `PrimitiveRendererService` gains `text?: 'none' | 'atlas'` and `glyphRaster?: GlyphRasterPort`. The default `'none'` rejects every text node with `unsupported-feature`, after the shape check.
  - `'atlas'` requires `clips` other than `'none'` (clip variants, as E25-S1) and a `glyphRaster` whose shape passes `hasPortShape`; otherwise construction throws a `TypeError`.
  - The mirror gains `textNodes: 'supported' | 'unsupported'`, and the service gains `requiresTextPipeline`, read by the backend at attach.
  - Text inside an isolated container needs `groups: 'isolated'` as any leaf does; the text pipeline then also gets its layer variants.
- **E28-S4 mask sources.** A text node as a mask container's `children[0]` is `unsupported-feature` (MVP-Q12). A text node inside a mask container's other children is clipped as any leaf.
- **E28-S5 compatibility.** A scene without text nodes is accepted and drawn exactly as before, with or without `text: 'atlas'` (E28-A07).

**Raster port.**

```ts
interface GlyphRasterPort {
  readonly portVersion: 0;
  readonly operationId: string;
  rasterize(request: GlyphRasterRequest): GlyphRasterResult; // synchronous
}
type GlyphRasterRequest = Readonly<{
  text: string; fontList: string; lang: string;
  pixelSize: number; // the size bucket, device px
  phaseX: 0 | 0.25 | 0.5 | 0.75; // pen origin offset inside the first pixel
}>;
type GlyphRasterResult =
  | Readonly<{ status: 'ok'; width: number; height: number; left: number; top: number; coverage: Uint8Array }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'failed'; reason: 'too-large' | 'unavailable' }>;
```

- `coverage` is row-major, `width × height` bytes, with a transparent border of at least 1 px. The bitmap's top-left pixel is at `(−left, −top)` from the pen origin's pixel, in whole device px.
- The canvas implementation, `createCanvasGlyphRaster()` in `renderer-webgpu`, runs on the main thread:
  - One `OffscreenCanvas` 2D context with `willReadFrequently`.
  - `font = "<pixelSize>px " + fontList` and `lang = lang`.
  - White `fillText` on a transparent surface at `(pad + phaseX, pad + ascent)`. The box comes from `measureText`'s `actualBoundingBox*` values plus the pad.
  - Coverage is the alpha channel.
  - Whitespace-only clusters return `empty`. A bitmap wider or taller than 1,024 px returns `too-large`.
- Main-thread rasterization sees every face registered in `document.fonts` (M6-F2, ADR 0003), so M6a's registry needs nothing else.

## 3. Rendering semantics

Notation follows P1 D2: a leaf's premultiplied contribution `P` blends source-over.

- **E28-K1 device map.** `M` maps node-local units to device px: the node's world transform, then `(world − camera) · zoom · DPR`. A cluster's device pen origin is `o = M(x, y)`, and its device size is `s = size · σ` with `σ = √|det M_lin|`.
- **E28-K2 size bucket.** The bucket `b` is `s` rounded to the nearest 1/4 px up to 64 px, and to the nearest whole px above (E28-Q2). Clusters with `s < 0.5` draw nothing and report nothing. Buckets above the raster cap `C = 256` are clamped to `C` (E28-K4).
- **E28-K3 snapped and general placement.**
  - *Snapped:* `M_lin = σ · I` within a relative 1e-9 (uniform positive scale, no rotation or flip) and `s ≤ C`. The phase is `phaseX = round(4 · frac(o.x)) / 4`, carrying 1 into the integer part. The baseline is `round(o.y)`. The bitmap is placed unscaled on whole pixels: its top-left at `(floor(o.x) + carry − left, round(o.y) − top)`. Each pixel reads one texel. Drawing a bucket unscaled changes the drawn size by at most half a bucket step: 1/8 px up to 64 px, 1/2 px above.
  - *General:* any other `M`, or `s > C`. The phase is 0. The bitmap is mapped by `M_lin / b` about `o` and sampled bilinearly with clamp-to-edge. Above `C` this magnifies the capped bitmap: glyphs blur, disclosed (M6-Q8 (a)).
- **E28-K4 raster cap.** `C = 256` device px. A cluster whose bitmap the port refuses as `too-large` draws nothing and reports E28-D3.
- **E28-K5 colour.** For coverage `c` (8-bit, from the atlas or the bilinear sample), run colour `(r, g, b, a)` straight, and node opacity `α`: `P = (r, g, b, 1) · a · c · α`, in encoded sRGB, premultiplied. This is P1 D2, with coverage multiplying RGB and alpha and opacity applied once.
- **E28-K6 colour glyphs (E28-Q4 (a)).** A colour glyph, such as emoji, draws as its coverage silhouette tinted by the run colour. Colour fidelity is out of MVP scope, disclosed.
- **E28-K7 order.** A text node is one leaf at its paint position. Its clusters draw in run order, then cluster order, and overlapping clusters blend in that order.
- **E28-K8 clips and layers.** A text draw is multiplied by its full clip coverage `K_n` (P4-K3) and sits inside isolated layers as any leaf (E25-K1, K2). At 4x every sample of a pixel receives the pixel's value, as E25's composite does. Text never writes the stencil.
- **E28-K9 bounds.** For culling, clip-chain culling and E25-K5 layer bounds, a cluster's local bound is `[x − size, x + advance + size] × [y − 2·size, y + size]`. A node's bound is the union over its clusters. The bound is conservative; probes check that glyph ink is not cut.

## 4. Realization (E28-Q1 (a))

**Atlas plan (renderer-core).** The atlas is planned on the CPU. The packet tells the backend what to upload.

- **Pages.** The atlas has up to `E28_ATLAS_PAGES_MAX = 8` pages of 2048 × 2048 `r8unorm`, 4 MiB each and 32 MiB in all. Bitmaps are shelf-packed with a 1 px gutter.
- **E28-K10 key.** An entry's key is `(generation, lang, fontList, text, bucket, phaseX)`. A lookup matches only an equal key, so an entry is never reused across generations (M6-F4). The same key used twice in a frame is rasterized once.
- **Generation.** When a frame first sees a generation `g` above every generation seen before, entries of older generations remain only as eviction candidates. Pages that hold only older-generation entries are evicted first.
- **Eviction (E28-Q3 (a)).** Eviction is page-granular LRU. A page records the last frame that drew from it. When a bitmap fits no page and all pages exist:
  1. Evict a page not used by this frame, choosing pages that hold only older-generation entries first, then the least recently used.
  2. Clear the evicted page and drop its entries.
  3. If every page is used by this frame, the clusters that do not fit are not drawn, and `render.text-atlas-limit` is reported.
- **Raster budget (E28-Q6 (a)).** At most `E28_RASTER_PER_FRAME = 256` port calls per prepared frame. A cluster still missing an entry after that:
  1. draws from an entry of the same key in the nearest other bucket, by the general path scaled to `s`, if one exists;
  2. otherwise does not draw this frame.

  The source then invalidates with reason `'scene'`. Frames continue until every visible cluster has its own entry, and the last frame equals a frame drawn with no budget.
- **Counters (test hooks).** `glyphRasterCalls`, `glyphUploads` (bitmaps written), `atlasEvictions`.

**Packet: the `text` part.** It is optional and absent when no text is drawn and no notice is pending:

```ts
type TextPacketPart = Readonly<{
  layoutVersion: 0;
  pageCount: number;
  /** Pages cleared this frame, before uploads. */
  clears: readonly number[];
  uploads: readonly Readonly<{ page: number; x: number; y: number; width: number; height: number; coverage: Uint8Array }>[];
  /** Per-instance records; 16 floats each: device quad origin and two axis vectors, texel rect, page, mode, premultiplied colour. */
  instances: Float32Array;
  /** Draws, split at a page or clip-state change; ordered against the target's draws as E25 composites are. */
  draws: readonly Readonly<{
    first: number; count: number; page: number;
    target: number; // -1: the main pass; otherwise an index into `layers`
    position: number; meshOrder: number;
    clipState?: number;
  }>[];
  notices: readonly TextNotice[];
}>;
```

- `position` and `meshOrder` mean what they mean for E25 composites, generalized: a text draw sorts against analytic runs, mesh draws and composites in its target. Batching splits at a text draw and never reorders.
- A text draw inside a layer appears in the layer's target, never in the main pass.

**Text pipeline (renderer-webgpu).**

- **Key and layout.** Key `e28-text-v0`, with variants `+clip-v0`, `+layer-v0` and both, at the scene's sample count, with and without the `stencil8` keep state (write mask 0, compare `always`), as the E25 composite.
- **Bind groups.**
  - Group 0 is the text group: the instance storage buffer, one atlas page, a linear clamp-to-edge sampler, and the target uniform.
  - Groups 1 to 3 keep their roles: clip (or empty), empty, layer (or empty). No group beyond index 3 is needed.
- **Shader.** The vertex stage builds the quad from the instance's origin and axes. The fragment stage reads coverage:
  - snapped mode: `textureLoad` at the integer texel;
  - general mode: `textureSampleLevel` at level 0.

  The sampler is the renderer's first.
- **Atlas pages** are created with `TEXTURE_BINDING | COPY_DST`, not `RENDER_ATTACHMENT`, through a new tracked-texture helper (`bytesPerTexel: 1`). Uploads use `queue.writeTexture` after clears and before the passes.
- **Existing pipelines.** Modules, keys and recorded shader hashes are unchanged. The text pipelines and pages are created only when `requiresTextPipeline` is set. If creation fails, text stays undrawn and `render.text-unavailable` is reported once per generation.

**Lifetime and device loss (E28-Q7 (a)).**

- Pages live while any text node is drawn, and are released when none remains, on resize, on dispose and on device loss.
- After device loss, the new generation's `reconstruct` packet starts from an empty atlas plan, and clusters are rasterized again under the raster budget. No CPU copy of the atlas is kept.

**Architecture amendment.** The text reservation paragraph gains: "Since E28 (2026-10-29), committed text draws as `text` scene leaves through a browser-rasterized grapheme-cluster atlas ([E28 contract](plans/d9-e28-text-glyph-atlas-contract.md))."

## 5. Diagnostics

All three are warnings exported from `packages/contracts/src/diagnostics.ts`, with queues limited as `render.clip-resource-limit` is: 4,096 queued, 32 per frame, overflow counted.

- **E28-D1 `render.text-unavailable`.** The text pipeline or atlas could not be created. Context: `{ reason }`. Reported once per renderer generation, as `render.paint-unavailable` is.
- **E28-D2 `render.text-atlas-limit`.** This frame's clusters alone exceed the atlas. Context: `{ nodeId, omitted, pages }`, for the first node with an omitted cluster. Raised once on the transition into the over-limit state, which clears when a frame draws every cluster.
- **E28-D3 `render.glyph-raster-failure`.** The port returned `failed` or threw. Context: `{ nodeId, reason }` with reason `'too-large' | 'unavailable' | 'threw'`. Raised once per node, reason and generation. The cluster is not drawn.

## 6. Acceptance criteria and fixtures

Evidence goes to `docs/evidence/e28/`.

**Runs.** Headed runs use the reference PC with Chrome and Edge, at DPR 1 and 2, at sample count 4 and a forced 1x.

**Oracle.** A CPU oracle places the port's own bitmaps by E28-K1 to K3, from the same `createCanvasGlyphRaster()` in the same page, and composes P1 D2, P4 and E25 in Float64. It is the E25 layer oracle with a text leaf source. It checks placement and compositing, not DOM agreement (M6c).

**Tolerances.**

- Snapped: 2/255.
- General (bilinear): 3/255.
- Plus 1/255 per isolation level (E25-K4).

**Fixtures.** The CSS surface is 512 × 320 unless stated.

- **T1 runs.** Latin and Hangul runs in two families from the test-system font set (Arial, Malgun Gothic) and two sizes, at zoom 1.
- **T2 phases.** One cluster at x offsets of 0, 0.25, 0.5 and 0.75 device px. They select four phases.
- **T3 general.** T1 rotated 30°, skewed, and mirrored.
- **T4 order.** Text between two overlapping shapes, and text over a mesh path and under an analytic rectangle.
- **T5 clips and layers.**
  - Text in a rotated rect clip, with clusters crossing the edge.
  - Text in a mask container.
  - Text in an isolated container at opacity 0.5 overlapping a shape.
  - Text in a nested layer.
- **T6 zoom.** T1 at zoom 0.25, 4 and 16. At 16, 24 px text exceeds `C`, so it is drawn magnified from the capped bitmap.
- **T7 colour glyph.** An emoji cluster draws its silhouette in the run colour.
- **T8 atlas pressure.** Test hooks `textAtlasPagesForTesting` and `textAtlasPageSizeForTesting` force a small atlas. They show eviction order, the over-limit notice, and convergence under the raster budget.
- **T9 generation.** A fake raster port draws a different pattern per generation. Generation 2 never draws generation 1's bitmaps.

**Observation (not a criterion).** O-MS, the `mixed-sizes` offset that M6-S0 did not diagnose (ADR 0003): on the M6-S0 page's layout, compare atlas placement (E28-K3) with canvas `fillText` at the exact fractional origin. Report whether the 1.0 px offset is positional (baseline rounding, E28-K3) or raster. M6c sets the tolerance.

**Criteria.**

| ID | Criterion | Evidence |
| --- | --- | --- |
| E28-A01 | Validation. Each E28-S2 limit and shape rule fails with `invalid-value`. `text: 'none'` rejects text with `unsupported-feature`; `'atlas'` accepts it. Option `TypeError`s per E28-S3. A text mask source is `unsupported-feature`. Equality and change sets cover the new kind | Unit tests (U1) |
| E28-A02 | Planning. Buckets, phases and snapped or general classification (E28-K2, K3) on committed matrices. Bounds per E28-K9. Key equality, one raster per key per frame, and no match across generations. Draw order against analytic runs, mesh draws and composites, in the main pass and in layers. Draw splitting by page and clip state. Eviction order. Raster budget, fallback and convergence. The D2 transition rule | Unit tests with a fake port (U2) |
| E28-A03 | T1 to T7 within the section 6 tolerances. In T5, ink is never cut by culling. In T6 the general path magnifies the capped bitmap | Headed spec, readback (U4) |
| E28-A04 | Invalidation. A colour edit, an opacity edit and a pan by whole device px cost 0 raster calls and 0 uploads. A sub-pixel pan costs at most one raster per new phase. A zoom rasterizes only new buckets. A generation change re-rasterizes every visible cluster. No path port call is made for text | Unit (U2), GPU counters (U4) |
| E28-A05 | Resources. Atlas pages and the sampler appear in resource accounting. Pages are released when no text remains, on resize, on dispose and on device loss. After device loss, once the raster budget converges, the frame equals the pre-loss capture | Unit with the fake device (U3), headed spec (U4) |
| E28-A06 | Atlas bound. T8 as stated. Generation-only pages are evicted first. Pages used by the current frame are never evicted. Total atlas bytes never exceed 32 MiB | Unit (U2), headed spec (U4) |
| E28-A07 | Identity. Scenes without text, with `text: 'none'` and `'atlas'`, give byte-identical captures against `main` at U1's merge base. Existing shader hashes, pipeline keys and module and pipeline counts with `text: 'none'` are unchanged. The E10-A1 golden log is unchanged. The full `pnpm test:gpu` passes | SwiftShader captures (U3), headed full `pnpm test:gpu` (U4) |
| E28-A08 | Raster port. The canvas port returns identical results for identical requests, `empty` for whitespace, and `too-large` beyond 1,024 px. Its bitmaps for T1 are byte-identical across two pages of one browser. T9's generation rule holds with the fake port | Headed (U4), unit (U2) |

## 7. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | Scene kind, validation and limits, `GlyphRasterPort`, the three diagnostic codes, service options and mirror gate, architecture amendment | E28-A01; CI |
| U2 | Rendering | Atlas plan, keys, buckets, phases, bounds, the `text` packet part and ordering, eviction, raster budget, notices, counters, in `renderer-core` | E28-A02; unit parts of A04, A06, A08 |
| U3 | Rendering | Pages, sampler, text pipeline and variants, uploads, accounting and lifetime, device loss, `createCanvasGlyphRaster()`, in `renderer-webgpu` | Unit part of A05; A07 on SwiftShader |
| U4 | Visualization | Headed page with `text: 'atlas'`, spec and oracle for T1 to T9, the O-MS observation; reference-PC run | E28-A03; GPU parts of A04 to A08 |
| U5 | Rendering | Evidence index `docs/evidence/e28/` | Index merged; MVP M6c may project text |

Order: U1, U2, U3, U4, U5. U1 may start once this contract is approved; it does not wait for M6a, because the scene node is plain data. M6c needs U5.

## 8. Risks

- **Main-thread cost.** Rasterization runs on the main thread and competes with M9's pointer priority. E28's raster budget bounds it per frame (`E28_RASTER_PER_FRAME`); a zoom gesture over much text draws scaled fallbacks for a few frames.
- **Browser raster changes.** Canvas text rasterization follows Chrome and Edge and can change with updates. E28's oracle uses the same browser's bitmaps, so it is not affected; M6c's DOM agreement is.
- **Grayscale coverage.** The atlas holds grayscale coverage, so text may look lighter than ClearType DOM text (ADR 0003).
- **Snapped bucket error.** Drawing an unscaled bucket changes size by up to half a step, and rounding the baseline moves a glyph by up to 0.5 px vertically. O-MS checks whether this explains M6-S0's 1.0 px offset.
- **Bounds.** E28-K9 assumes ink stays within one size of the pen box. Decorative fonts beyond that may be culled at clip and layer edges. T5 checks the test fonts.
- **First sampler.** Bilinear filtering differs slightly between GPUs. The general tolerance allows 3/255.
- **Memory.** 32 MiB of pages, plus per-frame uploads. Many families and sizes cause eviction churn, not growth.

## 9. Questions (each with a recommended option)

- **E28-Q1 realization.** (a) A CPU-planned atlas in `renderer-core`; the packet carries uploads; one text pipeline with clip and layer variants. (b) The backend owns the atlas and rasterizes during encoding.

  Recommended: (a). It keeps planning, ordering and budgets testable in Node with a fake port, as the mesh and layer plans are.
- **E28-Q2 size buckets.** (a) 1/4 px steps up to 64 px, whole px up to the 256 px cap. (b) Geometric steps of about 6 %, always drawn scaled.

  Recommended: (a). At zoom 1 it keeps text unscaled and exact against its bitmaps, with a size error of 1/8 px at body sizes. (b) blurs every glyph.
- **E28-Q3 eviction.** (a) Page-granular LRU, with older-generation pages first, 8 pages of 4 MiB. (b) Entry-granular LRU with a compacting packer.

  Recommended: (a). It is simple and needs no repacking. Entry LRU is a later optimization if churn is observed.
- **E28-Q4 colour glyphs.** (a) Silhouette tinted by the run colour, disclosed. (b) An RGBA atlas and a colour variant.

  Recommended: (a). Colour fidelity is out of MVP scope (plan section 1). (b) doubles the pipelines and adds a colour-detection rule.
- **E28-Q5 thread.** (a) Main-thread rasterization. (b) A worker with faces registered by M6a.

  Recommended: (a). M6-S0 shows a worker does not see `document.fonts` faces, and (a) needs nothing from M6a. A worker is the remedy if M9 measures the cost.
- **E28-Q6 raster budget.** (a) 256 port calls per frame, with nearest-bucket fallback and follow-up frames. (b) No budget.

  Recommended: (a). It bounds the worst frame, and the scene converges to the unbudgeted frame.
- **E28-Q7 device loss.** (a) Re-rasterize after loss. (b) Keep CPU copies of every page and re-upload them.

  Recommended: (a). The atlas is a reconstructible cache, and (b) doubles its memory.
- **E28-Q8 raster cap.** (a) `C = 256` device px, magnified above it, with blur disclosed (M6-Q8 (a)). (b) `C = 128`.

  Recommended: (a). A 256 px cluster bitmap is about 300 × 300 px, so a 2048 px page holds dozens. A 64 px heading stays sharp up to zoom 4. (b) halves that.

## 10. Decisions

- **2026-10-29, recommended options auto-adopted** under the user's standing instruction of 2026-10-24: E28-Q1 (a) to Q8 (a). The user may reopen any of them before U1 merges. A different pick on the user's M6 glyph-route card withdraws this contract.
