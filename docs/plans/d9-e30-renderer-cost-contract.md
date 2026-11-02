# E30 contract: renderer cost for the pre-alpha gate

Status: APPROVED 2026-11-02 after independent review round 3 (READY WITH FOLLOW-UPS, applied; section 10), with the recommended options auto-adopted (section 9). Full tier (rendering-track table): it sets E30's acceptance criteria and changes how the renderer prepares a frame. It does not change the [D9 shared surface](d9-post-mvp1-tracks-proposal.md#boundary): no `packages/contracts` export, no member of a `renderer-core` or `renderer-webgpu` root export and no operation identity changes (E30-Q1 (a)). Under E26-Q4 (a), any part in a visualization-owned path (`apps/next-host`, `packages/editor-core`, `packages/react`, `packages/ui`) is its own PR, written here and merged by the visualization track.

This is rendering-track item [E30](d9-rendering-track.md#status-index), pre-alpha gate unit [PA-U3](pre-alpha-gate-plan.md#4-units-and-order), under row E33 (the user lifted the 2026-11-01 pause for it with PA-Q9 (a), 2026-11-02 13:42Z).

Owners:

- This file owns E30's measurement split, its remedies (levers), their oracles and E30-A01 to A07.
- The [pre-alpha gate plan](pre-alpha-gate-plan.md) owns the gate rows PA-A01 to A04, their verdict rules, the unit order and the re-entry points (its section 5). E30 makes those rows passable; it gives no gate verdict.
- [`prototype-plan.md`](../prototype-plan.md) and the [P1 plan](p1-instanced-primitives.md#acceptance-and-evidence-map) own the 16.7, 33.3 and 50 ms numbers. They stay unchanged.
- The [E26 contract](d9-e26-pointer-priority-contract.md) owns the scenarios, the harness, the metrics (its section 3) and the twin-source oracle (its section 4.4.1). E30 adds no scenario and changes no scenario identity.
- [`docs/benchmarks/README.md`](../benchmarks/README.md) owns the measurement rules.

## 1. Problem

### 1.1 What is carried

E26 closed on 2026-11-01 with these misses carried to E30 ([U6b record](../evidence/e26/u6b-8629d30.md#exit)), and M9-U2 re-measured them on the v2 workloads at `89393f1` ([record](../evidence/m9/u2-89393f1.md)):

| Miss | v1 (U6b, `8629d30`) | v2 with `ui=1` (M9-U2, `89393f1`) | Gate row |
| --- | --- | --- | --- |
| All visible at F (all-edit, all-pan): maximum per-run p95 per project; `encodeAndSubmitMs` | 66.8 to 100 ms; `encodeAndSubmitMs` per-run p95 56 to 89 ms | 83.4 to 100.1 ms; `encodeAndSubmitMs` per-run median 52.3 to 82.2 ms | PA-A03 |
| Steady-drag pointer latency, `pointerToWorkDoneMs` | per-run p95 busy 151 to 327, plain 136 to 237 ms (medians 62 to 90) | maximum per-run p95 per project busy 888 to 1,348, plain 519 to 830 ms | PA-A04 |
| Long tasks over 50 ms outside isolation, busy run | 14 of 20 runs, 55 to 82 ms, most right after the isolation | 4 to 6 per run (font-load overlap, V-21) | PA-A04 (E26-A05) |
| Held write "within one frame after pointer up" | 62 to 76 ms after pointer-up handling | 74.6 to 97.4 ms | PA-A04 (E26-A05) |
| Typical view, maximum per-run p95 | Chrome 33.3 to 33.4 ms in 5 runs, cause not established (at `89393f1` v1 is 16.8 ms in every run, with the user's browsers closed) | 33.4 to 33.5 ms, frame median 33.3 ms (attributed to V-20) | PA-A01 |

The v2 typical-view, stress and most of the v2 latency misses are attributed to the right column (V-20, PA-U1) and the font-load re-projection (V-21, PA-U2), not to the renderer ([U2 record, "Where the v2 time goes"](../evidence/m9/u2-89393f1.md#where-the-v2-time-goes)). The all-visible miss is the renderer's: encode alone is over 33.3 ms before the column adds anything.

### 1.2 Container observation at `c8d71f2` (not evidence)

`pnpm check:e30` (`tests/e26/e30-profile.check.ts`, added with this contract) times `PrimitiveSceneSource.prepare` on the M1-A13 page (v1) at camera F, 1280 × 720 CSS at DPR 1, with the real geometry ports and every packet acknowledged, in a shared cloud container. Timings are from three unprofiled runs of the committed script (20 timed `still` and `edit` frames, 600 `pan` frames over one whole period of the E26 pan and zoom path; nearest rank, so the median of 20 frames is the lower middle). The self-time ranking is from two more runs that sampled `pan` and `still` (whose frames are then left untimed); `edit` was sampled only by an earlier draft of the script.

| Frame at F | Per run (three runs) | Leading self time (V8 sampling profile, 100 µs) |
| --- | --- | --- |
| First frame (one per run) | 77.4 to 79.9 s | not sampled (E26 U5a names fringe builds and mesh record versioning) |
| No change (`still`) | median 13.5 to 15.4 ms | the source's `prepare` body and its closures (34 %), the mesh packer's `prepare` (9 %), clip admission and plan (9 %), `getResidentIds`, instance records, the overlay sweep: each a pass over every drawn item |
| One-leaf move (`edit`) | median 24.1 to 31.2 ms | (draft script) as `still`, plus `readRetainedScene`, `numericArraysEqual` over all derived primitives, derivation |
| Pan and zoom path (`pan`) | median 50.3 to 51.1 ms, p95 91.0 to 108.5 ms, maximum 218 to 230 ms | the path pipeline's per-path pass (14 %; each path evaluated again under a new frame key), GC (8 %), the source's `prepare` and closures (14 %), the mesh packer (6 %), the clip plan (6 %), `#servePaint` (6 %), the packing bound (4 %), buckets (3 %); no function over 14 % |

The pan frame's tail (p95 about twice the median) is not attributed: tessellation at bucket crossings, GC and the container's own noise are candidates, and U1c's counters (paths evaluated afresh, port calls per frame) are what separates them.

Three things follow:

- **A camera-only frame re-evaluates every path.** The path pipeline's frame key holds the camera position and zoom (`path-mesh-pipeline.ts`, `prepare`), so a pan or zoom keeps no path outcome, although at F nothing enters or leaves the view and a path draw's instance lanes are relative to the mesh origin (`packInstanceLanes(world, entry, origin)`), not the camera. The camera does reach the packet in other places, which a reuse must recompute (section 4.1): the P1 and mesh frame records (`#updateFrame`, `meshFrameLanes` and its finiteness), the clip part's camera, each isolated layer's device rect (`layerBound`), each mask level's device bounds and texture (its memo key holds the camera), and the text frame (per-leaf device map, snapped phase, pixel corner).
- **Even an unchanged frame costs 13.5 to 15.4 ms at F**, because U5d-2's reuse keeps each part's records but still walks every drawn item in each part (packer, clip plan, mask admission, instance records, item merge).
- **No single function leads.** The cost is a dozen linear passes over about 6,500 drawn leaves. A remedy that removes one pass gains a few percent; the levers below remove whole classes of frames from the passes.

The records of the PC time only `encodeAndSubmitMs` (prepare, `submitPrimitivePacket` and `acknowledge` together, `webgpu-backend.ts`), so the PC share of the backend's command encoding and of the GPU is not known. That is the first unit.

### 1.3 Why 33.3 ms needs one refresh

A frame row passes when the maximum per-run p95 of `rafCallbackIntervalMs` is at or below the ceiling, with no rounding allowance. Intervals are whole refresh intervals (16.7 ms at 60 Hz) plus jitter, so a row whose frames take two refreshes reads 33.3 to 33.4 ms and passes or fails by jitter (M9-U2's typical view v2: median 33.3, p95 33.4 to 33.5). PA-A03 passes robustly only when at least 95 % of frames at F fit one refresh, as v1 stress does (p95 16.8 ms). The working budget for E30 is therefore **`encodeAndSubmitMs` p95 ≤ 10 ms at F on the main PC**, leaving the rest of the refresh to the editor, the column and the browser. The PC shows what fits: in U6b, v1's typical view held a frame p95 of 16.8 ms in Edge with `encodeAndSubmitMs` p95 9.3 to 12.6 ms, and v1 stress held 16.8 ms with 10.0 to 11.3 ms at the re-run. It is a recorded design target, not a threshold and not a closing condition (E30-A05): the gate verdict stays PA-A03's, and a result near 33.3 ms goes to the user under PA-Q6.

## 2. Scope

In scope:

- The frame split (section 3), so each share of the four gate rows is attributed to the renderer or to something else.
- Camera-only frames that keep the prepared frame (lever L1, section 4.1), in `renderer-core`.
- Set frames whose remaining passes are proportional to the change (L2, section 4.2), in `renderer-core`.
- Conditionally, by the split: the backend's encode or GPU share (L3), the frame after an isolation (L4), and the renderer's share of pointer latency (L5).

Out of scope:

- Changing what any scene draws: every capture stays identical (E30-A02). A cached or scaled raster during camera motion is E30-Q3.
- The right column (V-20), the font-load re-projection (V-21), the editor's edit path (`applyEdit`, E26 U4's note) and autosave. A share the split puts there goes back to its owner under the plan's section 5.
- The first frame at F (77 to 80 s in the container, section 1.2): it is in every run's warm-up and no gate row times it. U2 records the PC's value once, and the exit record carries it by name.
- Workers, `OffscreenCanvas`, lower-tier hardware (PA-U7), memory (PA-U4) and P1 A10 (PA-U5).

## 3. The frame split (U1)

- **Renderer measures.** While frame measurement is active (`startFrameMeasurements`, which the bench and the playground's measurement pages call; production never does), the backend wraps each part of a frame in User Timing: `vs-prepare`, `vs-submit` (`submitPrimitivePacket`: writes and command encoding through `queue.submit`) and `vs-acknowledge`, plus `vs-gpu`, from the end of `submitPrimitivePacket` to `onSubmittedWorkDone`, for every eighth submitted frame (a proxy of GPU time, named as one). User Timing keeps entries without a cap, so each reader (the bench, the playground pages) calls `performance.clearMeasures` after it reads a window. (Amended 2026-11-02 by U1a: the `vs-tessellate` measure inside `vs-prepare` is dropped. `renderer-core`'s path pipeline cannot see the backend's measurement state without a new root-export member or a hidden global; U1c's container counters give the port calls per frame, and the PC reads re-tessellation only indirectly, from `vs-prepare` outliers against the container's counts. This amendment is listed for the next review of this contract.) No measure is created while measurement is inactive (a unit test), so production pays nothing; no root export changes (E30-Q1 (a)). Because PA-U1's re-measure may run with the measures on (E30-Q2), U1 checks their observer effect: one PC sitting of `e26-mixed-all-pan-10k/v2` and `e26-mixed-view-edit-10k/v2` with the split on and off (an `E26_SPLIT=0` harness switch), five repetitions each, in U2; a difference of more than 0.5 ms in `encodeAndSubmitMs` median, or any change in a row's frame p95 by a whole refresh, turns the split off for verdict runs and keeps it for diagnostic runs only.
- **Latency split.** For `pointerToWorkDoneMs` samples, the bench adds per move: the input handler (the `pointermove` task from dispatch to its end, holding the editor's gesture update, projection and scene set) and the wait to the next prepare, read from the measures above and the samples' own timestamps. This is the visualization-owned part (`apps/next-host` bench), its own PR.
- **Records.** The harness (`tests/e26/e26-harness.spec.ts`) collects the measures over the window into each run record under a new `split` field; `tooling/e26-summarize.mjs` reports the per-run medians and p95. The scenario configuration and its hash do not change: the split is an observation of the same run. The run-record format is owned by [`docs/benchmarks/README.md`](../benchmarks/README.md), so U1c amends its result format section with the field.
- **Container profile.** `pnpm check:e30` gains the v2 page (instances and text, if the text atlas runs with the test raster port; otherwise it says that the v2 profile has no text) and counters of paths evaluated afresh and items walked per frame, which L1 and L2 use.

## 4. Levers

Every lever keeps E26's twin-source oracle: a source with the lever on and a twin with it off (`useFullDerivationForTesting` plus the lever's own switch) get the same frames and receipts and must produce byte-identical packets; every 50th frame a fresh full prepare has the same resolved draws (E26 section 4.4.1, U5c).

### 4.1 L1: camera-only frames keep the prepared frame

When a frame's only input change is the camera (same scene view, target, port readings, and the last packet acknowledged), the source keeps the camera-independent part of the last prepared frame and recomputes only the camera-dependent part, as long as the camera stays inside the frame's **validity range**: a box of camera positions and an interval of zooms, computed conservatively when the frame is prepared.

**Kept inside the range** (the decisions do not depend on the camera inside it):

1. **Cull.** No leaf crosses the viewport or the clip-chain cull guard: the drawn set's bounds stay inside the viewport and the culled leaves stay outside it, by kept unions of each side's bounds widened by the guard at its largest over the zoom interval (`2 / (zoom · DPR)` grows as the zoom falls).
2. **Path buckets.** Every drawn path's buckets hold (the U5d-3 hint gives each path a zoom interval; the frame keeps the paths ordered by where their interval ends, so a crossing re-evaluates only those paths).
3. **Origins.** The primitive and mesh origins stay selected under their hysteresis (`#selectOrigin`, `selectMeshOrigin`), and the mesh frame stays finite (`meshFrame !== null`), so no path's packing-range state changes.
4. **Packing.** U5d-1's sufficient condition holds for every assessed primitive over the range. U3 shows in its PR that the bound is affine in the camera's translation and monotone in its zoom over an interval, or the range is narrowed to the current camera for that primitive.
5. **Masks and layers.** Each mask level's and each isolated layer's budget decision and drawable state are unchanged over the range: a level or layer whose device bound is non-empty stays non-empty and an empty one stays empty, so mask admission (`plan.admit`) and the layer drawn set (`layerBound` returning null) drop the same content. The range is cut to the current camera when a level or layer is within 1 % of its budget or within one device pixel of an empty bound after snapping and clamping.

With these, the kept part is the path pipeline's draws and mesh instance records, the primitive instance records and order, and the gradient records (they depend only on the origins, condition 3). The item merge (`mergeItems`) and the clip-state assignment are kept only when the recomputed text frame gives every text leaf the same draws (count and atlas pages) as the kept frame; otherwise both are recomputed over the kept mesh draws and the new text draws, since a new sub-pixel phase or a placement change at a zoom can change a leaf's draws.

**Recomputed on every camera-only frame**, by today's code for that part, with no range: the P1 and mesh frame records (`#updateFrame`, with its representability throw, and `meshFrameLanes`); the clip part's camera; each isolated layer's device rect (`layerBound`: bounds minus camera, times zoom and DPR, snapped and clamped); each mask level's device bounds and its texture content (the mask level memo, whose key holds the camera, decides as today); and the text frame (`planTextFrame`: device map, snapped phase, pixel corner, uniform-scale test). A part whose recompute U3 finds unsafe to separate from a kept part leaves both on today's path, and U3 records which.

Outside the range, or for a condition a check declines, the frame runs today's path for the affected paths or parts only. A range cut to the current camera by condition 5 is expected, not a reuse miss: the next pan of any size reruns today's path for those mask levels or layers only, and U3's counters report such cuts separately.

**What L1 can give.** The recomputed parts scale with the number of mask levels, isolated layers and text leaves, not with the 6,500 drawn leaves, and the M1-A13 page's masks (E26 U5d-2 put mask planning and admission at 13 % of the frame) are re-rendered on the GPU on every pan either way. U3's container counters report the recomputed work per pan frame; the pan target below is a counter target, and its time is observed.

Acceptance (U3): the twin differential of at least 1,000 seeded frames with camera-only runs (pans, zooms across bucket boundaries, origin moves, mesh frames that become non-finite, leaves entering and leaving the view, clips, masks, isolated layers, text at sub-pixel phases), byte-identical packets; a counter test shows, on a camera-only frame inside the range, 0 paths evaluated afresh and 0 instance records compared, and at a bucket boundary only the crossing paths; mutations that drop each of conditions 1 to 5, each recomputed part, the empty-bound check of condition 5 and the text-draw check on the item merge each fail the differential, with seeded cases for a mask level and a layer whose bound rounds or clamps to empty and a text leaf whose phase needs uncached glyphs. Observation, three runs of `pnpm check:e30`: the pan frame at F at DPR 1.

### 4.2 L2: set frames proportional to the change

A frame after a scene set walks only the items the set changed, using the mirror's `changedSince` (E26 U5c-1) through every part that still walks every drawn item: the mesh packer's draw walk, clip admission and the clip plan, mask admission, the instance-record comparison (`numericArraysEqual` over all derived primitives), `getResidentIds`, the overlay sweep and the item merge; and `readRetainedScene` builds no whole-page view when the source only needs the changed IDs. Each part keeps its full walk as the twin. The unchanged frame (no set, same camera) becomes a frame-record-only frame by the same rule.

Acceptance (U4): the twin differential of E26 U5c with sets of 1 to 64 leaves, container edits, inserts, removals, reorders and mask-source edits, byte-identical; counters show items walked per frame proportional to the changed items plus a constant, and 0 on an unchanged frame. Observation, three runs of `pnpm check:e30`: the `still` and `edit` frames at F at DPR 1.

### 4.3 Conditional levers (U5), decided by U2's split

- **L3, backend encode or GPU.** If `vs-submit` or `vs-gpu` p95 at F is over 5 ms after L1 and L2, U5 profiles the backend on the PC and takes the leading cost (for example re-encoding unchanged command sequences, or per-draw state changes), with the E10 captures as its oracle. A remedy that needs a new pipeline, render bundle or draw batching that changes draw order is written up as its own item first.
- **L4, the frame after an isolation.** If the busy run's long tasks outside isolation (E26-A05) are frames whose `vs-prepare` holds them, U5 takes the frame after a removal-set isolation (E26 U5b keeps records but every re-inserted path is evaluated again) under L2's rule.
- **L5, the renderer's share of latency.** If the latency split puts more than 10 ms of a median move in `vs-prepare`, `vs-submit` or the scene set apply, U5 takes it under L2. A share in the input handler outside the renderer goes to V-20, V-21 or the editor (plan section 5).

A conditional lever that the split does not call for is recorded as not needed in E30's progress, with the split's numbers.

## 5. Acceptance criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| E30-A01 | Split: the measures of section 3 exist only while measurement is active; every run record of `pnpm test:e26` carries `split`; the summary reports it; the benchmarks README's result format names the field; no scenario configuration hash changes | CI (unit tests); one PC run (U2) |
| E30-A02 | Identity: every committed capture and the E10-A1 golden log are unchanged; headed run tier 2 (`pnpm test:headed --tier 2`) on the main PC at E30's last head has 0 failed | CI; main PC (U6) |
| E30-A03 | L1 oracle and counters as section 4.1 states | CI (`tests/unit/e30-u3-camera-frames.test.ts`) |
| E30-A04 | L2 oracle and counters as section 4.2 states | CI (`tests/unit/e30-u4-set-frames.test.ts`) |
| E30-A05 | Working budget, recorded (section 1.3): on the main PC, `vs-prepare` + `vs-submit` + `vs-acknowledge` (that is, `encodeAndSubmitMs`) p95 ≤ 10 ms in every run of `e26-mixed-all-pan-10k/v2` and `e26-mixed-all-edit-10k/v2`, Chrome and Edge, DPR 1 and 2; v1 recorded beside them. A miss is not a failure of E30: it goes into E30-A06's attribution with the split | Main PC (U6) |
| E30-A06 | Attribution: U6's record gives, for each of PA-A01 to A04 on v2, the split's renderer share and the rest, and names each remaining miss's owner (E30, V-20, V-21, the editor, or the exit card) | Main PC (U6) |
| E30-A07 | Every conditional lever (L3 to L5) is either taken with its oracle or recorded as not needed with U2's numbers | E30 progress section |

E30 closes on E30-A01, A03, A04 and A07 in CI and its progress, and A02 and A06 at E30's last head on the main PC. A03 or A04 also closes as "not taken" when its lever is not merged, with its measurement recorded, as A07 allows for L3 to L5. E30-A05 is the renderer's half of PA-A03 and is recorded, not gated; PA-A03 itself is judged at the gate head by PA-U9, so a PA-A03 pass with an A05 miss is reported as such, and an A05 pass with a PA-A03 miss is attributed by A06. Container timings are observations in every unit: a lever's merge rests on its oracle and counters, and its container and PC times are recorded beside them. A lever that does not lower the PC's `encodeAndSubmitMs` at all is not merged as a remedy: its PR records the measurement and the next lever, as E26 did.

## 6. Units

| Unit | Content | Paths | Merged by |
| --- | --- | --- | --- |
| U0 | This contract, `pnpm check:e30` and the status rows | `docs/plans`, `tests/e26`, root config | Rendering |
| U1a | Renderer measures (section 3) and their inert test | `renderer-webgpu`, `renderer-core`, `tests/unit` | Rendering |
| U1b | Bench latency split and measure collection | `apps/next-host` | Visualization |
| U1c | Harness `split` field and its `E26_SPLIT=0` switch, summarizer, the benchmarks README result-format amendment, `check:e30` v2 page and counters | `tests/e26`, `tooling`, `docs/benchmarks` | Rendering |
| U2 | PC run with the split: the v2 rows at PA-U1's head (it may be PA-U1's own re-measure, if U1 has merged), the split's on/off overhead check (section 3), the PC's first-frame time at F; decides L3 to L5 | `docs/evidence/e30/` | Rendering |
| U3 | L1 camera-only frames | `renderer-core`, `tests/unit` | Rendering |
| U4 | L2 set frames | `renderer-core`, `tests/unit` | Rendering |
| U5 | The conditional levers that U2 calls for | as needed | as needed |
| U6 | PC record: E30-A02, A05, A06 at E30's last head; E30 closes | `docs/evidence/e30/` | Rendering |

Order: U1a to U1c first, then U2 (through the coordinator's PC slot). U3 and U4 start after PA-U1's re-measure, as the plan orders. Under E30-Q2 (a), U1 may land before that re-measure; it changes no drawing, and its timing effect is checked by U2's on/off runs. U3 and U4 are independent and may run in either order under the WIP limit; U5 after both; U6 last. Each PR runs `pnpm check`, `pnpm test:unit` and, when it touches rendering, SwiftShader `pnpm test:gpu`, and records what the main PC still owes. If PA-A01 to A04 all pass after PA-U1 and PA-U2, PA-U3 closes E30 as "not needed for the gate" and it stays backlog (plan section 5).

## 7. Risks

- **The validity range may be narrow on the pan and zoom path.** The zoom moves through bucket boundaries; each crossing re-evaluates those paths. If crossings are frequent enough to keep the pan frame over budget, U3 records the crossing rate and the cost per crossing path, which bounds what L1 can give.
- **Conservative checks can cost what they save.** Each range check must be cheaper than the pass it skips; U3 measures each check and keeps today's path where it is not.
- **A subtle reuse bug draws a stale frame.** The twin oracle, the fresh full check and the E10 captures guard it, as in E26; every new reuse condition gets a mutation that must fail a test.
- **L1's recomputed parts may keep the pan frame over budget.** Mask levels are re-rendered, and layer rects and the text frame replanned, on every camera-only frame (section 4.1). If U3's counters and the PC split show these leading after L1, U3 records their cost, which bounds what L1 can give, and the next lever is U5's or E30-Q3's.
- **The GPU may be the floor.** At about 6,500 drawn leaves with clips and masks, the GPU time per frame on the GTX 1660 SUPER is not known. If `vs-gpu` alone is near a refresh, CPU levers cannot pass PA-A03, and E30-Q3 decides.
- **The main PC is shared.** U2 and U6 wait for the coordinator's PC slot; container numbers stay observations.

## 8. Questions (each with a recommended option)

- **E30-Q1 Where the split lives.** (a) User Timing measures from the backend while frame measurement is active, read by the bench through a `PerformanceObserver`; no root export member changes. (b) New fields on `WebGpuFrameMeasurements`, a `renderer-webgpu` root export member, which is D9 shared surface with both-track review. Recommended: (a). It needs no shared-surface change, and the measures are inert outside the bench.
- **E30-Q2 When U1 lands.** (a) U1 (measurement only) may merge before PA-U1's re-measure, so that re-measure carries the split; the levers (U3 to U5) wait for it, as the plan says. (b) All of E30's code waits for PA-U1's re-measure. Recommended: (a). The plan's section 5 decides E30's scope from that re-measure, and without the split it can only guess the renderer's share, as M9-U2 had to. It changes the order of the approved pre-alpha plan (PA-U3: "code after PA-U1"), a Full-tier visualization item (V-22), so adopting it needs a plan amendment that the visualization track reviews and merges (D9 conflict rule, E26-Q4 (a)). It is a reversible order change of measurement code, not of a remedy, so it falls under the user's standing rule of 2026-10-24 (adopt the recommended option, record it, tell the user); the user can still pick (b) before U1 merges. The amendment PR also records that PA-Q9's lift of the pause was given under the plan's order and that Q2 widens when that code may land; the user is told in one line when Q2 is adopted, and section 9 records the date once the amendment merges.
- **E30-Q3 If the levers within the current design do not reach the budget.** (a) The remaining miss goes to the pre-alpha exit card with the split (plan section 7, "E30 is large"). (b) A cached raster of the scene while the camera moves (scaled bitmap during motion, a full render when it stops), which changes what is drawn during motion and so needs a requirements decision. (c) Move preparation to a worker, which changes the threading model. Recommended: (a) for this gate. (b) and (c) are new items that only the user can start.

## 9. Decisions

2026-11-02, after review round 3, the recommended options were auto-adopted under the user's standing rule of 2026-10-24 (추천안 자동 채택: adopt the recommended option, record it with the date, tell the user): E30-Q1 (a) and E30-Q3 (a). E30-Q2 (a) is adopted the same way and took effect when the pre-alpha plan amendment that records it merged through the visualization track (#463, `230f12c`, 2026-11-02): U1 may merge before PA-U1's re-measure; U3 to U5 still wait for it.

## 10. Review record

- Round 1 (2026-11-02, independent review, NOT READY): B1 L1's range missed the camera-dependent parts outside the frame records (clip camera, layer rects, mask level bounds and textures, the text frame, mesh frame finiteness) and the guard's growth over the zoom interval; fixed by splitting L1 into kept and recomputed parts and adding the bound to section 7. S1 E30-A05 made a recorded target with the closing set named; the 10 ms grounded in U6b. S2 E30-Q2 needs a visualization-reviewed plan amendment, and U2 checks the split's observer effect. S3 container times are observations, counters gate. S4 the script: profiled frames untimed, the pan over a whole period, timings only from the committed script, the tail not inferred. S5 the typical-view row. S6 the benchmarks README amendment. N1 to N5 applied.
- Round 2 (2026-11-02, NOT READY): B1 the kept part still held camera-dependent results (mask admission and the layer drawn set through empty bounds, text draws feeding the item merge and clip states); fixed by condition 5's drawable state, the text-draw check on the merge and clip states, gradients named as kept, and mutations for each. S1 a closing path for an unmerged L1 or L2 ("not taken"). S2 the Q2 amendment's PA-Q9 note and the user notice. N1 to N3 applied.
- Round 3 (2026-11-02, READY WITH FOLLOW-UPS, applied): the closing set names A06 as a main-PC record; condition 5's cut to the current camera is expected and counted separately.

## 11. Progress

- **U0 (2026-11-02).** This draft. Container observation at `c8d71f2` in section 1.2.
- **U1a (2026-11-02).** `webgpu-backend.ts` emits `vs-prepare`, `vs-submit`, `vs-acknowledge` and, for every eighth submitted frame, `vs-gpu` (submit end to `waitForSubmittedWork`), each through `performance.measure` with the backend's clock, only while frame measurement is active; the names are a module constant, not exported. `tests/unit/e30-u1a-frame-measures.test.ts`: no measure while inactive; nine frames give nine of each CPU measure and two GPU waits; a failed submission measures prepare and submit only. A `vs-gpu` wait that settles after its window stopped or restarted, or after a device or generation change, is dropped (a test). `vs-tessellate` dropped (section 3 amendment). Independent review of the diff: READY WITH FOLLOW-UPS, applied (the stale GPU wait, the clear-measures rule, the indirect PC attribution, a test name).
