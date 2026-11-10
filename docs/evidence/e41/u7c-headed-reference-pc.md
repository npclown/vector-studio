# E41 U7c: the cards benchmark, the bench comparison, the counters and the editor flows on the reference PC

Contract: [d9-e41-boolean-effects-contract.md](../../plans/d9-e41-boolean-effects-contract.md), section 5.6 and its "U7c amendments". This record covers E41-A10, the bench part of E41-A06, the headed parts of E41-A07 to A09, and the headed run of E41-A12.

## Sitting

The full log of the sitting, with the machine, the browser versions and every command, is [pc-1bbec13/sitting.txt](pc-1bbec13/sitting.txt). The run records are committed beside it.

- Commit 1bbec13 (main after #563), with a clean tree. The reference PC: Windows 11 Pro 26200, NVIDIA GeForce GTX 1660 SUPER (adapter `nvidia/turing`), 1920 × 1080 at 60 Hz, headed Chrome 156.0.8078.81 and Edge 157.0.4341.42. The mouse was not touched during the E26 runs.
- Step 1: `pnpm build`. Passed.
- Step 2 (A10): `E26_SCENARIOS=e41 pnpm test:e26 --project=chrome-dpr1 --project=chrome-dpr2`, with `M8_N3_BASELINE` set to the main-PC headed layout baseline. 5 repetitions each, 20 of 20 passed. Records: [pc-1bbec13/cards/](pc-1bbec13/cards/).
- Steps 3 and 6 (A06's bench part): every E26 scenario that the eadc1d7 sitting recorded, at 3 repetitions, in `chrome-dpr1`, `chrome-dpr2` and the two `-v2` twins. Step 3 ran `e26-mixed-` and `e26-simple-` (48 passed); step 6 ran `e26-pointer-busy-`, `e26-ui0-`, `m9-typing-` and `e26-isolation-` (72 passed). The other test entries were the planned cross-skips (v1 scenarios skip in the `-v2` projects, and v2 scenarios skip in the v1 projects). Records: [pc-1bbec13/a06/](pc-1bbec13/a06/).
- Step 4 (counters): `pnpm test:gpu -g "A07|A08|A09"`, 12 of 12 passed, all in the `chrome` project. The pattern also matched nine tests of other suites (E23, E25, E28, P4 and V-3; listed in sitting.txt); the three E41 tests are E41-A07, A08 and A09. Reports: [pc-1bbec13/gpu/](pc-1bbec13/gpu/).
- Step 5: the full GPU tier (`pnpm test:gpu:full`). Every E41 test passed in Chrome and in Edge (A05 at 1x and 4x, A06, A07, A08, A09); the E41 reports are in [pc-1bbec13/gpu/full-suite/](pc-1bbec13/gpu/full-suite/). Other suites' results are under A06 in the exit record.
- Step 7 (A12): `pnpm test:e41-next-host`, 4 of 4 passed: the boolean and the effects flows in Chrome 156.0.8078.81 and Edge 157.0.4341.42.
- Steps 8 to 10, after the first pass of the records: the `viz-v4` A08 corpus was not rerun (its WASM pin is stale on main), the `e3-a04-readback` rerun with an 8 GB Node heap was stopped without a result, and the `-v2` A/B at e8ba618 and 1bbec13 ran 30 of 30 at each commit (see A06).
- In each of steps 2, 3 and 6, one run per project logged one console 404 for a static resource, always in a first repetition: `e41-cards-view` r1 (step 2), `e26-mixed-view-edit` r1 (step 3) and `e26-pointer-busy` r1 (step 6). The eadc1d7 records show the same single 404 in each project's `e26-mixed-view-edit` r1, so it predates E41. Console errors are recorded but do not fail a run. Page errors would fail a run, and there were none.

## E41-A10: `e41-cards`

The target is a median `rafCallbackIntervalMs` of at most 16.7 ms, judged at DPR 2. `gpuMs` is the frame's `vs-gpu` measure, from submit until the GPU work is done. The renderer has no per-pass timestamps, so this measure stands in for effect-pass GPU time (amendment). `firstFrameMs` is the time from navigation to the loaded scene's first finished frame.

| Scenario | DPR | Frame median (ms) | Frame p95 (ms) | gpuMs median (ms) | Effect passes / frames | firstFrameMs |
| --- | --- | --- | --- | --- | --- | --- |
| `e41-cards-view/v1` | 1 | 16.70 | 16.80 | 10.6 to 11.3 | 30,000 / 600 per run | 5,135 to 5,716 |
| `e41-cards-drag/v1` | 1 | 16.70 | 16.70 to 16.80 | 11.1 to 11.6 | 30,000 / 600 per run | 5,138 to 5,228 |
| `e41-cards-view/v1` | 2 | 16.70 | 16.80 | 12.2 to 12.9 | 30,000 / 600 per run | 5,153 to 5,241 |
| `e41-cards-drag/v1` | 2 | 16.70 | 16.80 | 12.3 to 12.6 | 30,000 / 600 per run (r4: 29,950 / 599) | 5,144 to 5,167 |

Every run held the display's 60 Hz frame interval. Every frame drew all 50 effect roots: the harness checks exactly 50 passes per submitted frame, so no tree dropped its effects over the budget. The drag moved the card in every drag run.

**E41-A10: PASS.** At DPR 2 (2560 × 1440, more pixels than section 5.6's 1920 × 1080), the median is 16.70 ms against the 16.7 ms ceiling for both the view and the drag (p95 16.80 ms). The frame's GPU time is about 12.5 ms.

## E41-A06, bench part

**Bench part: PASS.** No frame metric got worse, and the one difference found in the `-v2` pages predates E41 (A/B below).

The comparison is against the last committed reference-PC records, [docs/evidence/pa-u9/eadc1d7/timing/runs](../pa-u9/eadc1d7/timing/runs) (2026-11-05, 5 repetitions, Chrome), and covers every Chrome scenario recorded there. This sitting has 3 repetitions per scenario and project. Each value is a range over the runs. The tables are computed from the run records' summaries; the E26 harness records these values and does not fail a run on them.

Frame scenarios: `rafCallbackIntervalMs` median / p95, and the `vs-gpu` median (`gpuMs`, from submit until the GPU work is done), in ms.

| Scenario | Project | Frame eadc1d7 | Frame 1bbec13 | gpuMs eadc1d7 | gpuMs 1bbec13 |
| --- | --- | --- | --- | --- | --- |
| `e26-mixed-all-edit-10k/v1` | chrome-dpr1 | 33.4 / 50.0 to 50.1 | 16.7 / 33.4 | 192.8 to 195.0 | 43.9 to 44.6 |
| `e26-mixed-all-edit-10k/v1` | chrome-dpr2 | 33.5 to 49.9 / 50.1 | 16.7 / 33.4 | 210.1 to 215.4 | 44.2 to 45.0 |
| `e26-mixed-all-edit-10k/v2` | chrome-dpr1-v2 | 33.4 / 50.0 to 50.1 | 33.3 / 33.4 to 33.5 | 216.2 to 219.4 | 60.6 to 62.5 |
| `e26-mixed-all-edit-10k/v2` | chrome-dpr2-v2 | 49.8 to 49.9 / 50.1 | 33.3 / 33.4 to 50.0 | 251.1 to 251.7 | 60.7 to 63.0 |
| `e26-mixed-all-pan-10k/v1` | chrome-dpr1 | 50.0 / 66.7 | 33.3 / 50.0 | 323.3 to 329.0 | 101.0 to 104.4 |
| `e26-mixed-all-pan-10k/v1` | chrome-dpr2 | 66.6 / 66.7 to 66.8 | 33.3 to 33.4 / 50.0 | 357.0 to 358.4 | 102.9 to 107.0 |
| `e26-mixed-all-pan-10k/v2` | chrome-dpr1-v2 | 50.0 / 66.6 to 66.7 | 33.3 to 33.4 / 50.0 | 261.9 to 305.0 | 105.7 to 106.7 |
| `e26-mixed-all-pan-10k/v2` | chrome-dpr2-v2 | 50.1 / 66.7 to 66.8 | 33.4 / 50.1 | 342.5 to 348.9 | 95.6 to 106.7 |
| `e26-mixed-view-edit-10k/v1` | chrome-dpr1 | 16.7 / 16.8 | 16.7 / 16.8 | 18.1 to 18.4 | 6.0 to 17.7 |
| `e26-mixed-view-edit-10k/v1` | chrome-dpr2 | 16.7 / 16.8 | 16.7 / 16.8 | 18.1 to 34.8 | 18.1 to 18.3 |
| `e26-mixed-view-edit-10k/v2` | chrome-dpr1-v2 | 16.7 / 16.8 | 16.7 / 16.8 | 19.0 to 19.4 | 20.5 to 35.6 |
| `e26-mixed-view-edit-10k/v2` | chrome-dpr2-v2 | 16.7 / 16.8 | 16.7 / 16.8 | 19.1 to 19.6 | 34.4 to 35.6 |
| `e26-simple-stress-10k/v1` | chrome-dpr1 | 16.7 / 16.8 | 16.7 / 16.8 | 3.8 to 4.2 | 3.9 to 4.0 |
| `e26-simple-stress-10k/v1` | chrome-dpr2 | 16.7 / 16.8 | 16.7 / 16.7 to 16.8 | 3.8 to 3.9 | 3.7 to 4.0 |
| `e26-simple-stress-10k/v2` | chrome-dpr1-v2 | 16.7 / 16.8 | 16.7 / 16.7 to 16.8 | 3.8 to 4.2 | 4.0 to 4.1 |
| `e26-simple-stress-10k/v2` | chrome-dpr2-v2 | 16.7 / 16.8 | 16.7 / 16.7 to 16.8 | 3.7 to 3.8 | 3.8 to 4.0 |
| `e26-ui0-mixed-all-edit-10k/v1` | chrome-dpr1-v2 | 33.4 / 50.0 | 33.3 / 33.4 | 188.0 to 188.5 | 55.9 to 56.5 |
| `e26-ui0-mixed-all-edit-10k/v1` | chrome-dpr2-v2 | 49.8 to 49.9 / 50.0 to 50.1 | 33.3 / 33.4 | 211.1 to 212.3 | 55.9 to 56.3 |
| `e26-ui0-mixed-all-pan-10k/v1` | chrome-dpr1-v2 | 50.0 / 66.6 to 66.7 | 33.3 / 50.0 | 258.5 to 311.3 | 102.1 to 104.8 |
| `e26-ui0-mixed-all-pan-10k/v1` | chrome-dpr2-v2 | 50.1 / 66.7 to 66.8 | 33.4 / 50.0 to 66.6 | 298.3 to 349.8 | 96.9 to 106.2 |
| `e26-ui0-mixed-view-edit-10k/v1` | chrome-dpr1-v2 | 16.7 / 16.8 | 16.7 / 16.8 | 18.0 to 18.2 | 18.2 to 18.3 |
| `e26-ui0-mixed-view-edit-10k/v1` | chrome-dpr2-v2 | 16.7 / 16.8 | 16.7 / 16.8 | 18.1 to 18.2 | 18.3 |
| `e26-ui0-simple-stress-10k/v1` | chrome-dpr1-v2 | 16.7 / 16.8 | 16.7 / 16.7 to 16.8 | 3.7 to 3.9 | 3.9 to 4.0 |
| `e26-ui0-simple-stress-10k/v1` | chrome-dpr2-v2 | 16.7 to 1016.6 / 16.8 to 1016.7 | 16.7 / 16.8 | 3.4 to 3.8 | 3.8 |

Pointer scenarios: `pointerToWorkDoneMs` median / p95 in ms. The scenario's bound is 50 ms.

| Scenario | Project | eadc1d7 | 1bbec13 |
| --- | --- | --- | --- |
| `e26-pointer-busy-10k/v1` busy | chrome-dpr1 | 40.2 to 43.3 / 71.9 to 84.6 | 38.5 to 41.4 / 72.6 to 84.7 |
| `e26-pointer-busy-10k/v1` busy | chrome-dpr2 | 40.8 to 41.9 / 75.2 to 109.2 | 36.7 to 41.8 / 77.9 to 80.2 |
| `e26-pointer-busy-10k/v1` plain | chrome-dpr1 | 39.8 to 44.9 / 68.6 to 149.2 | 39.2 to 41.6 / 68.3 to 72.0 |
| `e26-pointer-busy-10k/v1` plain | chrome-dpr2 | 40.5 to 43.1 / 73.6 to 89.8 | 36.5 to 40.7 / 64.3 to 82.3 |
| `e26-pointer-busy-10k/v2` busy | chrome-dpr1-v2 | 75.2 to 105.7 / 199.9 to 483.0 | 77.7 to 97.8 / 240.5 to 343.9 |
| `e26-pointer-busy-10k/v2` busy | chrome-dpr2-v2 | 75.2 to 94.4 / 197.7 to 480.4 | 79.4 to 95.2 / 245.7 to 265.7 |
| `e26-pointer-busy-10k/v2` plain | chrome-dpr1-v2 | 73.8 to 85.5 / 164.2 to 244.1 | 91.9 to 115.5 / 238.1 to 498.0 |
| `e26-pointer-busy-10k/v2` plain | chrome-dpr2-v2 | 73.6 to 87.6 / 196.4 to 262.2 | 78.3 to 95.5 / 263.3 to 298.5 |
| `e26-ui0-pointer-busy-10k/v1` busy | chrome-dpr1-v2 | 59.3 to 74.9 / 147.5 to 286.9 | 67.9 to 90.6 / 220.4 to 256.4 |
| `e26-ui0-pointer-busy-10k/v1` busy | chrome-dpr2-v2 | 84.3 to 102.6 / 256.4 to 573.0 | 62.3 to 68.8 / 196.9 to 314.0 |
| `e26-ui0-pointer-busy-10k/v1` plain | chrome-dpr1-v2 | 62.5 to 70.9 / 133.7 to 179.3 | 71.2 to 80.2 / 176.1 to 263.4 |
| `e26-ui0-pointer-busy-10k/v1` plain | chrome-dpr2-v2 | 65.9 to 88.0 / 153.8 to 518.3 | 63.1 to 89.5 / 188.3 to 231.4 |

Typing (`keyToWorkDoneMs` median / p95 in ms) and isolation (one and sixteen isolated loads in ms; each run records its own bounds, 286 to 301 ms for one and 572 to 602 ms for sixteen):

| Scenario | Project | eadc1d7 | 1bbec13 |
| --- | --- | --- | --- |
| `e26-isolation-m1-a13/v1` | chrome-dpr1 | one 86 to 97, sixteen 110 to 121 | one 88 to 89, sixteen 119 to 122 |
| `e26-isolation-m1-a13/v1` | chrome-dpr2 | one 88 to 97, sixteen 109 to 118 | one 86 to 91, sixteen 114 to 118 |
| `m9-typing-10k/v1` | chrome-dpr1-v2 | 46.6 to 47.1 / 51.0 to 53.8 | 26.1 to 29.4 / 35.2 to 39.0 |
| `m9-typing-10k/v1` | chrome-dpr2-v2 | 39.3 to 52.2 / 58.9 to 64.2 | 26.6 to 35.2 / 49.4 to 51.5 |

Findings:

- **No frame metric got worse.** Every frame median and p95 is the same as at eadc1d7 or lower. The all-visible scenarios (`mixed-all-*`, `ui0-mixed-all-*`) are one or two 60 Hz intervals faster, and their `gpuMs` dropped from about 190 to 360 ms to about 44 to 107 ms. The likely cause is E39's stencil paths, merged after eadc1d7; no bisect was run.
- **Typing and isolation did not get worse.** Typing is faster (median 26 to 35 ms against 39 to 52 ms), and every isolation run is inside its bounds.
- **v1 pointer latency did not get worse.** The v1 medians are 37 to 42 ms against 40 to 45 ms.
- **The `-v2` (studio page) scenarios: not caused by E41.** Against eadc1d7, `e26-mixed-view-edit-10k/v2` reads a `gpuMs` of 20.5 to 35.6 ms against 19.0 to 19.6 ms, with the frame unchanged at 16.7 / 16.8 ms, and `e26-pointer-busy-10k/v2` plain at DPR 1 reads a latency median of 92 to 116 ms against 74 to 86 ms (its CPU parts within 0.2 ms; the wait from claim to GPU done 71 to 89 ms against 44 to 56 ms). To attribute it, the reference PC ran both scenarios at e8ba618 (main before E41 turned on `effects: 'v0'` in the editor hosts, db163f6) and at 1bbec13 in one sitting, 5 repetitions each, clean builds (sitting.txt step 10; records [pc-1bbec13/ab-e8ba618/](pc-1bbec13/ab-e8ba618/) and [pc-1bbec13/ab-1bbec13/](pc-1bbec13/ab-1bbec13/)). Medians of the run medians, e8ba618 to 1bbec13:
  - `mixed-view-edit/v2`: frame 16.7 / 16.8 ms at both. `gpuMs` 35.9 to 36.8 ms at DPR 1 (runs 35.5 to 36.9 against 36.3 to 37.3) and 36.3 to 36.5 ms at DPR 2.
  - `pointer-busy/v2` busy: 105.7 to 124.1 ms at DPR 1 and 123.4 to 105.4 ms at DPR 2. The runs range over 86 to 143 ms at both commits.
  - `pointer-busy/v2` plain: 110.4 to 97.5 ms at DPR 1 and 96.8 to 95.4 ms at DPR 2.

  So the gap to eadc1d7 is already present at e8ba618, before the effects wiring; it is not E41's. The pointer latencies move in both directions within their spread. What `effects: 'v0'` does cost on a scene without effects is small: up to about 1 ms of `gpuMs` at DPR 1 (about 2.5 %) with the frame unchanged. A SwiftShader A/B in this repository's container (not evidence) points the same way: prepare 6.0 to 6.4 ms against 4.5 to 5.0 ms and `gpuMs` 916 to 967 ms against 859 to 908 ms with `'v0'` against `'none'`, 3 repetitions each.
- **`firstFrameMs`.** It is new in this sitting, so there is no earlier value to compare with. It is 5.2 to 6.2 s for the E26 pages, the same as the `e41-cards` page (5.1 to 5.7 s).

## E41-A07 to A09, headed

Each value below is from the reports [`a07.json`](pc-1bbec13/gpu/a07.json), [`a08.json`](pc-1bbec13/gpu/a08.json) and [`a09.json`](pc-1bbec13/gpu/a09.json) of step 4. Each report's `failures` list is empty, as is each E41 report of the full suite in both browsers.

- **E41-A07.**
  - The four effect edits (offset and σ, a second shadow, adding a blur, removal) cost 0 fill port calls, 0 stroke port calls and 0 geometry builds.
  - A pan costs 0 with effects and 0 without.
  - The zoom to 1.5 costs 1 fill call and 1 stroke call, with and without effects alike: the stroked star crosses a tessellation bucket.
  - Over 3 frames, the 3 roots drew 9 effect passes.
- **E41-A08.**
  - Over the budget, the pixel below the rectangle stays white (255, 255, 255) and the content stays red (255, 0, 0). No effect pass runs.
  - Under the budget, the shadow pixel is (128, 128, 128).
  - The notices count 0, then 1 after the first transition and 2 after the second. Staying over the budget with a different σ adds none.
- **E41-A09.**
  - The effects frame created 25 textures (counted while encoding) and raised the texture peak from 3,276,801 to 4,457,961 bytes. Afterwards, the live textures are back to 3 and 3,276,801 bytes.
  - After the resize to 800 × 500 at DPR 2, the plain frame, the effects frame and the plain frame again each leave 3 live textures and 32,000,001 bytes.
  - After device loss, the recovered frame is byte-identical, and the live textures are back at the baseline.
  - After dispose, 0 textures are live.

## E41-A12, headed

`pnpm test:e41-next-host` (`playwright.e41-studio.config.ts`) at 1bbec13: 4 of 4 passed in 22.6 s. The `e41-booleans` spec (toolbar, context menu and panel buttons) and the `e41-effects` spec (the Effects section, with pixel probes of the presented frame) each passed in Chrome 156.0.8078.81 and in Edge 157.0.4341.42.
