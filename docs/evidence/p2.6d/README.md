# P2.6d decoder cost diagnosis — 2026-09-26

Status: local diagnostic checkpoint PASS, pending required CI/protected integration. This Node-only instrumented diagnosis is NOT_APPLICABLE to P2 A08. The [last reference result](../../benchmarks/results/20260926-p2-batch-v1-reference-02/README.md) remains a valid FAIL; full P2 is incomplete, P1 A09/A10 remain UNVERIFIED and P3-P5 remain outside approved D6.

## Scope and prospective contract

Entry: clean main `a41d1a8c22694964f0d98be7db75e6ccf13790be`, after protected PR #49 and required CI. The [P2.6d contract](../../plans/p2-geometry-kernel.md#p26d-decoder-cost-diagnosis) was frozen before tooling and execution. Primary owns region boundaries, review and interpretation. One GPT-5.6 Sol medium worker prepares isolated ignored tooling, with no child delegation.

No product source, public/raw API, Rust algorithm/work limit, dependency or benchmark workload/consumer/threshold changes are included. Vitest transforms the actual ABI module in memory. Original statements are preserved, and removing inserted instrumentation must recover original source bytes exactly. Unique anchors, original/transformed hashes and expected invocation counts prevent silently missing or drifting instrumentation.

Complete pack and decode timers contain their own instrumentation overhead. Decoder verb copy, point allocation/copy, coordinate-finiteness scan, provenance allocation/copy and provenance validation are disjoint subregions. Remaining decode time includes all other validation/control work and timer overhead. Complete adapter time encloses pack/decode/raw process/reserve plus input preparation, lifetime checks and wrappers; non-adapter time includes the unchanged full checksum consumer and loop/wrapper return overhead. Nested times must not be added together as independent costs.

The diagnostic uses the real release WASM and frozen 1,000-path workload, cache disabled, two independent instances, one preparation pair, one warm-up pair and five alternating diagnostic pairs. All samples/errors/work/call/payload/checksum observations and cleanup are retained. Diagnostic metadata must include source start/end and tooling identity. No raw reference record is replaced.

## Interpretation limits

This changes execution through timers and try/finally instrumentation, which can affect JIT optimization and allocation/GC behavior. Node is not the browser reference host, warm-up is short, and medians describe only these diagnostic samples. Region observations are not exact attribution of uninstrumented runtime, causal proof of GC cost, a speedup comparison or evidence for A08. Independent component medians need not sum to the total median.

Only after reviewing complete observations may a bounded production candidate be selected for a later checkpoint. It must preserve owned output, endianness/offset handling, validation and error behavior. Any candidate still needs correctness fixtures and a new full reference run before a performance claim.

## Observations and interpretation

Executed `pnpm exec vitest run --config .tools/p2-decode-diagnostic.config.ts` on Node 24.15.0, Windows x64 10.0.26200, Ryzen 7 3700X, 16 logical cores and 34,291,060,736 memory bytes. Recorded UTC interval: `2026-09-26T12:50:58.050Z` through `2026-09-26T12:51:03.905Z`; timezone Asia/Seoul. No operator power/load/display condition is claimed, and no browser reference measurement occurred. The suite first runs a one-path smoke case, then fresh diagnostic instances with the declared preparation/warm-up protocol. All five alternating diagnostic pairs and both preparation/warm-up pairs are retained: 14 variant samples total.

Each table entry is the independent median of the five diagnostic samples for that variant, in milliseconds. Decoder subregions are nested inside decode total, which is nested inside adapter total; do not sum rows indiscriminately.

| Observed region                         | Batch ms | Per-path ms |
| --------------------------------------- | -------: | ----------: |
| Complete sample                         |  385.068 |     395.000 |
| Complete adapter                        |  213.713 |     218.708 |
| Raw process                             |  137.542 |     139.570 |
| Pack input                              |    2.895 |       4.453 |
| Decode output total                     |   71.757 |      68.366 |
| Verb copy                               |    1.122 |       1.053 |
| Point allocation/copy                   |    7.798 |       7.506 |
| Coordinate-finiteness scan              |   17.243 |      15.771 |
| Provenance allocation/copy              |    6.890 |       6.406 |
| Provenance validation                   |   22.386 |      22.051 |
| Other decoder work and timer overhead   |   14.391 |      14.840 |
| Other adapter work and wrapper overhead |    2.848 |       6.902 |
| Non-adapter timed work                  |  170.537 |     174.444 |

Other adapter work is computed per sample as adapter minus raw process/reserve/pack/decode durations. Non-adapter time contains full unchanged checksum consumption and benchmark loop/wrapper return costs; it is not an isolated checksum profile. Steady reserve time is zero. Full raw times and counts are in the archived record, not rounded to table precision.

These observations separate substantial decoder validation from copying: the separate coordinate-finiteness scan alone accounts for approximately 16–17 ms in this instrumented run, while point allocation/copy accounts for about 8 ms. The next bounded candidate is to fuse point decoding and the finite-value check into one loop, eliminating a second traversal/callback while retaining owned arrays and the same DataView little-endian reads. The candidate must still read/copy every scalar, accumulate invalid-coordinate state, and preserve the existing post-loop error rather than throwing early. This avoids introducing native-endian bulk-copy assumptions or a new helper. A later checkpoint must prove unchanged error precedence/text, NaN/Infinity rejection, finite values including signed zero, array ownership and offset behavior before any integration.

Provenance validation remains a separate observed cost, but bypassing it or dropping provenance is outside the contract. Raw process and non-adapter work also remain substantial. The proposed fusion is not assumed sufficient for A08, and these samples do not justify a 1.20 speedup prediction or a change to the benchmark consumer.

## Integrity and Primary review

The measured production source manifest is `732d2a8a32b1f7f77c7a6ea93c0bfff2f2832c132a41dafa0d9c31ad1b137b94`, unchanged from P2.6b/P2.6c. Source start/end match all 33 files and base `a41d1a8c22694964f0d98be7db75e6ccf13790be`; the dirty flag honestly includes prospective plan/evidence edits. Three tooling hashes match at start/end. Original ABI SHA-256 is `a57b7c55ae61e58f7a108f6fd52f678c5615c2aacafddfbf516e39b2a0fdad66`; transformed in-memory source SHA-256 is `2b6873ad58c07e39c4887fbc17a1af4e0faf3058d464c7ce3d2015dfaa7da9bf`. Stripping insertions restores original bytes. Release WASM remains `861762ca8d5e48d6cc5c602e82ef98652b9d7fa326068a0756d4e301497d25cc`.

All samples have checksum `0062bfe5bfe9d864`, 1,000 successful results and 26,856,175 copied payload bytes. Every steady variant has 32,000 logical cubics, 1,818,150 sizing/emission visits each, 925,075 emitted cubic lines, no cache hit/reserve/growth and one versus 1,000 successful process calls. Every decoder subregion executes 1,000 times; total pack/decode executes once for batch or 1,000 times for per-path. Both sessions acknowledge dispose once and finish with zero live linear/cache payload memory. Preparation retains actual additional sizing/retry work: batch 2 process/2 reserve calls; per-path 1,006 process/7 reserve calls. It is not mislabeled as steady work.

Primary corrected the draft before execution: region wrappers initially narrowed the scope of copied arrays; preparation initially used steady-work assertions; cleanup contained unserializable BigInt counters; invalid-duration checks preceded preservation of the failing sample. Final tooling uses scope-preserving region insertions, phase-appropriate work assertions, existing serializable session counters and record-before-guard ordering. Full source/tooling manifests, duration/residual guards and a real-WASM smoke test were also reviewed. No defective draft produced a timed diagnostic record.

Primary verified the completed raw record, recomputed each median from five samples, matched all source files to Git and all tooling/archive byte hashes, and checked hook counts/checksums/cleanup. The Sol medium worker independently reviewed all completed observations and reproduced the medians, pair order, steady work, preparation retries and cumulative cleanup without findings. Its combined point-copy/finiteness medians are 25.409/23.265 ms (batch/per-path), computed per sample before aggregation. The checks remain necessary, so the separate scan duration is not entirely removable overhead. Primary reviewed and retained that limitation and the post-loop error requirement. No additional implementation or timed run is part of this checkpoint.

## Validation and reproduction

- `pnpm exec tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --lib "ES2022,DOM" --types node --strict --skipLibCheck .tools/p2-decode-instrumentation.ts .tools/p2-decode-diagnostic.config.ts .tools/p2-decode-diagnostic.test.ts` — PASS: isolated ignored-tool typecheck, not a root check that skips these files.
- `pnpm exec vitest run --config .tools/p2-decode-diagnostic.config.ts -t "validates instrumentation guards"` — PASS: one smoke test, full diagnostic skipped; altered-source/missing-marker controls reject, one real-WASM path succeeds with all seven hooks counted once.
- `pnpm exec vitest run --config .tools/p2-decode-diagnostic.config.ts` — PASS: both tests, 6.22 seconds, 14 retained variant samples, no diagnostic errors, source/tooling start/end matches and zero cleanup counters.
- Changed-document formatting, local link/anchor validation, staged byte-hash/scope checks and required CI results are recorded on the PR. No root build, full geometry suite or headed reference was separately rerun locally: production and benchmark source files are unchanged and remain tied to existing evidence.

Archived [raw diagnostic](diagnostic-01.json.gz), [test source](diagnostic-test-source.txt), [configuration](diagnostic-config-source.txt), [insertion helper](instrumentation-source.txt) and [byte hashes](archive-manifest.json) preserve the executed inputs and all observations. Restore the three source archives to the `.tools/` paths listed in the manifest and run from repository root with the pinned toolchain/release WASM. Choose a fresh `OUTPUT` path in the restored test before rerunning: existing output is exclusive and cannot be overwritten; this changes the tooling hash for the new run, which is recorded honestly. The helper pins the current ABI hash and refuses source drift, so reusing it after a product change requires a reviewed update rather than silently moving anchors. `node:zlib.gunzipSync` restores the raw JSON bytes for analysis. No fixture is automatically added to the production or root test suite.
