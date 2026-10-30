# E28 U3: the text pipeline on a software GPU (E28-A07 capture part, text smoke check)

Contract: [d9-e28-text-glyph-atlas-contract.md](../../plans/d9-e28-text-glyph-atlas-contract.md), section 7, U3: the unit part of E28-A05 and E28-A07 on SwiftShader. The headed reference-PC run is U4's, and U5 indexes both.

## Method

- Commit: branch `claude/eng-e28-u3-text-pipeline` on top of `54a7336` (U2, #366).
- Browser: Playwright Chromium (Chrome for Testing 153.0.8010.12) at `/opt/pw-browsers/chromium`, headless, with the SwiftShader flags of [../e23/u3-swiftshader.md](../e23/u3-swiftshader.md). The geometry kernel WASM SHA-256 starts with `6d4e47805b66`.
- Host page: the E23 headed page. U3 adds its `text=atlas` option, which sets the service's `text: 'atlas'` with `createCanvasGlyphRaster()` and forwards `requiresTextPipeline`. The page's `rasterize(request)` returns that same port's bitmap.
- Script: [u3-swiftshader-captures.mjs](u3-swiftshader-captures.mjs), run with `SWIFTSHADER=1`. The camera is at home and the CSS surface is 512 × 320. The script runs at sample counts 4 and 1 and at DPR 1 and 2. Its output rows are in [u3-swiftshader-captures.jsonl](u3-swiftshader-captures.jsonl).
- Parts:
  - **Identity (A07).** Two scenes without text: `leaves` (rectangles with strokes, a mesh path) and `groups` (an isolated container at opacity 0.5 holding a rotated rect-clip container). Each runs with `text=none` and `text=atlas`, under `groups=flat` and `groups=isolated`.
  - **Snapped text.** Seven white clusters on the page's opaque black clear colour: Latin at 16 and 24 px, a Hangul syllable, and the four phases 0, 0.25, 0.5 and 0.75. The fonts are Arial with fallbacks, `sans-serif` and `serif`. The clusters are far apart, so no bitmaps overlap. For each cluster the script places the port's own bitmap by E28-K1 to K3 (half-up rounding, phase, bucket, pen corner `P`) and compares every pixel of its rect with the frame. It also counts lit pixels outside every rect.
  - **Variants.** The same text inside a far rect clip (`+clip-v0`), inside a container drawn as a layer with `isolate=1` (`+layer-v0`), and inside both (`+clip-v0+layer-v0`). Each must be byte-identical to the plain frame.
  - **General text.** The clusters rotated by 30°, drawn by the general path. The check is that ink is drawn and no error or text diagnostic is raised.

## Results

The script reports 44 rows and 0 failures.

**E28-A07, capture part.**

- With `text=none` and `text=atlas`, every scene without text gives byte-identical frames, flat and isolated, at both sample counts and DPRs. That is 12 pairs, 24 frames, with 0 mismatches. No frame has a text part.
- Against `main`, `docs/evidence/e23/a08-solid-capture.mjs` was run unchanged with `SWIFTSHADER=1` on this branch. It renders the P4 page's solid scenes, 12 frames, with `text: 'none'`. Its output has SHA-256 `230a28be…284ec9`, the hash E24 U3 and E25 U3 recorded. So the output is byte-identical to theirs.
- Hash, key and count part: `tests/unit/e28-u3-text-pipeline.test.ts` pins the four text modules and their keys. It checks that `textPipeline` adds exactly one module and one pipeline per variant, and that nothing changes without it. The module hashes pinned by the E23 and E25 tests, and the E10-A1 golden log in `tests/unit/e10-default-invariance.test.ts`, pass unchanged.

**Snapped text.**

- At both sample counts and DPRs, every pixel of every cluster's bitmap rect equals the port's coverage byte (worst difference 0), and no pixel outside the rects is lit (0 stray pixels).
- Each frame drew 7 instances from 1 page, after 7 port calls and 7 uploads.
- At 4x every sample of a pixel receives the pixel's value, so the resolve keeps it exact.

**Variants.**

- `clipped`, `layered` and `both` are byte-identical to `plain` at both sample counts and DPRs.
- Each scene renders three frames. The layer counter rose by 3 for `layered`, which has one layer, and by 6 more for `both`, which has two.
- So all four text pipelines compiled and were created on SwiftShader's WGSL path, and the scene came up with `textPipelineAvailable`. No `render.text-unavailable` was raised.

**General text.** The rotated clusters drew ink in all four configurations, with no error and no text diagnostic. Placement and bilinear sampling against an oracle are U4's (E28-A03, T3).

**Remaining for the reference PC (U4).**

- T1 to T9 against the oracle (A03).
- The GPU counters of A04.
- The resource checks of A05 and A06 under device loss.
- The A07 captures on Chrome and Edge, and the full headed `pnpm test:gpu`.
- A08's browser part.
