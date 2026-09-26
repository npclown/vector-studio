# P2.5 production runner functional review — 2026-09-26

Disposition: local P2.5 PASS, pending required CI and protected PR integration. This validates the production runner and observations, not P2 A08 speedup or full P2/P1 acceptance. Reference execution remains P2.6 and requires current operator/environment observations.

## Sources and immutable runs

Both runs used the checkpoint worktree on `codex/p2-5-benchmark-runner`, based on `0c777c71c4d7da483438aee10ab3b3a7b64d3360`. The successful run's source manifest matches the subsequently committed checkpoint files byte-for-byte. WASM SHA-256 is `861762ca8d5e48d6cc5c602e82ef98652b9d7fa326068a0756d4e301497d25cc`; two independent release builds matched. Production asset manifest SHA-256 is `5960fb3bea300ca2fbbe56794abab11c0715dc2b0c1d01954d9b31a54248a3de`.

| Run                      | Outcome                                                                                                                   | Records                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20260926-functional-01` | FUNCTIONAL_FAIL before sampling: installed Chrome/Edge required `--enable-automation` for CDP launch-argument observation | [Invocation/source](20260926-functional-01/invocation.json), [Chrome](20260926-functional-01/chrome-r1.json), [Edge](20260926-functional-01/edge-r1.json), [aggregate](20260926-functional-01/aggregate.json), [final status](20260926-functional-01/runner-status.json)                                                                                                                         |
| `20260926-functional-02` | FUNCTIONAL_PASS, both browsers; no validation findings                                                                    | [Invocation/source](20260926-functional-02/invocation.json), [build/compiler](20260926-functional-02/build.json), [Chrome](20260926-functional-02/chrome-r1.json), [Edge](20260926-functional-02/edge-r1.json), [aggregate](20260926-functional-02/aggregate.json), [source/build completion](20260926-functional-02/completion.json), [final status](20260926-functional-02/runner-status.json) |

The first run's only measured-source difference is the absent explicit launch option. Its [configuration source](20260926-functional-01/launch-config-source.txt) is archived and hash-verified against that run's manifest. Every other manifest entry matches the final checkpoint. Both complete record sets are retained without modification; the second run uses a new directory and does not overwrite the first. `completion.json` closes capture before independent record evaluation; `runner-status.json` includes the evaluator's final exit outcome. Source-start/end and production asset integrity checks passed in both runs.

Commands were `pnpm benchmark:p2 --profile functional --output-dir artifacts/p2.5/20260926-functional-01` and the same command with `20260926-functional-02`. Each command validates/rebuilds the real kernel, bundles the real adapter into an isolated Vite production page and launches one headless Chrome repetition followed by one headless Edge repetition, with no retries, traces or video. CDP detaches before sampling. Functional mode has one separately labeled preparation pair, one warm-up pair and two measured pairs; it makes no reference-performance claim.

## Observations

Environment: Windows x64 `10.0.26200`, AMD Ryzen 7 3700X, 16 logical cores, 34,291,060,736 installed-memory bytes, Node 24.15.0, pnpm 11.1.2, pinned Rust 1.94.1/MSVC with LLVM 21.1.8. Chrome `153.0.8010.53` and Edge `154.0.4258.37` each observed a 1280×720 viewport at DPR 1, visible document and approximately 0.1 ms positive clock quantum. Actual flags, optional GPU information, window/screen/navigator state, compiler identity and release profile are in the raw records. No operator power/load/display observation is claimed for this functional run.

Both browsers and both variants produced checksum `0062bfe5bfe9d864`. Each steady sample observed:

- 1,000 successful paths, 32,000 logical cubics and zero failed paths.
- Batch: one successful process call; per-path: 1,000 successful process calls. No reserve, growth, retry, cache hit or cache retention.
- 1,818,150 sizing visits and 1,818,150 emission visits, producing 925,075 cubic LINE commands in each variant.
- 26,856,175 copied typed-payload bytes per variant. Batch retained the full result payload during traversal; per-path retained only the current path result. These are owned typed-array payload observations, excluding JS objects, allocator overhead and physical memory.
- Stable owned WASM linear memory of 30,343,168 bytes for batch and 1,179,648 bytes for per-path. Disposed sessions reported zero live linear/cache memory, unchanged cumulative work and exactly one acknowledged raw dispose per variant. Dropped WASM memory is not evidence of immediate physical-memory reclamation.

Preparation is reported separately: batch input/output capacities 1,617,056/26,920,228 bytes; per-path 1,680/29,408 bytes. The independent validator recomputed identities, configuration hashes, pair schedule/order, all counter deltas, exact output byte accounting, checksums, memory/lifetime invariants and cleanup from raw records. Functional aggregates retain timings for diagnostics but set performance disposition to NOT_APPLICABLE.

## Validation and review

- `pnpm check` — PASS: formatting, ESLint, TypeScript, 297 unit tests in 41 files, dependency boundaries.
- `pnpm build` — PASS: five TypeScript libraries and playground production build (43 modules).
- `pnpm benchmark:p2 --profile functional --output-dir artifacts/p2.5/20260926-functional-02` — PASS: rustfmt, Clippy, 25 native unit tests, identical independent WASM release builds, 25 real-WASM/native integration tests in three files, production page build (11 modules), Chrome/Edge tests 2/2 and independent raw-record evaluator 1/1. The native framed bridge is explicitly invoked by integration validation despite its ordinary cargo-test ignore marker.
- Focused runner unit fixtures cover frozen numeric draws, complete checksum sensitivity, batching-independent result traversal, exclusive output, CLI/reference metadata rejection, source/build hashing, malformed counters/lifetimes/order/workload, missing repetitions and per-repetition threshold calculations.
- Changed Markdown formatting, local links/anchors, whitespace, archived-record/source-manifest comparison and staged scope review are required before commit; their final outcomes are recorded in the PR.

Primary owned the general adapter capacity reuse guard, CLI/build orchestration, independent record validator, evidence and final review. A GPT-5.6 Terra medium worker's initial generator draft diverged from the frozen workload; Primary stopped it before any run and escalated the bounded browser task to GPT-5.6 Sol medium. Sol corrected the generator/capture fixtures and subsequently reviewed orchestration read-only. No recursive delegation occurred.

Review fixes included correct endpoint-relative RNG draws and MOVE origin, timing through checksum publication, visibility-event dispatch between pairs, current GPU metadata getters, explicit configuration/source/build identity, counter domains/history, raw dispose acknowledgement, bounded exact preparation retries, observed compiler identity and durable post-validation failure status. Independent follow-up found no remaining material blocker; Primary checked the final diff and actual records.

The only product-code change skips reserve when the existing input arena is sufficient. A real-WASM regression verifies unchanged output, one process/epoch advance on reuse, and exact reserve/retry when larger input/output is required. Numerical algorithms, tolerances, raw/public API, external dependencies, renderer lifecycle and package boundaries are unchanged. P2 A08, P1 A09/A10, full P1 acceptance and P3-P5 authorization remain open/unchanged.
