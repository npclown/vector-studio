# P0.5a headed foundation evidence

Status: P0-A13, P0-A14 and P0-A15 PASS for the measured source; full P0 gate remains open.

## Provenance and reproduction

- Source: `11314b52ddb23f6d43c69d5cce20870caa9fb211`, feature branch `codex/p0-5a-unit-foundation`; preserve with tag `evidence/p0.5a-20260909-061400`. All ten JSON records report `sourceWorktree: clean` and no source changes. Later commits only index these observations and update the plan.
- Command: `pnpm test:gpu` with `P0_EVIDENCE_OUTPUT_DIR=docs/evidence/p0.5a/2026-09-09T061400Z`; PASS, 10 tests in 17.1 s. To reproduce, check out the measured source and choose a new output directory: writers refuse overwrites.
- Environment: Windows `10.0.26200` x64, Node `24.15.0`, pnpm `11.1.2`, Playwright `1.62.1`. Chrome `152.0.7977.83`, Edge `152.0.4191.66`, headed hardware WebGPU with `--enable-unsafe-webgpu`. Adapter reports NVIDIA / Turing; adapter description is not exposed. Per-run limits and selected features are in each JSON.
- Fixture records were captured on 2026-09-09 between `06:13:54.445Z` and `06:14:05.180Z` (local timezone Asia/Seoul, UTC+09:00). The directory suffix is the run identity; individual records own exact observation timestamps.
- This is a development-server correctness run, not a production benchmark. DPR is browser-context emulation at 1, 1.5 and 2. Captured framebuffer pixels are not physical-display presentation timestamps. All six fixtures selected 4x MSAA without fallback.
- [Owning execution contract](../../../plans/p0-webgpu-foundation.md#t006b-headed-foundation-evidence-contract-2026-09-09), [validation policy](../../../validation.md), [headed test](../../../../tests/gpu/foundation-experiments.spec.ts), and [independent PNG reader](../../../../tests/support/foundation-image.ts).

## A13: camera and rendered coordinates

Fixed document vertices are `(0,0)`, `(100,0)`, `(0,60)` with camera position `(-20,-10)` and zoom `1.5`. The CSS canvas is 640x360, anchored at `(44,84)` with no canvas border/radius/transform. The oracle decodes the captured PNG, classifies foreground by `max(R,G,B)>80`, derives vertices from foreground bounds, checks literal expected coordinates within one physical pixel, and checks interior/exterior samples. Runtime position snapshots are supplementary evidence, not the image oracle.

| DPR | PNG dimensions | Literal expected vertices     | Observed vertices, both browsers and both stages | Maximum coordinate error | Records                                                                                                              |
| --- | -------------- | ----------------------------- | ------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | 640x360        | `[30,15,180,15,30,105]`       | `[30,15,180,15,30,105]`                          | 0 px                     | [Chrome](foundation-camera-triangle-v1-dpr-1-chrome.json), [Edge](foundation-camera-triangle-v1-dpr-1-edge.json)     |
| 1.5 | 960x540        | `[45,22.5,270,22.5,45,157.5]` | `[45,22,270,22,45,157]`                          | 0.5 px                   | [Chrome](foundation-camera-triangle-v1-dpr-1-5-chrome.json), [Edge](foundation-camera-triangle-v1-dpr-1-5-edge.json) |
| 2   | 1280x720       | `[60,30,360,30,60,210]`       | `[60,30,360,30,60,210]`                          | 0 px                     | [Chrome](foundation-camera-triangle-v1-dpr-2-chrome.json), [Edge](foundation-camera-triangle-v1-dpr-2-edge.json)     |

All initial/recovered screenshot pairs have identical SHA-256 hashes. Primary reviewed all numeric records and representative PNGs from both browsers. The raw files remain unchanged after capture.

| DPR | Chrome initial / recovered                                                                                                                    | Edge initial / recovered                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [Initial](foundation-camera-triangle-v1-dpr-1-chrome-initial.png) / [Recovered](foundation-camera-triangle-v1-dpr-1-chrome-recovered.png)     | [Initial](foundation-camera-triangle-v1-dpr-1-edge-initial.png) / [Recovered](foundation-camera-triangle-v1-dpr-1-edge-recovered.png)     |
| 1.5 | [Initial](foundation-camera-triangle-v1-dpr-1-5-chrome-initial.png) / [Recovered](foundation-camera-triangle-v1-dpr-1-5-chrome-recovered.png) | [Initial](foundation-camera-triangle-v1-dpr-1-5-edge-initial.png) / [Recovered](foundation-camera-triangle-v1-dpr-1-5-edge-recovered.png) |
| 2   | [Initial](foundation-camera-triangle-v1-dpr-2-chrome-initial.png) / [Recovered](foundation-camera-triangle-v1-dpr-2-chrome-recovered.png)     | [Initial](foundation-camera-triangle-v1-dpr-2-edge-initial.png) / [Recovered](foundation-camera-triangle-v1-dpr-2-edge-recovered.png)     |

The [17 numeric camera tests](../../../../tests/unit/camera.test.ts) supply inverse/composition/invalid-input and domain coverage. Combined result: **P0-A13 PASS**.

## A14 and A15: ownership, reuse and recovery

Every fixture JSON contains initial, steady, recovered and disposed snapshots:

- Shared backing capacity is 256 bytes with alignment 4. Position allocation is ID 1, offset 0, 24 bytes; color allocation is ID 2, offset 24, 36 bytes. Requested/allocated/reserved/peak-reserved bytes are 60, with two non-overlapping live ranges. GPU accounting records one 256-byte buffer, not an additional 60-byte allocation charge.
- Each steady interval adds six submitted/completed frames without increasing backing-buffer creations, pipeline creations or pipeline requests. Two compatible initial pipeline requests produce one successful cached native pipeline.
- Deliberate device destruction advances generation 1 to 2 once, retains allocation descriptors and fixed CPU vertices, and reconstructs one backing buffer and one pipeline. Cumulative creation counts are 2; live counts remain 1; cache ready count is 1 and pending count is 0.
- Disposal clears allocator live/retired/reserved bytes, native buffer/pipeline ownership, cache ready/pending entries, and all backend live resource counts/bytes to zero. Diagnostics are exactly loss detected, recovery started, recovery succeeded and disposal completed; no unexpected diagnostics or page errors occurred.

[Allocator unit fixtures](../../../../tests/unit/shared-buffer-allocator.test.ts) cover exhaustion, invalid/double free, retirement until submitted GPU work completes, generation changes and disposal. [Cache unit fixtures](../../../../tests/unit/pipeline-cache.test.ts) cover incompatible key dimensions, concurrent reuse, rejection/retry and stale-generation completion. [Native integration fixtures](../../../../tests/unit/native-foundation-integration.test.ts) verify actual subrange bindings, complete pipeline recipes, 4x-to-1x fallback, completion coalescing and late resource cleanup. Headed fixtures exercise the integrated real draw; they do not allocate artificial incompatible pipelines. Combined results: **P0-A14 PASS; P0-A15 PASS**.

## Other validation and limits

- Final source `pnpm check`: PASS, 13 files / 109 unit and contract tests, formatting, lint, TypeScript and boundaries. `pnpm build`: PASS. `pnpm test:browser`: PASS, 10 tests / 11.4 s. Routine headed validation before the clean-source capture: PASS, 10 tests / 16.6 s.
- Existing headed [Chrome recovery](recovery-chrome.json) / [Edge recovery](recovery-edge.json) and [Chrome dashboard](dashboard-chrome.json) / [Edge dashboard](dashboard-edge.json) cases also pass in this capture. Their artifacts are [Chrome recovered scene](recovered-chrome.png), [Edge recovered scene](recovered-edge.png), [Chrome dashboard](dashboard-chrome.png) and [Edge dashboard](dashboard-edge.png).
- Primary review corrected two test/fixture issues before the measured commit: a wait that missed the final queued RAF, and fractional screenshot clipping from centered layout after scrollbar growth. The active plan records those failed local attempts and corrections. The fixed acceptance thresholds were retained.
- No benchmark, native hardware OOM induction, physical-display presentation timing or final P0 gate evaluation was performed. P0.6 must still review all criteria/scenarios on the appropriate source and environment; this evidence does not authorize P1.
