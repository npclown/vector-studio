# V-32 contract: images (paste, drop, place, image fill)

Status: **DONE 2026-11-12** ([exit record](../evidence/v32/exit-2026-11-12.md)); adopted 2026-11-12 (review round 2 READY WITH FOLLOW-UPS, follow-ups applied, section 12), Full tier. Visualization-track item [V-32](d9-visualization-track.md#status-index), item 2 of the Figma gap list the user asked for on 2026-11-12 ("1~10번까지 다 진행해줘"). The request lifts the `requirements.md` deferral "Images are deferred". The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24 unless the user picks otherwise. Identifiers use the prefix **V32-**.

It changes shared surface, so every unit is Full tier:

- the document schema: optional fields of the unreleased v8 (coordinator rule of 2026-11-12: the first gap-list item to merge introduces v8 through the V-35 scaffold PR; later items add optional fields and fill defaults in `migrateV7toV8`): an `images` table and an image fill paint;
- the scene contract (`SceneImagePaint`), scene validation, the mirror's `paints` option and two diagnostic codes;
- a new port in `contracts` (`ImageSourcePort`), the E23 paint variants (section 4.3), a texture store in `renderer-webgpu`;
- new editor commands, a projector option, an optional clipboard fragment field, export of image paints, UI (paste, drop, toolbar, panel);
- [requirements.md](../requirements.md): images move from "deferred" to supported, and the future-considerations list drops image fills and raster image content.

It adds no runtime dependency and changes no threshold of P3, E23, E25, E39 or E41. A scene without image paints draws exactly as before (V32-A09).

Owners: this file owns V-32's order, criteria and evidence. [E23](d9-e23-gradient-paint-contract.md) owns the paint records this extends; [V-30](viz-v30-export-contract.md) owns the export writer; the multiple-fills item (V-35, parallel) owns `fills`, into which an image paint drops as one more fill paint (agreed with that thread 2026-11-12: `Fill = { paint, visible, opacity, blendMode }`, each fill its own scene draw).

## 1. What a user can do

- **Paste** an image (PNG, JPEG, WebP, GIF first frame) copied from another app: a rectangle with the image as its fill appears at the image's natural size, placed by the existing paste rule (M6b section 9.3: at the pointer when it is over the canvas, else the view centre), and is selected.
- **Drop** one or more image files on the canvas: each becomes such a rectangle, the first centred on the drop point, later ones offset by (20, 20) page units.
- **Place image** from the toolbar or Ctrl/Cmd+Shift+K: a file picker, then as drop at the view centre.
- **Image fill** on a selected rectangle, ellipse, path, star, frame or symbol: in the fill section choose "Image", pick a file, choose the scale mode (Fill, Fit, Stretch, Tile) and, for Tile, a scale.
- Copy, paste, duplicate, undo, autosave and reload keep images. Export to PNG and SVG includes them.

An image is a paint, not a node type (V32-Q1 (a), Figma's model): a placed image is a rectangle that can be resized, rotated, given corner radii, a stroke, effects or a mask like any other.

## 2. Document model

```ts
type ImageScaleMode = 'fill' | 'fit' | 'stretch' | 'tile';
type ImagePaint = Readonly<{ kind: 'image'; image: string; scaleMode: ImageScaleMode; scale: number }>;
type FillPaint = Color | Gradient | ImagePaint;   // fill slots; strokes keep Paint = Color | Gradient
type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
type ImageAsset = Readonly<{ mimeType: ImageMimeType; width: number; height: number; data: string }>;
// v8 document: `images?: Readonly<Record<string, ImageAsset>>`.
```

- **V32-M1 table.** Optional `images`, keyed by the lowercase hex SHA-256 of the decoded bytes (64 characters). Absent means `{}`; parse keeps it absent for a document without it, `migrateV7toV8` adds nothing, and serialize omits the field when the table is empty (so documents without images serialize as they do without V-32). `data` is standard base64 with padding; `width` and `height` are the natural size after EXIF orientation, whole numbers in `[1, 32768]` with `width · height ≤ 2²⁶` pixels.
- **V32-M2 limits and parse cost.** Each asset decodes to at most 32 MiB; the table's total, measured on the finished document, at most 256 MiB. Parse checks the base64 alphabet, padding and length (not the full decode) and decodes only the first 16 bytes, which must match `mimeType` (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `47 49 46 38`, WebP `RIFF` then `WEBP` at offset 8). The key is not re-hashed (the writer hashes, V32-E1); a key that is not 64 lowercase hex characters is invalid.
- **V32-M3 paint.** `FillPaint` is the type of every fill slot (V-35: of every `Fill.paint`) of rectangles, ellipses, paths, custom nodes, frames and symbols; `Stroke.color` stays `Paint`, so an image stroke is a type error and invalid in parse. `image` names an entry of `images`; `scale` is finite in `[0.01, 100]`, used by `tile` and stored for every mode (default 1).
- **V32-M4 integrity.** The "names an entry" check runs in `parseDocument`, in `Draft.finish` over the touched nodes (so every command, including the existing fill commands, fails with `editor.image-invalid` on a dangling key), and in `validateFragmentTree` against the fragment's own `images`. `Draft.finish` then drops the entries no node of the finished document names (a full scan, only when a touched node of the base or the draft had an image paint). Undo restores whole documents, so it brings dropped entries back. Every document literal built from another (`draft.ts`, `clipboard.ts`) carries `images` when its source has one.
- **V32-M5 scale modes** (unit box `[0, 1]²` of the frame, node size `w × h` in node units, image `iw × ih`): `stretch` maps the image onto the box; `fill` scales uniformly by `max(w/iw, h/ih)` and centres (overflow cropped); `fit` by `min(w/iw, h/ih)` and centres (uncovered area transparent); `tile` repeats the image at `iw · scale × ih · scale` node units from the box's top-left. Rotation and resizing re-evaluate the mode. A node with `w = 0` or `h = 0` projects the image paint as no fill (V32-S4).
- **V32-M6 node edits.** A flip (`resize.ts` `mirrorPaint`) leaves an image paint unchanged: the mode re-fits it, so a flipped image is not mirrored (disclosed; Figma mirrors). A boolean result (`boolean-command.ts` `remapPaint`) keeps `A₀`'s image paint, which re-fits the result's box.

## 3. Scene contract and port

```ts
type SceneImagePaint = Readonly<{
  kind: 'image';
  image: string;               // the document key, resolved through ImageSourcePort
  transform: SceneAffine;      // image space [0, 1]² to node-local space (as SceneGradient.transform)
  wrapX: SceneImageWrap;       // per image axis
  wrapY: SceneImageWrap;
}>;
type SceneImageWrap = 'extend' | 'decal' | 'repeat';
type ScenePaint = SceneColor | SceneGradient | SceneImagePaint;
```

- **V32-S1 discrimination.** `kind: 'image'` with exactly the five fields; `image` 1 to 128 printable ASCII characters; `transform` as E23-S2 (finite, invertible in binary64). `isSceneGradient` narrows to `kind` `'linear'` or `'radial'`; new `isSceneImagePaint` and `isSceneColor`.
- **V32-S2 slots.** Valid as a primitive or path **fill**; in any stroke it is `invalid-value`. A mask source's paint is ignored (E23-K5) and never requested from the port.
- **V32-S3 gate.** The mirror's `paints` option gains `'image'` (gradients and images). Under `'solid'` or `'gradient'` an image paint is `unsupported-feature`.
- **V32-S4 projector.** New editor option `projectImages: boolean` (default false, beside `projectEffects`). With it, V32-M5 maps to `transform` and the per-axis wraps: `stretch` and `fill` use `extend` on both axes (clamp to edge, so the shape's anti-aliased edge samples the edge texels); `fit` uses `extend` on the axis the image spans and `decal` (transparent outside the image) on the letterboxed axis (both `extend` when the aspects match); `tile` uses `repeat` on both. The transform is composed with the unit box as M4-P1 composes gradients. An image paint on a zero-size axis projects as `fill: null`. Without the option, an image fill projects as `fill: null`, and the editor emits `{ code: 'editor.renderer-unsupported', reason: 'unsupported-feature', nodeIds }` for those nodes once per renderer attachment and page (a new emission site, rate as `editor.text-unavailable`), never a scene the mirror rejects. Export always projects with images on.
- **V32-P1 port** (`contracts/src/image.ts`, plain data like the glyph raster port):

```ts
interface ImageSourcePort {
  readonly portVersion: 0;
  readonly operationId: string;
  request(image: string): ImageSourceResult;          // synchronous
  subscribe(listener: (images: readonly string[]) => void): () => void;
}
type ImageSourceResult =
  | Readonly<{ status: 'ready'; width: number; height: number; pixels: Uint8Array }> // RGBA8 straight, rows top first
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'failed'; reason: 'unknown-image' | 'decode-failed' | 'too-large' }>;
```

- **V32-P2 port rules.** A ready result is at most `SCENE_IMAGE_MAX_SIDE = 4096` pixels per side (the port downscales larger images, keeping the aspect) with `pixels.length = 4 · width · height`. Listeners run on a task after the change, never inside `request`, as `TextLayoutPort` (M6a-L3). A key the port evicts may answer `pending` again, and the port notifies when it is ready again. A throw counts as `failed` with `decode-failed`. The renderer service takes the port as option `imageSource`; `paints: 'image'` without it is a construction error. The renderer requests only keys of drawn, non-mask records.

## 4. Rendering

### 4.1 Semantics

- **V32-K1 value.** At pixel centre `p`, `u = G · (p / (zoom · DPR) − (origin − camera))` with `G` the E23 record map built from the paint's `transform`. Per axis, `extend` clamps to the edge texel, `decal` makes the paint transparent when that coordinate is outside `[0, 1]`, and `repeat` wraps; the sampler addressing is clamp-to-edge unless both axes repeat (a mixed pair wraps the repeating coordinate with `u − floor(u)` before the sample). The sample is bilinear within a level and linear between levels (trilinear), premultiplied, encoded sRGB, and replaces the constant colour in every E23-K4 formula (P1 analytic, P3 mesh, ST-U7 joint, clip and layer variants).
- **V32-K2 level of detail.** With `J` the linear part of `G` divided by `zoom · DPR` (image units per pixel, columns `∂u/∂x`, `∂u/∂y`) and the texture `W × H` with `L` levels: `ρ = max(‖(W·J₀₀, H·J₁₀)‖, ‖(W·J₀₁, H·J₁₁)‖)`, `λ = clamp(log2 ρ, 0, L − 1)`, sampled with `textureSampleLevel`, which is legal in the non-uniform control flow of the paint block.
- **V32-K3 pending and failed.** A pending image contributes nothing that frame and is not requested again until the port notifies its key (one request per state change, A05); the service invalidates with reason `scene` when the port notifies. A key refused by the budget is requested again only once its bytes would be admitted. A failed image contributes nothing and raises `render.image-unavailable` (warning) once per key per renderer generation; it is requested again when the port notifies its key. Notices past the backend's per-frame limit are kept for the next frame. The renderer draws no placeholder.

### 4.2 Textures

- **V32-K4 mips.** One `rgba8unorm` texture per resident image with the full WebGPU chain (level `l` is `max(1, ⌊W/2^l⌋) × max(1, ⌊H/2^l⌋)`). Level 0 is `round(c · a / 255)` per colour channel of the 8-bit straight input, alpha copied unchanged; level `l + 1` texel `(x, y)` is the rounded mean of level `l` texels `(min(2x + i, W_l − 1), min(2y + j, H_l − 1))`, `i, j ∈ {0, 1}`, computed in integers from the 8-bit level `l`, rounding half up (so an odd last row or column of level `l` does not reach level `l + 1`, and a level of width or height 1 repeats its texel through the clamp). Built in `renderer-core` (`buildImageMips`, unit-testable in Node), uploaded with `writeTexture`. Mips do not wrap, so minified `repeat` tiles may show a faint seam (disclosed).
- **V32-K5 budget.** Image textures (all levels) count as `texture` resources, at most 256 MiB per renderer. A texture not bound in the current frame is released least recently bound first when an upload would pass the budget; an image that still does not fit is not drawn and raises `render.image-resource-limit` (warning) once per key while it stays refused. One 4096² image with mips is about 85 MiB, so at most three such images draw at once (disclosed). Device loss drops every texture; the next generation requests the drawn keys again.

### 4.3 Realization (V32-Q3 (a))

- **V32-K6 one paint variant.** The E23 paint modules gain the image branch (record kind 2) and three bindings in group 2 (texture, clamp sampler, repeat sampler); their keys become `+paint-v1` and the layout `e23-paint-v1`, and every variant built from them (clip, E25 layer, shifted layer, E39 covers) follows. Base and clip modules, their keys and the E3-recorded `MESH_FILL_SHADER` are unchanged; the gradient arithmetic of `paintValue` is unchanged. If the paint variants fail to build, gradient and image draws fail closed with `render.paint-unavailable`, as in E23.
- **V32-K7 binding.** Group 2 is created per (paint table buffers, texture view) and cached on the table state; a draw binds the group of its image texture (the 1 × 1 transparent texture when it has no image, or its image is pending, failed or refused). An analytic run carries the image key of its primitives' fill (`PrimitiveDraw.image`); a primitive with an image fill closes the run when its key differs from the run's, and a mesh draw's image is its fill record's key. Every encoder path that binds group 2 (main pass, layer and shifted layer passes, E39 covers, the E10 capture) binds per draw; the E10 count pass has no group 2 and is unchanged.
- **V32-K8 record.** An image record uses the E23 record layout: header lanes (2, `wrapX` code, levels, `wrapY` code), the map `G` built exactly as for a gradient, and the bound texture's `W`, `H`, `L` in the first offset lanes. A record with a non-finite binary32 lane contributes nothing (E23-K8).
- **V32-K9 invalidation.** Changing an image paint's mode, scale or key rewrites records and bindings only: 0 fill or stroke port calls, 0 geometry builds.

## 5. Editor

- **V32-E1 asset input.** Commands take `ImageAssetInput = { key, mimeType, width, height, data }`. The host reads `width` and `height` from the file header (PNG IHDR, JPEG SOF, GIF screen descriptor, WebP VP8/VP8L/VP8X, with EXIF orientation for JPEG), never by a full decode, and computes `key` with `crypto.subtle.digest`, so commands stay synchronous. Failures, all with no change: invalid asset (V32-M2) or a key already in the table with different `data` → `editor.image-invalid`; the table over its limit after the command → `editor.image-too-large`.
- **V32-E2 commands** (each one undo step):
  - `insertImages { assets: ImageAssetInput[]; at?: Point; names?: string[] }`: 1 to 32 assets (`names`, if given, has the same length, else `editor.image-invalid`). One rectangle per asset in the active page (or the artboard under `at`, V-25 adoption rules), frame at natural size, the first centred on `at` (default: the view centre), later ones offset by (20, 20); fill `{ kind: 'image', scaleMode: 'fill', scale: 1 }`, no stroke; name the given name (the file name without extension) or "Image". The selection becomes the new rectangles.
  - `setImageFill { ids; asset: ImageAssetInput; scaleMode? }`: on each fill-capable selected node (V32-M3) sets the fill to the image (default mode `fill`); with V-35's `fills`, it replaces the topmost fill's paint, or adds one fill when there is none. Others are skipped; none qualifying is `editor.image-no-target`.
  - `setImagePaint { ids; scaleMode?; scale? }`: changes mode or scale of each node whose (topmost) fill is an image paint.
  - The existing fill commands accept an `ImagePaint` whose key is already in the table (style paste, V-35) and replace an image paint by a colour or gradient; V32-M4 drops the unreferenced entry.
- **V32-E3 clipboard.** The fragment keeps version 2 and gains an optional `images` key (added to `parseFragment`'s allowed key set; any document schema version the fragment allows may carry it) holding the entries that its `nodes` and carried `sourceNodes` name; a fragment without it parses as before. Pasting merges entries: an identical entry under the same key is a no-op; a different one is `editor.image-invalid`; a merge past the limit is `editor.image-too-large`. The `text/plain` clipboard output is unchanged.
- **V32-E4 export.** Both writers use the projection with images on. PNG (Canvas 2D) awaits a decode of each image (`createImageBitmap`, the V32-H1 options); a failed decode leaves that paint out and the export still succeeds. It draws `extend` and `decal` paints with `drawImage` under the shape clip (`decal` clips to the image rectangle too), `repeat` with `createPattern` and `setTransform`. SVG writes `extend`/`decal` paints as `<g clip-path>` (the clip path with the shape's `clip-rule`) holding `<image href="data:…" width="1" height="1" preserveAspectRatio="none" transform="matrix(…)">` (`extend` is approximated as `decal`, which matches inside the shape for `fill` and `stretch`), and `repeat` as a `<pattern patternUnits="userSpaceOnUse" width="1" height="1" patternTransform="matrix(…)">` of that image.

## 6. Hosts and UI

- **V32-H1 image source.** `@vector-studio/react` gains `createImageSource(getDocument)`: an `ImageSourcePort` that decodes `images[key]` on first request with `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'from-image', resizeWidth/resizeHeight })` (downscaled to 4096 per side). Before decoding, the port reads the dimensions from the file header with the E1 parser: above the V32-M1 caps it fails `too-large`, and when they disagree with the asset's declared size it fails `decode-failed`, so a crafted document cannot make it allocate past the cap, reads RGBA through an `OffscreenCanvas`, keeps at most 512 MiB of pixels (least recently requested dropped first) and notifies on a task. `@vector-studio/webgpu-host`'s editor renderer options take it and set `paints: 'image'`; the editor hosts set the projector's `images` option.
- **V32-H2 input.** In the canvas `paste` handler, image files are taken synchronously from `clipboardData.files` when no vector-studio fragment is on the clipboard; then the text paste does not run, and the command runs after hashing. In text edit mode the textarea ignores image files. `dragover`/`drop` accept image files; other files, files over 32 MiB, and files whose header does not parse are skipped with the notice `editor.image-unsupported-file`.
- **V32-H3 UI.** Toolbar "Place image"; Ctrl/Cmd+Shift+K opens the picker from the host's keydown handler (inside the user activation), not through the editor keymap. The fill section's paint type gains "Image" with a thumbnail, "Choose image…", the scale mode select and, for Tile, a scale field (%). `appearance-model.ts` and `appearance-panel.tsx` treat image paints as their own kind (they are not gradients). A layer row whose node's fill is an image shows an image icon.

## 7. Consumers updated with U2 or U3 (as E23-S4 listed them)

`contracts/scene.ts` (guards); `renderer-core`: `scene-validation.ts` (copy, support, equality), `paint-records.ts`, `primitive-scene-source.ts` (records, run tags); `renderer-webgpu`: `paint-pipeline.ts`, `native-primitive-scene.ts`, `layer-pipeline.ts`, `shifted-layer-pipeline.ts`, `frame-capture.ts`; `model`: `types.ts`, `parse.ts`, `serialize.ts`, migration; `editor-core`: `projector.ts` (`composePaint` takes the table), `draft.ts`, `clipboard.ts`, `editor.ts`, `resize.ts` (`mirrorPaint`), `boolean-command.ts` (`remapPaint`), `export.ts`; `react`: `export-image.ts`, `canvas-input.ts`; `ui`: `appearance-model.ts`, `appearance-panel.tsx`, `layer-model.ts`; tests and pages: `tests/support/e23-gradient-oracle.ts`, `tests/support/scene-paint.ts`, `apps/playground/src/scene-paint.ts`, the E23, E25 and E39 variant-key tests.

## 8. Units and acceptance criteria

| Unit | Content | Gate |
| --- | --- | --- |
| U1 | this contract, requirements, track row | independent review READY |
| U2 | model (after the v8 scaffold), scene types and validation, port type, projector, editor commands, clipboard, SVG export | A01 to A04, A07 (SVG), CI |
| U3 | renderer-core mips, residency, records, run tags; renderer-webgpu variants, store, binding; service option; headed fixture page and spec | A05, A06, A09 on the reference PC |
| U4 | react image source, PNG export, paste and drop, webgpu-host options, UI; next-host on | A07 (PNG), A08 headed |
| U5 | evidence record, track row Done | independent evidence review |

- **V32-A01 model.** v7 document migrates without `images`; a v8 document without `images` parses; round trip of three image paints and two assets, and an empty table omitted on serialize; each rejection with its path: bad key, bad alphabet or length, mismatched magic, over 32 MiB, too many pixels, image paint in a stroke, missing entry, `scale` out of range.
- **V32-A02 scene.** S1 and S2 accept and reject cases; `'gradient'` rejects an image paint with `unsupported-feature`; existing solid and gradient validation unchanged.
- **V32-A03 editor.** `insertImages` frame, name, fill, selection, offset, 1 to 32, `names` length; `setImageFill` targets, skips and `editor.image-no-target`; `setImagePaint`; a fill command with a dangling key fails; pruning and undo restoring the entry; same key with different data rejected; table limit measured after pruning; clipboard round trip into a second document including a carried symbol source; a fragment without `images` still pastes.
- **V32-A04 projector.** The four modes give the expected `transform` and `wrap` for a 64 × 32 image in a 100 × 80 frame rotated 30°, including `fit` letterboxing and `tile` at scale 0.5; a zero-width node projects `fill: null`; without the option, `fill: null` and the notice.
- **V32-A05 renderer-core.** `buildImageMips` of a 5 × 3 fixture equals a hand-computed chain (sizes 5×3, 2×1, 1×1); records for the three wraps; residency admit, release order and refusal; the store requests a key once per state change; an image mode, scale or key change costs 0 port calls and 0 geometry builds (K9).
- **V32-A06 headed rendering** (reference PC, Chrome, DPR 1 and 2): a fixture page with a 64 × 32 test image of four flat quadrants as fill of a rectangle (stretch), a rotated ellipse (fill), a path with a hole (fit, evenodd), a frame (tile at 0.5), one under a mask, one at opacity 0.5 and one with a drop shadow. Interior probes, at least 2 texels at the sampled level from any colour change, within 3 per channel of the CPU reference (K1 at the probe point); an edge probe across the stretched rotated rectangle's edge and one across the covered axis of the `fit` path, each within the E23 edge tolerance against a solid fill of the same edge colour; `fit` outside the image transparent; a minified probe of a checker image at zoom 0.25 within 3 of the box-filtered reference; pending then ready draws after the port's notification; a failed key raises one `render.image-unavailable`; device loss and recovery redraw byte-identically.
- **V32-A07 export.** SVG: unit test of the written elements for the three wraps and an evenodd clip. PNG: headed probe of a 2x export at the quadrant centres within 3.
- **V32-A08 editor flow (headed next-host).** Paste from a synthetic clipboard event, drop of two files, Place image through the file chooser, set image fill on an ellipse and change its mode; each draws (probe) and undo removes it; reload after autosave keeps the image.
- **V32-A09 unchanged scenes.** Base and clip modules and keys byte-identical to `main`; the E23 headed specs pass and their gradient probes are unchanged under `paints: 'gradient'` and `'image'`; the variant-key tests change only `paint-v0` to `paint-v1`.
- **V32-A10.** `pnpm check`, `pnpm build` and CI pass on every PR; `requirements.md`, `host-api.md` (port, commands, `projectImages`), the track row, a dated amendment line in the E23 contract (keys, layout and group 2) and the paint sentence of `graphics-engine-architecture.md` (P1 visual behaviour) updated (U1 for the documents, U3 for E23).

## 9. Open choices (recommended option first; 추천안 자동 채택 2026-11-12 unless the user picks otherwise)

- **V32-Q1 representation.** (a) image paint on ordinary nodes (Figma); (b) a new `image` node type. (a) keeps every node feature and composes with multiple fills.
- **V32-Q2 storage.** (a) base64 in the document's `images` table; (b) a host asset store port with keys only in the document. (a) keeps documents self-contained (clipboard, persistence, export); (b) is the remedy if document size hurts.
- **V32-Q3 realization.** (a) one texture per image, bound per draw, in the one paint variant set (K6); (b) a shared atlas; (c) separate image variants beside `+paint-v0`. (a) keeps full resolution and simple eviction; (c) doubles the paint variant set for no pixel difference.
- **V32-Q4 image strokes.** (a) not supported; (b) supported. (a) keeps one texture per draw.
- **V32-Q5 crop mode.** (a) not in v1; (b) Figma's Crop with a stored image transform. Backlog.

## 10. Disclosed limits and backlog

- Documents grow by the base64 size of their images and autosave writes the whole document (Q2 (b) is the remedy). Memory in the worst case: document strings up to about 341 MiB, port cache 512 MiB, textures 256 MiB.
- Textures are at most 4096 per side and the budget holds about three such images; more stay undrawn with a notice.
- Premultiplying and mipmapping run on the main thread when an image first draws: on the order of 100 ms for a 4096² image (a worker is backlog).
- Mirroring does not flip images; minified tiles may show seams; animated images draw their first frame.
- Inside a shape, the letterboxed edge of a `fit` image is a hard, unfiltered edge.
- A texture the renderer released whose pixels the port also evicted draws transparent for a moment when it comes back into view.
- The port's `OffscreenCanvas` readback passes through a premultiplied canvas, so colours of nearly transparent pixels lose precision.
- No colour management: the GPU draws the encoded bytes without ICC profiles, while PNG export through Canvas 2D and SVG viewers may apply them, so exports of images with profiles can differ slightly from the canvas.
- A renderer with `paints: 'gradient'` creates a 1 × 1 texture and two samplers on its first gradient draw, since the shared group 2 layout binds them.
- Backlog: crop mode, image strokes, image adjustments, decoding in a worker, a host asset store, SVG `<image>` import (the SVG import item may call `insertImages`).

## 11. Record

- **U3 scope (2026-11-12).** U3 (#578) brings forward from U2 the scene types and their validation (V32-S1 to S3), the port type (V32-P1) and the two diagnostic codes, since the renderer needs them; A02 is U3's. U2 keeps the model, projector, commands, clipboard and SVG export.
- **Implementation reviews (2026-11-12).** U3: r1 NOT READY (B1 polling, B2 E23 under `paints: 'image'`, F1 to F11), r2 READY WITH FOLLOW-UPS (N1 to N3), applied in `e5491738` and `41dbc9dc`. U2: r1 NOT READY (B1 quadratic paste merge, B2 SVG export repeating the base64 per use), r2 READY WITH FOLLOW-UPS (trusted fragment table, `imageDataBytes` doc), applied before #591. U4: r1 NOT READY (B1 GIF frame past the pixel cap, B2 PNG export decoding at full size unchecked, F1 to F8), applied in `ba677a94`; r2 NOT READY (an XMP APP1 reset the JPEG orientation), applied in `60d1760c`; r3 READY WITH FOLLOW-UPS (non-blocking, listed in the exit record).
- **U2 and U4 (2026-11-12).** Merged together in #591 (`4534b546`) at the coordinator's request. Reference PC headed run on `fb9073ba` (Chrome 157.0.8103.51, Edge 157.0.4341.46): `v32-image-flow` 4/4 (A07 PNG, A08), with the m8-next-host, e41-booleans, v31-lock-hide, v35-next-host and v37-next-host regressions passing.
- **U5 (2026-11-12).** Exit record [docs/evidence/v32/exit-2026-11-12.md](../evidence/v32/exit-2026-11-12.md): A01 to A10 PASS, with the disclosures listed there.

## 12. Review rounds

- **r1 (2026-11-12) NOT READY.** Applied: three wraps so stretched and filled images keep anti-aliased edges (B1); zero-size axis projects `fill: null` (B2); optional `images`, fragment field instead of a version, V-35 fill rules (B3); projector option off-behaviour and export on (B4); consumer list (S1); `FillPaint`, integrity sites, document literals (S2); exact LOD and mip rules, minified probe (S3); one variant set, fail-closed rule, per-draw binding at every encoder path (S4, and observation O1: the spike's single `+paint-v1` set is now the contract, and the E23 gradient arithmetic is kept exact); budget, cost, memory and pixel-cap disclosures, header-only dimensions (S5); decode options and colour disclosure (S6); limits after pruning, paste codes, header-only parse, `sourceNodes` (S7); port timing, eviction and throw rules (S8); paste, text mode, placement and shortcut rules (S9); export details (S10); K9, probe and `names` criteria (S11). O1: implementation started as a spike before this review; it stays uncommitted until the contract is READY.
- **r2 (2026-11-12) READY WITH FOLLOW-UPS.** Applied: per-axis wraps so `fit` keeps the edge on its covered axis, with an edge probe and the letterbox disclosure (F1); the off-option notice as a new emission site named `projectImages` (F2); E23 and architecture amendments named in A10 (F3); header check in the port (F4); count pass, alpha, fragment key set and two disclosures (F5); the spike follows the per-axis wraps before U3 (F6). V32-Q1 to Q5 take option (a), 추천안 자동 채택 2026-11-12.
- **Amendment (2026-11-12, U2a).** V32-M1, M4 and A01: an absent `images` stays absent through parse, `migrateV7toV8` and document literals instead of becoming `{}`, matching the v8 rule that a new optional field defaults when absent and V-39's `colorStyles` and `variables`, so documents without images are unchanged in memory as well as on disk.
- **Amendment (2026-11-12, U2b).** Points the contract left open, as implemented:
  - An image fill below opacity 1 projects as its own leaf whose scene `opacity` is the fill opacity, since `SceneImagePaint` has no alpha; colours and gradients still fold opacity into alpha.
  - A mask source's image fill projects as opaque black, so it is never requested (V32-S2).
  - The `projectImages` off-option notice is raised once per attachment and page.
  - `insertImages` with 0 or more than 32 assets fails `editor.image-invalid` at `/assets`. Later assets are offset cumulatively, so asset i moves by (20·i, 20·i). Without `at`, the view centre is used, and with no view size the command fails `editor.no-viewport-size`.
  - In SVG, a paint repeating on both axes is a `<pattern>`; any other image paint is a `<g clip-path>` holding an `<image>`. Each image's data is written once, as an `<image id>` in `<defs>`; every use is a `<use href xlink:href>` of it (inside the `<g clip-path>`, or inside the `<pattern>`), with the `xmlns:xlink` declaration on the root. Image ids are `i1`, `i2`, … in order of first use. A fragment's `images` holds only entries its nodes name; one nothing names is `document.invalid-field` at `/images/<key>`.
  - The eyedropper reads no colour from an image fill.
- **Amendment (2026-11-12, U4).** Points the contract left open, as implemented:
  - The E1 header parser lives in `@vector-studio/react` (react cannot import the model), with the V32-M1/M2 caps mirrored there.
  - `editor.image-unsupported-file` reaches the host through react's `subscribeImageNotices`, since the editor has no host-raised diagnostics; next-host shows it as text.
  - A place or drop of more than 32 files places the first 32 and names the rest in the notice. A refused `insertImages` raises `editor.image-place-failed` (the refusal code as `reason`). The GIF header size is the screen grown to the first frame; PNG `eXIf` orientation is applied like JPEG's (a bitmap that differs from the header's size fails `decode-failed`). SVG files dropped still import as before.
  - "Place image" is on the studio toolbar. Ctrl/Cmd+Shift+K is handled in the canvas keydown, inside the user activation.
  - PNG export decodes with the V32-H1 options and checks (header, caps, declared size, at most 4096 per side, a few decodes at a time); an image that fails them is left out. A mixed wrap pair uses `repeat-x` or `repeat-y`.
  - "Choose image…" keeps the fill's current scale mode.