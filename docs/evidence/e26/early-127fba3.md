# E26 early PC run at `127fba3` (2026-10-31)

This is the early run of the [E26 contract](../../plans/d9-e26-pointer-priority-contract.md) section 4.4.1 (U5d): all of `pnpm test:e26`, after U5a, U5b and U5c, on the same PC and with the same procedure as the [baseline](baseline-bc071b0.md). U5d takes its next lever from this run.

## Run

- **Machine.** Reference PC DESKTOP-DKVUSAV (NVIDIA Turing), Chrome 156.0.8078.74 and Edge 156.0.4314.50, headed, Node 24.22.1.
- **Commit.** `127fba3`, with a clean tracked tree (every record has `dirty: false`).
- **Time.** 2026-10-31, 14:01 to 15:13 KST (1.2 h, against the baseline's 1.3 h).
- **Tests.** 120 of 120 passed; none failed or was flaky, and every run is valid. The first run of each project (mixed-view-edit, repetition 1) logs one console error for a 404 resource. The baseline has the same four, and they do not invalidate a run.
- **Records.** The 120 records are in [early-127fba3/runs/](early-127fba3/runs/), with the name list `runs/files.txt`. [early-127fba3/summary.json](early-127fba3/summary.json) is the output of `node tooling/e26-summarize.mjs`.

## Results

Maximum per-run p95, in ms, by nearest rank. The baseline's maximum is in brackets. `encodeAndSubmitMs` is the per-run p95 range, and it includes the primitive packet's `prepare`.

| Scenario | Ceiling | chrome-dpr1 | chrome-dpr2 | edge-dpr1 | edge-dpr2 | `encodeAndSubmitMs` p95 |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v1` | ≤ 16.7 | 33.5 [66.7] | 33.9 [66.7] | 33.4 [66.7] | 50.1 [66.6] | 12.3 to 25.7 |
| `e26-mixed-all-edit-10k/v1` | ≤ 33.3 | 116.7 [6216.7] | 150.1 [166.6] | 116.8 [6450] | 166.5 [166.6] | 67.2 to 124 |
| `e26-mixed-all-pan-10k/v1` | ≤ 33.3 | 183.4 [6749.9] | 116.7 [166.7] | 150.1 [6566.6] | 233.6 [150.1] | 103.8 to 233.4 |
| `e26-simple-stress-10k/v1` | ≤ 33.3 | 83.4 [133.3] | 50.1 [133.3] | 83.4 [149.9] | 66.7 [133.4] | 49 to 78.6 |
| `e26-pointer-busy-10k/v1` busy | < 50 | 425.7 [5040.6] | 279.9 [4592.5] | 436.8 [5053.4] | 295.8 [4801.6] | n/a |
| `e26-pointer-busy-10k/v1` plain | < 50 | 245.7 [337.3] | 197.6 [351.8] | 277.1 [318] | 185.6 [343] | n/a |

## Findings

- **Every row still misses its ceiling.** The frame scenarios are still bound by CPU work per frame, and `encodeAndSubmitMs` alone is over the ceiling in every frame row except the typical view at DPR 1.
- **B3 and B4 are gone.**
  - At DPR 1 the all-visible frames drop from about 6 s to 100 to 183 ms.
  - The 4.1 to 4.9 s long task after each isolation no longer appears; the busy p95 drops from 4.3 to 5.1 s to 0.17 to 0.44 s.
- **The typical view runs at two vsyncs, not four.** Its median is 33.3 ms in every run, and its `encodeAndSubmitMs` p95 is 12 to 26 ms, so the frame now misses 16.7 ms by a few milliseconds of CPU work.
- **One row is worse than the baseline.** The all-visible pan at Edge DPR 2 has a maximum of 233.6 ms against 150.1. Its `encodeAndSubmitMs` p95 varies from 159 to 233 ms across runs. It is the most zoom-heavy row, so the cause to check first is the per-zoom cost below.

## Container profile (what U5d takes)

The prepare of the M1-A13 and stress pages was profiled at the fitted view, as the all-visible scenarios use it, at DPR 1 and 2. The frames were: no change, a one-leaf edit, and the pan and zoom path of section 3.3. Packets were acknowledged and the real geometry ports were used. Medians in ms, on the container:

| Page | DPR | No change | One-leaf edit | Pan and zoom |
| --- | --- | --- | --- | --- |
| M1-A13 | 1 | 47.9 | 54.1 | 172 |
| M1-A13 | 2 | 48.9 | 51.5 | 131 |
| stress | 1 | 4.2 | 8.1 | 103 |
| stress | 2 | 4.6 | 8.4 | 103.7 |

A CPU profile of the pan and zoom frames splits the cost as follows:

- **Packing assessment.** On every camera change, every visible primitive is assessed. That is 74% of the stress page's frame and 27% of the M1-A13 page's. The cost is mostly the clipping of each triangle against the viewport.
- **Path buckets.** Tolerance buckets are recomputed for every visible path whenever the zoom changes, in exact dyadic arithmetic. That is 16% of the M1-A13 page's frame.
- **Per-draw work.** The rest is spent on each visible draw, even when nothing changed: the mesh part of the packet (`#prepareMeshPart`, the mesh packer), clip admission and planning, and the residency check on kept outcomes. That is most of the M1-A13 page's no-change frame of about 48 ms.

U5d takes these as three units, in that order (section 4.4.1, "U5d in three units").
