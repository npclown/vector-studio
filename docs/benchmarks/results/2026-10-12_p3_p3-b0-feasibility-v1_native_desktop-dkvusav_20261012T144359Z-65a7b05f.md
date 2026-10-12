# P3 B0 feasibility, reference run 20261012T144359Z-65a7b05f

Status: Exploratory until the independent evidence review in the [execution plan](../../plans/p3-fill-stroke-meshes.md) accepts it. This record is an immutable observation; corrections append a review record.

**Verdict (computed by the runner from the raw samples): INFEASIBLE, provisional at k = 2 until B0-W replaces k with a measured ratio.** All eight validity checks pass, so the verdict is decided by the estimates against the budgets, not by a measurement failure. Its scope is limited; see [Scope of this verdict](#scope-of-this-verdict).

## Scenario and contract

- Scenario `p3-b0-feasibility` v1, configuration hash `a10c98e9c732929b2752a7349486cbd95e31cc02018d3c703011543483d29271`.
- Contract: [frozen B0 contract](../../plans/p3-b0-feasibility-benchmark-contract.md). Runner `p3-b0-runner/1`, profile `reference`.
- Raw record: [`.json` beside this file](2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.json). `validateRecord` (`tests/geometry/p3-b0/analysis.ts`) recomputes aggregates, fits, estimates, checks and the verdict from its raw samples and accepts it.

## Environment

| Item       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Machine    | DESKTOP-DKVUSAV, the reference machine per the prototype plan's accepted constraint 2                                                                                                                                                                                                                                                                                                                                                            |
| CPU, RAM   | AMD Ryzen 7 3700X, 16 logical cores, 34,291,060,736 bytes (31.94 GiB)                                                                                                                                                                                                                                                                                                                                                                            |
| OS         | Windows 11 Pro 10.0.26200, x64, timezone Asia/Seoul                                                                                                                                                                                                                                                                                                                                                                                              |
| Toolchain  | rustc 1.94.1 (e408947bf 2026-03-25), x86_64-pc-windows-msvc, LLVM 21.1.8; Node 24.15.0                                                                                                                                                                                                                                                                                                                                                           |
| Source     | Commit `34ae06ded83635176d89ea711efbc3f55948cebd`, clean tree                                                                                                                                                                                                                                                                                                                                                                                    |
| Power      | AC online, no battery, Windows plan Balanced. Source: Primary-session observation before the run (`SystemInformation.PowerStatus`, `powercfg /getactivescheme`)                                                                                                                                                                                                                                                                                  |
| Background | Operator statement, not observed: the operator replied "시작해" in chat to a request to stop heavy work (video, recording, builds) during the run. Observed: a Primary process listing at 14:43:38Z, 21 s before the start, showed no node, cargo or rustc process of this project, only three idle third-party node helpers; the session ran no concurrent build, test or agent work. No CPU-load sampling, per the user's standing instruction |
| Start      | 2026-10-12T14:43:59.564Z; five decision repetitions and the diagnostic run completed by about 15:33Z                                                                                                                                                                                                                                                                                                                                             |

## Validity checks

| Check                               | Pass | Detail                                                    |
| ----------------------------------- | ---- | --------------------------------------------------------- |
| 5b-admission-and-topology-identical | yes  | 5 repetitions compared; first admission hash 2ea479cdae7a |
| 1-admitted-P2                       | yes  | 10 admitted; largest P2/s=16                              |
| 1-admitted-P4                       | yes  | 10 admitted; largest P4/s=16                              |
| 1-admitted-P8                       | yes  | 6 admitted; largest P8/s=8                                |
| 2-prediction-factor                 | yes  | max factor 1.375                                          |
| 3-no-unverified-primary-cell        | yes  | none                                                      |
| 4-linearity                         | yes  | ratios 1.006 to 1.010 over the five repetitions           |
| 5-checksums-identical               | yes  | all equal                                                 |
| 6-flat-commands                     | yes  | L + 2C on every path                                      |
| 7-repetitions-complete              | yes  | 5 of 5, no failed process                                 |
| 8-metadata-complete                 | yes  | complete                                                  |

Every timed batch was allocation-free.

## Estimates against the budgets (k = 2)

| Quantity                    | Estimate     | Budget   | Ratio            |
| --------------------------- | ------------ | -------- | ---------------- |
| Initial build               | 3,920,405 ms | 1,000 ms | about 3920× over |
| Edit proxy (p95)            | 4,503.5 ms   | 4 ms     | about 1126× over |
| Mesh memory                 | 15.41 MiB    | 64 MiB   | within           |
| Per path (supporting value) | 1,960.2 ms   | —        | —                |

Fitted log-log slopes of the per-path median against leaves, over the five repetitions: P2 1.84-1.86, P4 1.90-1.92, P8 1.91-1.95 and K2 1.93-1.94. The binding estimate comes from the P8 series (repetition 1, slope 1.947). Contour sensitivity at equal total cubics: K2 against P4 0.987-0.994, K4 against P4 0.977 and 0.986, so splitting cubics across contours barely changes cost.

## Measured drivers

Stage split from the diagnostic run at the largest cells, in ms per 10-path batch (S1 flatten and leaf partitions, S2 topology certificate, S3 tessellation):

| Cell    | Flatten | Topology | Tessellation |  Total | Topology share |
| ------- | ------: | -------: | -----------: | -----: | -------------: |
| P2/s=16 |   0.053 |    334.2 |         31.3 |  365.6 |            91% |
| P4/s=16 |   0.096 |   1312.7 |         84.6 | 1397.4 |            94% |
| P8/s=8  |   0.083 |   1305.1 |         97.8 | 1402.9 |            93% |

The topology certificate dominates.

## H1 (exact-arithmetic hypothesis)

| Series | Cell    | Exact share | Overhead | Verdict   |
| ------ | ------- | ----------- | -------- | --------- |
| P2     | P2/s=16 | 0.875       | 1.098    | Supported |
| P4     | P4/s=16 | 0.873       | 1.090    | Supported |
| P8     | P8/s=8  | 0.872       | 1.092    | Supported |

The estimated exact share (top-level call counts times replayed unit costs, over the S3 median, as the contract defines it) is about 0.87 at the largest cells. The baseline-corrected share, reported but not used in the verdict, is 0.840-0.842.

## Observations (not in the decision)

- **O1, unsnapped coordinates.** Almost every generic-coordinate path fails `Topology(KnotMismatch)`; for example O1/P2 cells admit 0 to 4 of 30 paths. P4/s=16 and P8/s=8 also show 8 `OwnerLimit` failures each.
- **O2, crossing stars.** Every path of every X cell fails `Topology(Unresolved)`, as the contract predicted: the transverse arrangement accepts one crossing partner per leaf.

## Scope of this verdict

As the contract requires for every verdict:

- It covers simple, disjoint, snapped contours at zoom 1 and densities of 2-8 leaves per cubic, at e = 8.
- It does not cover the roadmap's 1%-6400% zoom range, generic-coordinate input (see O1) or crossings of any kind (see O2). Crossing cost is not measured by B0.
- Extrapolating beyond the data assumes no new cost regime between the largest admitted L and L*; the curvature guard limits, but does not remove, that risk.
- It is provisional on native measurement until B0-W replaces k with a measured ratio. If that changes the verdict, the new verdict goes to the user.

## Limits of this record

- It measures the private kernel's native fill on one CPU, single thread, in a test-harness release build. It says nothing about browser, WASM or GPU cost, the V3c fringe builder, or edit latency beyond the stated proxy.
- It closes no A01-A08 criterion. Acting on the verdict needs the independent evidence review. Under the contract's decision rule, an INFEASIBLE verdict goes to the user as an architecture decision before B1; B0 reports the drivers it measured, the H1 verdict and contour sensitivity, and chooses no remedy.
