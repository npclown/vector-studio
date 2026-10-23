# R0 review close-out, 2026-10-23

Independent reviews that close the [D10](../plans/d10-roadmap-reset.md) R0 review backlog: E1, V-1, V-2 and V-3, plus the re-review of PR #216 (E3-U2c). Each review ran in a fresh context under the `reviewer` role of [`AGENTS.md`](../../AGENTS.md#agent-roles), read-only, in a Linux cloud container (Node v22.22.0, cargo available, no GPU or headed browser).

Environment note for every review: `pnpm check` fails one of 1,326 unit tests here, `tests/unit/p3-b0r-identity.test.ts` (pinned SHA-256 of the B0R random corpus). The file was last changed in #168 and none of the reviewed changes touch it; the container runs Node v22.22.0 while `engines` pins 24.15.0. Format, lint, typecheck and `pnpm run check:boundaries` pass. Windows CI is the gate of record.

Headed GPU specs and benchmarks are NOT RUN in every review below (no headed WebGPU browser here). Recorded headed evidence was judged on internal consistency only. Precision stays UNVERIFIED until A04 evidence exists; no review makes a performance claim.

## Summary

| Item | Change | Tier | Verdict | Blocking | Follow-ups |
| --- | --- | --- | --- | --- | --- |
| E1 | 7a48ab9 (#202) | Full | ACCEPTED | none | 2, backlog [E9](../plans/d9-rendering-track.md#status-index) |
| V-1 | dd4534c (#201) | Light (D10) | ACCEPTED | none | 1 doc fix applied; 3 to backlog [V-6](../plans/d9-visualization-track.md#status-index) |
| V-2 | d9b4b8d (#207) | Light (D10) | ACCEPTED | none | 1 contract note applied |
| V-3 | e6eb90f (#209) | Full | ACCEPTED as A07 partial evidence | none | 2 doc fixes applied; 2 to backlog V-6; 1 already historical |
| PR #216 | a164d30, E3-U2c | Full | READY after merge of `main` | merge conflict, fixed in 2096025 | 1 cosmetic, deferred |

## E1

ST-U10 implements E1-K1 as the [ST-U9 addendum, E1](../plans/p3-b2-stroke-contract.md) specifies: the checkpoint sits after the cell-boundary loop and before the span loop; the abort condition `W + F_L > max_work` matches `charge`; both guards line up with `emit_boundary` and `push_contributor`; the forecast uses checked `u64` arithmetic and falls back to no abort on overflow; only `new_stroke` sets the flag. Only abort timing changes.

Commands:

- `cargo test --release --lib stroke_early_abort` at 90b0633 — PASS, 10 passed, 1 ignored.
- `node tooling/p3-stroke-e1-corpus.mjs c1` — 1,195 cases, SHA-256 `52940665…`, equal to the record (the hash does not depend on Node 24).
- `P3_E1_CORPUS=… cargo test --release --lib e1_c1 -- --ignored` — PASS in 457 s; tally equal to the record (10,568 runs, fired 58 small and 789 large, 345 blocked, 4,606 exactness checks).
- On the 7a48ab9 tree: `cargo test --release --lib` — PASS, 468 passed, 60 ignored; `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` — PASS.
- NOT RUN: dump identity against the pre-merge base, `pnpm test:geometry`, the p2/p3 identity suites and the E1-D1 to D3 seeded-defect reruns (WASM build or kernel edits needed; covered by the PR record).

Follow-ups (cannot change an outcome; backlog E9):

1. The guard equality points (`rounded_line_fill.rs:1676`, `:1681`) are untested: changing `<=` to `<` passes every test. Add points at `max_boundaries = boundaries + S` and `max_contributors = contributors + vertical`.
2. The `blocked` counter does not say which guard blocked, so the E1-F4 contributor row would pass on the boundary guard under lower default caps. Count each guard separately.

## V-1

Every unit criterion (V1-A3 to A6) has its 28 tests and they pass; V1-A14 and V1-A16 hold. The recorded headed values (operation ids, notice sets, A7 deltas) match the spec literals. The page uses only published exports and stores plain JSON state.

Commands: `pnpm vitest run tests/unit/viz-v1-appearance.test.ts tests/unit/v3a-path-pipeline.test.ts tests/unit/v3b-mesh-backend.test.ts` after `pnpm build` — PASS, 78/78. `pnpm build` — PASS.

Follow-ups:

1. Stale residual text in the V-1 evidence — fixed in this record's PR.
2. A notice can be credited to newer settings: `viz-v1-appearance.ts:442-448` calls `tracker.setState` at queue time, so a width-8 `work-limit` notice that arrives after a width-9 commit is filed under width 9. The status is labelled derived. Backlog V-6.
3. A zoom change clears only the latest state failure (`viz-v1-appearance-state.ts:650-662`), against contract §3.4. Backlog V-6.
4. The width and miter number fields keep `aria-invalid` after a slider commit (`viz-v1-appearance.ts:376-377`). Backlog V-6.

## V-2

Every row V2-A1 to V2-A18 points to existing, matching evidence. A probe of 37 inputs (implicit repeats, `1e-3`, `.5.5`, `-.5-.5`, invalid exponents, arcs, `Z` handling, commas, signed zero, range limits, empty input) matched contract §1.2 and §1.4 in every case. The oracle is independent of the parser.

Commands: `pnpm vitest run` on the parse, state, v3a and v3b tests — PASS, 4 files, 235 tests. `pnpm build` — PASS.

Follow-up: the degree-elevation bound of contract §1.3 is relative and does not hold for subnormal intermediates (`M 0 0 Q 1e-323 0 0 0`); the V2-A6 test already excludes them. A dated note is added to §1.3 in this record's PR. No code change.

## V-3

Every VZ3-A1 to A19 row points to an existing assertion, and the recorded values match the predicted literals and agree with each other. The checks cannot pass vacuously: probes are compared with an independent oracle, the churn probes distinguish the two orders, leak counters are read at every cycle end and a null `pathMesh` fails the CPU gates. What A07 still lacks is stated in contract §1.2, and X1 lists it as partial.

Commands: `pnpm vitest run tests/unit/v3a-path-pipeline.test.ts tests/unit/v3b-mesh-backend.test.ts tests/unit/viz-v3-integration-scene.test.ts` — PASS, 60 tests. `git diff --stat e6eb90f~1 e6eb90f -- packages package.json apps/playground/package.json pnpm-lock.yaml` — empty. NOT RUN: `tests/geometry/viz-v3-packer-churn.test.ts` (needs the WASM build), `pnpm build`.

Follow-ups:

1. `portCalls` counts batched calls, not built keys, so a regression that also rebuilds an unchanged path inside R2's in-window batch would still read fill +1. Gate path-mesh `entries` and `bytes` in R2. Backlog V-6.
2. The `meshInstances` evidence row is a high-water mark, not a slot count. A note is added under the table in this record's PR.
3. The pre-D10 status row naming the old branch is in the kept history section; left as written.
4. X1 A07 read "None yet; A07 partial" — reworded in this record's PR.
5. Optional: an explicit non-null assert in the spec's `delta()`. Backlog V-6.

## PR #216 re-review

The B1 fix in `zClip` is correct and complete, including the symmetric incoming case; the "both neighbours cut" case cannot occur on a convex polygon. Every speed-up of contract section 14.8 is an exact identity or a sound filter (Bernstein hull, `signAtRoot` prefilter, `imid`, scaled frame, seam budget, lazy halves and witnesses). The earlier merge dropped nothing from `main`, and the PR states that the corpus is not frozen and that no threshold or cap changed.

Commands at a164d30: `pnpm test:e3-a04` — PASS, 78/78. `git merge-tree --write-tree origin/main a164d30` — CONFLICT in `docs/plans/d9-rendering-track.md` only.

Disposition: `main` was merged into the PR branch in 2096025, keeping the D10 one-line E3 row; `a04-region.ts` is unchanged, so its SHA-256 stays `47117f77…` as the freeze evidence records. After the merge, `pnpm test:e3-a04` — PASS, 78/78; typecheck and lint PASS. The cosmetic SHOULD-FIX (a JSDoc line above `normalsNear` that belongs to `pointsNear`, `a04-region.ts:3763`) is deferred to the next E3 code change so the recorded oracle hash stays valid.
