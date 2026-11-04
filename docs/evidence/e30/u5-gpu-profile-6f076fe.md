# E30-U5: main-PC GPU profile of the frame passes (2026-11-04)

The L3 step that the [re-read at `af351d3`](u5-reread-af351d3.md) called for: what the GPU spends per frame in the v2 frame scenarios, now that the main thread's encode is no longer the leading cost. Contract: [section 4.3](../../plans/d9-e30-renderer-cost-contract.md#43-conditional-levers-u5-decided-by-u2s-split), L3.

## Method

- **Diagnostic build, never merged.** Branch `claude/e30-gpu-profile-diag` at `6f076fe`, which is `597591a` (main after #494; the renderer is `af351d3`'s) plus two diagnostic commits:
  - the browser device requests `timestamp-query` when the adapter offers it;
  - the native primitive scene gives every render pass `timestampWrites` and labels each pass by kind: `mask` (one per mask level tile), `layer` (one per isolated layer tile) and `main` (the frame's one primitive pass). Up to six readback buffers rotate, and a frame is not timed when all six are still mapped, so a row has fewer timed frames than prepares;
  - per timed frame it adds User Timing measures whose duration is the summed GPU time of each kind (`vs-gputs-mask`, `-layer`, `-main`), their sum (`-passes`), the span from the first pass's start to the last pass's end (`-span`, which also covers the mask tile copies between passes), and the pass counts (`vs-gputs-n-*`);
  - the E26 harness records every split key in a frame record.

  The first sitting, at `fffdad6`, collected these measures but its harness wrote only the four standard split keys, so it had no GPU timestamps; `6f076fe` fixed that, and the numbers below are from the `6f076fe` sitting.
- **Sitting.** Main PC DESKTOP-DKVUSAV (GTX 1660 SUPER, adapter `nvidia`/`turing`), Chrome 156.0.8078.81, 2026-11-04 at about 06:50Z.
  - `E26_REPETITIONS=1`, split on, `M8_N3_BASELINE` as in the re-reads.
  - `E26_SCENARIOS=e26-mixed-,e26-simple-stress-10k/v2`, run with `pnpm test:e26 --project chrome-dpr1-v2 --project chrome-dpr2-v2`. 8 passed, 6 skipped (the v1 rows and the pointer rows, which have no frame passes to time), 5.2 min.
  - No other browser windows were open.
  - Separately, a headed Chrome on the same build logged `[e30-gputs] timestamp-query enabled`.
- **Raw records.** They are kept on the PC at `D:\GIT\e30-gpuprof-6f076fe` and are not in the repository, because a diagnostic build is not evidence for a gate row. The timestamps are Chrome's, which are quantized. Read the numbers as an attribution of GPU time, not as a timing claim.

## Per-frame GPU time by pass kind

Median of the timed frames, from one run each. The p95 is within 1.3 ms of the median in every cell except `vs-gpu`. Frame time is `rafCallbackIntervalMs` p95.

| Scenario | DPR | frame p95 | prepare / submit median | `vs-gpu` median | main pass | mask passes (count) | layer passes (count) | passes sum | span |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mixed-view-edit/v2` | 1 | 16.8 | 2.3 / 1.2 | 19.1 | 5.62 | 0 (0) | 0.28 (5) | 5.89 | 5.99 |
| `mixed-view-edit/v2` | 2 | 16.8 | 2.3 / 1.2 | 19.1 | 5.38 | 0 (0) | 0.33 (5) | 5.71 | 5.89 |
| `mixed-all-edit/v2` | 1 | 50.0 | 9.3 / 6.2 | 217.7 | 35.23 | 0 (0) | 1.31 (23) | 36.54 | 37.01 |
| `mixed-all-edit/v2` | 2 | 50.1 | 9.8 / 6.3 | 250.5 | 39.76 | 0 (0) | 1.41 (23) | 41.17 | 41.73 |
| `mixed-all-pan/v2` | 1 | 66.6 | 14.6 / 13.3 | 254.2 | 34.75 | 8.66 (595) | 1.31 (23) | 44.71 | 50.81 |
| `mixed-all-pan/v2` | 2 | 66.7 | 17.8 / 14.0 | 347.7 | 39.51 | 10.49 (595) | 1.41 (23) | 51.45 | 57.78 |
| `simple-stress/v2` | 1 | 16.8 | 2.4 / 0.6 | 4.1 | 0.76 | 0 (0) | 0 (0) | 0.76 | 0.76 |
| `simple-stress/v2` | 2 | 16.8 | 2.5 / 0.6 | 3.9 | 0.53 | 0 (0) | 0 (0) | 0.53 | 0.53 |

All times are in ms.

## Reading

- **The all-visible rows are GPU-bound, and this is now measured, not inferred.**
  - In all-visible edit, a frame's passes take 37 to 42 ms on the GPU while the main thread spends about 16 ms on prepare plus submit. The frame takes 50 ms, which is three 60 Hz refreshes: the first refresh after a 37 to 42 ms GPU frame.
  - In pan, the passes take 51 to 58 ms against about 28 to 32 ms on the main thread. The frame takes 66.7 ms, which is four refreshes.
  - In this sitting the frame times sit on whole refreshes: 16.8, 50.0 and 66.7 ms, against 18.1 ms in the `af351d3` re-read.
- **The main pass is the cost, and it scales with the drawn content, not the pixels.**
  - The main pass alone takes 35.2 ms at DPR 1 and 39.8 ms at DPR 2 in all-visible edit. Four times the pixels at DPR 2, at the same 4x sample count, add only 13 %.
  - The typical view's main pass takes about 5.5 ms on the same target, and stress's one large instanced draw takes 0.5 to 0.8 ms.
  - So the all-visible pass is not bound by fill rate. Its cost tracks the work per drawn item. U1's container counters for the v2 page at F counted about 2,400 primitive draws, 2,500 mesh draws and 2,300 glyph instances per packet. The timings of that entry were withdrawn by the U1c correction; the counts describe the packet, which the acknowledgement fault did not change, but they were not re-read on the PC. The item is not profiled further than the pass, so which of the per-draw work costs most is the next measurement: state changes per draw, mesh stencil-and-cover per path, or vertex work.
- **The pan row's mask passes add 9 to 10 ms.** That is 595 mask passes, one per level tile, re-rendered every frame because masked levels move with the camera. The copies between them add another 6 ms of span.
- **`vs-gpu` holds several frames of queued work.**
  - All-visible: 218 to 348 ms in the median, against 37 to 58 ms of GPU work per frame, so about four to six frames are in flight when a sample is taken.
  - The typical view: 19 ms, against 6 ms per frame, so about three frames.
  - This queue depth adds to the pointer latency rows' claim-to-work-done time, whatever the GPU's per-frame cost.

## L3 decision

- **No GPU-side remedy merges in E30.** Contract section 4.3 says a GPU remedy that needs a new pipeline, render bundles or draw batching that changes draw order is written up as its own item first. This profile shows that the all-visible main pass is per-draw bound, and every remedy that cuts per-draw cost at about 7,000 drawn items (glyphs included) is of that kind:
  - batching or instancing across paints;
  - fewer pipeline and bind-group switches through a sorted or merged draw list;
  - stencil-then-cover for many paths in one pass;
  - render bundles.
- **The remedy is written up as E34** in the [rendering track](../../plans/d9-rendering-track.md), with this record as its starting point.
- **The remaining all-visible miss goes to the exit card** under E30-Q3 (a) with this attribution: the GPU's main pass, about 35 to 40 ms per frame on the reference GPU.
- **A frames-in-flight cap is named as a candidate in E34, not taken here.** It would mean submitting the next frame only when the GPU has drained to one or two frames. It changes no drawing, and it bears on the pointer rows' claim-to-work-done time through the queue depth above. It changes the backend's frame pacing, which E26 and E30's latency rows depend on, so it gets its own oracle and PC run.
- **What comes next.** U6, the PC verdict record with `E26_SPLIT=0` at E30's last head, records PA-A01 to A04 with this attribution.
