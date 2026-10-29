# E25 U4: the headed spec on a software GPU

Contract: [d9-e25-isolated-opacity-contract.md](../../plans/d9-e25-isolated-opacity-contract.md), section 7, U4. This file records the U4 spec run on SwiftShader in the cloud container, before the reference-PC run. The headed run on the reference PC (Chrome and Edge) is the criteria evidence; U5 indexes both.

## Method

- Commit: branch `claude/eng-e25-u4-headed-page` on top of `4d53f7e` (U3).
- Browser: Playwright Chromium (Chrome for Testing 153.0.8010.12) at `/opt/pw-browsers/chromium`, headless, with the SwiftShader flags of [../e23/u3-swiftshader.md](../e23/u3-swiftshader.md). The geometry kernel WASM SHA-256 starts with `6d4e47805b66`.
- Spec: `tests/gpu/e25-isolated-opacity.spec.ts`, run with a local Playwright config that points `testDir` at `tests/gpu` and the base URL at the playground's dev server. The config is not committed; on the reference PC the spec runs under `playwright.gpu.config.ts`.
- Page: the E23 check page with `groups=isolated`, and `isolate=1` for the shared-edge comparison.
- Oracle: `tests/support/e25-layer-oracle.ts`, which composes section 3 over the leaf sources of the E23 and E24 oracles (`elementSource`, `dashElementSource`). The `multiplied` mode is O1's counter-oracle.

## Results

Every test passed: 12 tests in all.

**E25-A03.** O1 to O6 and O8 (a), (b) were run at 4x and 1x, at DPR 1 and 2. Every fixture drew the expected number of layers.

| Fixture | Probes at DPR 1 / 2 | Worst difference | Tolerance |
| --- | --- | --- | --- |
| O1 | 17,538 / 71,120 | 0.50 | 3 |
| O2 | 15,600 / 66,437 | 0.70 | 3 |
| O3 | 16,126 / 68,154 | 1.00 | 5 |
| O4 | 17,421 / 70,844 | 0.50 | 3 |
| O5 | 16,730 / 69,469 | 0.50 | 3 |
| O6 | 16,442 / 68,558 | 0.50 | 3 |
| O8 half off, zoom 0.25 | 18,211 / 72,455 | 0.50 | 3 |
| O8 half off, zoom 8 | 18,083 / 72,207 | 0.50 | 3 |
| O8 odd offset | 17,564 / 71,420 | 0.50 | 3 |

- The 4x and 1x figures are the same.
- O1's three named overlap probes are 63.75/255 from the descendant-multiplied oracle. The margin is 24.
- O6 has 40 edge probes at DPR 1 and 86 at DPR 2. They are pixel centres on the rect clip's left edge, at coverage 0.5. Each is within 0.25 of E25-K2's per-leaf value, against a tolerance of 5. Where the two children overlap, SVG's group-clip model differs from the per-leaf value by up to 32/255.
- O4's layer bound lies within the rotated clip's device bounds. Every O8 bound has an even origin and size.
- Diagnostics: only P3's `fringe-work-cap` on O2's joint and dashed strokes. That code draws the stroke without its fringe, and the interior probes are unaffected.

**O7.**

- Opacity 0: no layer pass, no path port call, and no layers part. The sibling draws (17,993 probes).
- Opacity 1 with the identity transform: no layers part. The frame is byte-identical to the children placed at the root.

**E25-A04.** Each opacity edit was applied as a change set: 0.5 to 0.7, 1 to 0.5, and 0.5 to 1.

- Each edit cost 0 fill port calls, 0 stroke port calls and 0 geometry builds. The packet's layer opacity followed the edit.
- An edit from 0 to 0.5 cost what making the same subtree visible cost: 1 fill call, 1 stroke call and 1 geometry build each.
- Two camera moves (a pan, then a zoom to 1.5) cost the same with the container at 0.5 as at 1.
- O3 drew 9 layer passes over 3 submitted frames, which is 3 per frame.

**E25-A05 on a large surface.** O8 (c) used a 2100 × 1300 CSS surface at DPR 2, at 4x and at 1x.

- The layer bound is 1804 × 1404 at (198, 200), which is 2 × 2 tiles.
- There were 12,586 probes in the 8-px bands across the tile seams, and 90,032 grid probes. The worst difference was 0.74, against a tolerance of 3.

**E25-A06.**

- The texture `created` count rose by the layer textures and the tile set.
- After the isolated containers were removed, live counts and bytes in every category matched the baseline.
- The frame recovered after device loss is byte-identical to the frame before it, and accounting returned to the baseline.
- Nothing is live after dispose.

**E25-A07, O9.** The surface is 3840 × 2160 at 4x. The oracle leaves out the trees the budget drops; there were 2,993 probes per part, and the worst difference was 0.25.

| Part | Scene | Layers drawn | New `render.layer-resource-limit` |
| --- | --- | --- | --- |
| 1 | A (3 levels), leaf, B (2 levels) | b-1, b-0 | `a-0` |
| 1 again | the same | b-1, b-0 | none |
| 2 | A's root at opacity 1 | a-2, a-1 | `b-0` |
| 3 | A alone, 3 levels | none | `a-0` |
| 4 | A alone, root at opacity 1 | a-2, a-1 | none |

- Peak accounted bytes, an observation for section 8: 290,597,677 in all, of which 257,409,025 are textures.

**Shared edges (section 8), an observation.** Three boxes meet on pixel centres at 4x:

- white under the layer, ending at E;
- the layer's red, from E to F;
- green over the layer, starting at F.

The scene was drawn twice, once as analytic rectangles and once as path fills.

- At opacity 0.5, every probe on E and F is within 0.625 of the per-pixel model, where coverages multiply as P1 composes them. The disjoint-samples model, the average of the two sides, is 31.75 away.
- At opacity 1, the layer path (`isolate=1`) and the main pass give identical pixels on both edges.
- On SwiftShader, then, the U3 finding does not show on shared axis-aligned edges. The reference-PC run repeats the measurement on hardware.

## Remaining for the reference PC

- The spec under `playwright.gpu.config.ts` on Chrome and Edge.
- The A08 captures with `u3-swiftshader-captures.mjs` and `docs/evidence/e23/a08-solid-capture.mjs` on the hardware adapter.
- The full `pnpm test:gpu`.
