# V-36 A10: glass-card cost on the reference PC

Contract: [viz-v36-inner-shadow-background-blur-contract.md](../../plans/viz-v36-inner-shadow-background-blur-contract.md), V36-A10.

**Scene.** U4 (#598) built `v36-glass` in the E26 harness (`tests/e26/scenarios.ts`, `generateV36GlassDocument`). It is `e41-cards` with 10 of its 50 cards changed into glass cards: cards 0, 5, 10, and so on. Each glass card's background is one white fill at alpha 0.3. Its card root, a group on the page, appends two effects to the ones it has in `e41-cards`:

- the editor's default inner shadow;
- a background blur of radius 20.

Glass cards 0, 10, 20, 30 and 40 keep their `e41-cards` layer blur.

**Scenarios.** Both use E26's `fitted` camera, which is how A10's "typical view" is read here (as for E41-A10 and V35-A10):

- `v36-glass-view/v1`: continuous pan and zoom.
- `v36-glass-drag/v1`: drags `card-22`, the `e41-cards` drag target. It is not a glass card, so the drag measures 10 background blurs redrawn while another card moves.

## Sitting

- **Date and tree.** 2026-11-12, branch `claude/viz-v36-u4-exit` at `366d34e`. That is main `cf5e7c8` plus U4, the same code as #598's merge `c863fa6` apart from documentation. `pnpm install` and `pnpm build` passed.
- **Environment.** The reference PC (the user's main PC) with an NVIDIA GTX 1660 SUPER (`nvidia/turing`) and Chrome 157.0.8103.51, which is the records' `browser`. The records' `userAgent` says Chrome/151, as in the E41 and V-35 records.
- **Projects.** `chrome-dpr1` and `chrome-dpr2`, five repetitions each, at the harness viewport of 1280 × 720 CSS px. No record is dirty.
- **Command.** PowerShell: `$env:M8_N3_BASELINE='docs/evidence/m8-a14-2026-11-01/17a2b0a-main-pc-headed.json'; $env:E26_SCENARIOS='v36'; $env:E26_RESULTS_DIR='test-results/v36-a10'; pnpm test:e26 --project=chrome-dpr1 --project=chrome-dpr2`.
- **Result.** 20 of 20 passed in 7.6 min. The records are in [a10-366d34e/](a10-366d34e/).

## Results

All values are in ms.

- **rAF:** the median and p95 of the frame interval over the 10 s window.
- **Idle rAF:** the same page's median before any load.
- **GPU:** the median and p95 of `vs-gpu`. `vs-gpu` runs from submit to `onSubmittedWorkDone` and is sampled on every eighth frame (71 samples). It is a latency proxy: it includes time queued behind earlier work and the callback delay, not only the GPU's busy time.
- **Encode:** the median and p95 of `encodeAndSubmitMs`.

| Project | Scenario | rAF median | rAF p95 | idle rAF | GPU median | GPU p95 | encode median / p95 | frames | effect passes / splits per frame |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dpr2 | view | 17.7 to 17.9 | 18.1 | 17.6 to 17.8 | 18.6 to 19.0 | 26.9 to 36.5 | 3.8 to 4.0 / 5.6 to 5.9 | 563 | 50 / 10 |
| dpr2 | drag | 17.6 to 17.8 | 18.1 | 17.5 to 17.8 | 19.3 to 19.7 | 28.7 to 39.7 | 4.6 to 4.7 / 6.6 to 7.1 | 563 to 566 | 50 / 10 |
| dpr1 | view | 17.7 to 17.8 | 18.1 | 17.5 to 17.6 | 18.0 to 18.6 | 26.2 to 36.1 | 3.8 to 3.9 / 5.5 to 5.8 | 563 to 564 | 50 / 10 |
| dpr1 | drag | 17.7 to 17.8 | 18.1 | 17.4 to 17.9 | 19.3 to 19.6 | 34.3 to 37.9 | 4.7 / 6.8 to 8.0 | 562 to 564 | 50 / 10 |

Run checks:

- Every drag run applied every move: `revisedMoves` equals `framesSubmitted`.
- `backgroundBlurSkipped` is 0 in every run.
- There were no long tasks, no page errors and no device loss.
- One console error, a 404 for a page resource, appears in r1 of each view project, as in the V-35 sittings.

**Baseline for comparison.** The plain `e41-cards` scene, run on the same PC at E41's sitting `1bbec13` ([../e41/pc-1bbec13/cards/](../e41/pc-1bbec13/cards/)), measured:

- rAF median 16.7 ms, equal to its idle median;
- GPU median 10.6 to 12.9 ms;
- encode median 2.6 to 3.4 ms;
- 600 frames per window.

So the 10 glass cards add about 7 ms to the GPU latency proxy and about 1.2 ms to encode. These are two different sittings, and the display paced differently in each (below).

## Verdict

**Not met as written. Disclosed for the user's decision.**

1. **The ceiling is missed by about 1 ms.** Every median is 17.6 to 17.9 ms against 16.7 ms. As in V-35's sitting, the idle frame interval on the same page is already 17.4 to 17.9 ms, about 57 Hz, with Windows reporting 60 Hz. The loaded interval equals the idle one.
2. **Frames keep pace on this PC.** There are 562 to 566 frames in each 10 s window, about one per vsync, and every drag move was applied. The scene does not drop frames on this display.
3. **The GPU has no headroom left, unlike V-35.** The GPU latency proxy's median, 18.0 to 19.7 ms, is above one frame interval, and its p95 reaches 26 to 40 ms. V-35's 15 blend roots measured 7 to 8 ms on the same PC and display.
   - Frames still keep pace because the proxy counts queueing and callback delay as well as GPU work, and frames overlap in the queue.
   - Even so, this scene uses about the whole frame. On a display that really paces at 60 Hz, or with more glass cards than 10, frames would likely be dropped.
   - The cost comes from the background blurs. Each one ends and resumes the main pass, copies its backdrop with MSAA stored, and runs a radius-20 blur chain (contract section 11, "Pass splits").

Recommended follow-up, if the user accepts: a backlog item to reduce background-blur cost. Options include blurring the backdrop at reduced resolution for large radii, and sharing one snapshot between neighbouring glass roots. This was not measured in this sitting.
