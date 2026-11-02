# PA-U4c memory method validation at `8d873e8` (2026-11-02)

Unit PA-U4c of the [A09 memory method contract](../../../plans/pa-u4-a09-memory-method.md#4-units): the memory variant (`E26_MEMORY=1`) headed on the main PC, to check each source and the trace routes. This record holds raw observations only. It is not timed evidence and gives no PA-A05 verdict.

## Run

- **Commit.** `8d873e8` (main, after #468 and #469). The tree was clean apart from three untracked local paths that predate the run and are not part of it (`.claude/launch.json`, `artifacts/`, `docs/evidence/e3-a04-readback-2026-10-24/`). Before the run: `pnpm install --frozen-lockfile`, then `pnpm build`.
- **Command.** `E26_MEMORY=1 E26_REPETITIONS=5 E26_RESULTS_DIR=test-results/pa-u4c E26_SCENARIOS=e26-simple-stress-10k/v2,e26-mixed-view-edit-10k/v2 pnpm exec playwright test --config playwright.e26.config.ts --project chrome-dpr1-v2 --project chrome-dpr2-v2 --project edge-dpr1-v2 --project edge-dpr2-v2`.
- **Time.** 2026-11-02 21:56:00Z to 22:11:53Z (Playwright: 15.9 min).
- **Result.** 40 passed, 0 failed, 0 skipped; exit 0. Nothing was repeated or replaced. The console log is [`console.log`](console.log).
- **Machine.** The main PC (DESKTOP-DKVUSAV): GTX 1660 SUPER (driver 32.0.16.1088), Ryzen 7 3700X, 31.9 GB RAM, Windows build 26200, Balanced power plan, one 1920 × 1080 display at 60 Hz. Chrome 156.0.8078.74 and Edge 156.0.4314.58, Node v24.22.1.
- **Background load.** The user's own apps stayed open and were not closed: Chrome (19 processes, the user's profile), VS Code, TradingView, Telegram, Notepad, Calculator, Settings, Task Manager, Windows Terminal and the Claude app. There was no Edge process. CPU averaged 14.5 % over 10 s, peaking at 32 %.

## Files

- [`runs/`](runs/): the 40 records (`*--memory.json`), listed in `runs/files.txt`.
- [`runs.tsv`](runs.tsv): one row per record, written by [`pa-u4c-tsv.mjs`](pa-u4c-tsv.mjs).
- [`findings.json`](findings.json): the raw output of [`pa-u4c-investigate.mjs`](pa-u4c-investigate.mjs). The script streams all 40 raw traces in `test-results/pa-u4c/memory-traces/`, one event per line.
- [`traces/`](traces/): two raw traces gzipped, stress r1 in chrome-dpr1-v2 and in edge-dpr1-v2 (0.76 MB each). The other 38 traces stay on the PC and are not committed.

## Per-project summary

M1 to M5 are in MiB, the range over five runs. Every run's verdict is UNVERIFIED with `unverified` = M1, M2 and M7. The statuses are the same in all 40 runs: M1 candidate, M2 unverified, M3 exact, M4 exact, M5 stated-bound, M6 exact (0 bytes, no IDB put), M7 unverified.

| Project | Scenario | M1 | M3 | M4 | M5 | GCs (major) | usedMismatch | usedDelta min / max (bytes) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | stress | 164.3–164.5 | 2.1 | 21.6 | 14.5 | 183 (1) | 0–2 | −3,064 / 0 |
| chrome-dpr1-v2 | view-edit | 210.5–295.5 | 33.2 | 50.5 | 14.5 | 324–327 (4–7) | 0–4 | −344,220 / 0 |
| chrome-dpr2-v2 | stress | 163.9–165.5 | 2.1 | 74.3 | 46.2 | 183 (1) | 1–2 | −269,856 / 0 |
| chrome-dpr2-v2 | view-edit | 275.3–288.3 | 33.4 | 103.4 | 46.2 | 335–336 (4) | 0–3 | −363,216 / 83,412 |
| edge-dpr1-v2 | stress | 163.9–166.0 | 2.1 | 21.6 | 14.5 | 183 (1) | 0–2 | −445,960 / 362,820 |
| edge-dpr1-v2 | view-edit | 213.8–293.6 | 33.2 | 50.5 | 14.5 | 326–329 (4–8) | 2–3 | −344,944 / 0 |
| edge-dpr2-v2 | stress | 164.1–166.0 | 2.1 | 74.3 | 46.2 | 183 (1) | 0–4 | −86,348 / 406,476 |
| edge-dpr2-v2 | view-edit | 273.0–308.9 | 33.4 | 103.4 | 46.2 | 331–340 (4) | 1–3 | −475,620 / 0 |

- **Every run:**
  - `gc.unpaired` 0 and `gc.otherThreads` 0;
  - GPU `unknownFormats` empty, `querySets` 0, `externalTextures` 0;
  - two WASM memories and 0 IDB puts;
  - canvas maximum 1280 × 720 at DPR 1 and 2560 × 1440 at DPR 2.
- **Values that do not vary across runs:**
  - `exactSumBytes` is the same in every run of a project and scenario: 40,108,077 (stress, DPR 1), 128,581,677 (stress, DPR 2), 102,960,491 (view-edit, DPR 1) and 191,859,716 (view-edit, DPR 2).
  - Canvas reads are 904 in every stress run and 658 to 688 in view-edit.
  - GPU textures and buffers are 3 and 3 in every stress run; in view-edit, textures are 5,357 to 5,598 and buffers 669 to 698.

## 4a. Trace event names

165 distinct names contain GC, Heap, cppgc, Oilpan, BlinkGC or Memory, counted over all 40 traces. The full list with phase counts is `a_names` in [`findings.json`](findings.json).

- **Names of these words that do not occur.** No name contains `Oilpan` or `BlinkGC`. Blink's GC is the `CppGC.*` family (category `cppgc` and `disabled-by-default-cppgc`).
- **Main-GC and heap-stats names:**
  - `MinorGC` 10,170 (X);
  - `MajorGC` 108 (107 X, 1 B);
  - `V8.GC_Heap_Stats` 10,277 (I);
  - `V8.GCTraceGCNVP` 10,277 (I);
  - `V8.GC_HEAP_DUMP_STATISTICS` 10,277;
  - `V8.GCScavenger` 10,170;
  - `V8.GCFinalizeMC` 108;
  - `V8.GC_MARK_COMPACTOR` 108.
- **Incremental marking:**
  - `V8.GCIncrementalMarking` 7,151;
  - `V8.GC_MC_INCREMENTAL` 21,451 (X, s, f);
  - `V8.GCIncrementalMarkingStart` 109;
  - `CppGC.IncrementalMark` 7,382;
  - `CppGC.MarkIncrementalStart` 109.
- **Other cppgc:**
  - `CppGC.MarkTransitiveClosure` 8,313;
  - `CppGC.AtomicMark` 1,255;
  - `CppGC.ConcurrentMark` 1,453;
  - `CppGC.IncrementalSweep` 3,095;
  - `CppGC.SweepOnAllocation` 2,244;
  - `CppGC.AtomicSweep` 214;
  - and others.
- **Memory:**
  - `GlobalMemoryDump` 64 (b/e);
  - `GlobalMemoryDump.Computation` 288;
  - `AcquiredForGC` 590 (b/e/n).

## 4b. memory-infra

- **No memory dump events.** No trace has an event with `ph: "v"` (0 events in 40 traces), so there are no `args.dumps.allocators` and no v8, blink_gc, partition_alloc or malloc allocator attributes to list.
- **The memory-infra events that do occur.** These are in category `disabled-by-default-memory-infra`, in the browser process:
  - `GlobalMemoryDump` (b/e): its args are `dump_guid`, `dump_type: "summary_only"`, `level_of_detail: "background"` and `success`;
  - `GlobalMemoryDump.Computation`, with empty args.
- **Why there are no process dumps.** The dumps that were taken are summary-only background dumps, which put no per-process dump into the trace.
- **The peak-like value that does exist** is outside memory-infra: `V8.GC_Heap_Stats` `args.stats` carries `peak_malloced_memory` (see 4c).

## 4c. Heap-size args

- **cppgc carries no heap size.** No `CppGC.*` event has a heap-size argument: their args are `epoch` and `forced` (for example `CppGC.AtomicMark` and `CppGC.IncrementalMark`). Blink's heap size reaches the trace only through V8's events below.
- **Events whose args carry sizes:**
  - `MinorGC` and `MajorGC`: `args.usedHeapSizeBefore` and `args.usedHeapSizeAfter`, plus `args.type`. The one `MajorGC` with ph B has only `usedHeapSizeBefore`.
  - `V8.GC_Heap_Stats`: `args.stats`, a JSON string with these keys:
    - `isolate`, `id`, `time_ms`;
    - `total_heap_size`, `total_heap_size_executable`, `total_physical_size`, `total_available_size`, `used_heap_size`, `heap_size_limit`;
    - `malloced_memory`, `peak_malloced_memory`, `external_memory`;
    - `spaces[]`, each with `name`, `size`, `used_size`, `available_size` and `physical_size`.
  - `V8.GCTraceGCNVP`: `args.value`, a JSON string. Its size keys include:
    - `start_object_size` / `end_object_size`;
    - `start_memory_size` / `end_memory_size`;
    - `start_holes_size` / `end_holes_size`;
    - `start_old_gen_consumed_size` / `end_old_gen_consumed_size`;
    - `start_global_consumed_size` / `end_global_consumed_size`;
    - `allocated`, `promoted`, `new_space_size`, `new_space_capacity`, `new_space_survived`, `old_gen_allocation_limit` and `global_allocation_limit`.

    The full key list is `c_stringifiedSizeArgs` in `findings.json`.
  - `V8.GCEvaluateOldSpaceLocalPretenuring`: `args.value.size_of_objects_before_gc` and `size_of_objects_after_gc`.
  - `V8.GCUpdateAllocationLimits` (`args.value`): `embedder_size_at_last_gc`, `global_consumed_bytes`, `external_memory_low_since_last_gc` and allocation limits.
- **Peak-like and committed-like fields:**
  - `peak_malloced_memory` in `V8.GC_Heap_Stats` is the only peak field. It is malloc'd memory, not the JS heap.
  - `total_physical_size` is the committed-like size.

  Main-thread maxima per run are in `c_mainThreadHeapStatsMaxima`. `peak_malloced_memory` is about 7.1 MB in every stress run and 22.7 to 27.1 MB in view-edit. The maximum `total_physical_size` is 140.6 to 142.8 MB in stress and 185.3 to 289.7 MB in view-edit.

## 4d. Pairing

One stress r1 run per browser (`d_pairing` in `findings.json`), main thread only:

| Run | GCs (X) | MinorGC | MajorGC | `V8.GC_Heap_Stats` | GCs with 1 stats | with 0 | with more | stats inside the GC span |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 stress r1 | 183 | 182 | 1 | 183 | 183 | 0 | 0 | 183 of 183 |
| edge-dpr1-v2 stress r1 | 183 | 182 | 1 | 183 | 183 | 0 | 0 | 183 of 183 |

- **Pairing holds.** Every `MinorGC` or `MajorGC` has exactly one `V8.GC_Heap_Stats`, emitted inside its `X` span, and no stats event precedes the first GC. Neither run has a main-thread GC on another thread (`otherThreadGcs` 0).
- **GC events with a ph other than X.** Over all 40 traces there is one: a `MajorGC` with `ph: "B"` and no matching end, in `edge-dpr2-v2--e26-mixed-view-edit-10k_v2--r4`. Its args are `type: "finalize incremental marking via task"` and `usedHeapSizeBefore: 209134016`.
  - It looks like a major GC that was still running when the trace stopped.
  - The summarizer counts only `X` GCs, so this record shows 335 GCs and 4 majors with `unpaired` 0, and that GC's after-sizes are missing from the record.
  - A few other `MajorGC`-family names (`V8.GCFinalizeMC`, `V8.GC_MARK_COMPACTOR`, `V8.GC_MC_MARK`) also have the single `B` from the same GC.
- **Incremental marking splits a major GC.**
  - In each run, one `V8.GCIncrementalMarkingStart` (with `CppGC.MarkIncrementalStart`) starts the cycle.
  - Then come 74 (Chrome) or 72 (Edge) `V8.GCIncrementalMarking` steps, each with a `V8.GC_MC_INCREMENTAL` and a `V8.GC_MC_INCREMENTAL_EMBEDDER_TRACING`, alongside 75 or 73 `CppGC.IncrementalMark` steps.
  - The cycle ends with the one `MajorGC` `X` event, whose span holds `V8.GC_MC_MARK_FINISH_INCREMENTAL`.
  - Outside the MajorGC span lie 462 (Chrome) and 449 (Edge) incremental-marking events; 10 and 9 lie inside it.
  - So the marking work of a major GC is spread over many steps between mutator tasks before the atomic pause. The `MajorGC` event's `usedHeapSizeBefore` is the size at the final pause, not at the start of marking. Minor GCs run in between: 182 of them in a run with one major.

## 4e. Raw trace sizes

There are 40 traces, 8,811,614 to 12,712,251 bytes each and 420,107,948 bytes in total (`e_sizes` in `findings.json`):

- stress: 8.8 to 9.4 MB;
- view-edit: 11.5 to 12.7 MB.

Gzipped with `gzip -9`, chrome-dpr1-v2 stress r1 is 760,365 bytes and edge-dpr1-v2 stress r1 is 761,573 bytes. Both are under 20 MB and are committed in `traces/`.
