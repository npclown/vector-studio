# P2.6e single-pass point validation — 2026-09-26

Disposition: local P2.6e PASS, pending required CI/protected integration. Functional verification does not establish a speedup. P2 A08 retains the [last reference FAIL](../../benchmarks/results/20260926-p2-batch-v1-reference-02/README.md); full P2 is incomplete, P1 A09/A10 remain UNVERIFIED and P3-P5 remain outside D6.

## Contract and implementation review

Base: clean main `866a8af4506adde1371ba909a1462031c8e984a1`, after P2.6d PR #50. Primary froze the [P2.6e contract](../../plans/p2-geometry-kernel.md#p26e-single-pass-point-validation) before implementation. The prior diagnostic identified a separate finite-coordinate traversal as a bounded candidate; it did not predict that removing that traversal would meet A08.

The only product edit is the point-copy loop in `packages/geometry-wasm/src/abi.ts`. It allocates the same owned Float64Array, reads every scalar with the same little-endian DataView offset, stores the value, and sets a sticky boolean when any value is nonfinite. The error remains after the complete copy loop with identical text. The separate `points.some` traversal is removed. The flag is reset for each result, remains false for an empty range and never resets after an invalid value. Finite values, signed zero and subnormal values are copied exactly as before. NaN/Infinity still cause the same error before any result is returned.

Primary inspected the surrounding decoder: envelope/range/bounds and supported-verb checks still precede this boundary; point arity, output state and provenance checks follow it. No early throw, partial publication, borrowed array, native-endian typed view, helper/export, dependency, Rust change, raw/public API or benchmark-consumer/threshold change is introduced. Generation/cache/ownership behavior is unchanged.

## Fixtures and delegation

Primary implemented and reviewed the production change. One GPT-5.6 Terra medium worker owned only `tests/unit/geometry-output-points.test.ts`; no child delegation. Its independent packed-output builder emits two paths with nonzero pointStart for the later path, and outer byte offsets 3 and 5. Eight tests cover finite signed zero/subnormal/small values, NaN/+Infinity/-Infinity in early/late coordinates, error precedence, copied-array ownership and a bad later result rejecting the complete decode.

Primary corrected the ownership test's initial attempt to change output -0 to +0 while retaining a -0 canonical source. Final fixtures decode canonical data and then mutate the second returned arrays, checking that the earlier result is unchanged. Point/verb/provenance buffers are distinct across paths and decode calls, and mutating raw input bytes does not affect retained output. A finite-coordinate malformed-provenance control proves that corruption is meaningful before the paired coordinate-error precedence check. The new fixture does not import the production packer or mock numeric primitives.

## Functional evidence

Command: `pnpm benchmark:p2 --profile functional --output-dir artifacts/p2.5/20260926-p2-6e-functional-01`.

The [invocation/source](20260926-functional-01/invocation.json) honestly records the dirty checkpoint worktree and all 33 measured files. Source manifest SHA-256 is `487a244d20f894d8dcb6c3d406f895af8c310e3b67284bc8741cd6a690719ce1`; the [production build manifest](20260926-functional-01/build.json) is `dc1e58648f2c37ad31df46155b69450d330a90627fafb05a00618cd1193a06e3`. Source-start/end and build integrity pass in [completion](20260926-functional-01/completion.json). Release WASM remains `861762ca8d5e48d6cc5c602e82ef98652b9d7fa326068a0756d4e301497d25cc`, with two independent builds identical.

Windows x64 10.0.26200, Ryzen 7 3700X, Node 24.15.0/pnpm 11.1.2 and pinned Rust 1.94.1/MSVC/LLVM 21.1.8. Headless installed Chrome 153.0.8010.53 then Edge 154.0.4258.37 ran serially, one fresh page each, one preparation pair, one warm-up pair and two measured pairs. No current reference operator conditions are asserted. [Aggregate](20260926-functional-01/aggregate.json) is FUNCTIONAL_PASS with no findings; performance disposition is NOT_APPLICABLE. [Final runner status](20260926-functional-01/runner-status.json) records success.

All eight pairs (sixteen variant samples) retain checksum `0062bfe5bfe9d864`, 1,000 successful results and 26,856,175 copied payload bytes per variant. Each steady sample uses one versus 1,000 successful process calls, 32,000 logical cubics, 1,818,150 sizing/emission visits each and 925,075 emitted cubic lines, with no reserve/growth/retry/cache hit. Both sessions acknowledge dispose exactly once with status 0 and reach zero live linear/cache payload memory. Primary separately verified these raw invariants and source/build hashes. These payload counters retain their JS-object/allocator/physical-memory exclusions.

All seven original records are preserved; browser records are losslessly compressed as `chrome-r1.json.gz` and `edge-r1.json.gz`. The [archive manifest](20260926-functional-01/archive-manifest.json) retains original/stored byte lengths and SHA-256. `node:zlib.gunzipSync` restores the exact original JSON bytes. No historical observation is overwritten, and the original run remains under its exclusive artifacts directory.

## Validation and remaining gate

- `pnpm exec prettier --check packages/geometry-wasm/src/abi.ts` — PASS.
- `pnpm exec vitest run tests/unit/geometry-provenance.test.ts tests/unit/geometry-adapter.test.ts` — PASS: 16 existing tests.
- `node_modules\.bin\prettier.cmd --check tests/unit/geometry-output-points.test.ts`, `node_modules\.bin\eslint.cmd tests/unit/geometry-output-points.test.ts`, and `node_modules\.bin\vitest.cmd run tests/unit/geometry-output-points.test.ts` — PASS: focused formatting/lint and eight tests. Worker used local binaries after Corepack sandbox access prevented its initial pnpm invocation.
- `pnpm check` — PASS: formatting, lint, TypeScript, 315 tests in 43 files and package boundaries.
- `pnpm build` — PASS: five TypeScript libraries and playground production build, 43 modules.
- Functional command above — PASS: rustfmt, Clippy, 25 native tests, two identical release WASM builds, 25 real-WASM/native integration tests in three files, production page build (11 modules), Chrome/Edge 2/2 and independent record evaluator 1/1. The framed native bridge is explicitly invoked despite its ordinary cargo-test ignore marker.
- Changed Markdown formatting, local link/anchor validation, staged source/archive hash review and whitespace checks are required before commit; final results are recorded on the PR.

The old P2.6d diagnostic tooling remains immutable and pinned to its original ABI source; it was not modified or rerun against this change. A later full reference run with current environment observations must determine performance acceptance. This checkpoint neither promises the 1.20 threshold nor changes A08's current FAIL disposition.
