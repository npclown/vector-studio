# E23 U3: software-GPU readback of the paint variants

Contract: [d9-e23-gradient-paint-contract.md](../../plans/d9-e23-gradient-paint-contract.md), section 7, U3 gate (E23-A03 on a software GPU, and the compile check of every variant from section 4, Uniformity). This is the U3 part of the E23 evidence; the headed reference-PC run (A03, A04, A05 GPU part, A08, A09) is U4's, and U5 indexes both.

## Method

- Commit: U3 branch `claude/eng-e23-u3-paint-variants` on top of `e6e1213` (U2).
- Browser: Playwright Chromium at `/opt/pw-browsers/chromium`, headless, flags `--enable-unsafe-webgpu --use-vulkan=swiftshader --use-angle=swiftshader --enable-unsafe-swiftshader --enable-features=Vulkan`. Adapter `{ vendor: google, architecture: swiftshader }`.
- Host page: a draft of U4's `apps/playground/e23-gradient-paint.html`, the P4 headed page with `paints: 'gradient'` and `requiresPaintPipeline` passed through. It lands with U4 and is not part of U3. Geometry kernel WASM SHA-256 `6d4e4780…5e9223`, built with `cargo build --release --target wasm32-unknown-unknown`.
- Script: [u3-swiftshader-readback.mjs](u3-swiftshader-readback.mjs). It renders each fixture at camera `(0, 0)`, zoom 1, DPR 1 and 512 × 320 physical pixels. It then compares interior probes with E23-K1 to K4 evaluated in binary64 over the page's opaque black background. Interior means at least 2 px from shape edges (3 px for G6) and at least 1 px from hard stops and seams. The threshold is 2/255 per channel.
- Run with `SAMPLES=4` and `SAMPLES=1`.

## Results

| Case | Variants exercised | Probes | Max diff (4x) | Max diff (1x) |
| --- | --- | --- | --- | --- |
| G1, G4 (pad, repeat, reflect), G5 (transparent stop, hard stop) | analytic `+paint-v0` | 363 | 0.49/255 | 0.49/255 |
| G2 elliptical radial, three stops | analytic `+paint-v0` | 504 | 0.50/255 | 0.50/255 |
| G8 line stroke and rectangle stroke over solid fill | analytic `+paint-v0`, stroke index | 115 | 0.49/255 | 0.49/255 |
| G3 joint path, opacity 0.5: fill only, stroke only, stroke over fill | mesh joint `+paint-v0` (gradient fill and stroke), mesh fill `+paint-v0` | 13 | 0.50/255 | 0.50/255 |
| G6 (first part): G1 in a 20° rotated container with a rect clip, inside and outside the clip | analytic `+paint-v0+clip-v0` | 9995 | 0.50/255 | 0.50/255 |

- 0 failing probes in either run. The worst difference is 0.50/255, which is 8-bit rounding.
- The scene came up with `paintPipelineAvailable`, so no `render.paint-unavailable` was emitted. All six paint modules were therefore compiled and their pipelines created by SwiftShader's WGSL path: analytic, analytic+clip, mesh fill, mesh joint, mesh fill+clip and mesh joint+clip.
- The mesh clip paint variants were compiled but not probed. U4's G6 covers G3 under the clip.
- Every G5 probe on the transparent ramp reads the premultiplied value `(1 − t, 0, 0)` within 0.5/255, with no green, which is E23-A04's software preview. The exact `t = 0.5` probe is U4's.

## Notes for U4

- G3's stroke at this scale reports `render.path-mesh-failure` with `fringe-work-cap` (drawn without its coverage fringe). This is existing P3 behaviour. U4's edge probes on G3's stroke must take it into account, or place G3 so that the stroke fringe fits the work limit.
- `paintRecordWritesForTesting` counts per-index GPU writes. Record indices are dense per frame (the U2 carry-over), so a pan that culls or reveals a node rewrites the records that moved. "A camera pan writes 0 gradient records" (A05) is measured by the packet's `builds`, or by a pan that culls nothing.
- Adding the page will need the V4 host-injection allowlists in `v3a-path-pipeline` and `v3b-mesh-backend` updated.
