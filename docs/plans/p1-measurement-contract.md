# P1 measurement readiness contract

Status: **PARTIAL — deterministic workloads specified; memory and physical-presentation methods unresolved. No P1 implementation entry or acceptance run is authorized.**

Owner: P1.0m in the [active plan](p1-instanced-primitives.md). This supplements its measurement details without changing the [roadmap thresholds](../prototype-plan.md#p1-instanced-primitives) or [benchmark policy](../benchmarks/README.md). The user's 2026-09-09 approval covers D1/D2 only. The definitions below are prospective specifications, not performance observations. No product code, benchmark, external tool installation or capture was performed for this checkpoint.

## Common deterministic scene definition

Configuration version: `p1-primitives-workloads/v1`. The eventual runner must store the full expanded configuration and canonical hash, not just this version/seed. Any later workload/trajectory/method change receives a new scenario version before measurement.

- Canvas: 1280x720 CSS and physical pixels, DPR 1; D2 sRGB canvas, premultiplied alpha, preferred non-sRGB unorm format, opaque clear `(0.08,0.10,0.14,1)`. Require and record 4x MSAA for the reference configuration; 1x is a separate functional fixture/configuration, not pooled reference evidence. No overlays inside the canvas or unrelated animation.
- Five fresh repetitions per scene/browser. Continuous mode; warm-up `[0,5000)` ms, measured `[5000,15000)` ms from the first ready animation callback. No missing-data discard or post-measurement threshold changes. Actual callback times are observations, not fixed synthetic frame durations. Pin installed stable Chrome/Edge versions and re-establish reference environment before runs.
- Seed `0x50310001`. For node index `i`, unsigned word `u = (Math.imul(1664525, ((seed ^ i) >>> 0)) + 1013904223) >>> 0`; `qj = ((u >>> (8*j)) & 255)/255`, `j=0..3`. Translation jitter `(jx,jy)=(2*q0-1,2*q1-1)` where the scene enables it. Store this algorithm plus all constants in the configuration. No unseeded randomness.
- IDs are `p1-` plus a five-digit zero-padded index; document/page IDs are `p1-benchmark` / scenario ID, initial scene revision 0. Every primitive has `parentId: null`, `visible: true`, opacity `0.5 + 0.25*(i % 3)`. Root paint order is increasing `i`. No structural containers in these performance scenes; hierarchy is separately tested by correctness fixtures.
- Fill RGBA is `(0.2+0.6*q0, 0.2+0.6*q1, 0.2+0.6*q2, 0.45+0.4*q3)`. Stroke RGBA is `(0.8-0.6*q2, 0.8-0.6*q1, 0.8-0.6*q0, 0.65)`. Lines have null fill. All values are straight-alpha encoded-sRGB input under approved D2.

For a document-space center `(x,y)`, apply this exact payload; transform is `[1,0,0,1,tx,ty]`. Geometry starts at the approved local origin, rather than adding unapproved rectangle x/y fields.

| `i % 4` | Geometry                                           | `(tx,ty)`       | Stroke width |
| ------- | -------------------------------------------------- | --------------- | ------------ |
| 0       | Rectangle width 3, height 2, radii `[0,0,0,0]`     | `(x-1.5,y-1)`   | 0.5          |
| 1       | Rectangle width 3, height 3, radii `[0.5,1,0.5,1]` | `(x-1.5,y-1.5)` | 0.5          |
| 2       | Ellipse width 3, height 2                          | `(x-1.5,y-1)`   | 0.5          |
| 3       | Line `(-1.75,0)` to `(1.75,0)`, butt cap           | `(x,y)`         | 1            |

Each primitive's geometric stroke-inclusive extent is within center ±1.75 on both axes. Culling uses conservative bounds including the analytic coverage guard; use a two-physical-pixel guard for workload count verification below. Zero-copy or shared style implementations may not change the declared colors/order.

## Four workload trajectories and structural checks

Let `theta(t) = 2*pi*((t mod 10000)/10000)`, with elapsed time in milliseconds. Evaluate at the actual frame callback timestamp relative to the common start. Warm-up and measurement use one uninterrupted trajectory. CPU interaction updates must run before preparation/submission in the single backend-owned RAF, not in a second animation loop.

| Scenario ID                  | Population and centers                                                                      | Camera / changing state                                                                                                                          | Required counts                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `p1-pan-zoom-1k/v1`          | N=1000, C=40, R=25; `c=i%C`, `r=floor(i/C)`; `x=180+900*c/(C-1)+jx`, `y=160+400*r/(R-1)+jy` | Camera position `(20+20*sin(theta),10+10*cos(theta))`; zoom `1.05+0.05*sin(theta+pi/3)`                                                          | All 1000 visible every frame                                 |
| `p1-pan-zoom-10k/v1`         | N=10000, C=100, R=100; same center formula                                                  | Same camera trajectory                                                                                                                           | All 10000 visible every frame                                |
| `p1-cull-10k/v1`             | N=10000, C=R=100; `x=10+20*c`, `y=10+20*r`; no position jitter                              | Fixed camera `(0,0)`, zoom 1.5; continuous render mode                                                                                           | Exactly 1032 visible, 8968 culled                            |
| `p1-single-transform-10k/v1` | Same initial scene as cull-10k                                                              | Same fixed camera; only center of `p1-00000` changes to `(10+4*sin(theta),10+4*(cos(theta)-1))`; convert center to the rectangle transform above | Exactly 1032 visible; one updated node per measured callback |

S1/S2 proof: all stroke-inclusive bounds lie within `[177.25,1082.75] x [157.25,562.75]`. Camera x is in `[0,40]`, y in `[0,20]`, zoom in `[1,1.1]`. The intersection of all conservative view rectangles contains `[40,1280/1.1] x [20,720/1.1]`, which contains the scene bounds with a large coverage margin. Therefore pan/zoom never invalidates the all-visible workload assumption. This is an analytic bound, not a GPU observation.

S3 proof: document viewport is `[0,853.333...] x [0,480]`. Geometric bounds plus the 2/1.5 document-unit coverage guard select columns 0..42 and rows 0..23: 43*24 = 1032. Column 43 starts beyond the right edge and row 24 beyond the bottom edge even with the guard. Thus the roadmap's approximately-1000 population is frozen to an exact expected 1032, not a permissive interval used to conceal culling errors.

S4 uses the same count: target center remains x `[6,14]`, y `[2,10]`, with geometric bounds inside the viewport. The fixture replaces that node with unchanged geometry/style and an incremented scene revision each measured callback (`baseRevision` is the last accepted revision). Initial snapshot and warm-up uploads are separately recorded. Require zero warmed geometry rebuilds, no unrelated instance/style uploads, no full-scene upload, and actual native write ranges tied to the target. A revision-tagged unchanged transform still does not justify geometry/style dirtiness. This direct scene-update trajectory tests rendering cost; it is not the pointer-to-present input fixture.

The runner must assert scene composition, visible counts, pending callbacks and actual write ranges, rather than deriving reported counts only from this configuration. Independent unit fixtures verify generator outputs and bounds before headed workloads. P1.0b must choose the private packet/rebase implementation consistent with these fixed inputs.

## Frozen frame-time method

Primary disposition on 2026-09-09 after independent review: A08 is measured as `rafCallbackIntervalMs`, the interval between successive **render-loop RAF callback timestamps**, with one successful current-generation submission per measured callback. Separate encode/submit/queue-completion metrics retain distinct names. Retain 16.7 ms ceilings for S1/S3 and 33.3 ms for S2; do not inherit P0's 18 ms ceiling or add a rounding allowance. This freezes the previously unspecified frame-interval observation under the roadmap and benchmark policy; it does not revise A10 or assert physical presentation. Implementation and actual acceptance evidence remain absent.

Collect intervals only when both bounding callbacks are within `[5000,15000)`; record the boundary callbacks and submitted scene/camera revisions. Preserve every in-window long interval, unsuccessful submission and loss/visibility event. Unsuccessful/missing submissions, empty samples, hidden/occluded runs, unexpected diagnostics or unavailable required observers prevent acceptance. Record count/duration rather than requiring exactly 600 callbacks, which would select only fast runs. Nearest-rank per-repetition p95 with the maximum of the five p95 values determines the ceiling; publish median/p99/min/max and all raw samples. The measurement definition is fixed; A08 itself remains TODO until its runner and accepted results exist.

The [HTML animation-frame algorithm](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#animation-frames) defines callback invocation, and [High Resolution Time](https://www.w3.org/TR/2026/WD-hr-time-3-20260901/) defines clock behavior and timer coarsening. Neither establishes the visible display endpoint. Record time origin and observed timer resolution; do not treat extra decimal places as measurement accuracy.

## Combined-memory readiness

The unchanged gate is simultaneous peak working memory ≤ 256,000,000 bytes. The active plan's document/mirror/index/style/CPU geometry/upload/WASM/GPU categories and shared/copied-storage rules apply. This includes JS object, map and string storage, and temporary old/new buffers and candidate snapshots; a typed-array-only ledger is incomplete.

A future exact owned-buffer ledger can prove typed backing storage and GPU descriptor capacities at each allocation/free/generation event, but it cannot by itself prove JS object overhead. Sampling heap usage or taking isolated heap snapshots cannot automatically establish an unobserved between-sample peak. Any upper-bound method must explain why every counted engine category is included throughout the same window, avoid subtracting unrelated sampled baselines, and retain observations that exceed the ceiling.

Sol's read-only investigation and Primary source review found a candidate observational method, with unresolved coverage:

1. Capture `Runtime.getHeapUsage` for each engine-owning isolate and retain its `usedSize`, `totalSize`, `embedderHeapUsedSize` and `backingStorageSize` raw fields. The [CDP contract](https://chromedevtools.github.io/devtools-protocol/v8/Runtime/#method-getHeapUsage) describes isolate scope and separate heap/backing fields; it does not promise a continuous peak for the engine. Validate field availability and category overlap against the actual browser implementation before deriving a sum. Count a shared isolate only once.
2. Candidate CPU envelope is `totalSize + embedderHeapUsedSize + backingStorageSize`, without subtracting a baseline. Keep typed/WASM ledger categories for attribution; do not automatically add them again to an envelope that already includes them. Unknown field coverage, unavailable fields or shared backing ownership make the derivation UNVERIFIED.
3. At scene creation, atomic mirror publication with candidate storage still live, warmed steady state, maximal dirty uploads, resize/recovery old-and-new resource overlap and disposal, pause advancement at explicit test barriers. Read GPU ledger before and after the CPU observation and assert unchanged ownership/revisions. Preserve raw phases. Adding the largest observed CPU envelope to the largest ledger GPU live value is conservative across those observations, but not proof against missed inter-observation CPU transients.
4. Freeze five repetitions per scene/browser in a separate memory-instrumented run; include measurement and unrelated same-isolate overhead rather than subtracting it. No forced garbage collection. Corroborate category coverage with heap snapshots outside timed performance runs. The [browser memory article](https://web.dev/articles/monitor-total-page-memory-usage) describes implementation-dependent estimates and unavailable regions; page memory APIs are corroboration, not an automatic complete upper bound.

**Not accepted as A09 proof:** the proposal does not yet account for every transient peak or establish the CDP sum's coverage. Adopting sampled phase maxima in place of the current simultaneous-peak criterion would require an explicit prospective acceptance decision. Existing browser tools can be researched further without adding dependencies, but no such relaxation is included in D1/D2 approval. A09 and P1.0m remain UNVERIFIED. No allocation stress, storage-architecture rewrite or forced OOM is proposed.

## Physical-presentation feasibility proposal

A10 remains **pointer-to-present p95 < 50 ms**. The [prior feasibility investigation](../evidence/p0-6-measurement-feasibility-2026-09-09.md#presentation-candidates-and-limits) remains relevant. A scene-update timestamp, screenshot, RAF callback or queue completion cannot stand in for the particular changed frame reaching the display. No P0 acceptance exception applies.

Read-only source verification on 2026-09-09 found an official portable [PresentMon v2.5.1 x64 release](https://github.com/GameTechDev/PresentMon/releases/tag/v2.5.1). Release metadata names `PresentMon-2.5.1-x64.exe` with SHA-256 `9bec3083069f58f911e6a512f4806db51a27bd096103087bc1d05ef54c80a191`. Its [versioned CLI documentation](https://github.com/GameTechDev/PresentMon/blob/v2.5.1/README-ConsoleApplication.md) supports process-ID filtering, bounded duration, unique sessions and QPC timestamps. Display latency is relative to its CPU frame start, while displayed time is a duration. These fields do not automatically identify this renderer's changed canvas frame. PATH lookup found no PresentMon/wpr/wpa command in this shell; it does not establish absence from disk.

The following is a **proposal requiring separate approval**, not work authorized by D1/D2:

1. Download only that portable official binary into an ignored repository-local tool directory, verify its digest, and run a bounded local feasibility fixture with existing test tooling. No MSI/service installation, runtime dependency, driver change or product implementation. A digest mismatch stops the experiment.
2. Use an isolated browser profile/window and verify the selected monitor, refresh and power/background conditions. Select the fixture's producing process ID from its observed process tree; do not filter all Chrome/Edge processes by executable name. Abort if the target cannot be isolated. ETW provider collection may still involve system-wide events even when CSV output is filtered; retain only task artifacts and report that operational scope.
3. Maximum one 30-second capture per Chrome and Edge (two captures total), unique session/output paths, automatic termination and no dropped-frame exclusion. Never stop someone else's trace session. If elevated tracing privileges are required, report the exact requirement before requesting elevation; do not auto-relaunch as administrator. Collect read-only browser markers and an independently encoded frame/content marker using a test-only fixture, without adding a P1 renderer implementation.
4. Prove browser-clock/QPC mapping with an uncertainty bound and identify which display event contains the changed fixture frame; a similar cadence is insufficient. A candidate mapping must preserve input IDs, coalesced/superseded inputs, output content/generation IDs, dropped events, display-path metadata and clock drift. If the browser/ETW path cannot supply that evidence, the result is UNVERIFIED, not an estimated <50 ms result.
5. Report feasibility and overhead only. This two-run experiment is not the five-repetition P1 acceptance run, cannot pass P1-A10, and does not resolve A09. No further tool, longer capture, optical hardware or criterion change is implied by its approval.

## Readiness and next action

| Item                           | Status                                                                          | Consequence                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| D1/D2                          | User-approved on 2026-09-09                                                     | Public/visual design is fixed; no implementation claim                       |
| Four workload definitions      | Specified prospectively above                                                   | Ready for independent arithmetic review and later runner fixtures            |
| A08 frame-time endpoint        | Frozen by Primary: `rafCallbackIntervalMs` plus successful submission invariant | Definition ready; runtime acceptance remains TODO                            |
| A09 combined peak memory       | UNVERIFIED                                                                      | Method must cover JS overhead and simultaneous peaks                         |
| A10 physical presentation      | UNVERIFIED                                                                      | Separate bounded instrumentation decision required to attempt this candidate |
| P1.0m / P1.0b / implementation | PARTIAL / not started / BLOCKED                                                 | Preserve milestone entry rule                                                |

Primary reviews the independent Terra medium workload arithmetic and Sol medium memory-method investigation. Approval of the design documentation permits its protected PR integration; it does not authorize the unapproved experiment above. Validation of this document is limited to source/claim consistency, links, formatting and arithmetic; no runtime or performance result is claimed.

## Reproduce workload arithmetic

Run the following JavaScript with `node --input-type=module` from PowerShell stdin. It creates no files and invokes no renderer/browser. The analytic trajectory enclosure above proves visibility for all times; this script separately checks all generated node bounds against that enclosure and enumerates the culling count.

```javascript
import assert from 'node:assert/strict';
for (const [count, columns, rows] of [
  [1000, 40, 25],
  [10000, 100, 100],
]) {
  for (let i = 0; i < count; i++) {
    const u = (Math.imul(1664525, (0x50310001 ^ i) >>> 0) + 1013904223) >>> 0;
    const x = 180 + (900 * (i % columns)) / (columns - 1) + (2 * (u & 255)) / 255 - 1;
    const y =
      160 + (400 * Math.floor(i / columns)) / (rows - 1) + (2 * ((u >>> 8) & 255)) / 255 - 1;
    assert(x - 1.75 >= 40 && x + 1.75 <= 1280 / 1.1);
    assert(y - 1.75 >= 20 && y + 1.75 <= 720 / 1.1);
  }
}
let visible = 0;
const extent = 1.75 + 2 / 1.5;
for (let i = 0; i < 10000; i++) {
  const x = 10 + 20 * (i % 100);
  const y = 10 + 20 * Math.floor(i / 100);
  if (x + extent >= 0 && x - extent <= 1280 / 1.5 && y + extent >= 0 && y - extent <= 720 / 1.5)
    visible++;
}
assert.equal(visible, 1032);
assert(6 - 1.75 > 0 && 2 - 1.75 > 0);
assert(14 + 1.75 < 1280 / 1.5 && 10 + 1.75 < 720 / 1.5);
console.log(
  'PASS: 11000 generated all-visible bounds; 1032 culled-scene visible; moving target bounds',
);
```

## Checkpoint validation on 2026-09-09

- The JavaScript arithmetic block above, extracted from this document and passed to `node --input-type=module` — PASS: all 11000 S1/S2 generated bounds lie inside the conservative viewport intersection; S3 count is 1032; S4 target stays visible. This is a CPU arithmetic check, not rendering acceptance.
- `pnpm exec prettier --check --ignore-path .gitignore AGENTS.md docs/graphics-engine-architecture.md docs/plans/p1-instanced-primitives.md docs/plans/p1-measurement-contract.md docs/prototype-plan.md docs/plans/p0-webgpu-foundation.md` — PASS for all six PR Markdown files.
- Local link/anchor checker from `docs/evidence/docs-review-2026-09-05.md`, via `node --input-type=module` — PASS: 201 local links/anchors across 56 Markdown files.
- `git diff --check`, scoped file inventory and Primary source-of-truth review — PASS: documentation only; unchanged D1/D2 TypeScript shape, product files, dependencies, historical run records and numeric thresholds. A08 now has an explicitly frozen callback-interval method, distinct from physical presentation. The architecture now records the approved behavior; instrumented methods retain their stated proposal limits.
- Local unit/build/browser/GPU/benchmark/capture commands — NOT RUN: no implementation or performance claim. Required remote static/unit/build CI remains a separate PR gate.

Actual delegation: Terra medium supplied and reviewed workload formulas; Sol medium investigated memory API coverage and reviewed measurement boundaries. Neither edited files, ran captures nor delegated again. Primary corrected local-origin packing and the minimum-viewport arithmetic, independently ran the arithmetic and reviewed the source/approval boundary. P1.0m is PARTIAL; accepting this documentation does not approve the external-tool experiment or relax a gate.
