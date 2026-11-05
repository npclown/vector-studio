# PA-U9: pre-alpha sitting on the main PC at the gate head `eadc1d7`, 2026-11-04 to 05

Status: **sitting complete; PA-A02 PASS, PA-A01, A03 and A04 miss, PA-A05 UNVERIFIED (a possible FAIL on the start-of-GC floor, not computed), PA-A10 tier 3 half PASS** ([pre-alpha gate plan, section 3](../plans/pre-alpha-gate-plan.md#3-acceptance-criteria)). The misses and the UNVERIFIED memory row are gate exceptions for the PA-U10 exit card; this record decides none of them.

## Identity

- Gate head `eadc1d75d0e26872128584445333572fa649f089` (origin/main after [#502](https://github.com/npclown/vector-studio/pull/502)), detached checkout, `git status --porcelain` empty before every timed part. Every timing and memory record reads `dirty: false`. Untracked leftovers (`.claude/launch.json`, an old readback folder, ten unignored `artifacts/` entries) were moved out of the tree before the sitting and put back after it ([environment](pa-u9/eadc1d7/environment.json)).
- Main PC DESKTOP-DKVUSAV: Windows 11 Pro 10.0.26200, Ryzen 7 3700X, 31.9 GB, GTX 1660 SUPER driver 32.0.16.1088, display scale 100 %, two 1920x1080 displays, AC power, Balanced scheme. Node 24.22.1, pnpm 11.1.2, Playwright 1.62.1, headed Chrome 156.0.8078.81 and Edge 156.0.4314.58. WebGPU adapter `nvidia / turing` in every timing record. Idle rAF median 16.7 ms.
- `M8_N3_BASELINE=docs/evidence/m8-a14-2026-11-01/17a2b0a-main-pc-headed.json` for every part.
- Order: timing (`pnpm test:e26`, 22:27Z to 01:42Z), memory (02:13Z to 02:29Z), tier 3 (`pnpm test:headed --tier 3`, 02:29Z to 03:58Z).

### Departures from the sitting conditions

- **The user's Chrome was open when timing started.** At 22:03Z the user was asked to close browsers and heavy apps; after more than 10 minutes the run started either way. At 22:27Z 15 `chrome` processes ran (no `msedge`); they were gone by 02:12Z, before memory and tier 3. When Chrome closed is not recorded. Telegram, KakaoTalk, TeamViewer, MobaXterm, Teams and the Claude app stayed open through the sitting; CPU over 10 s before timing averaged 3.7 % (max 5.5 %). Which timing projects ran while Chrome was open is unknown. Two displays were active throughout. This departs from the plan's "the user's browsers closed" condition and is disclosed; the timing rows below were not re-run. Read under it: the PASS stands, because contention can only add time; the misses stand as measured and are not attributed to it.
- **One timing test failed and was not re-run**: `edge-dpr2-v2` `e26-ui0-mixed-all-pan-10k/v1` r3, `page.evaluate: Target page, context or browser has been closed` (`tests/e26/e26-harness.spec.ts:894`), no record written ([failures](pa-u9/eadc1d7/tier3/failures.txt)). It is a `ui=0` control of a v1 row, not a gated row. Totals: 403 passed, 1 failed, 404 skipped (the skips are the plan's projects-by-scenario matrix).

## PA-A01 to A04: timing

Rules: the E26 verdict rules as M9 used them (maximum per-run p95, nearest rank, no rounding allowance, every repetition kept). Five repetitions per project. Full table: [summary.md](pa-u9/eadc1d7/timing/summary.md), records in [timing/runs](pa-u9/eadc1d7/timing/runs/).

Max per-run p95 in ms, `chrome-dpr1-v2` / `chrome-dpr2-v2` / `edge-dpr1-v2` / `edge-dpr2-v2`:

| Row | v2 scenario | Target | Max per-run p95 | Result |
| --- | --- | --- | --- | --- |
| PA-A01 | `e26-mixed-view-edit-10k/v2` | ≤ 16.7 | 16.8 / 16.8 / 16.8 / 16.8 | miss by 0.1 |
| PA-A02 | `e26-simple-stress-10k/v2` | ≤ 33.3 | 16.8 / 16.8 / 16.8 / 16.8 | **PASS** |
| PA-A03 | `e26-mixed-all-edit-10k/v2` | ≤ 33.3 | 50.1 / 50.1 / 50.1 / 50.1 | miss |
| PA-A03 | `e26-mixed-all-pan-10k/v2` | ≤ 33.3 | 66.7 / 66.8 / 66.7 / 66.8 | miss |
| PA-A04 | `e26-pointer-busy-10k/v2`, busy | < 50 | 483 / 480.4 / 347 / 259.6 | miss |
| PA-A04 | `e26-pointer-busy-10k/v2`, plain | < 50 | 244.1 / 262.2 / 253.9 / 295.9 | miss |

- **PA-A01 is within 0.1 ms of its ceiling.** Every per-run p95 is 16.8 ms, one refresh at this sitting's interval (idle rAF median 16.7 ms), as at the E30 U6 sitting. The plan sends a result within 0.1 ms of a ceiling to the user (PA-Q6, section 5); PA-U10's exit card asks it.
- **PA-A03** holds three and four refreshes in every run, as at E30 U6; the renderer remedy is backlog E34.
- **PA-A04 pointer latency** misses in both variants. Per-run p95 ranges over all 20 runs: busy 190.3 to 483 ms, plain 137.2 to 295.9 ms.

### PA-A04: the E26-A05 clauses on v2

From the 40 pointer records (`writesDuringPress`, `firstWriteAfterUpMs`, `longTasksOver50`, `undoDepth`):

| Clause | Busy (20 runs) | Plain (20 runs) |
| --- | --- | --- |
| No autosave write starts while the pointer is pressed | holds: 0 writes in every run | holds: 0 writes in every run |
| The due write starts within one frame after pointer up | **miss**: first write 69.1 to 84.0 ms after up | not exercised (N/A): no write comes due during the press; the first write is the autosave delay, 520.5 to 537.5 ms after up |
| No long task over 50 ms between down and up except one overlapping isolation | **miss**: one font-load task of 60 to 73 ms during the press in every run (the isolation task, 145 to 172 ms, is exempt) | holds: the two tasks seen (68 and 79 ms, one run each) start at pointer up, after the press |
| The pointer up is applied | holds: undo depth 2 of 2 in every run | holds: undo depth 1 of 1 in every run |

`firstWriteAfterUpMs` is measured from `upHandledMs`. One busy run (`chrome-dpr1-v2` r2) also has an 83 ms task starting at pointer up. The drag defect seen in V-21 U3 and PA-U5 (moves stop applying, a write during the press, the release not applied) did not occur in any of the 40 runs.

### Change since earlier sittings

| Measure | [V20-U3](viz-v20/u3-b810f89.md) (`b810f89`) | [E30 U6](e30/u6-80e4789.md) (`80e4789`) | This sitting |
| --- | --- | --- | --- |
| Pointer busy, max per-run p95 per project | 752.6 to 876.3 ms | 208.7 to 412.4 ms | 259.6 to 483 ms |
| Pointer plain, max per-run p95 per project | 558 to 767.4 ms | 235.9 to 343.6 ms | 244.1 to 295.9 ms |
| First write after up, busy | 67.6 to 85 ms | 82.6 to 98.8 ms | 69.1 to 84.0 ms |
| Typical view frame p95 | 33.4 ms (two refreshes) | 18.1 ms (17.5 to 18.0 ms refresh), one Edge DPR 2 run 35.3 ms | 16.8 ms (16.7 ms refresh) |

No `packages/` or `apps/` file changed between E30 U6's head `80e4789` and the gate head (`git diff --stat 80e4789 eadc1d7 -- packages apps` is empty). The differences against E30 U6 are sitting variance and are not attributed; busy is higher and plain lower than there.

### Other rows (recorded, not gated)

- `e26-isolation-m1-a13/v1`: 20 of 20 pass (one rejection 84.3 to 104 ms, 16 rejections 109.2 to 179.5 ms, against 276.2 to 288.5 / 552.4 to 577 ms).
- `m9-typing-10k/v1`: max per-run p95 53.8 / 64.2 / 56.4 / 65.2 ms (recorded only).
- `m9-ui-geometry`: equal with and without the UI in all four projects.
- v1 and `ui=0` controls: same pass or miss outcome as the v2 rows, with different values. The v1 pointer maxima are lower (busy 84.6 to 135.8 ms, plain 80.1 to 149.2 ms). Among the `ui=0` v1 controls, busy `chrome-dpr2-v2` reaches 573 ms and plain 518.3 ms, `edge-dpr2-v2` pan has one 83.4 ms run, and `chrome-dpr2-v2` stress r5 reads 1016.7 ms, so that control row misses. None is attributed.

## PA-A05: memory

Method: the [PA-U4 method record](pa-u4c/8d873e8.md) and A09-Q4 (a) (a run reads FAIL when the exact categories plus the floor of an UNVERIFIED one exceed the bound). Five repetitions per project on each workload. Records in [memory/runs](pa-u9/eadc1d7/memory/runs/); the 40 raw traces (about 349 MB) stay on the main PC. MB is 10⁶ bytes; the bound is 256,000,000 bytes.

| Project | Workload | Exact sum (M3 to M6, M5 a stated bound) | Floor sum (exact + M1 floor) | Observed sum | Verdict per run |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | stress v2 (gated) | 40.1 | 162.1 to 162.8 | 210.3 to 211.3 | UNVERIFIED x5 |
| edge-dpr1-v2 | stress v2 (gated) | 40.1 | 161.5 to 162.3 | 210.7 to 211.7 | UNVERIFIED x5 |
| chrome-dpr2-v2 | stress v2 (gated) | 128.6 | 250.0 to 250.4 | 298.3 to 299.8 | UNVERIFIED x5 |
| edge-dpr2-v2 | stress v2 (gated) | 128.6 | 250.0 to 251.4 | 299.0 to 303.9 | UNVERIFIED x5 |
| chrome-dpr1-v2 | view-edit v2 | 103.0 | 316.4 to 320.3 | 429.1 to 443.8 | FAIL x5 |
| edge-dpr1-v2 | view-edit v2 | 103.0 | 316.7 to 333.8 | 435.2 to 450.6 | FAIL x5 |
| chrome-dpr2-v2 | view-edit v2 | 191.9 | 401.8 to 449.1 | 528.5 to 559.9 | FAIL x5 |
| edge-dpr2-v2 | view-edit v2 | 191.9 | 409.1 to 466.2 | 534.0 to 569.9 | FAIL x5 |

- **PA-A05 reads UNVERIFIED on the floor this sitting computed**: on the gated workload no run's floor sum exceeds the bound (DPR 2 is 4.6 to 6.0 MB under it), and M1, M2 and M7 have no exact high-water mark. An UNVERIFIED PA-A05 does not pass (section 3); it is a gate exception for the exit card, as the user chose on 2026-11-02 (disclose, no memory remedy now).
- **Method gap, disclosed: PA-U4c section 6 was not done.** PA-U4c named the largest `start_memory_size` (`V8.GCTraceGCNVP`, the committed heap at each GC start) as M1's between-GC source for PA-U9, and asked that a GC still running when the trace stops be counted as unpaired. Neither is implemented at `eadc1d7` (`tests/support/memory-trace.ts` reads no `start_memory_size`, and an unended GC is dropped, so `unpaired: 0` does not exclude one). The M1 floor here is `gc.maxTotalAfter` alone. A largest `start_memory_size` is also a value the heap held, so it is a valid floor and may be higher: PA-U4c saw it 0 to 17.2 MB (Chrome) and 0 to 20.7 MB (Edge) above the previous GC's end, more than this sitting's 4.6 to 6.0 MB margin. **On that floor, stress at DPR 2 could read FAIL under A09-Q4 (a).** The 40 raw traces are kept on the main PC, so the floor can be recomputed without a new sitting; until then PA-A05 is UNVERIFIED with a possible FAIL, and either reading is a gate exception.
- **Against PA-U4c** (`8d873e8`, stress DPR 2 floor 269.1 to 271.4 MB, which would have read FAIL): M3 to M6 are unchanged (M4 77.9 MB, M5 48.4 MB at DPR 2). The M1 floor is lower: the committed heap `gc.maxTotalAfter` is 121.4 to 122.8 MB here against 140.6 to 142.8 MB. The floor rule is not the cause (in all 20 stress runs `gc.maxTotalAfter` equals the end `totalSize`, so taking the larger adds nothing). Between the two heads 18 `packages/` files changed (E30 and later work); which change lowered the heap is not established. The margin also rests on A09-Q2 (a)'s two assumed swap-chain copies (29.5 MB of M5).
- **View-edit** is not the gated workload (PA-Q2), and is recorded: every run reads FAIL.

## PA-A10: tier 3

`pnpm test:headed --tier 3` at the gate head: 14 stages passed, **460 passed, 0 failed, 0 flaky, 0 skipped**, 89.1 minutes ([stages](pa-u9/eadc1d7/tier3/stages.tsv), [console](pa-u9/eadc1d7/tier3/console.log)): `gpu-corpus` 24, `gpu` 186, `p5` 4, `m1` 2, `m2` 10, `m3` 2, `m4` 10, `m5` 10, `m6a` 26, `m6b` 38, `m6c` 100, `m6c-typing` 8, `m7` 4, `m8` 36. The tier 3 half of PA-A10 passes. The CI half is CI's `Validate` check at the gate head, which PA-U10 confirms.

## Files

[`pa-u9/eadc1d7/`](pa-u9/eadc1d7/): `environment.json` (machine, observations before each part, departures), `timing/` (403 run records with `runs/files.txt`, `summary.json`, `summary.md`, console), `memory/` (40 run records with `runs/files.txt`, console), `tier3/` (`stages.tsv`, `failures.txt`, console). They are kept as written (`.prettierignore`).

## Verdict

At the gate head `eadc1d7`: PA-A01 miss by 0.1 ms (to the user under PA-Q6), PA-A02 PASS, PA-A03 miss, PA-A04 miss (latency in both variants; the held write and the font-load task in the busy clauses), PA-A05 UNVERIFIED (a possible FAIL on the start-of-GC floor, not computed), PA-A10 tier 3 PASS with CI owed to PA-U10. PA-U10 writes the exit record and asks the gate exceptions on the exit card.
