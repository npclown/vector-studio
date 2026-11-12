# V-35 A10: blend cost on the reference PC

Contract: [viz-v35-fills-blend-contract.md](../../plans/viz-v35-fills-blend-contract.md), V35-A10. The scene and harness are U5's: `v35-cards` in the E26 harness (`tests/e26/scenarios.ts`, `generateV35CardsDocument`). The scene has 50 cards, each background with three fills; the top fill of every fifth card is `multiply` and every tenth card is `screen` as a node. That makes 15 blend roots. The two scenarios are `v35-cards-view/v1` (fitted camera, continuous render) and `v35-cards-drag/v1` (one card dragged).

## Sittings

| Sitting | Commit | Runs | Records |
| --- | --- | --- | --- |
| 1 | `6f94aa2` (#588) | view 10 of 10 passed; drag 0 of 10 (harness bug, below) | [a10-6f94aa2-view/](a10-6f94aa2-view/) (view only; the drag runs wrote no record) |
| 2 | `d8fd617` (#592) | 20 of 20 passed | [a10-d8fd617/](a10-d8fd617/) |

- **Environment.** Main PC with a GTX 1660 SUPER (`nvidia/turing`), driver 32.0.16.1088 and Chrome 157.0.8103.51. Windows reports 60 Hz, the only mode at 1920 × 1080. The Balanced power plan was on and nothing ran fullscreen.
- **Projects and runs.** `chrome-dpr1` and `chrome-dpr2`, with the E26 harness viewport of 1280 × 720 CSS px, five repetitions each. No record is dirty. `blendPipelineAvailable` is true in every record.
- **Command.** PowerShell, after `pnpm build`: `$env:M8_N3_BASELINE='docs/evidence/m8-a14-2026-11-01/17a2b0a-main-pc-headed.json'; $env:E26_SCENARIOS='v35'; $env:E26_RESULTS_DIR='test-results/v35-a10-r2'; pnpm test:e26 --project=chrome-dpr1 --project=chrome-dpr2`.
- **Sitting 1's drag failure.** The pressed card background has three fills, so it projects as `<id>\0fill<i>` leaves (V35-P1). The harness looked up its bounds under the bare id and threw "the pressed leaf has no draw bounds". #592 takes the union of the node's fill and stroke leaves; the press point is unchanged from `e41-cards`. No product code changed between the sittings.

## Results (sitting 2, `d8fd617`)

All values are in ms. The rAF columns are the median and p95 of the frame interval over the 10 s window. GPU is the median `vs-gpu` timestamp-query time per sampled frame (71 or 72 samples), and it includes the backdrop snapshots and the blend composites. Encode is the median and p95 of `encodeAndSubmitMs`. Splits per frame is `blendSplits` divided by `framesSubmitted`.

| Project | Scenario | rAF median | rAF p95 | idle rAF median | GPU median | GPU p95 | encode median / p95 | frames | splits per frame |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dpr2 | view | 17.6 (all 5) | 18.1 | 17.5 to 17.9 | 7.5 to 8.0 | 11.1 to 12.6 | 1.0 to 1.1 / 1.6 to 1.9 | 567 to 569 | 15 |
| dpr2 | drag | 17.5 to 17.6 | 18.1 | 17.6 to 17.8 | 7.2 to 8.0 | 9.9 to 12.7 | 2.4 to 2.5 / 3.7 to 4.0 | 567 to 570 | 15 |
| dpr1 | view | 17.6 (all 5) | 18.1 | 17.5 to 18.0 | 7.4 to 7.7 | 9.1 to 10.1 | 1.0 to 1.1 / 1.6 to 1.8 | 567 to 569 | 15 |
| dpr1 | drag | 17.6 (all 5) | 18.1 | 17.5 to 17.7 | 7.2 to 7.9 | 9.2 to 12.7 | 2.3 to 2.5 / 3.5 to 3.8 | 567 to 568 | 15 |

Every drag run applied every move (`revisedMoves` equals `framesSubmitted`). There were no long tasks, no page errors and no device loss. One console error, a 404 for a page resource, appears in r1 of each view project in both sittings and in none of the later runs. Sitting 1's view runs at `6f94aa2` agree: rAF 17.6 / 18.1, GPU median 7.3 to 8.0, 15 splits per frame.

## Verdict

**Not met as written (disclosed for the user's decision).** Every median is 17.5 to 17.6 ms against the 16.7 ms ceiling, so A10 misses by about 0.9 ms. The miss is the display's pacing, not the scene:

- The idle rAF median, measured on the same page before any load, is also 17.5 to 18.0 ms, about 57 Hz. The loaded frame interval equals the idle one, so each frame holds one vsync.
- The work per frame is far below a vsync: GPU median 7.2 to 8.0 ms (p95 at most 12.7), CPU encode and submit median 1.0 to 2.5 ms.
- Earlier sittings on this PC (E41 U7c, `e41-cards`) measured an idle rAF of 16.7 ms. This sitting's display or driver paces at about 57 Hz with Windows reporting 60 Hz, and the coordinator found no setting that differs.

This follows the E26 precedent (U5d PC re-run, d9-e26 contract): a row that holds one vsync and misses only the literal ceiling is recorded as a miss, with the cause shown, for the user to decide (A10: "a miss is disclosed in the exit record and the user decides").

Also disclosed: A10 names 1920 × 1080 at DPR 1. The E26 harness measures a 1280 × 720 CSS viewport at DPR 1 and DPR 2 (2560 × 1440 device px at DPR 2, more pixels than 1080p). As for E41, the verdict is read at DPR 2.
