# P0.5 smoke evidence: 2026-09-06

Status: Reviewed orchestration evidence; not a performance baseline

## Source and commands

- Source revision: `59d103f655ec9b4ee5549ce252c4960bffa94f3b`
- Source state at capture: clean
- Benchmark: `pnpm benchmark:p0 -- --profile smoke --output-dir docs/benchmarks/results`
- Headed dashboard/recovery: `$env:P0_EVIDENCE_OUTPUT_DIR = 'docs/evidence/p0.5/2026-09-06-smoke-59d103f'; pnpm test:gpu`
- Environment: Windows 10 x64, NVIDIA Turing adapter, Chrome 140.0.7339.82, Edge 140.0.3485.54; exact per-run fields are in the JSON records.

## Review

- Benchmark runner: PASS, 2/2 browser projects in 9.1 seconds after the production build.
- Result inspection: PASS, 10 JSON plus 10 matching Markdown records covering five scenarios in Chrome and Edge. All records use schema `vector-studio/p0-benchmark-result/v1`, runner `vector-studio/p0-runner/v1`, profile `smoke`, Exploratory status, clean source provenance, and ordered `performance.now` windows.
- Diagnostics and bounded collection: PASS, zero unexpected diagnostics and zero dropped samples across the ten repetitions.
- Headed evidence suite: PASS, 4/4 tests in 7.5 seconds. Four JSON records report clean source state and zero page errors; four matching PNGs were created without replacing prior evidence.
- Visual inspection: PASS, both dashboard captures show a visible gradient triangle and current backend state, generation, adapter, 640 x 360 DPR-1 surface, sample count, frame/resource/listener counters, stopped timing summary, controls, and the expected validation diagnostic.

## Dashboard and recovery artifacts

- Chrome: [dashboard](dashboard-chrome.png), [dashboard record](dashboard-chrome.json), [recovered surface](recovered-chrome.png), [recovery record](recovery-chrome.json)
- Edge: [dashboard](dashboard-edge.png), [dashboard record](dashboard-edge.json), [recovered surface](recovered-edge.png), [recovery record](recovery-edge.json)

## Benchmark records

Each Markdown record has a matching raw JSON file with the same base name.

- Chrome: [startup](../../../benchmarks/results/20260905T173305.920Z_p0-startup-v1_chrome_desktop-dkvusav_c4109d3e-9d7e-4261-b650-53c319e9eebe.md), [steady foundation](../../../benchmarks/results/20260905T173306.693Z_p0-steady-foundation-v1_chrome_desktop-dkvusav_8f1c3912-a38a-44ee-8117-bf14e2c00109.md), [idle invalidation](../../../benchmarks/results/20260905T173307.071Z_p0-idle-invalidation-v1_chrome_desktop-dkvusav_38262ce0-3469-4bf6-86e6-2724d2dabc8b.md), [resize storm](../../../benchmarks/results/20260905T173307.496Z_p0-resize-storm-v1_chrome_desktop-dkvusav_ed21cb5a-e4aa-4792-a7ee-560892af46c1.md), [lifecycle recovery](../../../benchmarks/results/20260905T173307.867Z_p0-lifecycle-recovery-v1_chrome_desktop-dkvusav_7f99edfa-7cb3-48e4-8619-59052eaabca2.md)
- Edge: [startup](../../../benchmarks/results/20260905T173309.891Z_p0-startup-v1_edge_desktop-dkvusav_0b360467-f728-41e1-a7c2-84b381edfb95.md), [steady foundation](../../../benchmarks/results/20260905T173310.711Z_p0-steady-foundation-v1_edge_desktop-dkvusav_0c6a8290-fdaf-43d7-86b2-c091dfbad7f1.md), [idle invalidation](../../../benchmarks/results/20260905T173311.095Z_p0-idle-invalidation-v1_edge_desktop-dkvusav_6f111400-1d8a-4cf8-90e8-cf83d7033d47.md), [resize storm](../../../benchmarks/results/20260905T173311.513Z_p0-resize-storm-v1_edge_desktop-dkvusav_005d5874-3ebf-4df9-8df4-a148aef55424.md), [lifecycle recovery](../../../benchmarks/results/20260905T173311.900Z_p0-lifecycle-recovery-v1_edge_desktop-dkvusav_feff58b5-b4c2-4d11-b184-39ebf3e9bc7f.md)

## Limitations

- The smoke profile uses one shortened repetition per scenario. It validates orchestration and artifact integrity but cannot satisfy numeric P0 thresholds.
- Display refresh rate was not supplied, so refresh-dependent evaluation is unavailable.
- Browser WebGPU exposes no physical-display presentation timestamp. `observedPresentation` is explicitly unavailable with reason `browser-webgpu-no-presentation-timestamp`; first-present requirements remain UNVERIFIED.
- The deliberate validation error and device loss in headed tests are expected diagnostics. Native hardware OOM remains UNVERIFIED and was not induced.
