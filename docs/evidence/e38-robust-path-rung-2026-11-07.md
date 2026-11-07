# E38: a robust last rung so pen paths always draw, 2026-11-07

Rendering-track item E38 ([contract](../plans/d9-e38-robust-path-rung-contract.md)). This record holds the defect, the measured results and the validation. Identity: `geometry-wasm/fill-v0+r6`, `geometry-wasm/stroke-v0+r9`.

## 1. The defect

On 2026-11-07 the user sent two pen paths from the editor (main PC, :4194, latest `main` d9b5f88), both drawn with the pen tool and stroked white, 1 px, butt, miter 4:

- node-5: 739 × 609 px, 18 cubics, closed, no fill.
- node-7: 1,240 × 733 px, 19 cubics, closed.

Neither draws. Measured natively on d9b5f88 (`fill-v0+r5`, `stroke-v0+r8`) at `e` = 0 to −6 (zoom 1 at DPR 1 is `e = −3`; the user's DPR 1.25 is `e = −4`):

| Path | Stroke | Fill (nonzero) |
| --- | --- | --- |
| node-5 | `work-limit` at `e ≤ −1` (`NodeLimit`, then `InputLimit`) | `work-limit` at `e = 0` and `e ≤ −4` |
| node-7 | `work-limit` at every `e` from 0 to −6 | `work-limit` at `e = 0`, −2, −3 and below |
| node-3 (2026-11-06) | `work-limit` from `e = −2` down | `work-limit` at `e ≤ −5` |
| node-8 (2026-11-06) | `work-limit` from `e = −3` down | `work-limit` at `e ≤ −5` |

The renderer's coarser retry (#522) climbs three exponents at most, so at `e = −4` it cannot reach an exponent where node-7's stroke builds. Every earlier fix (E35 #524, E14-U2 #528, #522) moved one cap; the cost of the exact arrangement grows with length over tolerance and with crossings, so the next larger or busier path passed the new cap. The cause is structural: there was no rung that always succeeds.

## 2. The fix

See the [contract §2](../plans/d9-e38-robust-path-rung-contract.md#2-the-rule). In short: after an exact `work-limit` or `unsupported-geometry`, the kernel flattens the path at `2^(e-1)`, builds stroke pieces (quads, joins, caps) or takes the fill's chords, and trapezoidates them with a slab sweep under the rule, into buffers reserved with the engine. The renderer draws a mesh with no boundary edges without the coverage fringe and no longer hides a path whose fringe or joint overlay it cannot build.

## 3. Results (native, release, one container)

`e38_measure_corpus` (`cargo test --release --lib e38_measure_corpus -- --ignored --nocapture`), the robust rung alone. Memory: 6,826,112 reserved bytes per engine (fill and stroke each own one). No build coarsened (R4) on the corpus.

| Path | `e` | Fill chords / trapezoids / time | Stroke chords / trapezoids / time |
| --- | --- | --- | --- |
| node-3 | −3 | 813 / 679 / 0.15 ms | 813 / 3,934 / 5.0 ms |
| node-3 | −8 | 4,532 / 3,776 / 1.1 ms | 4,532 / 22,099 / 67 ms |
| node-5 | −3 | 718 / 648 / 0.13 ms | 718 / 3,561 / 3.3 ms |
| node-5 | −4 | 1,013 / 909 / 0.24 ms | 1,013 / 4,989 / 6.3 ms |
| node-5 | −8 | 4,033 / 3,601 / 0.64 ms | 4,033 / 19,905 / 55 ms |
| node-7 | −3 | 1,198 / 861 / 0.24 ms | 1,198 / 5,785 / 5.5 ms |
| node-7 | −4 | 1,687 / 1,208 / 0.32 ms | 1,687 / 8,146 / 8.9 ms |
| node-7 | −8 | 6,720 / 4,767 / 1.2 ms | 6,720 / 32,628 / 86 ms |
| node-8 | −4 | 938 / 938 / 0.10 ms | 938 / 4,562 / 3.5 ms |
| E35 node6 | −4 | 1,088 / 945 / 0.16 ms | 1,088 / 5,327 / 5.0 ms |

The worst case on the corpus is node-7's stroke at `e = −8` (zoom 32 at DPR 1): 86 ms natively, under the trapezoid budget of 32,768 by a small margin; a larger path at that zoom coarsens once (R4) and draws at twice the tolerance. At the editor's exponents every path builds in under 10 ms. Before the rung runs, the exact rung still spends its own budget (200 to 400 ms natively on node-7's stroke, `NodeLimit`); that latency is a follow-up ([contract §6](../plans/d9-e38-robust-path-rung-contract.md#6-not-in-e38)).

## 4. Validation

| Check | Result |
| --- | --- |
| E38-A1 `e38_user_paths_always_draw` (release, ignored): node-3, node-5, node-7, node-8 and the six E35 cases, fill and stroke, `e` = 0 to −8, 600 samples per robust mesh against the reference | PASS; robust builds (fill, stroke) = (39, 60) |
| E38-A1 `e38_user_node5_node7_draw_at_editor_exponents` (CI) | PASS; robust builds (3, 4) |
| E38-A2 `e38_fuzz_pen_paths_match_the_reference` (12 cases, CI) and `_full` (96 cases, release) | PASS |
| E38-A3 `e38_fuzz_never_refuses` (3 cases, CI) and `_full` (40 cases, release) | PASS |
| E38-A4 `e38_build_allocates_nothing`, `e38_robust_rung_through_the_export` (fill: E14-U2 `x_f7` at −4 and node-7 at −3; stroke: node-7 at −3), no allocation, storage unchanged, empty boundary, `work-limit` without the rung | PASS |
| E38-A5 the kernel suite, debug as CI runs it (`cargo test --locked --offline`) | 546 passed, 0 failed, 75 ignored |
| `cargo fmt --check`, `cargo clippy --all-targets -D warnings` on Rust 1.94.1 | PASS |
| `pnpm exec vitest run` (unit) | PASS except `p3-b0r-identity` "matches its pinned SHA-256", which fails identically on `main` d9b5f88 in this container (Node 22, not the repository's pinned Node 24.22.1) |
| E38-A6 headed (`pnpm test:gpu` on the main PC) and the editor at :4194 | After merge |

The reference is a 256-chord-per-cubic flattening with Wang's error bound added to the margin; samples within the margin of the ideal boundary are not judged. For miter and bevel joins and butt caps the stroke oracle also skips samples near a corner, where the reference disk union is not the requested join.

## 5. Changed tests

- Revision pins: `fill-v0+r6` and `stroke-v0+r9` in the adapters, the export tests, the geometry analysis tests and five GPU specs.
- `v3a-path-pipeline`, `v3c-path-fringe`, `st-u6-stroke-pipeline`, `st-u7-joint-pipeline`: a path whose fringe or joint overlay cannot be built now draws without it (the notice stays, with the new text), where it was hidden before.
