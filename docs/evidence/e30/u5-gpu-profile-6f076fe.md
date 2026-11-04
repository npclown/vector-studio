# E30-U5: main-PC GPU profile of the frame passes (2026-11-04)

The L3 step that the [re-read at `af351d3`](u5-reread-af351d3.md) called for: what the GPU spends per frame in the v2 frame scenarios, now that the main thread's encode is no longer the leading cost. Contract: [section 4.3](../../plans/d9-e30-renderer-cost-contract.md#43-conditional-levers-u5-decided-by-u2s-split), L3.

## Method

- **Diagnostic build, never merged.** Branch `claude/e30-gpu-profile-diag` at `6f076fe`, which is `597591a` (main after #494; the renderer is `af351d3`'s) plus two diagnostic commits:
  - the browser device requests `timestamp-query` when the adapter offers it;
  - the native primitive scene gives every render pass `timestampWrites` and labels each pass by kind: `mask` (one per mask level tile), `layer` (one per isolated layer tile) and `main` (the frame's one primitive pass). Up to six readback buffers rotate, and a frame is not timed when all six are still mapped, so a row has fewer timed frames than prepares;
  - per timed frame it adds User Timing measures whose duration is the summed GPU time of each kind (`vs-gputs-mask`, `-layer`, `-main`), their sum (`-passes`), the span from the first pass's start to the last pass's end (`-span`, which also covers the GPU work between passes: the mask and layer tile copies and any gaps), and the pass counts (`vs-gputs-n-*`);
  - the E26 harness records every split key in a frame record.

  The first sitting, at `fffdad6`, collected these measures but its harness wrote only the four standard split keys, so it had no GPU timestamps; `6f076fe` fixed that, and the numbers below are from the `6f076fe` sitting.
- **Sitting.** Main PC DESKTOP-DKVUSAV (GTX 1660 SUPER, adapter `nvidia`/`turing`), Chrome 156.0.8078.81, 2026-11-04 at about 06:50Z.
  - `E26_REPETITIONS=1`, split on, `M8_N3_BASELINE` as in the re-reads.
  - `E26_SCENARIOS=e26-mixed-,e26-simple-stress-10k/v2`, run with `pnpm test:e26 --project chrome-dpr1-v2 --project chrome-dpr2-v2`. 8 passed, 6 skipped (the v1 mixed scenarios, which the prefix also selects and which run only in the v1 projects), 5.2 min.
  - No other browser windows were open.
  - Separately, a headed Chrome on the same build logged `[e30-gputs] timestamp-query enabled`.
- **Raw records.** They are kept on the PC at `D:\GIT\e30-gpuprof-6f076fe` and are not in the repository, because a diagnostic build is not evidence for a gate row. The timestamps are Chrome's, which are quantized. Read the numbers as an attribution of GPU time, not as a timing claim.

## Per-frame GPU time by pass kind

Median of the timed frames, from one run each. In the GPU pass columns (main, mask, layer, passes, span) the p95 is within 1.3 ms of the median in every cell; prepare and submit vary more (pan prepare p95 28.3 and 37 ms). Frame time is `rafCallbackIntervalMs` p95.

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

- **GPU pass time is measured; that the all-visible rows are GPU-bound is the reading.**
  - All-visible edit: the passes sum to 36.5 to 41.2 ms (span 37.0 to 41.7) against about 16 ms of main-thread prepare plus submit. The frames take 50.0 ms, three 60 Hz refreshes.
  - Pan: the passes sum to 44.7 to 51.5 ms (span 50.8 to 57.8) against about 28 to 32 ms. The frames take 66.7 ms, four refreshes.
  - Each frame takes the first whole refresh after its GPU span, which is how a GPU-bound frame lands. Nothing here times the presentation itself, so this is a reading, not a measurement.
  - The frame times sit on whole refreshes in this sitting (16.8, 50.0, 66.7 ms). The `af351d3` re-read had 18.1 ms; a user Chrome window was open during that sitting and none during this one. That difference is the likely cause, not established.
- **The main pass scales with the drawn content, not the pixels.** We read this as per-item cost; it is not split further.
  - The main pass takes 35.2 ms at DPR 1 and 39.8 ms at DPR 2 in all-visible edit. Four times the pixels at the same 4x sample count add 13 %.
  - On the same target the typical view's main pass takes about 5.5 ms and stress's under 1 ms.
  - The pass is not bound by fill rate. What it is bound by within the drawn items is not measured: the draw calls, the mesh stencil-and-cover per path, or vertex work.
  - The encoder already switches pipelines only at a variant change and binds a clip state only when it changes. So removing redundant state calls, the in-E30 kind of L3 remedy, has little left to take. The draw counts per frame were not re-read for the v2 page after the U1c correction, so no per-draw figure is given here.
- **Pan adds about 9 to 10 ms of mask passes.** These are 595 mask passes (8.7 and 10.5 ms), one per level tile, re-rendered every frame because masked levels move with the camera. Span minus the pass sum adds about 6 ms of GPU time between passes, the tile copies included.
- **`vs-gpu` is much longer than a frame's GPU work in the all-visible rows. This is an estimate.**
  - `vs-gpu` runs from a frame's submit end to its `onSubmittedWorkDone()`. In the all-visible rows it is 218 to 348 ms in the median, which is 5.0 to 6.0 times the frame's GPU span, or about four to five frame intervals.
  - That is consistent with several frames of work queued ahead of each sample. It is also consistent with completion being reported late (delivery or presentation waits). The passes leave the GPU about 20 % idle at a 50 ms frame, which does not by itself explain a standing queue that deep.
  - In the typical view `vs-gpu` is 19 ms against 6 ms of passes per 16.7 ms frame. That is about one frame interval plus its own work, so no deep queue is shown.
  - Whether this delay is in the pointer rows' claim-to-work-done time is not measured here, because the pointer rows were not run.

## L3 decision

- **No GPU-side remedy merges in E30.** The GPU cost is not split below the pass, so there is no measured leading cost to take, and the in-scope kind of L3 remedy (redundant state calls) is largely taken already (above).
- **The remedies that a split would point to are of the kind section 4.3 writes up as its own item first:**
  - batching or instancing across paints;
  - a merged draw list that changes draw order;
  - stencil-and-cover for many paths in one pass;
  - render bundles;
  - for pan, mask tiles kept under a camera translation.
- **They are written up as E34** in the [rendering track](../../plans/d9-rendering-track.md), whose first step is the split by draw kind on the PC.
- **The remaining all-visible miss goes to the exit card** under E30-Q3 (a), with this attribution:
  - edit: the GPU's main pass, about 35 to 40 ms per frame on the reference GPU;
  - pan: the same main pass, plus about 9 to 10 ms of mask passes and about 6 ms between passes.
- **A frames-in-flight cap is named in E34 as a candidate, not taken here.** It would submit the next frame only when the GPU has drained to one or two frames, and it changes no drawing. It changes the backend's frame pacing, so it needs its own oracle and PC run. It is worth taking only if the `vs-gpu` delay turns out to be a real queue in the latency rows.
- **What comes next.** U6, the PC verdict record with `E26_SPLIT=0` at E30's last head, records PA-A01 to A04 with this attribution.
