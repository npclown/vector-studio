# E23 gradient paint: evidence index (2026-10-29)

Index of E23-A01 to A09 for the [E23 contract](../../plans/d9-e23-gradient-paint-contract.md) (unit U5). E23 is done: every criterion passes, and MVP M4 may consume gradient paint.

The reference-PC run used DESKTOP-DKVUSAV with a GTX 1660 SUPER (driver 610.88), Chrome 156.0.8078.48 and Edge 156.0.4314.50. It ran at commit `e96a034`, the final head of `claude/eng-e23-u4-headed-page`, whose content was merged as #335. Install and build exited 0. The report files stay on the PC; the figures below are copied from the run report.

Other evidence files in this folder:

- [u3-swiftshader.md](u3-swiftshader.md): U3 container readback on SwiftShader, with its script [u3-swiftshader-readback.mjs](u3-swiftshader-readback.mjs).
- [u4-swiftshader.md](u4-swiftshader.md): U4 spec on SwiftShader and the A08 capture procedure.
- [a08-solid-capture.mjs](a08-solid-capture.mjs): the A08 solid-capture script.

## Index

| ID | Status | Evidence |
| --- | --- | --- |
| E23-A01 Validation | PASS | `tests/unit/e23-u1-scene-paint.test.ts`, in CI since #329 |
| E23-A02 Packing | PASS | `tests/unit/e23-u2-paint-records.test.ts` (#331): records, rebase and camera rewrites, the E23-K8 out-of-range cases |
| E23-A03 Interior and edge probes, G1 to G8 | PASS | Headed `tests/gpu/e23-gradient-paint.spec.ts`, Chrome and Edge, DPR 1 and 2 (below). SwiftShader: [u3](u3-swiftshader.md), [u4](u4-swiftshader.md) |
| E23-A04 Premultiplied ramp and hard stop | PASS | Headed spec, DPR 1 and 2 (below) |
| E23-A05 Invalidation | PASS | Unit: `e23-u2-paint-records.test.ts`, `e23-u3-paint-variants.test.ts`. GPU counters: headed spec (below) |
| E23-A06 Batching | PASS | Unit: `e23-u2-paint-records.test.ts`. GPU counters: headed spec (below) |
| E23-A07 Unavailable variants | PASS | `tests/unit/e23-u3-paint-variants.test.ts` with the fake device (#334) |
| E23-A08 Identity | PASS | Hash part: base, clip and mask WGSL SHA-256 pinned in `e23-u3-paint-variants.test.ts`. Captures: byte-identical on the reference PC (below). Full headed `pnpm test:gpu`: 146 of 146 (below) |
| E23-A09 Resources | PASS | Headed spec (below) |

## Headed spec: `tests/gpu/e23-gradient-paint.spec.ts`

12 of 12 tests passed in 52.0 s. That is 6 tests in each of Chrome and Edge: A03 at DPR 1 and 2, A04 at DPR 1 and 2, A05 with A06, and A09. The A04, A05-A06 and A09 report files are byte-identical across the two browsers. The A03 reports differ only in `diagnostics.timestampMs`.

**A03.** The adapter reported nvidia/turing, WASM `58f26517…b4fd35`, 4 samples. There were no page errors and 0 failing probes. Worst difference per fixture, in 1/255, against the 2/255 interior tolerance:

| Fixture | DPR 1 | DPR 2 | Path |
| --- | --- | --- | --- |
| G1 | 0.5500 | 0.5500 | analytic |
| G2 | 0.5368 | 0.5574 | analytic |
| G3 | 1.0767 | 1.1858 | mesh, one `fringe-work-cap` warning |
| G4 | 0.5250 | 0.5375 | analytic |
| G5 | 0.5250 | 0.5375 | analytic |
| G6 | 1.1687 | 1.7548 | mesh, one `fringe-work-cap` warning |
| G7 (18 combinations) | 0.5100 to 0.5615 | 0.5025 to 0.5621 | analytic |
| G8 | 0.5375 | 0.5313 | analytic |

G3's and G6's strokes report the existing `fringe-work-cap` and draw without their fringe. The spec accepts only that diagnostic (U4 record). G6 at DPR 2 is the closest to the limit, with a margin of 0.25/255.

**A04.** At DPR 1 the probe column is 110; at DPR 2 it is 220. Both give the same values:

- The ramp reads (127, 0, 0). That is premultiplied 0.5 red within 2/255, and more than 24/255 from straight-alpha's (0.25, 0.25, 0).
- Below the hard stop the probe reads (255, 0, 0); above it, (0, 0, 255).
- No failures.

**A05 and A06 (GPU counters).**

- Runs: G4 is one paint run of 3. Solid, gradient, solid gives runs of 1, 3 and 1, in paint order.
- A camera-only pan keeps 3 records and builds 0.
- A stop edit keeps 3 records and builds 1.
- On the path fixture: 0 fill port calls, 0 stroke port calls and 0 geometry builds.

**A09.**

- Baseline: 3 buffers, 4,140 B, 1 bind group.
- With gradients: 6 buffers, 5,196 B, 1 bind group.
- After the gradients are removed, and after device-loss recovery: 3 buffers, 4,140 B, 1 bind group.
- `disposedLive` 0.

## A08 solid captures (headed Chrome)

The capture script was run unmodified, with `NODE_PATH` set to the repo's `node_modules`. It captured the existing P4 page's solid frames at `d00af7c` (U1's merge base) and at `e96a034`. The two files `a08-base.json` and `a08-u4.json` are byte-identical: SHA-256 `2664A1C2…FFF55C0A`, and `fc /b` reports no differences. Each holds 12 frames at 512 × 320.

## Full headed suite (E23-A08)

`pnpm test:gpu` at `e96a034`: **146 passed**, 0 failed, 0 skipped, 0 flaky, none interrupted or not run. It took 3.1 h in Chrome and Edge.

- The remote connection dropped at 03:55Z. The run kept going, and its log is continuous.
- The longest files were [chrome] `viz-v4-a08-corpus` at 57.7 min, [edge] `p1-primitives` at 9.3 min, [chrome] `p1-primitives` at 8.7 min and [edge] `p4-clip-mask` at 8.4 min.
- No processes from the job were left running.
