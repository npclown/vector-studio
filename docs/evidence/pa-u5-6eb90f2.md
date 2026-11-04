# PA-U5: one elevated PresentMon attempt on the busy pointer run, 2026-11-04

Status: **PA-A06 UNVERIFIED, recorded with its method limits; non-blocking under PA-Q3 (a)** ([pre-alpha gate plan](../plans/pre-alpha-gate-plan.md#3-acceptance-criteria)). The capture worked, the correlation ran, and no number below is a validated pointer-to-present measurement. The busy run itself failed one assertion (the release was not applied), from a known intermittent editor defect, not from the capture; that is disclosed below.

## Identity and method

- Head `6eb90f2` (origin/main after [#499](https://github.com/npclown/vector-studio/pull/499), the PA-U5 tooling). Main PC DESKTOP-DKVUSAV, Windows 11 Pro 10.0.26200, Node 24.22.1, Playwright 1.62.1, headed Chrome 156.0.8078.81 (`chrome-dpr1-v2`), GTX 1660 SUPER driver 32.0.16.1088. No chrome or msedge process ran before the run. The record's user agent reads Chrome/151 because of Playwright's device descriptor; the launched browser is 156 ([environment](pa-u5/6eb90f2-01/environment.json)).
- Command: `E26_PRESENTMON=test-results/pa-u5-6eb90f2-01 E26_SCENARIOS=e26-pointer-busy-10k/v2 E26_REPETITIONS=1 M8_N3_BASELINE=docs/evidence/m8-a14-2026-11-01/17a2b0a-main-pc-headed.json pnpm exec playwright test --config playwright.e26.config.ts --project chrome-dpr1-v2`.
- PresentMon 2.5.1 x64, 956,768 bytes, SHA-256 `9bec3083069f58f911e6a512f4806db51a27bd096103087bc1d05ef54c80a191` (the pinned P1.0m value). The ignored copy under `test-results/p1-tools` was gone; with the user's approval it was downloaded again from the official v2.5.1 release, the hash matched, and the helper's preflight passed.
- The user approved the UAC prompt once. Only PresentMon ran elevated (25 s timed, `--qpc_time --v2_metrics`, target the browser's single GPU process, PID 23820, parent checked); the browser and the runner stayed unprivileged.

## Attempts

All three are in the environment record; only the third ran the capture.

1. 13:41:33Z to 13:41:54Z: stopped before elevation, because the PresentMon binary was missing (the helper's hash check). No prompt, no capture.
2. 13:43:51Z to 13:44:10Z: stopped before elevation, because attempt 1 had left the empty capture directory and the harness requires a new one. The empty directory was removed.
3. 13:44:20Z to 13:45:08Z: the measured run. PresentMon requested 13:44:36.99Z, started 13:44:39.97Z, ended 13:45:05.14Z, exit 0.

The user chose one attempt (decision card, 11:42Z). Attempts 1 and 2 never reached the prompt, so attempt 3 is that one attempt. It was not retried.

## Results

From [`correlate.json`](pa-u5/6eb90f2-01/correlate.json) (`node tooling/pa-u5-presentmon-correlate.mjs <record>`):

- CSV schema `CPUStartQPC + DisplayLatency` (v2 metrics); 25 rows, all for the GPU process, all displayed.
- Clock: page-to-QPC offset from the bracketed pairs, uncertainty 0.60 ms, before/after drift 0.03 ms.
- Moves with a revision: 25; inside the captured display span: 24, outside: 1.

| Measure (24 moves)                                           | p50 ms | p95 ms | max ms |
| ------------------------------------------------------------ | -----: | -----: | -----: |
| `pointerToWorkDoneMs` (page clock, as E26)                   |   90.5 |  171.6 |  186.6 |
| `lowerBoundMs`: true but weak lower bound of pointer-to-present |   17.0 |   45.8 |   61.1 |
| `afterWorkDoneMs`: heuristic, first display after work done  |  105.6 |  189.4 |  204.4 |

The renderer runs on demand, so the 25 displays cluster around changes. In page time: 16 fall between 13,591 and 14,040 ms, while the drag produced revisions (13,586 to 14,031 ms work done); 7 between 14,074 and 14,590 ms, after the drag had stopped; and 2 at 15,707 and 15,724 ms, after the font-load change (15,576 to 15,706 ms). Which display shows which move is not known: no frame or content identity joins a CSV row to a move (P1.0m J2), which is why PA-A06 stays UNVERIFIED.

## The run's own failure

The test failed `the release was applied` (undo depth 1, expected 2), with 0 rejections against 1 expected, so the plain variant was skipped. The record shows the drag produced revisions for about 400 ms after the press (revisions 3 to 27), then an autosave write ran while the button was still down (13,969.9 to 14,047.8 ms page time), and the remaining 415 moves made no change; the release at 17,584.7 ms was handled but applied nothing, and no write followed it. The rejection is armed at 1.0 s into the drag, after the drag had stopped, so it never fired. The page stayed visible and focused, with no blur or visibility change; one console 404 was logged.

This is the same signature as the V-21 U3 attempt-1 failure ([record](viz-v21/u3-b6e9343.md), `edge-dpr2-v2` busy r1: a write during the press, no change after it, the release not applied), on a run without PresentMon. The capture is therefore not its cause. The defect can silently drop a user's drag, so it is named for the pre-alpha exit card as a follow-up; its cause is not found here.

## Files

[`pa-u5/6eb90f2-01/`](pa-u5/6eb90f2-01/): the run record (`presentMonVariant: true`, so `tooling/e26-summarize.mjs` never counts it as timed evidence), `chrome.csv`, the helper's start and result records, `correlate.json`, `environment.json`, the Playwright log and error context. They are kept byte-for-byte (`.gitattributes -text`, `.prettierignore`), as the helper writes CRLF.

## Verdict

PA-A06: UNVERIFIED with the limits above, non-blocking (PA-Q3 (a)). The weak lower bound of pointer-to-present is 17.0 ms at p50 and 61.1 ms at most; it says only that no change can have been shown sooner. Under the gate-head rule this record counts if no measured `packages/` or `apps/` file changes before the gate head.
