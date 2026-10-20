# P3 Alt-A1 AL-S2 B0-W reference run 20261020T050227Z-f86bda54

Status: Exploratory until the independent evidence review (AL-A15) in the [execution plan](../../plans/p3-fill-stroke-meshes.md#alt-a1-al-u7-reference-runs) accepts it. This record is an immutable observation; corrections append a review record.

**Product verdict (computed by the runner and recomputed by the validator): INCONCLUSIVE, because an AL-S1 check fails.** The linked [AL-S1 record](2026-10-20_p3_p3-fill-ladder-v1_native_desktop-dkvusav_20261020T044849Z-ed356d28.md) fails its check 2 (prediction factor 3.874 > 2). All ten AL-S2 validity items pass and every browser checksum equals the native one, so the run has a verdict. Under the [contract's section 5.3](../../plans/p3-alt-a1-fill-ladder-contract.md#53-c-product-stage-verification-scenario-al-s1-and-the-verdict), any failed AL-S1 check makes the product verdict INCONCLUSIVE whatever the estimates are. Its scope is limited; see [Scope of this verdict](#scope-of-this-verdict).

**Measured factor: k̂ = 1.579**, browser port time over native export time in the test-harness build (Edge, P2/s=16). The report-only one-path factor is **k̂₁ = 1.615** (Chrome, P2/s=16, one path); it does not enter the verdict.

This run is the AL-S2 half of unit AL-U7 of the [Alt-A1 production contract](../../plans/p3-alt-a1-fill-ladder-contract.md#61-units): B0-W, [section 5.2](../../plans/p3-alt-a1-fill-ladder-contract.md#52-b-b0-w-the-wasmnative-ratio). It measures the production operation `'geometry-wasm/fill-v0+r2'` as the release WASM through the V2 adapter `createFillMeshPort` in headed Chrome and Edge, and the same cells through the AL-S1 harness's native ratio mode in the same runner session, and forms the ratio that replaces B0's provisional k = 2.

## Scenario and contract

- Scenario `p3-b0-wasm` v1, profile `reference`, runner `p3-b0-wasm-runner/1`, schema version 1.
- Configuration hash `f337d0efb6c457118c624dacc9bcd6a9946f2c495437282c987f20be884c2bfd`, equal to the reference hash recorded in the plan when AL-U6 merged. The embedded native ratio-mode configuration hashes to `ff36ec78a920d704df431cf411f9c064bf1d3a0cb21523c83857a6bdad9ef9c3`, equal to the hash AL-U5 recorded. Corpus SHA-256 `206cf6e9971d5f38f11cbef801692555843b1602ee937c5e1b60ed7dbd329796` (580,965 bytes).
- Contract: [frozen Alt-A1 production contract](../../plans/p3-alt-a1-fill-ladder-contract.md), sections 5.2 and 5.3; the decision rule is [B0's](../../plans/p3-b0-feasibility-benchmark-contract.md#5-extrapolation-and-the-feasibility-decision), unchanged, with k = k̂.
- Raw record: [`.json` beside this file](2026-10-20_p3_p3-b0-wasm-v1_chrome-edge_desktop-dkvusav_20261020T050227Z-f86bda54.json), a byte-for-byte copy of the runner's `record.json` (1,293,761 bytes, SHA-256 `b2cc24179b792f6c1754cae70f88b8ee112b22f7a4cffae5089bf014ad6799c3`). The file name uses `chrome-edge` in the browser position of the [README's naming](../README.md#directory-layout), because the run covers both browsers (the native leg is part of the same record). `validateWasmRecord(record, alS1Bytes)` (`tests/geometry/p3-b0-wasm/analysis.ts`), given the committed AL-S1 bytes, checks the schema and scenario identity, the configuration hash and that the configuration equals `scenarioConfig('reference')`, the corpus hash, the native configuration against the embedded ratio mode and its hash, the SHA-256 of the AL-S1 bytes, re-validates them with `validateLadderRecord`, rebuilds the AL-S1 link and recomputes the stored analysis, including k̂, k̂₁, the validity items and the product verdict. It accepts the committed file.
- **AL-S1 link.** `alS1.path` is the committed AL-S1 `.json`, SHA-256 `c394cca2…355c`, run `20261020T044849Z-ed356d28`, profile `reference`, configuration hash `8f07f146…672e`. Kernel-source hash (`kernelSourceSha256`, the canonical JSON of the manifest entries under `packages/geometry-wasm/kernel/src/` plus the kernel `Cargo.toml` and `Cargo.lock`) `287e0f0e2b1c32c21eda48d59978bbfec150d7c152c89e301c1ffeeac5c2f1b2` in both records, so `al-s1-same-kernel` passes.
- Command: `pnpm benchmark:p3-b0-wasm --profile reference --environment-json <scratchpad>/al-u7-env.json`, with no `--al-s1` argument: the runner linked the only tracked AL-S1 reference record of this kernel.
- Uncommitted artifacts in `artifacts/p3-b0-wasm/20261020T050227Z-f86bda54/`: `raw-record.json` (SHA-256 `e9638e19…a358`), `summary.md`, the native leg's `ratio-0.json` to `ratio-4.json` with logs, the ten browser captures `browser-chrome-r0.json` to `browser-edge-r4.json`, `browser-options.json`, the page build under `build/`, `corpus.bin`, `ratio-corpus.bin`, `process-listing.txt`, `invocation.json` and the build and browser logs.

## Environment

| Item       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine    | DESKTOP-DKVUSAV, the reference machine per the prototype plan's accepted constraint 2, the same machine as the AL-S1 run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| CPU, RAM   | AMD Ryzen 7 3700X, 16 logical cores, 34,291,060,736 bytes (31.94 GiB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| OS         | Windows 11 Pro 10.0.26200, x64, timezone Asia/Seoul                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Toolchain  | rustc 1.94.1 (e408947bf 2026-03-25), x86_64-pc-windows-msvc host; Node 24.15.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| WASM build | `cargo build --locked --offline --release --target wasm32-unknown-unknown` (release: opt-level 3, LTO, one codegen unit, panic abort, strip), rustflags `--remap-path-prefix D:\GIT\vector-studio=.`. SHA-256 `f13fb345ec14d0857da7c63917f1ad5376315c8154fb31e914e9855a5e5c6127`, 341,343 bytes, verified in every page; the same SHA-256 as AL-U6's functional runs on the same kernel                                                                                                                                                                                                                                                              |
| Page build | Production build mode, `vite build --config tests/geometry-benchmark/p3-b0-wasm/vite.config.ts`, four files, SHA-256 `07e3db6b…5d1d`, served cross-origin isolated (COOP/COEP)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Native leg | `p3_fill_ladder_bench::run_ladder_ratio`, the AL-S1 harness's ratio mode, built as AL-S1's harness is (`cargo test --release --lib --locked --offline`, target directory `.tools\geometry-build`, the same rustflags; this record does not repeat AL-S1's known-overhead list), five fresh processes, kernel revision 2 in each, clock quantum 100 ns in each, no failure                                                                                                                                                                                                                                                                            |
| Browsers   | Chrome stable 155.0.8059.80 (channel `chrome`), then Edge stable 155.0.4283.62 (channel `msedge`), as Playwright's `browser.version()` reports them; headed; one worker; a fresh page per repetition; no DevTools, tracing or video. Each record keeps its 46 launch flags (Playwright's defaults plus `--enable-automation`, which `Browser.getBrowserCommandLine` needs). The pages' `navigator.userAgent` strings read `Chrome/151.0.7922.34` (and `Edg/151.0.7922.34`), which differ from the reported versions; the analysis does not use them                                                                                                  |
| Display    | Viewport 1280 × 720 CSS px, device-pixel ratio 1, screen 1280 × 720, in every repetition. Every page was `visible` at start and end with no visibility event, and reported `crossOriginIsolated` true. Browser clock quantum 0.005 ms in every repetition. GPU: not applicable (no GPU work)                                                                                                                                                                                                                                                                                                                                                         |
| Source     | Commit `65900836348585c09d302eaebb4dc40575e76ad6` on branch `claude/p3-alt-a1-u7-reference-runs`, clean tree as the runner recorded it (`dirty: false`, no dirty files). It is `main` `e2cf5b7` plus one commit that adds the AL-S1 record `.json` and its `.prettierignore` line, and no source file, so the AL-S1 record was tracked when this run linked it. The 88 source-manifest SHA-256 values equal those of the files at `6590083`. The untracked, machine-local `.claude/launch.json` was moved out of the worktree for the run, because the reference profile requires a clean worktree, and restored afterwards; it is not a source file |
| Power      | AC online, no system battery, Windows plan Balanced. Source: Primary-session observation immediately before the AL-S1 run, the same environment file for both runs (`observedAt` 2026-10-20T13:48:31+09:00)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Background | Operator statement, not observed: the operator answered "지금 시작 (Recommended)" in chat to the readiness question that asked for heavy work (video playback, screen recording, builds) to stop and the PC to be left unused during the runs. Observed: the Primary process listing at 04:48:31Z, before the AL-S1 run, and the runner's own listing for this run (`tasklist.exe /fo csv /nh`, 353 processes, SHA-256 `8e4e6857…ec8`) at 05:02:27.755Z, just before the start. The session ran no concurrent build, test or agent work. No CPU-load sampling, per the user's standing instruction                                                   |
| Start      | `utcStart` 2026-10-20T05:02:28.332Z; `utcEnd` 05:16:02.277Z, a record span of 13 min 34 s. The shell timed the whole command at 13 min 36 s. The builds and the native leg ran before 05:05:37.8Z; the five Chrome repetitions ran 05:05:37.8Z-05:11:04.7Z and the five Edge repetitions 05:11:06.1Z-05:16:01.7Z, 59-67 s each                                                                                                                                                                                                                                                                                                                       |

## Validity items

Section 5.2's items, all required. A checksum mismatch between browser and native would give no verdict (`INVALID`); any other failed item would make the product verdict INCONCLUSIVE. None failed.

| Item                     | Pass | Detail                                                                                                              |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------- |
| repetitions-complete     | yes  | complete: 5 native and 5 + 5 browser repetitions, every cell's checksums present                                    |
| checksums-equal-native   | yes  | every browser checksum equals the native checksum, on all 34 cells and 3 one-path cells, in both                    |
| largest-primary-verified | yes  | no largest primary cell is UNVERIFIED                                                                               |
| no-reserve-or-growth     | yes  | none during timing (browser epoch and storage check; native zero allocations, stable storage)                       |
| largest-cells-admitted   | yes  | every path of every largest primary cell is `ok`                                                                    |
| operation-identity       | yes  | identical: page options, WASM and corpus SHA-256, `'geometry-wasm/fill-v0+r2'`, port version 0, B0's shuffle orders |
| native-leg-valid         | yes  | valid (`analyzeRatioNative`)                                                                                        |
| cross-origin-isolated    | yes  | every captured page was cross-origin isolated                                                                       |
| al-s1-same-kernel        | yes  | equal kernel sources (`287e0f0e…f1b2` in both records)                                                              |
| metadata-complete        | yes  | complete: browser fields of every repetition, power and background observations, the AL-S1 link                     |

The browser checksum equality also confirms that the WASM produced the native rung mix bit for bit on every timed cell.

## k̂ and k̂₁

Per cell and repetition, r = browser per-path median / native per-path median, where per path = nearest-rank median timed sample / (R · paths), with R = 100 ten-path calls (R = 1,000 one-path calls on the one-path cells). k_cell is the nearest-rank median of r over the five repetitions. k̂ is the maximum over Chrome and Edge of k_cell at the largest admitted cell of each primary series; k̂₁ is the same at the one-path cells.

| Cell              | Chrome r, repetitions 0-4         | Chrome k_cell | Edge r, repetitions 0-4           | Edge k_cell |
| ----------------- | --------------------------------- | ------------: | --------------------------------- | ----------: |
| P2/s=16           | 1.652, 1.568, 1.566, 1.585, 1.550 |         1.568 | 1.538, 1.574, 1.592, 1.591, 1.579 |   **1.579** |
| P4/s=16           | 1.606, 1.567, 1.568, 1.600, 1.529 |         1.568 | 1.451, 1.557, 1.521, 1.575, 1.555 |       1.555 |
| P8/s=8            | 1.658, 1.570, 1.505, 1.578, 1.544 |         1.570 | 1.525, 1.564, 1.510, 1.587, 1.553 |       1.553 |
| P2/s=16, one path | 1.657, 1.602, 1.615, 1.588, 1.621 |     **1.615** | 1.543, 1.607, 1.610, 1.614, 1.684 |       1.610 |
| P4/s=16, one path | 1.647, 1.560, 1.520, 1.529, 1.502 |         1.529 | 1.530, 1.548, 1.492, 1.542, 1.534 |       1.534 |
| P8/s=8, one path  | 1.598, 1.564, 1.606, 1.560, 1.556 |         1.564 | 1.506, 1.560, 1.550, 1.557, 1.566 |       1.557 |

- **k̂ = 1.579**, from Edge at P2/s=16; Chrome's maximum over the three cells is 1.570 (P8/s=8). The six largest-cell k_cell values lie in 1.553-1.579.
- **k̂₁ = 1.615**, from Chrome at P2/s=16 one path; Edge's maximum is 1.610 (P2/s=16). k̂₁ / k̂ = 1.023.
- Over all 34 decision cells, k_cell lies in 1.546-1.737 in Chrome and 1.516-1.681 in Edge; the largest values are on small P2 cells (Chrome P2/s=4, 1.737; Edge P2/s=6, 1.681).

### Every cell

Per-path medians over the five repetitions, for orientation; k_cell is the median of the per-repetition ratios, not the ratio of these medians.

| Cell              | Native (µs) | Chrome (µs) | Chrome k_cell | Edge (µs) | Edge k_cell |
| ----------------- | ----------: | ----------: | ------------: | --------: | ----------: |
| P2/s=3            |        6.87 |       11.74 |         1.662 |     11.50 |       1.674 |
| P2/s=4            |        8.86 |       15.14 |         1.737 |     14.66 |       1.662 |
| P2/s=5            |       10.92 |       18.40 |         1.693 |     18.15 |       1.648 |
| P2/s=6            |       12.75 |       21.85 |         1.709 |     21.43 |       1.681 |
| P2/s=7            |       15.14 |       24.48 |         1.617 |     23.93 |       1.599 |
| P2/s=8            |       16.90 |       28.22 |         1.672 |     27.60 |       1.633 |
| P2/s=10           |       20.88 |       35.10 |         1.692 |     33.97 |       1.626 |
| P2/s=12           |       25.28 |       40.25 |         1.633 |     40.24 |       1.628 |
| P2/s=14           |       29.36 |       47.17 |         1.617 |     47.23 |       1.592 |
| P2/s=16           |       33.13 |       52.33 |         1.568 |     52.73 |       1.579 |
| P4/s=3            |       13.20 |       21.70 |         1.648 |     21.54 |       1.649 |
| P4/s=4            |       17.33 |       28.21 |         1.624 |     27.83 |       1.606 |
| P4/s=5            |       21.02 |       35.93 |         1.686 |     34.65 |       1.631 |
| P4/s=6            |       25.48 |       41.37 |         1.607 |     39.98 |       1.613 |
| P4/s=7            |       29.59 |       47.68 |         1.613 |     47.20 |       1.597 |
| P4/s=8            |       34.30 |       54.16 |         1.583 |     53.56 |       1.560 |
| P4/s=10           |       43.04 |       67.80 |         1.589 |     67.11 |       1.551 |
| P4/s=12           |       51.66 |       82.47 |         1.613 |     82.23 |       1.595 |
| P4/s=14           |       61.09 |       97.05 |         1.601 |     94.98 |       1.544 |
| P4/s=16           |       71.13 |      111.60 |         1.568 |    108.78 |       1.555 |
| P8/s=3            |       26.24 |       40.98 |         1.546 |     41.12 |       1.562 |
| P8/s=4            |       34.53 |       54.76 |         1.572 |     53.88 |       1.560 |
| P8/s=5            |       43.78 |       68.81 |         1.571 |     67.35 |       1.536 |
| P8/s=6            |       52.43 |       83.25 |         1.588 |     82.19 |       1.586 |
| P8/s=7            |       62.82 |       97.28 |         1.560 |     96.23 |       1.529 |
| P8/s=8            |       70.39 |      110.28 |         1.570 |    109.85 |       1.553 |
| K2/s=3            |       26.23 |       42.55 |         1.642 |     41.88 |       1.598 |
| K2/s=4            |       33.97 |       55.41 |         1.609 |     55.39 |       1.597 |
| K2/s=5            |       43.63 |       69.99 |         1.589 |     68.67 |       1.563 |
| K2/s=6            |       52.23 |       83.48 |         1.596 |     81.19 |       1.553 |
| K2/s=7            |       61.33 |       96.73 |         1.598 |     94.83 |       1.547 |
| K2/s=8            |       69.29 |      109.12 |         1.574 |    107.61 |       1.516 |
| K4/s=3            |       55.80 |       86.24 |         1.552 |     86.99 |       1.548 |
| K4/s=4            |       73.48 |      115.32 |         1.576 |    113.58 |       1.550 |
| P2/s=16, one path |       32.68 |       52.66 |         1.615 |     52.82 |       1.610 |
| P4/s=16, one path |       68.81 |      105.97 |         1.529 |    105.16 |       1.534 |
| P8/s=8, one path  |       68.20 |      106.93 |         1.564 |    105.63 |       1.557 |

**Native leg against AL-S1.** The native leg's per-path medians at the three largest cells (33.13, 71.13 and 70.39 µs) are 1.051, 1.058 and 1.049 times AL-S1's batch medians at the same cells (31.53, 67.26 and 67.10 µs), on the same kernel. The windows differ: the ratio mode times 100 consecutive calls with the decoded fold after each, while AL-S1 times one call per sample followed by the fold of its output bytes.

## Estimates against the budgets (k = k̂)

Computed by `productVerdict` from the AL-S1 analysis's k-free t̂ and t̂_p95 and its M̂, under B0's rule with one factor for both time estimates. They do not decide this verdict (see [Context](#context-the-estimates-against-the-budgets)).

| Quantity                                         | Estimate   | Budget   | Ratio to budget |
| ------------------------------------------------ | ---------- | -------- | --------------: |
| Initial build T̂ = 1,000 · t̂ · k̂                  | 1,031.1 ms | 1,000 ms |           1.031 |
| Edit proxy t̂_edit = t̂_p95 · k̂                    | 4.367 ms   | 4 ms     |           1.092 |
| Mesh memory M̂ (from AL-S1)                       | 6.81 MiB   | 64 MiB   |           0.106 |
| Context only: t̂_p95 · k̂₁ (one-path, report-only) | 4.467 ms   | —        |               — |

With t̂ = 0.6529 ms and t̂_p95 = 2.7656 ms from AL-S1's binding fits (P8 median and P8 p95 of repetition 0). k̂ ≈ 1.58 replaces k = 2, so both time estimates are 0.790 times AL-S1's provisional ones (1,305.9 ms and 5.531 ms). M̂ does not depend on the platform; the checksum equality makes the browser meshes the same meshes.

**Memory observation, not a decision input.** `linearMemoryBytes()` after the run is 2,293,760 bytes in each browser, 0.85% of BC19's 256 MB ceiling (268,435,456 bytes), in every repetition.

## Why check 2 failed

These are facts from the AL-S1 record; this section chooses no remedy. The full analysis from the raw samples, cell by cell, is in the [AL-S1 record](2026-10-20_p3_p3-fill-ladder-v1_native_desktop-dkvusav_20261020T044849Z-ed356d28.md#why-check-2-failed).

- **Which check.** AL-S1's check 2, the prediction factor of the primary fits, limit 2. None of this record's browser or native-leg samples enters it.
- **Which fits.** Four of AL-S1's 30 primary fits exceed 2, all P8 p95 fits (series P8, kind p95 of individually timed one-path calls): repetition 4 (factor 3.874, s_e 0.257), repetition 0 (3.582, s_e 0.242), repetition 2 (2.837, s_e 0.198) and repetition 3 (2.392, s_e 0.166). For P8 (n = 6, L\* = 256) the factor is exp(5.264 s_e), so the limit holds only for s_e ≤ 0.132. Every median fit passes.
- **Mechanism.** In each failing fit one cell's individual path times rise to a higher level, about 1.2-1.27 times the lower one, for part of the cell, while the same cell stays at the lower level in other repetitions: P8/s=4 in repetitions 4 and 3, P8/s=7 in repetition 0 and P8/s=5 in repetition 2. Because the p95 point is the 190th of 200 samples, 11 or more elevated samples lift it; the outlying point's log residual is +0.245 to +0.414.
- **Effect on the estimates used here.** The P8 p95 fit of repetition 0, which binds t̂_p95 and so t̂_edit at k̂, is one of the four failing fits; the P8 median fit of repetition 0, which binds t̂ and so T̂ at k̂, passes (factor 1.765) but has the same elevated P8/s=7 point.
- **Relation to the earlier records.** The same series and kind failed check 2 in the 2026-10-17 B0 record (max 3.248) and the spike record (max 2.610), each with two failing fits.

## Comparison with the 2026-10-17 B0 and 2026-10-18 spike records

Neither earlier record measured a factor; both used B0's provisional k = 2. Values come from `analyze()` of the committed records, as in the AL-S1 record. **Ratios are earlier record / this record, so a value above 1 means this record's estimate is smaller.**

**Verdicts:** B0 2026-10-17 INCONCLUSIVE (check 2, provisional at k = 2); spike 2026-10-18 INCONCLUSIVE (check 2, provisional at k = 2); AL-S1 2026-10-20 INCONCLUSIVE (check 2, provisional at k = 2); this product verdict INCONCLUSIVE (AL-S1 check 2, k = k̂ = 1.579).

| Quantity | B0 2026-10-17 (k = 2) | Spike 2026-10-18 (k = 2) | AL-S1 2026-10-20 (k = 2) | AL-S2 (k = k̂) | B0 / AL-S2 | Spike / AL-S2 | AL-S1 / AL-S2 |
| -------- | --------------------: | -----------------------: | -----------------------: | ------------: | ---------: | ------------: | ------------: |
| T̂        |           41,419.3 ms |               1,285.3 ms |               1,305.9 ms |    1,031.1 ms |      40.17 |         1.247 |         1.267 |
| t̂_edit   |            122.048 ms |                 2.491 ms |                 5.531 ms |      4.367 ms |      27.95 |         0.570 |         1.267 |
| M̂        |             15.41 MiB |                 6.81 MiB |                 6.81 MiB |      6.81 MiB |       2.26 |         1.000 |         1.000 |
| Factor   |                 k = 2 |                    k = 2 |                    k = 2 |     k̂ = 1.579 |      1.267 |         1.267 |         1.267 |

The measured k̂ is 0.790 of the k = 2 the earlier records assumed. The spike's t̂_edit is smaller than this record's because AL-S1's binding p95 fit (2.7656 ms per path) is 2.22 times the spike's (1.246 ms), which outweighs the smaller factor.

AL-U6's functional runs of this runner (one repetition each, a busy development machine; not evidence) gave k̂ between 1.569 and 1.794 and k̂₁ between 1.315 and 1.590, as the plan's AL-U6 entry records.

## Context: the estimates against the budgets

This is a fact, not a verdict. The product verdict is INCONCLUSIVE and stands. With k = k̂ the estimates are T̂ = 1,031.1 ms, 1.031 times B_init = 1,000 ms; t̂_edit = 4.367 ms, 1.092 times B_edit = 4 ms; and M̂ = 6.81 MiB, 0.106 of B_mem = 64 MiB. The report-only t̂_p95 · k̂₁ is 4.467 ms, 1.117 times B_edit. As arithmetic on AL-S1's t̂ and t̂_p95, T̂ ≤ 1,000 ms would need a factor of at most 1.532 and t̂_edit ≤ 4 ms a factor of at most 1.446; the contract's section 7 gave 1.556 and 3.21 at the spike's values.

## Scope of this verdict

As the contract requires for every verdict:

- It covers simple, disjoint, snapped contours at zoom 1 and densities of 2-8 leaves per cubic, at e = 8, extrapolated to L\* = 4 times the largest L with the curvature guard's limits, as AL-S1's.
- Product stage: the production export natively, and the release WASM through the V2 adapter in Chrome 155 and Edge 155 on the reference machine.
- It does not cover the zoom range (DF9, AL-OB6), generic coordinates (O1 is an observation), crossings, lower-tier hardware, the fringe builder (DF8), scene application, packing, upload, draw cost or anything else outside the port (contract section 5.5).
- k̂ is browser port time over native export time in the test-harness build: the browser side includes the adapter's validation, packing, copies and checks and the per-call fold, and the native side is the kernel export only. It is not a pure WASM/native code ratio.
- k̂ is measured on ten-path batches. The one-path k̂₁ is 1.023 times k̂ here; the edit proxy t̂_edit uses k̂, as B0's rule has it, and is a lower bound on edit latency.

## Limits of this record

- It is one run per browser on one machine. Its k̂ is the maximum of six k_cell values that lie within 1.553-1.579; it does not show how k̂ varies between runs, browser versions or machines.
- The product estimates inherit every limit of the AL-S1 record, including its failed check 2 and the elevated P8 cells in its binding fits; this record does not re-measure t̂ or t̂_p95.
- The browser leg runs headed with Playwright's launch flags, including `--enable-automation`, `--no-sandbox` and `--enable-unsafe-swiftshader`, which the record keeps. No GPU work is done.
- Background load is an operator statement plus process listings; the Primary listing was taken 14 min before this run's start, before the AL-S1 run, and the runner's listing under 1 s before it. No CPU-load sampling.
- The memory observation is one value per browser after the run; it is not a peak.
- It closes no A01-A08 criterion. Acting on it needs the independent evidence review (AL-A15). Under the contract's section 5.3 and user decision B0-Q3, an INCONCLUSIVE product verdict goes to the user before B1, as INFEASIBLE does, with the measured numbers; B1 stays blocked under AL-Q6. This record chooses no remedy.
