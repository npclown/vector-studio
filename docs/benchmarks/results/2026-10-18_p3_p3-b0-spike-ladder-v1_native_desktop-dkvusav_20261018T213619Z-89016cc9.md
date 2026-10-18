# P3 B0 spike, fallback-ladder reference run 20261018T213619Z-89016cc9

Status: Exploratory until the independent evidence review (SL-A11) in the [execution plan](../../plans/p3-fill-stroke-meshes.md#b0-spike-sl-u4-reference-run) accepts it. This record is an immutable observation; corrections append a review record.

**Verdict (computed by the runner from the raw samples): INCONCLUSIVE.** Validity check 2 (prediction factor) fails with a maximum factor of 2.610 against the limit 2. The other ten checks pass, all four oracle gates pass and both harness checks pass, so the run is valid and has a verdict. Under the [frozen decision rule](../../plans/p3-b0-spike-ladder-contract.md#6-decision-rule-and-consequences) a failed check makes the verdict INCONCLUSIVE whatever the estimates are. Its scope is limited; see [Scope of this verdict](#scope-of-this-verdict).

This run is unit SL-U4 of the [B0 spike contract](../../plans/p3-b0-spike-ladder-contract.md#71-units). It measures the Alt-A1 fallback ladder (fast rung, with the exact rung on fallback) on B0's unchanged corpus, sampling, fits and decision rule, under its own scenario identity. The two `p3-b0-feasibility` v1 records, [2026-10-12](2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.md) and [2026-10-17](2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.md), are not changed.

## Scenario and contract

- Scenario `p3-b0-spike-ladder` v1, profile `reference`, runner `p3-b0-spike-runner/1`, schema version 1.
- Configuration hash `0daa96c068504c33dcf17ca787c1995db4972a76a006cd6db79473243fe72267`, equal to the reference hash recorded in the plan when SL-U3 merged (SL-A10). Corpus SHA-256 `206cf6e9971d5f38f11cbef801692555843b1602ee937c5e1b60ed7dbd329796` (580,965 bytes), equal to the contract's and both B0 records'.
- Contract: [frozen B0 spike contract](../../plans/p3-b0-spike-ladder-contract.md), which reuses the [B0 contract](../../plans/p3-b0-feasibility-benchmark-contract.md)'s corpus, fits, prediction bound, curvature guard, checks, k = 2 and budgets.
- Raw record: [`.json` beside this file](2026-10-18_p3_p3-b0-spike-ladder-v1_native_desktop-dkvusav_20261018T213619Z-89016cc9.json), a byte-for-byte copy of the runner's `record.json` (884,200 bytes, SHA-256 `180cdc14de5f8dd40267a98319b6162ef3dfacbc3d2db494261218134f47bb36`). `validateSpikeRecord` (`tests/geometry/p3-b0-spike/analysis.ts`) checks the scenario identity, recomputes the configuration hash, requires the configuration to equal `scenarioConfig('reference')`, checks the corpus hash, recomputes aggregates, fits, estimates, checks, fallback tables, oracle and harness status and the verdict from the raw samples, and accepts it.
- Command: `pnpm benchmark:p3-b0-spike --profile reference --environment-json <scratchpad>/spike-u4-env.json`.
- Uncommitted artifacts in `artifacts/p3-b0-spike/20261018T213619Z-89016cc9/`: `raw-record.json` (SHA-256 `03c25d49…0be2`), `summary.md`, `oracle.json`, `oracle-dump.json` (13,532,654 bytes, 1,270 paths, SHA-256 `3ccd703f44590933917fba66c0eb11c454ba9ad36e28a2e59e9e6c10d7cc548c`, as the record states; the same dump hash as SL-U3's functional runs), `diagnostic.json`, `process-listing.txt` and the per-process logs.

## Environment

| Item       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine    | DESKTOP-DKVUSAV, the reference machine per the prototype plan's accepted constraint 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CPU, RAM   | AMD Ryzen 7 3700X, 16 logical cores, 34,291,060,736 bytes (31.94 GiB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| OS         | Windows 11 Pro 10.0.26200, x64, timezone Asia/Seoul                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Toolchain  | rustc 1.94.1 (e408947bf 2026-03-25), x86_64-pc-windows-msvc, LLVM 21.1.8; Node 24.15.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Build      | B0's decision build: ignored `cargo test --release --lib --locked --offline` tests `p3_b0_spike_bench::run_spike_decision`, `run_spike_diagnostic` and `run_spike_oracle`, target directory `.tools/geometry-build`, rustflags `--remap-path-prefix D:\GIT\vector-studio=.`. Known overhead, as recorded: panic=unwind in the test harness; the `cfg(test)` tracking allocator compiled in, inactive while timing; the `cfg(test)` `fill_filter::record` counters compiled in                                                                                                                                                                                                                  |
| Source     | `main` commit `9505dddb5b5f329e124909ab1e89eed7a4e9eb83` (SL-U3 merged through PR #151), clean tree as the runner recorded it (`dirty: false`, no dirty files). The 57 source-manifest SHA-256 values equal those of the files at `9505ddd`. The untracked, machine-local `.claude/launch.json` was moved out of the worktree for the run, because the reference profile requires a clean worktree, and restored afterwards; it is not a source file                                                                                                                                                                                                                                           |
| Power      | AC online, no system battery, Windows plan Balanced. Source: Primary-session observation immediately before the run (`SystemInformation.PowerStatus`, `powercfg /getactivescheme`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Background | Operator statement, not observed: the operator answered "지금 시작 (Recommended)" in chat to the readiness question that asked for heavy work (video, recording, builds) to stop during the run. Observed: a Primary process listing at 21:36:02Z showed no cargo, rustc, ffmpeg, OBS, MSBuild or Visual Studio process and no node process of this project, only idle third-party (OpenAI Codex runtime) node helpers; the session ran no concurrent build, test or agent work. The runner's own listing (`tasklist.exe /fo csv /nh`, 344 processes, SHA-256 `31c32932…94d2`) was captured at 21:36:19.589Z, just before the start. No CPU-load sampling, per the user's standing instruction |
| Start      | `utcStart` 2026-10-18T21:36:20.256Z; `utcEnd` 21:42:47.188Z, a record span of 6 min 27 s. The shell timed the whole command at 6 min 30 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| N/A        | Browser, GPU, viewport and DPR: not applicable to a native CPU benchmark, as the record states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Oracle gates and harness checks

A failed gate or harness check would invalidate the run (verdict `INVALID`). None failed.

| Gate  | What it checks                                                                                                     | Checked | Failures | Pass |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------: | -------: | ---- |
| SL-O1 | Exact certificate re-verification on every path with an S1 view, except `PREFIX` fallbacks                         |   1,254 |        0 | yes  |
| SL-O2 | Exact region and mesh validity of every fast-rung mesh                                                             |   1,121 |        0 | yes  |
| SL-O3 | Agreement with the exact rung on every path both rungs admit                                                       |     453 |        0 | yes  |
| SL-O4 | Exact rung unchanged: 1,270 exact outcomes and 35 batch checksums against the 2026-10-17 record, and dump complete |   1,305 |        0 | yes  |

- **Allocation (SL-A7):** 1,270 ladder calls in the oracle run, counted around the call only, with zero allocating calls. Every timed batch and every admission pre-check path in all five repetitions was allocation-free.
- **S1 accessor (section 2.2):** 453 published paths equal bit for bit, and on the other 817 the accessor succeeds or fails exactly as the attempt's prefix did; 0 failures.
- **E5 (recorded once per repetition, equal in all five):** `size_of::<SpikeLadder>()` 41,840 bytes; the exact workspace's `allocated_bytes()` 1,111,552.

## Validity checks

| Check                                 | Pass | Detail                                                                                             |
| ------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| 5b-admission-and-ladder-mix-identical | yes  | 5 repetitions compared; first ladder mix hash 1600d9c0106f                                         |
| 1-admitted-P2                         | yes  | 10 admitted; largest P2/s=16 admitted                                                              |
| 1-admitted-P4                         | yes  | 10 admitted; largest P4/s=16 admitted                                                              |
| 1-admitted-P8                         | yes  | 6 admitted; largest P8/s=8 admitted                                                                |
| 2-prediction-factor                   | NO   | max factor 2.610, limit 2; two P8 p95 fits exceed 2; see [Why check 2 failed](#why-check-2-failed) |
| 3-no-unverified-primary-cell          | yes  | none                                                                                               |
| 4-linearity                           | yes  | ratios 1.077, 1.182, 0.977, 1.171 and 1.183 for repetitions 0-4, limit 1.25                        |
| 5-checksums-identical                 | yes  | all equal                                                                                          |
| 6-flat-commands                       | yes  | L + 2C on every path                                                                               |
| 7-repetitions-complete                | yes  | 5 of 5, no failed process                                                                          |
| 8-metadata-complete                   | yes  | complete                                                                                           |

The clock quantum was 100 ns in every repetition. Linearity on P4/s=16: per-path median at 10 paths 79.3-81.9 µs, at 100 paths 80.0-94.1 µs.

## Estimates against the budgets (k = 2)

The runner computes the estimates even when a check fails. They do not decide this verdict (see [Context](#context-the-estimates-against-the-budgets)).

| Quantity                    | Estimate   | Budget   | Ratio to budget |
| --------------------------- | ---------- | -------- | --------------: |
| Initial build T̂             | 1,285.3 ms | 1,000 ms |           1.285 |
| Edit proxy t̂_edit (p95)     | 2.491 ms   | 4 ms     |           0.623 |
| Mesh memory M̂               | 6.81 MiB   | 64 MiB   |           0.106 |
| Per path (supporting value) | 0.6426 ms  | —        |               — |

**Binding fits.** T̂ and the per-path value come from the P8 median fit of repetition 0 (slope 0.998, prediction factor 1.731): 0.6426 ms per path at L\* = 256, times 1,000 paths and k = 2. t̂_edit comes from the P8 p95 fit of repetition 0 (slope 1.142, factor 2.356): 1.246 ms per path, times k = 2. In both the prediction bound U, not the curvature guard G, is binding. The fit with the largest factor, P8 p95 repetition 1 (2.610), estimates 0.8874 ms and does not bind. M̂ is 1,000 times the largest value at L\* of the least-squares lines of mean E2 bytes against L: the P8 line at L\* = 256 gives 7,144 bytes per path, so M̂ = 7,144,000 bytes (the mesh sizes are under [Fallback and admission](#fallback-and-admission)).

**Fallback share.** Every timed decision path (340: the first 10 of each of the 34 cells) took the fast rung, in every repetition; the fallback rate at the largest cell is 0 for P2, P4 and P8.

## Fitted slopes

Fitted log-log slopes of the per-path median against leaves, over the five repetitions: P2 0.946-0.976, P4 0.944-1.039, P8 0.998-1.048 and K2 0.978-1.031. The p95 fits of individually timed paths: P2 0.945-1.058, P4 0.931-1.126, P8 0.892-1.142 and K2 0.982-1.153. Every fit, with its factor, binding term and estimate, is in the [per-fit table](#fitted-slopes-and-per-fit-estimates).

## Fallback and admission

### Decision cells

All 34 decision cells are ADMITTED in every repetition. The admission pre-check (paths 0-9 of each cell and 0-99 of P4/s=16, 430 paths) put every path on the fast rung with no fallback, identically in all five repetitions (check 5b). Mean E2 bytes are from the pre-check; mesh sizes are the oracle run's totals over the same paths, for the fast rung and for the exact rung run alone.

| Cell    |   L | Pre-check paths | Fast | Fallbacks | Mean E2 bytes | Fast V / T  | Exact V / T   |
| ------- | --: | --------------: | ---: | --------: | ------------: | ----------- | ------------- |
| P2/s=3  |   6 |              10 |   10 |         0 |           144 | 60 / 40     | 100 / 80      |
| P2/s=4  |   8 |              10 |   10 |         0 |           200 | 80 / 60     | 140 / 120     |
| P2/s=5  |  10 |              10 |   10 |         0 |           256 | 100 / 80    | 180 / 160     |
| P2/s=6  |  12 |              10 |   10 |         0 |           312 | 120 / 100   | 220 / 200     |
| P2/s=7  |  14 |              10 |   10 |         0 |           368 | 140 / 120   | 260 / 240     |
| P2/s=8  |  16 |              10 |   10 |         0 |           424 | 160 / 140   | 300 / 280     |
| P2/s=10 |  20 |              10 |   10 |         0 |           536 | 200 / 180   | 380 / 360     |
| P2/s=12 |  24 |              10 |   10 |         0 |           648 | 240 / 220   | 460 / 440     |
| P2/s=14 |  28 |              10 |   10 |         0 |           760 | 280 / 260   | 540 / 520     |
| P2/s=16 |  32 |              10 |   10 |         0 |           872 | 320 / 300   | 620 / 600     |
| P4/s=3  |  12 |              10 |   10 |         0 |           312 | 120 / 100   | 220 / 200     |
| P4/s=4  |  16 |              10 |   10 |         0 |           424 | 160 / 140   | 300 / 280     |
| P4/s=5  |  20 |              10 |   10 |         0 |           536 | 200 / 180   | 380 / 360     |
| P4/s=6  |  24 |              10 |   10 |         0 |           648 | 240 / 220   | 460 / 440     |
| P4/s=7  |  28 |              10 |   10 |         0 |           760 | 280 / 260   | 540 / 520     |
| P4/s=8  |  32 |              10 |   10 |         0 |           872 | 320 / 300   | 620 / 600     |
| P4/s=10 |  40 |              10 |   10 |         0 |         1,096 | 400 / 380   | 788 / 766     |
| P4/s=12 |  48 |              10 |   10 |         0 |         1,320 | 480 / 460   | 984 / 950     |
| P4/s=14 |  56 |              10 |   10 |         0 |         1,544 | 560 / 540   | 1148 / 1114   |
| P4/s=16 |  64 |             100 |  100 |         0 |         1,768 | 6400 / 6200 | 13272 / 12860 |
| P8/s=3  |  24 |              10 |   10 |         0 |           648 | 240 / 220   | 460 / 440     |
| P8/s=4  |  32 |              10 |   10 |         0 |           872 | 320 / 300   | 620 / 600     |
| P8/s=5  |  40 |              10 |   10 |         0 |         1,096 | 400 / 380   | 790 / 767     |
| P8/s=6  |  48 |              10 |   10 |         0 |         1,320 | 480 / 460   | 1000 / 970    |
| P8/s=7  |  56 |              10 |   10 |         0 |         1,544 | 560 / 540   | 1190 / 1156   |
| P8/s=8  |  64 |              10 |   10 |         0 |         1,768 | 640 / 620   | 1376 / 1338   |
| K2/s=3  |  24 |              10 |   10 |         0 |           624 | 240 / 200   | 440 / 400     |
| K2/s=4  |  32 |              10 |   10 |         0 |           848 | 320 / 280   | 600 / 560     |
| K2/s=5  |  40 |              10 |   10 |         0 |         1,072 | 400 / 360   | 760 / 720     |
| K2/s=6  |  48 |              10 |   10 |         0 |         1,296 | 480 / 440   | 920 / 880     |
| K2/s=7  |  56 |              10 |   10 |         0 |         1,520 | 560 / 520   | 1080 / 1040   |
| K2/s=8  |  64 |              10 |   10 |         0 |         1,744 | 640 / 600   | 1240 / 1200   |
| K4/s=3  |  48 |              10 |   10 |         0 |         1,248 | 480 / 400   | 880 / 800     |
| K4/s=4  |  64 |              10 |   10 |         0 |         1,696 | 640 / 560   | 1200 / 1120   |

Each fast-rung mesh has V = L and T = L − 2C vertices and triangles per path (it triangulates the flattened polygon P), so its E2 size is 16L + 12(L − 2C) bytes; the exact rung's meshes have about twice as many triangles.

### O1, generic coordinates (untimed, outside the decision)

30 paths per cell. "Conservative" counts fallbacks on which every exact condition held (SL-O1); "Exact OK" is the exact rung's OK count in this run and "Record OK" the 2026-10-17 record's.

| O1 cell    | Fast | Fallbacks  | Conservative | Exact OK | Record OK |
| ---------- | ---: | ---------- | -----------: | -------: | --------: |
| O1/P2/s=3  |   24 | CLOSURE 6  |            0 |        1 |         1 |
| O1/P2/s=4  |   28 | CLOSURE 2  |            0 |        4 |         4 |
| O1/P2/s=5  |   20 | CLOSURE 10 |            0 |        0 |         0 |
| O1/P2/s=6  |   22 | CLOSURE 8  |            0 |        0 |         0 |
| O1/P2/s=7  |   24 | CLOSURE 6  |            0 |        0 |         0 |
| O1/P2/s=8  |   26 | CLOSURE 4  |            0 |        0 |         0 |
| O1/P2/s=10 |   27 | CLOSURE 3  |            0 |        0 |         0 |
| O1/P2/s=12 |   28 | CLOSURE 2  |            0 |        2 |         2 |
| O1/P2/s=14 |   30 | 0          |            0 |        0 |         0 |
| O1/P2/s=16 |   29 | CLOSURE 1  |            0 |        2 |         2 |
| O1/P4/s=3  |   25 | CLOSURE 5  |            0 |        1 |         1 |
| O1/P4/s=4  |   28 | CLOSURE 2  |            0 |        4 |         4 |
| O1/P4/s=5  |   25 | CLOSURE 5  |            0 |        0 |         0 |
| O1/P4/s=6  |   29 | CLOSURE 1  |            0 |        0 |         0 |
| O1/P4/s=7  |   29 | CLOSURE 1  |            0 |        0 |         0 |
| O1/P4/s=8  |   30 | 0          |            0 |        0 |         0 |
| O1/P4/s=10 |   30 | 0          |            0 |        0 |         0 |
| O1/P4/s=12 |   28 | CLOSURE 2  |            0 |        2 |         2 |
| O1/P4/s=14 |   30 | 0          |            0 |        0 |         0 |
| O1/P4/s=16 |   22 | PREFIX 8   |            0 |        2 |         2 |
| O1/P8/s=3  |   27 | CLOSURE 3  |            0 |        1 |         1 |
| O1/P8/s=4  |   30 | 0          |            0 |        4 |         4 |
| O1/P8/s=5  |   27 | CLOSURE 3  |            0 |        0 |         0 |
| O1/P8/s=6  |   26 | CLOSURE 4  |            0 |        0 |         0 |
| O1/P8/s=7  |   25 | CLOSURE 5  |            0 |        0 |         0 |
| O1/P8/s=8  |   22 | PREFIX 8   |            0 |        0 |         0 |

Totals over the 780 O1 paths: 691 fast, 73 `CLOSURE` and 16 `PREFIX` fallbacks, no conservative fallback; the exact rung admits 23, as in the 2026-10-17 record. The fast rung therefore publishes a mesh for 691 generic-coordinate paths, 668 of which the exact rung alone fails; both rungs admit the other 23. The 16 `PREFIX` fallbacks (8 each in O1/P4/s=16 and O1/P8/s=8) are prefix failures on which the exact rung also fails, with `OwnerLimit`, as the 2026-10-17 record shows for the same cells.

### X, crossings (untimed, outside the decision)

| X cell | Paths | `CROSSING` | Exact `Topology(Unresolved)` | As expected |
| ------ | ----: | ---------: | ---------------------------: | ----------- |
| X/s=5  |    10 |         10 |                           10 | yes         |
| X/s=7  |    10 |         10 |                           10 | yes         |
| X/s=9  |    10 |         10 |                           10 | yes         |
| X/s=11 |    10 |         10 |                           10 | yes         |
| X/s=13 |    10 |         10 |                           10 | yes         |
| X/s=15 |    10 |         10 |                           10 | yes         |

## SL-O5 sliver statistics, fast versus exact

Float64, observational (contract section 4.5): quality ρ = 4√3·A / (ℓ1² + ℓ2² + ℓ3²), the smallest angle and the smallest altitude, per cell and rung over the oracle run's meshes. The spike claims compliance with neither R0 nor R2.

**Totals.**

| Cells    | Rung  | Meshes | Triangles | Min ρ         | Min angle (°) | Min altitude  | ρ < 0.1 | ρ < 0.01 |
| -------- | ----- | -----: | --------: | ------------- | ------------- | ------------- | ------: | -------: |
| Decision | fast  |    430 |    16,160 | 0.00198       | 0.0670        | 0.00936       |   5,817 |       76 |
| Decision | exact |    430 |    33,081 | 1.10e-5       | 0.000365      | 1.51e-5       |  23,545 |    2,981 |
| O1       | fast  |    691 |    19,521 | 0 (see below) | 0 (see below) | 0 (see below) |   4,702 |      277 |
| O1       | exact |     23 |     1,116 | 2.77e-5       | 0.000918      | 0.000378      |     731 |       50 |

Over the decision cells the fast rung's meshes have half as many triangles as the exact rung's, a smallest ρ about 180 times larger, 36% of their triangles below ρ = 0.1 against 71%, and 0.47% below ρ = 0.01 against 9.0%.

**O1 fast meshes, from the oracle dump.** The O1 fast-rung minimum is 0 because of contracted contours (SL-L5). From `oracle-dump.json` (the artifact whose SHA-256 the record stores; this count is not in the committed `.json`): 247 O1 fast-rung triangles have a side shorter than 10^-12, the same number as the 247 contracted contours SL-O6 reports; their Float64 ρ is at most 1.2·10^-15, and 60 of them have ρ = 0 because the Float64 cross product rounds to zero. Every other O1 fast-rung triangle has ρ ≥ 0.00198. SL-O2 validates these meshes exactly and passes; the zero values are a Float64 observation of a side of about one ulp.

**Per decision cell.**

| Cell    | Fast T | Fast min ρ | Fast p5 ρ | Fast median ρ | Fast min angle (°) | Fast ρ<0.1 | Fast ρ<0.01 | Exact T | Exact min ρ | Exact p5 ρ | Exact median ρ | Exact min angle (°) | Exact ρ<0.1 | Exact ρ<0.01 |
| ------- | -----: | ---------: | --------: | ------------: | -----------------: | ---------: | ----------: | ------: | ----------: | ---------: | -------------: | ------------------: | ----------: | -----------: |
| P2/s=3  |     40 |     0.0811 |    0.0811 |         0.635 |               4.02 |          5 |           0 |      80 |     0.00103 |     0.0406 |          0.399 |               0.034 |          16 |            2 |
| P2/s=4  |     60 |      0.081 |    0.0811 |         0.519 |               4.02 |          4 |           0 |     120 |      0.0724 |     0.0774 |          0.323 |                 2.4 |          10 |            0 |
| P2/s=5  |     80 |      0.081 |    0.0811 |         0.502 |               4.02 |          5 |           0 |     160 |      0.0247 |     0.0588 |           0.26 |               0.818 |          16 |            0 |
| P2/s=6  |    100 |      0.081 |    0.0811 |         0.409 |               4.02 |          8 |           0 |     200 |     0.00102 |    0.00107 |          0.219 |              0.0336 |          60 |           10 |
| P2/s=7  |    120 |      0.081 |    0.0811 |         0.375 |               4.02 |          8 |           0 |     240 |     0.00206 |     0.0277 |          0.176 |               0.068 |          57 |            3 |
| P2/s=8  |    140 |      0.081 |    0.0811 |         0.339 |               4.02 |          8 |           0 |     280 |     0.00849 |    0.00968 |          0.161 |               0.281 |          84 |           14 |
| P2/s=10 |    180 |      0.081 |     0.192 |         0.271 |               4.02 |          6 |           0 |     360 |     0.00474 |     0.0227 |          0.127 |               0.157 |         116 |            8 |
| P2/s=12 |    220 |      0.081 |     0.165 |         0.222 |               4.02 |          8 |           0 |     440 |    0.000548 |   0.000985 |          0.108 |              0.0181 |         194 |           52 |
| P2/s=14 |    260 |     0.0811 |     0.146 |         0.192 |               4.02 |         10 |           0 |     520 |      0.0012 |     0.0211 |         0.0963 |              0.0396 |         270 |           12 |
| P2/s=16 |    300 |     0.0809 |     0.132 |         0.167 |               4.02 |         13 |           0 |     600 |     0.00179 |    0.00568 |         0.0784 |              0.0593 |         372 |           70 |
| P4/s=3  |    100 |       0.15 |      0.15 |         0.439 |               7.16 |          0 |           0 |     200 |     0.00108 |     0.0426 |          0.213 |              0.0356 |          56 |            5 |
| P4/s=4  |    140 |       0.15 |      0.15 |         0.317 |               7.16 |          0 |           0 |     280 |     0.00175 |    0.00774 |          0.189 |               0.058 |          86 |           14 |
| P4/s=5  |    180 |      0.149 |     0.161 |          0.26 |               7.16 |          0 |           0 |     360 |    0.000842 |     0.0228 |          0.139 |              0.0279 |         126 |            3 |
| P4/s=6  |    220 |      0.144 |      0.15 |         0.216 |               6.98 |          0 |           0 |     440 |    0.000596 |   0.000993 |           0.11 |              0.0197 |         193 |           56 |
| P4/s=7  |    260 |     0.0572 |     0.148 |         0.188 |               2.84 |          3 |           0 |     520 |    0.000113 |     0.0155 |          0.104 |             0.00374 |         256 |           14 |
| P4/s=8  |    300 |     0.0564 |     0.103 |         0.165 |                2.2 |          5 |           0 |     600 |    0.000132 |    0.00862 |         0.0885 |             0.00437 |         366 |           60 |
| P4/s=10 |    380 |     0.0372 |    0.0813 |         0.135 |               1.35 |         23 |           0 |     766 |    0.000188 |     0.0048 |         0.0696 |             0.00621 |         576 |           70 |
| P4/s=12 |    460 |     0.0434 |    0.0605 |         0.114 |               1.52 |         95 |           0 |     950 |     0.00046 |    0.00131 |         0.0572 |              0.0152 |         772 |          158 |
| P4/s=14 |    540 |     0.0173 |    0.0417 |         0.097 |              0.604 |        297 |           0 |   1,114 |    0.000524 |    0.00989 |         0.0475 |              0.0173 |       1,030 |           56 |
| P4/s=16 |  6,200 |    0.00862 |    0.0492 |        0.0857 |              0.293 |      4,479 |          67 |  12,860 |    0.000011 |    0.00379 |         0.0426 |            0.000365 |      12,072 |        1,595 |
| P8/s=3  |    220 |     0.0945 |     0.136 |         0.209 |               4.39 |          3 |           0 |     440 |     0.00101 |     0.0206 |          0.105 |              0.0335 |         210 |           11 |
| P8/s=4  |    300 |    0.00926 |    0.0945 |         0.155 |               0.46 |         18 |           1 |     600 |    0.000466 |    0.00804 |         0.0756 |              0.0154 |         380 |           32 |
| P8/s=5  |    380 |     0.0225 |     0.077 |         0.138 |              0.899 |         40 |           0 |     767 |     0.00159 |     0.0128 |         0.0704 |              0.0525 |         576 |           25 |
| P8/s=6  |    460 |      0.013 |    0.0675 |         0.116 |              0.644 |        156 |           0 |     970 |     0.00049 |    0.00101 |         0.0585 |              0.0162 |         812 |          124 |
| P8/s=7  |    540 |    0.00551 |    0.0528 |         0.102 |              0.222 |        257 |           4 |   1,156 |    0.000494 |    0.00625 |         0.0497 |              0.0164 |         993 |          123 |
| P8/s=8  |    620 |    0.00198 |    0.0411 |        0.0939 |              0.067 |        351 |           4 |   1,338 |   0.0000113 |     0.0041 |         0.0431 |            0.000373 |       1,207 |          196 |
| K2/s=3  |    200 |       0.15 |      0.15 |         0.439 |               7.16 |          0 |           0 |     400 |    0.000998 |     0.0391 |          0.224 |               0.033 |          97 |            5 |
| K2/s=4  |    280 |       0.15 |      0.15 |         0.317 |               7.16 |          0 |           0 |     560 |     0.00175 |     0.0194 |          0.189 |               0.058 |         172 |           14 |
| K2/s=5  |    360 |      0.149 |      0.15 |         0.259 |               7.16 |          0 |           0 |     720 |    0.000842 |     0.0199 |          0.137 |              0.0279 |         256 |            6 |
| K2/s=6  |    440 |      0.144 |      0.15 |         0.216 |               6.98 |          0 |           0 |     880 |    0.000596 |    0.00458 |          0.112 |              0.0197 |         371 |           64 |
| K2/s=7  |    520 |     0.0571 |     0.149 |         0.188 |               2.84 |          6 |           0 |   1,040 |   0.0000907 |     0.0116 |         0.0988 |               0.003 |         520 |           47 |
| K2/s=8  |    600 |     0.0563 |     0.129 |         0.165 |                2.2 |          9 |           0 |   1,200 |    0.000132 |    0.00962 |         0.0871 |             0.00437 |         716 |           84 |
| K4/s=3  |    400 |       0.15 |      0.15 |         0.439 |               7.16 |          0 |           0 |     800 |    0.000998 |     0.0289 |          0.229 |               0.033 |         175 |           18 |
| K4/s=4  |    560 |      0.149 |      0.15 |         0.317 |               7.16 |          0 |           0 |   1,120 |     0.00175 |     0.0153 |          0.173 |               0.058 |         332 |           30 |

## SL-O6 geometric error observation

Native Float64 output only; this is not D8 checkpoint B4's A04 corpus measurement.

| Cells    | Fast paths | Curve share: max certified δ̄ | Curve share: exact max \|d_m\| | Topology share | Contracted contours | Max \|k − m\|  |
| -------- | ---------: | ---------------------------- | ------------------------------ | -------------- | ------------------: | -------------- |
| Decision |        430 | 0.0940676095137381           | 0.0940676095137329             | 0 (SL-O2)      |                   0 | —              |
| O1       |        691 | 0.0937500000000470           | 0.0937500000000019             | 0 (SL-O2)      |                 247 | 9.486 · 10^-16 |
| X        |          0 | —                            | —                              | —              |                   0 | —              |

- **Curve share.** Both maxima are below δ = 0.125, as SL-C1 requires; the certified bound is at or above the exact value on every fast path (SL-O1). The decision maximum is at P2/s=7.
- **Topology share.** Zero, because SL-O2 passes on every fast mesh: the fast mesh's boundary is P exactly.
- **Storage share.** Not applicable: the spike packs no Float32.
- **Contracted contours.** On the 247 contracted contours (on 24 of the 26 O1 cells, 3 to 17 per cell; none on the two `PREFIX` cells O1/P4/s=16 and O1/P8/s=8), the certificate bounds P′, whose merged edge e′ = [p, m] satisfies δ̄(e′) < δ. The mesh triangulates P, whose real edges [p, k] and [k, m] differ from the source curve by up to δ̄(e′) + |k − m|. So P's positional bound holds only within an extra |k − m|, at most 9.486 · 10^-16 here; with the O1 certified maximum that is still below δ.
- **Storage format.** The record stores the certified per-path maximum of |d_m|, not per-edge values (an SL-U3 interpretation recorded in the plan).

## Diagnostic stage split

One separate process (section 5.8), over the P2, P4 and P8 cells, three warm-up and ten timed batches per stop. The stops SL-D1 to SL-D4 time the fast rung alone, with no exact rung on a fallback (no stop fell back in any cell); the exact rung alone is timed in the same process as a baseline. Values are medians in ms per 10-path batch; stage costs are differences of medians.

| Cell    | Prefix SL-D1 | Certificate D2−D1 | Classification D3−D2 | Triangulation D4−D3 | Fast rung D4 | Exact rung alone | Exact / fast | Sweep candidates per path | Diagonals per path |
| ------- | -----------: | ----------------: | -------------------: | ------------------: | -----------: | ---------------: | -----------: | ------------------------: | -----------------: |
| P2/s=3  |       0.0105 |            0.0550 |               0.0004 |              0.0014 |       0.0673 |           1.8272 |         27.2 |                       3.5 |                  0 |
| P2/s=4  |       0.0127 |            0.0657 |               0.0005 |              0.0093 |       0.0882 |           2.4765 |         28.1 |                         5 |                  0 |
| P2/s=5  |       0.0196 |            0.0835 |               0.0180 |              0.0125 |       0.1336 |           3.1286 |         23.4 |                       7.3 |                  0 |
| P2/s=6  |       0.0189 |            0.0969 |               0.0006 |              0.0130 |       0.1294 |           3.7424 |         28.9 |                       9.7 |                  0 |
| P2/s=7  |       0.0212 |            0.1117 |               0.0005 |              0.0147 |       0.1481 |           4.3905 |         29.6 |                      11.6 |                  0 |
| P2/s=8  |       0.0239 |            0.1282 |               0.0009 |              0.0163 |       0.1693 |           5.0126 |         29.6 |                      14.3 |                  0 |
| P2/s=10 |       0.0299 |            0.1884 |               0.0010 |              0.0237 |       0.2430 |           6.3247 |         26.0 |                      17.8 |                  0 |
| P2/s=12 |       0.0362 |            0.1918 |              -0.0001 |              0.0245 |       0.2524 |           7.6028 |         30.1 |                      24.7 |                  0 |
| P2/s=14 |       0.0418 |            0.2212 |               0.0016 |              0.0263 |       0.2909 |           8.8087 |         30.3 |                      26.6 |                  0 |
| P2/s=16 |       0.0481 |            0.2527 |               0.0015 |              0.0290 |       0.3313 |          10.1056 |         30.5 |                      32.8 |                  0 |
| P4/s=3  |       0.0175 |            0.1160 |               0.0010 |              0.0135 |       0.1480 |           3.9821 |         26.9 |                      10.5 |                  0 |
| P4/s=4  |       0.0221 |            0.1548 |               0.0007 |              0.0163 |       0.1939 |           5.9615 |         30.7 |                      15.9 |                  0 |
| P4/s=5  |       0.0279 |            0.1916 |               0.0019 |              0.0198 |       0.2412 |           6.7186 |         27.9 |                      19.1 |                  0 |
| P4/s=6  |       0.0333 |            0.2313 |               0.0008 |              0.0241 |       0.2895 |           8.0101 |         27.7 |                      26.4 |                  0 |
| P4/s=7  |       0.0388 |            0.2689 |               0.0014 |              0.0265 |       0.3356 |           9.4101 |         28.0 |                      29.7 |                  0 |
| P4/s=8  |       0.0438 |            0.3065 |               0.0041 |              0.0287 |       0.3831 |          10.7313 |         28.0 |                      35.6 |                  0 |
| P4/s=10 |       0.0558 |            0.3844 |               0.0070 |              0.0377 |       0.4849 |          13.4884 |         27.8 |                      45.4 |                0.6 |
| P4/s=12 |       0.0666 |            0.4602 |               0.0032 |              0.0512 |       0.5812 |          16.4755 |         28.3 |                      60.3 |                1.4 |
| P4/s=14 |       0.0783 |            0.5394 |               0.0005 |              0.0598 |       0.6780 |          19.1317 |         28.2 |                      68.4 |                1.6 |
| P4/s=16 |       0.0909 |            0.6133 |               0.0043 |              0.0742 |       0.7827 |          21.8747 |         27.9 |                      84.2 |                2.2 |
| P8/s=3  |       0.0309 |            0.2739 |               0.0005 |              0.0232 |       0.3285 |           8.3795 |         25.5 |                        28 |                  0 |
| P8/s=4  |       0.0411 |            0.3621 |              -0.0011 |              0.0380 |       0.4401 |          11.1872 |         25.4 |                      40.7 |                  0 |
| P8/s=5  |       0.0505 |            0.4556 |               0.0010 |              0.0415 |       0.5486 |          14.0823 |         25.7 |                      52.6 |                0.6 |
| P8/s=6  |       0.0600 |            0.5411 |               0.0022 |              0.0516 |       0.6549 |          17.2193 |         26.3 |                      71.4 |                  1 |
| P8/s=7  |       0.0702 |            0.8167 |              -0.1516 |              0.1373 |       0.8726 |          22.0453 |         25.3 |                      84.4 |                1.6 |
| P8/s=8  |       0.0802 |            0.7220 |               0.0990 |             -0.0222 |       0.8790 |          23.2587 |         26.5 |                     100.9 |                1.8 |

- **The fast rung alone is 23-31 times faster than the exact rung alone** in the same process, 26.5-30.5 times at the largest cells.
- **The certificate (FR1-FR5) dominates the fast rung**: at the largest cells 76% (P2/s=16), 78% (P4/s=16) and 82% (P8/s=8) of the fast rung's median, the S1 prefix 9-15%, and classification and triangulation together 9-10%.
- **Negative differences.** Because the stops are timed separately and their medians are differenced, a stage can come out negative when it is small against the run-to-run variation of its neighbours: classification at P2/s=12, P8/s=4 and P8/s=7, triangulation at P8/s=8 (the D3 median there is larger than the D4 median). These are not negative costs.
- **Counters.** No clearance test reached steps 2 or 3 on any of the 26 diagnosed cells. `fill_filter` F1 decided every case with no fallback (27,963 in total; for example 2,433 at P4/s=16 and 2,442 at P8/s=8 over ten paths); F0.2 and F0.3 recorded no case. B0's H1 is not evaluated (section 5.8).

## Comparison with the 2026-10-17 B0 record

All values below come from `analyze()` of the two committed records (`tests/geometry/p3-b0-spike/analysis.ts` for this record, `tests/geometry/p3-b0/analysis.ts` for the [2026-10-17 record](2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.json)), with the same corpus, cells, sampling and fit code, on the same machine on consecutive days. Ratios are B0/spike, so a value above 1 means the ladder is faster or smaller. The B0 scenario measures the exact rung alone; this one measures the ladder, which here took the fast rung on every timed path.

**Verdicts:** B0 2026-10-17 INCONCLUSIVE (check 2, max factor 3.248); spike INCONCLUSIVE (check 2, max factor 2.610).

### Estimates

| Quantity                     | B0 2026-10-17 | Spike 2026-10-18 | B0/spike |
| ---------------------------- | ------------: | ---------------: | -------: |
| T̂, initial build at k = 2    |   41,419.3 ms |       1,285.3 ms |     32.2 |
| t̂_edit, p95 proxy at k = 2   |    122.048 ms |         2.491 ms |     49.0 |
| M̂, mesh payload              |     15.41 MiB |         6.81 MiB |     2.26 |
| Per path at L\* (supporting) |     20.710 ms |        0.6426 ms |     32.2 |

The binding initial-build fit is P8 median in both records, repetition 4 in B0 and repetition 0 here; the binding edit fit is P8 p95, repetition 4 in B0 and repetition 0 here.

### Per-cell per-path medians

Per-path median from the batch samples (batch time / 10), median over the five repetitions.

| Cell    |   L | B0 (ms) | Spike (ms) | B0/spike |
| ------- | --: | ------: | ---------: | -------: |
| P2/s=3  |   6 |   0.191 |    0.00704 |     27.1 |
| P2/s=4  |   8 |  0.2502 |    0.00911 |     27.5 |
| P2/s=5  |  10 |  0.3191 |    0.01128 |     28.3 |
| P2/s=6  |  12 |  0.3933 |    0.01326 |     29.7 |
| P2/s=7  |  14 |   0.447 |    0.01542 |       29 |
| P2/s=8  |  16 |  0.5291 |     0.0174 |     30.4 |
| P2/s=10 |  20 |  0.6364 |    0.02169 |     29.3 |
| P2/s=12 |  24 |   0.782 |    0.02597 |     30.1 |
| P2/s=14 |  28 |  0.9087 |    0.02991 |     30.4 |
| P2/s=16 |  32 |   1.068 |    0.03489 |     30.6 |
| P4/s=3  |  12 |  0.4181 |     0.0152 |     27.5 |
| P4/s=4  |  16 |  0.5585 |    0.01999 |     27.9 |
| P4/s=5  |  20 |  0.6957 |    0.02488 |       28 |
| P4/s=6  |  24 |  0.8136 |    0.02959 |     27.5 |
| P4/s=7  |  28 |  0.9621 |    0.03423 |     28.1 |
| P4/s=8  |  32 |   1.099 |    0.03923 |       28 |
| P4/s=10 |  40 |   1.422 |    0.04941 |     28.8 |
| P4/s=12 |  48 |   1.685 |    0.05914 |     28.5 |
| P4/s=14 |  56 |   1.991 |    0.06958 |     28.6 |
| P4/s=16 |  64 |   2.229 |    0.07986 |     27.9 |
| P8/s=3  |  24 |  0.8557 |    0.03359 |     25.5 |
| P8/s=4  |  32 |   1.169 |    0.04448 |     26.3 |
| P8/s=5  |  40 |   1.463 |    0.05624 |       26 |
| P8/s=6  |  48 |   1.759 |    0.06734 |     26.1 |
| P8/s=7  |  56 |   2.141 |    0.07896 |     27.1 |
| P8/s=8  |  64 |   2.389 |    0.08989 |     26.6 |
| K2/s=3  |  24 |  0.8605 |    0.03051 |     28.2 |
| K2/s=4  |  32 |   1.096 |    0.04003 |     27.4 |
| K2/s=5  |  40 |   1.384 |       0.05 |     27.7 |
| K2/s=6  |  48 |   1.664 |    0.05978 |     27.8 |
| K2/s=7  |  56 |   1.995 |       0.07 |     28.5 |
| K2/s=8  |  64 |   2.208 |    0.07948 |     27.8 |
| K4/s=3  |  48 |   1.671 |    0.06315 |     26.5 |
| K4/s=4  |  64 |   2.326 |    0.08311 |       28 |

The ladder is 25.5-30.6 times faster per path in every cell. Unlike the B0R remeasure's comparison, the ratio does not grow with L: both rungs scale about linearly in L (median slopes near 1 in both records).

### Fitted slopes and per-fit estimates

Per-fit estimate t̂ = exp(max(U, G)) at L\* (64, 128 and 256 for P2, P4 and P8; 128 for K2), per path, before the factor k. "Binding" is the larger of U and G for this record's fit (U for every B0 fit).

| Series | Kind   | Rep | Slope | Factor | Binding | Estimate (ms) | B0 slope | B0 factor | B0 estimate (ms) | B0/spike |
| ------ | ------ | --: | ----: | -----: | ------- | ------------: | -------: | --------: | ---------------: | -------: |
| P2     | median |   0 | 0.958 |  1.269 | U       |       0.08892 |    1.025 |     1.220 |            2.721 |     30.6 |
| P2     | p95    |   0 | 0.998 |  1.770 | U       |        0.1532 |    1.091 |     1.361 |            4.105 |     26.8 |
| P2     | median |   1 | 0.976 |  1.252 | U       |       0.08907 |    1.023 |     1.018 |            2.133 |     23.9 |
| P2     | p95    |   1 | 1.058 |  1.599 | U       |        0.1475 |    1.031 |     1.090 |            2.463 |     16.7 |
| P2     | median |   2 | 0.947 |  1.025 | G       |       0.06694 |    1.029 |     1.081 |            2.367 |     35.4 |
| P2     | p95    |   2 | 0.945 |  1.181 | U       |       0.08038 |    1.056 |     1.247 |            3.325 |     41.4 |
| P2     | median |   3 | 0.963 |  1.286 | G       |        0.1039 |    1.032 |     1.019 |            2.237 |     21.5 |
| P2     | p95    |   3 | 1.049 |  1.834 | U       |        0.1667 |    0.978 |     1.215 |            2.896 |     17.4 |
| P2     | median |   4 | 0.946 |  1.017 | G       |       0.06691 |    1.010 |     1.335 |            2.904 |     43.4 |
| P2     | p95    |   4 | 0.981 |  1.179 | G       |       0.08963 |    1.006 |     1.658 |            4.034 |       45 |
| P4     | median |   0 | 1.039 |  1.226 | U       |        0.2156 |    1.014 |     1.136 |            5.236 |     24.3 |
| P4     | p95    |   0 | 1.113 |  1.350 | G       |        0.3152 |    0.994 |     1.464 |            7.466 |     23.7 |
| P4     | median |   1 | 0.944 |  1.220 | U       |        0.1852 |    1.020 |     1.021 |            4.603 |     24.8 |
| P4     | p95    |   1 | 1.126 |  1.405 | G       |        0.3606 |    1.017 |     1.096 |            5.293 |     14.7 |
| P4     | median |   2 | 0.965 |  1.185 | U       |        0.1819 |    1.005 |     1.037 |            4.779 |     26.3 |
| P4     | p95    |   2 | 0.953 |  1.626 | U       |        0.2695 |    0.910 |     1.297 |            6.018 |     22.3 |
| P4     | median |   3 | 0.993 |  1.024 | G       |        0.1626 |    1.003 |     1.049 |            4.726 |     29.1 |
| P4     | p95    |   3 | 1.008 |  1.221 | U       |        0.2128 |    1.038 |     1.114 |            5.997 |     28.2 |
| P4     | median |   4 | 0.994 |  1.025 | G       |         0.162 |    1.016 |     1.399 |            6.693 |     41.3 |
| P4     | p95    |   4 | 0.931 |  1.226 | U       |        0.1946 |    1.000 |     1.961 |            11.17 |     57.4 |
| P8     | median |   0 | 0.998 |  1.731 | U       |        0.6426 |    0.953 |     1.742 |            15.55 |     24.2 |
| P8     | p95    |   0 | 1.142 |  2.356 | U       |         1.246 |    0.856 |     3.215 |            28.36 |     22.8 |
| P8     | median |   1 | 1.003 |  1.040 | U       |        0.3761 |    1.049 |     1.053 |            10.66 |     28.3 |
| P8     | p95    |   1 | 0.892 |  2.610 | U       |        0.8874 |    1.044 |     1.312 |            14.14 |     15.9 |
| P8     | median |   2 | 1.008 |  1.033 | U       |        0.3757 |    1.068 |     1.119 |            12.35 |     32.9 |
| P8     | p95    |   2 | 1.000 |  1.072 | U       |        0.4066 |    1.160 |     1.714 |             26.3 |     64.7 |
| P8     | median |   3 | 1.048 |  1.473 | U       |        0.5933 |    1.051 |     1.221 |             12.8 |     21.6 |
| P8     | p95    |   3 | 0.919 |  1.794 | U       |        0.6306 |    1.202 |     1.608 |            25.89 |     41.1 |
| P8     | median |   4 | 1.009 |  1.023 | U       |        0.3729 |    1.137 |     1.678 |            20.71 |     55.5 |
| P8     | p95    |   4 | 1.103 |  1.626 | U       |        0.7708 |    1.284 |     3.248 |            61.02 |     79.2 |
| K2     | median |   0 | 1.000 |  1.095 | U       |        0.1764 |    0.820 |     1.285 |            4.798 |     27.2 |
| K2     | p95    |   0 | 1.094 |  1.707 | U       |        0.3327 |    0.938 |     1.684 |             8.22 |     24.7 |
| K2     | median |   1 | 0.988 |  1.463 | U       |        0.2447 |    1.000 |     1.028 |            4.528 |     18.5 |
| K2     | p95    |   1 | 1.153 |  2.455 | U       |        0.5708 |    0.974 |     1.177 |            5.463 |     9.57 |
| K2     | median |   2 | 0.984 |  1.041 | U       |        0.1643 |    1.002 |     1.038 |            4.768 |       29 |
| K2     | p95    |   2 | 1.010 |  1.504 | U       |        0.2851 |    0.935 |     1.361 |            6.604 |     23.2 |
| K2     | median |   3 | 0.978 |  1.018 | U       |        0.1593 |    0.995 |     1.076 |            4.865 |     30.5 |
| K2     | p95    |   3 | 1.014 |  1.102 | U       |        0.1877 |    0.980 |     1.192 |            5.743 |     30.6 |
| K2     | median |   4 | 1.031 |  1.195 | U       |        0.2015 |    1.110 |     1.278 |            6.593 |     32.7 |
| K2     | p95    |   4 | 0.982 |  1.292 | U       |        0.2239 |    1.318 |     2.053 |            15.36 |     68.6 |

### Stage split

Largest admitted cell of each primary series, ms per 10-path batch. B0's stages are S1 (flatten and leaf partitions), S2 − S1 (topology certificate) and S3 − S2 (tessellation and ownership); the spike's are SL-D1 (the same S1 prefix), D2 − D1 (the fast rung's certificate FR1-FR5) and D4 − D2 (classification and triangulation FR6-FR8). The correspondence is by role; the algorithms differ. Both runs are diagnostic processes on different days.

| Series | Cell    | B0 stage     | B0 (ms) | Spike stage                    | Spike (ms) | B0/spike |
| ------ | ------- | ------------ | ------: | ------------------------------ | ---------: | -------: |
| P2     | P2/s=16 | flatten      |  0.0578 | prefix                         |     0.0481 |     1.20 |
| P2     | P2/s=16 | topology     |   7.481 | certificate                    |     0.2527 |     29.6 |
| P2     | P2/s=16 | tessellation |   2.945 | classification + triangulation |     0.0305 |     96.5 |
| P2     | P2/s=16 | total        |   10.48 | fast rung                      |     0.3313 |     31.6 |
| P4     | P4/s=16 | flatten      |   0.092 | prefix                         |     0.0909 |     1.01 |
| P4     | P4/s=16 | topology     |   16.79 | certificate                    |     0.6133 |     27.4 |
| P4     | P4/s=16 | tessellation |   6.778 | classification + triangulation |     0.0785 |     86.3 |
| P4     | P4/s=16 | total        |   23.66 | fast rung                      |     0.7827 |     30.2 |
| P8     | P8/s=8  | flatten      |  0.0813 | prefix                         |     0.0802 |     1.01 |
| P8     | P8/s=8  | topology     |   18.06 | certificate                    |      0.722 |     25.0 |
| P8     | P8/s=8  | tessellation |   6.916 | classification + triangulation |     0.0768 |     90.1 |
| P8     | P8/s=8  | total        |   25.06 | fast rung                      |      0.879 |     28.5 |

The exact rung alone in this run's diagnostic process took 10.11, 21.87 and 23.26 ms at the same three cells, against B0's S3 totals of 10.48, 23.66 and 25.06 ms (B0/spike 1.04, 1.08 and 1.08). The prefix is about the same in both; the topology-certificate role is 25-30 times cheaper and the tessellation role 86-97 times cheaper.

## Why check 2 failed

These are facts from the record; this section chooses no remedy. Check 2 covers the primary series only: the K2 p95 fit of repetition 1 also has a factor above 2 (2.455, in the per-fit table), but K2 is an observational series and does not enter check 2.

**What the check measures.** For each primary fit (series P2, P4 and P8; each of five repetitions; the per-path median and the per-path p95 kind, as `analyze` builds them, 30 fits), the prediction factor is exp(U − ŷ(x\*)) = exp(t · s_e · √(1 + 1/n + (x\* − x̄)² / S_xx)). Here t is the one-sided Student-t quantile for n − 2 degrees of freedom and s_e the residual standard error of the log-log fit. The leaf values, n and L\* are the same as in both B0 records, so the factor depends on the measurement only through s_e, and the thresholds are the 2026-10-17 record's.

| Series | n   | L\*     | t        | √(…)  | Factor         | Limit 2 holds when |
| ------ | --- | ------- | -------- | ----- | -------------- | ------------------ |
| P2, P4 | 10  | 64, 128 | 1.859548 | 1.370 | exp(2.547 s_e) | s_e ≤ 0.272        |
| P8     | 6   | 256     | 2.131847 | 2.469 | exp(5.264 s_e) | s_e ≤ 0.132        |

**Which fits fail.** Two of the 30 primary fits exceed 2, both P8 p95 fits, the same series and kind as in the 2026-10-17 record:

| Fit                 | s_e   | Factor | Slope |
| ------------------- | ----- | ------ | ----- |
| P8 p95 repetition 1 | 0.182 | 2.610  | 0.892 |
| P8 p95 repetition 0 | 0.163 | 2.356  | 1.142 |

The next largest are P2 p95 repetition 3, 1.834 (s_e 0.238, below its threshold 0.272), and P8 p95 repetition 3, 1.794 (s_e 0.111). Every median fit passes; the largest median factor is 1.731 (P8, repetition 0). The P8 p95 fit of repetition 2 has s_e 0.013 and factor 1.072.

**Where the scatter comes from.** The p95 kind uses, per cell, the nearest-rank p95 of the 200 individually timed paths (20 batches of 10), that is the 190th smallest sample, so 11 or more elevated samples in a cell lift it. In both failing fits the outlying point is P8/s=5 (L = 40).

- **Repetition 1 (factor 2.610).** The P8 p95 points at L = 24, 32, 40, 48, 56 and 64 are 0.0357, 0.0554, 0.0884, 0.0694, 0.0832 and 0.0929 ms; the L = 40 point lies above the L = 48 and L = 56 points, and its log residual, +0.309, is the largest (the next is −0.142 at L = 24). In P8/s=5, the individual path times are 55.4-56.3 µs, with isolated values up to 61.2 µs, through batches 0-9 and the first eight paths of batch 10. From the last two paths of batch 10 they rise to 118.7-121.6 µs, are 78.7-116.5 µs in batches 11-12, and stay at 69.2-78.9 µs through batch 19, the end of the cell. 58 of the 200 samples exceed 1.25 times the cell's individual-path median of 56.2 µs, all in batches 10-19; the maximum is 121.6 µs. The cell's p95 is 0.0884 ms, against 0.0593-0.0828 ms for the same cell in the other repetitions. Its batch median, 0.0568 ms per path, stays close to repetitions 2-4's 0.0561-0.0562 ms, because 10 of its 20 batches precede the change. P8/s=5 was the 12th of 34 cells in repetition 1's shuffled order.
- **Repetition 0 (factor 2.356).** The points are 0.0337, 0.0473, 0.0828, 0.0703, 0.0820 and 0.1153 ms; the largest residuals are +0.265 at L = 40 and −0.129 at L = 56. In P8/s=5 the individual path times alternate between two levels, about 57 µs and about 68-70 µs, in runs of consecutive paths that cross batch boundaries: mostly the upper level in batches 0-5 and 13-19, both levels in batches 6-9, and mostly the lower in batches 10-12. Its individual-path median, 68.7 µs, is itself at the upper level, against 55.9-56.2 µs in repetitions 1-4, so only 8 samples exceed 1.25 times it. The cell's batch median is 0.0704 ms per path, against 0.0561-0.0568 ms in repetitions 1-4. In P8/s=8 (L = 64) of the same repetition the path times alternate between about 88-93 µs and about 109-113 µs in batches 2-9, with a maximum of 146.0 µs, and are 87-96 µs in batches 10-19; 11 samples exceed 1.25 times the median, in batches 5 and 7-9, and the p95 is 0.1153 ms against 0.0929-0.0962 ms in repetitions 1-4.
- **The same elevation moves the median fits.** Repetition 0's P8/s=5 batch median (0.0704 ms) is the L = 40 point of the P8 median fit of repetition 0, which lies above that fit's L = 48 point (0.0676 ms) and gives the largest median factor, 1.731; that fit is the binding fit for T̂. The other P8 median fits estimate 0.373-0.593 ms per path; repetition 3's (0.593 ms, factor 1.473) has an elevated L = 48 point (P8/s=6 batch median 0.0795 ms, against 0.0672-0.0676 ms in the other repetitions).
- **Size of the levels.** Where two levels appear (P8/s=5 in repetitions 0 and 1, P8/s=8 in repetition 0), the upper is about 1.2-1.25 times the lower.

**Relation to the 2026-10-17 record.** The failing series and kind are the same, P8 p95, and the mechanism is the same kind: elevated individual samples concentrated in one or two cells of a six-point fit with a target four times beyond the data. The P8 per-path times here are 0.034-0.090 ms, 25.5-27.1 times smaller than in the 2026-10-17 record, so a delay of a given absolute size weighs more relative to the sample, and the fit works on logarithms. The record does not identify the source of the level changes; the run had no CPU-load sampling, by the user's standing instruction.

## Context: the estimates against the budgets

This is a fact, not a verdict. The runner's verdict is INCONCLUSIVE and stands. The estimates the runner computed from this record are T̂ = 1,285.3 ms, about 1.29 times B_init = 1,000 ms; t̂_edit = 2.491 ms, within B_edit = 4 ms (0.623 of it); and M̂ = 6.81 MiB, within B_mem = 64 MiB (0.106 of it). The contract's section 6 asks the record to state the two ratios that its Alt-E notes refer to: T̂/B_init = 1.285 and t̂_edit/B_edit = 0.623.

Three functional runs of the spike runner during SL-U3, before this run, which are not evidence (one repetition, two timed batches, a busy development machine; section 5.13), gave about 775-1,233 ms for the initial estimate at k = 2: 1,233 and 872 ms are recorded in the SL-U3 plan entry; 775 ms is from run `20261018T124100Z-0c67613b`, in its uncommitted artifact `record.json` only (`initialMs` 775.36).

## Scope of this verdict

As the contract requires for every verdict:

- It covers simple, disjoint, snapped contours at zoom 1 and densities of 2-8 leaves per cubic, at e = 8.
- It does not cover the roadmap's 1%-6400% zoom range, generic-coordinate input (O1 is an observation) or crossings of any kind (O2 is an observation; crossings take the exact rung).
- Extrapolating beyond the data assumes no new cost regime between the largest admitted L and L\*; the curvature guard limits, but does not remove, that risk.
- It is provisional on native measurement and k = 2 until B0-W replaces k with a measured ratio. If that changes the verdict, the new verdict goes to the user.
- It holds for the ladder as the contract specifies it, with the fallback rates this record reports (every timed decision path on the fast rung), and as a test-only spike, not a production operation.

## Limits of this record

- It measures a test-only ladder on the private kernel's native fill, on one CPU, single thread, in a test-harness release build with the recorded overhead. It says nothing about browser, WASM or GPU cost, the V3c fringe builder, or edit latency beyond the stated proxy, which is a lower bound.
- It is one run. It does not show whether the level changes in P8/s=5 and P8/s=8 recur.
- The fallback cost is not exercised on the decision cells: no timed path fell back, so the estimates contain no exact-rung time. The O1 and X fallbacks are untimed.
- Background load is an operator statement plus process listings 18 s and under 1 s before the start, with no CPU-load sampling.
- The stage split differences come from separately timed stops; small stages can be negative (see the diagnostic section). The comparison with the 2026-10-17 record is across runs on different days.
- SL-O5 and SL-O6 are Float64 observations. The O1 zero-ρ explanation uses the uncommitted oracle dump, whose hash the record stores. SL-O6 is not D8 checkpoint B4's A04 measurement.
- It closes no A01-A08 criterion. Acting on the verdict needs the independent evidence review (SL-A11). Under the contract's section 6 and user decision B0-Q3, an INCONCLUSIVE verdict goes to the user before B1, as INFEASIBLE does, with the measured numbers; the spike chooses no remedy.
