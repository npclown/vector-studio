# E23 U4: headed page, GPU spec and oracle on a software GPU

Contract: [d9-e23-gradient-paint-contract.md](../../plans/d9-e23-gradient-paint-contract.md), section 7, U4 (headed run on the reference PC for A03, A04, A05 GPU part, A08 and A09). This file records the container run of the same spec on SwiftShader, and the A08 capture procedure. The reference-PC run is recorded separately when it has run. U5 indexes both.

## What U4 adds

- `apps/playground/e23-gradient-paint.html` and `src/e23-gradient-paint.ts`: the P4 headed page with `paints: 'gradient'` and `requiresPaintPipeline`. It is exposed as `window.__vectorStudioE23`, with `render`, `show`, a camera-only `pan`, `resize`, `recover`, `counters` (including `getPreparationStatistics`), `diagnostics` and `dispose`.
- `tests/support/e23-gradient-oracle.ts`: E23-K1 to K4 in binary64, covering the gradient coordinate, the three spreads, the stop lookup and the premultiplied composition. It includes the joint stroke-over-fill formula. A probe counts as interior when it is at least 2 physical px from every edge and at least 1 px from a hard stop or a repeat or reflect seam. The seam test samples at √2 px, so it covers a diagonal gradient.
- `tests/gpu/e23-gradient-paint.spec.ts` defines fixtures G1 to G8 at DPR 1 and 2 with the values pinned in section 6, and runs these tests:
  - A03 per DPR: interior tolerance 2/255, and edge probes on G1 at 4/255.
  - A04 per DPR: the premultiplied ramp and the hard stop at 24/255.
  - A05 and A06, combined.
  - A09.
- `a08-solid-capture.mjs`: the capture part of A08 (see below).

## SwiftShader run

- Run in the container on Playwright Chromium with the SwiftShader flags listed in [u3-swiftshader.md](u3-swiftshader.md), using a local config that is not committed. Result: 6 of 6 tests passed.
- **A03:** 0 failing probes at both DPRs.
  - The worst difference is 0.50/255 for G1, G2, G4, G5, G7 and G8.
  - G3 reaches 0.66/255 at DPR 1 and 0.80/255 at DPR 2. G6 reaches 0.75/255 and 0.97/255.
  - Each fixture has 16,553 to 18,297 probes at DPR 1, and four times as many at DPR 2.
- **A04:** the ramp is red with no green at both DPRs. Across the hard stop, the probe below reads (255, 0, 0) and the probe above reads (0, 0, 255).
- **A05:**
  - A camera-only pan to (13, −7) builds 0 records.
  - A stop edit on one G4 primitive builds 1 record of 3. The edit is made at the camera the records were built at, because a replaced snapshot re-anchors the primitive origin at `snapOrigin(camera)` on the 256 grid, and every record is origin-relative.
  - On G3 (a path), solid → gradient → solid → gradient followed by a stop edit makes 0 fill port calls, 0 stroke port calls and 0 geometry builds. The first solid build is checked to have called both ports, so the counters are not vacuous.
- **A06:** G4 is one paint run of 3. Solid, gradient, solid gives runs of 1, 3 and 1, in paint order.
- **A09:**
  - The paint tables add 3 buffers, from 3 to 6 live buffers and from 4,140 to 5,196 bytes.
  - Accounting returns to the solid baseline after the gradients are removed, and again after device-loss recovery.
  - The recovered frame is byte-equal to the frame before the loss.
  - After dispose, 0 resources are live.
- **Diagnostics:** the only diagnostic is `render.path-mesh-failure` with `fringe-work-cap`, on the 12-unit stroke of G3 and of G6's G3. This is existing P3 behaviour: that stroke is drawn without its coverage fringe. The spec now fails on any other diagnostic. The 2 px interior margin excludes the unfringed edge. Edge probes therefore stay on G1 (analytic), and edges of mesh draws and stroke paints are not probed. This is a disclosed limitation of U4, not a criterion the contract sets per fixture.

## A08 capture part

- `a08-solid-capture.mjs` renders three solid-only scenes on the P4 page and prints the SHA-256 and the painted-channel count of every frame. The P4 page has not changed since `9ef77b5`, so the same page and scenes run at both commits.
  - P1 covers a rounded rectangle and an ellipse with strokes, plus a rotated rectangle at opacity 0.5.
  - P3 covers a path with a joint stroke at opacity 0.5, and a rotated path.
  - P4 covers a rotated rectangle clip and a mask.
- Each scene is rendered at 4x and 1x, at DPR 1 and DPR 2.
- Procedure:
  1. Serve the playground of `main` at U1's merge base, `d00af7c`, and run the script. Keep the output.
  2. Serve the playground of the U4 head and run the script again.
  3. Compare the two outputs. They must be byte-identical.
- On the reference PC, use `CHANNEL=chrome` (the default) or `msedge`, headed. In the container, `SWIFTSHADER=1` uses the software adapter.
- **SwiftShader result:** the outputs at `d00af7c` and at the U4 head are identical. All 12 frames were compared, and every frame is painted, with 41,246 to 89,299 non-zero channels. The geometry WASM was the same for both.
- **Remaining for the reference PC:** the same comparison on the real GPU, and the full headed `pnpm test:gpu` suite. The hash and key part of A08 is pinned in U3's unit test.
