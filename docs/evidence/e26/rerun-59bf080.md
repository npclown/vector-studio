# E26 PC re-run after U5d at `59bf080` (2026-10-31)

This is the re-run of the [E26 contract](../../plans/d9-e26-pointer-priority-contract.md) section 4.4.1 ("After U5d-3, the PC runs every scenario again"): all of `pnpm test:e26` after U5d-1 (#422), U5d-3 (#424) and U5d-2 (#425), on the same PC and with the same procedure as the [baseline](baseline-bc071b0.md) and the [early run](early-127fba3.md).

## Run

- **Machine.** Reference PC DESKTOP-DKVUSAV (NVIDIA Turing), Chrome 156.0.8078.74 and Edge 156.0.4314.50, headed, Node 24.22.1.
- **Commit.** `59bf080` (main; it includes U5d-2's `48e35b7`), with a clean tracked tree (every record has `dirty: false`).
- **Time.** 2026-10-31, 19:03 to 20:04 KST (1.0 h, against the early run's 1.2 h).
- **Tests.** 120 of 120 passed; none failed or was flaky, and every run is valid. The same four console errors as in the earlier runs (one 404 resource in the first run of each project) do not invalidate a run.
- **Records.** The 120 records are in [rerun-59bf080/runs/](rerun-59bf080/runs/), with the name list `runs/files.txt`. [rerun-59bf080/summary.json](rerun-59bf080/summary.json) is the output of `node tooling/e26-summarize.mjs`.

## Results

Maximum per-run p95, in ms, by nearest rank. The early run's maximum is in brackets. `encodeAndSubmitMs` is the per-run p95 range (the early run's in brackets).

| Scenario | Ceiling | chrome-dpr1 | chrome-dpr2 | edge-dpr1 | edge-dpr2 | `encodeAndSubmitMs` p95 |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v1` | ≤ 16.7 | 16.9 [33.5] | 16.8 [33.9] | 16.8 [33.4] | 16.8 [50.1] | 9.0 to 11.7 [12.3 to 25.7] |
| `e26-mixed-all-edit-10k/v1` | ≤ 33.3 | 66.7 [116.7] | 66.7 [150.1] | 66.7 [116.8] | 66.7 [166.5] | 47.1 to 55.9 [67.2 to 124] |
| `e26-mixed-all-pan-10k/v1` | ≤ 33.3 | 100.1 [183.4] | 66.8 [116.7] | 66.8 [150.1] | 83.2 [233.6] | 62.2 to 92.7 [103.8 to 233.4] |
| `e26-simple-stress-10k/v1` | ≤ 33.3 | **16.8** [83.4] | **16.8** [50.1] | **16.8** [83.4] | **16.8** [66.7] | 10.0 to 11.3 [49 to 78.6] |
| `e26-pointer-busy-10k/v1` busy | < 50 | 284 [425.7] | 226.8 [279.9] | 242.8 [436.8] | 229.6 [295.8] | n/a |
| `e26-pointer-busy-10k/v1` plain | < 50 | 226.6 [245.7] | 237 [197.6] | 186 [277.1] | 235.5 [185.6] | n/a |

## Findings

- **The stress scenario passes** (E26-A03's stress row) in every project, at one vsync: its median and p95 are 16.7 to 16.8 ms, with no long task over 50 ms.
- **The typical view holds one vsync.** Every run's median is 16.7 ms and its p95 16.8 to 16.9 ms, against an idle rAF median of 16.7 ms; `encodeAndSubmitMs` p95 is 9 to 12 ms. E26-A02 still fails, by 0.1 to 0.2 ms of vsync interval jitter, because the ceiling has no rounding allowance (section 3.2). A frame-budget miss would show as 33.3 ms intervals, which appear only at p99.
- **The all-visible scenarios still miss by about 2x.** Their medians are 50 ms (edit) and 66.7 ms (pan), every run has 121 to 182 long tasks over 50 ms, and `encodeAndSubmitMs` p95 alone (47 to 93 ms) is over the 33.3 ms ceiling, so the frames are still bound by CPU work per frame. The container profile after U5d-2 puts what is left of the one-leaf edit in the pipeline's per-path pass on path edits, the incremental derivation and the mesh part, and the pan and zoom frame in the per-path pass under a new frame key (every path is evaluated again), the packing assessment and the mask plan.
- **Pointer latency is unchanged in kind.** Medians are 56 to 80 ms with or without the `setFill` and the rejection, so the latency is not the isolation's (120 to 147 ms, once per run) but the steady drag path. The plain variant has no long task over 50 ms at all. In the busy variant one autosave write starts during the press and the first write after pointer up starts about 520 ms later: that is E26-A05's autosave gate (U6a), not yet built.
