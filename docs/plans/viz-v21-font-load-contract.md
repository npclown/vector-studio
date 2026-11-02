# V-21 font-load re-projection contract (pre-alpha PA-U2)

Status: DRAFT 2026-11-02, Full tier. This item changes product behavior in `packages/text-dom` and `packages/editor-core`: when the editor learns of a new text layout generation, and how much of the page it re-projects for it. It amends M6a-L3 and M6c-P4. It is visualization-track item [V-21](d9-visualization-track.md#status-index) and unit PA-U2 of the [pre-alpha gate plan](pre-alpha-gate-plan.md#4-units-and-order). Once the contract is approved, questions V21-Q1 to V21-Q4 (section 8) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

Owners:

- This contract owns V-21's levers, its acceptance criteria and its re-measure.
- The pre-alpha plan owns the gate (PA-A04) and what follows the re-measure (its section 5).
- The [M6a contract](mvp-m6a-text-model-contract.md) (L3) and the [M6c contract](mvp-m6c-gpu-text-contract.md) (P4) own text generations and their re-projection. They are amended only where section 4 says.

## 1. Problem

In `e26-pointer-busy-10k/v2`, the harness registers a second font two seconds into the drag. It marks this as `m9-font-load`, a font arriving mid-session. In the [M9-U2 record](../evidence/m9/u2-89393f1.md#long-tasks-font-load-autosave-and-typing), every run shows:

- three generation changes (3 to 6);
- four or five long tasks over 50 ms overlapping the load, most of them 170 to 250 ms.

V-20 did not change this. In the [V20-U3 sitting](../evidence/viz-v20/u3-b810f89.md) at `b810f89`, chrome-dpr1 busy r1 still has three tasks of 188, 208 and 175 ms flagged `fontLoad: true`, one per bump (`bumps` 3, generation 3 to 6). PA-U9 counts long tasks outside isolation against PA-A04, and they are not exempt (M9-Q3). Pointer moves that arrive during such a task wait behind it.

## 2. Cause, from the code at `5ce5b5b`

These are code facts. That they explain the tasks is the hypothesis that V21-U1 measures.

- **Three bumps per load.** `registerFont` in `packages/text-dom/src/text-dom.ts`:
  1. bumps once when it adds the face, a registry change;
  2. bumps once when `face.load()` settles;
  3. bumps again on `document.fonts` `loadingdone`.

  Each bump dispatches the listeners synchronously (M6a-L3: "each event increments it").

- **Each dispatch re-projects the page.** The editor's single port listener (`packages/editor-core/src/editor.ts`, M6c-P4) does three things:
  1. It drops the layout cache (`TextLayoutCache.notify`).
  2. It calls `SceneProjector.relayout`. That deletes every text entry from the memo, clears the instance results that hold text, sets `scoped = false` and calls `change(document, page, [])`.
  3. It raises one `textLayout` session event.

  With `scoped` false, `change` runs the whole-page `sync(project(document))`. That is a projection and change-set diff over the whole active page (the v2 document's page 1 projects up to 11,000 scene nodes), not only its text units.

- **Most text does not change.** Page 1 of the v2 document has 200 text nodes, plus the text in the instances of source 0 (`tests/m9/document.ts`). Only the `M9_V2_SECOND_FAMILY_NODES` (50) that name `M9 Font Load` can lay out differently once that family loads; the rest name the committed family, whose face is already loaded.
  - The first bump (the registry change) comes before the new face has loaded. Its layouts measure with the fallback, as they did before the bump.

## 3. Levers

| Lever | Where                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1    | `packages/text-dom`    | **One dispatch per settle.** The generation still increments on every event (M6a-L3's monotonic counter is unchanged). The listener dispatch is deferred to a task and coalesced: a bump schedules one dispatch, and later bumps before it runs add none. While `document.fonts.status` is `loading`, the scheduled dispatch waits for the next `loadingdone` or `loadingerror`. A load therefore reaches the editor once, after it settles. A DPR change still dispatches on its own task. |
| L2    | `packages/editor-core` | **Text-only relayout.** `relayout` re-projects the text units and the instances holding text through the scoped path, `scopedSync` with the touched set being those IDs, instead of the whole page. The scene's other nodes are not re-projected or diffed.                                                                                                                                                                                                                                 |
| L3    | `packages/editor-core` | **Only changed layouts are replaced.** After the new layouts are computed, a text unit whose layout equals its previous one (same lines and clusters) keeps its scene node, except for the generation stamp the atlas key needs (M6-F4). Whether this saves enough to justify its code is V21-U1's question (V21-Q2).                                                                                                                                                                       |

## 4. Behavior change (M6a-L3 and M6c-P4 amendment)

- **M6a-L3.**
  - The generation still increments on each listed event, before the dispatch.
  - Listeners run once per coalesced dispatch, on a later task, never inside `registerFont` or an event handler. They are held while `document.fonts` is loading.
  - `generation` read between a bump and its dispatch is already the new value. A `layout` call in that gap uses it, as today.
  - `dispose` cancels a pending dispatch.
- **M6c-P4.**
  - A generation change re-projects the active page's text units and text-holding instances through the scoped path.
  - Other nodes keep their scene nodes.
  - Other pages still re-project on their page switch.
  - The `textLayout` session event is raised once per dispatch, as today.
- **What a user sees.** Text that waits for a face keeps its fallback layout until the face settles, and then changes once instead of up to three times. That is no later than today's last change, apart from the one task of deferral.

## 5. Units

| Unit   | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Machine                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| V21-U1 | **Counters, before any fix.** Bench-only (`?bench=1`, M9-A03's rule) and inert without the bench. For each dispatch the editor receives, record:<ul><li>its time;</li><li>the relayout's duration, split into layout calls (count and time), projection, change-set send and the renderer's submit;</li><li>the number of text units and scene nodes it touched;</li><li>how many of the new layouts equal the old.</li></ul>A headless spec (`pnpm test:v21-count`, run by hand, not in CI) records these on the v2 pointer-busy path, as V20-U1 did. The record names which share dominates. | Cloud (headless), laptop if the renderer is needed |
| V21-U2 | L1 and L2, plus L3 if V21-Q2 keeps it. The M6a-L3 and M6c-P4 amendments go into those contracts. Unit tests: <ul><li>coalescing (add, settle and `loadingdone` give one dispatch; two loads in flight give one dispatch after both settle; `loadingerror`; DPR change alone; `dispose` with a pending dispatch);</li><li>the generation still rising per event;</li><li>`relayout` touching only text units and text-holding instances;</li><li>a layout read between bump and dispatch.</li></ul>The U1 counters again at the U2 head.                                                        | Cloud, laptop smoke                                |
| V21-U3 | Re-measure on the main PC at the V21-U2 head: `e26-pointer-busy-10k/v2` and `e26-pointer-plain-10k/v2`, with the v1 pointer rows as a control, in the M9-U2 conditions. Then tier 2 headed (`pnpm test:headed --tier 2`).                                                                                                                                                                                                                                                                                                                                                                      | Main PC, coordinator's slot                        |

## 6. Acceptance criteria

| ID      | Criterion                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V21-A01 | On the v2 pointer-busy path, one font load gives exactly one listener dispatch and one relayout, while the generation still rises by at least 3 (U2 counters, with U1's count before the fix recorded).                                                                  |
| V21-A02 | A relayout projects only text units and text-holding instances: the scene nodes it touches are at most the page's text units plus the instances that hold text (U2 counters).                                                                                            |
| V21-A03 | The final scene after the load equals today's: every text unit's lines, clusters and generation match a whole-page relayout's. A unit test compares both paths on a fixture with text, instances and text overrides; the headless spec compares them on the v2 document. |
| V21-A04 | The M6a and M6c criteria that cover generations still pass: the M6a unit suite, the M6c text atlas tests (no fallback raster reused after a load, M6-F4) and the m6 next-host suites headed in Chrome and Edge, in tier 2.                                               |
| V21-A05 | V21-U3 records, for each busy v2 run, the long tasks over 50 ms flagged `fontLoad`, with their durations, and PA-A04's v2 pointer rows. The target is 0 such tasks per run. If the target is missed, the record gives the remaining task's split from the U1 counters.   |

## 7. Gate

V-21 is done when V21-A01 to A05 are met. A05 requires the record, not the target: whether PA-A04 passes is the pre-alpha gate's question. After V21-U3, [section 5 of the pre-alpha plan](pre-alpha-gate-plan.md#5-re-entry-points) decides what follows.

## 8. Open questions

| ID     | Question                                                                                                              | Options and recommendation                                                                                                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V21-Q1 | Where are the dispatches coalesced?                                                                                   | (a) In text-dom (L1): one dispatch per settle for every port user. (b) In the editor's listener, debouncing its relayout; text-dom unchanged. **Recommended (a)**: the bumps are text-dom's events, any other listener has the same cost, and (b) still runs the listener three times.              |
| V21-Q2 | Is L3 (keep unchanged layouts' scene nodes) part of V21-U2?                                                           | (a) Only if V21-U1 shows that the scene send and renderer submit of unchanged units is the larger share after L2. (b) Always. (c) Never. **Recommended (a)**: L3 adds a comparison per unit and a special case for the generation stamp, so it should be justified by measurement.                  |
| V21-Q3 | Does the first bump (registry change) still dispatch on its own when no load follows (a face added and never loaded)? | (a) Yes: if `document.fonts` is not loading when the deferred dispatch runs, it dispatches. (b) Drop the registry-change bump. **Recommended (a)**: a registered family can shadow an installed one before it loads, so layouts can change; (a) keeps that and still merges it when a load follows. |
| V21-Q4 | Is a relayout split across frames (time slicing) in scope?                                                            | (a) No: L1 and L2 first; if V21-U3 still shows a font-load task over 50 ms, slicing is the next lever, in this item. (b) Yes, now. **Recommended (a)**: slicing gives frames with mixed generations, which needs its own rule, and L1 and L2 may suffice.                                           |

## 9. Risks

- **One relayout may still be long.** About 250 text layouts with measurement, plus the scoped projection, could still exceed 50 ms. A05 records it, and V21-Q4 names the next lever.
- **Deferral changes timing that tests may rely on.** A test that expects the `textLayout` event synchronously inside `registerFont`, or right after `loadingdone`, changes. V21-U2 lists each one.
- **The scoped path must handle instance text.** If `scopedSync` misses an instance whose expansion holds text, that instance shows a stale layout. V21-A03 compares against the whole-page path.
- **`document.fonts.status` stays `loading`** while any unrelated face loads (for example a UI web font). The dispatch then waits for that face too. A test covers two loads in flight.

## 10. Validation of this contract

Documentation only: Prettier check, local links and independent review. No product, browser, GPU or benchmark run is claimed. The cause in section 2 is read from the code at `5ce5b5b` and from the font-load fields of the V20-U3 records.

## 11. Progress

- 2026-11-02: drafted (PA-U2).
