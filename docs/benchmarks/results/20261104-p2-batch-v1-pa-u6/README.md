# PA-U6: P2 A08 re-run, p2-batch/v1, 2026-11-04

Status: **A08 FAIL, valid observation; PA-A07 discloses it and does not block** (pre-alpha gate plan, [PA-A07](../../../plans/pre-alpha-gate-plan.md#3-acceptance-criteria), verdict by PA-Q4 (a), user decision 2026-11-02). All ten repetitions miss the median paired B/A >= 1.20 requirement, by the same margin as both September reference runs. The frozen benchmark, workload, consumer and thresholds are unchanged.

## Identity

- Measured head: `6e172765708cf5bde319ca46bfe02b90376dee3d` (origin/main on 2026-11-04, after PA-U8 #497 and the P2 runner fix #498). The source record is marked dirty only by three untracked local items outside the hashed files; `sourceMatches=true` and `buildMatches=true` in [completion](reference/completion.json).
- Commands: `pnpm benchmark:p2 --profile functional --environment-json .tools/pa-u6-environment-02.json --output-dir artifacts/p2.5/20261104-pa-u6-functional-02`, then the same with `--profile reference` and `--output-dir artifacts/p2.5/20261104-pa-u6-reference-02`.
- [Reference invocation](reference/invocation.json) SHA-256 `f36799b521a28d9abf9d352f54801ea951af6147f3336faefdb58e6d50e055bf`; [build manifest](reference/build.json) SHA-256 `53d277ecba4b792056631bb20d4a6015b8980e120fe503e2316d4295470dd496`; production build `208f1ce239d9c550faa8d899a11e27c9ebeeb363408fcdf6e33cb8b8a8f222f3`; WASM `58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35` (Rust 1.94.1, wasm32 release, the pinned profile).
- The runner's configuration hash differs from the September runs because [#498](https://github.com/npclown/vector-studio/pull/498) added `testIgnore: ['p3-*/**']` to `playwright.p2-benchmark.config.ts`, so that the P3 specs added since September are no longer collected. The P2 spec, workload and evaluator are untouched.

## Environment

Main PC DESKTOP-DKVUSAV: Windows x64, Ryzen 7 3700X, GTX 1660 SUPER driver `32.0.16.1088`, Node 24.22.1, headed Chrome 156.0.8078.81 then Edge 156.0.4314.58, one worker, five fresh repetitions each, no retries. [Hardware preflight](hardware-preflight.json) and [environment](environment-02.json) observed at 12:48:18Z: AC power, Balanced scheme, primary display 1920x1080 at 60 Hz plus a second display. Background load is an agent observation, not operator confirmation: the user closed Chrome at 12:48Z, no chrome or msedge process ran before the run, and no build, test or other measurement ran during it; resident apps were idle to light. Window occlusion was not confirmed by an operator. This CPU/WASM benchmark makes no presentation claim.

The runner runs the full geometry validation (1,217 geometry vitest tests, about 19 minutes, and 595 Rust tests) before each profile, so the reference measurement started right after that CPU load ended. The September runs had the same order.

## Results

[Functional](functional/aggregate.json): FUNCTIONAL_PASS (Chrome and Edge r1).

| Browser | Repetition | Median paired B/A | Batch p95 ms | Per-path p95 ms | A08                   |
| ------- | ---------: | ----------------: | -----------: | --------------: | --------------------- |
| Chrome  |          1 |          0.996381 |        389.4 |           387.6 | FAIL: speedup and p95 |
| Chrome  |          2 |          0.997396 |        440.7 |           414.1 | FAIL: speedup and p95 |
| Chrome  |          3 |          1.002627 |        388.7 |           388.4 | FAIL: speedup and p95 |
| Chrome  |          4 |          0.991460 |        421.5 |           384.8 | FAIL: speedup and p95 |
| Chrome  |          5 |          0.998910 |        391.7 |           390.1 | FAIL: speedup and p95 |
| Edge    |          1 |          0.998391 |        388.0 |           395.6 | FAIL: speedup         |
| Edge    |          2 |          1.002192 |        387.6 |           386.7 | FAIL: speedup and p95 |
| Edge    |          3 |          1.004169 |        390.8 |           390.6 | FAIL: speedup and p95 |
| Edge    |          4 |          0.991784 |        397.5 |           388.7 | FAIL: speedup and p95 |
| Edge    |          5 |          0.995405 |        392.1 |           388.0 | FAIL: speedup and p95 |

30 measured pairs per repetition, 300 in all, none discarded. Worst paired median `0.9914600550923137`. The [aggregate](reference/aggregate.json) and raw captures (gzipped, lossless) keep full precision. Both variants take about 370 to 383 ms at the median, as in September (`1.0057` to `1.0186` there): batching the process call does not shorten the sample, so most of each sample is work common to both variants. This record does not diagnose that cost; P2 performance work stays deferred under [D7](../../../plans/p2-follow-on-entry.md). D7's temporary P3-entry floor (every paired median >= 1.00, met by the September run) is now missed in seven of ten repetitions (0.991 to 0.999); the differences are within the repetition-to-repetition spread of either run, and this record does not claim a regression or reopen D7. The reference runner exits 1 because the acceptance result is FAIL ([runner status](reference/runner-status.json)); that is the evaluator, not a geometry failure.

## Failed attempt 1

The first attempt, at `5765b47` and ending 12:07Z, was FUNCTIONAL_FAIL before any capture: the P2 Playwright config also collected the P3 specs. Its small records are kept in [failed-attempt-01](failed-attempt-01/aggregate.json); #498 fixed the config, and this run is attempt 2.

## PA-U8 R34 (same sitting)

[`r34-output.txt`](r34-output.txt): `tests/m6a-next-host/pa-u8-r34.spec.ts` passed 4/4 (Chrome and Edge, `Malgun Gothic` and `Times New Roman`), max |layout - canvas| = 0 in every case. A first invocation without `M8_N3_BASELINE` failed all four at the layout-budget check before measuring; the passing runs set it to `docs/evidence/m8-a14-2026-11-01/17a2b0a-main-pc-headed.json`.

## Verdict

PA-A07: P2 A08 FAIL as measured, disclosed on the exit card, non-blocking under PA-Q4 (a). PA-A09 R34 half: PASS. No threshold, workload or evidence was changed.
