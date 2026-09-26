# P2.6b exact provenance arithmetic review — 2026-09-26

Disposition: local P2.6b PASS, pending required CI and protected integration. This checkpoint preserves provenance acceptance using exact Number arithmetic. It makes no performance claim: P2 A08 retains the [valid reference FAIL](../../benchmarks/results/20260926-p2-batch-v1-reference-01/README.md), and full P2 remains incomplete. P1 A09/A10 and P3-P5 authorization are unchanged.

## Scope and exactness proof

Base: clean main `24f8597e78eb8445886283001430f13713a1b5e3`, after PR #47. The [prospective P2.6b contract](../../plans/p2-geometry-kernel.md#p26b-exact-provenance-arithmetic) was recorded before implementation. Only the arithmetic in `packages/geometry-wasm/src/abi.ts` provenance validation changes in production.

Decoded provenance values are Uint32. The unchanged depth check runs before exponentiation and permits only depths 0 through 20. The unchanged numerator check then permits only integers from 1 through the denominator, which is exactly `2 ** depth`. Every saved previous numerator and denominator has already passed those checks; initial state is 0/1. Thus both products in the continuity comparison are nonnegative integers bounded by 2^40. Binary64 represents every such integer exactly, including the subtraction of one and powers of two. Exact equality therefore has the same result as the previous BigInt calculation for every value reaching that comparison. Invalid depths and numerators are rejected first, with the same errors and ordering. This argument depends on the current depth limit; any future increase must revisit the bound.

Primary inspected every changed guard and the surrounding decoder. Source-ordinal resets, verb/point counts, emitted-line cap, complete coverage, error strings, copied arrays and cache/lifetime handling remain unchanged. The raw/public API, Rust algorithm and work limits, benchmark workload/consumer/thresholds, dependencies and module boundaries are unchanged. No new runtime helper or export was added.

## Fixtures and delegation

One GPT-5.6 Terra medium worker implemented the bounded arithmetic change and packed decoder fixtures; no child delegation. Primary requested two corrections before acceptance: compare the actual decoder against the test-only BigInt oracle for the same adversarial partitions, and make valid fixture endpoints follow the declared line-equivalent source cubic. Both were corrected and reviewed.

The ten new tests cover a valid mixed partition reaching depth 20 with continuity cross-products above 32 bits, whole depth-zero coverage, depth 21 and Uint32-extreme depths, zero/over-denominator/Uint32-extreme numerators, gap/overlap mutations and incomplete coverage. Explicit malformed fixtures check existing error text. These decoder fixtures supplement the existing real-WASM numerical and lifetime regressions; they do not replace the independent geometric oracle.

## Functional records

Command: `pnpm benchmark:p2 --profile functional --output-dir artifacts/p2.5/20260926-p2-6b-functional-01`.

Preserved without modification: [invocation/source](20260926-functional-01/invocation.json), [build/compiler](20260926-functional-01/build.json), [Chrome](20260926-functional-01/chrome-r1.json), [Edge](20260926-functional-01/edge-r1.json), [aggregate](20260926-functional-01/aggregate.json), [completion](20260926-functional-01/completion.json), [runner status](20260926-functional-01/runner-status.json) and [archive byte hashes](20260926-functional-01/archive-manifest.json). The source record honestly reports a dirty checkpoint worktree; Primary verified all 33 measured source entries against the final implementation. Its manifest SHA-256 is `732d2a8a32b1f7f77c7a6ea93c0bfff2f2832c132a41dafa0d9c31ad1b137b94`. Source-start/end and build integrity checks passed.

WASM SHA-256 remains `861762ca8d5e48d6cc5c602e82ef98652b9d7fa326068a0756d4e301497d25cc`, with two independent release builds identical. Production asset manifest SHA-256 is `702ef1b99df759ae692a855411c55640167383cc144a5b703e13e4fd9980bfdc`.

Windows x64 10.0.26200, Ryzen 7 3700X, 16 logical cores, 34,291,060,736 memory bytes; Node 24.15.0, pnpm 11.1.2, pinned Rust 1.94.1/MSVC and LLVM 21.1.8. Installed Chrome 153.0.8010.53 then Edge 154.0.4258.37 ran serially headless, one fresh page each, one preparation pair, one warm-up pair and two measured pairs. This profile has no reference operator/environment assertion and performance disposition is NOT_APPLICABLE.

All eight retained pairs (sixteen variant samples) have checksum `0062bfe5bfe9d864`, 1,000 successful paths and 26,856,175 copied payload bytes per variant, matching the prior reference output. Every steady sample uses one batch process call or 1,000 per-path calls, zero reserve/growth/retry and no retained cache. The raw-record validator verifies 32,000 logical cubics, 1,818,150 sizing and emission visits each, and 925,075 emitted cubic lines per steady sample. Both sessions dispose exactly once with status 0 and end with zero live linear/cache payload memory. Primary independently checked source/archive hashes, pair checksums, result/payload counts, call counts, reserve/growth and cleanup against the raw records.

## Validation

- `pnpm exec prettier --check packages/geometry-wasm/src/abi.ts tests/unit/geometry-provenance.test.ts` — PASS.
- `pnpm exec eslint packages/geometry-wasm/src/abi.ts tests/unit/geometry-provenance.test.ts` — PASS.
- `pnpm exec vitest run tests/unit/geometry-provenance.test.ts tests/unit/geometry-adapter.test.ts` — PASS: 16 tests.
- `pnpm check` — PASS: formatting, lint, TypeScript, 307 unit tests in 42 files and package boundaries.
- `pnpm build` — PASS: five TypeScript libraries and playground production build, 43 modules.
- Functional command above — PASS: rustfmt, Clippy, 25 native unit tests, two identical WASM release builds, 25 real-WASM/native integration tests in three files, 11-module production page build, Chrome/Edge 2/2 and record evaluator 1/1. The framed native bridge is explicitly invoked by geometry integration despite its ordinary cargo-test ignore marker.
- Changed Markdown formatting, local link/anchor check, `git diff --check`, staged source/archive hash comparison and scope review are required before commit; final outcomes are recorded in the PR.

A complete new reference run remains necessary to evaluate A08. Functional durations cannot establish an improvement, and this arithmetic change is not assumed sufficient to reach median paired speedup 1.20 in every repetition.
