# P3 B0 feasibility, B0R remeasure run 20261017T150336Z-23973138

Status: Exploratory until the independent evidence review in the [execution plan](../../plans/p3-fill-stroke-meshes.md#b0r-u8-remeasure) accepts it. This record is an immutable observation; corrections append a review record.

**Verdict (computed by the runner from the raw samples): INCONCLUSIVE.** Validity check 2 (prediction factor) fails with a maximum factor of 3.248 against the limit 2. The other ten checks pass. Under the frozen decision rule a failed check makes the verdict INCONCLUSIVE whatever the estimates are. Its scope is limited; see [Scope of this verdict](#scope-of-this-verdict).

This run is the remeasure of the [B0R kernel fill performance contract](../../plans/p3-b0r-kernel-performance-contract.md#8-remeasure-plan), section 8. It reruns the unchanged B0 scenario on the kernel after B0R units U0-U7. The first B0 record, [run 20261012T144359Z-65a7b05f](2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.md), is not changed.

## Scenario and contract

- Scenario `p3-b0-feasibility` v1, configuration hash `a10c98e9c732929b2752a7349486cbd95e31cc02018d3c703011543483d29271`, corpus SHA-256 `206cf6e9971d5f38f11cbef801692555843b1602ee937c5e1b60ed7dbd329796`. Both equal the values pinned in B0R section 8 item 3.
- Contract: [frozen B0 contract](../../plans/p3-b0-feasibility-benchmark-contract.md). Runner `p3-b0-runner/1`, profile `reference`.
- Raw record: [`.json` beside this file](2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.json), a byte-for-byte copy of the runner's `record.json` (SHA-256 `e10bbfc1d5155f9915e5c98d4aedc0dc5ae567c1580bfea4ad2480a7e5d1ed9f`). `validateRecord` (`tests/geometry/p3-b0/analysis.ts`) recomputes aggregates, fits, estimates, checks and the verdict from its raw samples and accepts it.
- Command: `pnpm benchmark:p3-b0 --profile reference --environment-json <scratchpad>/b0r-u8-env.json`.

## Environment

| Item       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine    | DESKTOP-DKVUSAV, the reference machine per the prototype plan's accepted constraint 2                                                                                                                                                                                                                                                                                                                                                                   |
| CPU, RAM   | AMD Ryzen 7 3700X, 16 logical cores, 34,291,060,736 bytes (31.94 GiB)                                                                                                                                                                                                                                                                                                                                                                                   |
| OS         | Windows 11 Pro 10.0.26200, x64, timezone Asia/Seoul                                                                                                                                                                                                                                                                                                                                                                                                     |
| Toolchain  | rustc 1.94.1 (e408947bf 2026-03-25), x86_64-pc-windows-msvc, LLVM 21.1.8; Node 24.15.0                                                                                                                                                                                                                                                                                                                                                                  |
| Source     | `main` commit `0b481632568f5e7e2ceec0c2bf9921ce8295af75` (B0R U7 merged through PR #145), clean tree as the runner recorded it. The untracked, machine-local `.claude/launch.json` was moved out of the worktree for the run, because the runner requires a clean worktree, and restored afterwards; it is not a source file                                                                                                                            |
| Power      | AC online, no system battery, Windows plan Balanced. Source: Primary-session observation immediately before the run (`SystemInformation.PowerStatus`, `powercfg /getactivescheme`)                                                                                                                                                                                                                                                                      |
| Background | Operator statement, not observed: the operator replied "시작해" in chat to the readiness question that asked for heavy work (video, recording, builds) to stop during the run. Observed: a Primary process listing at 15:03:09Z, 27 s before the start, showed no node, cargo, rustc, ffmpeg, OBS, MSBuild or Visual Studio process; the session ran no concurrent build, test or agent work. No CPU-load sampling, per the user's standing instruction |
| Start      | 2026-10-17T15:03:36.199Z; the record's end time is 15:06:05.333Z. The whole command took about 2 min 31 s (shell timing of the whole command; the record's own span is 2 min 29 s)                                                                                                                                                                                                                                                                      |

## Validity checks

| Check                               | Pass | Detail                                                                   |
| ----------------------------------- | ---- | ------------------------------------------------------------------------ |
| 5b-admission-and-topology-identical | yes  | 5 repetitions compared; first admission hash 2ea479cdae7a                |
| 1-admitted-P2                       | yes  | 10 admitted; largest P2/s=16                                             |
| 1-admitted-P4                       | yes  | 10 admitted; largest P4/s=16                                             |
| 1-admitted-P8                       | yes  | 6 admitted; largest P8/s=8                                               |
| 2-prediction-factor                 | NO   | max factor 3.248, limit 2; see [Why check 2 failed](#why-check-2-failed) |
| 3-no-unverified-primary-cell        | yes  | none                                                                     |
| 4-linearity                         | yes  | ratios 0.987 to 1.041 over the five repetitions                          |
| 5-checksums-identical               | yes  | all equal                                                                |
| 6-flat-commands                     | yes  | L + 2C on every path                                                     |
| 7-repetitions-complete              | yes  | 5 of 5, no failed process                                                |
| 8-metadata-complete                 | yes  | complete                                                                 |

Every timed batch was allocation-free. The clock quantum was 100 ns in every repetition.

## Estimates against the budgets (k = 2)

The runner computes the estimates even when a check fails. They do not decide this verdict (see [Context](#context-the-estimates-against-the-budgets)).

| Quantity                    | Estimate    | Budget   | Ratio          |
| --------------------------- | ----------- | -------- | -------------- |
| Initial build               | 41,419.3 ms | 1,000 ms | about 41× over |
| Edit proxy (p95)            | 122.048 ms  | 4 ms     | about 31× over |
| Mesh memory                 | 15.41 MiB   | 64 MiB   | within         |
| Per path (supporting value) | 20.710 ms   | —        | —              |

The per-path value and the initial-build estimate come from the P8 median fit of repetition 4 (slope 1.137). The edit proxy comes from the P8 p95 fit of repetition 4 (61.024 ms per path, times k = 2), the same fit that sets the check 2 maximum. In both, the prediction bound U, not the curvature guard G, is binding.

## Fitted slopes

Fitted log-log slopes of the per-path median against leaves, over the five repetitions: P2 1.010-1.032, P4 1.003-1.020, P8 0.953-1.137 and K2 0.820-1.110. The p95 fits of individually timed paths have slopes P2 0.978-1.091, P4 0.910-1.038 and P8 0.856-1.284. Every slope is in the [comparison table](#fitted-slopes-and-per-fit-estimates).

Contour sensitivity at equal total cubics: K2 against P4 0.987-1.058 (1.058 at 6 cubics, 0.987-0.997 at 8, 12 and 16), K4 against P4 0.992 and 1.043.

## Measured drivers

Stage split from the diagnostic run at the largest cells, in ms per 10-path batch (S1 flatten and leaf partitions, S2 topology certificate, S3 tessellation):

| Cell    | Flatten | Topology | Tessellation |  Total | Topology share |
| ------- | ------: | -------: | -----------: | -----: | -------------: |
| P2/s=16 |   0.058 |    7.481 |        2.945 | 10.483 |            71% |
| P4/s=16 |   0.092 |   16.793 |        6.778 | 23.662 |            71% |
| P8/s=8  |   0.081 |   18.059 |        6.916 | 25.057 |            72% |

The topology certificate still takes the larger share, about 71-72%; the tessellation takes about 28-29%.

## H1 (exact-arithmetic hypothesis)

| Series | Cell    | Exact share | Overhead | Verdict       |
| ------ | ------- | ----------- | -------- | ------------- |
| P2     | P2/s=16 | 0.125       | 0.981    | Not supported |
| P4     | P4/s=16 | 0.131       | 1.062    | Not supported |
| P8     | P8/s=8  | 0.137       | 1.049    | Not supported |

The estimated exact share at the largest cells is about 0.13. The baseline-corrected share, reported but not used in the verdict, is 0.109-0.119.

**Caveat (B0R contract [section 3.1](../../plans/p3-b0r-kernel-performance-contract.md#31-principle)).** After B0R, the `fill_exact` counters count only the exact work that the filters could not avoid, while the `orient2d` and `segment_relation` counters still count every top-level call and their replayed unit costs include the filter. This H1 therefore measures the residual exact share. It is not comparable with the first record's H1 (about 0.87, Supported), and this record draws no conclusion from comparing them.

## Observations (not in the decision)

The O1 and O2 tables are identical to the first record's (see the identity cross-check below):

- **O1, unsnapped coordinates.** Almost every generic-coordinate path fails `Topology(KnotMismatch)`; O1/P2 cells admit 0 to 4 of 30 paths. P4/s=16 and P8/s=8 also show 8 `OwnerLimit` failures each.
- **O2, crossing stars.** Every path of every X cell fails `Topology(Unresolved)`.

## Identity cross-check (B0R section 8 item 4)

**Result: PASS, zero differences.** `node tooling/compare-p3-b0-records.mjs --old docs/benchmarks/results/2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.json --new docs/benchmarks/results/2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.json` loads both committed records through `validateRecord`, prints `Identity cross-check: PASS` and exits 0.

The tool compares these fields for equality, after canonical JSON serialization:

- scenario ID, scenario version and configuration hash; runner ID; corpus SHA-256;
- each record's configuration hash and corpus SHA-256 against the values pinned in B0R section 8 item 3;
- the first admission hash (`2ea479cdae7a` in both), over repetition 0's full admission;
- the set of repetition indices;
- for each of the five repetitions:
  - every admission cell, with each path's status and topology mix (rounded and transverse selection) and sizes. Allocation counts are zeroed for this comparison and then compared separately per path;
  - every timed cell's batch checksums;
  - the linearity cell and its 10-path and 100-path checksums;
- whether a diagnostic run is present, and every O1 and O2 observation cell.

Timings, environment, run ID, source commit and the other fields that may legitimately differ are not compared.

## Comparison with the 2026-10-12 record (B0R section 8 item 6)

Every value below comes from `compareRecords` in `tooling/compare-p3-b0-records.mjs`, which takes each value from `analyze()` of the two committed records. Values are converted from ns to ms. The tool's Markdown report gives ratios as new/old; the ratios below are old/new, the B0R contract's form, so a value above 1 means the remeasure is faster.

**Verdict:** old INFEASIBLE (all checks pass), new INCONCLUSIVE (check 2 fails).

### Estimates

| Quantity                     | Old (2026-10-12) | New (2026-10-17) | Old/new |
| ---------------------------- | ---------------: | ---------------: | ------: |
| T̂, initial build at k = 2    |     3,920,405 ms |      41,419.3 ms |    94.7 |
| t̂_edit, p95 proxy at k = 2   |       4,503.5 ms |       122.048 ms |    36.9 |
| M̂, mesh payload              |        15.41 MiB |        15.41 MiB |       1 |
| Per path at L\* (supporting) |       1,960.2 ms |        20.710 ms |    94.7 |

M̂ is unchanged because the meshes are bit-identical. The old binding fit was P8 median repetition 1; the new one is P8 median repetition 4.

### Per-cell per-path medians

Per-path median from the batch samples (batch time / 10), median over the five repetitions.

| Cell    |   L | Old (ms) | New (ms) | Old/new |
| ------- | --: | -------: | -------: | ------: |
| P2/s=3  |   6 |    1.468 |    0.191 |    7.68 |
| P2/s=4  |   8 |    2.478 |   0.2502 |     9.9 |
| P2/s=5  |  10 |    3.721 |   0.3191 |    11.7 |
| P2/s=6  |  12 |    5.217 |   0.3933 |    13.3 |
| P2/s=7  |  14 |    6.899 |    0.447 |    15.4 |
| P2/s=8  |  16 |    8.905 |   0.5291 |    16.8 |
| P2/s=10 |  20 |    13.49 |   0.6364 |    21.2 |
| P2/s=12 |  24 |    19.12 |    0.782 |    24.5 |
| P2/s=14 |  28 |    25.59 |   0.9087 |    28.2 |
| P2/s=16 |  32 |    33.31 |    1.068 |    31.2 |
| P4/s=3  |  12 |     5.24 |   0.4181 |    12.5 |
| P4/s=4  |  16 |    8.868 |   0.5585 |    15.9 |
| P4/s=5  |  20 |    13.52 |   0.6957 |    19.4 |
| P4/s=6  |  24 |    19.11 |   0.8136 |    23.5 |
| P4/s=7  |  28 |    25.66 |   0.9621 |    26.7 |
| P4/s=8  |  32 |    33.19 |    1.099 |    30.2 |
| P4/s=10 |  40 |    51.22 |    1.422 |      36 |
| P4/s=12 |  48 |    73.33 |    1.685 |    43.5 |
| P4/s=14 |  56 |    98.72 |    1.991 |    49.6 |
| P4/s=16 |  64 |    128.2 |    2.229 |    57.5 |
| P8/s=3  |  24 |    19.13 |   0.8557 |    22.4 |
| P8/s=4  |  32 |     33.3 |    1.169 |    28.5 |
| P8/s=5  |  40 |    51.24 |    1.463 |      35 |
| P8/s=6  |  48 |    73.18 |    1.759 |    41.6 |
| P8/s=7  |  56 |    99.08 |    2.141 |    46.3 |
| P8/s=8  |  64 |    128.4 |    2.389 |    53.8 |
| K2/s=3  |  24 |    18.92 |   0.8605 |      22 |
| K2/s=4  |  32 |    32.97 |    1.096 |    30.1 |
| K2/s=5  |  40 |    50.73 |    1.384 |    36.7 |
| K2/s=6  |  48 |     72.4 |    1.664 |    43.5 |
| K2/s=7  |  56 |    97.36 |    1.995 |    48.8 |
| K2/s=8  |  64 |    126.7 |    2.208 |    57.4 |
| K4/s=3  |  48 |    71.66 |    1.671 |    42.9 |
| K4/s=4  |  64 |    126.4 |    2.326 |    54.4 |

The speedup grows with L in every series: from 7.7× at the smallest P2 cell to 53.8-57.5× at the 64-leaf cells.

### Fitted slopes and per-fit estimates

Per-fit estimate t̂ = exp(max(U, G)) at L\* (64, 128 and 256 for P2, P4 and P8; 128 for K2), per path, before the factor k.

| Series | Kind   | Rep | Slope old | Slope new | Estimate old (ms) | Estimate new (ms) | Estimate old/new |
| ------ | ------ | --: | --------: | --------: | ----------------: | ----------------: | ---------------: |
| P2     | median |   0 |     1.856 |     1.025 |             127.6 |             2.721 |             46.9 |
| P2     | p95    |   0 |     1.841 |     1.091 |             152.9 |             4.105 |             37.2 |
| P2     | median |   1 |     1.863 |     1.023 |             125.7 |             2.133 |             58.9 |
| P2     | p95    |   1 |     1.866 |     1.031 |             135.7 |             2.463 |             55.1 |
| P2     | median |   2 |     1.862 |     1.029 |             124.6 |             2.367 |             52.7 |
| P2     | p95    |   2 |     1.736 |     1.056 |             149.8 |             3.325 |               45 |
| P2     | median |   3 |     1.864 |     1.032 |             124.3 |             2.237 |             55.6 |
| P2     | p95    |   3 |     1.888 |     0.978 |             138.9 |             2.896 |               48 |
| P2     | median |   4 |     1.843 |     1.010 |               124 |             2.904 |             42.7 |
| P2     | p95    |   4 |     1.851 |     1.006 |             151.4 |             4.034 |             37.5 |
| P4     | median |   0 |     1.914 |     1.014 |             500.2 |             5.236 |             95.5 |
| P4     | p95    |   0 |     1.927 |     0.994 |             542.4 |             7.466 |             72.6 |
| P4     | median |   1 |     1.916 |     1.020 |               497 |             4.603 |              108 |
| P4     | p95    |   1 |     1.926 |     1.017 |             545.5 |             5.293 |              103 |
| P4     | median |   2 |     1.904 |     1.005 |               495 |             4.779 |              104 |
| P4     | p95    |   2 |     1.880 |     0.910 |               535 |             6.018 |             88.9 |
| P4     | median |   3 |     1.904 |     1.003 |             496.7 |             4.726 |              105 |
| P4     | p95    |   3 |     1.838 |     1.038 |             629.2 |             5.997 |              105 |
| P4     | median |   4 |     1.911 |     1.016 |             494.6 |             6.693 |             73.9 |
| P4     | p95    |   4 |     1.810 |     1.000 |             556.8 |             11.17 |             49.8 |
| P8     | median |   0 |     1.949 |     0.953 |             1,935 |             15.55 |              124 |
| P8     | p95    |   0 |     1.923 |     0.856 |             2,125 |             28.36 |             74.9 |
| P8     | median |   1 |     1.947 |     1.049 |             1,960 |             10.66 |              184 |
| P8     | p95    |   1 |     1.947 |     1.044 |             2,252 |             14.14 |              159 |
| P8     | median |   2 |     1.943 |     1.068 |             1,943 |             12.35 |              157 |
| P8     | p95    |   2 |     1.968 |     1.160 |             2,230 |              26.3 |             84.8 |
| P8     | median |   3 |     1.940 |     1.051 |             1,925 |              12.8 |              150 |
| P8     | p95    |   3 |     1.920 |     1.202 |             2,151 |             25.89 |             83.1 |
| P8     | median |   4 |     1.914 |     1.137 |             1,922 |             20.71 |             92.8 |
| P8     | p95    |   4 |     1.905 |     1.284 |             1,988 |             61.02 |             32.6 |
| K2     | median |   0 |     1.934 |     0.820 |             505.4 |             4.798 |              105 |
| K2     | p95    |   0 |     1.882 |     0.938 |             487.9 |              8.22 |             59.4 |
| K2     | median |   1 |     1.940 |     1.000 |             492.1 |             4.528 |              109 |
| K2     | p95    |   1 |     1.926 |     0.974 |             539.5 |             5.463 |             98.7 |
| K2     | median |   2 |     1.938 |     1.002 |             489.1 |             4.768 |              103 |
| K2     | p95    |   2 |     1.901 |     0.935 |             526.7 |             6.604 |             79.7 |
| K2     | median |   3 |     1.942 |     0.995 |             490.4 |             4.865 |              101 |
| K2     | p95    |   3 |     1.958 |     0.980 |             530.4 |             5.743 |             92.4 |
| K2     | median |   4 |     1.931 |     1.110 |             488.1 |             6.593 |               74 |
| K2     | p95    |   4 |     1.883 |     1.318 |               531 |             15.36 |             34.6 |

The fitted slopes fell: median fits from 1.84-1.95 to 0.82-1.14, and p95 fits from 1.74-1.97 to 0.86-1.32.

### Stage split

Diagnostic run, largest admitted cell of each primary series, ms per 10-path batch.

| Series | Cell    | Stage        | Old (ms) | New (ms) | Old/new |
| ------ | ------- | ------------ | -------: | -------: | ------: |
| P2     | P2/s=16 | flatten      |   0.0533 |   0.0578 |   0.922 |
| P2     | P2/s=16 | topology     |    334.2 |    7.481 |    44.7 |
| P2     | P2/s=16 | tessellation |    31.33 |    2.945 |    10.6 |
| P2     | P2/s=16 | total        |    365.6 |    10.48 |    34.9 |
| P4     | P4/s=16 | flatten      |   0.0959 |    0.092 |    1.04 |
| P4     | P4/s=16 | topology     |    1,313 |    16.79 |    78.2 |
| P4     | P4/s=16 | tessellation |    84.63 |    6.778 |    12.5 |
| P4     | P4/s=16 | total        |    1,397 |    23.66 |    59.1 |
| P8     | P8/s=8  | flatten      |    0.083 |   0.0813 |    1.02 |
| P8     | P8/s=8  | topology     |    1,305 |    18.06 |    72.3 |
| P8     | P8/s=8  | tessellation |    97.78 |    6.916 |    14.1 |
| P8     | P8/s=8  | total        |    1,403 |    25.06 |      56 |

The topology share fell from 91-94% to 71-72%. H1 is in the [H1 section](#h1-exact-arithmetic-hypothesis), with its caveat.

## Why check 2 failed

These are facts from the record; this section chooses no remedy.

**What the check measures.** For each primary fit (series P2, P4 and P8; each repetition; both the per-path median and the per-path p95 kind, as `analyze` builds them), the prediction factor is exp(U − ŷ(x\*)) = exp(t · s_e · √(1 + 1/n + (x\* − x̄)² / S_xx)). Here t is the one-sided Student-t quantile for n − 2 degrees of freedom and s_e is the residual standard error of the log-log fit. The leaf values, n and L\* are the same in both records, so the factor depends on the measurement only through s_e. The slope does not enter it.

| Series | n   | L\*     | t        | √(…)  | Factor         | Limit 2 holds when |
| ------ | --- | ------- | -------- | ----- | -------------- | ------------------ |
| P2, P4 | 10  | 64, 128 | 1.859548 | 1.370 | exp(2.547 s_e) | s_e ≤ 0.272        |
| P8     | 6   | 256     | 2.131847 | 2.469 | exp(5.264 s_e) | s_e ≤ 0.132        |

P8 has the fewest points (L = 24-64) and the farthest target (L\* = 256, a factor of 4), so it tolerates less than half the residual scatter of P2 and P4.

**Which fits fail.** Two of the 30 primary fits exceed 2, both P8 p95 fits:

| Fit                 | s_e   | Factor | Slope |
| ------------------- | ----- | ------ | ----- |
| P8 p95 repetition 4 | 0.224 | 3.248  | 1.284 |
| P8 p95 repetition 0 | 0.222 | 3.215  | 0.856 |

The next largest is P4 p95 repetition 4, 1.961 (s_e 0.264). Every median fit passes; the largest median factor is 1.742 (P8, repetition 0). In the first record the P8 p95 fits had s_e 0.010-0.024 and factors 1.051-1.135. In this record the P8 p95 fit of repetition 1 has s_e 0.052 and factor 1.312.

**Where the scatter comes from.** The p95 kind uses, per cell, the nearest-rank p95 of the 200 individually timed paths (20 batches of 10). That is the 190th smallest sample, so 11 or more elevated samples in a cell lift it.

- **Repetition 4.** The P8 p95 points at L = 24, 32, 40, 48, 56 and 64 are 0.947, 1.160, 1.570, 2.486, 3.602 and 2.437 ms. The L = 56 point lies above the L = 64 point, by a factor of 1.48, and their log residuals are +0.299 and −0.263. In P8/s=7 (L = 56), 34 of the 200 individual samples exceed 1.25 times the cell's individual-path median of 2.414 ms; they fall in 13 of the 20 batches, and the maximum is 6.737 ms. The cell's batch median was also elevated: 2.579 ms per path, against 2.045-2.147 ms in repetitions 0-3. P8/s=8 (L = 64) in the same repetition has no sample above 1.25 times its median, and its p95, 2.437 ms, is 1.04 times its median.
- **Repetition 0.** The points are 0.913, 2.071, 2.005, 1.867, 2.292 and 2.623 ms, so L = 32 and L = 40 lie above L = 48. The largest residuals are +0.330 at L = 32 and −0.243 at L = 24. P8/s=4 (L = 32) has 17 samples above 1.25 times its median, in six batches between 11 and 17 (11 and 13-17), with a maximum of 5.277 ms; its p95 of 2.071 ms compares with 1.160-1.294 ms for the same cell in repetitions 1-4, and its batch median of 1.473 ms per path with 1.124-1.190 ms. P8/s=5 (L = 40) has 27 such samples.
- **Repetition 4, linearity.** The P4/s=16 linearity per-path median at 10 paths was 2.801 ms, against 2.236-2.331 ms in repetitions 0-3.

**Why the same mechanism did not fail the first record.** The P8 per-path times are now 0.86-2.39 ms instead of 19.1-128.4 ms, 22-54 times smaller. A delay of a given absolute size is therefore 22-54 times larger relative to the sample, and the fit works on logarithms. The record does not identify the source of the elevated samples; the run had no CPU-load sampling, by the user's standing instruction.

## Context: the estimates against the budgets

This is a fact, not a verdict. The runner's verdict is INCONCLUSIVE and stands. The estimates the runner computed from this record exceed the budgets: T̂ = 41,419.3 ms is about 41 times B_init = 1,000 ms, and t̂_edit = 122.048 ms about 31 times B_edit = 4 ms. M̂ = 15.41 MiB is within B_mem = 64 MiB.

## Scope of this verdict

As the contract requires for every verdict:

- It covers simple, disjoint, snapped contours at zoom 1 and densities of 2-8 leaves per cubic, at e = 8.
- It does not cover the roadmap's 1%-6400% zoom range, generic-coordinate input (see O1) or crossings of any kind (see O2). Crossing cost is not measured by B0.
- Extrapolating beyond the data assumes no new cost regime between the largest admitted L and L\*; the curvature guard limits, but does not remove, that risk.
- It is provisional on native measurement until B0-W replaces k with a measured ratio. If that changes the verdict, the new verdict goes to the user.

## Limits of this record

- It measures the private kernel's native fill on one CPU, single thread, in a test-harness release build. It says nothing about browser, WASM or GPU cost, the V3c fringe builder, or edit latency beyond the stated proxy.
- It is one run. It does not show whether the elevated samples in repetitions 0 and 4 recur.
- Background load is an operator statement plus a process listing 27 s before the start, with no CPU-load sampling.
- The H1 values measure the residual exact share after B0R and are not comparable with the first record's.
- It closes no A01-A08 criterion. Acting on the verdict needs the independent evidence review. Under the B0 contract's decision rule and user decision B0-Q3, an INCONCLUSIVE verdict goes to the user as an architecture decision before B1, as INFEASIBLE does; B0R chooses no further remedy.
