# E41 U7c: the cards benchmark, the bench comparison and the counters on the reference PC

Contract: [d9-e41-boolean-effects-contract.md](../../plans/d9-e41-boolean-effects-contract.md), section 5.6 and its "U7c amendments". This record covers E41-A10, the bench part of E41-A06, and the headed parts of E41-A07 to A09.

## Sitting

- Commit 1bbec13 (main after #563), with a clean tree. The PC is the reference PC, adapter `nvidia/turing`, running headed Chrome. The mouse was not touched during the E26 runs.
- Step 1: `pnpm build`. Passed.
- Step 2 (A10): `E26_SCENARIOS=e41 pnpm test:e26 --project=chrome-dpr1 --project=chrome-dpr2`, with `M8_N3_BASELINE` set to the main-PC headed layout baseline. 5 repetitions each, 20 of 20 passed. Records are in `test-results/e41-u7c-cards` on the PC.
- Step 3 (A06's bench part): `E26_SCENARIOS=e26-mixed-,e26-simple- E26_REPETITIONS=3 pnpm test:e26` in `chrome-dpr1`, `chrome-dpr2` and the two `-v2` twins. 48 runs passed. The other 48 test entries were the planned cross-skips (v1 scenarios skip in the `-v2` projects, and v2 scenarios skip in the v1 projects). Records are in `test-results/e41-u7c-a06` on the PC.
- Step 4 (counters): `pnpm test:gpu -g "A07|A08|A09"`. All tests passed in every project (12 of 12). Reports are in `artifacts/e41-effects/2026-11-10T05-01-27-079Z-1108` on the PC.
- Each run's first repetition logged one console 404 for a static resource. This happened in `e41-cards-view` in both projects and in `e26-mixed-view-edit` in all four projects. The same 404 is in all four `e26-mixed-view-edit` first repetitions of the eadc1d7 records, so it predates E41. Console errors are recorded but do not fail a run. Page errors would fail a run, and there were none.

## E41-A10: `e41-cards`

The target is a median `rafCallbackIntervalMs` of at most 16.7 ms, judged at DPR 2. `gpuMs` is the frame's `vs-gpu` measure, from submit until the GPU work is done. The renderer has no per-pass timestamps, so this measure stands in for effect-pass GPU time (amendment). `firstFrameMs` is the time from navigation to the loaded scene's first finished frame.

| Scenario | DPR | Frame median (ms) | Frame p95 (ms) | gpuMs median (ms) | Effect passes / frames | firstFrameMs |
| --- | --- | --- | --- | --- | --- | --- |
| `e41-cards-view/v1` | 1 | 16.70 | 16.70 to 16.80 | 10.6 to 11.3 | 30,000 / 600 per run | 5,135 to 5,716 |
| `e41-cards-drag/v1` | 1 | 16.70 | 16.70 to 16.80 | 11.1 to 11.6 | 30,000 / 600 per run | 5,138 to 5,228 |
| `e41-cards-view/v1` | 2 | 16.70 | 16.70 to 16.80 | 12.2 to 12.9 | 30,000 / 600 per run | 5,153 to 5,241 |
| `e41-cards-drag/v1` | 2 | 16.70 | 16.70 to 16.80 | 12.3 to 12.6 | 30,000 / 600 per run (r4: 29,950 / 599) | 5,144 to 5,167 |

Every run held the display's 60 Hz frame interval. Every frame drew all 50 effect roots: the harness checks exactly 50 passes per submitted frame, so no tree dropped its effects over the budget. The drag moved the card in every drag run.

**E41-A10: PASS.** At DPR 2 (2560 × 1440, more pixels than section 5.6's 1920 × 1080), the median is 16.70 ms against the 16.7 ms ceiling for both the view and the drag. The frame's GPU time is about 12.5 ms.

## E41-A06, bench part: no regression

The comparison is against the last committed reference-PC records of the same scenarios, [docs/evidence/pa-u9/eadc1d7/timing/runs](../pa-u9/eadc1d7/timing/runs) (2026-11-05, 5 repetitions, Chrome). This sitting has 3 repetitions per scenario and project. Each cell is the frame median / frame p95 in ms, as a range over the runs.

| Scenario | Project | eadc1d7 (2026-11-05) | 1bbec13 (this sitting) |
| --- | --- | --- | --- |
| `e26-mixed-all-edit-10k` | v1 | 33.4 to 49.9 / 50.1 | 16.7 / 33.4 |
| `e26-mixed-all-edit-10k` | v2 | 33.4 to 49.9 / 50.1 | 33.3 / 33.4 to 50.0 |
| `e26-mixed-all-pan-10k` | v1 | 50.0 to 66.6 / 66.7 to 66.8 | 33.3 to 33.4 / 50.0 |
| `e26-mixed-all-pan-10k` | v2 | 50.0 to 50.1 / 66.6 to 66.8 | 33.3 to 33.4 / 50.0 to 50.1 |
| `e26-mixed-view-edit-10k` | v1 | 16.7 / 16.8 | 16.7 / 16.8 |
| `e26-mixed-view-edit-10k` | v2 | 16.7 / 16.8 | 16.7 / 16.8 |
| `e26-simple-stress-10k` | v1 and v2 | 16.7 / 16.8 | 16.7 / 16.7 to 16.8 |

No gated frame metric (`rafCallbackIntervalMs` median and p95) got worse; `gpuMs` is an observation, not gated. The all-visible scenarios are faster than at eadc1d7. The gain is likely E39's stencil paths, merged after eadc1d7; no bisect was run.

Observations, not regressions:

- **`gpuMs` of `e26-mixed-view-edit-10k/v2`.** It reads 34.4 to 35.6 ms at DPR 2 and 20.5 to 35.6 ms at DPR 1, against 19.0 to 19.6 ms at eadc1d7. The frame median and p95 did not change (16.7 / 16.8). A hypothesis, not a measured cause: `vs-gpu` runs from submit to done, so a frame that waits behind the one before it reads about two intervals while the frame rate holds. The eadc1d7 records show the same bimodal reading once (DPR 2 v1 r5, 34.8 ms). The v1 twin reads 18.1 to 18.3 ms at DPR 2, as before, and its DPR 1 readings are noisy across repetitions (6.0, 7.0 and 17.7 ms).
- **`gpuMs` of the all-visible scenarios.** It is lower than at eadc1d7: `e26-mixed-all-pan-10k/v1` reads 101 to 107 ms against 323 to 358 ms, and `e26-mixed-all-edit-10k/v1` reads 44 to 45 ms against 193 to 215 ms.
- **`firstFrameMs`.** It is new in this sitting, so there is no earlier value to compare with. It is 5.2 to 6.0 s for the v1 pages and 5.2 to 6.2 s for the v2 pages, the same as the `e41-cards` page (5.1 to 5.7 s). So the effect and shifted pipelines that `effects: 'v0'` creates before the first frame do not stand out in it.

## E41-A07 to A09, headed

Each value below is from the reports `a07.json`, `a08.json` and `a09.json`. Each report's `failures` list is empty.

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
