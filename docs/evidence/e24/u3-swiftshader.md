# E24 U3: headed spec and oracle for dashed strokes on a software GPU

Contract: [d9-e24-dash-contract.md](../../plans/d9-e24-dash-contract.md), section 7, U3: a headed run on the reference PC for the A04 GPU part, A05 and A06. This file records the container run of the same spec on SwiftShader and the A06 capture comparison. The reference-PC run is recorded separately when it has run, and U4 indexes both.

## What U3 adds

- **Page.** U3 reuses the E23 headed page (`apps/playground/e23-gradient-paint.html`, `window.__vectorStudioE23`) instead of adding a new one. Its service already hosts the real geometry-wasm fill and stroke ports, with `clips: 'all'` and `paints: 'gradient'`, and since E24 U2 it has `dashes: 'supported'`. The page's `counters()` gains `dashExpansions`, read from the new test hook `PrimitiveRendererService.getDashExpansionCountForTesting()`.
- **Oracle.** `tests/support/e24-dash-oracle.ts` dashes each path independently of `stroke-dash.ts`.
  - Cubics are flattened into pieces no longer than 2^-12 local units. Lines stay exact. Arc length is accumulated along the pieces.
  - The dash intervals follow E24-K1 to K5 from their definitions: odd doubling, phase reduction, closed intervals, zero gaps joined, a restart per subpath, seam joining, and zero-length dashes and subpaths.
  - Dashes are resampled at 1/4 unit for the coverage queries. The stroke of a dash is a band of half-width r along each segment, a disk at each interior vertex, and the cap at each end. Probes are left out within 2 physical px of any band, disk, cap plane or fill edge, and near a miter corner.
  - Composition is E23's: the joint stroke-over-fill source, scaled by node opacity, over black.
- **Spec.** `tests/gpu/e24-stroke-dash.spec.ts` defines fixtures D1 to D9 with the values pinned in section 6. Placements are recorded in the spec. D2's square-cap copy rotates the geometry, not the node, so that the local-axis-aligned squares of E24-K5 differ from SVG's path-aligned squares. It runs these tests:
  - **A05 per DPR:** interior probes at 2/255, and edge probes at 4/255 on D1's butt dash ends, whose pixel centres lie on the end lines. A non-section-6 row, "D6 solid reference", draws D6 with a solid stroke.
  - **D7 per DPR:** dash ends measured at zoom 0.25, 1 and 8. Each end is a half-coverage crossing along its tangent, found by bilinear reads. Zoom 8 uses one camera per end. Ends must agree within 0.5 physical px at the coarsest zoom, and at zoom 8 each end must lie within 0.5 physical px of the oracle's end. Any diagnostic other than a fringe cap fails the test.
  - **A04 GPU part:** port-call, geometry-build and dash-expansion counters. Any diagnostic other than a fringe cap fails the test.
  - **A03 note:** informational only.

## SwiftShader run

Run in the container on Playwright Chromium (Chrome for Testing 153.0.8010.12) with the SwiftShader flags listed in [../e23/u3-swiftshader.md](../e23/u3-swiftshader.md), using a local config that is not committed. The WASM SHA-256 starts with `6d4e47805b66`. Result: 6 of 6 tests passed.

- **A05:**
  - There are 0 failing probes at both DPRs. Every fixture has about 17,000 to 18,200 probes at DPR 1 and about 69,500 to 72,600 at DPR 2.
  - The worst difference is 0.5/255 or less: D1 0.5, D6 0.5, D9 0.475 (DPR 1) and 0.5 (DPR 2). Every other fixture is 0.
  - D1's 33 (DPR 1) and 66 (DPR 2) edge probes pass at 4/255.
  - Content probes are those whose expected colour is not the black background. Probes within 2 physical px of an edge are left out, so thin strokes keep few. Every drawn fixture must have at least one, except D7 at zoom 0.25, whose strokes are narrower than that band and whose ends the D7 test measures. The counts at DPR 1 / DPR 2:
    - D1, D8 and D9: 50 / 550. D2: 70 / 633. D3: 22 / 972. D4 and D7 at zoom 1: 4 / 185. D5: 26 / 403.
    - D6: 2,218 / 0 (O3 at DPR 2). D6 solid reference: 2,131 / 9,253. D7 at zoom 8: 1,412 / 6,177. D7 at zoom 0.25: 0 / 0.
- **D7:**
  - At DPR 1, 46 end comparisons have a worst disagreement of 1.01 local units, against a limit of 2 (0.5 physical px at zoom 0.25).
  - At DPR 2, 46 comparisons have a worst of 0.17, against a limit of 1.
  - Absolute check at zoom 8: each end's crossing lies within 0.5 physical px of the oracle's end (0.0625 local units at DPR 1, 0.03125 at DPR 2). 23 ends are measured at each DPR; the worst offsets are 1.9e-4 and 9.3e-5 local units.
- **A04 GPU part** (D6 with its fill, at zoom 1):

  | Step | Fill calls | Stroke calls | Geometry builds | Dash expansions |
  | --- | --- | --- | --- | --- |
  | Pattern edit | 0 | 1 | 0 | 1 |
  | Phase edit | 0 | 1 | 0 | 1 |
  | Dashed to solid | 0 | 1 | 0 | 0 |
  | Solid to dashed | 0 | 1 | 0 | 1 |
  | Colour edit | 0 | 0 | 0 | 0 |
  | Pan | 0 | 0 | 0 | 0 |
  | Zoom 1 → 8 | 1 | 1 | 0 | 0 |

  The zoom re-requests both paints under the existing tolerance rules and runs no expansion.
- **Diagnostics.** The spec fails on any diagnostic outside this list:
  - `fringe-work-cap` (E24-Q6 (a), O2: region-only):
    - D2's round dots, D6's stroke, D6's solid-reference stroke, and D7's stroke at DPR 1.
    - At DPR 2, also D4's stroke and D6's fill. D6's solid reference shows the same caps (fill and stroke) at DPR 2.
  - `dash-limit`: exactly once, on D8's node A (`failureScope: 'renderer'`, `toleranceExponent: null`, `paint: 'stroke'`). A is not drawn (O1), including its filled subpath, and B draws.
  - `overlay-unsupported` on D6 at DPR 2 (the ST7-Q8 (a) class, not the section 8 work cap):
    - At DPR 2, D6's fill is over the fringe cap and draws region-only. The dash butt ends then put Steiner points on the fill's sloped outer edges, and the ST-U7 overlay builder refuses with `sloped-outer-edge` (ST7-Q8 (a), [p3-b2-stroke-contract.md](../../plans/p3-b2-stroke-contract.md), "Narrower sloped-edge class"). D6 takes E11-U4 O3 and is not drawn. The frame is checked to show exactly that.
    - The builder's `unsupported` reason is not carried into the diagnostic. The attribution comes from review: the builder was run on D6's meshes in a scratch probe that is not committed, and the code path (`path-joint-overlay.ts`, `fail('sloped-outer-edge')` under an outer edge of a region-only fill) fits it. E27 carries the reason into the diagnostic or commits the probe.
    - D6's solid reference draws at both DPRs within 0.5/255, including at DPR 2, where its fill is also region-only.
    - At DPR 1, D6 draws through the joint overlay: the fill shows in the gaps and the stroke covers the fill on the dashes.
    - The spec allows this notice only for D6 at DPR 2. At DPR 1 it is a failure.
    - Decision (2026-10-29, recommended option auto-adopted): disclose it as a known failure of E24 and add backlog item E27 for the overlay builder. It is not fixed in E24.
- **A03 note:** `[1, 1]` on `M 0 0 L 8190 0` with width 2 is exactly 4,096 dashes, the most the renderer requests. The real kernel does not build it: it reports `work-limit` (path scope, tolerance exponent −3), and the path is not drawn (O1). The kernel's E2 work limit is therefore reached at or below the renderer's `dash-limit` on this geometry, as section 8's kernel-work risk anticipated. Both outcomes fail closed with a diagnostic. This note is informational, not a gate.

## A06 capture comparison

- `docs/evidence/e23/a08-solid-capture.mjs` was run unchanged with `SWIFTSHADER=1` against two playgrounds:
  - `2d19b64`, which is `main` at U1's merge base, served from a separate worktree;
  - the U2 merge `b38bb46` plus this unit's working tree.
- The two outputs are byte-identical. Both 12-frame JSON files have SHA-256 `230a28be…284ec9`, and the same geometry WASM served both.
- **Remaining for the reference PC:** the same comparison on the real GPU, the full headed `pnpm test:gpu` suite, and this spec on Chrome and Edge.
