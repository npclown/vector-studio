# P3 Alt-A1 AL-S1 product-stage reference run 20261020T044849Z-ed356d28

Status: Exploratory until the independent evidence review (AL-A15) in the [execution plan](../../plans/p3-fill-stroke-meshes.md#alt-a1-al-u7-reference-runs) accepts it. This record is an immutable observation; corrections append a review record.

**AL-S1 verdict (computed by the runner from the raw samples): INCONCLUSIVE, provisional at k = 2.** Validity check 2 (prediction factor) fails with a maximum factor of 3.874 against the limit 2. The other ten checks pass, all six oracle gates pass and the `MESH_CHECK` count is 0, so the run is valid and has a verdict. Under the [frozen decision rule](../../plans/p3-b0-feasibility-benchmark-contract.md#5-extrapolation-and-the-feasibility-decision), which the [Alt-A1 contract](../../plans/p3-alt-a1-fill-ladder-contract.md#53-c-product-stage-verification-scenario-al-s1-and-the-verdict) keeps unchanged, a failed check makes the verdict INCONCLUSIVE whatever the estimates are. Its scope is limited; see [Scope of this verdict](#scope-of-this-verdict).

**This is not the product verdict.** The product verdict of contract section 5.3 is computed by the AL-S2 record from this record and its measured k̂: [AL-S2 record](2026-10-20_p3_p3-b0-wasm-v1_chrome-edge_desktop-dkvusav_20261020T050227Z-f86bda54.md). Because an AL-S1 check fails, that verdict is also INCONCLUSIVE.

This run is the AL-S1 half of unit AL-U7 of the [Alt-A1 production contract](../../plans/p3-alt-a1-fill-ladder-contract.md#61-units). It measures the production operation `'geometry-wasm/fill-v0+r2'` (the fill ladder in the `fill_v0` export, revision 2) natively, on B0's unchanged corpus, sampling, fits and decision rule, under its own scenario identity. The `p3-b0-feasibility` v1 records ([2026-10-12](2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.md), [2026-10-17](2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.md)) and the `p3-b0-spike-ladder` v1 record ([2026-10-18](2026-10-18_p3_p3-b0-spike-ladder-v1_native_desktop-dkvusav_20261018T213619Z-89016cc9.md)) are not changed.

## Scenario and contract

- Scenario `p3-fill-ladder` v1, profile `reference`, runner `p3-fill-ladder-runner/1`, schema version 1.
- Configuration hash `8f07f1467b1e396fd1a9c02e6f27c17131cf203e287b5ea690391536b7f3672e`, equal to the reference hash recorded in the plan when AL-U5 merged. Corpus SHA-256 `206cf6e9971d5f38f11cbef801692555843b1602ee937c5e1b60ed7dbd329796` (580,965 bytes), equal to the contract's and to every earlier B0 record's.
- Contract: [frozen Alt-A1 production contract](../../plans/p3-alt-a1-fill-ladder-contract.md), section 5.3, which reuses the [B0 contract](../../plans/p3-b0-feasibility-benchmark-contract.md)'s corpus, sampling, fits, prediction bound, curvature guard, checks 1-8, k = 2 and budgets.
- Raw record: [`.json` beside this file](2026-10-20_p3_p3-fill-ladder-v1_native_desktop-dkvusav_20261020T044849Z-ed356d28.json), a byte-for-byte copy of the runner's `record.json` (938,201 bytes, SHA-256 `c394cca24afa19433368117c948ebcf1a1a72427b9d0b241235dc1c5c436355c`), committed in `6590083`. `validateLadderRecord` (`tests/geometry/p3-fill-ladder/analysis.ts`) checks the schema and scenario identity, recomputes the configuration hash, requires the configuration to equal `scenarioConfig('reference')`, checks the corpus hash and recomputes the stored analysis (aggregates, fits, estimates, checks, fallback tables, oracle gates, invalid reasons and verdict) from the raw samples. It accepts the committed file.
- Command: `pnpm benchmark:p3-fill-ladder --profile reference --environment-json <scratchpad>/al-u7-env.json`.
- Uncommitted artifacts in `artifacts/p3-fill-ladder/20261020T044849Z-ed356d28/`: `raw-record.json` (SHA-256 `7edb615f…58ce`), `summary.md`, `oracle.json`, `oracle-dump.txt` (35,695,825 bytes, 3,270 entries, SHA-256 `a4ff47a7fb1daa3d2f320592fd166f47a0bd6f74a33f5a64eb5b4a112636499b`, as the record states; the same dump hash as AL-U5's functional run), `oracle-input.bin` (SHA-256 `5337a7f8…62d4`), `process-listing.txt`, `invocation.json` and the per-process logs.

## Environment

| Item       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine    | DESKTOP-DKVUSAV, the reference machine per the prototype plan's accepted constraint 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| CPU, RAM   | AMD Ryzen 7 3700X, 16 logical cores, 34,291,060,736 bytes (31.94 GiB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| OS         | Windows 11 Pro 10.0.26200, x64, timezone Asia/Seoul                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Toolchain  | rustc 1.94.1 (e408947bf 2026-03-25), x86_64-pc-windows-msvc; Node 24.15.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Build      | B0's decision build: ignored `cargo test --release --lib --locked --offline` tests `p3_fill_ladder_bench::run_ladder_decision` and `run_ladder_oracle`, target directory `.tools\geometry-build`, rustflags `--remap-path-prefix D:\GIT\vector-studio=.`. Known overhead, as recorded: panic=unwind in the test harness; the `cfg(test)` tracking allocator compiled in, inactive while timing; the `cfg(test)` `fill_filter::record` counters compiled in; the `cfg(test)` ladder fault switches and test hooks compiled in, all off                                                                                                                                     |
| Source     | `main` commit `e2cf5b75203cfe84e5180e38115af0c63cce263d` (AL-U6 merged through PR #162), clean tree as the runner recorded it (`dirty: false`, no dirty files). The 69 source-manifest SHA-256 values equal those of the files at `e2cf5b7`. The untracked, machine-local `.claude/launch.json` was moved out of the worktree for the run, because the reference profile requires a clean worktree, and restored afterwards; it is not a source file                                                                                                                                                                                                                      |
| Power      | AC online, no system battery, Windows plan Balanced. Source: Primary-session observation immediately before the run (`SystemInformation.PowerStatus`, `powercfg /getactivescheme`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Background | Operator statement, not observed: the operator answered "지금 시작 (Recommended)" in chat to the readiness question that asked for heavy work (video playback, screen recording, builds) to stop and the PC to be left unused during the runs. Observed: a Primary process listing at 04:48:31Z showed no cargo, rustc, ffmpeg or OBS process and no node, Chrome or Edge process of this project; the session ran no concurrent build, test or agent work. The runner's own listing (`tasklist.exe /fo csv /nh`, 330 processes, SHA-256 `62059fb6…59a2`) was captured at 04:48:49.329Z, just before the start. No CPU-load sampling, per the user's standing instruction |
| Start      | `utcStart` 2026-10-20T04:48:49.971Z; `utcEnd` 05:01:50.578Z, a record span of 13 min 1 s. The shell timed the whole command at 13 min 4 s. The five timed repetitions and the native oracle process finished by about 04:50Z; most of the span is the TypeScript evaluation of the 3,270-entry oracle dump                                                                                                                                                                                                                                                                                                                                                                |
| N/A        | Browser, GPU, viewport and DPR: not applicable to a native CPU benchmark, as the record states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Oracle gates

A failed gate or a nonzero `MESH_CHECK` count would invalidate the run (verdict `INVALID`, no verdict). None failed.

| Gate    | What it checks                                                                                                                                                                                   | Checked | Failures | Pass |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------: | -------: | ---- |
| SL-O1   | Exact certificate re-verification on every dump entry with an S1 view, except `PREFIX` fallbacks                                                                                                 |   2,951 |        0 | yes  |
| SL-O2   | Exact region and mesh validity of every fast-rung mesh                                                                                                                                           |   2,242 |        0 | yes  |
| SL-O3   | Agreement with the exact rung on every path both rungs admit                                                                                                                                     |   1,332 |        0 | yes  |
| SL-O4   | Exact rung unchanged: 1,270 exact outcomes and 35 batch checksums against the 2026-10-17 record, and the dump complete                                                                           |   1,305 |        0 | yes  |
| AL-I2   | Every non-fast path: module-level ladder agreement and the one-path export output byte-equal to `exact_only` (1,028 fallback paths, two checks each)                                             |   2,056 |        0 | yes  |
| harness | Zero allocations in every ladder call, every `build_path` outcome equal to the module ladder's, kernel revision 2 (3,270 entries: 1,270 B0 corpus paths and 2,000 of `p3-fill-ladder-random/v1`) |   3,270 |        0 | yes  |

- **`MESH_CHECK` count: 0.** No fast mesh failed the always-on AL-FR9 check.
- **AL-I3 (observation, not a gate):** 3,270 entries checked, 2,949 identical to the spike module, 321 allowed `RANGE` differences, 0 AL-M5 differences and 0 other differences.
- **Allocation and storage:** every timed batch and every admission pre-check call in all five repetitions was allocation-free, and the engine storage (addresses and capacities) was unchanged across every timed cell.
- **E5 (recorded once per repetition, equal in all five):** `size_of::<FillEngine>()` 13,176 bytes; the engine's `heap_bytes()` (workspace, scratch and ladder storage reserved from `FILL_V0_LIMITS`) 1,223,256 bytes, the same in every prepared cell engine; the largest cell's input and output buffers 1,057,432 bytes.

## Validity checks

| Check                                 | Pass | Detail                                                                                              |
| ------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| 5b-admission-and-ladder-mix-identical | yes  | 5 repetitions compared; first ladder mix hash 08c85ab01ffa                                          |
| 1-admitted-P2                         | yes  | 10 admitted; largest P2/s=16 admitted                                                               |
| 1-admitted-P4                         | yes  | 10 admitted; largest P4/s=16 admitted                                                               |
| 1-admitted-P8                         | yes  | 6 admitted; largest P8/s=8 admitted                                                                 |
| 2-prediction-factor                   | NO   | max factor 3.874, limit 2; four P8 p95 fits exceed 2; see [Why check 2 failed](#why-check-2-failed) |
| 3-no-unverified-primary-cell          | yes  | none                                                                                                |
| 4-linearity                           | yes  | ratios 0.914, 1.015, 1.045, 1.176 and 1.016 for repetitions 0-4, limit 1.25                         |
| 5-checksums-identical                 | yes  | all equal                                                                                           |
| 6-flat-commands                       | yes  | L + 2C on every path                                                                                |
| 7-repetitions-complete                | yes  | 5 of 5, no failed process                                                                           |
| 8-metadata-complete                   | yes  | complete                                                                                            |

The clock quantum was 100 ns in every repetition, and every repetition reported kernel revision 2. Linearity on P4/s=16: per-path median at 10 paths 65.9-75.5 µs, at 100 paths 67.5-78.0 µs.

## Estimates against the budgets (k = 2)

The runner computes the estimates even when a check fails. They do not decide this verdict (see [Context](#context-the-estimates-against-the-budgets)). k = 2 is B0's provisional factor; the AL-S2 record replaces it with the measured k̂.

| Quantity                                         | Estimate   | Budget   | Ratio to budget |
| ------------------------------------------------ | ---------- | -------- | --------------: |
| Initial build T̂                                  | 1,305.9 ms | 1,000 ms |           1.306 |
| Edit proxy t̂_edit (p95)                          | 5.531 ms   | 4 ms     |           1.383 |
| Mesh memory M̂ (E2, the decision quantity)        | 6.81 MiB   | 64 MiB   |           0.106 |
| Port payload with boundary pairs (reported only) | 8.77 MiB   | —        |               — |
| Per path t̂ (k-free)                              | 0.6529 ms  | —        |               — |
| Per-path p95 t̂_p95 (k-free)                      | 2.7656 ms  | —        |               — |

**Binding fits.** T̂ and t̂ come from the P8 median fit of repetition 0 (slope 1.163, prediction factor 1.765): 0.6529 ms per path at L\* = 256, times 1,000 paths and k = 2. t̂_edit comes from the P8 p95 fit of repetition 0 (slope 1.451, factor 3.582): 2.7656 ms per path, times k = 2. In both the prediction bound U, not the curvature guard G, binds. The binding edit fit is itself one of the four fits that fail check 2. The fit with the largest factor, P8 p95 repetition 4 (3.874), estimates 1.123 ms and does not bind. M̂ is 1,000 times the largest value at L\* of the least-squares lines of mean E2 bytes against L: the P8 line at L\* = 256 gives 7,144 bytes per path, so M̂ = 7,144,000 bytes; with 8 bytes per boundary pair the payload is 9,192 bytes per path, 9,192,000 bytes.

**Fallback share.** Every timed decision path (340: the first 10 of each of the 34 cells) took the fast rung, in every repetition; the fallback rate at the largest cell is 0 for P2, P4 and P8. The estimates therefore contain no exact-rung time.

## Fitted slopes

Fitted log-log slopes of the per-path median against leaves, over the five repetitions: P2 0.881-0.989, P4 0.930-1.103, P8 0.948-1.163 and K2 0.820-1.135. The p95 fits of individually timed paths: P2 0.919-1.032, P4 0.814-1.212, P8 0.882-1.451 and K2 0.707-1.503. Every fit, with its factor, binding term and estimate, is in the [per-fit table](#fitted-slopes-and-per-fit-estimates).

## Fallback and admission

### Decision cells

All 34 decision cells are ADMITTED in every repetition. The admission pre-check (paths 0-9 of each cell and 0-99 of P4/s=16, 430 paths) put every path on the fast rung with status `OK` and no fallback, identically in all five repetitions (check 5b). The mean E2 bytes per path are equal to the spike record's in every cell (for example 872 at P2/s=16 and 1,768 at P4/s=16 and P8/s=8). The mean port payload with boundary pairs is 1,128 bytes at P2/s=16 and 2,280 bytes at P4/s=16 and P8/s=8. Each fast mesh has V = L vertices and T = L − 2C triangles, as in the spike.

### O1, generic coordinates (untimed, outside the decision)

30 paths per cell, through `build_path`. "Published" counts paths with an `OK` mesh from either rung; "B0 exact OK" is the 2026-10-17 record's exact-rung OK count.

| O1 cell    | Fast | Fallbacks  | Conservative | Published | B0 exact OK |
| ---------- | ---: | ---------- | -----------: | --------: | ----------: |
| O1/P2/s=3  |   24 | CLOSURE 6  |            0 |        24 |           1 |
| O1/P2/s=4  |   28 | CLOSURE 2  |            0 |        28 |           4 |
| O1/P2/s=5  |   20 | CLOSURE 10 |            0 |        20 |           0 |
| O1/P2/s=6  |   22 | CLOSURE 8  |            0 |        22 |           0 |
| O1/P2/s=7  |   24 | CLOSURE 6  |            0 |        24 |           0 |
| O1/P2/s=8  |   26 | CLOSURE 4  |            0 |        26 |           0 |
| O1/P2/s=10 |   27 | CLOSURE 3  |            0 |        27 |           0 |
| O1/P2/s=12 |   28 | CLOSURE 2  |            0 |        28 |           2 |
| O1/P2/s=14 |   30 | 0          |            0 |        30 |           0 |
| O1/P2/s=16 |   29 | CLOSURE 1  |            0 |        29 |           2 |
| O1/P4/s=3  |   25 | CLOSURE 5  |            0 |        25 |           1 |
| O1/P4/s=4  |   28 | CLOSURE 2  |            0 |        28 |           4 |
| O1/P4/s=5  |   25 | CLOSURE 5  |            0 |        25 |           0 |
| O1/P4/s=6  |   29 | CLOSURE 1  |            0 |        29 |           0 |
| O1/P4/s=7  |   29 | CLOSURE 1  |            0 |        29 |           0 |
| O1/P4/s=8  |   30 | 0          |            0 |        30 |           0 |
| O1/P4/s=10 |   30 | 0          |            0 |        30 |           0 |
| O1/P4/s=12 |   28 | CLOSURE 2  |            0 |        28 |           2 |
| O1/P4/s=14 |   30 | 0          |            0 |        30 |           0 |
| O1/P4/s=16 |   22 | PREFIX 8   |            0 |        22 |           2 |
| O1/P8/s=3  |   27 | CLOSURE 3  |            0 |        27 |           1 |
| O1/P8/s=4  |   30 | 0          |            0 |        30 |           4 |
| O1/P8/s=5  |   27 | CLOSURE 3  |            0 |        27 |           0 |
| O1/P8/s=6  |   26 | CLOSURE 4  |            0 |        26 |           0 |
| O1/P8/s=7  |   25 | CLOSURE 5  |            0 |        25 |           0 |
| O1/P8/s=8  |   22 | PREFIX 8   |            0 |        22 |           0 |

Totals over the 780 O1 paths: 691 fast, 73 `CLOSURE` and 16 `PREFIX` fallbacks, no conservative fallback, the same counts as the spike record. All 691 published paths are fast meshes; the exact rung publishes none of the 89 fallbacks. The 2026-10-17 record's exact rung admitted 23 O1 paths.

### X, crossings (untimed, outside the decision)

| X cell | Paths | `CROSSING` | Published (`OK`) | As expected |
| ------ | ----: | ---------: | ---------------: | ----------- |
| X/s=5  |    10 |         10 |               10 | yes         |
| X/s=7  |    10 |         10 |               10 | yes         |
| X/s=9  |    10 |         10 |               10 | yes         |
| X/s=11 |    10 |         10 |               10 | yes         |
| X/s=13 |    10 |         10 |               10 | yes         |
| X/s=15 |    10 |         10 |               10 | yes         |

Every X path falls back with `CROSSING`, and the exact rung's cascade publishes all 60 (V2's triangle-free retry), as AL-U5's functional run showed.

### Randomized family `p3-fill-ladder-random/v1` (untimed, outside the decision)

2,000 paths (seed 1279345746, SHA-256 `a597510d…7bbc`): 1,121 fast; fallbacks `RANGE` 321, `CLEARANCE` 132, `PREFIX` 303, `CLOSURE` 27 and `MONOTONE` 96; 34 conservative; 1,380 published (1,121 fast and 259 by the exact rung).

## SL-O5 sliver statistics, fast versus exact

Float64, observational: quality ρ = 4√3·A / (ℓ1² + ℓ2² + ℓ3²), the smallest angle, per group and rung over the oracle run's meshes. No R0 or R2 compliance is claimed (AL-OB4). The per-cell values are in the `.json` (`oracle.slivers`).

| Group      | Rung  | Meshes | Triangles | Non-finite ρ | Min ρ   | Min angle (°) | ρ < 0.1 | ρ < 0.01 |
| ---------- | ----- | -----: | --------: | -----------: | ------- | ------------- | ------: | -------: |
| Decision   | fast  |    430 |    16,160 |            0 | 0.00198 | 0.0670        |   5,817 |       76 |
| Decision   | exact |    430 |    33,081 |            0 | 1.10e-5 | 0.000365      |  23,545 |    2,981 |
| O1         | fast  |    691 |    19,521 |            0 | 0       | 0             |   4,702 |      277 |
| O1         | exact |     23 |     1,116 |            0 | 2.77e-5 | 0.000918      |     731 |       50 |
| X          | exact |     60 |     2,280 |            0 | 5.4e-17 | 1.8e-15       |   1,029 |       85 |
| Randomized | fast  |  1,121 |    23,144 |           57 | 0       | 0             |   3,329 |      156 |
| Randomized | exact |  1,138 |    52,453 |        5,887 | 0       | 0             |  23,673 |    3,638 |

The decision and O1 rows are equal to the spike record's totals. The O1 fast minimum of 0 comes from contracted contours (SL-L5), as the spike record explains. "Non-finite ρ" counts triangles whose Float64 quality is not finite, as the record stores it; SL-O2 validates every fast mesh exactly and passes.

## SL-O6 geometric error observation

Native Float64 output only, as fractions of δ = 0.125; this is not D8 checkpoint B4's A04 corpus measurement.

| Group      | Fast paths | Max certified δ̄ / δ | Max exact \|d_m\| / δ | Contracted contours |
| ---------- | ---------: | ------------------- | --------------------- | ------------------: |
| Decision   |        430 | 0.752541 (P2/s=7)   | 0.752541              |                   0 |
| O1         |        691 | 0.750000            | 0.750000              |                 247 |
| X          |          0 | —                   | —                     |                   0 |
| Randomized |      1,121 | 0.997846            | 0.997846              |                  69 |

Every maximum is below 1 (δ̄ < δ, as SL-C1 requires), and the certified bound is at or above the exact value. The decision and O1 values equal the spike record's (0.0940676 and 0.0937500 in absolute units, and 247 contracted contours).

## Comparison with the 2026-10-17 B0 and 2026-10-18 spike records

All values below come from `analyze()` of the three committed records (`tests/geometry/p3-fill-ladder/analysis.ts` for this record, `tests/geometry/p3-b0-spike/analysis.ts` for the [spike record](2026-10-18_p3_p3-b0-spike-ladder-v1_native_desktop-dkvusav_20261018T213619Z-89016cc9.json) and `tests/geometry/p3-b0/analysis.ts` for the [2026-10-17 record](2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.json)), with the same corpus, cells, sampling and fit code, on the same machine. **Ratios are earlier record / this record, so a value above 1 means this run is faster or smaller.** The B0 scenario measures the exact rung alone through the private workspace; the spike measures the test-only ladder module; this run measures the production export, which took the fast rung on every timed path. The export window also includes the always-on AL-FR9 check, output writing and the FNV-1a fold of the output, and the certificate carries the AL-U4b1 and AL-U4b2 optimizations.

**Verdicts:** B0 2026-10-17 INCONCLUSIVE (check 2, max factor 3.248); spike 2026-10-18 INCONCLUSIVE (check 2, max factor 2.610); this record INCONCLUSIVE (check 2, max factor 3.874). All three are provisional at k = 2.

### Estimates

| Quantity                   | B0 2026-10-17 | Spike 2026-10-18 | AL-S1 2026-10-20 | B0 / AL-S1 | Spike / AL-S1 |
| -------------------------- | ------------: | ---------------: | ---------------: | ---------: | ------------: |
| T̂, initial build at k = 2  |   41,419.3 ms |       1,285.3 ms |       1,305.9 ms |      31.72 |         0.984 |
| t̂_edit, p95 proxy at k = 2 |    122.048 ms |         2.491 ms |         5.531 ms |      22.07 |         0.450 |
| M̂, mesh payload (E2)       |     15.41 MiB |         6.81 MiB |         6.81 MiB |       2.26 |         1.000 |
| t̂, per path at L\*         |     20.710 ms |        0.6426 ms |        0.6529 ms |      31.72 |         0.984 |

The binding initial-build fit is P8 median in all three records (repetition 4 in B0, 0 in the spike, 0 here); the binding edit fit is P8 p95 (repetition 4 in B0, 0 in the spike, 0 here). T̂ is 1.6% above the spike's and t̂_edit is 2.22 times the spike's, although the per-cell medians below are 1.01-1.39 times faster than the spike's: both binding fits here have an elevated L = 56 point (see [Why check 2 failed](#why-check-2-failed)).

### Per-cell per-path medians

Per-path median from the batch samples (batch time / 10), median over the five repetitions.

| Cell    |   L | B0 (ms) | Spike (ms) | AL-S1 (ms) | B0 / AL-S1 | Spike / AL-S1 |
| ------- | --: | ------: | ---------: | ---------: | ---------: | ------------: |
| P2/s=3  |   6 |  0.1910 |    0.00704 |    0.00655 |       29.2 |         1.075 |
| P2/s=4  |   8 |  0.2502 |    0.00911 |    0.00849 |       29.5 |         1.073 |
| P2/s=5  |  10 |  0.3191 |    0.01128 |    0.01051 |       30.4 |         1.073 |
| P2/s=6  |  12 |  0.3933 |    0.01326 |    0.01231 |       32.0 |         1.077 |
| P2/s=7  |  14 |  0.4470 |    0.01542 |    0.01419 |       31.5 |         1.087 |
| P2/s=8  |  16 |  0.5291 |    0.01740 |    0.01606 |       32.9 |         1.083 |
| P2/s=10 |  20 |  0.6364 |    0.02169 |    0.02005 |       31.7 |         1.082 |
| P2/s=12 |  24 |  0.7820 |    0.02597 |    0.02377 |       32.9 |         1.093 |
| P2/s=14 |  28 |  0.9087 |    0.02991 |    0.02817 |       32.3 |         1.062 |
| P2/s=16 |  32 |   1.068 |    0.03489 |    0.03153 |       33.9 |         1.107 |
| P4/s=3  |  12 |  0.4181 |    0.01520 |    0.01256 |       33.3 |         1.210 |
| P4/s=4  |  16 |  0.5585 |    0.01999 |    0.01627 |       34.3 |         1.229 |
| P4/s=5  |  20 |  0.6957 |    0.02488 |    0.02028 |       34.3 |         1.227 |
| P4/s=6  |  24 |  0.8136 |    0.02959 |    0.02504 |       32.5 |         1.182 |
| P4/s=7  |  28 |  0.9621 |    0.03423 |    0.02800 |       34.4 |         1.222 |
| P4/s=8  |  32 |   1.099 |    0.03923 |    0.03225 |       34.1 |         1.216 |
| P4/s=10 |  40 |   1.422 |    0.04941 |    0.04060 |       35.0 |         1.217 |
| P4/s=12 |  48 |   1.685 |    0.05914 |    0.04989 |       33.8 |         1.185 |
| P4/s=14 |  56 |   1.991 |    0.06958 |    0.05740 |       34.7 |         1.212 |
| P4/s=16 |  64 |   2.229 |    0.07986 |    0.06726 |       33.1 |         1.187 |
| P8/s=3  |  24 |  0.8557 |    0.03359 |    0.02417 |       35.4 |         1.390 |
| P8/s=4  |  32 |   1.169 |    0.04448 |    0.03231 |       36.2 |         1.377 |
| P8/s=5  |  40 |   1.463 |    0.05624 |    0.04107 |       35.6 |         1.369 |
| P8/s=6  |  48 |   1.759 |    0.06734 |    0.04981 |       35.3 |         1.352 |
| P8/s=7  |  56 |   2.141 |    0.07896 |    0.05849 |       36.6 |         1.350 |
| P8/s=8  |  64 |   2.389 |    0.08989 |    0.06710 |       35.6 |         1.340 |
| K2/s=3  |  24 |  0.8605 |    0.03051 |    0.02503 |       34.4 |         1.219 |
| K2/s=4  |  32 |   1.096 |    0.04003 |    0.03289 |       33.3 |         1.217 |
| K2/s=5  |  40 |   1.384 |    0.05000 |    0.04086 |       33.9 |         1.224 |
| K2/s=6  |  48 |   1.664 |    0.05978 |    0.04914 |       33.9 |         1.217 |
| K2/s=7  |  56 |   1.995 |    0.07000 |    0.05812 |       34.3 |         1.204 |
| K2/s=8  |  64 |   2.208 |    0.07948 |    0.07892 |       28.0 |         1.007 |
| K4/s=3  |  48 |   1.671 |    0.06315 |    0.05515 |       30.3 |         1.145 |
| K4/s=4  |  64 |   2.326 |    0.08311 |    0.06956 |       33.4 |         1.195 |

The production export is 28.0-36.6 times faster per path than the 2026-10-17 exact rung and 1.007-1.390 times faster than the spike in every cell: 1.06-1.11 times on P2, 1.18-1.23 times on P4 and 1.34-1.39 times on P8. K2/s=8 is the smallest spike ratio, because its batch median is about 79-83 µs per path in repetitions 0, 1 and 4 and about 66 µs in repetitions 2 and 3 (an upper level about 1.2-1.25 times the lower, as described below).

### Fitted slopes and per-fit estimates

Per-fit estimate t̂ = exp(max(U, G)) at L\* (64, 128 and 256 for P2, P4 and P8; 128 for K2), per path, before the factor k. "Binding" is the larger of U and G for this record's fit.

| Series | Kind   | Rep | Slope | Factor | Binding | Estimate (ms) | Spike estimate (ms) | Spike / AL-S1 | B0 estimate (ms) | B0 / AL-S1 |
| ------ | ------ | --: | ----: | -----: | ------- | ------------: | ------------------: | ------------: | ---------------: | ---------: |
| P2     | median |   0 | 0.989 |  1.312 | U       |       0.08863 |             0.08892 |         1.003 |            2.721 |       30.7 |
| P2     | p95    |   0 | 0.987 |  1.639 | U       |        0.1347 |              0.1532 |         1.137 |            4.105 |       30.5 |
| P2     | median |   1 | 0.944 |  1.184 | U       |       0.07329 |             0.08907 |         1.215 |            2.133 |       29.1 |
| P2     | p95    |   1 | 1.032 |  1.540 | U       |        0.1307 |              0.1475 |         1.128 |            2.463 |       18.8 |
| P2     | median |   2 | 0.944 |  1.035 | G       |       0.06237 |             0.06694 |         1.073 |            2.367 |       37.9 |
| P2     | p95    |   2 | 0.952 |  1.372 | G       |        0.1259 |             0.08038 |         0.638 |            3.325 |       26.4 |
| P2     | median |   3 | 0.943 |  1.284 | U       |       0.08086 |              0.1039 |         1.285 |            2.237 |       27.7 |
| P2     | p95    |   3 | 0.987 |  1.778 | U       |        0.1417 |              0.1667 |         1.177 |            2.896 |       20.4 |
| P2     | median |   4 | 0.881 |  1.177 | U       |       0.06600 |             0.06691 |         1.014 |            2.904 |       44.0 |
| P2     | p95    |   4 | 0.919 |  1.396 | G       |       0.09649 |             0.08963 |         0.929 |            4.034 |       41.8 |
| P4     | median |   0 | 1.017 |  1.275 | U       |        0.1803 |              0.2156 |         1.196 |            5.236 |       29.0 |
| P4     | p95    |   0 | 1.034 |  1.410 | U       |        0.2591 |              0.3152 |         1.216 |            7.466 |       28.8 |
| P4     | median |   1 | 1.031 |  1.115 | G       |        0.1730 |              0.1852 |         1.071 |            4.603 |       26.6 |
| P4     | p95    |   1 | 1.187 |  1.492 | U       |        0.3412 |              0.3606 |         1.057 |            5.293 |       15.5 |
| P4     | median |   2 | 0.999 |  1.058 | G       |        0.1412 |              0.1819 |         1.288 |            4.779 |       33.8 |
| P4     | p95    |   2 | 1.123 |  1.354 | U       |        0.2565 |              0.2695 |         1.051 |            6.018 |       23.5 |
| P4     | median |   3 | 1.103 |  1.305 | U       |        0.2121 |              0.1626 |         0.767 |            4.726 |       22.3 |
| P4     | p95    |   3 | 1.212 |  1.574 | U       |        0.3552 |              0.2128 |         0.599 |            5.997 |       16.9 |
| P4     | median |   4 | 0.930 |  1.200 | U       |        0.1441 |              0.1620 |         1.124 |            6.693 |       46.4 |
| P4     | p95    |   4 | 0.814 |  1.620 | G       |        0.2007 |              0.1946 |         0.969 |            11.17 |       55.7 |
| P8     | median |   0 | 1.163 |  1.765 | U       |        0.6529 |              0.6426 |         0.984 |            15.55 |       23.8 |
| P8     | p95    |   0 | 1.451 |  3.582 | U       |         2.766 |               1.246 |         0.450 |            28.36 |       10.3 |
| P8     | median |   1 | 1.063 |  1.057 | U       |        0.3136 |              0.3761 |         1.199 |            10.66 |       34.0 |
| P8     | p95    |   1 | 1.275 |  1.870 | U       |         1.012 |              0.8874 |         0.877 |            14.14 |       14.0 |
| P8     | median |   2 | 1.039 |  1.040 | U       |        0.2925 |              0.3757 |         1.285 |            12.35 |       42.2 |
| P8     | p95    |   2 | 0.899 |  2.837 | U       |        0.7765 |              0.4066 |         0.524 |            26.30 |       33.9 |
| P8     | median |   3 | 0.970 |  1.509 | U       |        0.3907 |              0.5933 |         1.518 |            12.80 |       32.8 |
| P8     | p95    |   3 | 0.882 |  2.392 | U       |        0.6413 |              0.6306 |         0.983 |            25.89 |       40.4 |
| P8     | median |   4 | 0.948 |  1.638 | U       |        0.4063 |              0.3729 |         0.918 |            20.71 |       51.0 |
| P8     | p95    |   4 | 0.947 |  3.874 | U       |         1.123 |              0.7708 |         0.686 |            61.02 |       54.3 |
| K2     | median |   0 | 1.131 |  1.370 | U       |        0.2187 |              0.1764 |         0.807 |            4.798 |       21.9 |
| K2     | p95    |   0 | 1.210 |  1.596 | U       |        0.3556 |              0.3327 |         0.935 |            8.220 |       23.1 |
| K2     | median |   1 | 1.118 |  1.272 | U       |        0.1982 |              0.2447 |         1.235 |            4.528 |       22.8 |
| K2     | p95    |   1 | 1.503 |  2.127 | U       |        0.5919 |              0.5708 |         0.964 |            5.463 |        9.2 |
| K2     | median |   2 | 0.984 |  1.063 | U       |        0.1390 |              0.1643 |         1.182 |            4.768 |       34.3 |
| K2     | p95    |   2 | 0.894 |  1.333 | U       |        0.2022 |              0.2851 |         1.410 |            6.604 |       32.7 |
| K2     | median |   3 | 0.820 |  1.303 | U       |        0.1449 |              0.1593 |         1.099 |            4.865 |       33.6 |
| K2     | p95    |   3 | 0.707 |  2.080 | U       |        0.2300 |              0.1877 |         0.816 |            5.743 |       25.0 |
| K2     | median |   4 | 1.135 |  1.392 | U       |        0.2211 |              0.2015 |         0.911 |            6.593 |       29.8 |
| K2     | p95    |   4 | 1.293 |  2.128 | U       |        0.4857 |              0.2239 |         0.461 |            15.36 |       31.6 |

## Why check 2 failed

These are facts from the record; this section chooses no remedy. Check 2 covers the primary series only: the K2 p95 fits of repetitions 1, 3 and 4 also have factors above 2 (2.127, 2.080 and 2.128), but K2 is an observational series and does not enter check 2.

**What the check measures.** For each primary fit (series P2, P4 and P8; each of five repetitions; the per-path median and the per-path p95 kind, 30 fits), the prediction factor is exp(U − ŷ(x\*)) = exp(t · s_e · √(1 + 1/n + (x\* − x̄)² / S_xx)), with t the one-sided Student-t quantile for n − 2 degrees of freedom and s_e the residual standard error of the log-log fit. The leaf values, n and L\* are those of every earlier B0 record, so the factor depends on the measurement only through s_e, and the thresholds are unchanged:

| Series | n   | L\*     | t        | √(…)  | Factor         | Limit 2 holds when |
| ------ | --- | ------- | -------- | ----- | -------------- | ------------------ |
| P2, P4 | 10  | 64, 128 | 1.859548 | 1.370 | exp(2.547 s_e) | s_e ≤ 0.272        |
| P8     | 6   | 256     | 2.131847 | 2.469 | exp(5.264 s_e) | s_e ≤ 0.132        |

**Which fits fail.** Four of the 30 primary fits exceed 2, all P8 p95 fits, the same series and kind as in the 2026-10-17 and spike records:

| Fit                 | s_e   | Factor | Slope | Outlying point (log residual) |
| ------------------- | ----- | ------ | ----- | ----------------------------- |
| P8 p95 repetition 4 | 0.257 | 3.874  | 0.947 | L = 32, P8/s=4 (+0.414)       |
| P8 p95 repetition 0 | 0.242 | 3.582  | 1.451 | L = 56, P8/s=7 (+0.401)       |
| P8 p95 repetition 2 | 0.198 | 2.837  | 0.899 | L = 40, P8/s=5 (+0.331)       |
| P8 p95 repetition 3 | 0.166 | 2.392  | 0.882 | L = 32, P8/s=4 (+0.245)       |

The next largest are P8 p95 repetition 1, 1.870 (s_e 0.119), P2 p95 repetition 3, 1.778 (s_e 0.226, below its threshold 0.272), and P8 median repetition 0, 1.765 (s_e 0.108). Every median fit passes; the largest median factor is 1.765 (P8, repetition 0).

**Where the scatter comes from.** The p95 kind uses, per cell, the nearest-rank p95 of the 200 individually timed one-path calls (20 samples of 10), that is the 190th smallest, so 11 or more elevated samples in a cell lift it. Each failing fit has one cell whose individual path times rise to a higher level for part of the cell, while the same cell in other repetitions stays at the lower level. Times below are individual one-path call times; "batch per path" is the ten-path call of the same sample divided by 10.

- **Repetition 4 (factor 3.874), P8/s=4, the 6th of 34 cells in that repetition's shuffled order.** The P8 p95 points at L = 24, 32, 40, 48, 56 and 64 are 0.0245, 0.0612, 0.0434, 0.0578, 0.0754 and 0.0700 ms. In P8/s=4 the path times are 32.0-32.5 µs, with isolated values up to 40.4 µs, through samples 0-5 and the first six paths of sample 6. The last four paths of sample 6 are 35.1, 35.1, 46.6 and 88.3 µs, sample 7 is 61.2-65.8 µs and sample 8 41.8-49.1 µs. Samples 9-19 are mostly 39.8-41.6 µs, with runs of 45.9-59.4 µs in samples 10, 12 and 13. 24 samples exceed 1.25 times the cell's path median of 40.3 µs, in samples 6, 7, 10, 12 and 13; the maximum is 88.3 µs. The cell's p95 is 61.2 µs, against 35.7-39.0 µs in repetitions 0-2 and 54.7 µs in repetition 3. The batch per path is 32.1-32.6 µs in samples 0-6, 62.9 µs in sample 7, 57.4 µs in sample 8 and 40.4-48.0 µs after; the cell's batch median is 40.50 µs, against 31.89-32.31 µs in repetitions 0-2. The L = 24 point of the same fit, P8/s=3, is low (24.5 µs, residual −0.229), against 24.8-30.9 µs in the other repetitions.
- **Repetition 0 (factor 3.582), P8/s=7, the 9th cell.** The points are 0.0248, 0.0390, 0.0480, 0.0605, 0.1270 and 0.0821 ms; the largest residuals are +0.401 at L = 56 and −0.229 at L = 64. In P8/s=7 the path times are about 70-80 µs through most of the cell, with all ten paths of sample 3 at 128.7-157.4 µs and sample 4 at 89.7-107.4 µs; they are at a lower level of 58.2-62.6 µs only in paths 2-9 of sample 1 and most of samples 17-19. 27 samples exceed 1.25 times the cell's path median of 74.2 µs, in samples 3, 4, 5, 7, 8, 12, 13 and 14; the maximum is 157.4 µs. The path median itself is at the upper level, against 58.1-58.9 µs in repetitions 1-4, and the p95 is 127.0 µs against 65.1-75.4 µs. The cell's batch median is 75.58 µs per path, against 58.13-58.94 µs in repetitions 1-4.
- **Repetition 2 (factor 2.837), P8/s=5, the 29th cell.** The points are 0.0309, 0.0360, 0.0718, 0.0644, 0.0651 and 0.0708 ms. In P8/s=5 the path times are 40.4-41.9 µs, with isolated values up to 47.7 µs, in samples 0-1 and 6-18. From the third path of sample 2 they rise: 51.5-61.0 µs in sample 2, 50.3-65.4 µs in sample 3, 71.8-75.0 µs in sample 4, then up to 75.9 µs in sample 5, falling back to 42.0-42.9 µs in its last three paths; the first seven paths of sample 19 are 41.0-54.9 µs. 35 samples exceed 1.25 times the path median of 41.0 µs, in samples 2-5 and 19; the maximum is 75.9 µs. The p95 is 71.8 µs against 43.4-50.4 µs in the other repetitions. The batch median, 40.89 µs per path, stays at the other repetitions' 40.95-41.18 µs, because only three of its 20 batch samples are elevated (53.7, 69.5 and 62.7 µs per path in samples 3-5).
- **Repetition 3 (factor 2.392), P8/s=4, the 7th cell.** The points are 0.0278, 0.0547, 0.0504, 0.0654, 0.0710 and 0.0706 ms. In P8/s=4 the path times alternate between two levels, about 32.6-33.6 µs and about 39.0-40.6 µs, in runs that cross sample boundaries: the lower level in paths 1-6 of sample 2, from the end of sample 13 through sample 14, in paths 3-8 of sample 16 and in sample 19, the upper level elsewhere. Runs of elevated values, up to 98.3 µs, are in samples 2 (last three paths), 4-6 and 17-18. 30 samples exceed 1.25 times the path median of 39.5 µs, which is itself at the upper level against 32.0-32.4 µs in repetitions 0-2; the maximum is 98.3 µs and the p95 54.7 µs.
- **The same elevation moves the binding median fit.** Repetition 0's P8/s=7 batch median (0.07558 ms) is the L = 56 point of the P8 median fit of repetition 0, which lies above that fit's L = 64 point (0.06726 ms); its residual, +0.180, is the fit's largest and gives the largest median factor, 1.765. That fit binds T̂. The other P8 median fits estimate 0.2925-0.4063 ms per path. Repetition 0's P8 p95 fit, which binds t̂_edit, is the second failing fit above.
- **Size of the levels.** Where two levels appear (P8/s=4 in repetitions 3 and 4, P8/s=7 in repetition 0, and K2/s=8 across repetitions), the upper is about 1.2-1.27 times the lower. Linearity in repetition 3 (100-path per path 78.0 µs against 66.4 µs at 10 paths, ratio 1.176) is within its limit.

**Relation to the earlier records.** The failing series and kind are the same in all three records, P8 p95, and the mechanism is the same kind: elevated individual samples concentrated in one cell of a six-point fit whose target is four times beyond the data. Four P8 p95 fits fail here, against two in the spike record and two in the 2026-10-17 record. The P8 per-path medians here are 0.024-0.067 ms, 1.34-1.39 times smaller than the spike's and 35.3-36.6 times smaller than the 2026-10-17 record's, so a delay of a given absolute size weighs more relative to the sample, and the fit works on logarithms. The record does not identify the source of the level changes; the run had no CPU-load sampling, by the user's standing instruction.

## Context: the estimates against the budgets

This is a fact, not a verdict. The runner's verdict is INCONCLUSIVE and stands. At k = 2 the estimates are T̂ = 1,305.9 ms (1.306 times B_init = 1,000 ms), t̂_edit = 5.531 ms (1.383 times B_edit = 4 ms) and M̂ = 6.81 MiB (0.106 of B_mem = 64 MiB). With the measured k̂ = 1.579 of the AL-S2 record, the product estimates are T̂ = 1,031.1 ms (1.031 times B_init) and t̂_edit = 4.367 ms (1.092 times B_edit), with M̂ unchanged; the AL-S2 record states them, and its product verdict is INCONCLUSIVE because check 2 fails here.

## Scope of this verdict

As the contract requires for every verdict:

- It covers simple, disjoint, snapped contours at zoom 1 and densities of 2-8 leaves per cubic, at e = 8, extrapolated to L\* = 4 times the largest L with the curvature guard's limits.
- It does not cover the roadmap's 1%-6400% zoom range (DF9 is deferred, AL-OB6), generic-coordinate input (O1 is an observation) or crossings of any kind (O2 is an observation; crossings take the exact rung).
- Extrapolating beyond the data assumes no new cost regime between the largest admitted L and L\*; the curvature guard limits, but does not remove, that risk.
- It is provisional on native measurement and k = 2. The product-stage verdict with k = k̂ is the AL-S2 record's.
- It holds for the production operation `'geometry-wasm/fill-v0+r2'` at `e2cf5b7`, with the fallback rates this record reports (every timed decision path on the fast rung).

## Limits of this record

- It measures the production export natively, on one CPU, single thread, in a test-harness release build with the recorded overhead. It says nothing about browser, WASM or GPU cost, the V3c fringe builder, scene application or upload, or edit latency beyond the stated proxy, which is a lower bound.
- It is one run. It does not show whether the level changes in P8/s=4, P8/s=5, P8/s=7 and K2/s=8 recur.
- The fallback cost is not exercised on the decision cells: no timed path fell back, so the estimates contain no exact-rung time. The O1, X and randomized-family fallbacks are untimed.
- Background load is an operator statement plus process listings 19 s and under 1 s before the start, with no CPU-load sampling.
- The comparisons with the 2026-10-17 and 2026-10-18 records are across runs on different days, with different code (exact rung alone, test-only spike module, production export).
- SL-O5 and SL-O6 are Float64 observations. SL-O6 is not D8 checkpoint B4's A04 measurement.
- It closes no A01-A08 criterion. Acting on it needs the independent evidence review (AL-A15). Under the contract's section 5.3 and user decision B0-Q3, an INCONCLUSIVE verdict goes to the user before B1, as INFEASIBLE does, with the measured numbers; this record chooses no remedy.

## Review note (AL-A15, 2026-10-20)

Appended after the independent evidence review; the text above is unchanged, and the raw `.json` is unchanged.

- **Status.** The independent evidence review AL-A15 accepted this record on 2026-10-20 with no blocking items: the verdict recomputes exactly from the raw samples, every hash, link and provenance item checks out, and the tables match `analyze()`. The status line above still says Exploratory because the body is immutable; read it as accepted ([plan entry](../../plans/p3-fill-stroke-meshes.md#alt-a1-al-u7-reference-runs)).
- **Correction, "Where the scatter comes from".** The sentence that the same cell in other repetitions stays at the lower level is wrong for P8/s=4: that cell is at the upper level in both repetitions 3 and 4 (path medians 39.5 and 40.3 µs, against 32.0-32.4 µs in repetitions 0-2). It holds for P8/s=7 (repetition 0 only) and P8/s=5 (repetition 2 only).
- **Correction, "Size of the levels".** The band of about 1.2-1.27 times holds for the cells it names (P8/s=4 in repetitions 3 and 4, P8/s=7 in repetition 0, and K2/s=8). It does not describe P8/s=5 in repetition 2, which rises from about 41 µs to 51.5-75.9 µs, up to about 1.85 times.
- **Background load disclosure.** The runner's process listing shows no process of this project, so that narrow claim holds, and the 2026-10-12 protocol minimum (operator statement plus process listings) is met. The listing does show a third-party `hyperframes preview` tool running since 2026-10-19 (node PID 30716, esbuild PID 26568 and four `chrome-headless-shell` processes) and interactive applications: Chrome (22-28 processes), 14 `claude.exe`, codex, ChatGPT, TradingView, `Video.UI.exe`, Teams and TeamViewer. This is relevant beside the unexplained level changes in check 2; it does not identify their source.
