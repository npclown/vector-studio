# E26 baseline at `bc071b0` (2026-10-30)

This is the pinned baseline of the [E26 contract](../../plans/d9-e26-pointer-priority-contract.md) (section 3.5, as amended by U1c): the five scenarios run by `pnpm test:e26` (`tests/e26/e26-harness.spec.ts`) at U1c's merge commit `bc071b0`, after U2, U4 and U3. It is the second half of U1c.

Every target is missed. The frame scenarios are bound by the CPU work of each frame, where the backend's `encodeAndSubmitMs` (which includes the primitive packet's `prepare`) takes 45 to 159 ms. Three findings go past the scenarios' own targets:

- At DPR 1, the all-visible scenarios take about 6 s per frame and submit no frame in the window.
- In the busy latency scenario, every isolation is followed by, or sits inside, a long task of 4.1 to 4.9 s.
- The autosave write starts during the press in every busy run, which U6a is meant to fix.

The last section records what follows from this for U5 and U6.

## Run

The run used the reference PC, DESKTOP-DKVUSAV, with an NVIDIA Turing GPU (the GTX 1660 SUPER; the records give only the adapter's vendor and architecture). Browsers were Chrome 156.0.8078.74 and Edge 156.0.4314.50, headed at 1280 × 720 CSS, with the window in front, a clean tree and a 60 Hz display (idle rAF median 16.7 ms in every record).

- **Tests.** 120 of 120 tests passed in 1.3 h, with 0 failed or flaky. That is 6 runs (4 frame scenarios plus the latency scenario's `busy` and `plain` variants), times 5 repetitions, times Chrome and Edge at DPR 1 and 2. A passed test means a valid run, not a met target: none lost the device, hid the page, lost focus, threw a page error or had a DPR mismatch.
- **Records.** The 120 records are in [baseline-bc071b0/runs/](baseline-bc071b0/runs/), byte-identical to the PC's zip (SHA-256 `87121C65A010F1357C0669415706BEFC1A00B69000B728887A66E88375D7C918`), with the zip's name list as `runs/files.txt`. [baseline-bc071b0/summary.json](baseline-bc071b0/summary.json) is `node tooling/e26-summarize.mjs docs/evidence/e26/baseline-bc071b0/runs --json …`.
- **Record notes.**
  - The records' `userAgent` reports Chrome 151.0.7922.34 for both browsers. Each record's `browser` field (Playwright's `browser.version()`) matches the installed executables, so trust that field instead.
  - The PC's first attempt failed every test on the clean-tree check, because three standing untracked entries counted as dirty. They were excluded for the run through `.git/info/exclude`. The check now counts tracked files only (this PR).

## Results

Per-run p95, in ms, by nearest rank. Max is the maximum per-run p95. No result has a rounding allowance.

| Scenario | Variant | Project | Per-run p95 | Max | Target | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v1` | frame | chrome-dpr1 | 66.7, 66.7, 66.7, 66.7, 66.7 | 66.7 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | chrome-dpr2 | 50.2, 66.6, 66.7, 66.6, 66.6 | 66.7 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | edge-dpr1 | 66.6, 66.6, 66.6, 50.3, 66.7 | 66.7 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | edge-dpr2 | 66.6, 66.6, 66.6, 66.6, 66.6 | 66.6 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | chrome-dpr1 | 6083.4, 6116.5, 6083.3, 6050, 6216.7 | 6216.7 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | chrome-dpr2 | 150, 150.1, 166.6, 150, 150.1 | 166.6 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | edge-dpr1 | 6450, 6066.6, 5916.6, 5916.6, 6350 | 6450 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | edge-dpr2 | 166.6, 150.1, 150.2, 150, 150.1 | 166.6 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | chrome-dpr1 | 6583.2, 6749.9, 6466.5, 6499.9, 6650 | 6749.9 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | chrome-dpr2 | 166.7, 166.6, 150.1, 150, 150 | 166.7 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | edge-dpr1 | 6566.6, 6533.4, 6266.6, 6366.7, 6133.3 | 6566.6 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | edge-dpr2 | 150.1, 150, 150.1, 150, 150 | 150.1 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v1` | frame | chrome-dpr1 | 116.7, 133.3, 116.8, 133.3, 116.8 | 133.3 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v1` | frame | chrome-dpr2 | 116.8, 116.8, 116.8, 133.3, 116.8 | 133.3 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v1` | frame | edge-dpr1 | 133.3, 133.2, 116.8, 149.9, 133.4 | 149.9 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v1` | frame | edge-dpr2 | 133.3, 133.4, 133.3, 116.8, 133.4 | 133.4 | ≤ 33.3 | miss |
| `e26-pointer-busy-10k/v1` | busy | chrome-dpr1 | 4936.9, 4806.1, 5040.6, 4769.7, 4635 | 5040.6 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | chrome-dpr2 | 4592.5, 4443.1, 4345.7, 4366.5, 4286 | 4592.5 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | edge-dpr1 | 4964.7, 5053.4, 4877, 4833.1, 4957.8 | 5053.4 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | edge-dpr2 | 4532.8, 4801.6, 4692.6, 4609.8, 4621.2 | 4801.6 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | chrome-dpr1 | 250.5, 337.3, 290.2, 259.8, 278.3 | 337.3 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | chrome-dpr2 | 351.8, 246.3, 243.3, 319.6, 256.8 | 351.8 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | edge-dpr1 | 312.6, 275.3, 318, 263.8, 276.4 | 318 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | edge-dpr2 | 338.6, 288.3, 278, 343, 258.7 | 343 | < 50 | miss |

## Findings

- **B1. The typical view runs at 15 fps.** The p95 is 66.7 ms, four vsyncs, in every configuration.
  - The per-run p95 of `encodeAndSubmitMs` is 45 to 52 ms.
  - The typical-view runs have 33 to 103 long tasks for 193 to 203 measured frames.
  - The frame's CPU time, prepare included, is three times the 16.7 ms budget. For comparison, U2's container observation put the renderer time of five gesture updates at 0.58 ms, down from 288.7 ms, so the scene-set cost is no longer the bound.
- **B2. The all-visible scenarios at DPR 2 and the stress scene run at 6 to 9 fps.**
  - At DPR 2, the all-visible scenarios have a p95 of 150 to 167 ms and an `encodeAndSubmitMs` p95 of 135 to 159 ms.
  - The stress scene has a p95 of 117 to 150 ms and an `encodeAndSubmitMs` p95 of 119 to 143 ms.
  - The stress scene has only rectangles and ellipses, with no stroke, clip or text, so even plain primitives cost about 12 µs each per frame.
- **B3. At DPR 1, the all-visible scenarios submit nothing.**
  - In `e26-mixed-all-edit-10k/v1` and `e26-mixed-all-pan-10k/v1` at DPR 1, each render callback takes about 6 s.
  - The window holds one or two intervals and two long tasks of 5.86 to 6.74 s. The backend records no `encodeAndSubmitMs` sample and `framesSubmitted` does not advance, so no frame reaches submission.
  - The same camera at DPR 2 submits every frame in about 150 ms.
  - The harness does not record backend diagnostics, so the cause is not known. The backend has three ways to skip a submission that fit the data: `prepare` returns a null packet (no diagnostic, `webgpu-backend.ts` `#renderFrame`), `prepare` throws (`RENDER_SUBMISSION_FAILED`), or the submission returns a status other than `submitted`. Why only DPR 1 is affected is a hypothesis until diagnosed.
  - It is filed for diagnosis first (last section).
- **B4. A multi-second task follows or contains each isolation.**
  - In all 20 busy runs, the one-time rejection's `e26-isolation` measure takes 97 to 103 ms (A06's single one-time case, diagnostic here).
  - In 18 of 20 runs, a 4.1 to 4.6 s long task starts 16 to 34 ms after the measure ends, outside it. In the other 2 (edge-dpr1 r2, edge-dpr2 r3), the isolation runs inside one 4.5 to 4.9 s long task, which the harness marks as overlapping the isolation and A05 therefore exempts. Either way it drives the busy runs' 4.3 to 5.1 s p95.
  - Its timing points to the first frame after isolation re-preparing most of the page, for example because the isolation's sets replace the prepared records of every unit they resend. At 10,634 nodes such a rebuild takes seconds, as E23 saw when a re-anchored primitive origin rebuilt every record. The profile (last section) confirms or rejects this.
  - The marked isolation is quick. In most runs the cost lands in the next frame, outside the A05 exemption.
- **B5. Pointer latency without background work is 240 to 350 ms.**
  - The plain variant has 127 to 153 samples per run, a per-run p95 of 243 to 352 ms, and long tasks of 60 to 94 ms during the drag.
  - Inferred, not measured: in on-demand mode a move's work-done point waits for the frame in progress and the next one, and each takes about 50 ms or more of CPU at the typical view (B1).
- **B6. The A05 autosave inputs.**
  - In every busy run, the `setStyle` write (500 ms trailing) starts during the press and takes 111 to 191 ms. This is the case U6a's gate defers.
  - In every run, both variants, the first write after the release starts 516 to 534 ms after the release was handled. That is the trailing delay, not "within one frame after pointer up", so the release does not yet flush the due write. U6a owns both.
  - No run had more than one no-change move. The CDP input queued as intended: 34 to 45 busy samples, and 127 to 153 plain samples, against 499 to 501 moves sent.

## What follows

- **U5 is likely.** Every frame scenario is over its ceiling and the frame's CPU time, prepare included, is over budget. Section 4.4's condition (prepare as a leading share) and section 8's GPU-share branch are decided by a CPU profile that splits prepare from encode and submit, which is U5's first step. B1 and B2 set its target. Section 2's risk applies: a U5 that does not fit E26 becomes its own item.
- **B3 is diagnosed before U5.** The next run should record the backend's diagnostics and submission status, which the harness now lacks (a follow-up for the harness).
- **B4 decides A05 for isolation.** Either isolation keeps the prepared records of units it did not change, or the first frame after it is bounded. It is part of U5's scope or of U3's follow-up, whichever the profile points to.
- **U6a** (the autosave gate and the flush on release) is unchanged by the baseline. B6 is its before state.
