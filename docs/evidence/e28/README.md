# E28 text glyph atlas: evidence index (2026-10-29)

This is the index of E28-A01 to A08 for the [E28 contract](../../plans/d9-e28-text-glyph-atlas-contract.md), unit U5.

E28 is done: every criterion passes. The unit criteria pass in CI, A07's captures on SwiftShader, and the headed spec and the full `pnpm test:gpu` on the reference PC at the tree of #370, before #378 lowered the budget. The budget of 64 is checked by unit tests and a SwiftShader re-run only. Two decisions came out of the evidence, and both are recorded in the contract:

- **Raster budget.** A frame of 256 distinct raster calls took 19.4 to 27.9 ms on the reference PC, which is longer than a 60 Hz frame. So `E28_RASTER_PER_FRAME` was lowered from 256 to 64 before this index (#378, `b0571f7`).
  - The hardware run used 256. The figure of about 7 ms for 64 calls is extrapolated from it, at 0.11 ms per call.
  - New or regenerated text past the budget is blank until its frame comes. For example, 1,000 visible clusters take 16 frames after a font-load generation bump.
  - U5 did not time a 64-call frame on hardware (the reference PC was unavailable). That timing passes to M9, or to the next reference-PC run of the E28 spec: its raster-cost tests already time one budget-sized frame.
- **Compaction.** U4's T8 spec found a fragmentation lock in the atlas plan. Section 4's compaction rule fixed it before U4 merged (#369).

MVP M6c may project text.

The reference-PC run used DESKTOP-DKVUSAV with a GTX 1660 SUPER (NVIDIA Turing, D3D11), headed Chrome 156 and Edge 156. It ran at `9bbee7f`, whose tree is identical to `ae1d7ab` (#370, U4's merge). The report files stay on the PC; the figures are in [u4-main-pc.md](u4-main-pc.md).

Units: U1 #363 (`2250375`), U2 #366 (`54a7336`), U3 #368 (`8785036`), U2 compaction #369 (`cc6083e`), U4 #370 (`ae1d7ab`), budget #378 (`b0571f7`).

Evidence files in this folder:

- [u3-swiftshader.md](u3-swiftshader.md): U3's text pipeline on SwiftShader, covering the A07 capture part and a snapped-text smoke check. It comes with its script [u3-swiftshader-captures.mjs](u3-swiftshader-captures.mjs) and its output [u3-swiftshader-captures.jsonl](u3-swiftshader-captures.jsonl).
- [u4-swiftshader.md](u4-swiftshader.md): U4's spec on SwiftShader, as a pre-run, including the budget-64 re-run.
- [u4-main-pc.md](u4-main-pc.md): U4's spec and the full `pnpm test:gpu` on the reference PC. This is the evidence of record.

## Index

| ID | Status | Evidence |
| --- | --- | --- |
| E28-A01 Validation | PASS | `tests/unit/e28-u1-text-scene.test.ts` (#363), in CI |
| E28-A02 Planning | PASS | `tests/unit/e28-u2-atlas-plan.test.ts` (#366, #368, #369, #370, #378), in CI. The K9 bound covers negative advances (amended in #370). Compaction is covered by the section 4 tests |
| E28-A03 T1 to T7 | PASS | Headed `tests/gpu/e28-text-atlas.spec.ts`, Chrome and Edge, 4x and 1x, DPR 1 and 2, with the default tolerances. The worst general difference is 1.42/255 against 3, with no undecided probe ([PC](u4-main-pc.md)). T5's clip fixture has clusters crossing the clip edge, compared with the oracle, so ink cut by culling would fail it. T6 zoom 16 asserts that the 24 px runs use the capped 256 bucket, drawn by the general path. SwiftShader (general tolerance 16; the spec refuses that override on hardware): [u4](u4-swiftshader.md) |
| E28-A04 Invalidation | PASS | Unit: `e28-u2-atlas-plan.test.ts`. GPU counters from the headed spec: edits and whole-pixel pans make 0 calls; subpixel pans and zooms make one call per new key; a generation change makes 28 calls for 28 keys; the path port makes 0 calls ([PC](u4-main-pc.md)) |
| E28-A05 Resources | PASS | Unit with the fake device: `tests/unit/e28-u3-text-pipeline.test.ts` (#368). It covers D1 once under injected pipeline and page-allocation failures, pages kept on resize and released with the last text node and on dispose, and the incarnations in the receipt; `e28-u2-atlas-plan.test.ts` covers dropping the entries of a page whose incarnation changed and redrawing them. Headed spec: accounting, resize, removal and dispose; after device loss, recovery equals the pre-loss frame ([PC](u4-main-pc.md)). Page release on device loss is shown through recovery (new incarnations re-rasterize), not by an accounting check. A real out-of-memory surfaces as an uncaptured device-error diagnostic, not as D1 (disclosed in the [contract's section 7, U4 record](../../plans/d9-e28-text-glyph-atlas-contract.md#7-units)) |
| E28-A06 Atlas bound | PASS | Unit: `e28-u2-atlas-plan.test.ts`. Headed spec: the T8 pressure steps converge with worst 0; E28-D2 appears once on entry and once on re-entry; eviction order puts the older generation first; the 32 MiB peak is exactly 33,554,432 bytes on 8 pages ([PC](u4-main-pc.md)) |
| E28-A07 Identity | PASS | SwiftShader: U3's scenes without text are byte-identical with `text=none` and `atlas`, and against `main` the E23 solid-capture script with `text: 'none'` reproduces the hash E24 and E25 recorded ([u3](u3-swiftshader.md)), so `atlas` matches `main` through those two checks. Module hashes, keys, and module and pipeline counts are pinned in `e28-u3-text-pipeline.test.ts`; the E10-A1 golden log is in CI. Reference PC: hashes are identical with `none` and `atlas`, and the full `pnpm test:gpu` passes 210 of 210 ([PC](u4-main-pc.md)) |
| E28-A08 Raster port | PASS | Headed spec: identity, `empty`, `too-large` and `unavailable`; the bearing clusters have no border ink; T1 hashes are equal on two pages; T9's generation rule holds with the fake port ([PC](u4-main-pc.md)). Unit: `e28-u3-text-pipeline.test.ts` (the canvas port: empty, too-large, unavailable, negative left bearing) and `e28-u2-atlas-plan.test.ts` (T9) |

## Observations handed on

- **Raster cost.** On the reference PC, a cold call averages 0.13 to 0.16 ms and a warm call 0.024 to 0.028 ms, at T1's sizes. The budget counts calls, not pixels.
- **M6c hand-off.** The `placements` and `readCluster` hooks returned four clusters with worst difference 0 at DPR 1 and 2. M6c owns the measurement against the DOM.
- **SwiftShader general tolerance.** General text needs `E28_GENERAL_TOLERANCE=16` on SwiftShader, because its bilinear filtering is coarser. The mean signed difference is about 0, so the error is not a placement bias. The spec refuses the override on a hardware adapter.
