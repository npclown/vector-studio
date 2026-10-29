# E26 contract: pointer priority and the 10,000-node workload

Status: APPROVED 2026-10-29 after independent review round 3 (recommended options auto-adopted, section 10), Full tier (rendering-track table). It does not change the [D9 shared surface](d9-post-mvp1-tracks-proposal.md#boundary): no `packages/contracts` export, no member of a renderer-core or renderer-webgpu root export, and no operation identity changes (E26-Q1 (a)). Test seams are module-level functions that the package `index.ts` files do not export, as `setNextGeometryRevisionForTesting` is, and the benchmark hooks use only members that exist today (section 3.3). Parts of E26 change files that the visualization track owns (`packages/editor-core`, `packages/react`, `packages/persistence-idb`, `apps/next-host`), and those parts follow the D9 conflict rule (E26-Q4, section 7).

This is rendering-track item [E26](d9-rendering-track.md#status-index) and MVP rendering need R-P ([MVP plan, section 5](mvp-editor-plan.md#5-rendering-track-needs)). MVP M9 runs the committed benchmarks; E26 makes them passable and gives M9 the workloads, the harness and the method.

Owners:

- This file owns the E26 workloads, their measurement method, the scene-set cost rules, the batched isolation procedure (through the M1 amendment of U3) and the background-work rule.
- [`docs/requirements.md`](../requirements.md) (Platform and performance) owns the requirements, and [`docs/prototype-plan.md`](../prototype-plan.md) (P1 exit gate) owns the 16.7 ms, 33.3 ms and 50 ms numbers. E26 reads the requirements as E26-Q6 states and uses the numbers unchanged.
- [`docs/benchmarks/README.md`](../benchmarks/README.md) owns the measurement rules. E26 adds scenarios under them and no new rule.
- The [M1 contract](mvp-m1-document-v2-contract.md), section 5, owns projection and isolation. U3 amends its isolation procedure and keeps its result.
- The [M5 contract](mvp-m5-persistence-contract.md) owns autosave (M5-S1, M5-S2). U6a amends M5-S1 for gestures.
- P1 keeps A09 (memory) and A10 (pointer to physical presentation). E26 closes neither (E26-Q3).

## 1. Problem

The [M1-A13 observation](../evidence/m1-a13-observation-2026-10-28.md) timed the 10,000-node document of `tests/m1-a13/document.ts` (seed `0x6d31a13`, 10,634 scene nodes on page 1) in a shared cloud container, on the CPU only:

| Step | Median | Of which renderer-core mirror |
| --- | ---: | ---: |
| One gesture update (pointer move) | 77 ms | about 58 ms |
| Commit (pointer up) | 155 ms | 116 ms |
| Attach (first snapshot) | 119 ms | 95 ms |
| Forced isolation, 9,250 one-unit sets, all accepted | 298 s | 99.9 % |

The causes, read from the code at `fe2e195`:

- **Every scene set costs the whole page.** `RetainedSceneMirror.applyChanges` (`packages/renderer-core/src/scene-mirror.ts`) copies the node map (`applyCandidate`), checks finite world arithmetic over every node (`hasFiniteSceneArithmetic`, `scene-numeric.ts`), builds a key set of every node (`validateOperations`) and runs `validateCandidateGraph` (`scene-validation.ts`: sorted passes, parent cycles, order consistency, the clip and isolation depth walk) over the whole candidate. `#publishScene` then copies the map again, sorts every key and compares every path node in `assignGeometryRevisions`, and materializes the sorted `nodes` array of the published view. A one-node set is O(n log n).
- **Isolation is quadratic.** After a rejected multi-unit set the projector (`SceneProjector`, `packages/editor-core/src/projector.ts`, `isolate` and `addUnits`) sends an empty snapshot and then one set per unit. With the cost above that is O(n² log n). The number of sets is not itself the problem; the cost per set is (section 4.2).
- **Every document change re-projects the whole page.** `SceneProjector.change` calls `sync(this.project(...))`, which projects and compares the whole active page. The whole editor side of a gesture update, this diff included, is about 19 ms.
- **Every frame prepares the whole scene.** `PrimitiveSceneSource.prepare` (`primitive-scene-source.ts`) walks the whole retained scene (`derivePrimitives`, `cullPrimitives`) on each invalidated frame, and a zoom across a path tolerance bucket re-tessellates paths. No 10,000-node mixed-scene frame has been timed on the reference PC. The P1.6b headless functional runs (2026-09-26, packet v1, 1280×720, four intervals each) had a `rafCallbackIntervalMs` median of 116.6 ms for `p1-pan-zoom-10k/v1` and 50 ms for `p1-cull-10k/v1` ([raw records](../evidence/p1.6b/20260926-functional/raw/20260926-final-functional/)). They are functional runs, not evidence, but they point the same way.
- **Nothing gives the pointer priority.** `packages/react/src/canvas-input.ts` executes each pointer event synchronously. An autosave write that comes due serializes the whole document on the main thread (`serializeEnvelope` in the store's write, `packages/persistence-idb`), even mid-drag. Isolation runs inside the command that triggered it.

## 2. Scope

In scope:

- Five benchmark workloads, their harness and method (section 3), and CPU counters that CI can check.
- Scene-set cost proportional to the set and the subtrees it changes (section 4.1), in `renderer-core`.
- Batched isolation with the M1 result, only if U2's numbers call for it (section 4.2), and change-scoped projection (section 4.3), in `editor-core`.
- Frame preparation proportional to what changed, only if U1's baseline calls for it (section 4.4).
- The pointer-priority rule for background work (section 5).

Out of scope:

- Changing what any scene draws. Every capture stays identical (E26-A08).
- P1 A09 memory and A10 physical presentation (E26-Q3), P2 A08.
- Worker or `OffscreenCanvas` rendering, and moving the editor off the main thread.
- Lower-tier hardware (MVP plan: after the MVP).
- Changing the M1 isolation result, the scene contract or the rejection reasons.

## 3. Workloads and method

### 3.1 Scenarios

Each scenario has a stable ID and version, a seed and a configuration hash ([benchmarks README, Scenario identity](../benchmarks/README.md#scenario-identity)). The fitted camera `F` of a page is the camera whose viewport holds the world bounds of every scene node of the page with a 10% margin on each side.

| ID | Document and camera | Interaction | Target |
| --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v1` | The M1-A13 document (seed `0x6d31a13`), page 1, a fixed camera at zoom 1 over a region chosen by U1 that contains the M1-A13 move selection and in which 900 to 1,100 scene nodes are visible (the typical view, as P1 Scene 3) | The edit drag (section 3.3) of the M1-A13 move selection | `rafCallbackIntervalMs` ≤ 16.7 ms (E26-A02) |
| `e26-mixed-all-edit-10k/v1` | As above, camera `F`: all 10,634 scene nodes visible (the worst case) | The edit drag | ≤ 33.3 ms (E26-A03) |
| `e26-mixed-all-pan-10k/v1` | As above, camera `F` | The pan and zoom path (section 3.3) | ≤ 33.3 ms (E26-A03) |
| `e26-simple-stress-10k/v1` | 10,000 nodes at `p1-pan-zoom-10k/v1`'s positions, sizes and seed as a v5 document, one page, through the editor and `apps/next-host`, with reduced styles: P1's lines (`i % 4 = 3`) become 3.5 × 1 rectangles centred on the line, every node keeps P1's opacity `0.5 + 0.25·(i % 3)` and fill colour, and no node has a stroke, clip or text | The pan and zoom path | ≤ 33.3 ms (E26-A03) |
| `e26-pointer-busy-10k/v1` | The typical view of `e26-mixed-view-edit-10k/v1` | The latency drag (section 3.3) while background work is due: a `setFill` command on a node outside the selection 100 ms before pointer down, so its autosave trailing write (500 ms) comes due mid-drag; and a one-time injected rejection (section 3.4, `reject-mode` recorded in the configuration) of a node the drag moves, armed at 1.0 s, so the next gesture-update set (two units) is rejected and isolates. No command is issued during the drag, because every command interrupts the gesture | `pointerToWorkDoneMs` < 50 ms; no long task over 50 ms other than the marked isolation (E26-A04, A05) |

The stress scene reuses P1's positions so its layout matches a known P1 scene, with simple styles as the requirement says, and it runs through the editor and the host, because the requirement is about the editor. Version 1 of `e26-pointer-busy-10k/v1` has no text: E28's raster budget under load needs a text node on the same page and a real font-load generation change through the layout port, which needs M6c's text projection. That is `e26-pointer-busy-10k/v2`, added after M6c merges, so the composition of v1 does not depend on when M6c merges. Until then E28's per-frame bound rests on E28's own evidence.

### 3.2 Metrics

- **`rafCallbackIntervalMs`**: the interval between successive render-loop rAF callback timestamps, each with one successful submission, as in P1 A08. Each repetition reports median, p95 and p99 by nearest rank. A ceiling passes when the **maximum per-run p95** is at or below it, with no rounding allowance (P1 measurement contract).
- **`pointerToWorkDoneMs`**: from the `timeStamp` of the oldest event that a dispatched `pointermove` coalesced (`getCoalescedEvents()[0]`, or the event itself) to the resolution of `queue.onSubmittedWorkDone()` for the first submission whose packet carries a scene revision at or after the revision that input produced. The revision is the content correlation. A move that produces no new revision (a gesture update that changes nothing) has no endpoint: it is excluded from the percentiles and counted as `no-change`. This is a named proxy, not presentation (E26-Q3), and its 50 ms bound is the A10 number, not A10.
- **Frame CPU split**, per frame, for diagnosis only: input handling with editor subscribers and overlay updates, projection, scene-set apply, prepare (with path re-tessellation separate), encode and submit.
- **Long tasks** from a `PerformanceObserver` over the window. Isolation is wrapped in `performance.mark` and `performance.measure` (`e26-isolation`), so the one allowed long task is identified by overlap. Unavailable is recorded as unavailable.
- **Counters** (section 4.1): node visits per applied set, sets per isolation, full-path fallbacks. They need no clock, so CI checks them.

### 3.3 Drivers, cadence and window

- **Frame scenarios** (`rafCallbackIntervalMs`) follow P1: continuous render mode for the run, 5 s warm-up and the half-open window `[5000, 15000)` ms of one uninterrupted trajectory, and interaction updates applied inside the backend's own rAF callback before prepare, with no second animation loop. The benchmark driver runs at the start of each render callback by wrapping the `animationFrameClock` that the host already passes in `WebGpuBackendOptions`; the metrics come from the existing `getFrameMeasurements()`, `getStatistics().framesSubmitted`, `waitForSubmittedWork()` and the service's synchronization state. All of it lives in `apps/next-host`, so no root export changes.
  - The **edit drag** dispatches one synthetic pointer move per callback through `CanvasInput`, along `p(t) = start + (40·sin θ(t), 30·(cos θ(t) − 1))` CSS px with P1's `θ(t)`, after one pointer down in the warm-up; the pointer up is after the window.
  - The **pan and zoom path** sets the camera per callback with `setViewport`: position `F.position + 0.05 · F.viewport · (sin θ, cos θ − 1)` and zoom `F.zoom · (0.95 + 0.05 · cos θ)`. Here `F.viewport` is the viewport size in world units at `F`, the camera position is the viewport's top-left corner, and the 10% margin is 10% of the viewport on each side. The zoom factor stays in [0.90, 1.0], so the viewport only grows, and with `c = cos θ` the bottom edge moves to `−0.05·(1 − c) + 1/(0.95 + 0.05·c)` viewports, which is at least 1 for every `c`; the right edge stays at or beyond 0.95 of the viewport, inside the margin; the top edge only moves up, and the left edge moves right by at most 0.05 of the viewport, inside the margin. Every node stays visible; U1 also asserts, for every measured frame, that the culled count is zero. The edit drag moves the selection by at most 60 CSS px, inside the margin at `F`.
- **The latency scenario** uses real input: Playwright `page.mouse` (CDP `Input.dispatchMouseEvent`) at a fixed 8 ms cadence for 4 s, on-demand render mode as in production. Chromium aligns `pointermove` dispatch to frames and coalesces the rest, which `getCoalescedEvents` exposes.
- **Benchmark flag.** The harness runs `apps/next-host` with `?bench=1`, which installs the driver and the metric hooks and leaves frame capture off. `?test=1` is not used, because its frame capture changes the canvas configuration (`COPY_SRC`) that is measured.

### 3.4 Injected rejection

A valid document never makes the real renderer reject a set, so the scenarios and tests inject it:

- **Headed.** Under `?bench=1&reject=<id>` the host wraps the renderer service so that the first set holding scene node `<id>` after the wrapper is armed is rejected once with `invalid-value` (as M1-A13 does), or, with `&reject-mode=persistent`, every set holding it. The scenario arms it at a fixed time. A persistent rejection is the worst case for isolation; a one-time one is what M1-A13 measured.
- **CI.** Wrappers around `RetainedSceneMirror` corrupt the chosen units' snapshots into real rule violations, so the mirror's own rules reject them: a mask source of an unsupported kind, a clip depth or isolation depth past its limit, and a transform whose world bounds are not finite. A pure predicate injection is also run, but it cannot test batch closure (section 4.2).

### 3.5 Runs

- **Reference PC.** Headed Chrome and Edge on the main PC (DESKTOP-DKVUSAV), refresh rate recorded, 1280×720 CSS at DPR 1 and 2, five repetitions per scenario, browser and DPR. Runs go through the coordinator's PC queue. Hidden, occluded or throttled runs are kept and investigated, never replaced silently.
- **Baseline.** The baseline is pinned to U1c's merge commit, before any remedy. It runs on the reference PC when the PC is free; U2 and U4 do not wait for it, because their acceptance is the CPU counters and differentials of section 6, and their timing is reported against the pinned baseline afterwards.
- **CPU observation.** `pnpm observe:m1-a13` keeps running in a container and gains the counters. U3 updates its isolation assertions (section 4.2). It stays an observation: only the reference PC makes performance claims.

## 4. Cost rules

### 4.1 Scene sets proportional to the change (renderer-core)

Let a set insert, update or remove k nodes in a scene of n nodes and depth d, and let S be the summed size of the subtrees whose world inputs the set changes: those of updated containers whose transform, visibility, opacity or clip changes, of reparented nodes, and the children of removed containers. `RetainedSceneMirror.applyChanges` must cost O(k · (d + log n) + S) node visits instead of O(n log n). `replaceSnapshot` stays O(n log n).

- **Same verdicts.** For every change set, the incremental mirror returns the same `SceneApplyResult` (status, reason, current version) and publishes the same scene, geometry revisions included, as the full validator. The full validator stays in the module as the oracle, called by tests only.
- **What is checked incrementally.**
  - Shape of the inserted and updated nodes, and operation conflicts against an id index.
  - Finite world transforms and world bounds for the changed nodes and every node of S, per node, as the oracle checks them.
  - Parent existence and acyclicity along the changed nodes' ancestor chains, and invalid parents for the children of removed containers.
  - Order consistency, unknown children and occurrence on the old and the new parent of every inserted, updated and removed node, and on every container whose children change.
  - The clip graph: mask-source rules for the changed nodes and the masks above them, and clip and isolation depth for the changed nodes and every node of S.
- **Publication.** No set sorts or copies the whole node map. Geometry revisions are assigned to the changed path nodes only, in the same id order as today. `RetainedSceneView`, a root export, keeps its type, members and meaning; its sorted `nodes` array is materialized lazily, at most once per published version and only when read. A published view stays immutable after later sets apply (a persistent map or copy-on-write). Prepare reads it every frame today, so its O(n) moves to the frame path, which section 4.4 owns.
- **Counters.** A module-level test seam, not exported from `index.ts`, counts node visits per set, so CI checks the bound without timing.

### 4.2 Batched isolation (editor-core, conditional)

With section 4.1, one-per-unit isolation costs about n · (d + log n) node visits, the same order as batching. So U2 first times one-per-unit isolation of the M1-A13 page with a one-time and with one persistent injected rejection, in a container, as the ratio to R of E26-A06. U3 runs only if either ratio misses A06's relative bound; otherwise U3 records the numbers and is dropped, and the reference PC checks A06 later.

If U3 runs, the projector reaches the **same** result as M1 section 5 isolation: the same excluded units, the same scene nodes and orders, and the same rejection reports in the same order. Revision numbers may differ; geometry revisions are compared per node as "changed or not since the previous snapshot". The procedure:

1. Send the empty snapshot, as today. A bookkeeping rejection (`stale-snapshot`, `revision-conflict`) raises the revision and retries, as today, and never bisects.
2. Keep a queue of contiguous pre-order segments of the page's units, starting with one segment of all units. Take the first segment and drop from it every unit whose parent unit is dead (rejected, removed with its subtree, or dropped here); a dropped unit is itself dead.
3. Build its set as the union of its units' one-unit sets, with orders merged: a container inserted in the same set carries its children in its own `children`, and one order entry is sent per scene parent outside the set, holding the parent's children in projection order, filtered to held units and the set's units.
4. On `applied`, continue with the next segment. On `invalid-scene`, split the segment into its first and second half and put both at the front of the queue, first half first. A rejected one-unit segment is that unit's rejection, handled as `addUnits` handles it now (left out with its subtree; a rejected mask source removes its mask group). Rejections of segments longer than one unit are not reported.
5. Any other status ends in a full snapshot, as today.

`retry` (released subtrees, `addUnits` with roots) uses the same procedure on the units under its roots.

The result equals the one-per-unit result only if acceptance is **batch-closed**: when a segment is accepted on scene state X, each of its units, sent one by one in pre-order from X, is also accepted. U3 states which mirror rules make this hold. The differential of E26-A06 checks it against the real mirror with the rule violations of section 3.4, because an injected predicate makes it hold trivially. If a rule breaks it, U3 sends one-unit segments for the units that rule involves and records where.

Each persistently rejected unit costs up to about 3 · log₂ n extra sets. A one-time rejection (M1-A13's case) costs one set in place of 9,250.

U3 amends M1 section 5 (the procedure, not the result) and updates `tests/m1-a13/observation.check.ts`, which asserts 9,250 sets today.

### 4.3 Change-scoped projection (editor-core)

`change(document, page, touched)` projects and diffs only the touched units, their ancestors' child lists, the frames whose synthetic nodes they affect, and the instances whose expansion they change (a change to a symbol source re-expands every instance of it on the page), instead of the whole page. The change set and the invalid-expansion diagnostics it produces must be identical to the whole-page path for every command. The whole-page path stays in the module as the test oracle only; production has no mismatch detection, so E26-A09's differential is the guard.

### 4.4 Frame preparation (renderer-core, conditional)

If U1's baseline shows a frame scenario over its ceiling with prepare as a leading share, U5 makes prepare cost proportional to the changed nodes for a scene set, and to the visible set for a camera change, by keeping the derived primitives and the cull result between frames, and it reports path re-tessellation at tolerance-bucket crossings separately. Packets must be byte-identical to a full prepare of the same scene and camera (the full prepare is the oracle). If the baseline shows prepare inside budget, U5 records that and is dropped. If the GPU share dominates, see section 8.

## 5. Pointer priority

The rule: **pointer input and the scene update it causes are not delayed by background work.** During a gesture (a pointer pressed), background work either waits for the gesture to end or is bounded as listed here.

| Work | During a gesture |
| --- | --- |
| Autosave writes (M5-S1) | A write that comes due (trailing timer or maximum wait) waits until the gesture ends, then starts at once. The dirty flag, `flush()` and the `beforeunload` guard are unchanged |
| Isolation after a rejected set | Stays synchronous inside its command, because a partly isolated scene must never be drawn (M1 section 5; E26-Q5). Bounded by E26-A06 |
| Retries of released subtrees | Same as isolation |
| E28 rasters past the budget | Already bounded to `E28_RASTER_PER_FRAME` (64) per frame by E28; E26 changes nothing in E28 and checks the bound under load in `e26-pointer-busy-10k/v2` |
| Path re-tessellation | Part of the frame; measured in the split, and U5's concern if it leads |
| Editor subscribers and overlay updates | Part of the input's own work; measured in the split |
| Future thumbnails or exports | Must wait, as autosave does |

- **Input.** Chromium already aligns `pointermove` dispatch to frames and coalesces the rest. `CanvasInput` keeps handling each dispatched event synchronously, in order, and adds no queue of its own: a queue in the layer would have to run its moves from the render callback (through a clock wrapper as in section 3.3) or from a second rAF; the second adds a frame of latency, and the first only repeats what Chromium already does. Wheel events are out of E26's scope.
- **Autosave gate.** `createAutosave` gains an optional `holdWhile?: () => boolean` option, and the autosave gains a `release()` method. The host passes `() => a pointer is pressed` and calls `release()` on every gesture-end path: `pointerup`, `pointercancel`, blur (which `CanvasInput` turns into `pointercancel`), `lostpointercapture`, and dispose. U6a amends M5-S1: "a write that comes due, by the trailing timer or the maximum wait, while `holdWhile()` is true starts on `release()`"; each release path has a unit test, and so does a write that ends mid-gesture after the maximum wait ran out (`dueAfterWrite`), which today starts the next write at once.

## 6. Acceptance criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| E26-A01 | Workloads and harness: the five scenarios generate deterministically from their seeds; configuration hashes are stable; the all-visible scenarios cull nothing on any measured frame; the pinned baseline is committed with every repetition | U1 unit tests; baseline record |
| E26-A02 | Typical editing at 60 fps: `e26-mixed-view-edit-10k/v1`, maximum per-run p95 of `rafCallbackIntervalMs` ≤ 16.7 ms, Chrome and Edge, DPR 1 and 2 | Reference PC, U6b |
| E26-A03 | All-visible and stress at 30 fps: `e26-mixed-all-edit-10k/v1`, `e26-mixed-all-pan-10k/v1` and `e26-simple-stress-10k/v1`, maximum per-run p95 ≤ 33.3 ms, Chrome and Edge, DPR 1 and 2 | Reference PC, U6b |
| E26-A04 | Pointer latency: `e26-pointer-busy-10k/v1`, maximum per-run p95 of `pointerToWorkDoneMs` < 50 ms. The same measure on the latency drag over the same view without the `setFill` and the rejection is reported too | Reference PC, U6b |
| E26-A05 | Pointer priority: in `e26-pointer-busy-10k/v1`, no long task over 50 ms starts between pointer down and pointer up except one overlapping the `e26-isolation` measure; no autosave write starts while the pointer is pressed, and the due write starts within one frame after pointer up; the pointer up is applied. Unit tests cover the autosave gate and the amended M5-S1 | Reference PC, U6b; CI |
| E26-A06 | Isolation: on the reference PC, isolation of the M1-A13 page with one persistent injected rejection takes at most `3 · R + 50` ms, and with 16 scattered persistent rejections at most `6 · R + 100` ms, where R is the median `replaceSnapshot` time of the same page in the same run (median of five), and in any case at most 500 ms and 1,000 ms. One-per-unit isolation sends one snapshot's worth of nodes plus a per-set overhead, and batching sends up to about three snapshots' worth; the constant covers projection, and the absolute caps keep a slow `replaceSnapshot` from loosening the bound. If U3 was dropped on the container ratio and the reference PC misses a cap, U3 is reopened. If U3 runs: its result is identical to one-per-unit isolation on at least 500 seeded cases against the real mirror with the violations of section 3.4, including mask sources and nested frames | Reference PC (U2 or U3); CI |
| E26-A07 | Scene-set cost: the incremental mirror equals the full validator on every set of a randomized differential (at least 2,000 seeded sets, with every reason `applyChanges` can return, plus `resync-required`) and on the existing scene tests; node visits per set stay within `c · (k · (d + log₂ n) + S)` with `c` fixed in U2 | CI |
| E26-A08 | Identity: every committed capture and the E10-A1 golden log are unchanged; the full `pnpm test:gpu` passes on the reference PC | CI; reference PC |
| E26-A09 | Change-scoped projection: equal change sets and diagnostics to the whole-page path for every command of the editor's command tests and a randomized run of at least 1,000 seeded commands, symbols and instances included | CI |

A remedy that misses its target on the reference PC is not merged as a pass: its PR records the measurement and the next lever, as E2 and E20 did.

## 7. Units

Under the [D9 conflict rule](d9-post-mvp1-tracks-proposal.md) ("the PR is split, and the owning track merges that part first as its own PR"), every part in a visualization-owned path is its own PR. This track may write it; the visualization track (the MVP thread) reviews and merges it (E26-Q4).

| Unit | Content | Paths | Merged by |
| --- | --- | --- | --- |
| U1a | Scenario generators, the stress document, counters in the CPU observation | `tests/` | Rendering |
| U1b | The `?bench=1` host option: driver, metric hooks, injected rejection | `apps/next-host` | Visualization |
| U1c | The headed harness spec; then the pinned baseline on the reference PC | `tests/gpu/`, `docs/evidence/e26/` | Rendering |
| U2 | Incremental mirror validation and publication (4.1), oracle, A07 differential; one-per-unit isolation timing (4.2) | `renderer-core` | Rendering |
| U3 | Batched isolation (4.2), only if U2's timing misses A06; M1 section 5 amendment; observation update | `editor-core`, `docs/plans`, `tests/m1-a13` | Visualization |
| U4 | Change-scoped projection (4.3) with A09 | `editor-core` | Visualization |
| U5 | Incremental prepare (4.4), only if the baseline calls for it | `renderer-core` | Rendering |
| U6a | Autosave gate and the M5-S1 amendment; host wiring | `persistence-idb`, `apps/next-host`, `docs/plans` | Visualization |
| U6b | Reference-PC run of every scenario and the evidence index | `docs/evidence/e26/` | Rendering |

Order: U1a, U1b, U1c first (the PC part of U1c when the PC is free). U2 and U4 can run in parallel after U1a. U3 after U2. U5 after U2, U4 and the baseline. U6a any time after U1b. U6b last. Each PR runs `pnpm check` and `pnpm test:unit`; PRs that touch rendering also run SwiftShader `pnpm test:gpu` and record what the reference PC still owes.

## 8. Risks

- **Batch closure may not hold** for a clip or mask rule. Mitigation: one-unit segments for those units (4.2). U3 may also not be needed at all.
- **The incremental validator may drift** from the full one as scene rules are added. Mitigation: the oracle stays in the module, every new rule extends both, and the A07 differential runs in CI.
- **Container updates are subtree-sized.** Dragging a frame or a group chain still costs its subtree. A02 to A04 measure the real drags; if a drag of a large frame misses, U2 records it as the next lever.
- **Prepare may dominate** after U2 and U4, making U5 large. The baseline decides early; a U5 that does not fit E26 becomes its own item.
- **GPU time may dominate** at 10,634 visible nodes with clips and masks. CPU remedies cannot fix that. If the baseline shows it, E26 records the GPU share and files an item (for example batching mask passes), and A03 stays open with that disclosure.
- **The reference PC is shared** and on hold now. Every claim waits for it; container numbers stay observations.

## 9. Questions (each with a recommended option)

- **E26-Q1 Scene surface.** (a) Keep the `contracts` scene surface and every root export's members. (b) Add a rejection detail naming the offending node to `SceneApplyResult`, so the projector excludes it without bisection. Recommended: (a). (b) is shared surface, and naming one node does not cover rules that involve several nodes.
- **E26-Q2 Isolation shape.** (a) Faster sets first (4.1), batching only if needed, with the M1 result (4.2). (b) Scope isolation to the rejected set's units only, which changes the M1 result. (c) Above a size limit, fall back to a full snapshot that leaves out every unit of the rejected set. Recommended: (a). (b) and (c) change what the user sees after a rejection, which is the visualization track's contract.
- **E26-Q3 Latency endpoint.** (a) Measure `pointerToWorkDoneMs` with the A10 number as its bound, named as a proxy; A10 stays open. (b) Wait for a physical-presentation method (PresentMon) before any latency claim. Recommended: (a). The benchmarks README forbids a proxy from satisfying a presentation threshold silently; (a) names it and leaves A10 open, and it unblocks M9.
- **E26-Q4 Visualization-owned paths.** (a) Follow the D9 conflict rule: those parts are their own PRs, which this track may write and the visualization track merges. (b) Ask the user for an exception so this track merges them with both-track review. Recommended: (a). It needs no exception, and the MVP thread already reviews this track's contract changes.
- **E26-Q5 Isolation inside the command.** (a) Keep isolation synchronous and bounded by A06. (b) Spread it over frames and hide the page until it ends. Recommended: (a). (b) shows a blank page on an error path and needs a new host state.
- **E26-Q6 Reading of the frame targets.** The requirements give 60 fps to typical editing, 30 fps to the 10,000-simple-node stress scene, and no rate to the all-visible worst case. (a) Typical editing is a typical view of the 10,000-node document (about 1,000 visible, as P1 Scene 3) at 16.7 ms, and the all-visible mixed scenes take P1 Scene 2's 33.3 ms. (b) The all-visible mixed scenes at 16.7 ms too. Recommended: (a). It is how P1 split the same requirement, and (b) would hold a mixed scene with clips and masks to a stricter bound than the simple stress scene.

## 10. Decisions

2026-10-29, after review round 3, the recommended options were auto-adopted under the user's standing rule (adopt the recommended option, record it with the date, tell the user): E26-Q1 (a), E26-Q2 (a), E26-Q3 (a), E26-Q4 (a), E26-Q5 (a), E26-Q6 (a). E26-Q6 is a reading of the requirements; the user can still pick (b), which moves the all-visible mixed scenarios to 16.7 ms before U6b runs.

## 11. Review record

- Round 3 (READY WITH FOLLOW-UPS): the busy scenario's rejection mode named (one-time) and recorded; the left edge of the pan bound; the stress rectangles' size and P1's opacities; the `dueAfterWrite` test; A06's missing period and U3 reopening. All applied.
- Round 2 (NOT READY): B1 the busy scenario's commands interrupted the drag (fixed: setFill before the drag, injected rejection inside it, text moved to v2); S1 pan bound restated; S2 stress styles stated; S3 old and new parent checks, no summed-bounds check; S4 trailing timer and every release path; S5 container go/no-go on the ratio, absolute caps; S6 clock-wrapper mechanism named. Nits applied.
- Round 1 (independent review, NOT READY): B1 frame targets stricter than P1 for all-visible scenes (fixed by E26-Q6 and the scenario split); B2 the incremental bound ignored subtree-wide world inputs (fixed by S in 4.1 and A07); S1 to S13 fixed: injected rejection (3.4), conditional batching (4.2), the full batching procedure, real-rule differential, M1 and M5 amendments, publication costs, test seams and the `?bench=1` flag, the P1-style driver and window, coalesced latency start, autosave gate, missing work sources, unit split under the D9 conflict rule and a pinned baseline. Nits applied.
