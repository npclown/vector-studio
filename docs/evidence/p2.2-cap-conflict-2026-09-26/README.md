# P2.2 frozen cap conflict — 2026-09-26

Disposition: BLOCKED pending an explicit acceptance-contract decision. This is a local, uncommitted investigation from base `844e41db85c28f336c3f6702935608666186ca2c` on `codex/p2-2-rust-kernel`, not completed P2 acceptance or performance evidence.

## Conflict and reproduction

The [private contract](../../plans/p2-private-contract.md) limits each cubic to 4,096 emitted LINEs. The [active plan](../../plans/p2-geometry-kernel.md#acceptance-and-deterministic-fixtures) requires every ordinary curve in `p2-geometry/v1` to succeed. The mandated half-split, guarded chord-error algorithm needs more than 4,096 leaves for 51 of the 10,000 frozen curves.

Run `pnpm build`, then `node docs/evidence/p2.2-cap-conflict-2026-09-26/cap-audit.mjs`. The [diagnostic source](cap-audit.mjs) imports only the frozen corpus generator and independently counts leaves using the contract's arithmetic, guard and half-splits. It omits the per-cubic cap to measure the required count, while checking the existing depth and path-visit bounds. It is not an acceptance oracle. [The captured result](result.json) records its SHA-256 and every exceeding index.

| Observation                               | Value                                                              |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Curves requiring more than 4,096 LINEs    | 51 / 10,000                                                        |
| First conflict                            | Index 209, seed 1, 4,873 leaves, 9,745 visits, depth 13            |
| Largest required count                    | Index 6059, seed 2654435769, 8,192 leaves, 16,383 visits, depth 13 |
| Every curve fits 8,192 in this diagnostic | Yes; full WASM/oracle acceptance is still required                 |

Index 209 uses local shear, world `diag(4,0.25)`, zoom 64, DPR 3 and bucket tolerance `2^-12`. Its controls are `(-2661.498059052974,-826.6451233066618)`, `(970.641509629786,553.8398623466492)`, `(-2108.662119600922,-690.7536224462092)`, `(-1913.5083323344588,-939.6924353204668)`.

Actual WASM returns per-path `WORK_LIMIT` (5) instead of the required `OK` (0) at index 209. A native boundary regression confirms 4,096 attempted leaves and 8,196 visits before that rejection, with no partial result published. Those attempted-work counts intentionally differ from the diagnostic's complete-curve counts. A temporary local 8,192-cap diagnostic also produced 4,873 leaves for this curve; it was reverted. Production retains 4,096, and the test continues to fail honestly.

## Proposed decision, not yet applied

Raise only the private per-cubic LINE cap from 4,096 to 8,192, then update the owning contract, implementation and validator consistently and rerun the complete independent corpus. Preserve the 0.25 physical-pixel error limit, corpus, subdivision algorithm, depth 20, 1,048,576 visits/path, 65,536 output verbs/path, 64 MiB input and 256 MiB output caps, public API and raw ABI.

This doubles the maximum allowed emitted LINE count per cubic. At 29 packed bytes per LINE (verb + two f64 coordinates + provenance), the per-cubic LINE payload ceiling rises from 118,784 to 237,568 bytes, excluding MOVE, headers and padding. Global path/arena caps still apply; higher bounded subdivision work is possible. No performance or full numeric acceptance is inferred from the diagnostic. Keeping 4,096 would require reconsidering the mandated algorithm or the ordinary-corpus success requirement, a broader change.

Approval is required under the user's escalation policy for requirement conflicts and acceptance changes. The Rust-installation approval does not authorize this decision. No threshold, corpus, validator or production cap has been relaxed.

## Validation and review

Environment: Windows x64, Node 24.15.0, pnpm 11.1.2, rustup 1.28.2, rustc 1.94.1 (`e408947bfd200af42db322daf0fadfe7e26d3bd1`), LLVM 21.1.8, existing MSVC, `wasm32-unknown-unknown`. Pinned installation is under ignored `.tools/rust`; system PATH is unchanged. The crate has no third-party dependencies.

- `pwsh -NoProfile -File tooling/install-rust.ps1` — PASS: pinned installer hash, Rust identity and installed targets verified.
- `pnpm test:geometry` — FAIL overall: rustfmt and Clippy pass, all 21 native tests pass, two independent locked/offline release WASM builds match SHA-256 `2327e103cb915656e159a5e28a14cbb3a19d9e0b34fd42cf4e3d995ed9eb788f`; raw Node WASM tests pass 5/6, mandatory-corpus test fails at index 209 as described above.
- `node docs/evidence/p2.2-cap-conflict-2026-09-26/cap-audit.mjs` — PASS diagnostic execution: results above; not acceptance or timing evidence.
- `pnpm check` — PASS: formatting, ESLint, TypeScript, 274 tests in 36 files and dependency boundaries. The diagnostic's missing `node:url` import was fixed before this passing run.
- `pnpm build` — PASS: four TypeScript libraries and playground (43 modules).
- `pnpm exec prettier --check --ignore-path .gitignore docs/plans/p2-geometry-kernel.md docs/evidence/p2.2-cap-conflict-2026-09-26/README.md docs/evidence/p2.2-cap-conflict-2026-09-26/cap-audit.mjs docs/evidence/p2.2-cap-conflict-2026-09-26/result.json` — PASS. The result JSON was whitespace-formatted; a fresh diagnostic parsed and compared with `node:assert` `deepStrictEqual` matches the recorded values, including the script hash.
- Local link/anchor checker from [P1.0b evidence](../p1.0b-contract-review-2026-09-12.md#validation-and-limits) — PASS: 377 local links/anchors across 78 Markdown files. `git diff --check` — PASS.
- Browser differential tests, headed GPU acceptance, benchmarks and remote CI — NOT RUN: later checkpoints; P2.2 remains incomplete.

GPT-5.6 Sol high implemented the isolated Rust crate. GPT-5.6 Sol medium reviewed tooling and numerical behavior read-only. Primary owns raw ABI fixtures, build/CI wiring, contract review and this independent feasibility diagnostic. No child delegation. Primary/reviewer findings corrected before the final Rust run: native global-state exposure, epoch-exhausted disposal, missing derivative factor in uncertain-root bounds, nonfinite guarded flatness, and a misleading temporary regression name. Native allocator instrumentation includes a positive control and verifies zero heap allocations during `process`.

Remaining work includes resolving this contract conflict, completing full corpus/boundary acceptance, protected PR validation and then P2.3 adapter/cache integration. No commit or PR was created; no renderer/public API change is claimed. P1 environment and A09/A10 obligations remain independent.
