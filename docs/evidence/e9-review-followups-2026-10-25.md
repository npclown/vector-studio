# E9: E1 review follow-ups (2026-10-25)

Item E9 of the [rendering track](../plans/d9-rendering-track.md) closes the two follow-ups of the [E1 review](r0-review-closeout-2026-10-23.md#e1). Both changes are test-only (`cfg(test)` probe fields and native tests). No kernel path, output, limit or revision changes: fill stays `fill-v0+r3` and stroke stays `stroke-v0+r7`.

## Changes

1. Guard equality points. `e9_edges_1024_guard_equality_points` runs `edges-1024` at `max_work = W + F_L - 1` with `max_boundaries = boundaries + S` (1,020) and `max_contributors = contributors + Σ_vertical |Δrank|` (1,024): E1-K1 fires at both. One below each, the named guard blocks it; the full run keeps `WorkLimit` at `max_boundaries` 1,019 and `ContributorLimit` at `max_contributors` 1,023.
2. Per-guard counter. `EarlyAbortProbe` adds `boundary_blocked` and `contributor_blocked`; `blocked` stays their sum. E1-F4 asserts the guard that blocks each row, the E1-C1 sweep asserts that each boundary-guard point is blocked by the boundary guard and each contributor-guard point by the contributor guard, and the sweep checks `blocked = boundary_blocked + contributor_blocked`.

## Validation

- Mutation check: with `<` in place of `<=` in the boundary guard, then in the contributor guard (`rounded_line_fill.rs`, `early_abort_certain`), `cargo test --release --lib stroke_early_abort` fails in `e9_edges_1024_guard_equality_points` each time; every other test still passes, as the review found.
- `cargo test --release --lib` — PASS, 516 passed, 69 ignored. `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` — PASS.
- `node tooling/p3-stroke-e1-corpus.mjs c1` — 1,195 cases, SHA-256 `52940665…`, equal to the record.
- `P3_E1_CORPUS=… cargo test --release --lib e1_c1 -- --ignored` — PASS in 189 s. Tally equal to the E1 record (10,568 runs, fired 58 small and 789 large, 345 blocked, 4,606 exactness checks); the 345 blocks split into 288 boundary (the 288 boundary-guard points) and 57 contributor (the 57 contributor-guard points). The sweep asserts each point's guard, so no contributor-guard point is blocked by the boundary guard at the default caps.
- Linux, Node 22.22; CI covers Windows.
