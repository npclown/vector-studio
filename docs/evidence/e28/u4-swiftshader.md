# E28 U4: the headed text spec on a software GPU (pre-run)

Contract: [d9-e28-text-glyph-atlas-contract.md](../../plans/d9-e28-text-glyph-atlas-contract.md), section 7, U4. This pre-run checks the spec on SwiftShader before the reference-PC run, which is the evidence of record for E28-A03 to A08. U5 indexes both.

## Method

- Commit: branch `claude/eng-e28-u4-headed-text` on top of `cc6083e` (#369, U2 compaction).
- Browser: Playwright Chromium (build 1243) at `/opt/pw-browsers/chromium`, headless, with the SwiftShader flags of [../e23/u3-swiftshader.md](../e23/u3-swiftshader.md). The geometry kernel WASM SHA-256 starts with `6d4e47805b66`.
- Command: `tests/gpu/e28-text-atlas.spec.ts` under a local SwiftShader Playwright config (not committed), with `E28_GENERAL_TOLERANCE=16`. Reports go to `artifacts/e28-text-atlas/<run>/swiftshader/`.
- The fonts the spec names (Arial, Malgun Gothic) are absent on this host, so the canvas port falls back to Liberation Sans and Noto Sans CJK KR. The oracle uses the port's own bitmaps, so this changes the glyphs but not the check.

## Results

All 13 tests pass.

**E28-A03 (T1 to T7).** 14 rows at each of 4x and 1x, DPR 1 and 2. No row has a failure or an undecided pixel.

| Row | Worst difference (/255), 4x DPR 1 | 1x DPR 2 | Tolerance |
| --- | --- | --- | --- |
| T1 runs, T2 phases, T4, T7 emoji | ≤ 0.9 (T2: 0) | ≤ 0.9 (T2: 0) | 2 |
| T5 clip, mask | 0.49 | 0.48 | 2 |
| T5 layer, nested | 0.73, 0.98 | 0.72, 1.06 | 3, 4 |
| T6 zoom 0.25 and 4 (snapped) | 0.88, 0.48 | 0.48, 0.48 | 2 |
| T3 rotated, skewed, mirrored (general) | 10.53, 6.58, 6.85 | 8.33, 6.00, 6.50 | 16 (override) |
| T6 zoom 16 (general) | 4.62 | 1.53 | 16 (override) |

General text exceeds the default tolerance of 3 on SwiftShader. Experiments that quantized the texel offset to 4 and 8 bits did not model the error, so the override is used here only. The reference PC must pass with 3.

**E28-A04.** Colour, opacity, a whole-pixel pan and out-and-back cost 0 raster calls and 0 uploads. A subpixel pan and a zoom each cost 27 calls for 27 new keys. A generation change costs 28 for 28. The path port made no call.

**E28-A05.** One page (4 MiB) and the sampler appear in accounting. A resize costs 0 calls. Removing the last text node returns live texture bytes to the baseline. After device loss, the first recovered frame and the converged frame equal the pre-loss capture. Dispose leaves 0 live resources.

**E28-A06 (T8).** On one 256 px page:

| Step | Frames | Raster calls | Evictions (total) |
| --- | --- | --- | --- |
| A, 60 syllables at 20 px | 1 | 60 | 0 |
| B, 60 others | 2 | 108 | 1 |
| A, generation 2 (compaction) | 2 | 107 | 2 |
| A gen 2, all but one moved by 1/4 px (#369 R2 case) | 2 | 93 | 3 |
| A again after over-limit | 1 | 60 | 5 |

Every step converges to the oracle exactly (worst 0). The over-limit scene raised E28-D2 once, and once more on re-entry. The subpixel move raised none. With the raster budget, 300 syllables took 256 calls in the first frame and 300 in all. 600 clusters at 256 px reached 8 pages and 33,554,432 bytes at peak, the 32 MiB bound.

**E28-A07.** Scenes without text give identical hashes with `text=none` and `text=atlas` at both sample counts and DPRs.

**E28-A08.** Whitespace returns `empty`, thirty `W` at 256 px (wider than 1,024 px) `too-large` and `'serif; color: red'` `unavailable`. Bearing clusters (`j`, a combining acute, `ƒ`, math italic `𝑓`) have no ink on the bitmap border. T1's 28 bitmaps hash identically on two pages. T9: generation 2 never drew generation 1's fake-port pattern.

**M6c hand-off.** `readCluster` returned each of four clusters (`g`, `W`, `한`, `글`) with worst difference 0 and no stray pixel, at DPR 1 and 2, with their E28-K3 placements. Raster cost on SwiftShader: a 256-call frame took 6.8 ms at DPR 1 and 10.6 ms at DPR 2, so it fits a 60 Hz frame here. The reference PC records its own figure.

## Not run

- The reference-PC run (Chrome and Edge, hardware GPU, real fonts, default tolerance). It is queued through the coordinator.
