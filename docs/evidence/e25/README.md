# E25 isolated container opacity: evidence index (2026-10-29)

This is the index of E25-A01 to A08 for the [E25 contract](../../plans/d9-e25-isolated-opacity-contract.md), unit U5.

E25 is done: every criterion passes. One hardware observation is disclosed under A05 and A08: on the reference GPU, U3's four-configuration capture script is not byte-identical. A05's criterion limits byte identity to SwiftShader, and A08's evidence column assigns the frame captures to U3 on SwiftShader, with the full `pnpm test:gpu` as its hardware part. The hardware run is reported as an observation, because 4x is nondeterministic on this GPU from run to run. MVP M4 may start its R-O half.

The reference-PC run used DESKTOP-DKVUSAV with a GTX 1660 SUPER (NVIDIA Turing, D3D11), Chrome and Edge, at commit `d9652f4` (#349, U4's merge). U3's capture script (`u3-swiftshader-captures.mjs`) ran at `bbf7d5b` (#354). Install and build exited 0. The report files stay on the PC; the figures below are copied from the run reports.

Other evidence files in this folder:

- [u3-swiftshader.md](u3-swiftshader.md): U3's captures on SwiftShader (A05 and the A08 capture part), with the script [u3-swiftshader-captures.mjs](u3-swiftshader-captures.mjs) and its output [u3-swiftshader-captures.jsonl](u3-swiftshader-captures.jsonl).
- [u4-swiftshader.md](u4-swiftshader.md): U4's spec on SwiftShader.

## Index

| ID | Status | Evidence |
| --- | --- | --- |
| E25-A01 Validation | PASS | `tests/unit/e25-u1-group-opacity.test.ts` (#343); the option wiring in `tests/unit/e25-u3-layer-passes.test.ts` (#346); both in CI |
| E25-A02 Layer plan | PASS | `tests/unit/e25-u2-layer-plan.test.ts` (#344), in CI |
| E25-A03 O1 to O8 | PASS | Headed `tests/gpu/e25-isolated-opacity.spec.ts`, Chrome and Edge, 4x and 1x, DPR 1 and 2 (below). SwiftShader: [u4](u4-swiftshader.md) |
| E25-A04 Invalidation | PASS | Unit: `e25-u2-layer-plan.test.ts`. GPU counters: headed spec (below) |
| E25-A05 Variants and tiles | PASS, with a hardware observation | SwiftShader byte identity, 64 frames, 0 mismatches: [u3](u3-swiftshader.md). Hardware seams against the oracle: headed spec (below). The hardware capture comparison is an observation (below) |
| E25-A06 Resources | PASS | Unit with the fake device: `e25-u3-layer-passes.test.ts`. GPU part: headed spec (below) |
| E25-A07 Budget | PASS | Unit: `e25-u2-layer-plan.test.ts`; notice emission `tests/unit/e25-u4-layer-notices.test.ts` (#349). O9: headed spec (below) |
| E25-A08 Identity | PASS, with a hardware observation | SwiftShader: `flat` and `isolated` byte-identical (24 frames), solid captures byte-identical to `0e12283`: [u3](u3-swiftshader.md). Shader hashes pinned and pipeline keys checked in `tests/unit/e25-u3-layer-passes.test.ts` and `tests/unit/e23-u3-paint-variants.test.ts`; the E10-A1 golden log in `tests/unit/e10-default-invariance.test.ts`; all in CI. Reference PC: solid captures byte-identical, full `pnpm test:gpu` 182 of 182 (below) |

## Headed spec: `tests/gpu/e25-isolated-opacity.spec.ts`

24 of 24 tests passed in 4.2 min in Chrome and Edge, with 0 failed, flaky or skipped. The spec needs `--config playwright.gpu.config.ts`. All 12 report files match between the browsers apart from `timestampMs`, and no report has a failure or a page error. The geometry kernel WASM SHA-256 starts with `58f26517`.

**A03.** Worst difference against the oracle, in 1/255, over interior probes:

| Fixture | Worst at DPR 1 | Worst at DPR 2 | Tolerance |
| --- | --- | --- | --- |
| O1 | 0.5 | 0.5 | 3 |
| O2 | 0.725 | 0.690 | 3 |
| O3 | 1.0 | 1.0 | 5 |
| O4, O5, O6 | 0.5 | 0.5 | 3 |
| O8 (a) and (b) | 0.5 | 0.5 | 3 |

- The worst edge-probe difference (O1 and O8 (b) shape edges, O6 clip edges) was 0.75, against an edge tolerance of 5.
- O1's three named probes differ from the descendant-multiplied oracle by more than 24/255, which the spec asserts (63.75 on SwiftShader).
- The only diagnostics were two `fringe-work-cap` warnings, on O2's joint and dashed strokes, which the spec allows there.

**A04.** Each opacity edit (0.5 to 0.7, 1 to 0.5, 0.5 to 1) cost 0 fill and stroke port calls and 0 geometry builds. The edit from 0 to 0.5 cost what making the same subtree visible costs: 1 fill and 1 stroke call. A pan cost the same with the container at 0.5 as at 1: 1 call of each kind. The spec also asserts the same for a zoom to 1.5; the PC report lists the pan figures only. O3 drew 9 layer passes over 3 frames, 3 per frame.

**A05 seams.** O8 (c) on a 2100 × 1300 surface at DPR 2: worst 0.769 in the seam bands and 0.753 on the grid, against 3. The report counted 3 layer passes for the test.

**A06.** Live accounting after the isolated containers are removed, and after device loss and recovery, equals the baseline. The frame recovered after device loss equals the capture before it. Nothing is live after dispose. Release on resize is covered by U3's unit test with the fake device. Peak live bytes: 7,496,577.

**A07, O9.** Worst difference 0.75. Three `render.layer-resource-limit` notices, as the part table in [u4](u4-swiftshader.md#results) states. Peak accounted bytes: 290,597,677.

**O7.** Opacity 0 draws no layer pass and makes no path port call. Opacity 1 is byte-identical to the children placed at the root.

**Shared edges (section 8), an observation.** At opacity 0.5 the worst difference from the per-pixel model was 0.5. At opacity 1 the layer path and the main pass gave identical pixels (`worstLayerVsMain` 0). So the section 8 risk did not show on hardware either, for axis-aligned edges on pixel centres.

## A08 solid captures (headed Chrome)

`docs/evidence/e23/a08-solid-capture.mjs` ran unchanged on the hardware GPU at `0e12283` (U1's merge base) and at `d9652f4`. The two outputs are byte-identical, with SHA-256 `2664A1C2…5C0A`: the same hash as the E23 and E24 A08 captures.

## U3's capture script on hardware (an observation for A05 and A08)

The script [u3-swiftshader-captures.mjs](u3-swiftshader-captures.mjs) at `bbf7d5b` ran three times on the hardware GPU at `d9652f4`, headed Chrome, without `SWIFTSHADER`. It exits 1 each time, with 15, 14 and 14 of 96 frames differing from `flat`. The run file hashes are `4FDD4706…A85E`, `B929FABB…4238` and `665DC1B5…CC6B`. Every row had no errors. `layerPasses` was 0 for `flat` and `isolated`; for `layer` and `tiled` it was 2 on `leaves` and `wide` and 6 on `clips`, `nested`, `under` and `over`, as on SwiftShader.

- **4x is nondeterministic on this GPU.** All 48 rows at sample count 1 are byte-identical across the three runs. 16 rows at sample count 4 change between runs, including three `flat` rows (`under`, `over` and `wide` at DPR 1).
- **`isolated` against `flat` (A08).** At sample count 1, `isolated` is byte-identical to `flat` in every scene and run, and also at 4x and DPR 2. The differences at 4x and DPR 1 (`nested` up to 1, `over` up to 1, `wide` 2 to 4) appear only in rows whose captures change from run to run: `flat` itself for `over` and `wide`, and `isolated` itself for `nested`, which equals `flat nested` in two of the three runs. With every container at opacity 1, `groups: 'isolated'` builds the same packet and draws no layer. These differences are GPU nondeterminism, not an `isolated` path difference.
- **`layer` and `tiled` against `flat` (A05).** These differences keep their size from run to run, except `layer wide` at 4x and DPR 1 (3 to 4):
  - At sample count 1, five rows differ by 1/255 in every run: `tiled nested` at DPR 1, and `layer nested`, `tiled leaves`, `tiled nested` and `tiled wide` at DPR 2.
  - At 4x, the largest are `wide` through layers: `layer` 3 to 5, `tiled` 6 to 7.
  - A layer pass on this GPU therefore does not reproduce the main pass bit for bit, and tile seams add to it.
  - The criterion on hardware is the seam check against the oracle within the interior tolerance, which passed (0.769 against 3). The A03 fixtures also pass within tolerance.
- `clips` is byte-identical to `flat` in every configuration and run. As on SwiftShader, `under` and `over` are reported but not counted; they differ by at most 1/255.

## Full headed suite (E25-A08)

`pnpm test:gpu` at `d9652f4`: **182 passed**, with 0 failed, 0 skipped, 0 flaky and 0 not run. It took 3.2 h in Chrome and Edge and finished at 13:07Z.

- The longest files: `viz-v4-a08-corpus` took 1.1 h in Edge and 56.3 min in Chrome, `p1-primitives` about 9.5 min in each browser, and `p4-clip-mask` 8.7 min in Chrome.
- No processes from the job were left running.
