# A09 memory method (pre-alpha PA-U4)

Status: DRAFT 2026-11-02, Full tier (an acceptance method and its instrumentation). Unit PA-U4 of the [pre-alpha gate plan](pre-alpha-gate-plan.md#4-units-and-order), rendering track (row E33 of [D9](d9-rendering-track.md#status-index)). It turns PA-Q2 (a), which the user chose on 2026-11-02, into a method: the categories, the source of each one's high-water mark, the sum, and the verdict rule for PA-A05. The questions in section 8 are adopted as recommended under the user's standing instructions (2026-10-24, 추천안 자동 채택), except where they say the user decides.

Owners: the pre-alpha plan owns PA-A05 and the 256,000,000-byte bound. The [P1 measurement contract](p1-measurement-contract.md#combined-memory-readiness) owns the category rules (shared and copied storage counted once, JS object overhead included, no subtracted baselines, observations over the ceiling kept). This contract owns how each category is measured on today's code.

## 1. The rule PA-Q2 (a) set

- **Bound.** Combined working memory is at most the sum, over the categories of section 2, of each category's exact high-water mark (HWM) over the scenario. An exact HWM comes from a ledger or an allocator peak. A sampled maximum is not one, because it can miss a peak between samples. The sum bounds the simultaneous peak from above, because no category can exceed its own peak at the moment of the joint peak.
- **Verdict.** PASS when the sum is at most 256,000,000 bytes and every category has an exact HWM. FAIL when the sum of the exact HWMs alone already exceeds the bound. Otherwise UNVERIFIED, naming each category that has no exact HWM.
- **Workload.** `e26-simple-stress-10k/v2` is gated. `e26-mixed-view-edit-10k/v2` is recorded only. Both run in the editor with `ui=1`.

## 2. Categories at `b810f89`

These facts come from the code. The P1 inventory (document, mirror, index, style, CPU geometry, upload, WASM, GPU) maps onto them, together with what P1 did not have: the text atlas, isolation layers, clip masks and autosave copies.

| ID  | Category                          | Where it lives today                                                                                                                                                                                         | Exact HWM source (section 3)                                         |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| M1  | JS heap of the page isolate       | Document, history, scene mirror, index, styles, React and the UI, serialized autosave strings. The engine runs in one isolate: no package creates a `Worker`                                                  | V8 GC trace: `usedHeapSizeBefore` of each GC, and the final used size |
| M2  | ArrayBuffer backing stores        | Typed arrays outside the V8 heap: path-mesh packets, primitive records, upload staging, glyph bitmaps read back from the raster canvas                                                                       | Candidate only: V8 `external_memory` (section 3.2)                    |
| M3  | WASM linear memory                | `geometry-wasm` kernel memory                                                                                                                                                                                  | `memory.buffer.byteLength` at the end (it only grows)                 |
| M4  | GPU buffers and textures          | `renderer-webgpu`: primitive and mesh buffers, records, layer and composite attachments (isolation), mask stencils (clip), the glyph atlas texture, quad geometry                                             | Bench GPU ledger (section 3.3)                                        |
| M5  | Canvas back buffers               | The WebGPU canvas's current texture (width × height × 4 × the swap-chain depth), and the glyph raster `OffscreenCanvas`, at most `CANVAS_GLYPH_RASTER_MAX_EXTENT` (1,024) squared × 4                          | Bound by construction (section 3.4)                                   |
| M6  | IndexedDB write copies            | `persistence-idb` `put(text, key)`: the serialized string while a transaction is pending. The page-side string is in M1. The structured-clone copy is outside the isolate                                       | Bench IDB ledger: the most UTF-16 bytes of pending `put` values       |

Out of scope, as in P1: memory the page cannot own or observe. That covers the browser, GPU and storage processes' own allocations, the compositor, driver-side copies of GPU resources and Blink's DOM and layout. The record names these exclusions. A reader who wants a whole-process number is pointed to the process memory that PA-U4c records as corroboration, which is never a verdict.

## 3. High-water-mark sources

### 3.1 JS heap (M1): the GC trace

V8 frees heap memory only in garbage collection, so between two GCs the used heap size only grows. Its maximum over the window is therefore the largest `usedHeapSizeBefore` over the window's `MinorGC` and `MajorGC` trace events, or the used size at the window's end if that is larger. The trace categories are `devtools.timeline` and `v8`.

A cloud probe on headless Chromium 153 (2026-11-02, this contract's draft) showed that both events carry `usedHeapSizeBefore` and `usedHeapSizeAfter`. `V8.GC_Heap_Stats` also carries `used_heap_size`, `total_heap_size`, `external_memory` and `malloced_memory` per GC.

PA-U4b must confirm three things on the main PC's Chrome and Edge. First, both events arrive for every GC, including incremental and concurrent marking, where a GC's start may be split. Second, sweeping after a major GC only lowers the used size. Third, `total_heap_size` (reserved pages) is what to count, so the count includes heap the isolate holds but has not filled. Recommended: count `total_heap_size` at each GC start, which is the conservative choice (A09-Q1).

### 3.2 ArrayBuffer backing stores (M2): the open category

Typed arrays allocate their backing stores outside the V8 heap. Those stores are released when the GC sweeps array buffers, when they are detached, or when they are transferred. V8 tracks them as external memory. Its per-GC value (`external_memory` in `V8.GC_Heap_Stats`) is reported after the GC, not before it. An exact peak therefore needs one of the following, and PA-U4b tries them in this order:

1. A V8 trace field with the external memory at each GC start. If no such field exists, this route fails.
2. A monotonicity argument like the one in 3.1: if external memory only grows between array-buffer sweeps, its value just before each sweep, plus the final value, is the HWM. That needs the value at the start of each sweep.
3. An engine-side ledger of every typed-array allocation in `renderer-core`, `renderer-webgpu`, `geometry-wasm` and `text-dom`. It would be bench-only and inert without the bench. It counts bytes at construction and stops counting them only when the owner drops its reference. It is exact only if it covers every allocation site, so the ledger would have to come with an audit that lists every site.

If none of these holds on the reference browsers, M2 has no exact HWM, and PA-A05 is UNVERIFIED with M2 named. That outcome is allowed (pre-alpha plan, section 6), and the record says it plainly.

### 3.3 GPU (M4): the bench ledger

An init script that the harness injects only in the memory variant wraps `GPUDevice.prototype.createBuffer` and `createTexture`, and the `destroy` method of the objects they return. It adds `size` for a buffer. For a texture it adds width × height × depth or array layers × bytes per texel of the format, summed over mip levels and multiplied by the sample count, and it subtracts the same amount on `destroy`. The ledger keeps the live total and its maximum.

A resource that is dropped without `destroy` stays counted until the end of the run. That is conservative. The product code is unchanged; the wrapper is the measurement. The count is a lower bound of what the driver allocates, because of alignment and padding. That is the P1 rule, "descriptor capacities", and the record states it.

### 3.4 Canvas back buffers (M5): bound by construction

The WebGPU canvas context holds at most its configured texture plus the browser's swap-chain copies. The bound is the canvas size in device pixels × 4 bytes × 3, a triple-buffering assumption that A09-Q2 sets.

The glyph raster canvas never exceeds 1,024 × 1,024 × 4 bytes. That limit is enforced by `CANVAS_GLYPH_RASTER_MAX_EXTENT` in `canvas-glyph-raster.ts`.

A constant bound counts as an exact HWM here, because it is never below the true peak (A09-Q3).

### 3.5 WASM (M3) and IndexedDB (M6)

WASM linear memory never shrinks, so its final `byteLength` is its HWM.

The IDB ledger is part of the same init script. It wraps `IDBObjectStore.prototype.put`, adds 2 × the string length when the value is a string (structured size otherwise), and subtracts that amount when the transaction completes, errors or aborts. It keeps the maximum.

## 4. Units

| Unit   | Content                                                                                                                                                                                                                                                              | Where                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| PA-U4a | This contract.                                                                                                                                                                                                                                                       | Docs                       |
| PA-U4b | Instrumentation. Add a memory variant to the E26 harness (`E26_MEMORY=1`, never part of a timed run): the init script for the GPU and IDB ledgers, trace capture of the GC events, the WASM length at the end, and the M5 constants. The per-run record gets a `memory` block with each category's HWM and source. Investigate M2 along routes 1 to 3 of section 3.2. Unit tests for the ledger arithmetic, plus a headless smoke run that cannot be evidence. | Cloud, then laptop smoke   |
| PA-U4c | A main-PC sitting in headed Chrome and Edge at DPR 1 and 2, five repetitions of the two workloads with `E26_MEMORY=1`, at the pre-alpha remedies' head (after PA-U1 to U3, as PA-U5 does). The record gives each category's HWM per run, the sum, PA-A05's verdict, and process memory as corroboration. | Main PC, coordinator's slot |

PA-U4b follows the plan's order: it is parallel work that changes no product code. PA-U4c measures final code, so it waits for the remedies.

## 5. Acceptance

| ID      | Criterion                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A09-A01 | Each category in section 2 has its source implemented and named in the record, or the record names it UNVERIFIED with the reason.                                                                         |
| A09-A02 | The ledgers' arithmetic is unit-tested: texture sizes for every format the renderer uses, mip and sample counts, destroy and double destroy, and IDB complete, error and abort.                            |
| A09-A03 | The memory variant changes no document, camera, driver or scene. Its runs are never timed evidence, and the timed scenarios run without it.                                                                |
| A09-A04 | PA-U4c's record gives PA-A05's verdict by section 1's rule, every run kept, with the exclusions of section 2 stated.                                                                                        |

## 6. Gate

PA-U4a merges after independent review and CI. PA-U4b and PA-U4c follow the Full-tier PR format. A09 is decided only by PA-U4c's record, and this contract decides nothing in advance.

## 7. Risks

- **M2 stays open.** If V8 gives no value at each sweep start and the ledger audit cannot cover every site, A09 stays UNVERIFIED. That is allowed, and it is better than accepting a sampled number.
- **The trace changes timing.** Memory runs are separate from timed runs (A09-A03).
- **Browser versions.** The trace event names and arguments are V8 internals. The record names the versions, and a later browser can make the method fail. In that case the method is re-checked, not assumed.

## 8. Open questions

| ID     | Question                                                                    | Options and recommendation                                                                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A09-Q1 | M1: used size or reserved size?                                             | (a) `total_heap_size` (reserved) at each GC start, which is never less than the used size. (b) `usedHeapSizeBefore`. **Recommended (a)**: it is conservative, and memory the isolate holds is memory the page uses. Adopted 2026-11-02 (추천안 자동 채택).                 |
| A09-Q2 | M5: how many swap-chain textures?                                           | (a) Three (the configured texture plus two browser copies), a fixed assumption that the record states. (b) Measure from the GPU process. **Recommended (a)**: the page cannot observe the GPU process, and P1 excluded it. Adopted 2026-11-02 (추천안 자동 채택). |
| A09-Q3 | Does a proven constant bound count as an exact HWM?                         | (a) Yes. It is never below the true peak, so the sum stays an upper bound. (b) No, only ledgers and allocator peaks count. **Recommended (a)**: PA-Q2 (a) asks for an upper bound of the simultaneous peak, and a constant bound keeps it one. Adopted 2026-11-02 (추천안 자동 채택). |

## 9. Validation of this contract

Documentation only: Prettier, local links and independent review. The only run behind it is the cloud GC-trace probe of section 3.1, a diagnostic that is not evidence.

## 10. Progress

- 2026-11-02: drafted (PA-U4a).
