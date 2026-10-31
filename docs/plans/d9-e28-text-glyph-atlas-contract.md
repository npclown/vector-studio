# E28 contract: text through a browser-rasterized glyph atlas

Status: DONE 2026-10-29 ([evidence index](../evidence/e28/README.md), U5); APPROVED 2026-10-29 after independent review round 2 (recommended options auto-adopted, section 10), Full tier. It touches shared surface:

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
- P1 D2 owns compositing; P4 and E22 own clips and masks; E25 owns layers. E28 adds no rule to them, apart from generalizing E25's composite `meshOrder` into the `order` key (section 4), which U2 records as an E25 amendment.

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

- **E28-S1 shape.** `x` and `y` are the node-local pen origin of a cluster on its baseline, in the units of the node's transform: layout's cluster `x` and line baseline, with alignment and letter spacing already applied. `advance` is used for bounds only. `generation` is the layout port's generation (the *layout generation*), a non-negative safe integer. The layout port only increases it, but the renderer does not enforce that: keys differ, so a decrease is harmless. One frame may hold nodes of different layout generations, as it does while M6c re-projects. `lang` is checked syntactically, not through ICU, so Node and the browser agree: 1 to 35 ASCII letters, digits and `-`. M6a's `createTextDom` validates its configured `lang` by this same rule. A run need not span lines: M6c sends one run per same-style stretch of each line (M6a section 3, the E28 mapping). Letter spacing, line height and alignment reach the renderer only through positions.
- **E28-S2 limits.** `size` is finite and in `(0, 4096]`; positions and advances are finite; a cluster's `text` is non-empty with at most 32 UTF-16 units, no C0 or C1 control and no lone surrogate (as M6-T1); M6a splits a longer grapheme at code-point boundaries, which may draw it imperfectly, disclosed; `fontList` has 1 to 512 characters; a node has at most 16,384 runs and at most 16,384 clusters in all. DEL (U+007F) is neither C0 nor C1 and is accepted. A text node has no `children` and no `clip`. A shape or limit violation is `invalid-value`, as for any leaf.
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

- `coverage` is row-major, `width × height` bytes. `left` and `top` are whole numbers: the pen point, at the start of the baseline before the phase, is the corner between bitmap pixels `left − 1` and `left` horizontally and `top − 1` and `top` vertically. Ink is drawn at `(left + phaseX, top)` in bitmap coordinates, so pixel `(i, j)` of the bitmap covers device pixel `(P.x − left + i, P.y − top + j)` when the pen point lands on the device pixel corner `P`.
- The canvas implementation, `createCanvasGlyphRaster()` in `renderer-webgpu`, runs on the main thread:
  - One `OffscreenCanvas` 2D context with `willReadFrequently`.
  - It sets a sentinel font, then `font = "<pixelSize>px " + fontList` and `lang = lang`. If `font` still reads as the sentinel, the list did not parse and the result is `failed: 'unavailable'`.
  - From `measureText` with `pad = 2`: `left = pad + ceil(actualBoundingBoxLeft)`, `top = pad + ceil(actualBoundingBoxAscent)`, `width = left + ceil(actualBoundingBoxRight + phaseX) + pad`, `height = top + ceil(actualBoundingBoxDescent) + pad`. The bitmap therefore has a transparent border of at least 2 px.
  - White `fillText` on a transparent surface at `(left + phaseX, top)`, with `textBaseline = 'alphabetic'` and `textAlign = 'left'`. Coverage is the alpha channel. **Amendment (2026-10-31, M6c-U3): black, not white.** The fill is `#000000` (operation ID `canvas-2d/raster-v1`, was `canvas-2d/raster-v0`); coverage is still the alpha channel and the bitmap contract (`coverage`, `width`, `height`, `left`, `top`) is unchanged. Skia's glyph coverage depends on the paint's luminance (its gamma and contrast pre-blend), so white text's alpha is not the coverage of the dark text a browser paints: M6c-A06's raster term measured the difference, 0.07 CSS px in container Chromium and about 0.3 device px on Windows (vertical −0.31 CSS px at DPR 1, failing ±0.25), and with a black fill the bitmap composited black on white equals the browser's paint of the cluster exactly in container Chromium (`docs/evidence/m6c-u3/`). **Design caveat:** the atlas keeps one coverage per cluster whatever the run colour (E28-K5 multiplies it by the colour), so the coverage matches the browser's paint of near-black text only; any other run colour (coloured, grey or light text, on any background) is drawn with black's coverage and may be lighter than the browser's own paint (up to about 18/255 alpha for white and 11/255 for mid-grey in container Chromium). No M6c fixture gates this; it is recorded as a follow-up for M6c-U6 or later (M6c section 5).
  - Whitespace-only clusters return `empty`. A bitmap wider or taller than 1,024 px returns `too-large`.
- Main-thread rasterization sees every face registered in `document.fonts` (M6-F2, ADR 0003), so M6a's registry needs nothing else.

## 3. Rendering semantics

Notation follows P1 D2: a leaf's premultiplied contribution `P` blends source-over.

- **E28-K1 device map.** `M` maps node-local units to device px: the node's world transform, then `(world − camera) · zoom · DPR`. A cluster's device pen origin is `o = M(x, y)`, and its device size is `s = size · σ` with `σ = √|det M_lin|`.
- **E28-K2 size bucket.** The bucket `b` is `s` rounded to the nearest 1/4 px up to 64 px, and to the nearest whole px above (E28-Q2). Clusters with `s < 0.5` draw nothing and report nothing. Buckets above the raster cap `C = 256` are clamped to `C` (E28-K4).
- **E28-K3 snapped and general placement.**
  - *Snapped:* `M_lin = σ · I` within a relative 1e-9 (uniform positive scale, no rotation or flip) and `s ≤ C`. Rounding is half-up everywhere (`⌊v + 0.5⌋`, as `Math.round`, also for negative values), and the oracle uses the same rule. Let `q = ⌊4 · o.x + 0.5⌋`; then `phaseX = (q mod 4) / 4` and `P = (⌊q / 4⌋, ⌊o.y + 0.5⌋)` is the device pixel corner of the pen point. The bitmap is placed unscaled on whole pixels: its top-left at `(P.x − left, P.y − top)`. Each pixel reads one texel. Drawing a bucket unscaled changes the drawn size by at most half a bucket step: 1/8 px up to 64 px, 1/2 px above.
  - *General:* any other `M`, or `s > C`. The phase is 0. Bitmap point `u` (in bitmap px) maps to device point `o + (size / b) · M_lin · (u − (left + phaseX, top))`, where `phaseX` is the entry's own phase (0 for general-mode entries, possibly not for a fallback entry), so the pen point lands on `o` and one texel spans `size / b` node-local units. Coverage is sampled bilinearly, with the sample point clamped to the entry's texel rectangle inset by 0.5 texel, so no neighbouring entry is read. Above `C` this magnifies the capped bitmap: glyphs blur, disclosed (M6-Q8 (a)).
- **E28-K4 raster cap.** `C = 256` device px. A cluster whose bitmap the port refuses as `too-large` draws nothing and reports E28-D3.
- **E28-K5 colour.** For coverage `c` (8-bit, from the atlas or the bilinear sample), run colour `(r, g, b, a)` straight, and node opacity `α`: `P = (r, g, b, 1) · a · c · α`, in encoded sRGB, premultiplied. This is P1 D2, with coverage multiplying RGB and alpha and opacity applied once.
- **E28-K6 colour glyphs (E28-Q4 (a)).** A colour glyph, such as emoji, draws as its coverage silhouette tinted by the run colour. Colour fidelity is out of MVP scope, disclosed.
- **E28-K7 order.** A text node is one leaf at its paint position. Its clusters draw in run order, then cluster order, and overlapping clusters blend in that order.
- **E28-K8 clips and layers.** A text draw is multiplied by its full clip coverage `K_n` (P4-K3) and sits inside isolated layers as any leaf (E25-K1, K2). At 4x every sample of a pixel receives the pixel's value, as E25's composite does. Text never writes the stencil.
- **E28-K9 bounds.** For culling, clip-chain culling and E25-K5 layer bounds, a cluster's local bound is `[x + min(advance, 0) − size, x + max(advance, 0) + size] × [y − 2·size, y + size]`. The advance may be negative (letter spacing), so the bound covers both ends of the pen box (amendment, 2026-10-29, from the M6a-U2 cross-review; U2's code already did this). A node's bound is the union over its clusters. The bound is assumed conservative for the test fonts (section 8); T5's probes check that their ink is not cut.

## 4. Realization (E28-Q1 (a))

**Atlas plan (renderer-core).** The atlas is planned on the CPU. The packet tells the backend what to upload.

- **Pages.** The atlas has up to `E28_ATLAS_PAGES_MAX = 8` pages of 2048 × 2048 `r8unorm`, 4 MiB each and 32 MiB in all. Bitmaps are shelf-packed with a 1 px gutter.
- **E28-K10 key.** An entry's key is `(layout generation, lang, fontList, text, bucket, phaseX)`. A lookup matches only an equal key, so an entry is never reused across layout generations (M6-F4). The same key used twice in a frame is rasterized once.
- **Layout generation.** When a frame first sees a layout generation `g` above every one seen before, entries of lower layout generations remain only as eviction candidates. Pages that hold only such entries are evicted first.
- **Two phases per frame.** Planning first looks up every visible cluster and marks the pages of all hits as used by this frame. Only then does it allocate the misses, so eviction never removes an entry that the same frame reads.
- **Eviction (E28-Q3 (a)).** Eviction is page-granular LRU. A page records the last frame that drew from it. When a bitmap fits no page and all pages exist:
  1. Evict a page not used by this frame, choosing pages that hold only older-generation entries first, then the least recently used.
  2. Clear the evicted page and drop its entries.
  3. If every page is used by this frame, the clusters that do not fit are *omitted*: not drawn, and `render.text-resource-limit` is reported.

  Pages are cleared by `writeTexture` of zeros over the evicted area (pages have no `RENDER_ATTACHMENT`).
- **Compaction (amendment, 2026-10-29).** Eviction frees whole pages only, so a page that holds one entry this frame draws keeps all its stale entries (entries this frame does not draw exactly; an entry drawn only as a raster-budget fallback is stale, though it keeps its page used for the frame). When every page is used by this frame but some page holds a stale entry, step 3 does not apply:
  1. The miss that found no room, and every later miss of the frame, is *deferred*, with the raster budget's fallback. E28-D2 is not reported.
  2. The frame chooses the page with the most stale area, counted after all its lookups and fallbacks (the lowest index on a tie). The next acknowledged frame evicts and clears that page before its lookups. The clusters it drew from that page are rasterized again under the raster budget.
  3. If the frame's exact lookups used every stale entry, nothing can be freed. Its deferred misses are then omitted under step 3, and E28-D2 follows its transition rule.

  So step 3 applies only when every entry in the atlas is drawn exactly by the frame, which is section 5's "this frame's clusters alone exceed the atlas"; a deferral whose fallback is drawn is then omitted only because that fallback is itself an exact entry of the frame. Each compaction frees one page with stale entries, so for an unchanging scene a fragmented atlas needs at most one compaction per page. A scene that changes while compacting can make new stale entries and start further compactions.

  The cost is disclosed. While a compaction is pending, the misses it defers draw only their fallback. In the compacting frame, the clusters that were drawn from the evicted page are rasterized again. Those beyond the raster budget draw only their fallback, so text that was visible can disappear for a frame or more. A deferred cluster whose fallback was on the evicted page also draws nothing until it is rasterized, for example after a zoom on a full atlas. U4's T8 shows this on a one-page atlas, including a subpixel move of its text.
- **Raster budget (E28-Q6 (a), lowered by U4).** At most `E28_RASTER_PER_FRAME = 64` port calls per prepared frame. **U4 amendment (2026-10-29):** the figure was 256; on the reference PC a frame of 256 distinct calls took 19.4 to 27.9 ms (section 7, U4 record), over a 60 Hz frame, so it is lowered to 64. Criterion: the budget takes at most about half of a 60 Hz frame at the worst measured rate (0.11 ms per call at T1's sizes, so 64 calls are about 7 ms; 128 would be about 14 ms). The budget counts calls, not pixels, so 64 calls at large sizes can cost more; U5 did not time a 64-call frame on hardware; M9, or the next reference-PC run of the E28 spec, does. A cluster still missing an entry after that:
  1. draws from an entry whose key differs only in bucket and phase, the nearest bucket to `b` (the smaller on a tie, then phase 0), by the general path scaled to `s`, if one exists;
  2. otherwise does not draw this frame.

  Such a cluster is *deferred*. Omitted clusters (eviction step 3), failed clusters (E28-D3) and clusters with `s < 0.5` are never deferred. When a packet with deferred clusters is acknowledged, the service, which holds the `RendererInvalidationTarget`, invalidates once with reason `'scene'`. Frames continue while deferred clusters remain, and the last one equals a frame drawn with no budget. A frame with no deferred clusters requests nothing.
- **Port failures.** A port throw is caught inside `prepare` and becomes E28-D3 for that cluster. It never fails the packet or surfaces as `render.submission-failed`.
- **Counters (test hooks).** `getGlyphRasterCallsForTesting()`, `getGlyphUploadsForTesting()` (bitmaps written) and `getAtlasEvictionsForTesting()` on the service.

**Packet: the `text` part.** It is optional and absent when no text is drawn and no notice is pending:

```ts
type TextPacketPart = Readonly<{
  layoutVersion: 0;
  pageSize: number; // 2048, or textAtlasPageSizeForTesting
  pageCount: number; // the backend creates or releases pages to match
  /** Areas zeroed this frame, before uploads. */
  clears: readonly Readonly<{ page: number; x: number; y: number; width: number; height: number }>[];
  uploads: readonly Readonly<{ page: number; x: number; y: number; width: number; height: number; coverage: Uint8Array }>[];
  /** Per-instance records; 16 floats each: device quad origin and two axis vectors, texel rect, page, mode, premultiplied colour. */
  instances: Float32Array;
  /** Draws, split at a page or clip-state change; ordered against the target's draws as E25 composites are. */
  draws: readonly Readonly<{
    first: number; count: number; page: number;
    target: number; // -1: the main pass; otherwise an index into `layers`
    position: number; order: number;
    clipState?: number;
  }>[];
  notices: readonly TextNotice[]; // E28-D2 and D3, with their section 5 contexts
}>;
```

- **Order key.** `position` is the number of the target's analytic draws that precede the text draw, as `MeshFillDraw.position`. `order` is the number of the target's non-analytic draws (mesh draws, E25 composites and text draws) with an equal `position` that precede it. U2 renames E25's composite `meshOrder` to `order` with this definition; for packets without text the merged draw sequence is unchanged, since ties between composites were already decided by array order. Mesh draws carry no `order` field; their order is implied by array order. At each `position` the backend fills slot `k` with the composite or text draw whose `order` is `k`, and otherwise with the next mesh draw. Equal keys cannot occur. Batching splits at a text draw and never reorders.
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
- **Existing pipelines.** Modules, keys and recorded shader hashes are unchanged. With `text: 'atlas'`, attach creates the text module, the text pipelines and the sampler; U3 pins the resulting counts. Pages are created only when a packet's `pageCount` asks. If creation fails, text stays undrawn and `render.text-unavailable` is reported once per renderer generation.

**Lifetime and device loss (E28-Q7 (a)).**

- **Plan and receipts.** The CPU plan decides page count, clears and uploads; the backend follows `pageCount`. A submitted packet's receipt gains a `text` part: the page incarnations and the clears and uploads applied. The plan commits a frame's allocations, clears and uploads only on `acknowledge` of that receipt. Anything not acknowledged (a `not-ready`, `stale-generation` or `failed` result, or a packet never acknowledged) is planned again, and a changed page incarnation drops that page's entries. Because the backend writes to pages before `queue.submit`, a packet that cleared or uploaded to a page and then failed may have changed the page without a receipt. So when a pending packet is replaced without acknowledgement, the plan drops its entries on every page that packet cleared or uploaded to.
- **Release.** Pages stay while the scene holds any text node, visible or culled, so panning text away and back costs nothing. They are released when the scene holds no text node, on dispose and on device loss. Pages are not sized to the target, so a resize keeps them.
- **Device loss.** The new renderer generation's `reconstruct` packet starts from an empty atlas plan, and clusters are rasterized again under the raster budget. No CPU copy of the atlas is kept.

**Architecture amendment.** The text reservation paragraph gains: "Since E28 (2026-10-29), committed text draws as `text` scene leaves through a browser-rasterized grapheme-cluster atlas ([E28 contract](plans/d9-e28-text-glyph-atlas-contract.md))."

## 5. Diagnostics

All three are warnings exported from `packages/contracts/src/diagnostics.ts`, with queues limited as `render.clip-resource-limit` is: 4,096 queued, 32 per frame, overflow counted.

- **E28-D1 `render.text-unavailable`.** The text pipeline or atlas could not be created. Context: `{ reason }`. Reported once per renderer generation, as `render.paint-unavailable` is. Its `reason` is `'pipeline'` or `'page-allocation'`.
- **E28-D2 `render.text-resource-limit`.** This frame's clusters alone exceed the atlas. Context: `{ nodeId, omitted, pages }`, for the first node with an omitted cluster. Raised once on the transition into the over-limit state, which clears when a frame draws every cluster.
- **E28-D3 `render.glyph-raster-failure`.** The port returned `failed` or threw. Context: `{ nodeId, reason }` with reason `'too-large' | 'unavailable' | 'threw'`. Raised once per node, reason and layout generation. The cluster is not drawn.

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
- **T8 atlas pressure.** Service options `textAtlasPagesForTesting` and `textAtlasPageSizeForTesting` (E10 naming; the backend reads the page size from the packet) force a small atlas. They show eviction order, the over-limit notice, and convergence under the raster budget.
- **T9 generation.** A fake raster port draws a different pattern per generation. Generation 2 never draws generation 1's bitmaps.

**Hand-off to M6c (not a criterion).** M6-S0's `mixed-sizes` offset of 1.0 px is between canvas `fillText` at the exact origin and DOM, so an atlas-against-canvas comparison cannot explain it. ADR 0003 asks R-T and M6c to measure real atlas output against DOM; M6c owns that measurement and its tolerance. U4 supplies what it needs: a per-cluster readback hook that draws one cluster isolated through the atlas, and the E28-K3 placement of each cluster (pen corner `P`, phase and bucket), so M6c can separate baseline and phase rounding from raster differences.

**Raster cost (observation).** U4 records milliseconds per port call at T1's sizes on the reference PC and the time of a 256-call frame (after U4, the probe times one budget-sized frame). If 256 calls do not fit a frame at 60 Hz, U4 records it and E28-Q6's figure is lowered before U5.

**Criteria.**

| ID | Criterion | Evidence |
| --- | --- | --- |
| E28-A01 | Validation. Each E28-S2 limit and shape rule fails with `invalid-value`. `text: 'none'` rejects text with `unsupported-feature`; `'atlas'` accepts it. Option `TypeError`s per E28-S3. A text mask source is `unsupported-feature`. Equality and change sets cover the new kind | Unit tests (U1) |
| E28-A02 | Planning. Buckets, phases, half-up rounding and snapped or general classification (E28-K2, K3) on committed matrices, negative coordinates included. Bounds per E28-K9. Key equality, one raster per key per frame, and no match across layout generations. Draw order by `(position, order)` against analytic runs, mesh draws, composites and other text draws, in the main pass and in layers. Draw splitting by page and clip state. Two-phase eviction and its order. Raster budget, fallback, one invalidation per acknowledged deferring packet, none for omitted or failed clusters, and convergence. Commit on `acknowledge` only, replanning after `not-ready`, `stale-generation` and `failed`, and dropping the entries on pages written by a packet replaced without acknowledgement. E28-D2's transition rule. E28-D3 from a fake port that fails and one that throws | Unit tests with a fake port (U2) |
| E28-A03 | T1 to T7 within the section 6 tolerances. In T5, ink is never cut by culling. In T6 the general path magnifies the capped bitmap | Headed spec, readback (U4) |
| E28-A04 | Invalidation. A colour edit, an opacity edit and a pan by whole device px cost 0 raster calls and 0 uploads. A sub-pixel pan costs at most one raster per key and new phase. Panning text out of view and back costs 0 raster calls. A zoom rasterizes only new buckets. A generation change re-rasterizes every visible cluster. No path port call is made for text | Unit (U2), GPU counters (U4) |
| E28-A05 | Resources. Atlas pages and the sampler appear in resource accounting. Pages are released when the scene holds no text node, on dispose and on device loss, and kept on resize. After device loss, once the raster budget converges, the frame equals the pre-loss capture. E28-D1 is reported once under injected pipeline and page-allocation failures | Unit with the fake device (U3), headed spec (U4) |
| E28-A06 | Atlas bound. T8 as stated. Generation-only pages are evicted first. Pages used by the current frame are never evicted. Total atlas bytes never exceed 32 MiB | Unit (U2), headed spec (U4) |
| E28-A07 | Identity. Scenes without text, with `text: 'none'` and `'atlas'`, give byte-identical captures against `main` at U1's merge base. Existing shader hashes and pipeline keys are unchanged. Module and pipeline counts with `text: 'none'` are unchanged, and with `'atlas'` they rise by exactly the text pipelines U3 pins. The E10-A1 golden log, which runs with `text: 'none'`, is unchanged. The full `pnpm test:gpu` passes | SwiftShader captures (U3), headed full `pnpm test:gpu` (U4) |
| E28-A08 | Raster port. The canvas port returns identical results for identical requests, `empty` for whitespace, `too-large` beyond 1,024 px, and `failed: 'unavailable'` for an unparsable font list. Ink with negative left bearing (an italic and a combining mark) is not cut. Its bitmaps for T1 are byte-identical across two pages of one browser. T9's generation rule holds with the fake port | Headed (U4), unit (U2) |

## 7. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | Scene kind, validation and limits, `GlyphRasterPort`, the three diagnostic codes, service options and mirror gate, architecture amendment | E28-A01; CI |
| U2 | Rendering | Atlas plan, keys, buckets, phases, bounds, the `text` packet part and ordering, eviction, raster budget, notices, counters, in `renderer-core`; the `meshOrder` to `order` rename across `renderer-core`, the backend merge in `renderer-webgpu`, E25's tests and an E25 contract amendment note | E28-A02; unit parts of A04, A06, A08 |
| U3 | Rendering | Pages, sampler, text pipeline and variants, uploads, accounting and lifetime, device loss, `createCanvasGlyphRaster()`, in `renderer-webgpu` | Unit part of A05; A07 on SwiftShader |
| U4 | Visualization | Headed page with `text: 'atlas'`, spec and oracle for T1 to T9, the per-cluster readback hook for M6c, the raster-cost observation; reference-PC run | E28-A03; GPU parts of A04 to A08 |
| U5 | Rendering | Evidence index `docs/evidence/e28/` | Index merged; MVP M6c may project text |

Order: U1, U2, U3, U4, U5. U1 may start once this contract is approved; it does not wait for M6a, because the scene node is plain data. M6c needs U5.

U1 (2026-10-29):

- `packages/contracts`:
  - the `text` kind in `RenderNodeSnapshot`, with `SceneTextRun`, `SceneTextCluster` and the E28-S2 limits as `SCENE_TEXT_MAX_*` constants;
  - `GlyphRasterPort` and its request and result types in `text.ts`;
  - the codes `TEXT_UNAVAILABLE`, `TEXT_RESOURCE_LIMIT` and `GLYPH_RASTER_FAILURE`.
- `renderer-core`:
  - validation and equality of the kind;
  - the `textNodes` mirror option;
  - the E28-S4 mask-source rule in the graph walk;
  - the service options `text` and `glyphRaster`, with their `TypeError`s, and `requiresTextPipeline`.
- Text nodes are accepted under `text: 'atlas'` but draw nothing and take no paint position until U2. The backend does not read `requiresTextPipeline` until U3.
- The architecture's text reservation gains the section 4 sentence.
- Review follow-ups applied in U1: the run cap (`SCENE_TEXT_MAX_RUNS`), the `fontList` lower bound and the DEL wording in E28-S2.
- Carried to U2: the world-bounds arithmetic for text (E28-K9 bounds through the node transform) must be checked for finiteness, as `hasFiniteSceneArithmetic` does for other leaves.
- Tests: `tests/unit/e28-u1-text-scene.test.ts` (E28-A01).

U2 (2026-10-29):

- `renderer-core`:
  - `text-atlas.ts`: E28-K1 to K3 placement, E28-K2 buckets, the E28-K10 keys, the page plan with shelf packing, two-phase lookup, eviction and the raster budget, the instance records, E28-D2 and D3 notices with `textNoticeDiagnostic`, and the counters;
  - `PrimitiveSceneSource`: text leaves in the traversal with E28-K9 bounds, culling, layer bounds, mask admission and clip states, the `text` packet part, and commit on `acknowledge`;
  - the service options `textAtlasPagesForTesting` and `textAtlasPageSizeForTesting`, and the invalidation once per acknowledged packet with deferred clusters;
  - the U1 carry-over: a text node with a cluster whose E28-K9 world bound is not finite is `invalid-value`, as P1's arithmetic rule asks of other leaves.
- The order key: E25's composite `meshOrder` is now `order` with the section 4 definition, in `renderer-core` and in the backend merge of `renderer-webgpu`. The backend checks the orders of composites and text draws per target and holds a text draw's slot without drawing it until U3. E25's tests and contract carry the rename (E25 section 4, amendment note).
- Refinements recorded here, within section 4:
  - The `text` part is also present while the atlas holds pages, so `pageCount` keeps them for culled text, and once with `pageCount` 0 when the scene's last text node goes, which releases them.
  - Draws are split per text leaf as well as at a page or clip-state change.
  - The receipt's `text` part is `{ pages, clears, uploads }`: the incarnation per page index and the counts of clears and uploads applied. A page whose incarnation changed loses the entries from earlier packets, and the service invalidates once.
  - A page written by a packet replaced without acknowledgement is cleared before its next allocation.
  - Empty and failed port results are kept per key and layout generation, since they touch no page; a frame does not ask the port again for them.
  - A port result that is not well formed counts as a throw (`'threw'`).
  - Eviction step 3 ends the frame's port calls: once every page is used by the frame, the remaining misses are omitted without a port call and are not deferred, so an over-limit frame converges. An omitted key is rasterized at most once per frame, and a bitmap larger than a page evicts nothing.
  - The part is also present when the frame deferred clusters, so its acknowledgement invalidates.
  - E28-D2 clears when a frame omits and defers nothing. The D2 and D3 notices leave their queue when a packet carries them, as the mask and layer notices do, so a packet that is never acknowledged takes its notices with it.
- Interim state until U3: the WebGPU backend returns no `text` receipt part, so a packet with a text part is never acknowledged there. No host enables `text: 'atlas'` before U3 lands the receipt part.
- Observation for U3: a `not-ready` result writes nothing, yet the plan drops the pages of the replaced packet as section 4 asks. U3 may let the backend report that it wrote nothing.
- Tests: `tests/unit/e28-u2-atlas-plan.test.ts` (E28-A02; unit parts of A04, A06 and A08), and the updated `tests/unit/e25-u2-layer-plan.test.ts` and `tests/unit/e25-u3-layer-passes.test.ts`.

U3 (2026-10-29):

- `renderer-webgpu`:
  - `text-pipeline.ts`: the text module (`e28-text-v0`), its `+clip-v0`, `+layer-v0` and combined variants, keys, the group 0 layout, the sampler descriptor and the pipeline descriptor;
  - `canvas-glyph-raster.ts`: `createCanvasGlyphRaster()` as section 2 states, exported from the package;
  - the native scene: the text pipelines and sampler at creation, atlas pages, clears and uploads, the text buffer, the receipt's `text` part, text draws in the main pass and in layer passes, and release;
  - the backend: the `textPipeline` creation option from `requiresTextPipeline`, E28-D1, and E28-D2 and D3 from the packet's notices, emitted as the clip and layer notices are.
- The E23 headed page gains `text=atlas`, which sets the service's `text` option with the canvas port and exposes the port's bitmaps. U3's SwiftShader script uses it, and U4 may.
- Refinements recorded here, within section 4:
  - Each variant has its own module, pipeline layout and pipeline. The clip variants exist when the clip variants do, the layer variants when the layer pipeline does. So `textPipeline` adds one to four modules and as many pipelines, which U3 pins. Creation is all or nothing: any failure leaves text unavailable for the generation (E28-D1, `'pipeline'`).
  - Group 0's target uniform and the instance records share one text buffer. The uniform is at offset 0 and the records start at the storage offset alignment. The buffer grows by powers of two and is released on a frame without text draws. The uniform is written only when the target size changes.
  - Pages are created through `#createTrackedTextureWithUsage`, which takes exactly the given usage. The existing helper now calls it with `RENDER_ATTACHMENT` added. A page whose size differs from the packet's `pageSize` is recreated, which changes its incarnation.
  - Without the text pipeline, or once a page could not be created, the scene writes and draws no text for the rest of its generation. It releases its pages, and its receipts name stable placeholder incarnations per page index. The plan then settles instead of re-rasterizing every frame. A page allocation failure is E28-D1 with `'page-allocation'`. E28-D1 is reported once per renderer generation, for whichever reason comes first.
  - The text buffer fails the same way. If it cannot be created or tracked, or the instance records exceed `maxStorageBufferBindingSize` or `maxBufferSize`, the frame still submits without text, and E28-D1 is reported with `'page-allocation'`. A limit never fails the frame with `allocation-failed`.
  - A clear is written in bands of whole rows from one 64 KiB zero array, so no page-sized array is allocated.
  - The canvas port remembers that it has no 2D context and does not ask again. A cluster whose measured box has no width or no height is `empty`, so it takes no atlas space.
  - A text draw in the main pass binds its pipeline, group 0 for its page and, when clipped, the clip group. In a layer pass it also binds the empty group, or the clip group, at 1 and the empty group at 2. A clipped text draw without the clip variant, or a layer text draw without the layer variant, is not drawn (fail closed).
- Not adopted: the U2 observation about `not-ready`. A `not-ready` or `stale-generation` result writes nothing, and the plan still drops the replaced packet's pages, as section 4 asks. That happens only before the first target or after dispose, so the extra rasters are rare.
- Tests: `tests/unit/e28-u3-text-pipeline.test.ts`. It covers the unit part of E28-A05 and the hash, key and count part of A07. It also covers the gaps carried from U2:
  - fallback tie-breaking with the entry's phase kept;
  - snapped placement at negative coordinates;
  - an incarnation change on a page with this frame's uploads;
  - a packet replaced after an eviction;
  - text, mesh draws and composites ordered in a layer;
  - positive backend tests for text slots;
  - no path port call for text.
  
  The fake raster port and text nodes moved to `tests/support/e28-text-harness.ts`. The fake device gains `createSampler`, `queue.writeTexture` and texture-failure injection.
- Evidence: [u3-swiftshader.md](../evidence/e28/u3-swiftshader.md), the A07 capture part and a snapped-text check on SwiftShader. The check is exact against the port's own bitmaps, and all four variants are identical.
- Known limit, disclosed: WebGPU's `createTexture` does not throw on out-of-memory. It returns a texture and reports the error asynchronously, so the fake device's thrown failure covers only synchronous failures. U4 checks a real page allocation with an error scope on the reference PC.
- Left to U4: partial clips over text, text under group opacity, and bilinear general text against the oracle (T3 and T5). U3's SwiftShader check covers only snapped text, clips that do not cut glyphs, layers at opacity 1, and that rotated text draws ink.

U2 amendment, compaction (2026-10-29):

- **Found by** U4's T8 spec on SwiftShader. On a one-page atlas, a layout generation change put new entries into the page's free space, which marked the page as used by the frame. The remaining clusters were then omitted and E28-D2 was reported, although they fit the atlas on their own. Every later frame hit the same page, so the text never converged. The same lock can occur with eight pages once every page receives one of a frame's new entries.
- **Fix:** the section 4 compaction rule, in `renderer-core`'s `GlyphAtlasPlan`.
  - The pending page is committed only on `acknowledge`. It is dropped by `reset` and by a frame without text.
  - An atlas without stale entries behaves as before, so the U2 and U3 tests pass unchanged.
- **Review** (R1 NOT READY):
  - The first version evicted every page, and suppressed compaction until a frame drew every cluster. That left the lock possible after a compaction that ended over the limit. It also blanked a large atlas.
  - The rule now evicts one page per compaction and has no suppression.
  - R3 READY WITH FOLLOW-UPS: the cost paragraph now names fallbacks on the evicted page; U4's T8 adds R2's subpixel move on the real port. A frame that both fragments and defers under the raster budget is covered by the convergence argument only, since one page of T8 could not hold 256 misses (at the budget of 64 it could; not added).
  - R2 NOT READY: an entry drawn only as a fallback counted as drawn, so after a subpixel move on a full atlas its stale space was hidden and the frame omitted with a false E28-D2. A fallback now keeps its page used but its entry stays stale.
- **Tests:** `tests/unit/e28-u2-atlas-plan.test.ts`, "E28 section 4 compaction". They cover:
  - the deferral and the eviction;
  - a frame that exceeds the compacted atlas;
  - recovery after an over-limit compaction (the review's case), with E28-D2 raised again on re-entry;
  - an entry drawn only as a fallback after a subpixel move (R2's case);
  - the choice of the stalest page with two pages;
  - compaction under the raster budget, with one invalidation per deferring frame;
  - an unacknowledged fragmented frame, and an unacknowledged compacting frame;
  - a release while a compaction is pending.

U4 record, headed spec (2026-10-29):

- **Spec:** `tests/gpu/e28-text-atlas.spec.ts`, with the oracle in `tests/support/e28-text-oracle.ts`. E25's scene builder moved to `tests/support/e25-scene.ts` so both specs share it. The E23 page gains `raster=fake`, `pages` and `pagesize` options and the M6c hand-off hooks `placements`, `readCluster` and `rasterCost`.
- **Oracle:** snapped clusters read one texel per pixel. General clusters sample bilinearly at the pixel centre with the 0.5-texel inset clamp. A general pixel within 1.5 device px of a quad edge is undecided unless the bilinear value there is at most 1/255. Colours are premultiplied and blend in order, through E25's layer oracle.
- **SwiftShader pre-run:** [../evidence/e28/u4-swiftshader.md](../evidence/e28/u4-swiftshader.md). All 14 tests pass. General text needs `E28_GENERAL_TOLERANCE=16` there, because SwiftShader's bilinear filtering is coarser than the section 6 tolerance. The reference-PC run keeps the default tolerance, 3.
- **Out-of-memory, disclosed:** the spec does not force a real `createTexture` failure. A05 and the 32 MiB bound check that page allocations raise no uncaptured device error. A real out-of-memory would surface as an uncaptured device-error diagnostic, not as E28-D1, because `createTexture` reports it asynchronously (U3's known limit).
- **E28-K9:** amended for negative advances (above), with a unit test; U2's code already used both ends of the pen box.
- **Review** (READY WITH FOLLOW-UPS, all applied): the raster-cost frame now has 256 distinct requests (it had 84), and cold and warm calls are reported apart; the spec checks the page's placements against K1 to K3 computed apart from renderer-core; T8 gains an eviction-order test on two pages; A08's bearing check fails on a non-`ok` result and requires a real negative bearing; undecided probes are bounded; the general-tolerance override fails on a hardware adapter.
- **Raster cost:** on SwiftShader's host a 256-call frame takes 16.3 ms at DPR 1 and 21.8 ms at DPR 2.
- **Reference-PC run** (2026-10-29, [../evidence/e28/u4-main-pc.md](../evidence/e28/u4-main-pc.md)): full `pnpm test:gpu` at 9bbee7f (tree of ae1d7ab), headed Chrome 156 and Edge 156 on a GTX 1660 SUPER, 210 passed, 0 failed; all 14 E28 tests pass in both browsers with the default general tolerance 3 (worst general 1.42/255, no undecided probe). A 256-call frame took 24.0 and 27.9 ms in Chrome and 19.4 and 25.6 ms in Edge (DPR 1 and 2), so E28-Q6's figure is lowered to 64 before U5 (section 4, Raster budget). The PC ran with 256; the lowered budget changes only how many frames a large miss set takes, checked by the unit tests and the SwiftShader re-run recorded in [../evidence/e28/u4-swiftshader.md](../evidence/e28/u4-swiftshader.md), and U5's index records that the hardware cost of a 64-call frame is extrapolated from the 256-call figure.

U4 amendment, raster budget (2026-10-29):

- `E28_RASTER_PER_FRAME` is 64. Unit tests that assumed 256 now converge over the frames the budget needs (A06's page bound, the budget, fallback and compaction tests), and U3's storage-limit test reaches 80 records with one key. The headed spec's budget and raster-cost checks use the constant.
- Cost: a frame with more misses than 64 defers the rest. A fallback exists only for a bucket or phase change of an entry already in the atlas (a zoom or a subpixel move), so new clusters and clusters of a new layout generation draw nothing until their frame comes: 600 new visible clusters appear over 10 frames instead of 3, and after a generation change (for example each of M6a's `registerFont` bumps) 256 visible clusters take 4 frames instead of 1 and 1,000 take 16, about a quarter of a second at 60 Hz.
- Review R1 NOT READY: T8's over-limit steps assumed 256 and the cost note claimed fallbacks for new text; both fixed as stated here, with the unit tests now checking the per-frame budget after a compaction and one invalidation per deferring frame after a zoom.
- T8's over-limit steps show the scene until E28-D2 appears (bounded by the frames the budget needs plus 3), then check it is not repeated, instead of a fixed frame count.

U5 (2026-10-29): the evidence index [../evidence/e28/README.md](../evidence/e28/README.md) records E28-A01 to A08 as PASS: the unit criteria in CI, A07's captures on SwiftShader, and the headed spec and the full `pnpm test:gpu` on the reference PC at the tree of #370. That run predates #378, so the budget of 64 is checked by unit tests and a SwiftShader re-run only, and its hardware cost (about 7 ms) is extrapolated from the 256-call figure; timing a 64-call frame passes to M9 or the next reference-PC run. Review: READY WITH FOLLOW-UPS, all applied.

## 8. Risks

- **Main-thread cost.** Rasterization runs on the main thread and competes with M9's pointer priority. E28's raster budget bounds it per frame (`E28_RASTER_PER_FRAME`, 64 after U4's measurement, about 7 ms on the reference PC by extrapolation). New or regenerated text past the budget is blank until its frame comes (up to about 16 frames for 1,000 visible clusters after a font-load generation bump); a zoom gesture over much text draws scaled fallbacks for a few frames.
- **Browser raster changes.** Canvas text rasterization follows Chrome and Edge and can change with updates. E28's oracle uses the same browser's bitmaps, so it is not affected; M6c's DOM agreement is.
- **Grayscale coverage.** The atlas holds grayscale coverage, so text may look lighter than ClearType DOM text (ADR 0003).
- **Snapped bucket error.** Drawing an unscaled bucket changes size by up to half a step, and rounding the baseline moves a glyph by up to 0.5 px vertically. M6c measures whether this explains M6-S0's 1.0 px offset, with U4's hook.
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
- **E28-Q6 raster budget.** (a) 256 port calls per frame (lowered to 64 by U4's measurement), with nearest-bucket fallback and follow-up frames. (b) No budget.

  Recommended: (a). It bounds the worst frame, and the scene converges to the unbudgeted frame.
- **E28-Q7 device loss.** (a) Re-rasterize after loss. (b) Keep CPU copies of every page and re-upload them.

  Recommended: (a). The atlas is a reconstructible cache, and (b) doubles its memory.
- **E28-Q8 raster cap.** (a) `C = 256` device px, magnified above it, with blur disclosed (M6-Q8 (a)). (b) `C = 128`.

  Recommended: (a). A 256 px cluster bitmap is about 300 × 300 px, so a 2048 px page holds dozens. A 64 px heading stays sharp up to zoom 4 at DPR 1, and zoom 2 at DPR 2. (b) halves that.

## 10. Decisions

- **2026-10-29, recommended options auto-adopted** under the user's standing instruction of 2026-10-24: E28-Q1 (a) to Q8 (a). The user may reopen any of them before U1 merges. A different pick on the user's M6 glyph-route card withdraws this contract.

**Review record.** Independent review (fresh context), 2026-10-29.

- Round 1: NOT READY, with five blocking findings: order ties between text draws, composites and mesh draws; the general-mode mapping missing `size`; the raster port's placement convention; the CPU plan falling out of step with GPU pages (no receipt part, release on resize); and an unbounded follow-up loop under the raster budget. Further findings: bilinear bleed, release while culled, two-phase eviction, the O-MS method, `pageSize` and clears, diagnostics coverage and naming, rounding and fallback keys, port robustness, wording, and the unmeasured budget. All applied: the `(position, order)` key, the explicit texel map with an inset clamp, the `measureText` box rule with a sentinel font, receipt-committed plans, deferred clusters invalidated once per acknowledged packet, and the rest as listed.
- Round 2: READY WITH FOLLOW-UPS (pages written by a failed submission, the fallback entry's phase in the general map, the scope of the `order` rename and its E25 note, two M6a cross-references), all applied.
