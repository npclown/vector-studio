# A09 memory method (pre-alpha PA-U4)

Status: DRAFT 2026-11-02, Full tier (an acceptance method and its instrumentation). Unit PA-U4 of the [pre-alpha gate plan](pre-alpha-gate-plan.md#4-units-and-order), rendering track (row E33 of [D9](d9-rendering-track.md#status-index)). It turns PA-Q2 (a), which the user chose on 2026-11-02, into a method: the categories, the source of each one's high-water mark, the sum, and the verdict rule for PA-A05. The questions in section 8 are adopted as recommended under the user's standing instructions of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

Owners: the pre-alpha plan owns PA-A05, the 256,000,000-byte bound and the sitting that gives the verdict (PA-U9). The [P1 measurement contract](p1-measurement-contract.md#combined-memory-readiness) owns the category rules (shared and copied storage counted once, same-isolate overhead included, no subtracted baselines, observations over the ceiling kept). This contract owns how each category is measured on today's code and what this contract chooses to exclude.

## 1. The rule PA-Q2 (a) set

- **Window.** From navigation start to the end of the scenario's last step. Tracing and the ledgers of section 3 start before navigation, so document load, scene creation, the first upload and the initial index build are inside the window. P1 names scene creation and mirror publication with the candidate snapshot still live as phases to cover.
- **Bound.** Combined working memory is at most the sum, over the categories of section 2, of each category's exact high-water mark (HWM) over the window. An exact HWM comes from a ledger, an allocator peak or a stated constant bound (A09-Q3). A sampled maximum is not one, because it can miss a peak between samples. The sum bounds the simultaneous peak of the counted quantities from above, because no category can exceed its own peak at the moment of the joint peak. The counted quantities are those of section 3, for example descriptor capacities for GPU resources (the P1 rule), not what a driver allocates.
- **Verdict.** Per run: PASS when the sum is at most 256,000,000 bytes and every category has an exact HWM; FAIL when the sum of the exact HWMs alone exceeds the bound; otherwise UNVERIFIED, naming each category without an exact HWM. PA-A05 takes the largest sum over every run, browser and DPR, with every run kept: it passes only if every run passes.
- **Workload.** `e26-simple-stress-10k/v2` is gated, at DPR 1 and 2. `e26-mixed-view-edit-10k/v2` is recorded only. Both run in the editor with `ui=1`.

## 2. Categories at `b810f89`

These facts come from the code. The P1 inventory (document, mirror, index, style, CPU geometry, upload, WASM, GPU) maps onto them, together with what P1 did not have: the text atlas, isolation layers, clip masks, autosave copies and the editor DOM.

| ID  | Category                    | Where it lives today                                                                                                                                                                                                 | Exact HWM source (section 3)                                   |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| M1  | JS heap of the page isolate | Document, history, scene mirror, index, styles, React and the UI, serialized autosave strings. The engine runs in one isolate: no package and no host app creates a `Worker`                                          | GC trace plus a confirmed in-GC bound (3.1, A09-Q1)            |
| M2  | ArrayBuffer backing stores  | Typed arrays outside the V8 heap: path-mesh packets, primitive records, upload staging, mapped read-back ranges, glyph bitmaps read back from the raster canvas                                                       | Open (3.2)                                                     |
| M3  | WASM linear memory          | `geometry-wasm`: up to three instances (path, fill and stroke adapters), each with its own memory                                                                                                                    | Memory ledger (3.5)                                            |
| M4  | GPU buffers and textures    | `renderer-webgpu`: primitive and mesh buffers, records, layer and composite attachments (isolation, `rgba16float`), mask stencils (clip, `stencil8`), the glyph atlas texture, quad geometry, MSAA at 1 or 4 samples | GPU ledger (3.3)                                               |
| M5  | Canvas back buffers         | The WebGPU canvas's current texture, and the glyph raster `OffscreenCanvas`, at most `CANVAS_GLYPH_RASTER_MAX_EXTENT` (1,024) squared × 4                                                                             | Stated constant bound over the largest canvas size (3.4)       |
| M6  | IndexedDB write copies      | `persistence-idb` `put(text, key)`, always a string: the structured-clone copy while a transaction is pending. The page-side string is in M1                                                                         | IDB ledger (3.5)                                               |
| M7  | Embedder heap               | Blink's Oilpan heap: the DOM of the layer tree and panels with `ui=1`, and other Blink objects the page owns                                                                                                         | Open (3.6)                                                     |

**Exclusions.** These are this contract's own choice, not P1's, and the record names them: memory the page cannot observe or own. That covers the browser, GPU and storage processes' own allocations (including swap-chain copies beyond the one counted in M5), the compositor, driver-side copies and padding of GPU resources, decoded font data and Skia glyph caches (`text-dom` builds a `FontFace`), Blink layout and style data outside the Oilpan heap, and WASM compiled code. A reader who wants a whole-process number is pointed to the process memory that PA-U4c records as corroboration, which is never a verdict.

## 3. High-water-mark sources

### 3.1 JS heap (M1)

The trace categories are `devtools.timeline` and `v8`. A cloud probe on headless Chromium 153 (2026-11-02, this contract's draft) showed that `MinorGC` and `MajorGC` carry `usedHeapSizeBefore` and `usedHeapSizeAfter`, and that `V8.GC_Heap_Stats` carries `used_heap_size`, `total_heap_size`, `external_memory` and `malloced_memory` after each GC. The end-of-window value comes from the DevTools protocol's `Runtime.getHeapUsage` (`usedSize`, `totalSize`), read once after the last step.

Between GCs the reserved heap only grows, because V8 commits pages for new allocations and frees them only in a GC. So the reserved size just before a GC is at least the previous GC's `total_heap_size` plus what was allocated since. That value is not reported directly. Inside a GC, evacuation copies survivors before it frees the source pages, so the peak can sit inside the GC itself.

M1's HWM is therefore exact only if PA-U4b finds one of these on the main PC's Chrome and Edge, tried in this order:

1. A V8 peak counter for committed heap memory (a maximum-committed value) in a trace event or a memory-infra dump. It is an allocator peak and settles M1.
2. Per GC, `max(usedHeapSizeBefore, total_heap_size of the previous GC + bytes allocated since)` plus a confirmed bound on the in-GC transient (for example the size of the space being evacuated), checked against incremental and concurrent marking, where one GC's start can be split.

If neither holds, M1 is UNVERIFIED and the record says so (A09-Q1).

### 3.2 ArrayBuffer backing stores (M2): the open category

Typed arrays allocate their backing stores outside the V8 heap. Those stores are released when the GC sweeps array buffers, or when they are detached, transferred or unmapped. V8 tracks them as external memory. Its per-GC value (`external_memory`) is reported after the GC, and `Runtime.getHeapUsage` gives `backingStorageSize` only at one moment. An exact peak needs one of the following, tried in this order:

1. A V8 trace field with the external memory at each GC start.
2. A monotonicity argument like 3.1's: if external memory only grows between sweeps, its value just before each sweep, plus the end value, is the HWM. That fails when a buffer is detached between sweeps, because memory drops and grows back unseen. PA-U4b must show that the gated path detaches nothing: no `GPUBuffer.unmap` of a mapped range (as in frame capture), no transfer.
3. A bench-only engine-side ledger of every typed-array allocation in `renderer-core`, `renderer-webgpu`, `geometry-wasm` and `text-dom`, inert without the bench. It counts bytes at construction and stops counting them only when the owner drops its reference. It is exact only with an audit that lists every allocation site.

**Attribution.** If PA-U4b shows that M2's source includes WASM memories, M3 is not added again (P1: shared storage counted once).

If none holds, M2 has no exact HWM and PA-A05 is UNVERIFIED with M2 named. That outcome is allowed (pre-alpha plan, section 6).

### 3.3 GPU (M4): the bench ledger

An init script that the harness injects only in the memory variant wraps `GPUDevice.prototype.createBuffer` and `createTexture`, and the `destroy` method of the objects they return. It adds `size` for a buffer. For a texture it adds width × height × depth or array layers × bytes per texel, summed over mip levels and multiplied by the sample count. Bytes per texel are fixed for every format the renderer uses: `rgba16float` 8, `rgba8unorm` and `bgra8unorm` 4, `stencil8` 1. Any other format makes M4 UNVERIFIED for that run. It subtracts the same amount on the first `destroy`, and a second `destroy` changes nothing. The ledger keeps the live total and its maximum. The renderer creates no query sets and imports no external textures today; the ledger counts them as UNVERIFIED if they appear.

A resource that is dropped without `destroy` stays counted until the end of the window, which is conservative. A destroyed resource stops counting at once even if queued work still uses it; that is the descriptor-capacity rule of section 1, and the record states it.

### 3.4 Canvas back buffers (M5): a stated bound

The ledger also wraps `GPUCanvasContext.getCurrentTexture` and keeps the largest texture width × height seen. The WebGPU canvas is bounded by that size × 4 bytes × 3, a triple-buffering assumption that A09-Q2 sets and the record states. It is a stated bound, not a proven one: the copies beyond the first live in the GPU process.

The glyph raster canvas never exceeds 1,024 × 1,024 × 4 bytes. `canvas-glyph-raster.ts` refuses larger requests (`CANVAS_GLYPH_RASTER_MAX_EXTENT`), and the canvas grows only to the largest request.

### 3.5 WASM (M3) and IndexedDB (M6)

The init script wraps `WebAssembly.instantiate`, `instantiateStreaming` and the `WebAssembly.Memory` constructor and keeps a reference to every memory created or exported. Linear memory never shrinks, so each memory's HWM is its `byteLength` at the end, and M3 is the sum over every memory, including ones the product has dropped. Keeping a dropped memory alive changes its lifetime only in the memory variant.

The IDB ledger wraps `IDBObjectStore.prototype.put`. It adds 2 × the string length, subtracts it when the transaction completes, errors or aborts, and keeps the maximum. A non-string value makes M6 UNVERIFIED for that run.

### 3.6 Embedder heap (M7): the open category

Blink's Oilpan heap is page memory, and with `ui=1` it holds the editor's DOM. `Runtime.getHeapUsage` gives `embedderHeapUsedSize` only at one moment. PA-U4b looks for a trace source that gives its value at each Oilpan GC start or a peak counter, with the same argument as 3.1. If none exists, M7 is UNVERIFIED and named.

## 4. Units

| Unit   | Content                                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| PA-U4a | This contract.                                                                                                                                                                                                                                                                                                                                                                                                                              | Docs                        |
| PA-U4b | Instrumentation. Add a memory variant to the E26 harness (`E26_MEMORY=1`, never part of a timed run): the init script for the GPU, canvas, WASM and IDB ledgers, GC trace capture reusing the `E26_TRACE` path, and the end-of-window `Runtime.getHeapUsage` read. The per-run record gets a `memory` block with each category's HWM and source, or UNVERIFIED and why. Investigate M1, M2 and M7 along their routes. Unit tests for the ledger arithmetic, plus a headless smoke run that cannot be evidence. | Cloud, then laptop smoke    |
| PA-U4c | Method validation: a main-PC run in headed Chrome and Edge at DPR 1 and 2 with `E26_MEMORY=1` on both workloads, at any head. It shows each source works on the reference browsers and settles which routes of section 3 hold. It gives no PA-A05 verdict.                                                                                                                                                                                  | Main PC, coordinator's slot |

PA-U9, the plan's pre-alpha sitting, runs the memory variant at the remedies' head and gives PA-A05's verdict by section 1's rule. PA-U4b and U4c change no product code and run in parallel with the remedies, as the plan's PA-U4 row allows.

## 5. Acceptance

| ID      | Criterion                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A09-A01 | Each category in section 2 has its source implemented and named in PA-U4c's record, or the record names it UNVERIFIED with the reason.                                                                       |
| A09-A02 | The ledgers' arithmetic is unit-tested: every format of 3.3 and an unknown one, mip and sample counts, destroy and double destroy, the canvas maximum, the WASM sum, and IDB complete, error, abort and non-string. |
| A09-A03 | The memory variant changes no document, camera, driver or scene. Its runs are never timed evidence, and the timed scenarios run without it.                                                                  |
| A09-A04 | PA-U9's record gives PA-A05's verdict by section 1's rule, every run kept, with the exclusions of section 2 stated.                                                                                          |

## 6. Gate

PA-U4a merges after independent review and CI. PA-U4b and PA-U4c follow the Full-tier PR format. A09 is decided only by PA-U9's record, and this contract decides nothing in advance.

## 7. Risks

- **M1, M2 or M7 stays open.** If no exact source holds, A09 stays UNVERIFIED. That is allowed, and it is better than accepting a sampled number.
- **The trace and ledgers change timing and lifetimes.** Memory runs are separate from timed runs (A09-A03), and kept WASM memories only raise M3.
- **Browser versions.** Trace event names and arguments are V8 and Blink internals. The record names the versions, and a later browser can make the method fail. In that case the method is re-checked, not assumed.

## 8. Open questions

| ID     | Question                                         | Options and recommendation                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A09-Q1 | M1: what counts as the JS heap's exact HWM?      | (a) Reserved (committed) size, from a peak counter or the per-GC rule of 3.1 with a confirmed in-GC bound; UNVERIFIED otherwise. (b) The largest `usedHeapSizeBefore`. **Recommended (a)**: memory the isolate holds is memory the page uses, and (b) misses both reserved pages and the in-GC peak. Adopted 2026-11-02 (추천안 자동 채택). |
| A09-Q2 | M5: how many swap-chain textures?                | (a) Three (the configured texture plus two browser copies), a fixed assumption that the record states. (b) Count only the configured texture and exclude the copies as GPU-process memory. **Recommended (a)**: it keeps the sum an upper bound for a typical swap chain at a cost of two canvases. Adopted 2026-11-02 (추천안 자동 채택).   |
| A09-Q3 | Does a stated constant bound count as exact?     | (a) Yes, when the record states it and its assumption, so the sum stays an upper bound under that assumption. (b) No, only ledgers and allocator peaks count. **Recommended (a)**: PA-Q2 (a) asks for an upper bound of the simultaneous peak, and a stated bound keeps one. Adopted 2026-11-02 (추천안 자동 채택).                        |

## 9. Validation of this contract

Documentation only: Prettier, local links and independent review. The only run behind it is the cloud GC-trace probe of section 3.1, a diagnostic that is not evidence.

## 10. Progress

- 2026-11-02: drafted (PA-U4a). Review round 1: window defined, M1 route and Q1 reworded, PA-U4c made a method validation with PA-U9 giving the verdict (the plan's PA-A05 row), M3 covers every WASM memory, M5 a stated bound over the largest canvas, embedder heap added as M7, exclusions stated as this contract's own, M2 detach and attribution rules, verdict over all runs.
