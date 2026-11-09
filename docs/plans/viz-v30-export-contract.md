# V-30 export contract: PNG and SVG

Status: DONE 2026-11-09 (#550, `e739809`), Full tier. Visualization-track item [V-30](d9-visualization-track.md#status-index). Requested by the user on 2026-11-09 (the comparison with Figma, Illustrator and Excalidraw listed export as the largest missing feature; item 1 was the default). It moves export (PNG and SVG) out of the deferred list in [requirements](../requirements.md#extension-direction); import stays deferred. Questions V30-Q1 to V30-Q5 (section 7) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

It changes three packages: `editor-core` (two queries and their types), `react` (one function) and `ui` (one panel). It changes no scene contract, renderer, document schema or command.

## 1. What a user can do

- With nothing selected, export the active page: every visible top-level node.
- With a selection, export the selected nodes as one image. Selecting an artboard (a top-level frame) exports the artboard.
- Choose PNG at 0.5x, 1x, 2x, 3x or 4x, or SVG. The file downloads as `<name>.svg` or `<name>@<scale>x.png` (`<name>.png` at 1x), where the name is the one selected node's name, the page's name with no selection, or `export` for several nodes.

## 2. The export scene (`editor-core`)

**V30-S1 query.** `{ type: 'exportScene'; ids?: readonly string[] }` returns an `ExportScene` or null. `ids` omitted means the active page's top-level nodes in paint order.

**V30-S2 roots.** From `ids` the editor keeps the IDs that name a node on the active page, drops nodes with `visible: false` (and nodes that do not project), then drops an ID whose ancestor is still kept, and orders the rest in paint order (document pre-order, back to front). A kept node is drawn as itself: its ancestors' clips, masks and opacity do not apply (as Figma exports a layer). Its transform is its page-space transform (its ancestors' transforms composed with its own). With no root left, or no root that projects (a text node without a layout port, an invalid instance, an unowned custom node), the result is null.

**V30-S3 content.** Each root brings its subtree as the editor projects it to the renderer (`projectPage`): frames as their container, content clip, background and border; instances with their expansion; text as the laid-out clusters; custom nodes through their extension. The export scene holds three node kinds only:

- `container` with `clip` null, `rect` or `mask` (children[0] is the mask source, P4-S2);
- `path` (geometry, fill, path stroke);
- `text` (runs of clusters).

A `primitive` is turned into the `path` the renderer's outline functions give: a rectangle into `rectangleOutline` with its clamped radii and a round-join stroke (a primitive rectangle stroke is round-joined, M4-P3), an ellipse into `ellipseOutline`, a line into a two-point open path with butt caps. Primitive strokes take miter limit 4.

**V30-S4 bounds.** `bounds` is the union of the roots' page-space visual bounds (`visualBounds` mapped through the parent's page transform), rounded outward to whole page units, at least 1 × 1. Content outside it is cut off.

**V30-S5 SVG.** `{ type: 'exportSvg'; ids?: readonly string[] }` returns the SVG 1.1 text of the same scene, or null when `exportScene` is null. `width` and `height` are the bounds' size in px and the `viewBox` is the bounds, so 1 page unit is 1 px. The mapping:

| Scene | SVG |
| --- | --- |
| node transform | `transform="matrix(a b c d e f)"` (same convention) |
| `visible: false`, `opacity: 0` | left out |
| opacity in (0, 1) | `opacity` (isolated, as E25-K1 and the P3 joint draw) |
| rect clip | `clip-path` to a `<rect>` in the container's space |
| mask | `clip-path` to the source's geometry with `clip-rule` = its fill rule (fill area, P4-S2); a text source or a container source covers nothing (the subtree is left out) |
| path | `<path d>` with `fill-rule`, stroke width, cap, join, `stroke-miterlimit`, `stroke-dasharray` and `stroke-dashoffset` |
| solid paint | `#rrggbb` with `fill-opacity` or `stroke-opacity` below 1 |
| gradient | `<linearGradient>` (0,0 to 1,0) or `<radialGradient>` (centre 0,0, r 1), `gradientUnits="userSpaceOnUse"`, `gradientTransform` the paint's transform, `spreadMethod` |
| text | `<text>` per run with `font-family` (the run's font list), `font-size`, `fill`; one `<tspan x y>` per cluster; `xml:space="preserve"`; `xml:lang` |

Numbers are written with at most 4 decimals. Text stays live text: the file names the fonts and a viewer without them substitutes.

## 3. PNG (`react`)

**V30-P1 function.** `exportPng(editor, { ids?, scale? })` returns a `Promise<Blob | null>`: null when `exportScene` is null. `scale` is in (0, 16], default 1; the image is `ceil(width × scale) × ceil(height × scale)` pixels. A scale outside the range, or an image above 16,384 px on a side or 2^27 pixels, rejects with a `RangeError` (the panel shows `Image too large at <scale>x`).

**V30-P2 painter.** The image is painted from the export scene with the browser's Canvas 2D on a transparent background, in the main document, so the fonts the text layout port registered draw as on the canvas. Isolated opacity paints a layer and composites it once; rect clips and masks are `clip()` paths; a gradient paints its shape into a layer and fills the layer `source-in` with the gradient under the paint's transform; `reflect` and `repeat` spreads repeat the stops over the shape's extent (canvas gradients only pad).

## 4. UI (`ui`)

**V30-U1 panel.** `ExportPanel` is a fieldset titled Export: a format choice (PNG, SVG), a scale choice (0.5x to 4x; disabled for SVG) and a button that builds the file and downloads it through an object URL. The button reads `Export page <page name>` with nothing selected, `Export <name>` for one node and `Export <n> layers` for several. It is disabled with nothing selected on an empty page (a cheap check: the panel does not project the page on every change); an export that draws nothing (every target hidden) shows `Nothing to export`, and a failure shows `Export failed: <message>`. next-host's studio layout mounts it at the bottom of the right column; the M8 layout does not. `?test=1&layout=studio` shows the studio with the page's test hook, for the export spec.

## 5. Acceptance criteria

| ID | Criterion | Validation |
| --- | --- | --- |
| V30-A01 | `exportScene` follows S2 (ids filtering, nesting, hidden, order, page transform, null cases) and S3 (only container, path and text; primitives as outlines) | unit `tests/unit/v30-export.test.ts` |
| V30-A02 | Bounds follow S4 for a rotated node, a stroked rectangle, a frame child and a page export | unit |
| V30-A03 | `exportSvg` writes S5's mapping: transforms, opacity, rect clip, mask clip-rule, strokes with dash, solid and gradient paints with spread, text tspans, escaping of `<`, `&` and quotes; the output parses as XML | unit (string checks, an XML parse) |
| V30-A04 | `exportPng` at 1x and 2x gives the S4 pixel size and paints a red rectangle, a gradient, a clipped frame child and text where the scene says (pixel probes) | `tests/v30-export/v30-export.spec.ts`, `pnpm test:v30-export` (headed Chrome and Edge, or the headless smoke project: Canvas 2D needs no WebGPU) |
| V30-A05 | `ExportPanel` names its target, disables the scale for SVG and the button on an empty page, shows `Nothing to export` for hidden targets, and downloads a file with the S1 name | unit (`export-model` names) + `tests/v30-export/v30-export.spec.ts` |
| V30-A06 | New exports carry TSDoc, enter the M8 export lists and `docs/host-api.md` | `m8-u2-react-api`, `m8-u3-ui-api` tests; review |

## 6. Known limits (disclosed)

- The PNG is painted by Canvas 2D, not the WebGPU renderer: anti-aliasing and gradient interpolation may differ from the canvas by a few levels at edges. The scene and fonts are the same.
- SVG gradients interpolate unpremultiplied in most viewers, while the renderer interpolates premultiplied (E23): stops with different alpha shade differently.
- SVG text depends on the viewer's fonts; no outline-text option yet.
- Bounds take a text node's frame (as `visualBounds` does), so lines of a `fixed` text box that overflow its frame are cut off in the export.
- Each isolated-opacity layer and each gradient paint uses a scratch canvas the size of the whole image, so a large export with many gradients or nested translucent groups is memory heavy; a failed allocation shows `Export failed`.
- Effects (drop shadow, layer blur) arrive with schema v7 and are not exported yet. The SVG writer emits per-node `<defs>` (gradients, clips), so the effect filters of the Boolean and effects contract (#547, section 5.7) fit the same place; the Canvas 2D painter would add them as layer filters. A follow-up when effects land.
- Export per artboard in one click (all artboards as separate files), JPEG, PDF and export settings stored in the document are not in V-30.

## 7. Questions (adopted as recommended, 2026-11-09)

- **V30-Q1 PNG rasterizer.** (a) Canvas 2D painter of the export scene. (b) WebGPU renderer render-to-texture and readback. (c) Draw the SVG into an `<img>`. Recommended (a): no renderer or GPU change, and unlike (c) it uses the fonts the page registered.
- **V30-Q2 several selected nodes.** (a) One image of all of them. (b) One file each. Recommended (a), simpler; (b) can come with batch artboard export.
- **V30-Q3 ancestors.** (a) A nested node exports without its ancestors' clip, mask and opacity (Figma). (b) With them. Recommended (a).
- **V30-Q4 SVG text.** (a) Live text. (b) Outlines. Recommended (a); (b) needs glyph outlines the engine does not have.
- **V30-Q5 background.** (a) Transparent; a frame's fill is its own background. (b) The canvas colour. Recommended (a).

## 8. Record

- Implemented and merged 2026-11-09 (#550, `e739809`). Independent review r1 NOT READY (host-api heading list, gradient spread ends, size errors shown as "Nothing to export", hidden-group filter order: fixed; full-image scratch layers and fixed-text overflow: disclosed in section 6), r2 READY WITH FOLLOW-UPS (repeat gradients hold end colours to each cycle boundary: applied).
- V30-A01 to A03, A05 (names) and A06: unit tests and the M8 export-list tests, CI green on the merged head.
- V30-A04 and A05: `pnpm test:v30-export` passed 2/2 headed (Chrome and Edge) on the main PC at `e739809`; `pnpm test:m8-next-host` 36/36 there as the regression check. :4194 relaunched at `e739809`.
- Follow-up: export of effects (E41, schema v7) when they land.
