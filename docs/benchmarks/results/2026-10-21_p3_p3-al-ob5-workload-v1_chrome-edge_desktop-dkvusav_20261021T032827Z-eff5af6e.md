# P3 Alt-A1 AL-OB5 OB5-U3 reference run 20261021T032827Z-eff5af6e

Status: Exploratory until the independent evidence review in the [execution plan](../../plans/p3-fill-stroke-meshes.md#alt-a1-al-ob5-ob5-u3-reference-run) accepts it. This record is an immutable observation; corrections append a review record.

**Verdict (computed by the runner and recomputed by `validateOb5Record`): FEASIBLE.** Every validity item passes and T, t_edit and M are within budget: **T = 464.0 ms** against B_init = 1,000 ms (ratio 0.464), **t_edit = 0.740 ms** against B_edit = 4 ms (ratio 0.185) and **M = 7,144,000 bytes** (6.81 MiB) against B_mem = 64 MiB = 67,108,864 bytes (ratio 0.106). All fourteen validity items OB5-V1 to OB5-V14 pass, every browser fold equals the native fold of the same set and order, and every oracle gate passes with a `MESH_CHECK` count of 0. The maximum OB5-SP-init p95 is 502.8 ms, reported beside T. The verdict is for the workload in [Scope of the verdict](#scope-of-the-verdict); this status is pending the evidence review, and the decision then goes to the user under AL-Q6 (a) and [proposal section 4](../../plans/p3-al-ob5-workload-scenario-proposal.md#4-decision-use).

This run is unit OB5-U3 of the [AL-OB5 proposal](../../plans/p3-al-ob5-workload-scenario-proposal.md#6-units): the direct measurement of the 1,000 × 32 workload owed by [Alt-A1 section 5.4](../../plans/p3-alt-a1-fill-ladder-contract.md#54-verifying-the-workload-itself). It measures the production operation `'geometry-wasm/fill-v0+r2'` as the release WASM through the V2 adapter `createFillMeshPort` in headed Chrome and Edge, and the same sets natively in the same runner session. T, t_edit and M are measured values, not extrapolations. The AL-U7 estimates are context only; see [Context](#context-the-al-u7-estimates).

## Scenario and contract

- Scenario `p3-al-ob5-workload` v1, profile `reference`, runner `p3-al-ob5-runner/1`, schema version 1.
- Configuration hash `cb23d4ca9d6c2908597ba3a146234a0d6a5ace4dd0512bff0881a627205ea651`, equal to the reference hash pinned in the plan when OB5-U2 merged. Decision corpus SHA-256 `353fef77a5f7fe9208bdd6566a16477833ea0dc47528dbaca8581a37222acc2f` (4,782,093 bytes, FNV-1a 64 `86afe25bddc0876a`); observation corpus SHA-256 `8c6618bec379f5e1041ef5803913e16208427cbb178c784afa1238580b2596fc` (1,594,040 bytes); oracle input SHA-256 `679a4b773c8839331c1b47a4273aa467d8c7b4df13650afc26d133e78ea9bbed` (4,865,682 bytes).
- Workload: three decision sets of 1,000 simple, single-contour, snapped ring paths of 32 cubics, at λ = 2, 4 and 8 leaves per cubic (OB5-W2, OB5-W4, OB5-W8: 64, 128 and 256 leaves per path), nonzero fill, tolerance exponent −3, from `generateCellPaths` of the B0 corpus generator. Observation set OB5-W8U (the same ring unsnapped) is native and untimed.
- Operation: `geometry-wasm/fill-v0+r2`, revision 2, port version 0. Native: `FillEngine::process` at the production caps, release libtest harness, single thread.
- Sampling: 5 repetitions per browser (Chrome, then Edge) and 5 fresh native processes; set order shuffled per repetition (Fisher-Yates descending, seed 2654435769 + r). Per set: one untimed preparation call, 3 warm-up and 20 timed OB5-SP-init calls (window from before `buildFillMeshes` on the 1,000 requests to after the fold of its last result), and OB5-SP-edit on 1,000 one-path calls after 3 untimed ones (edit order seed 190709760 + r). Fresh page per repetition, 1280 × 720 at DPR 1, headed, no DevTools, tracing or video, one worker, cross-origin isolated.
- Statistics (proposal section 3.4): T is the maximum over browsers, repetitions and sets of the OB5-SP-init median; t_edit is the maximum of the OB5-SP-edit p95; M is the maximum over sets of the summed E2 bytes. Percentiles are nearest-rank.
- Raw record: [`.json` beside this file](2026-10-21_p3_p3-al-ob5-workload-v1_chrome-edge_desktop-dkvusav_20261021T032827Z-eff5af6e.json), a byte-for-byte copy of the runner's `record.json` (4,881,364 bytes, SHA-256 `bd51505849f951bd778eb25a5beec533ba50be263c6ebb887b5773efbafd6db4`). `validateOb5Record` (`tests/geometry/p3-al-ob5/analysis.ts`) accepts the committed file and its stored analysis equals `analyze()` of its raw samples.
- Command: `pnpm benchmark:p3-al-ob5 --profile reference --environment-json <scratchpad>/ob5-u3-env.json`, with `CARGO_HOME` and `RUSTUP_HOME` set to the repository `.tools/rust`.
- Uncommitted artifacts in `artifacts/p3-al-ob5/20261021T032827Z-eff5af6e/`: `raw-record.json` (SHA-256 `25336255e0270a92351dc96e0edd35fc79db4b4467a6eaf16ea194e20609a2f4`), `summary.md`, `oracle.json`, `oracle-dump.txt` (250,055,633 bytes, 3,000 entries, SHA-256 `680a5d7da6181d5350735e6e29a8fc8494fa7f200ea91f80608026c462b9a6e1`), `oracle-input.bin`, `process-listing.txt`, `invocation.json`, the per-process logs and the per-repetition browser and native JSON.

## Environment

| Item       | Value                                                                                                                                                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine    | DESKTOP-DKVUSAV, the reference machine per the prototype plan's accepted constraint 2                                                                                                                                                                                                                                               |
| CPU, RAM   | AMD Ryzen 7 3700X, 16 logical cores, 34,291,060,736 bytes (31.94 GiB)                                                                                                                                                                                                                                                               |
| OS         | Windows 11 Pro 10.0.26200, x64, timezone Asia/Seoul                                                                                                                                                                                                                                                                                 |
| Browsers   | Chrome 155.0.8059.85 (channel `chrome`) and Edge 155.0.4283.62 (channel `msedge`), headed, Playwright launch flags kept in each repetition's capture                                                                                                                                                                                |
| Toolchain  | rustc 1.94.1 (e408947bf 2026-03-25), x86_64-pc-windows-msvc; Node 24.15.0                                                                                                                                                                                                                                                           |
| Source     | `main` commit `4713307457024ac522977ec2a23c83125b0f7e4c` (PR #186; OB5-U2, PR #185, is merged), `dirty: false`, no dirty files. All 119 source-manifest SHA-256 values equal the files at the commit (OB5-V13)                                                                                                                      |
| Power      | AC power online, desktop with no system battery; Windows power plan Balanced (381b4222-f694-41f0-9685-ff5bb260df2e). Source: Primary-session observation immediately before the run: System.Windows.Forms.SystemInformation.PowerStatus (PowerLineStatus Online, BatteryChargeStatus NoSystemBattery) and powercfg /getactivescheme |
| Start, end | `utcStart` 2026-10-21T03:28:28.375Z; `utcEnd` 2026-10-21T05:04:30.839Z, a record span of 1 h 36 min 2 s                                                                                                                                                                                                                             |
| N/A        | GPU: no GPU work is measured. CPU-load sampling: not sampled, per the user's instruction                                                                                                                                                                                                                                            |

### Build identities

| Artifact       | Identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release WASM   | SHA-256 `480cb6336040254fed9bf3be2d620e87fcb723ea981c5b15c1bbb2275f0b2d50` (424,588 bytes), `wasm32-unknown-unknown`, release (opt-level 3, LTO, one codegen unit, panic abort, strip), rustflags `--remap-path-prefix D:\GIT\vector-studio=.`; equal to the WASM recorded for OB5-U2's validation                                                                                                                                                                               |
| Kernel source  | SHA-256 `bffb3a322a432e4fc35eeef0827752961a5b0bd687cba8745108388e5550b2ae`, the same for the WASM and native builds (OB5-V4)                                                                                                                                                                                                                                                                                                                                                     |
| Native harness | `p3_al_ob5_bench::run_ob5_native`, `x86_64-pc-windows-msvc`, libtest harness, release profile (opt-level 3, LTO, one codegen unit), unwind. Known overhead, as the record states: panic=unwind in the test harness; cfg(test) tracking global allocator compiled in, switched on around each timed and warm-up call outside its window; cfg(test) fill_filter::record decided/fallback counters compiled in; cfg(test) ladder fault switches and test hooks compiled in, all off |
| Page           | Vite production build of `tests/geometry-benchmark/p3-al-ob5`; bundle SHA-256 `5abd2194ade80164a80c16b8cc9b09dcea01d9cfa45858e442d4f7d9f97d71f5` (`index.html` `412f88c69659…`, `assets/index-BYceWi2z.js` `58c0ef69e55b…`)                                                                                                                                                                                                                                                      |

### Quiet-machine statement and background disclosure

- **Quiet-machine statement (operator, in chat).** The operator confirmed in chat that the PC is left unused and heavy work is stopped for the run. Source: Chat answer "지금 진행 (PC 비움)" (2026-10-21) to the OB5-U3 readiness question.
- **Observed by the Primary before the run (2026-10-21T03:28:00Z).** No `cargo`, `rustc`, `ffmpeg` or OBS process; no agent of this session running (all subagents finished or stopped). The runner's own listing (`tasklist.exe /fo csv /nh`, 298 processes, SHA-256 `6f53b273…ea23`) was captured at 2026-10-21T03:28:27.804Z, under 1 s before the start.
- **Disclosure, as the AL-A15 disclosure did.** Third-party and interactive processes were present and were not stopped: the user's own Chrome (17 processes), Microsoft Edge WebView2 (26), the Claude desktop app (14), and a third-party `hyperframes preview` tool (`node.exe` plus 4 `chrome-headless-shell` processes, from the npx cache). The narrow claim "no process of this project" holds. The 2026-10-12 protocol minimum (operator statement plus process listings) is met. The load of these processes is not measured and is not excluded as a cause of any level change in a sample.
- No CPU-load sampling was done, per the user's standing instruction.

## Validity items

| Item    | Pass | Detail                                                                                                    |
| ------- | ---- | --------------------------------------------------------------------------------------------------------- |
| OB5-V1  | yes  | every present browser fold equals the native fold of the same set and order                               |
| OB5-V2  | yes  | every call of a set has one fold; every edit equals its path in the batch                                 |
| OB5-V3  | yes  | every path has the expected flat commands, V, T and boundary pairs; M as expected                         |
| OB5-V4  | yes  | operation, revision, port version, hashes, kernel sources and orders as pinned                            |
| OB5-V5  | yes  | every path ok in every call; no batch failure                                                             |
| OB5-V6  | yes  | every path on the expected rung with no fallback reason; identical across repetitions                     |
| OB5-V7  | yes  | SL-O1, SL-O2, SL-O3, AL-I2 and the harness gates pass; the judged meshes are the timed ones               |
| OB5-V8  | yes  | MESH_CHECK count 0                                                                                        |
| OB5-V9  | yes  | every timed, warm-up and edit call advanced the epoch by 1 with unchanged storage; natively no allocation |
| OB5-V10 | yes  | cross-origin isolated; init samples at least 100 quanta; q at most B_edit / 100                           |
| OB5-V11 | yes  | every page visible for its whole repetition                                                               |
| OB5-V12 | yes  | every browser and native repetition, set and sample present                                               |
| OB5-V13 | yes  | clean committed tree; every manifest file equals the commit                                               |
| OB5-V14 | yes  | complete                                                                                                  |

OB5-V1 to OB5-V3, OB5-V7 and OB5-V8 are the output-identity items; a failure of one gives no verdict. None failed.

## Verdict quantities

| Quantity                                                              |                                   Value |           Budget |  Ratio |
| --------------------------------------------------------------------- | --------------------------------------: | ---------------: | -----: |
| T, the maximum OB5-SP-init median over browsers, repetitions and sets | 463.985 ms (Edge, repetition 3, OB5-W8) |         1,000 ms | 0.4640 |
| T p95 (reported beside T), the maximum OB5-SP-init p95                | 502.775 ms (Edge, repetition 3, OB5-W8) |                — |      — |
| t_edit, the maximum OB5-SP-edit p95                                   |   0.740 ms (Edge, repetition 0, OB5-W8) |             4 ms | 0.1850 |
| M, the summed E2 bytes of OB5-W8                                      |                         7,144,000 bytes | 67,108,864 bytes | 0.1065 |
| Port payload with boundary pairs (reported only)                      |                         9,192,000 bytes |                — |      — |

### Per set

The maximum over browsers and repetitions, in milliseconds:

| Set    | Init median max (ms) | Init p95 max (ms) | Edit p95 max (ms) | M (bytes) |
| ------ | -------------------- | ----------------- | ----------------- | --------- |
| OB5-W2 | 105.75               | 122.50            | 0.1650            | 1,768,000 |
| OB5-W4 | 223.76               | 282.52            | 0.3200            | 3,560,000 |
| OB5-W8 | 463.99               | 502.78            | 0.7400            | 7,144,000 |

Each path has V = 256, T = 254 and 256 boundary pairs at OB5-W8 (V = 128, T = 126 at OB5-W4; V = 64, T = 62 at OB5-W2), identical across paths, as OB5-U1's expectation has it. Every path of every set is `ok` on the fast rung with no fallback reason (OB5-V5, OB5-V6), and the batch fold is the same in every call.

### Every leg

Per browser and native repetition and set, in milliseconds: the OB5-SP-init median, p95 and p99 over 20 timed calls (each is a 1,000-path batch), and the OB5-SP-edit median, p95 and p99 over 1,000 one-path calls. Chrome and Edge are port time in the page; native is the export time in the libtest harness. The native clock quantum is 100 ns.

| Leg    | Rep | Set    | Init median | Init p95 | Init p99 | Edit median | Edit p95 | Edit p99 |
| ------ | --: | ------ | ----------: | -------: | -------: | ----------: | -------: | -------: |
| chrome |   0 | OB5-W8 |      455.50 |   469.16 |   470.12 |      0.4400 |   0.5750 |   0.6900 |
| chrome |   0 | OB5-W4 |      217.71 |   226.91 |   234.88 |      0.2200 |   0.2750 |   0.3150 |
| chrome |   0 | OB5-W2 |      104.00 |   107.35 |   113.74 |      0.1050 |   0.1400 |   0.1750 |
| chrome |   1 | OB5-W8 |      456.44 |   494.62 |   498.30 |      0.4500 |   0.5650 |   0.6450 |
| chrome |   1 | OB5-W4 |      219.97 |   256.36 |   267.85 |      0.2200 |   0.2950 |   0.3850 |
| chrome |   1 | OB5-W2 |      103.68 |   110.58 |   111.29 |      0.1050 |   0.1500 |   0.1950 |
| chrome |   2 | OB5-W8 |      449.53 |   462.77 |   464.56 |      0.4550 |   0.5900 |   0.7400 |
| chrome |   2 | OB5-W4 |      219.29 |   282.52 |   285.70 |      0.2200 |   0.2850 |   0.3150 |
| chrome |   2 | OB5-W2 |      102.84 |   106.31 |   113.94 |      0.1100 |   0.1500 |   0.1950 |
| chrome |   3 | OB5-W8 |      453.82 |   465.62 |   470.01 |      0.4500 |   0.6400 |   0.8250 |
| chrome |   3 | OB5-W4 |      218.78 |   239.94 |   251.39 |      0.2200 |   0.2700 |   0.3100 |
| chrome |   3 | OB5-W2 |      103.74 |   119.37 |   128.08 |      0.1100 |   0.1550 |   0.1900 |
| chrome |   4 | OB5-W8 |      447.19 |   484.72 |   531.00 |      0.4550 |   0.6000 |   0.8200 |
| chrome |   4 | OB5-W4 |      218.17 |   253.60 |   259.35 |      0.2200 |   0.2850 |   0.3400 |
| chrome |   4 | OB5-W2 |      102.87 |   111.35 |   117.09 |      0.1050 |   0.1300 |   0.1800 |
| edge   |   0 | OB5-W8 |      448.86 |   480.89 |   510.19 |      0.4650 |   0.7400 |   1.0300 |
| edge   |   0 | OB5-W4 |      219.00 |   226.80 |   231.75 |      0.2250 |   0.3000 |   0.3650 |
| edge   |   0 | OB5-W2 |      103.85 |   122.50 |   122.79 |      0.1050 |   0.1650 |   0.2850 |
| edge   |   1 | OB5-W8 |      457.33 |   478.56 |   495.06 |      0.4600 |   0.6500 |   0.8300 |
| edge   |   1 | OB5-W4 |      223.76 |   262.58 |   266.90 |      0.2250 |   0.3050 |   0.4100 |
| edge   |   1 | OB5-W2 |      105.68 |   109.61 |   111.25 |      0.1300 |   0.1600 |   0.2600 |
| edge   |   2 | OB5-W8 |      449.91 |   499.52 |   556.89 |      0.4550 |   0.6600 |   0.8800 |
| edge   |   2 | OB5-W4 |      218.80 |   249.87 |   265.27 |      0.2200 |   0.3000 |   0.4050 |
| edge   |   2 | OB5-W2 |      103.31 |   116.71 |   123.10 |      0.1050 |   0.1500 |   0.1850 |
| edge   |   3 | OB5-W8 |      463.99 |   502.78 |   512.58 |      0.4550 |   0.6600 |   0.8100 |
| edge   |   3 | OB5-W4 |      223.57 |   257.55 |   269.94 |      0.2250 |   0.3200 |   0.4800 |
| edge   |   3 | OB5-W2 |      105.75 |   111.74 |   112.83 |      0.1100 |   0.1450 |   0.1750 |
| edge   |   4 | OB5-W8 |      451.35 |   502.01 |   525.34 |      0.4500 |   0.6650 |   0.8300 |
| edge   |   4 | OB5-W4 |      219.09 |   243.62 |   287.88 |      0.2200 |   0.2950 |   0.3400 |
| edge   |   4 | OB5-W2 |      102.42 |   119.59 |   136.42 |      0.1050 |   0.1400 |   0.1900 |
| native |   0 | OB5-W8 |      305.26 |   337.11 |   343.00 |      0.2885 |   0.3736 |   0.5460 |
| native |   0 | OB5-W4 |      151.90 |   160.52 |   161.54 |      0.1379 |   0.1817 |   0.2372 |
| native |   0 | OB5-W2 |       67.82 |    79.90 |    79.91 |      0.0633 |   0.0785 |   0.0840 |
| native |   1 | OB5-W8 |      300.22 |   337.58 |   363.05 |      0.2888 |   0.3640 |   0.4132 |
| native |   1 | OB5-W4 |      142.70 |   157.62 |   172.24 |      0.1373 |   0.1760 |   0.2296 |
| native |   1 | OB5-W2 |       65.56 |    66.83 |    67.79 |      0.0634 |   0.0809 |   0.0947 |
| native |   2 | OB5-W8 |      301.90 |   325.53 |   327.04 |      0.2888 |   0.4204 |   0.5373 |
| native |   2 | OB5-W4 |      143.25 |   160.77 |   178.01 |      0.1379 |   0.1753 |   0.1990 |
| native |   2 | OB5-W2 |       65.83 |    71.07 |    82.87 |      0.0632 |   0.0664 |   0.0692 |
| native |   3 | OB5-W8 |      300.68 |   329.27 |   333.61 |      0.2895 |   0.3833 |   0.4888 |
| native |   3 | OB5-W4 |      140.78 |   150.22 |   152.48 |      0.1382 |   0.1822 |   0.1938 |
| native |   3 | OB5-W2 |       65.50 |    73.23 |    73.51 |      0.0633 |   0.0687 |   0.0822 |
| native |   4 | OB5-W8 |      297.22 |   314.98 |   335.15 |      0.2874 |   0.3131 |   0.3827 |
| native |   4 | OB5-W4 |      141.20 |   148.42 |   162.93 |      0.1373 |   0.1732 |   0.1846 |
| native |   4 | OB5-W2 |       65.22 |    76.53 |    76.67 |      0.0633 |   0.0680 |   0.0816 |

Browser init medians at OB5-W8 lie in 447.19-463.99 ms and browser edit p95 in 0.5650-0.7400 ms; the native init medians lie in 297.22-305.26 ms and the native edit p95 in 0.3131-0.4204 ms. The maximum edit p95 (0.7400 ms, Edge repetition 0) is one repetition's p95 of 1,000 samples; the Edge OB5-W8 edit p95 of the other four repetitions lies in 0.6500-0.6650 ms and Chrome's in 0.5650-0.6400 ms.

## Browser over native

Report-only, not a decision input. Browser port time over native export time in the test-harness build, per browser and set. Each value is the median over the five repetitions of the per-repetition ratio (init median over init median; edit p95 over edit p95), as the runner computes it. The browser side includes the adapter's validation, packing, copies and checks and the per-call fold; the native side is the kernel export only. It is not a pure WASM over native code ratio.

| Browser | Set    | Init median ratio | Edit p95 ratio |
| ------- | ------ | ----------------: | -------------: |
| chrome  | OB5-W2 |             1.577 |          1.912 |
| chrome  | OB5-W4 |             1.541 |          1.626 |
| chrome  | OB5-W8 |             1.505 |          1.552 |
| edge    | OB5-W2 |             1.570 |          2.102 |
| edge    | OB5-W4 |             1.552 |          1.711 |
| edge    | OB5-W8 |             1.519 |          1.786 |

For comparison, AL-S2 measured k̂ = 1.579 (init cells, ten-path batches) and k̂₁ = 1.615 (one-path cells). Here the OB5-W8 init ratios are 1.505 (Chrome) and 1.519 (Edge), and the OB5-W8 edit ratios 1.552 and 1.786.

## OB5-SP-cold

Report-only. One call per set on a second adapter over a fresh WASM instance created and disposed outside timing; the window includes its reserve and arena growth. Milliseconds, repetitions 0-4:

| Browser | Set    | Cold call (ms), repetitions 0-4   |
| ------- | ------ | --------------------------------- |
| chrome  | OB5-W8 | 917.2, 849.4, 863.0, 864.1, 863.2 |
| chrome  | OB5-W4 | 411.7, 434.2, 411.2, 417.1, 415.2 |
| chrome  | OB5-W2 | 192.8, 207.9, 191.9, 189.8, 204.8 |
| edge    | OB5-W8 | 916.8, 884.1, 864.8, 881.0, 903.4 |
| edge    | OB5-W4 | 411.0, 427.8, 415.2, 426.2, 427.2 |
| edge    | OB5-W2 | 194.0, 235.8, 238.0, 196.3, 192.6 |

At OB5-W8 the cold call is 849.4-917.2 ms in Chrome and 864.8-916.8 ms in Edge, against the warm init median of 447.19-463.99 ms.

## OB5-SR

Report-only. `PathMeshPipeline.prepare` on the 1,000 path nodes with a cold cache, a fresh pipeline per set, on the provisioned adapter, with `PATH_MESH_LIMITS` unchanged and `buildPathFringe` wrapped only to count its calls and time. Camera at (−640, −360), zoom 1, target 1280 × 720 at DPR 1. Region-only is the count of draws without a fringe; fringed is the rest. Builder time is the time inside `buildPathFringe`. The counts are the same in every repetition and browser.

| Browser | Set    | Prepare (ms), repetitions 0-4               | Draws | Region-only | Fringed | Builder time (ms), repetitions 0-4          | Builder calls | fringe-work-cap notices |
| ------- | ------ | ------------------------------------------- | ----: | ----------: | ------: | ------------------------------------------- | ------------: | ----------------------: |
| chrome  | OB5-W8 | 517.4, 500.8, 468.6, 521.1, 458.2           |  1000 |        1000 |       0 | 0.0, 0.0, 0.0, 0.0, 0.0                     |             0 |                    1000 |
| chrome  | OB5-W4 | 15705.6, 15537.6, 15596.3, 15749.6, 16289.2 |  1000 |           0 |    1000 | 15443.8, 15272.4, 15329.4, 15485.5, 16029.2 |          1000 |                       0 |
| chrome  | OB5-W2 | 4645.9, 4671.3, 4626.6, 4663.2, 4895.0      |  1000 |           0 |    1000 | 4493.5, 4520.4, 4468.1, 4497.2, 4713.9      |          1000 |                       0 |
| edge    | OB5-W8 | 515.8, 497.4, 518.6, 476.1, 468.5           |  1000 |        1000 |       0 | 0.0, 0.0, 0.0, 0.0, 0.0                     |             0 |                    1000 |
| edge    | OB5-W4 | 16511.7, 16963.5, 16105.7, 16119.6, 16049.8 |  1000 |           0 |    1000 | 16237.0, 16691.8, 15840.2, 15845.3, 15783.3 |          1000 |                       0 |
| edge    | OB5-W2 | 4812.1, 4881.4, 4874.7, 4962.4, 4798.3      |  1000 |           0 |    1000 | 4658.0, 4686.6, 4717.4, 4794.2, 4637.5      |          1000 |                       0 |

- **OB5-W8:** all 1,000 draws are region-only. Each takes the `fringe-work-cap` notice (1,000 notices), so the fringe builder is never called (0 calls, 0.0 ms) and the prepare time is 458.2-521.1 ms, against browser init medians of 447.19-463.99 ms for the port call alone.
- **OB5-W4 and OB5-W2:** all 1,000 draws are fringed and the builder is called once per draw. Prepare takes 15,537.6-16,963.5 ms at OB5-W4 and 4,626.6-4,962.4 ms at OB5-W2, of which the builder takes 15,272.4-16,691.8 ms and 4,468.1-4,794.2 ms. The builder is 96.0-98.4 % of the prepare time at these two sets.
- OB5-SR is outside the verdict. At the two smaller sets the builder time (seconds) is far above the port time (hundreds of milliseconds), and at OB5-W8 the fringe work cap keeps every draw away from the builder. This record draws no conclusion about the renderer budget from it.

## OB5-Q7 (a) observation

Outside the verdict, native and untimed, on the TypeScript-encoded OB5-W8U bytes (the unsnapped ring; the corpus matches): batch status 0, 1000 paths, **911 `ok` on the fast rung and 89 `work-limit` on the exact rung after a `PREFIX` fallback**. The unsnapped ring is not part of the decision workload.

## Oracle gates

One untimed native oracle run on a production-cap dump of all 3,000 paths (dump revision 2, 250,055,633 bytes), evaluated in TypeScript. A failed gate or a nonzero `MESH_CHECK` count would invalidate the run. None failed.

| Gate    | Checked | Failures | Pass |
| ------- | ------: | -------: | ---- |
| SL-O1   |   3,000 |        0 | yes  |
| SL-O2   |   3,000 |        0 | yes  |
| SL-O3   |   3,000 |        0 | yes  |
| AL-I2   |       0 |        0 | yes  |
| harness |   3,000 |        0 | yes  |

- **`MESH_CHECK` count: 0** over the oracle run and every native call.
- **AL-I2:** 0 checked because no path falls back (every one of the 3,000 paths is on the fast rung), so there is no fallback path to compare with `exact_only`.
- **Fast-rung share:** per set, 1,000 dump entries, 1,000 on the fast rung with no fallback, and 1,000 `ok` exact-rung results for the SL-O3 comparison. The record's AL-I3 field reports `prefix` 3,000 and `other` 0; AL-I3 is not a gate here, because the frozen spike returns `PREFIX` above 68 points ([proposal section 5](../../plans/p3-al-ob5-workload-scenario-proposal.md#5-oracles-and-validity-checks)).
- **Reported, not gated:** the maximum certified-over-delta is 0.7534 (OB5-W2), 0.7509 (OB5-W4) and 0.3753 (OB5-W8); there are 0 non-finite vertices in any set. Fast-rung median triangle quality is 0.0846 (OB5-W2), 0.0436 (OB5-W4) and 0.0261 (OB5-W8); the record's `below001` count on the fast rung is 0 of 62,000, 2,402 of 126,000 and 15,028 of 254,000 triangles. These sliver statistics (SL-O5 and SL-O6) are reported and are not gated, as AL-S1 reports them; the full per-set, per-rung table is `oracle.slivers` in the `.json`.

## Memory

Not a decision input. `linearMemoryBytes()` after the run: 17,825,792 bytes in Chrome and 17,825,792 bytes in Edge (17.00 MiB; 6.6 % of BC19's 268,435,456-byte ceiling), within the ceiling in both. The AL-S2 record's value for its ten-path workload was 2,293,760 bytes. One value per browser after the run; not a peak.

## Clock quantum

Every page was cross-origin isolated (OB5-V10). The page's clock probe reported a minimum positive increment of 0.005000 ms (about 5 µs) in every one of the ten browser repetitions; the native clock quantum was 100 ns in every repetition. OB5-V10's two conditions pass: every OB5-SP-init sample is at least 100 quanta (every init sample is a 1,000-path batch; the shortest browser init sample in the record is 100.17 ms against 100 quanta = 0.5 ms), and q = 0.005 ms is at most B_edit / 100 = 0.04 ms, so quantization moves an edit sample by at most 0.125 % of B_edit.

## Context: the AL-U7 estimates

A fact, not a decision input. The [AL-S2 record](2026-10-20_p3_p3-b0-wasm-v1_chrome-edge_desktop-dkvusav_20261020T050227Z-f86bda54.md#context-the-estimates-against-the-budgets) extrapolated, at k̂ = 1.579, T̂ = 1,031.1 ms (1.031 × B_init), t̂_edit = 4.367 ms (1.092 × B_edit) and, report-only, t̂_p95 · k̂₁ = 4.467 ms (1.117 × B_edit). The direct measurement is below all three:

| Quantity                            |                 AL-U7 estimate | This run (measured) | Measured / estimate |
| ----------------------------------- | -----------------------------: | ------------------: | ------------------: |
| Initial build                       |                 T̂ = 1,031.1 ms |        T = 464.0 ms |               0.450 |
| Edit                                |              t̂_edit = 4.367 ms |   t_edit = 0.740 ms |               0.169 |
| Edit, one-path factor (report-only) |          t̂_p95 · k̂₁ = 4.467 ms |   t_edit = 0.740 ms |               0.166 |
| Mesh memory                         | M̂ = 7,144,000 bytes (6.81 MiB) | M = 7,144,000 bytes |               1.000 |

Against the budgets, the estimates were 1.031 and 1.092 times B_init and B_edit; the measurements are 0.464 and 0.185 times. M equals M̂ exactly.

### Why the measurements are below the estimates

This section uses only the committed records: the [AL-S1 record](2026-10-20_p3_p3-fill-ladder-v1_native_desktop-dkvusav_20261020T044849Z-ed356d28.md#fitted-slopes-and-per-fit-estimates) (and its `.json`) and the [AL-S2 record](2026-10-20_p3_p3-b0-wasm-v1_chrome-edge_desktop-dkvusav_20261020T050227Z-f86bda54.md), and this record. The estimate is T̂ = 1,000 · t̂ · k̂ and t̂_edit = t̂_p95 · k̂, with t̂ and t̂_p95 native per-path values extrapolated by AL-S1 to L\* = 256 leaves and k̂ the measured browser over native factor.

1. **The factor is not the source.** The browser over native ratios here are 1.505-1.519 at OB5-W8 for init, against k̂ = 1.579; the edit p95 ratios are 1.552 (Chrome) and 1.786 (Edge). The factor accounts for at most 1.579 / 1.505 = 1.05 of the init gap. The gap is in the native per-path values.
2. **The native per-path time at 256 leaves is lower than the estimate.** AL-S1 bound t̂ = 0.6529 ms per path (P8 median fit, repetition 0) at L\* = 256. The direct native OB5-W8 init median is 297.22-305.26 ms per 1,000 paths, 0.2972-0.3053 ms per path: the estimate is 2.14-2.20 times the measurement. AL-S1's own P8 median bounds for repetitions 1, 2, 3 and 4 are 0.3136, 0.2925, 0.3907 and 0.4063 ms, of the same order as the direct 0.2972-0.3053 ms. Only repetition 0's 0.6529 ms is far above it, and it is the one that binds, as the maximum.
3. **At 64 leaves the two measurements agree.** AL-S1's P8/s=8 cell (64 leaves) has a per-path median of 66.3-68.3 µs over repetitions 0-4; OB5-W2 (64 leaves, a different shape) has a native per-path median of 65.2-67.8 µs. The rise from 64 to 256 leaves is what differs: the direct native medians give a log-log slope of 1.085-1.099 over 64 to 256 leaves (1.104-1.163 from 64 to 128, 1.007-1.095 from 128 to 256), whereas AL-S1's binding repetition-0 median fit has slope 1.163.
4. **Two terms of the extrapolation add to the gap.** For the repetition-0 P8 median fit, the point prediction at 256 leaves is exp(12.8213) ns = 0.3700 ms (1.21-1.25 times the direct 0.2972-0.3053 ms, from the steeper slope 1.163), and the upper prediction bound that the decision rule uses is 0.6529 ms, the point prediction times the prediction factor 1.7647 (0.3700 ms × 1.7647 = 0.6529 ms; the bound U binds, not the curvature guard G).
5. **The edit estimate carries a larger bound.** The binding AL-S1 edit value is the P8 p95 fit of repetition 0: point prediction exp(13.5569) ns = 0.7721 ms, slope 1.451, prediction factor 3.582, bound 2.7656 ms per path, one of the four fits that failed AL-S1's check 2. The direct native edit p95 at 256 leaves is 0.3131-0.4204 ms (median 0.2874-0.2895 ms), so the bound is 6.6-8.8 times the direct p95 and the point prediction is 1.8-2.5 times. The repetition-0 P8 p95 points are 24.8, 39.0, 48.0, 60.5, 127.0 and 82.1 µs at 24, 32, 40, 48, 56 and 64 leaves; the 56-leaf point is above the 64-leaf one, which steepens the fit. The AL-S1 record already documents elevated cells in that series.

**What the data show.** The estimates are extrapolated upper prediction bounds of AL-S1's repetition 0 fits, taken at 4 times the largest measured leaf count, and the repetition-0 P8 fits have the steepest slopes of the five repetitions (1.163 for the median fit and 1.451 for the p95 fit; the other repetitions' slopes are 0.948-1.063 and 0.882-1.275), with prediction factors of 1.765 and 3.582. Measuring 256 leaves directly removes both the slope extrapolation and the prediction bound. **What the data do not show:** why the repetition-0 P8 points are elevated (the AL-S1 record states the elevated cells and does not identify a source), and whether the browser leg would show the same extrapolation gap at other path shapes. This record does not speculate on a cause beyond the comparison above.

## Scope of the verdict

As [proposal section 4](../../plans/p3-al-ob5-workload-scenario-proposal.md#4-decision-use) states it: simple, single-contour, snapped rings at zoom 1, λ = 2, 4 and 8, e = −3, nonzero, on the reference machine DESKTOP-DKVUSAV in Chrome and Edge. It does not cover the zoom range, generic coordinates, multiple contours, crossings, stroke, the renderer and draw stages, or lower-tier hardware.

Further:

- T and t_edit are the production port in Chrome 155 and Edge 155; the browser side includes the adapter's validation, packing, copies and checks, and the per-call fold. Each edit sample is one `buildFillMeshes` call on one request; it is not an incremental edit.
- T is the maximum over ten browser repetitions of a median of 20 calls, which is more conservative than AL-S2's median-over-repetitions treatment ([proposal section 3.4](../../plans/p3-al-ob5-workload-scenario-proposal.md#34-statistics)); it is not like-for-like with T̂.
- OB5-SR and OB5-SP-cold are reported only. The OB5-SR renderer stage (fringe builder, paths of OB5-W4 and OB5-W2) is outside the verdict, and OB5-W8 never reaches the builder.
- The OB5-W8U fast-rung share (911 of 1,000) is an observation about unsnapped input and is outside the verdict.

## Limits of this record

- One run on one machine, five repetitions per browser; at five samples the nearest-rank p95 of the edit calls is the 950th of 1,000 and the maximum over repetitions is one repetition's p95. It does not show how the values vary between runs, browser versions or machines.
- The browser leg runs headed with Playwright's launch flags, which the record keeps (46 flags per repetition, including `--enable-automation`, `--no-sandbox` and `--enable-unsafe-swiftshader`). No GPU work is done.
- Background load is an operator statement plus process listings, with the third-party and interactive processes named above present; no CPU-load sampling. The load of those processes is unmeasured.
- The native leg is a libtest release build with the `cfg(test)` tracking allocator, unwinding and test hooks compiled in. Browser over native ratios are therefore report-only.
- The explanation of the gap compares committed records and does not re-run or re-fit AL-S1.
- It closes no A01-A08 or C03-C05 criterion and changes no budget, rule or past record. Acting on it needs the independent evidence review; the decision then goes to the user under AL-Q6 (a) and proposal section 4. This record chooses no remedy.

## Review note, 2026-10-21: independent evidence review (OB5-U3)

ACCEPTED WITH NOTES, no blocking item. The `.json` equals the run directory's `record.json` byte for byte; `validateOb5Record` accepts it on a `git archive` of `4713307` and `analyze()` recomputes FEASIBLE; the 119 source-manifest hashes equal the commit's blobs; T = 463.985 ms, t_edit = 0.7400 ms and M = 7,144,000 bytes recompute from the raw samples, and every table above matches the `.json`. Corrections and additions, which change no value and not the verdict:

- **Background disclosure, completed.** Besides the processes named above, the runner's listing (`process-listing.txt`, SHA-256 `6f53b273…ea23`) shows `ms-teams.exe` (2), `TeamViewer.exe` with `tv_x64`/`tv_w32`, `Video.UI.exe`, `Telegram.exe`, `KakaoTalk.exe`, `olk.exe` (Outlook), `Notepad.exe`, `Hearthstone Beta Launcher.exe`, `HGridEngine.exe` and `HGridStream.exe`, `Everything.exe`, the Windows Search indexer with six `SearchFilterHost.exe`, and the Primary session's own shell processes. The `hyperframes preview` tool also has `esbuild.exe` (PID 26568); its `node.exe` PID 30716 is the one AL-A15 named, so it has run since 2026-10-19. The listing is one snapshot before the start; their load is unmeasured.
- **Disturbance in the samples.** No browser repetition shows a level shift of its medians (OB5-W8 init medians 447.2-464.0 ms). Within-cell excursions are present: Chrome repetition 2 OB5-W4 timed samples 4-7 (264-286 ms against about 218 ms), Edge repetition 0 OB5-W2 samples 12-17 (113-123 ms against about 103 ms) with 28 edits above twice the median, Edge repetition 0 OB5-W8 with 14 such edits (the repetition whose p95 is t_edit), and native repetition 0 OB5-W4 (median 151.90 ms against 140.78-143.25 ms). Disturbance can only lengthen samples, and every individual sample is within budget: the longest timed init sample is 556.89 ms and the longest edit sample 2.405 ms. The verdict does not depend on the quietness of the machine.
- **Gap explanation, item 3.** The AL-S1 values 66.3-68.3 µs are its individually timed one-path medians; its batch per-path medians, the statistic of the fit and of OB5's init samples, are 66.3-68.8 µs. The direct slopes vary λ at s = 32, whereas AL-S1's P8 slope varies s at λ = 8 with ten-path batches; the two series differ in construction. Item 2: AL-S1's repetition-2 P8 median bound (0.2925 ms) is below the direct native per-path median (0.2972-0.3053 ms).
- **Set order.** Under the B0 rule with seeds 0x9e3779b9 + r, the set order is OB5-W8, OB5-W4, OB5-W2 in all five repetitions; order effects are not varied. Edit orders differ between repetitions.
- **Wording.** In "Limits", read: with five repetitions per browser the maximum over repetitions is one repetition's p95, and each edit p95 is the 950th of 1,000 samples. The captured `navigator.userAgent` (`…/151.0.7922.34`) is Playwright's device-descriptor string; the browser versions above come from `browserVersion`.

This review accepts the record as evidence for proposal section 4. The decision goes to the user under AL-Q6 (a).
