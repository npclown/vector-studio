# P2.6 reference result: p2-batch/v1 — 2026-09-26

Status: **Rejected as a performance baseline; valid FAIL observation.** Primary verified record integrity, current environment provenance and independently recomputed the thresholds. All ten repetitions miss A08's required paired median speedup. This result does not close P2, waive A08 or authorize P3-P5. The [active plan](../../../plans/p2-geometry-kernel.md#p26-reference-execution-and-gate-review) owns the gate; thresholds are unchanged.

## Identity and reproduction

- Measured revision: clean `f84b51f9d04e436816ce9690ec52b0c8f4451d8d`; branch `codex/p2-6-reference-results` before any tracked edit.
- Run ID: `20260926-reference-01`; schemas `p2-run/v1`, `p2-record/v1`, `p2-geometry-benchmark/v1`, `p2-aggregate/v1`.
- Command: `pnpm benchmark:p2 --profile reference --environment-json .tools/p2-6-reference-environment-01.json --output-dir artifacts/p2.5/20260926-reference-01`. Reproduction requires a fresh output ID and fresh operator/hardware observations; the archived environment is historical evidence.
- Environment observation: `2026-09-26T11:12:06.6308549Z`; timezone Asia/Seoul. Invocation and every repetition retain their own UTC timestamps.
- [Source/invocation](invocation.json) SHA-256: `5fa4b1caafc03173ecbc55f7acaf03e698d0198ba6a1de8722e8e8168661194f`; all 33 source entries match the clean measured revision.
- [Production asset manifest](build.json) SHA-256: `5960fb3bea300ca2fbbe56794abab11c0715dc2b0c1d01954d9b31a54248a3de`.
- WASM SHA-256: `861762ca8d5e48d6cc5c602e82ef98652b9d7fa326068a0756d4e301497d25cc`. Pinned Rust 1.94.1, commit `e408947bfd200af42db322daf0fadfe7e26d3bd1`, MSVC x64 host, LLVM 21.1.8, wasm32-unknown-unknown, release opt-level 3/LTO/codegen-units 1/panic abort/strip and repository-path remapping. Two independent release builds matched; the actual compiler observation/profile is archived.

## Environment and method

Windows x64 `10.0.26200`, AMD Ryzen 7 3700X, 16 logical cores, 34,291,060,736 installed-memory bytes, Node 24.15.0/pnpm 11.1.2. [Read-only Windows preflight](hardware-preflight.json) observed two active 1920×1080 displays at 60 Hz, AC online, Balanced scheme, NVIDIA GTX 1660 SUPER driver `32.0.15.9186`. The collector's legacy background-load field explicitly does not contain operator confirmation; the separately assembled [reference environment](environment.json) records the user's current affirmative reply that video/recording/high-load work were stopped and measurement windows could remain unobscured. No other local build/test/agent workload ran during the browser samples.

Installed headed Chrome `153.0.8010.53` ran first, then headed Edge `154.0.4258.37`, one worker, no retries. Each had five fresh page repetitions. All actual window rectangles were `(10,10,1296,808)`, entirely inside primary monitor `(0,0,1920,1080)`; viewport 1280×720 CSS/physical pixels at DPR 1. All records reported visible start/end with no hidden transition. Raw records retain launch flags, screen/window/navigator state and optional GPU adapter metadata. This is CPU/WASM work and requests no GPU device. Tracing/video/DevTools were off; the metadata CDP session detached before sampling. There is no physical-presentation measurement.

Each page generated the frozen seed `0x12345678` workload once: 1,000 MOVE(0,0)+32 connected CUBIC paths, endpoint-relative deltas, identity world/zoom/DPR1, local tolerance 0.25 and zero cache admission. A separate preparation pair provisioned arenas and checked matching output. Each variant then received ten warm-up samples and thirty measured samples, in the frozen AB/BA pair schedule with start order alternating by repetition. Totals: 300 measured pairs / 600 measured variant samples, plus all 100 warm-up and ten preparation pairs. No sample or outlier was discarded.

The `performance.now` clock starts before real adapter packing/calls and ends after full output checksum publication. Fetch, compile, instantiation and preparation/reserve are reported separately. Observed clock quantum was approximately 0.1 ms in every page; every measured sample exceeded 100 quanta. Percentiles use nearest rank; paired speedup is the median of each pair's per-path/batch duration ratio, not a ratio of medians.

## Results and threshold review

| Browser | Repetition | Median paired B/A | Batch p95 ms | Per-path p95 ms | A08                   |
| ------- | ---------: | ----------------: | -----------: | --------------: | --------------------- |
| Chrome  |          1 |          1.008861 |        391.1 |           396.1 | FAIL: speedup         |
| Chrome  |          2 |          0.999739 |        391.7 |           403.5 | FAIL: speedup         |
| Chrome  |          3 |          0.993849 |        397.8 |           394.5 | FAIL: speedup and p95 |
| Chrome  |          4 |          1.001078 |        395.4 |           394.4 | FAIL: speedup and p95 |
| Chrome  |          5 |          0.987362 |        399.8 |           399.9 | FAIL: speedup         |
| Edge    |          1 |          1.006492 |        390.8 |           398.4 | FAIL: speedup         |
| Edge    |          2 |          1.007596 |        389.8 |           393.0 | FAIL: speedup         |
| Edge    |          3 |          1.009767 |        391.7 |           412.3 | FAIL: speedup         |
| Edge    |          4 |          0.998704 |        393.5 |           398.2 | FAIL: speedup         |
| Edge    |          5 |          1.015167 |        390.7 |           394.5 | FAIL: speedup         |

The frozen criterion requires **every** repetition's paired median B/A >=1.20 and batch p95 <= per-path p95. Worst paired median was `0.9873617693503538`; best was `1.015167364018744`. Every speedup condition failed; Chrome repetitions 3 and 4 also failed p95. Rounded table values are for display; [the aggregate](aggregate.json) and raw records retain full precision, per-variant median/p95/p99/min/max and all samples. These are initial reference observations, not a regression comparison against the non-accepting functional profile.

The independent validator reported no malformed/incomplete-record finding or timer uncertainty. All measured samples had equal checksum `0062bfe5bfe9d864`, 1,000 successful paths, 32,000 logical cubics, zero failed paths, one versus 1,000 successful process calls, 1,818,150 sizing and emission visits each, 925,075 emitted cubic LINEs, and no reserve/growth/retry/cache hits. All raw dispose calls were acknowledged once and session live/cache memory reached zero. Owned typed-output bytes and linear-memory counters are retained with their existing JS-object/allocator/physical-memory exclusions; they do not prove P1 combined memory.

## Validation and artifacts

The reference command passed rustfmt/Clippy, 25 native unit tests, two identical WASM release builds and 25 geometry integration tests in three files, then production page build and all ten browser capture tests (5.5 minutes). The final record evaluator deliberately exited nonzero because A08 is FAIL. [Capture completion](completion.json) confirms source/build stability and no capture failure; [final runner status](runner-status.json) records the subsequent evaluator failure. This is a performance acceptance failure, not a failed geometry or browser-capture test.

Primary separately recalculated all ten nearest-rank ratios and p95 values directly from raw durations, verified all 300 measured pairs, primary-monitor containment, visible states and source-file SHA-256 matches. Existing A01-A07 evidence remains valid for the unchanged runtime; P1 A09/A10 and full P1 acceptance remain UNVERIFIED.

All 17 captured records/observations are retained. The ten large browser JSON records are losslessly gzip-compressed to avoid a large repetitive text diff; no sample fields are removed. [Archive manifest](archive-manifest.json) records both original and stored byte counts/SHA-256. `node:zlib.gunzipSync` restores each original JSON byte-for-byte. For example, from the repository root:

```sh
node -e "const fs=require('node:fs'),z=require('node:zlib'); const r=JSON.parse(z.gunzipSync(fs.readFileSync('docs/benchmarks/results/20260926-p2-batch-v1-reference-01/chrome-r1.json.gz'))); console.log(r.capture.samples.length)"
```

That example prints 41 pairs. Browser captures are `chrome-r1.json.gz` through `chrome-r5.json.gz` and `edge-r1.json.gz` through `edge-r5.json.gz`, all listed and hashed in the manifest. The hardware collector's original CRLF bytes are preserved by a file-specific Git attribute. Production assets remain reproducible from the measured source/toolchain and their committed hash manifest; local originals remain under the exclusive run directory.

Next work is bounded performance investigation under the existing contracts, followed by any justified implementation checkpoint and a new complete reference run. A FAIL does not establish which component is responsible and does not justify benchmark-specific shortcuts or changed acceptance semantics.

## Separate diagnostic investigation

After reference capture finished, Primary ran `pnpm exec vitest run --config .tools/p2-phase-profile.config.ts` — PASS, one diagnostic fixture. The [script](phase-diagnostic-source.txt), [configuration](phase-diagnostic-config.txt), [lossless raw samples](phase-diagnostic.json.gz) and [byte hashes](phase-diagnostic-integrity.json) are retained. To reproduce, restore the two text files to their original `.tools/p2-phase-profile.test.ts` and `.tools/p2-phase-profile.config.ts` paths and use a fresh diagnostic output filename in the script. Existing output is exclusive and must not be overwritten.

This is instrumented Node 24.15.0 on the same real release WASM and frozen inputs, one preparation pair, one warm-up pair and five alternating diagnostic pairs. It is **NOT_APPLICABLE to A08**: process and adapter timing wrappers add overhead, the host differs and the sample schedule is shorter. No instrumentation is subtracted from reference records.

| Median diagnostic component, ms |   Batch | Per-path |
| ------------------------------- | ------: | -------: |
| Complete timed sample           | 381.040 |  403.384 |
| Raw process calls               | 134.258 |  139.484 |
| Remaining adapter work          |  77.540 |   84.530 |
| Non-adapter timed work          | 168.709 |  176.723 |

Component medians are computed independently and need not sum to the median total. Non-adapter time is a residual containing full checksum traversal, benchmark loops and wrapper return overhead; it is not a pure checksum CPU profile. All diagnostic checksums matched and steady call/work/reserve invariants passed. This attribution demonstrates substantial shared work beyond the WASM call boundary, but does not isolate individual decoder or garbage-collection costs.

A Sol medium read-only audit identified repeated envelope/layout/canonical validation, repeated analytic bounds in sizing/emission, scalar output copies and BigInt interval comparisons per emitted line. It also identified a larger retained-output lifetime in batch as a possible tail-latency factor, not a proven GC cause. The smallest supported production candidate is exact Number-based provenance interval arithmetic: validated depth <=20 and numerator <=2^depth bound each cross-product by 2^40, below the exact-integer limit. Full validation and owned-copy semantics must remain. No candidate is claimed to achieve 1.20; checksum/workload/threshold changes are not a production optimization.
