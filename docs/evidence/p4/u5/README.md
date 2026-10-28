# P4 U5 headed evidence (reference PC)

- Commit: `9ef77b5` (`feat(eng-e21): P4 U5 headed clip and mask page and GPU spec (#290)`), recorded as `source.baseCommit` in every report.
- Date: 2026-10-28 (run directories `2026-10-28T02-20-07-772Z-17204` for Chrome, `2026-10-28T02-22-11-062Z-23852` for Edge, UTC).
- Machine: reference PC DESKTOP-DKVUSAV, Windows 11 Pro 10.0.26200, Node 24.22.1.
- Browsers: Chrome 156.0.8078.48, Edge 156.0.4314.42 (the `browser` field of each report).
- GPU adapter (`ready.adapter`): `{"architecture":"turing","description":"","vendor":"nvidia"}` in both browsers.
- Geometry kernel WASM: rebuilt with `pnpm test:geometry` before the run (1199 passed, 6 skipped). Independent-build SHA-256 `58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35`.
- Command: `$env:P4_CLIP_MASK_OUTPUT_DIR='artifacts/p4-clip-mask'; pnpm exec playwright test --config playwright.gpu.config.ts tests/gpu/p4-clip-mask.spec.ts`. Result: `16 passed (4.2m)`.

## Results

| Test                                                                       | Directory          | Chrome | Edge |
| -------------------------------------------------------------------------- | ------------------ | ------ | ---- |
| P4 U5 images (P4-A02 to A05, A10), 1x, DPR 1                               | `images-1x-dpr1`   | PASS   | PASS |
| P4 U5 images (P4-A02 to A05, A10), 4x, DPR 1                               | `images-4x-dpr1`   | PASS   | PASS |
| P4 U5 images (P4-A02 to A05, A10), 1x, DPR 2                               | `images-1x-dpr2`   | PASS   | PASS |
| P4 U5 images (P4-A02 to A05, A10), 4x, DPR 2                               | `images-4x-dpr2`   | PASS   | PASS |
| P4 U5 invalidation, culling, batching and resources (P4-A06 to A08), 4x, DPR 1 | `counters-4x-dpr1` | PASS   | PASS |
| P4 U5 mask texture budget (P4-A08), 1x                                     | `budget-1x`        | PASS   | PASS |
| P4 U5 frame-time observation (P4-A11), 1x                                  | `observation-1x`   | PASS   | PASS |
| P4 U5 frame-time observation (P4-A11), 4x                                  | `observation-4x`   | PASS   | PASS |

Every `report.json` has `failures: []`. No failure messages were produced. The P4-A11 observation files are functional observations only, with no performance claim or threshold.

## Figures (from the reports, identical in both browsers)

- Interior probes: 2,303,862 per browser, max deviation 0.5/255 (tolerance 2/255).
- Edge probes: 183,998 per browser, max deviation 3/255 (tolerance 4/255); depth 32 max 1/255.
- P1 rectangle observation (`p1Rectangle`, not gated): max 1.1/255 against the rendered P1 rectangle of each rect level, so on this hardware the clip edges also match P1 as P4-K1 originally worded.
- Depth 33 rejected with `unsupported-feature` in every configuration; the previous frame stays byte-identical.
- A06: rect-clip edit, translate and rotate cost 0 port calls, 1 clip-state write and 0 mask passes; a mask source edit costs 1 port call and 1 mask pass; a camera pan costs 1 mask pass; scale costs the same port calls with and without the clip.
- A08: device-loss recovered frame byte-identical; 5 of 20 full-surface masks report `render.clip-resource-limit` (a paint-order suffix) with 62,914,560 resident mask bytes.
- A11 (observation, no claim): 10,000 nodes, 20 masks, 100 panned frames; median encode and submit 66 to 69 ms, median frame interval 66.7 ms, 1,935 mask passes.

## P4-A09 identity: full headed `pnpm test:gpu`

Same machine, commit and kernel, 2026-10-28: `132 passed (2.8h)`. Chrome 66 passed, Edge 66 passed, 0 failed, 0 flaky, 0 skipped. The suite's artifacts are not committed.
