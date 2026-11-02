# M9-U4 identity sitting at `5ee0f4d` (2026-11-02)

The identity sitting of [M9 contract section 6](../../plans/mvp-m9-performance-exit-contract.md#6-identity-sitting-m9-u4), for M9-A06. **Result: 0 failed, 0 flaky, 0 skipped, 0 hangs** in every run. No committed capture or golden file changed.

## Run

- **Machine.** The main PC.
  - GPU and CPU: NVIDIA GeForce GTX 1660 SUPER (driver 32.0.16.1088), AMD Ryzen 7 3700X (8 cores, 16 threads).
  - Displays and power: two 1920×1080 displays at 60 Hz, Balanced power plan.
  - Software: Chrome 156.0.8078.74, Edge 156.0.4314.58, Node 24.22.1.
- **Preflight, 2026-11-02 15:30 KST.** Input had been idle for 219 s, and for 239 s twenty seconds later. No Chrome or Edge window was open.
- **Commit.** `5ee0f4d` was the head of `main` when the sitting started (the M9 exit head, contract section 6). The tree was clean apart from three untracked, machine-local items that are never committed.
  - **Main has moved since.** It has since gained #454 and #455, which change only headed-run selection, reporters and docs. No `packages/` or `apps/` file changes between `5ee0f4d` and those merges, so this sitting covers the product source of the exit.
- **Setup.**
  - `pnpm install --frozen-lockfile`: OK.
  - `pnpm test:geometry`: 72 files, 1,217 passed and 6 skipped, 15:31 to 15:53.
  - The root `pnpm build`: OK, 15:53 to 15:54.

## Results

| Run                                                                                              | Passed  | Failed, flaky, skipped | Time                         |
| ------------------------------------------------------------------------------------------------ | ------- | ---------------------- | ---------------------------- |
| `pnpm test:m8-next-host` (with `M8_N3_BASELINE` = the M8 baseline `17a2b0a-main-pc-headed.json`) | 36      | 0                      | 2.8 min                      |
| `pnpm test:p5-next-host`                                                                         | 4       | 0                      | 23.9 s                       |
| `pnpm test:m1-next-host`                                                                         | 2       | 0                      | 18.7 s                       |
| `pnpm test:m2-next-host`                                                                         | 10      | 0                      | 1.0 min                      |
| `pnpm test:m3-next-host`                                                                         | 2       | 0                      | 36.3 s                       |
| `pnpm test:m4-next-host`                                                                         | 10      | 0                      | 2.2 min                      |
| `pnpm test:m5-next-host`                                                                         | 10      | 0                      | 1.6 min                      |
| `pnpm test:m6a-next-host`                                                                        | 22      | 0                      | 26.9 s                       |
| `pnpm test:m6b-next-host`                                                                        | 38      | 0                      | 49.9 s                       |
| `pnpm test:m6c-next-host`                                                                        | 108     | 0                      | 15.2 min                     |
| `pnpm test:m7-next-host`                                                                         | 4       | 0                      | 32.5 s                       |
| **Next-host total**                                                                              | **246** | **0**                  | about 26 min, 15:54 to 16:20 |
| `pnpm test:gpu`, Chrome and Edge, with the A08 corpus spec (the config at `5ee0f4d`)             | **210** | **0**                  | 3.5 h, 16:20 to 19:51        |

- **The E28 text atlas spec**, part of `pnpm test:gpu`, ran on the `canvas-2d/raster-v1` route (M6 exit follow-up 7). It passed 14 of 14 in each browser:
  - A03 T1 to T7 at 4x and 1x, at DPR 1 and 2;
  - A04, A05, T8 (A06) three times, T9 (A08), A07;
  - the A08 canvas port;
  - the M6c per-cluster cases at DPR 1 and 2.
- **No test failed, so none was re-run alone.**
- **After the runs**, `git status` showed no tracked file changed. The three untracked items were unchanged.

## Disclosures

- **A user browser window was open during part of `pnpm test:gpu`.** At 16:37 KST, during `pnpm test:gpu`, a Chrome window of the user's own opened and stayed open. It was not the tests' browser, and it was not closed. The runs are pass or fail checks, not timings, so this does not change a result. It is recorded because the preflight did not hold for the whole sitting.
- **Some suite times are derived.** The progress summary file kept only its first two lines, because a monitor held it open. The suite times above come from Playwright's own output and from the log files' creation and modification times.
- **Per-spec times were not recorded.** The `line` reporter does not record them. Coarse `pnpm test:gpu` progress: 90 tests by about 16:50, 96 by 17:29, 100 by 17:58, 166 by 18:29 and 203 by about 19:30 KST. The A08 corpus took most of each browser's time.
- **The logs stay on the PC.** They are under `artifacts/m9-u4-5ee0f4d/`: install, geometry, build, one per next-host suite, and `test:gpu`. They are not committed.

## Verdict

M9-A06: **PASS**. The sitting ran as section 6 says (the full `pnpm test:gpu`, every next-host headed spec and the full headed E28 spec at `canvas-2d/raster-v1`), with no failure and no capture change.
