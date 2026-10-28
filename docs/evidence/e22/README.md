# E22 U3 headed evidence (2026-10-28)

Evidence for E22-A5 and E22-A6 of the [E22 contract](../../plans/d9-e22-clip-follow-ups-contract.md). Reference PC DESKTOP-DKVUSAV: Node v24.22.1, NVIDIA (Turing) adapter, release WASM SHA-256 `58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35`. The report files stay on the PC under `artifacts/p4-clip-mask/`; the fields below are copied from them.

## E22-A6: full headed suite

`pnpm test:gpu` at `f27919b` (Chrome 156.0.8078.48, Edge 156.0.4314.50): **134 passed, 0 failed** (3.0 h). `pnpm test:geometry`: 71 files, 1,199 tests passed, 6 skipped. The P4 spec ran unchanged apart from the new E22 test.

## E22-A5: 3840 × 2160 at 4x, DPR 2

Test `E22 U3 tiled mask passes at 3840 x 2160 (E22-A5), 4x, DPR 2` in `tests/gpu/p4-clip-mask.spec.ts`. The surface is 1920 × 1080 units at DPR 2; tile seams fall every 1024 device pixels from each level's own device origin. Every pixel of the frame (minus a 2 px border) is compared with the oracle at 2/255 (the interior tolerance). That is stricter than A5 asks (seam lines at 2/255, other edge-ramp pixels at the P4-A03 4/255) and is kept on purpose: it passed with a margin of 1.

| Browser (spec at)               | Surface                | Case                              | Status  | Mask levels | Interior probes, max | Edge probes, max (tol.) | Failures |
| ------------------------------- | ---------------------- | --------------------------------- | ------- | ----------- | -------------------- | ----------------------- | -------- |
| Chrome 156.0.8078.48 (`09e13bd`) | 3840 × 2160, 4 samples | `e22-full-screen-mask`            | applied | 1           | 8,257,000, 0         | 8,270,416, 1 (2)        | 0        |
| Chrome 156.0.8078.48 (`09e13bd`) | 3840 × 2160, 4 samples | `e22-nested-mesh-mask-over-seams` | applied | 2           | 8,266,934, 0         | 8,270,416, 1 (2)        | 0        |
| Edge 156.0.4314.50 (`2c5f218`)   | 3840 × 2160, 4 samples | `e22-full-screen-mask`            | applied | 1           | 8,257,000, 0         | 8,270,416, 1 (2)        | 0        |
| Edge 156.0.4314.50 (`2c5f218`)   | 3840 × 2160, 4 samples | `e22-nested-mesh-mask-over-seams` | applied | 2           | 8,266,934, 0         | 8,270,416, 1 (2)        | 0        |

No diagnostics in either case (no `render.clip-resource-limit`), 3 reference renders, grey check max deviation 0. Reports: Chrome `artifacts/p4-clip-mask/2026-10-28T12-11-50-880Z-11024/chrome/e22-uhd-4x-dpr2/report.json`, Edge `artifacts/p4-clip-mask/2026-10-28T14-03-37-196Z-3516/edge/e22-uhd-4x-dpr2/report.json` (Edge ran alone, 1 test, 6.7 min). `2c5f218` differs from `09e13bd` only in a spec comment.

Superseded runs at `f27919b` (before review r1 moved the mesh source to the nested level and added the every-pixel check): Chrome and Edge both PASS, interior max 0, edge max 1 at 4/255.

SwiftShader (container, Chrome for Testing 153.0.8010.12, headless) at `09e13bd`: PASS, same probe counts, nested case max deviation 0.54.
