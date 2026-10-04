# P3.2p2 historical polygon relation observation

Status: COMPLETE, independent audit PASS. This is a historical carried-polyline observation under the [frozen contract](../../plans/p3-polygon-relation-census-contract.md), not a current-kernel, source-curve topology or performance result. The [active plan](../../plans/p3-fill-stroke-meshes.md) owns milestone status.

## Identity and execution

P3.2p1 tooling integrated through [PR #79](https://github.com/npclown/vector-studio/pull/79), required [CI run37208813126/job111455583558](https://github.com/npclown/vector-studio/actions/runs/37208813126/job/111455583558) PASS on source`b2cc465a02b59af768155c8ba93c0b8c670a73b1`; squash`a5764303e27f4bebb8eff7e0711882df3105b3aa`. New clean branch`codex/p3-2p2-polygon-relation-observation` began at that squash. Windows x64, Node24.15.0, pnpm11.1.2,2026-10-04. Primary dispatched exactly one FULL invocation after p1 integration, with no exploratory subset or retry:

```powershell
node tooling/run-p3-polygon-census.mjs --full --native-dir .tools/p3-2m2-cubic-readiness-20261002-01/native --output .tools/p3-2p2-polygon-relations-20261004-01
```

RUN PASS, AUDIT PASS, COMPLETE1000 ordered rows, exit0. Each isolated phase executes its own test and intentionally skips the other phase. Logs remain ignored at`.tools/p3-2p2-full.log` and the output directory's run.log/audit.log. No source changed during execution: analysis dirty=false; normalized manifest start=end`ecbb9008fb72eae939dbdde818b02b5f39e90e649fd60359b46d91570dae7bad`.

Historical runtime remains the [m2 observation](../p3.2m2-cubic-readiness-2026-10-02/README.md), source`9508a6615f6b6e941aee26802a49eb9ca1b9dbd0`, manifest`d443f5e5e18d5b60c11cb546cbaa15e36da5abec1bc8f58cd1df4f27b5507f0b`. Scenario p2-batch/v1, seed0x12345678,1000 paths x32 cubics, tolerance1/8, identity screen. Input1684000 bytes SHA256`e45332519703e6c2dd290a3969a00736e0171b870da5ebce0767e8c54c2570dc`; output38612072 bytes SHA256`1e6086e3ef2faa76f112bc9512afc9a175fef3014a2952d6e4021ba5f8aa8973`. Each pass authenticates committed source records and each consumed frame, regenerates canonical input bytes, decodes carried output and checks EOF. No native kernel, position proof or curved-topology certificate was rerun.

## Immutable artifacts

These are byte-for-byte copies of completed output, never reformatted or regenerated during documentation:

| Artifact                           |   Bytes | SHA256                                                             |
| ---------------------------------- | ------: | ------------------------------------------------------------------ |
| [invocation.json](invocation.json) |    9040 | `988aa741639fda0cf7b61e7cbeabbc66618496d6cd46a6ad181bb199174bfdf5` |
| [report.json](report.json)         |   11412 | `41c5ff49ea0aa507ccc469b38e0e85a6df3391c57ea138fd4249cbb860362756` |
| [rows.ndjson](rows.ndjson)         | 2673169 | `36b6549fc33a19c142b27e2e025f74b3256a69a0681d8e8ee796d0bbea874d18` |
| [audit.json](audit.json)           |     334 | `1db08d2eaa8c31789273a8ee55629cde5cb321a75ff1f8c2cd6cb78b13d0f678` |

## Observed relations

All1000 rows are complete:1326192 raw emitted lines, no omitted zero edges,1000 synthetic closing edges and1327192 normalized edges. Classification covers881038654 pairs:879187942 strict-AABB rejections and1850712 exact tests. The independent parametric implementation reconstructs every row's edge/contact hashes, class maps, adjacency, first witnesses and summary.

| Relation            |     Total | Adjacent | Nonadjacent |
| ------------------- | --------: | -------: | ----------: |
| DISJOINT            | 879647814 |        0 |   879647814 |
| PROPER_CROSSING     |     63648 |        0 |       63648 |
| ENDPOINT_TOUCH      |   1327192 |  1327192 |           0 |
| T_JUNCTION          |         0 |        0 |           0 |
| COLLINEAR_POINT     |         0 |        0 |           0 |
| COINCIDENT_SAME     |         0 |        0 |           0 |
| COINCIDENT_REVERSED |         0 |        0 |           0 |
| COLLINEAR_OVERLAP   |         0 |        0 |           0 |

Max normalized edges1462 and pairs1067991 occur at index463. Max exact tests2914 occurs at index874. Primary retains no candidate list; independent audit peak21 candidate records occurs at index951 and respects its per-path E cap. These are logical work/cardinality observations, not heap-byte or speed claims. A read-only reduction of the immutable journal finds every path has at least one proper crossing: min25, max171 at index863, total63648. These derived values are observations, not new fixture expectations or runtime limits.

## Interpretation and validation boundary

The historical actual polylines all require crossing-aware region resolution; simple-contour topology alone cannot handle this recorded inventory. This does not prove original cubic crossings, source-to-polygon topology preservation, intersection-event multiplicity, a larger workspace's feasibility, current-kernel acceptance or mesh/renderer readiness. Private caps and error budgets are unchanged. No limits or acceptance thresholds are selected from observed maxima. Historical A08 FAIL and latest-source performance UNVERIFIED remain unchanged; stroke refinement stays user-deferred.

Primary checked exact source identity, clean execution, COMPLETE state,1000-row journal, sums/adjacency/maxima and audit linkage. Independent GPT-5.6 Sol medium read-only evidence review PASS: separately parsed all1000 rows, recomputed counts/adjacency/earliest maxima/crossing distribution, checked source identity and native hashes, and verified archive/report/audit linkage. No recursive delegation. Git staged-byte comparison against the raw capture PASS for all four artifacts. This checkpoint changes only evidence and plan status. Root code/build and native/WASM/browser/GPU/benchmark runs are NOT RUN locally in p2 because p1 code is unchanged and full diagnostic execution is its acceptance; required protected CI still applies.

Next meaningful implementation candidate is canonical all-LINE degenerate contour composition through the existing rounded workspace, under a separately frozen contract. It closes documented temporary private restrictions with approved visible semantics and unchanged caps. General cubic crossings/tangencies and rounded source endpoint correspondence remain separate unresolved prerequisites; this census does not bypass them.

Changed-Markdown Prettier check and staged diff whitespace check PASS; repository local-link audit from docs/evidence/p1.0b-contract-review-2026-09-12.md PASS:722 links/anchors across145 Markdown files. Only protected CI and PR integration remain.
