# P2.6c reference recheck: p2-batch/v1 — 2026-09-26

Status: **Rejected as a performance baseline; valid FAIL observation.** After P2.6b exact provenance arithmetic, all ten repetitions still miss the unchanged A08 median paired speedup requirement. Six also miss the p95 condition. This result does not close P2, weaken acceptance or authorize P3-P5. The [active plan](../../../plans/p2-geometry-kernel.md#p26c-reference-recheck) owns the gate.

## Identity and reproduction

- Clean measured revision: `55f609196053d16d59ef5db4c89b5aaa84ef190d`, after P2.6b PR #48; branch `codex/p2-6c-reference-recheck` before tracked edits.
- Run ID: `20260926-reference-02`; schemas `p2-run/v1`, `p2-record/v1`, `p2-geometry-benchmark/v1`, `p2-aggregate/v1`.
- Command: `pnpm benchmark:p2 --profile reference --environment-json .tools/p2-6c-reference-environment-01.json --output-dir artifacts/p2.5/20260926-reference-02`. Reproduction requires new hardware/operator observations and an exclusive new output ID; the archived environment is historical.
- Environment observation: `2026-09-26T11:52:33.8874141Z`; timezone Asia/Seoul. Invocation and each capture retain their own timestamps.
- [Source/invocation](invocation.json) SHA-256: `732d2a8a32b1f7f77c7a6ea93c0bfff2f2832c132a41dafa0d9c31ad1b137b94`. All 33 entries match the clean measured Git revision and working files.
- [Production build manifest](build.json) SHA-256: `702ef1b99df759ae692a855411c55640167383cc144a5b703e13e4fd9980bfdc`.
- WASM SHA-256: `861762ca8d5e48d6cc5c602e82ef98652b9d7fa326068a0756d4e301497d25cc`. Pinned Rust 1.94.1, commit `e408947bfd200af42db322daf0fadfe7e26d3bd1`, MSVC x64 host, LLVM 21.1.8, wasm32-unknown-unknown release with opt-level 3/LTO/codegen-units 1/panic abort/strip and repository-path remapping. Two independent release builds matched. Source/build identity equals the P2.6b functional checkpoint; that functional run is not reference performance evidence.

## Environment and method

Windows x64 10.0.26200, Ryzen 7 3700X, 16 logical cores, 34,291,060,736 memory bytes, Node 24.15.0/pnpm 11.1.2. The [fresh Windows preflight](hardware-preflight.json) observed two active 1920×1080 displays at 60 Hz, AC online, Balanced scheme `381b4222-f694-41f0-9685-ff5bb260df2e` and GTX 1660 SUPER driver `32.0.15.9186`. The collector's legacy background-load field does not assert operator confirmation. The separate [environment record](environment.json) records the user's immediate confirmation that video/recording/high-load work were stopped and windows could remain unobscured. No other local validation or subagent work ran during timed browser samples.

Headed installed Chrome 153.0.8010.53 ran first, then headed Edge 154.0.4258.37, one worker, five fresh repetitions each, no retries/tracing/video/DevTools. Every actual window was `(10,10,1296,808)`, entirely on primary monitor `(0,0,1920,1080)`, with 1280×720 viewport and DPR 1. Visibility was visible at start/end with no transition events. Browser flags, optional adapter metadata, navigator/screen/window/clock details remain in each raw capture. This CPU/WASM benchmark requests no GPU device and makes no physical-presentation claim.

The frozen workload and consumer are unchanged: seed `0x12345678`, 1,000 paths of MOVE(0,0) plus 32 connected endpoint-relative CUBICs, local tolerance 0.25, identity world/zoom/DPR and disabled caches. Each page retained one preparation pair, ten warm-up pairs and thirty measured pairs in the prescribed alternating AB/BA order, with start order alternating by repetition. All 300 measured pairs (600 variant samples), 100 warm-up pairs and ten preparation pairs are preserved; no outlier is discarded.

Timing includes real adapter packing, calls, output copies and full scalar/verb/provenance checksum publication. Fetch/compile/instantiation/preparation are separately reported. Every page observed approximately 0.1 ms clock quantum and every measured sample exceeded 100 quanta. Percentiles use nearest rank; speedup is the median of paired per-path/batch duration ratios, not a ratio of medians.

## Results

| Browser | Repetition | Median paired B/A | Batch p95 ms | Per-path p95 ms | A08                   |
| ------- | ---------: | ----------------: | -----------: | --------------: | --------------------- |
| Chrome  |          1 |          1.006250 |        391.3 |           400.1 | FAIL: speedup         |
| Chrome  |          2 |          1.006248 |        446.4 |           437.4 | FAIL: speedup and p95 |
| Chrome  |          3 |          1.013378 |        422.6 |           407.3 | FAIL: speedup and p95 |
| Chrome  |          4 |          1.016632 |        422.2 |           416.8 | FAIL: speedup and p95 |
| Chrome  |          5 |          1.013734 |        407.7 |           413.6 | FAIL: speedup         |
| Edge    |          1 |          1.005692 |        398.2 |           395.4 | FAIL: speedup and p95 |
| Edge    |          2 |          1.007246 |        419.5 |           416.0 | FAIL: speedup and p95 |
| Edge    |          3 |          1.015038 |        394.5 |           428.8 | FAIL: speedup         |
| Edge    |          4 |          1.009856 |        395.9 |           400.9 | FAIL: speedup         |
| Edge    |          5 |          1.018595 |        423.4 |           415.5 | FAIL: speedup and p95 |

Every repetition must have median paired B/A >=1.20 and batch p95 <= per-path p95. Worst paired median is `1.0056921086656014`, best `1.0185950413300466`. All speedup conditions fail; Chrome 2/3/4 and Edge 1/2/5 also fail p95. [Aggregate](aggregate.json) and raw captures retain full precision, all medians/p95/p99/min/max and durations; the table is rounded for display.

This run demonstrates that P2.6b alone is insufficient to meet A08. It does not isolate the causal effect of that change versus the [previous run](../20260926-p2-batch-v1-reference-01/README.md), establish a statistically significant improvement, or attribute tail variation to GC or any other component. No threshold, workload or benchmark-consumer change is justified by this failure.

## Correctness, integrity and gate review

The raw-record evaluator found no malformed/incomplete records or timer uncertainty. All measured variants had checksum `0062bfe5bfe9d864`, 1,000 successful paths, 32,000 logical cubics, 1,818,150 sizing and emission visits each, 925,075 emitted cubic lines and 26,856,175 copied typed-payload bytes. Batch uses one successful process call; per-path uses 1,000. No measured reserve/growth/retry/cache hit occurs. Both sessions acknowledge raw dispose exactly once and finish with zero live linear/cache payload memory. Existing JS-object/allocator/physical-memory exclusions remain; these observations do not establish P1 combined memory acceptance.

The command passed rustfmt, Clippy, 25 native unit tests, two identical release WASM builds, 25 geometry integration tests in three files, production build and 10/10 browser capture tests (5.6 minutes). The final evaluator deliberately exited 1 because the acceptance result is FAIL. [Completion](completion.json) reports `sourceMatches=true`, `buildMatches=true`, `failure=null`; [runner status](runner-status.json) retains the evaluator failure. Do not label this a geometry failure or successful A08 run.

Primary independently recomputed raw nearest-rank median/p95/p99 and paired ratios for every repetition, checked all pair counts, clocks, checksums, payload/process/reserve/growth counts, window containment/visibility and cleanup, and verified source bytes against the measured Git revision and production asset hashes. A Terra medium worker independently audited the completed records read-only and found no integrity defect; its recalculated metrics match exactly. Primary caught an incorrect p95-failure enumeration in the worker's prose, and the worker corrected it to the six repetitions listed above. The reviewed conclusion is valid FAIL, not UNVERIFIED. No recursive delegation or concurrent measurement workload occurred.

Changed-document formatting, local link/anchor checks, staged byte-hash/scope review and required CI are recorded on the checkpoint PR. Root product checks/build were not separately repeated for this evidence-only change; the reference command performs the geometry/build prerequisites above, and protected CI remains mandatory. P2.6b's 307 root tests and prior A01-A07 evidence remain the applicable implementation evidence. P2 A08 remains FAIL, full P2 remains incomplete, P1 A09/A10 remain UNVERIFIED and P3-P5 remain outside approved D6.

## Immutable artifacts and next step

All 17 records and environment observations are retained. Ten browser captures are losslessly gzip-compressed (`chrome-r1.json.gz` through `chrome-r5.json.gz`, and `edge-r1.json.gz` through `edge-r5.json.gz`); no fields are removed. The [archive manifest](archive-manifest.json) records original and stored byte lengths/SHA-256. `node:zlib.gunzipSync` restores original JSON bytes exactly. For example, from the repository root:

```sh
node -e "const fs=require('node:fs'),z=require('node:zlib'); const r=JSON.parse(z.gunzipSync(fs.readFileSync('docs/benchmarks/results/20260926-p2-batch-v1-reference-02/chrome-r1.json.gz'))); console.log(r.capture.samples.length)"
```

This prints 41 pairs. The collector output was saved as UTF-8 with LF line endings before hashing; all archived bytes match the original saved observations. Production assets are reproducible from the source/toolchain and committed manifest; local originals remain in the exclusive run directory.

Next: a separate bounded diagnosis of remaining adapter decode/copy and kernel costs, using non-accepting instrumentation before selecting another production correction. The prior phase diagnostic did not isolate individual copy/validation/GC costs. Preserve the same API, ownership, algorithm, work limits and benchmark semantics. Do not start P3 or rerun unchanged measurements merely seeking a pass.
