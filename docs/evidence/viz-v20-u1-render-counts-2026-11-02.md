# V20-U1 right-column render counts (2026-11-02)

Unit V20-U1 of the [V-20 contract](../plans/viz-v20-right-column-contract.md#5-units): how often the right column renders per step before any V-20 lever. Counts only, no timing claim.

## Method

- Counters: `@vector-studio/ui`'s package-internal render probe (`packages/ui/src/render-probe.ts`) calls `globalThis.__vsRenderProbe` once per render of `LayerTree` (`layers`), each layer row it renders (`layer-row`), `PropertyPanel` (`properties`), its `AppearancePanel` section (`appearance`), `EditorPanels` (`panels`) and the bench aside (`aside`). Only the bench page (`?bench=1`) installs the probe, and `__e26Bench.renders()` reads the counts. Without the bench the call does nothing.
- Spec: `pnpm test:v20-count` (`playwright.v20-count.config.ts`, `tests/v20/v20-render-count.spec.ts`), on the next-host production build, headless Chromium at 1600 x 1000 and DPR 1. It loads each v2 document with `?bench=1&ui=1&doc=`, sets the scenario's camera and clicks its layer toggles as the E26/M9 harness does. Then it runs 30 steps, 16.7 ms apart on the scenario clock, and waits two animation frames after each step. The steps are either `setViewport` along `panZoomCamera` or the edit drag sent as `input` pointer events (down, 30 moves, up) through `__e26Bench.editor()`. It does not wait for the renderer. WebGPU is unavailable in the container, so the renderer is in its error state (`data-renderer="error"`). The column does not depend on the renderer.
- Code: product code equal to `ecfd0f5`, the head the contract names. `packages/` and `apps/` have no differences between `ecfd0f5` and `f4add96`. The only additions are this unit's probe calls and bench reader, which change no behavior. The records' `commit` field shows the docs-only branch head the run was made on, and `dirty: true` for the uncommitted probe.
- Environment: cloud container, Chromium 153.0.8010.12 headless.

## Results

Renders per step after the first step. Each row's value was the same on every step: the minimum equals the maximum.

| Scenario (v2)                | Steps         | Layer rows (mounted) | `layers` | `layer-row` | `properties` | `appearance` | `panels` |
| ---------------------------- | ------------- | -------------------- | -------- | ----------- | ------------ | ------------ | -------- |
| `e26-simple-stress-10k/v2`   | camera, 30    | 10,000 (10,000)      | 1        | 10,000      | 1            | 1            | 1        |
| `e26-mixed-all-pan-10k/v2`   | camera, 30    | 655 (655)            | 1        | 655         | 1            | 1            | 1        |
| `e26-mixed-view-edit-10k/v2` | drag, 1+30+1  | 655 (655)            | 1        | 655         | 1            | 1            | 1        |

Records: [`viz-v20-u1/`](viz-v20-u1/), one JSON file per scenario with the per-step deltas and mounted rows.

## Reading

- V20-A01's baseline: every camera-only step renders `LayerTree`, `PropertyPanel` and `EditorPanels` once. V20-A01 requires 0 after the first step.
- V20-A02's baseline: the list mounts every row (10,000 on stress, 655 on the expanded v2 tree). Every step, camera or drag, renders every row again.
- This confirms the cause that contract section 2 derived from the code: the page re-renders on every editor event, and the unmemoized column re-renders everything under it. Levers L1 to L3 (V20-U2) address these three counts.
