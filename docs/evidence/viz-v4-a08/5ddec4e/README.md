# V-4 A08 counted headed run at snapshot 5ddec4e, 2026-10-26

This is the counted A08 run of the [V-4 contract](../../../plans/viz-v4-a08-corpus-contract.md), made on the [E11 exit snapshot record](../../../plans/d9-e11-p3-c03-c05-closure-contract.md#12-exit-snapshot-record). Its result is **INCONCLUSIVE**: 0 gated FAIL, 372 gated UNDECIDED. Every UNDECIDED entry is in one of two known classes of [E3 section 21](../../../plans/d9-e3-b4-precision-contract.md#21-known-classes-and-pass-with-disclosure-2026-10-26), as [contract section 18](../../../plans/viz-v4-a08-corpus-contract.md#18-counted-run-and-disclosed-classes-2026-10-27) records. Whether this closes A08 is the P3 exit decision (E11); this record does not mark A08 done.

Files: [record.json](record.json) (the metrics record), [record.md](record.md) (its generated summary) and [summary.md](summary.md) (every UNDECIDED key, the per-part tables and the per-case A02 rows). The expected-status list is committed at [`tests/visual/viz-v4/a08-expected-status.json`](../../../../tests/visual/viz-v4/a08-expected-status.json).

## Run identity

| Identity            | Value                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Snapshot            | `5ddec4e`, run in a clean worktree at `00e49bf` (#271; changes since 5ddec4e are documents, tests and harness only)            |
| Kernels             | `geometry-wasm/fill-v0+r4`, `geometry-wasm/stroke-v0+r7`                                                                      |
| Release WASM        | `58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35`                                                            |
| Renderer            | Mesh shader `d306137c…` (`p3-mesh-fill-v0`), render-state key `premultiplied-source-over/stencil8-write-once/no-cull/triangle-list-v1` (E17) |
| Subset              | `a08-subset/v1`, 2280 cases (1032 gated), `keysSha256` `1d406287fc3b8141d0494f15f68f0e628062320927d8610e5923cdc71ff192a4`      |
| Expected list       | `a08-expected-status/v1`, SHA-256 `186545b676b87045a4645f03b55718dfa6082d5aaff9435c207602df2baf319d`                           |
| Host                | User PC DESKTOP-DKVUSAV, Windows, discrete GPU, Node 24.15.0 (V8 13.6.233.17-node.48)                                          |
| Headed run          | `pnpm test:gpu:viz-v4`, run `artifacts/viz-v4-a08/2026-10-26T07-14-20-504Z-21328`, Playwright projects `chrome` and `edge`     |
| Metrics record      | `viz-v4-metrics/v2`, label `5ddec4e`, body SHA-256 `e8df19b25118ecf3ea852a9bbbbc0d83eb62ef85b27c192a97f1723ab109d823`          |

The run directory (captures and count images) stays on the PC. The body SHA-256 was re-checked against the committed `record.json`.

## Expected statuses and the headed run

| Variant   | RENDERED | REGION-ONLY | KERNEL-REJECTED | EMPTY-CROP |
| --------- | -------- | ----------- | --------------- | ---------- |
| fringe-1x | 1887     | 257         | 112             | 24         |
| fringe-4x | 1887     | 257         | 112             | 24         |
| msaa-4x   | 2144     | 0           | 112             | 24         |

No gated case is `RENDERER-FAILED` or `EMPTY-CROP` with reason `port-empty`. The headed run passed 24 of 24 spec tests in 2.3 h (Chrome 56 min, Edge 1.4 h), with 0 deviations from the list and 0 `MESH-MISMATCH` calls. At every gated DPR in both browsers, 0 of the expected-`RENDERED` gated cases were not rendered. Six ungated C5 stroke cases reported a port `empty` (`portEmpty`, report only).

## Criteria

| Criterion | Result    | Detail                                                              |
| --------- | --------- | ------------------------------------------------------------------- |
| VZ4-A3    | PASS      | Both projects; no missing, extra or duplicate case or group         |
| VZ4-A4    | PASS      | 0 status or call mismatches                                         |
| VZ4-A5    | PASS      | 0 pixel or record failures, 0 undecided                             |
| VZ4-A6    | UNDECIDED | 4128 gated case-variants, 0 FAIL, 372 UNDECIDED                     |
| VZ4-A7    | UNDECIDED | 4128 gated case-variants, 0 FAIL, 368 UNDECIDED                     |
| VZ4-A9    | PASS      | `pnpm coverage:viz-v4 --replay` on the PC wrote a byte-identical `record.json` |
| Result    | INCONCLUSIVE | Section 5.3: a gated case is UNDECIDED; no gated case FAILS     |

G3's "at most 1" holds in every gated case (0 `overCount`). Under E17 it checks the count pass's replay of the write-once stencil; the product side rests on E17-A2 and E17-A5 ([E17 record](../../../plans/d9-rendering-track.md#status-index)).

## The 372 gated UNDECIDED

Entries are key × variant × browser. Both browsers give the same keys, and so do `fringe-1x` and `fringe-4x`.

| Class (E3 section 21) | Entries | Keys                                                  | Reasons                                                            |
| --------------------- | ------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `far-vertices`        | 368     | C1/s19-I to s26-I under T0, T2, T5, T7 at DPR 1, 1.5, 2 | `clip bound ≥ 0.25 px` in all 368; with `beta ≥ 1 px` in 336, of which 128 also have a no-flip zone |
| `collapsed-feature`   | 4       | C4/n03/T2/z1-d2/center/k0@dpr2 (gap `g = 2^-16`)       | `G2-undecided`: 2 pixels at obs 0 within β_c of the 1 px class      |

C1/s19-I to s26-I are the named far-offscreen rows. Their drawn triangles reach far outside the canvas, so the GPU clips them, and the clip bound or β_c leaves pixels undecided. No gated entry is UNDECIDED for any other reason. The DPR 3 entries (ungated, reported) fall in the same two classes: 128 `far-vertices` in the same C1 rows and 4 `collapsed-feature` in C4/n07 (`g = 2^-16`).

## Per part, for A02 (fill rules)

Case × browser at the gated DPRs 1, 1.5 and 2, each fringe variant alike. "Not judged" is a null judgment: the case was not drawn with a fringe.

| Part                     | PASS | FAIL | UNDECIDED | Not judged                                                        |
| ------------------------ | ---- | ---- | --------- | ----------------------------------------------------------------- |
| C1 named fill lines      | 728  | 0    | 184       | 48 `REGION-ONLY` (`fringe-unsupported`)                           |
| C3 named fill cubics     | 528  | 0    | 0         | 144 `REGION-ONLY` (`fringe-work-cap`), 48 `KERNEL-REJECTED` (`unsupported-geometry`) |
| C4 near-coincidence      | 286  | 0    | 2         | 0                                                                 |
| C12 T-junction fills     | 86   | 0    | 0         | 10 `REGION-ONLY` (`fringe-work-cap`)                              |

At DPR 3 (reported): C1 240 PASS, 64 UNDECIDED, 16 not judged; C3 144 PASS, 96 not judged; C12 28 PASS, 4 not judged. Every C1, C3 and C12 case, key by key with its `fringe-1x`, `fringe-4x` and `msaa-4x` judgment in each browser, is listed in [summary.md, section "A02: per-case results"](summary.md#a02-per-case-results-c1--c3--c12-3552-key-variant-rows).

## Reported, not gated

- **`msaa-4x`** is the region-only baseline that A08 compares against. It FAILS G1 or G2 in most rendered cases (for example C1 768 and C3 652 at DPR 1 to 2), as expected without a fringe. Its VZ4-A5 check passes.
- **Strokes** (C5, C9): 14 FAIL entries per fringe variant at DPR 1 to 2. Stroke coverage is not gated (E11-Q4 (a)); a stroke gate is left to E13.
- **1x against 4x:** only C1 differs, in 1,273, 2,535, 2,822 and 7,459 pixels per browser at DPR 1, 1.5, 2 and 3 (at most 64/255 at DPR 1, 128/255 above). C3, C4, C5-C9, C11 and C12 do not differ.

All counts are in [summary.md](summary.md).
