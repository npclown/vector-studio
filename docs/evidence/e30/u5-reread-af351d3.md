# E30-U5 main-PC re-read at `af351d3` (2026-11-04)

Unit U5 of the [E30 contract](../../plans/d9-e30-renderer-cost-contract.md#43-conditional-levers-u5-decided-by-u2s-split): the PC re-read after L3a (#492) and L3b (#493), which reads their effect on `vs-submit` and the GPU queue proxy, and the SwiftShader `test:gpu` that both PRs owed. It is a diagnostic split-on sitting like the [re-read at `0846555`](u5-reread-0846555.md), in the same configuration; it decides no pre-alpha row (PA-U9 does) and is not E30's verdict run (U6, with `E26_SPLIT=0`).

## Sitting

- **Head.** `af351d3` (main, L3b merged). Every record has that commit and `dirty: false`. Prep: `pnpm install --frozen-lockfile`, `pnpm test:geometry` (cargo 526 passed, 69 ignored; vitest 1,217 passed, 6 skipped), `pnpm build`, all passing ([`prep-*.log`](u5-reread-af351d3/)).
- **Machine.** DESKTOP-DKVUSAV: GTX 1660 SUPER (driver 32.0.16.1088), one 1920 × 1080 display at 60 Hz, Balanced power plan, Chrome 156.0.8078.81 (156.0.8078.80 at `0846555`), Edge 156.0.4314.58, Node 24.22.1 ([`sitting.txt`](u5-reread-af351d3/sitting.txt)). A user Chrome session was open from before the sitting to its end; one unrelated Codex node runtime ran throughout. The display mode and power plan were recorded this time, and the 60 Hz display still gives a longer rAF interval: `idleRafMedianMs` is 17.7 to 18 ms in 146 of the 156 records that carry it and 16.7 ms in 10, and the stress rows' rAF callback interval medians are 16.7 to 17.2 ms, so frame p95s step by about 18.1 ms here, as at `0846555`. Why the browser's frame interval is longer than the display's is not explained.
- **E26, split on**, 04:05:23 to 05:24:11 UTC: the same command and environment as at `0846555` (`E26_REPETITIONS=3`, `M8_N3_BASELINE` set, the four `*-v2` projects). 159 passed, 1 failed, 84 skipped. The failure is the v1 control `e26-ui0-pointer-busy-10k/v1` r3 on `chrome-dpr1-v2`: its font load ended in `error` (console: `net::ERR_NO_BUFFER_SPACE`). Its record and error context are in [`attempt1/`](u5-reread-af351d3/attempt1/); one retry after `test:gpu` (05:53:00 to 05:53:23) passed and its record is in `runs/`. No v2 row failed.
- **`pnpm test:gpu`** (SwiftShader), 05:24:11 to 05:52:34: 93 tests, 93 passed ([`test-gpu.log`](u5-reread-af351d3/test-gpu.log)). This is the run #492 and #493 owed.
- **Files.** [`u5-reread-af351d3/`](u5-reread-af351d3/) holds `runs/` (160 records, `runs-files.txt`), `summary.json`, `summary.md`, the sitting, retry and `test:gpu` console logs, the prep logs, `times.txt` and `sitting.txt`. `node tooling/e26-summarize.mjs <dir>/runs --json <dir>/summary.json --markdown <dir>/summary.md` reproduces the summaries.

## The frame split at F, against `0846555`

Median of run medians and maximum of run p95s; the `0846555` values in parentheses are the same statistics from its re-read. Its committed record keeps only the summary text (its raw records were not kept), so the frame `maxPerRunP95Ms`, gpu and encode baselines here are from that sitting's `summary.md` as the operator reported it at the time; they are not reproducible from the repository.

| Scenario | Project | prepare median | submit median | submit p95 | gpu median | gpu p95 | `encodeAndSubmitMs` p95 per run | frame `maxPerRunP95Ms` | long tasks > 50 ms per run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mixed-view-edit/v2` | chrome-dpr1-v2 | 2.3 (2.4) | 1.1 (4.0) | 1.7 (5.7) | 20.6 (41.8) | 45.0 | 4.6, 4.6, 4.4 (8.6–9.0) | 18.2 (35.6) | 0, 0, 0 |
| `mixed-view-edit/v2` | chrome-dpr2-v2 | 2.3 (2.4) | 1.1 (3.9) | 1.7 (5.3) | 20.8 (41.6) | 43.0 | 4.6, 4.8, 4.6 (8.5–8.8) | 18.1 (35.6) | 1, 0, 0 |
| `mixed-view-edit/v2` | edge-dpr1-v2 | 2.3 (2.4) | 1.2 (4.0) | 1.6 (5.6) | 20.6 (41.2) | 38.9 | 4.5, 4.5, 4.4 (8.4–8.7) | 18.1 (35.5) | 0, 0, 0 |
| `mixed-view-edit/v2` | edge-dpr2-v2 | 2.4 (2.4) | 1.2 (4.0) | 1.6 (5.2) | 20.5 (41.0) | 41.6 | 4.6, 4.9, 4.6 (8.1–8.5) | 18.1 (35.9) | 0, 0, 0 |
| `mixed-all-edit/v2` | chrome-dpr1-v2 | 9.5 (9.5) | 6.1 (33.6) | 10.3 (39.4) | 223.6 (118.6) | 262.7 | 22.7, 22.0, 21.2 (50.1–51.7) | 52.9 (72.0) | 1, 1, 1 |
| `mixed-all-edit/v2` | chrome-dpr2-v2 | 9.6 (9.8) | 6.1 (33.9) | 9.5 (39.9) | 251.3 (119.5) | 258.5 | 20.3, 21.4, 20.1 (49.6–52.8) | 53.5 (72.1) | 0, 0, 0 |
| `mixed-all-edit/v2` | edge-dpr1-v2 | 9.8 (9.5) | 6.2 (33.9) | 10.6 (49.8) | 223.7 (119.0) | 270.6 | 22.9, 22.5, 24.4 (54.9–63.0) | 53.1 (88.0) | 2, 1, 0 |
| `mixed-all-edit/v2` | edge-dpr2-v2 | 9.9 (9.7) | 6.2 (33.9) | 9.6 (50.6) | 251.4 (117.6) | 289.2 | 20.7, 22.3, 21.9 (49.5–62.5) | 53.6 (89.1) | 0, 0, 0 |
| `mixed-all-pan/v2` | chrome-dpr1-v2 | 19.3 (19.1) | 20.0 (35.0) | 23.6 (46.0) | 288.3 (172.0) | 321.2 | 47.5, 47.2, 54.5 (69.2–72.8) | 70.8 (72.1) | 8, 9, 11 |
| `mixed-all-pan/v2` | chrome-dpr2-v2 | 24.7 (23.7) | 20.2 (34.9) | 26.9 (44.3) | 289.3 (190.8) | 356.9 | 63.8, 69.8, 65.5 (78.4–82.8) | 72.3 (72.9) | 28, 34, 35 |
| `mixed-all-pan/v2` | edge-dpr1-v2 | 19.4 (19.8) | 20.3 (36.8) | 25.8 (45.4) | 269.2 (179.8) | 317.8 | 47.2, 53.2, 54.0 (68.3–73.6) | 71.3 (72.6) | 9, 11, 14 |
| `mixed-all-pan/v2` | edge-dpr2-v2 | 25.4 (24.3) | 20.9 (38.4) | 24.9 (49.1) | 282.0 (201.8) | 359.0 | 59.8, 65.6, 68.3 (81.9–87.0) | 72.1 (90.0) | 32, 39, 31 |
| `simple-stress/v2` | chrome-dpr1-v2 | 2.6 (2.7) | 0.6 (0.6) | 0.7 (0.8) | 6.0 (3.7) | 7.0 | 3.4, 3.3, 3.6 (3.7–3.9) | 18.1 (18.1) | 0, 0, 0 |
| `simple-stress/v2` | chrome-dpr2-v2 | 2.5 (2.6) | 0.6 (0.6) | 0.9 (0.8) | 6.2 (6.4) | 8.7 | 3.4, 5.0, 3.4 (3.6–3.8) | 18.1 (18.1) | 0, 0, 0 |
| `simple-stress/v2` | edge-dpr1-v2 | 2.8 (2.7) | 0.6 (0.6) | 0.7 (0.8) | 5.8 (4.0) | 6.9 | 3.7, 3.6, 3.5 (3.8–4.1) | 18.1 (18.1) | 0, 0, 0 |
| `simple-stress/v2` | edge-dpr2-v2 | 2.7 (2.8) | 0.6 (0.6) | 0.7 (0.8) | 6.1 (6.6) | 8.6 | 3.5, 3.6, 3.5 (3.8–4.3) | 18.1 (18.1) | 0, 0, 0 |

- **Submit fell** where clipped draws are many: by a factor of about 3.5 in the typical view (4.0 to 1.1 to 1.2 ms in the median, p95 5.2 to 5.7 to 1.6 to 1.7) and about 5.5 in all-visible edit (about 34 to 6.1 to 6.2 ms), and by about 1.8 in pan (35 to 38 to 20 to 21 ms). Prepare is unchanged, as L3a and L3b do not touch it. Stress, with no clip states, is unchanged.
- **The typical view now presents in one refresh:** frame `maxPerRunP95Ms` 18.1 to 18.2 ms in every run (35.5 to 35.9 at `0846555`), at this sitting's rAF interval (above); `encodeAndSubmitMs` p95 4.4 to 4.9 ms; no long task in 11 of 12 runs. The E26 row's target (≤ 16.7 ms) is below this PC's rAF interval in this sitting, so the summary still marks it a miss; the stress rows, which also present every frame, show the same 18.1 ms.
- **All-visible edit:** frame p95 52.7 to 53.6 ms (72 to 89), encode p95 20 to 24 ms (50 to 63), long tasks 0 to 2 per run (144 to 173).
- **All-visible pan:** frame p95 70.4 to 72.3 ms in all but one run (54.4 ms), encode p95 47 to 70 ms (68 to 87), long tasks 8 to 39 per run (123 to 157). Prepare (19 to 25 ms in the median) and submit (20 to 21 ms) are now about equal.
- **The GPU queue proxy rose in the all-visible rows** (edit 118 to 120 to 224 to 251 ms in the median, pan 172 to 202 to 269 to 289 ms) and halved in the typical view (41 to 42 to about 20.6 ms). `vs-gpu` runs from a frame's submit end to its `onSubmittedWorkDone()` and holds the earlier frames' queued work: with the main thread submitting each all-visible frame in less time, more frames can be queued ahead of each sample, so the proxy grows while the frame time falls. We read this as these rows now being bound by the GPU's work per frame rather than the main thread's encode (main-thread prepare plus submit is about 16 ms in edit while a frame takes two to three refreshes); the harness does not profile GPU work, so this is an inference. Stress, with few draws, also rose on DPR 1 (gpu median 3.7 to 6.0 and 4.0 to 5.8 ms).

## The latency split (`e26-pointer-busy-10k/v2`)

| Row | Project | latency median / max p95 (`0846555`) | prepare median / p95 | submit median / p95 | long tasks after isolation, per run |
| --- | --- | --- | --- | --- | --- |
| busy | chrome-dpr1-v2 | 77.9 / 259.8 (123.8 / 420.1) | 2.7 / 4.6 | 1.3 / 2.0 | 1, 1, 1 |
| busy | chrome-dpr2-v2 | 78.5 / 268.3 (122.3 / 371.0) | 2.7 / 8.2 | 1.3 / 2.5 | 1, 2, 1 |
| busy | edge-dpr1-v2 | 76.5 / 286.0 (119.8 / 361.9) | 2.6 / 5.3 | 1.3 / 2.0 | 1, 1, 1 |
| busy | edge-dpr2-v2 | 76.9 / 255.3 (125.3 / 338.9) | 2.9 / 9.3 | 1.4 / 2.4 | 1, 1, 1 |
| plain | chrome-dpr1-v2 | 77.2 / 315.3 (123.2 / 450.3) | 2.6 / 4.2 | 1.3 / 2.0 | 0, 0, 0 |
| plain | chrome-dpr2-v2 | 79.9 / 276.8 (109.3 / 395.8) | 2.6 / 4.1 | 1.3 / 1.9 | 1, 0, 0 |
| plain | edge-dpr1-v2 | 74.6 / 215.3 (110.6 / 557.3) | 2.7 / 4.2 | 1.3 / 2.0 | 0, 0, 0 |
| plain | edge-dpr2-v2 | 67.9 / 170.8 (134.9 / 447.0) | 2.7 / 4.6 | 1.4 / 2.0 | 0, 0, 0 |

- **A median move is about 40 ms faster** (68 to 80 ms against 109 to 135), and the worst run p95 is 171 to 315 ms (339 to 557). Submit is 1.3 to 1.4 ms of it (4.2 at `0846555`); prepare plus submit is about 4 ms.
- **Long tasks after an isolation:** busy rows 1 per run in 11 of 12 runs and 2 in one, which, less the font load's one task per busy run (`longTasksOver50OutsideIsolation` counts it), is 1 other task in 12 runs (about 3 in 12 at `0846555`); plain rows 1 in 12 runs (0 in 12).
- The rows still miss PA-A04's 50 ms; the remainder is between the move's submission and its observed completion, which we read as GPU queue time, as above (not profiled).

## Conditional levers (E30-A07)

- **L3, after L3a and L3b.** The CPU encode is no longer the leading cost: `vs-submit` p95 is 1.6 to 1.7 ms in the typical view (under section 4.3's 5 ms) and 9.5 to 10.6 ms in all-visible edit, 23.6 to 26.9 ms in pan. `vs-gpu` p95 stays over 5 ms in every row (6.9 to 359 ms), and in the all-visible rows the GPU's work per frame appears to set the frame time (inferred, as above). Section 4.3 writes up a GPU remedy that needs a new pipeline, render bundle or draw-order change as its own item first; what the GPU spends per all-visible frame (the 4x multisampled 2560 × 1440 target at DPR 2, the mask passes, overdraw) is not profiled by the E26 harness, so the next step for L3 is that profile and the write-up, not a merge in E30. The pan rows' remaining CPU (prepare 19 to 25 ms, submit about 20 ms, from the masked states and mask tiles that move with the camera) is a candidate for a further L3 part.
- **L4** (#489) and **L5** (not needed at `0846555`; prepare plus submit is now about 4 ms of a median move) stand.

## Result

- L3a and L3b took the backend's main-thread encode from the leading cost to a small one on the PC: submit 4.0 to 1.1 ms in the typical view and 34 to 6 ms in all-visible edit (median); the typical view now presents every frame (18.1 ms at this sitting's longer rAF interval), and a median pointer move is about 40 ms faster.
- The all-visible rows (PA-A03) appear bound by the GPU's per-frame work (`vs-gpu` up as the queue deepens; inferred, not profiled); a GPU-side remedy is written up as its own item before any merge (section 4.3).
- `test:gpu` (SwiftShader) 93/93 at `af351d3`, the run #492 and #493 owed.
- One v1 control failed at its font load (`net::ERR_NO_BUFFER_SPACE`) and passed on its retry; named, not counted.
