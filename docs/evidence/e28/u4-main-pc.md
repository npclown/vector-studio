# E28 U4: the headed text spec on the reference PC

Contract: [d9-e28-text-glyph-atlas-contract.md](../../plans/d9-e28-text-glyph-atlas-contract.md), section 7, U4. This is the evidence of record for E28-A03 to A08 (GPU parts) and the raster-cost observation. The SwiftShader pre-run is [u4-swiftshader.md](u4-swiftshader.md).

## Method

- Run on the main PC (DESKTOP-DKVUSAV) on 2026-10-29, 03:12 to 06:56 KST.
- Commit: 9bbee7f (detached), whose tree is identical to main at ae1d7ab (#370). `pnpm install` and `pnpm build` exit 0.
- `pnpm test:geometry`: Vitest 1,216 passed and 6 skipped; Rust 526 passed, 0 failed, 69 ignored. The WASM SHA-256 starts with `58f26517`.
- Full `pnpm test:gpu`, headed:
  - Browsers: Chrome 156.0.8078.48 and Edge 156.0.4314.50.
  - GPU: ANGLE D3D11 on an NVIDIA GTX 1660 SUPER, driver 610.88 (adapter `nvidia/turing`).
  - No `E28_GENERAL_TOLERANCE`, `SWIFTSHADER` or Chromium override was set.
- The 28 E28 `report.json` files were moved out of the repo after hashing. The PC report is in the project files (`rendering/e28-u4-main-pc-2026-10-29.md`).

## Results

`pnpm test:gpu` passed 210 tests, with 0 failed, flaky, skipped or not run. All 14 E28 tests pass in both browsers. Ten report pairs are byte-identical between Chrome and Edge: the four A03 reports, A04, A07, A08, T8 eviction order and T9.

**E28-A03.**
- Every row passes with the default tolerances, and there are no undecided probes anywhere.
- The general tolerance is 3. The worst general difference is 1.42/255, for T3 rotated at DPR 2.

| Row | Worst (/255), DPR 1 | DPR 2 | Tolerance |
| --- | --- | --- | --- |
| T1 | 0.49 | 0.52 | 2 |
| T2 | 0 | 0 | 2 |
| T3 rotated, skewed, mirrored (general) | 1.29, 1.03, 1.05 | 1.42, 1.39, 1.00 | 3 |
| T4 | 0.80 | 0.90 | 2 |
| T5 clip, mask | 0.48, 0.49 | 0.52, 0.52 | 2 |
| T5 layer, nested | 0.72, 0.96 | 0.76, 0.98 | 3, 4 |
| T6 zoom 0.25, 4 | 1.11, 0.52 | 0.52, 0.52 | 2 |
| T6 zoom 16 (general rows) | 1.05 | 1.09 | 3 |
| T7 | 0.52 | 0.52 | 2 |

**E28-A04.**
- The base frame makes 28 calls.
- A colour edit, an opacity edit, a whole-pixel pan and moving out of view and back make 0 calls.
- A subpixel pan and a zoom each make 27 calls and 27 uploads, for 27 new keys.
- A generation change makes 28 calls.
- The path port makes no call.

**E28-A05.**
- One page appears in accounting: textures go from 3 to 4, and live bytes from 3,276,801 to 7,471,105.
- A resize makes 0 calls.
- After the text is removed, live textures return to 3.
- After device loss, the first recovered frame is equal (generation 2).
- Dispose leaves nothing live.
- Diagnostics: device loss (intended), recovery and disposal.

**E28-A06.**
- T8 converged to the oracle at every step, with a worst difference of 0. Calls and evictions per step:

  | Step | Calls | Evictions |
  | --- | --- | --- |
  | A | 60 | 0 |
  | B | 99 | 1 |
  | A gen 2 | 103 | 2 |
  | A gen 2 shifted | 103 | 3 |
  | A again | 63 | 5 |

- E28-D2 was raised once on entering the over-limit state.
- Budget test: 256 calls in the first frame, 300 in all.
- 600 clusters at 256 px peaked at 8 pages and 33,554,432 bytes.
- Eviction order: the older-generation page was evicted first.

**E28-A07.** Scenes without text give identical hashes with `text=none` and `text=atlas` at 4x and 1x, DPR 1 and 2. The headed part of the criterion is the full `pnpm test:gpu` pass above.

**E28-A08.**
- `empty`, `too-large` and `unavailable` behave as specified.
- Bearings (left/width): `j` 6/18, U+0301 12/15, `ƒ` 3/29, `𝑓` 3/32. No bitmap has ink on its border.
- T1's 28 bitmaps hash identically on two pages.
- T9: generation 2 never drew a generation 1 bitmap (9 calls each, worst 0.24).

**M6c hand-off.** Four clusters at DPR 1 and 2 have worst difference 0 and no stray pixel. Their placements are in the reports.

**Raster cost (observation).**

| Browser | Cold call, mean (ms) | Warm call, mean (ms) | 256 distinct calls, DPR 1 / DPR 2 (ms) |
| --- | --- | --- | --- |
| Chrome 156 | 0.13 to 0.16 | 0.024 to 0.028 | 24.0 / 27.9 |
| Edge 156 | 0.13 to 0.16 | 0.024 to 0.028 | 19.4 / 25.6 |

A 256-call frame does not fit a 60 Hz frame (16.7 ms) in any configuration. As section 6 provides, E28-Q6's figure is lowered to 64 (section 4, Raster budget, U4 amendment). The worst measured rate is 27.9 / 256 ≈ 0.11 ms per call, so a 64-call frame is about 7 ms. That figure is extrapolated: this run used 256.

## Not run

- The lowered budget of 64 on hardware. The unit tests and a SwiftShader re-run check it: 14 of 14 E28 tests pass, and a 64-call frame took 7.8 and 5.0 ms there.
