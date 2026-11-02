# V-21 font-load re-projection contract (pre-alpha PA-U2)

Status: DRAFT 2026-11-02, Full tier. This item changes product behavior in three packages: `packages/text-dom`, `packages/contracts` (an optional port member) and `packages/editor-core`. It changes when the editor learns of a new text layout generation, which cached layouts it drops, and how much of the page it re-projects. It amends M6a-L2, M6a-L3 and M6c-P4. It is visualization-track item [V-21](d9-visualization-track.md#status-index) and unit PA-U2 of the [pre-alpha gate plan](pre-alpha-gate-plan.md#4-units-and-order). Once the contract is approved, questions V21-Q1 to V21-Q4 (section 8) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

Owners:

- This contract owns V-21's levers, its acceptance criteria and its re-measure.
- The pre-alpha plan owns the gate (PA-A04) and what follows the re-measure (its section 5).
- The [M6a contract](mvp-m6a-text-model-contract.md) (L2, L3) and the [M6c contract](mvp-m6c-gpu-text-contract.md) (P4) own text generations and their re-projection. They are amended only where section 4 says.

## 1. Problem

In `e26-pointer-busy-10k/v2`, the harness registers a second font two seconds into the drag. It marks this step `m9-font-load`: a font arriving mid-session. The [M9-U2 record](../evidence/m9/u2-89393f1.md#long-tasks-font-load-autosave-and-typing) shows, in every run:

- three generation changes (3 to 6);
- four or five long tasks over 50 ms overlapping the load, most of them 170 to 250 ms.

V-20 did not change this. In the [V20-U3 sitting](../evidence/viz-v20/u3-b810f89.md) at `b810f89`:

- every busy v2 run has `bumps` 3 and generation 3 to 6;
- each run has three or four long tasks flagged `fontLoad` (`chrome-dpr1-v2--e26-pointer-busy-10k_v2--r1.json`: 188, 208 and 175 ms).

PA-U9 counts long tasks outside isolation against PA-A04, and they are not exempt (M9-Q3). Pointer moves that arrive during such a task wait behind it.

**Out of scope.** Every busy v2 run also has one unflagged long task of 145 to 210 ms, often with one of 55 to 80 ms. PA-A04 judges every long task, so it can still miss after V-21. V21-U3 records these tasks but V-21 does not remedy them.

## 2. Cause, from the code at `5ce5b5b`

These are code facts. Whether they explain the tasks is the hypothesis V21-U1 measures.

- **Three increments and three dispatches per load.** `registerFont` (`packages/text-dom/src/text-dom.ts`) bumps at three points:
  1. when it adds the face (a registry change);
  2. when `face.load()` settles;
  3. on `document.fonts` `loadingdone`.

  The code does not fix the order of the last two. Each bump runs the listeners synchronously (M6a-L3: "`subscribe` listeners run synchronously after each increment").

- **Each dispatch drops every cached layout.** The editor's port listener (`packages/editor-core/src/editor.ts`, M6c-P4) does three things:
  1. `TextLayoutCache.notify` drops every result (the cache holds one generation).
  2. It calls `SceneProjector.relayout`. That deletes every text entry from the memo, clears the results of instances that hold text, sets `scoped = false` and calls `change(document, page, [])`, a whole-page `sync(project(document))`.
  3. It raises one `textLayout` session event.

  The whole-page walk reuses memo snapshots for unchanged nodes. Outside text, its cost is a walk of about 11,000 nodes plus the diff, not a re-projection. Every text unit is measured again: 200 text nodes plus 12 instance texts, so 212 layouts per dispatch.

- **Most layouts cannot change.** Only the 50 text nodes whose run family is `M9 Font Load` name the registered family (`tests/m9/document.ts`, `M9_V2_SECOND_FAMILY_NODES`). The first bump comes before the face has loaded, so its layouts measure with the fallback, as before it. Each of the three tasks takes about 180 ms whether or not a layout changes. That points at measurement, not projection; U1 checks it.
- **On this workload the new face is the fallback's file.** The bench registers the committed test font under a second name (`apps/next-host/src/e26-bench.ts`; [M9 contract](mvp-m9-performance-exit-contract.md): "the same font file, so their layout may not change"). So after the load, every new layout likely equals the old one. A03 therefore uses a unit fixture whose face really changes the metrics.

## 3. Levers

| Lever | Where                                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1    | `packages/text-dom`                                               | **One dispatch per registration** (section 4.1). The add and the settle still increment the generation. Their dispatch is held while that face's `load()` is pending, then sent once, on a later task, after it settles. A `loadingdone` or `loadingerror` whose faces were all registered through this port is redundant with their settle, so it neither increments nor dispatches.                                |
| L2    | `packages/contracts`, `packages/text-dom`, `packages/editor-core` | **Drop only the affected layouts** (section 4.2). The port tells which font families an increment can affect: the registered family for a registry change or a settle; the event's face families for a foreign `loadingdone`; "all" for a DPR change. The cache drops only results whose font lists name such a family. The relayout re-projects only the text units whose layout was dropped, with their instances. |
| L3    | `packages/editor-core`                                            | **Scoped relayout**, only if V21-U1 shows the whole-page walk and diff, not measurement, as the larger share after L2 (V21-Q2). `relayout` passes the re-projected text node IDs to the scoped path instead of forcing `scoped = false`. `instancesOfSources` adds their instances and the chain adds their ancestors. When `scoped` is already false, the whole-page fallback stays.                                |

## 4. Behavior change

### 4.1 Dispatch (M6a-L3 amendment)

- **Increments.** The generation still increments, before any dispatch, on:
  - the add;
  - a settle;
  - a foreign `loadingdone` or `loadingerror`;
  - a DPR change.

  A `loadingdone` or `loadingerror` whose `fontfaces` are all faces registered through this port does nothing, because their settle already increments.

- **Dispatch timing.** Listeners never run inside `registerFont` or an event handler. An increment schedules one dispatch on a later task, and later increments before it runs add none.
- **Hold.** While a face registered through this port is pending, a scheduled dispatch waits until the last pending face settles. It waits at most 3,000 ms, then dispatches anyway (V21-Q3). A DPR change during a hold joins the held dispatch.
- **Reads in the gap.** `generation` read between an increment and its dispatch already has the new value, and a `layout` call in that gap uses it, as today.
- **Dispose.** `dispose` cancels a scheduled dispatch.
- **E28 note.** The note in M6a-L3 ("each `registerFont` causes this twice") becomes "once".
- **Mixed generations.**
  - Between an increment and its dispatch, an edit lays out the touched text at the new generation while the rest keeps the old one.
  - Under L2, unaffected text keeps its older generation after the dispatch too.
  - Each scene node still carries its result's generation, so the atlas key never reuses a raster across a load (M6-F4).

### 4.2 Affected families (M6a-L2 and M6c-P4 amendment)

- **The port.** `TextLayoutPort` gains an optional member, `changedSince(generation): readonly string[] | null`.
  - It returns the families that the increments after `generation` can affect.
  - It returns null, meaning "all", for a DPR change, an unknown face, or a generation older than the port's log.
  - It is an addition, so `portVersion` stays 0. A port without the member behaves as "all".
- **The cache.** `TextLayoutCache` drops only the results whose font lists name a changed family.
  - A kept result keeps its generation, and M6a-L2's "deep-equal results at one generation" still holds per result.
  - When `changedSince` returns null, the cache drops everything, as today.
- **The relayout (M6c-P4).**
  - The active page's text units whose result was dropped are re-projected, together with the instances that hold them. The other units keep their scene nodes.
  - Other pages re-project their affected units on their page switch.
  - The `textLayout` session event is raised once per dispatch.

### 4.3 What a user sees

- Text waiting for a face keeps its fallback layout until the face settles, then changes once instead of up to three times.
- A load longer than 3,000 ms dispatches at 3,000 ms and again at its settle.
- A foreign face, such as a UI web font, does not hold the editor's text.

## 5. Units

| Unit   | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Machine                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| V21-U1 | **Counters, before any fix.** Bench-only (`?bench=1`, M9-A03's rule) and inert without the bench. Per dispatch the editor receives:<ul><li>its time and generation;</li><li>the relayout's duration, split into layout calls (count and time), projection walk and diff, change-set send and the renderer's submit;</li><li>text units and scene nodes touched;</li><li>how many new layouts equal the old.</li></ul>Also: the order of settle and `loadingdone` in headless Chromium, and whether any key latency overlaps a relayout.<br><br>A headless spec (`pnpm test:v21-count`, run by hand, not in CI) records these on the v2 pointer-busy path, as V20-U1 did.                                                                                                                                                                                                                        | Cloud (headless)            |
| V21-U2 | **The remedy.** L1, L2, and L3 if V21-Q2 keeps it; the M6a and M6c amendments go into those contracts.<br><br>Unit tests:<ul><li>one dispatch for a URL face and for a `{ bytes }` face, in both settle and `loadingdone` orders;</li><li>two faces in flight;</li><li>the 3,000 ms cap;</li><li>a foreign `loadingdone`;</li><li>a DPR change alone and during a hold;</li><li>`dispose` with a held dispatch;</li><li>`changedSince` over a log;</li><li>the cache keeping unaffected results;</li><li>a layout read between increment and dispatch.</li></ul>Tests that change, each listed in U2's notes:<ul><li>`tests/unit/m6a-u4-text-dom.test.ts`: bump counts, and its synchronous `loadingdone`;</li><li>`tests/m6c-next-host/m6c-scene.spec.ts` M6c-A05;</li><li>any m6a or m6c next-host check that waits on a synchronous bump.</li></ul>The U1 counters run again at the U2 head. | Cloud, laptop smoke         |
| V21-U3 | **Re-measure.** On the main PC at the V21-U2 head, in the M9-U2 conditions: `e26-pointer-busy-10k/v2` and `e26-pointer-plain-10k/v2`, with the v1 pointer rows as a control. Then tier 2 headed (`pnpm test:headed --tier 2`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Main PC, coordinator's slot |

## 6. Acceptance criteria

| ID      | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V21-A01 | On the v2 pointer-busy path, each font load gives exactly one listener dispatch. The bench's `bumps` field counts dispatches and reads 1, while `generationAfter − generationBefore` is at least 2. U1 records both fields before the fix.                                                                                                                                                                                                          |
| V21-A02 | A dispatch lays out again only the text whose font list names a changed family: 50 layouts on the v2 document instead of 212 (U2 counters).                                                                                                                                                                                                                                                                                                         |
| V21-A03 | After a load, every text unit's lines and clusters equal those of today's whole-page relayout. On a unit fixture with text, instances, text overrides and a face that changes the metrics, the changed units are exactly those naming the family. With L3, the E26-A09 oracle (`checkScopedProjectionForTesting`) checks the scoped path against the whole page.                                                                                    |
| V21-A04 | The M6a and M6c criteria that cover generations pass after the amendments V21-U2 lists: the M6a unit suite; the M6c atlas tests (no fallback raster reused after a load, M6-F4); and the m6 next-host suites, headed in Chrome and Edge in tier 2. E28-K10's rule that a generation change with no face change re-rasterizes every key keeps a test, through the DPR path or a renderer unit test.                                                  |
| V21-A05 | V21-U3 records, for each busy v2 run:<ul><li>the load's `lastBumpMs`, which must be before the measure's `endMs` so the dispatch falls inside the measured window;</li><li>the long tasks over 50 ms flagged `fontLoad`;</li><li>every long task over 50 ms outside isolation;</li><li>PA-A04's v2 pointer rows.</li></ul>The target is 0 flagged tasks per run. If it is missed, the record gives the remaining task's split from the U1 counters. |

## 7. Gate

V-21 is done when V21-A01 to A05 are met. A05 requires the record, not the target. Whether PA-A04 passes is the pre-alpha gate's question, and the unflagged long tasks of section 1 stay outside V-21. After V21-U3, [section 5 of the pre-alpha plan](pre-alpha-gate-plan.md#5-re-entry-points) decides what follows.

## 8. Open questions

| ID     | Question                                                       | Options and recommendation                                                                                                                                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V21-Q1 | Where are dispatches coalesced?                                | (a) In text-dom (L1): one dispatch per registration for every port user. (b) In the editor's listener, debouncing its relayout, with text-dom unchanged. **Recommended (a)**: the increments are text-dom's events, and (b) still runs every listener three times and keeps the renderer's double re-rasterization.                            |
| V21-Q2 | Is L3 (scoped relayout) part of V21-U2?                        | (a) Only if V21-U1 shows the walk and diff as the larger share after L2. (b) Always. **Recommended (a)**: the walk reuses memo snapshots, and the timing points at measurement, which L2 removes.                                                                                                                                              |
| V21-Q3 | How long may a held dispatch wait?                             | (a) At most 3,000 ms (the browser's usual font block period plus a margin), then dispatch, and dispatch again at the settle. (b) Until the settle, however long. **Recommended (a)**: a slow or hung font must not freeze text updates.                                                                                                        |
| V21-Q4 | Is splitting a relayout across frames (time slicing) in scope? | (a) No: L1 and L2 first; if V21-U3 still shows a flagged task over 50 ms, slicing is the next lever, in this item. (b) Yes, now. **Recommended (a)**: L2 cuts the v2 relayout to 50 layouts, and slicing needs a rule for how long a page may show a load half applied, beyond the per-node mixed generations that section 4.1 already allows. |

## 9. Risks

- **The family log.** `changedSince` keeps one entry per increment. A bounded log (the last 64 increments, null past it) keeps the memory fixed. An editor that falls behind the log drops everything, which is today's behavior.
- **Family matching.** A font list names families as CSS strings. The match must use the same normalization as `buildFontList`, or an affected result is kept. A03's fixture covers quoted and unquoted families.
- **Deferral and tests.** Tests that expect the `textLayout` event or a leaf generation synchronously after a bump change, as V21-U2 lists.
- **One relayout may still be long.** If measuring 50 layouts plus the walk still exceeds 50 ms, A05 records it, and V21-Q2 and V21-Q4 name the next levers.

## 10. Validation of this contract

- This is documentation only: Prettier check, local links and independent review.
- Review r1 was NOT READY on the dispatch race, the metric window, M6c-A05 and the missing family-scoped lever. All of it is applied.
- No product, browser, GPU or benchmark run is claimed. Section 2 is read from the code at `5ce5b5b` and from the font-load fields of the V20-U3 records.

## 11. Progress

- 2026-11-02: drafted (PA-U2). Review r1 NOT READY; all ten findings applied:
  - L1 made deterministic: it holds on this port's pending faces, not on `document.fonts.status`, and the port's own `loadingdone` is treated as redundant;
  - L2 replaced by family-scoped invalidation, and the old L3 dropped;
  - scoped relayout made conditional (the new L3);
  - A01, A04 and A05 made measurable;
  - the bench font's being the fallback's file disclosed;
  - Q3 now holds the 3,000 ms cap, and Q4 reworded;
  - the out-of-scope long tasks named.
