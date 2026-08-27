# Benchmark policy and result format

Status: Accepted for prototype development

This directory is the source of truth for benchmark methodology and observed results. Acceptance thresholds are owned by the relevant execution or milestone plan; result files report facts and never redefine those thresholds.

## Directory layout

```text
docs/benchmarks/
  README.md
  results/
    TEMPLATE.md
    YYYY-MM-DD_<milestone>_<scenario>_<browser>_<machine>.md
```

Raw machine-readable output should be stored beside a result when the runner produces it, using the same base name and a `.json` extension. Large traces and screenshots may live in the test artifact store and be linked from the result.

## Reproducibility requirements

Every accepted run records:

- Git commit or explicit dirty-worktree marker
- UTC timestamp and local timezone
- Production/development build mode
- Operating system and version
- CPU, logical-core count, and installed memory
- GPU adapter description, vendor, architecture, driver when exposed, and WebGPU limits
- Browser product, channel, and exact version
- Viewport CSS size, physical size, and device-pixel ratio
- Power source and relevant power mode
- Scene ID, seed, object counts, and configuration hash
- Warm-up duration, measured duration, sample count, and repetition count
- Whether DevTools, tracing, screen recording, or other known overhead was enabled
- Commands and runner version

A result missing required metadata is exploratory and cannot satisfy an acceptance criterion.

## Run protocol

1. Use a production build served from localhost or HTTPS.
2. Close unrelated GPU-heavy applications where practical and record unavoidable load.
3. Keep the browser window visible and unobscured for reference hardware runs.
4. Disable DevTools and tracing during measured repetitions unless the scenario explicitly measures with them.
5. Warm the scene before sampling so shader/pipeline creation and first-load work are measured separately.
6. Run at least five measured repetitions for P0 reference results.
7. Record every repetition; do not discard outliers without preserving and explaining them.
8. Report median, p95, and p99 where sample count permits, plus minimum and maximum across repetitions.
9. Compare only runs with compatible scene, viewport, DPR, browser channel, build mode, and reference-machine class.

## Standard metrics

- Initialization wall time
- First-present wall time
- Frame interval median/p95/p99
- CPU encode-and-submit time median/p95/p99
- Pointer-to-present latency when interaction exists
- Frames submitted and frames presented where measurable
- Draw calls or render-pass count
- Pipeline/shader creation count
- Bytes uploaded per frame
- Live and peak tracked GPU-resource bytes
- JavaScript heap and WASM linear memory when available
- Long tasks greater than 50 ms
- Diagnostic error/warning counts

Browser APIs do not expose every GPU timing or allocation consistently. Missing metrics are recorded as unavailable, not guessed. Tracked allocation bytes are labeled as engine-accounted estimates rather than physical GPU memory.

## Scenario identity

A benchmark scenario has a stable ID and version. Changing scene composition, animation path, viewport, sample window, or metric calculation increments the scenario version. Seeded randomness is mandatory; the seed is part of the result.

P0 scenario definitions and thresholds are in `docs/plans/p0-webgpu-foundation.md`. P1's 1,000/10,000-node scenes remain owned by `docs/prototype-plan.md` until a dedicated P1 execution plan replaces them.

## Regression comparison

- Functional acceptance uses hard criteria from the execution plan.
- Performance acceptance uses both a hard ceiling and comparison with the most recent compatible accepted baseline where specified.
- A regression greater than 10% in a primary p95 metric requires investigation even when it remains under the hard ceiling.
- A result is not a regression baseline until the active plan marks it accepted.

