# M6c-U3: raster-term diagnosis probe (DOM against canvas, no GPU)

**Date: 2026-10-31. Status: probe written and checked in container Chromium 1243 (Linux, headless); main-PC run owed.** A diagnostic, not a gate and not M6c-A06 evidence.

## Why

The main-PC headed M6c-A06 run at `2f0745d` (Chrome 156.0.8078.74, Edge 156.0.4314.50, Windows, GTX 1660S) had the placement term exact everywhere and every DPR 2 project passing. At DPR 1, in both browsers and on reruns, it failed on the raster term only: about −0.3 CSS px vertical on `hangul` 편/기/벡, `hangul-in-latin` `t`, `small-9` 가 and `b`, `wrapped` and `align-right` `i`, and A07's `l`, plus 0.58 horizontal on `mixed-sizes` `x`. At DPR 2 the same clusters were near 0.15 CSS px, the same number of device px. That is a constant offset of about 0.3 device px. One reading is that the browser's DOM text rasterization differs from the 2D-canvas `fillText` that E28's glyph raster port (`createCanvasGlyphRaster`) uses.

## What it does

`diag-raster.mjs` serves its own page (`diag-raster-page.mjs`) with the built packages, the committed test font and `tests/fixtures/m6-text/gpu/text-gpu.v6.json`. It opens the page in each browser at each DPR. No next-host server and no WebGPU are needed.

Per inked cluster of the agreement nodes, it works as follows:

1. **Layout and placement.**
   - The node is laid out with the real text-dom.
   - The cluster is placed by E28-K1 to K3, using renderer-core's `sizeBucket` and `snappedPlacement`.
   - The camera is at the origin, zoom 1, as next-host shows `?fixture=text-gpu`.
2. **DOM side.** The placed DOM cluster is painted as the A06 spec's reference does (`apps/next-host/src/m6c-text-reference.ts`):
   - text-dom's `referenceStyle`;
   - the node's whole run tree, transparent, with only the cluster painted;
   - pen on `P.x + phaseX` and baseline on `P.y`;
   - the composited layer and the baseline layer shift.

   It is screenshotted at device scale. DOM variants:
   - `spec`;
   - `noLayer` (no `will-change`, LCD where the OS uses it);
   - `text-rendering` set to `geometricPrecision`, `optimizeSpeed` or `optimizeLegibility`.
3. **Canvas side.** The cluster is rasterized by:
   - **`port`:** E28's real `createCanvasGlyphRaster`, whatever the checkout's port does;
   - **`mirror`:** a copy of the raster-v1 recipe (black fill, from 2026-10-31), byte-equal to `port` on a checkout with the fix (`sameAsPort`);
   - **`fill-white`:** the v0 recipe (white fill, coverage = alpha), the port before the fix, so the before and after stay visible;
   - one-change variants of the copy:
     - `wrf-false`: `willReadFrequently: false`;
     - `element-canvas`: an HTML canvas instead of `OffscreenCanvas`;
     - `opaque-black-on-white`: black on opaque white, coverage `255 − min(R, G, B)`;
     - `ctx.textRendering` (three values);
     - `ctx.fontKerning` `none` or `normal`.

   Each bitmap is composited black on white at K3's corner, as the atlas draws a snapped cluster: one bitmap pixel per device pixel, value `255 · (1 − coverage)`.
4. **Measure.** Each canvas variant is compared with each DOM variant using the spec's own measures (`tests/m6c-next-host/m6c-agreement.ts`, transpiled at run time): `measureInk`, `rasterTerm` and `maxChroma`. Each pair is judged against section 6.3's bounds (horizontal ≤ 0.5, vertical ±0.25, size ≤ 1 CSS px).

The real GPU path is not run. In snapped mode the atlas copies the port's bitmap one-to-one and blends black by coverage, which the composite reproduces. A mismatch between the composite and the GPU frame is A06's job, not this probe's.

## Output

- A printed table per browser and DPR. It lists every canvas variant against DOM `spec`, and `port` against every DOM variant. Columns: max h, max |v|, max size, max |centroid y|, and failures over clusters compared.
- For each cluster that fails `port|spec`, its vertical term under every canvas variant.
- A JSON file (`--json`, by default `diag-raster-result.json` next to the script). It holds every cluster's terms for every pair, the placement (origin, `P`, `phaseX`, bucket), DOM chroma, placement residuals, the browser version, the user agent, and whether the 2D context has `lang` and `textRendering`.

## Run on the main PC

From the repository root at the commit that adds this file, after `pnpm install --frozen-lockfile` and `pnpm build`:

```
node docs/evidence/m6c-u3/diag-raster.mjs --channels chrome,msedge --dprs 1,2 --json docs/evidence/m6c-u3/diag-raster-result.json
```

It runs headed by default, as A06 does; `--headless` is an option. `--ids` narrows the nodes, for example `--ids hangul,small-9,mixed-sizes`.

## Container check (2026-10-31, not evidence)

Command: `node docs/evidence/m6c-u3/diag-raster.mjs --chromium <playwright chromium> --headless`. Headless Chromium 1243 on Linux, all 12 agreement nodes, 144 inked clusters at DPR 1 and 2. The run took 81 s. Results:

- `mirror` equals `port` byte for byte on every cluster.
- The DOM placement residual is 0 and the DOM chroma is 0.
- `port|spec`, DPR 1: max h 0.071, max |v| 0.071, max size 0.141 CSS px.
- `port|spec`, DPR 2: 0.035, 0.035 and 0.076.
- No `text-rendering` or `fontKerning` setting, canvas kind or `willReadFrequently` value changes the port's result.
- **`fill-black` (black text on the transparent surface, coverage = alpha; now the port's recipe) and `opaque-black-on-white` agree with the DOM exactly (0.000 on every measure) at both DPRs.**

So in this Chromium the whole remaining raster term comes from the port painting white text and reading its alpha. Skia's text coverage depends on the paint colour's luminance (its gamma and contrast pre-blend), so the coverage of white text is not the coverage of the black text the DOM reference paints. Windows uses its own text gamma and contrast, so the same cause could be several times larger there. The main-PC run is meant to confirm or refute that.

**Port fix (2026-10-31, the commit after the probe).** `createCanvasGlyphRaster` now fills black and reads coverage from alpha (operation ID `canvas-2d/raster-v1`), the `fill-black` variant above. On a checkout with the fix, `port` and `mirror` are that recipe and `fill-white` is the old port. The figures above are from the probe's first commit, where `port` was still white.

A design point of the fix: the atlas keeps one coverage per cluster, whatever the run's colour. Coverage from black text matches the browser's paint of dark text (the agreement fixtures are black). It does not match the browser's paint of light text on a dark background, which the M6c fixtures do not test.
