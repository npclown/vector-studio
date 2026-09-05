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

Every new run needs a collision-free identity, such as a UTC time/run-ID suffix after the machine name. Writers must refuse to replace an existing artifact. Keep committed observations immutable; append a correction/review record or a new run instead. The legacy P0.3 runner currently violates this rule through fixed filenames; its replacement is tracked in [P0.5](../plans/p0-webgpu-foundation.md#p05-playground-and-measurement-harness).

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

For new runs, include schema version, full scenario configuration (not only its hash), source and runner provenance, browser launch flags, selected WebGPU features/sample count, and display refresh rate where the gate depends on it. Capture actual clean/dirty state before generating output. A dirty run must identify its base commit and reproducible source delta, such as an archived patch or source-manifest hash tied to the subsequently committed files; a bare `+dirty` suffix is insufficient to reconstruct the measured implementation. Unavailable environment fields need an explicit reason; acceptance-sensitive fields must be resolved before accepting the run.

The runner reports measured values and numeric PASS/FAIL/UNVERIFIED, initially with Exploratory status. Only an execution-plan review linking the source, metadata, artifacts, and owning criteria accepts a result as a baseline. A generated `pass: true` or `Status: Accepted` label alone cannot establish acceptance. Older records retain their historical labels; the active plan records limits on their reuse.

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

## Measurement semantics

Each metric records its clock, start/end event, unit, observation method, and availability. WebGPU separates submission and completion; `onSubmittedWorkDone()` reports queue-work completion. Treating either as physical display presentation would be an inference, not a measured display timestamp. See the [WebGPU queue API reference](https://gpuweb.github.io/types/interfaces/GPUQueue.html#onsubmittedworkdone). A requestAnimationFrame interval is a callback cadence, and CPU encode-and-submit time excludes later GPU execution.

For startup, report navigation-to-ready separately from initialize-call-to-ready. First submission, queue completion, and observed presentation require distinct names. For recovery, use the current-generation loss observation as the start and label ready, first rebuilt submission, and presentation endpoints separately. A proxy must not silently satisfy a threshold written for presentation: if that event cannot be measured, mark it UNVERIFIED and resolve the owning plan before an acceptance run.

The current P0 `framesPresented` field increments on submission. Historical values must be interpreted as submission-path counts; screenshots separately support visible output. Do not infer startup, recovery, or pointer-to-present latency from this field.

## Samples and aggregation

- Preserve the raw timed samples for new timing runs, actual window boundaries, event counts, and every repetition, including failures. Summaries alone cannot reproduce percentile calculations.
- Use a declared percentile algorithm; the P0.3 runner uses nearest rank (`ceil(p * n) - 1` on ascending samples). Empty samples are unavailable, never zero. Reject NaN, infinity, negative durations, and missing required observations.
- Report each repetition's median/p95/p99 and sample count. For steady-frame ceilings, all repetitions must pass: use the maximum per-run p95, not a pooled p95 or a percentile of percentiles. Discrete invariants must hold in every repetition.
- Startup has one timing sample per fresh load; compute its p95 across the declared fresh-load sample set. At five samples nearest-rank p95 is the maximum and does not establish a stable tail estimate. Plans requiring stronger estimates must set larger counts before the run.
- A missing/unsupported long-task observer is unavailable, not zero long tasks. Bound observer collection to the measured window and record the diagnostics from that window and its setup separately.
- Hidden/occluded/throttled runs and unexpected GPU errors are retained but cannot be accepted without investigating the environmental or functional failure. Do not discard them and silently report only replacements.

## Scenario identity

A benchmark scenario has a stable ID and version. Changing scene composition, animation path, viewport, sample window, or metric calculation increments the scenario version. Seeded randomness is mandatory; the seed is part of the result.

The configuration hash covers the full deterministic configuration, including scenario version, scene/object counts, viewport/DPR, sample count, animation/resize sequence, warm-up/window, and repetition settings with a defined serialization. Store that configuration alongside the hash. Measurement corrections create successor scenarios when they change the observations or calculation; document their relationship and unchanged thresholds in the owning plan before running them.

P0 scenario definitions and thresholds are in `docs/plans/p0-webgpu-foundation.md`. P1's 1,000/10,000-node scenes remain owned by `docs/prototype-plan.md` until a dedicated P1 execution plan replaces them.

## Regression comparison

- Functional acceptance uses hard criteria from the execution plan.
- Performance acceptance uses both a hard ceiling and comparison with the most recent compatible accepted baseline where specified.
- A regression greater than 10% in a primary p95 metric requires investigation even when it remains under the hard ceiling.
- A result is not a regression baseline until the active plan marks it accepted.
