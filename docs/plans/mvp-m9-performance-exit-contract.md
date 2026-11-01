# MVP M9 contract: performance and MVP exit

Status: DRAFT 2026-11-01, for independent review. Standard tier: benchmark workloads, bench-host flags and evidence. No public API, schema, renderer or `contracts` change. A remedy that changes product code is out of this contract; gate G1 (section 9) decides whether one is written, as its own amendment. Visualization-track item V-19 in the [track status index](d9-visualization-track.md#status-index), milestone M9 of the [MVP editor plan](mvp-editor-plan.md#m9-performance-and-mvp-exit). The user accepted the M8 exit on 2026-11-01 at 20:49Z, recorded by status PR #448 (`d21df69`). Open questions M9-Q1 to M9-Q8 are in section 11.

Owners: this file owns M9 scope, the M9 workloads and their scenario IDs (section 3), the bench-host flags they add (section 4), the reference sitting (section 5), the identity sitting (section 6), the form of the MVP exit record (section 7), acceptance criteria M9-A01 to M9-A08 and the units. Product behavior stays in [`requirements.md`](../requirements.md) (Platform and performance), which this contract does not change. Methodology stays in the [benchmarks README](../benchmarks/README.md). The E26 measurement rules ([E26 contract](d9-e26-pointer-priority-contract.md), section 3) are reused unchanged, except where section 1.3 says otherwise.

## 1. Scope

In scope:

- The MVP performance evidence the plan asks for, on the main PC: a 10,000-node mixed editor document with every node visible as the worst case, typical editing at 60 fps, a 10,000-simple-node stress scene at 30 fps or more, and pointer-input latency while background work runs.
- Measured on the editor as M1 to M8 ship it: the M8 right column mounted, and a document with symbols, instances and text.
- The E26 v2 scenarios that E26 and the M6 exit left owed. A typing observation.
- A final identity and regression sitting at the exit head.
- The MVP exit record: one row per requirement bullet, the disclosed defects carried from P3 and P4, every milestone's disclosures, and the remaining backlog. The user's acceptance of that record is the MVP exit.

Out of scope:

- Performance remedies (gate G1 decides whether any are written).
- P1 A09 memory, P1 A10 physical presentation, and P2 A08 (M9-Q5).
- Lower-tier hardware (MVP plan: after the MVP).
- Worker or `OffscreenCanvas` rendering.
- Any change to what a scene draws.
- Any requirement change (M9-Q2 and M9-Q4 name the ones the user may choose at G1).

### 1.1 Starting point (main at `d21df69`)

- **Harness.** `pnpm test:e26` (`playwright.e26.config.ts`) runs `tests/e26/e26-harness.spec.ts`.
  - Projects: headed `chrome-dpr1`, `chrome-dpr2`, `edge-dpr1`, `edge-dpr2` in a 1400 × 1000 viewport. `E26_CHROMIUM` selects the smoke project `chromium-smoke-dpr1`. `E26_REPETITIONS` and `E26_SCENARIOS` narrow a run.
  - Scenario definitions are in `tests/e26/scenarios.ts`. The bench host is `apps/next-host/src/e26-bench.ts` (`?bench=1`, with `doc=`, `persist=1`, `reject=`, `isolation=1`), and its canvas is 1280 × 720.
  - `node tooling/e26-summarize.mjs` writes the summary.
- **Latest reference run.** [E26-U6b at `8629d30`](../evidence/e26/u6b-8629d30.md): 140 of 140 runs valid. Maximum per-run p95 by scenario:

  | Scenario | Max per-run p95 | Against target |
  | --- | --- | --- |
  | Typical view, edit | 16.8 ms (Edge), 33.3 to 33.4 ms (Chrome) | Miss |
  | All-visible, edit | 66.8 to 83.3 ms | Miss |
  | All-visible, pan | 83.5 to 100 ms | Miss |
  | Simple stress | 16.8 ms | Pass |
  | Pointer latency, busy | 232 to 327 ms | Miss |
  | Pointer latency, plain | 192 to 237 ms | Miss |

  The misses are backlog [E30](d9-rendering-track.md), paused by the user on 2026-11-01 until M9 shows real-editor misses.
- **What the bench omits.** Under `?bench=1`, `CanvasSide` renders only the M4 Appearance aside (`apps/next-host/src/m8-layout.tsx:51-52`; 112 px wide in the e26 viewport, M8-U6 notes), not the M8 layer tree or property panel (M8-N5). `layerRows` walks the whole active page on each document change, and that cost is unmeasured ([M8 exit](../evidence/m8-exit-2026-11-01.md)). The bench document is the M1-A13 document (`tests/m1-a13/document.ts`, seed `0x6d31a13`, 10,634 scene nodes on page 1), which has no instances and no text.
- **Observations with no claim.**
  - M1-A13: about 77 ms per gesture update before E26.
  - M4-A13: `setStyle` over 10k nodes takes 340 to 390 ms, and the miter first frame about 20 s.
  - M7-A10: about 169 ms per gesture update inside a source.
  - M6c-A10: about 330 to 350 ms per keystroke at 16,384 units (headed, main PC).

### 1.2 Inherited items

| Source | Item | Disposition |
| --- | --- | --- |
| E26 section 3.1; [M6 exit](../evidence/m6-exit-2026-11-01.md), follow-up 9 | `e26-mixed-view-edit-10k/v2` (instances, text) and `e26-pointer-busy-10k/v2` (text, a font-load generation change under load) | M9-U1 (M9-A01, A02) |
| M8 exit; M8 contract, risk "Panel cost" | Layer tree and property panel at 10k nodes | `ui=1` variant, M9-U1 and U2 (A02, A04) |
| M6 exit; M6c contract, section 12 | Typing cost on the main thread | `m9-typing-10k/v1`, recorded (M9-Q4) |
| M6 exit, follow-up 7 | The full headed E28 spec on the reference PC at `canvas-2d/raster-v1` | M9-U4 (A06) |
| M8 exit, M8-A14 | E26 smoke clause met only in part (SwiftShader latency `unresolved`) | Smoke stays functional only; M9 claims rest on the main PC (M9-Q8) |
| M4 exit; M5 exit; M6a and M6c contracts; M7 exit | Path projection cost, miter first frame, whole-document autosave serialization, text layout per node, font-load blank frames, instance expansion cost | Measured where the section 3 workloads exercise them (the write-start hook times autosave); the rest listed in the exit record as known limits |
| E30 | E26 misses | Re-measured in M9-U2; G1 decides |
| P1 A09, A10; P2 A08; D10 phase R2 | Open performance debt | M9-Q5 |
| M6-S0; M6c-Q12 | Eight raw JSON reports, a user action | Listed as owed in the exit record (M9-Q7) |

### 1.3 Changes to earlier rules

- E26 section 3.5 "Baseline": M9 does not re-pin a baseline. The M9-U2 run is reported beside U6b. Neither becomes an accepted regression baseline unless the exit acceptance says so ([benchmarks README](../benchmarks/README.md#regression-comparison)).
- Ownership of the E26 v2 scenarios moves from the rendering track to M9 (M9-Q6). They change only `tests/e26/` and the bench host. A change to renderer behavior would take E26's rendering-track review.

## 2. Requirement mapping

| Requirement (Platform and performance) | Judged by |
| --- | --- |
| Current desktop Chrome and Edge are the prototype target | Every M9 sitting runs headed Chrome and Edge, versions recorded |
| A document may contain 10,000 nodes | The v2 document (section 3.1): 10,000 document nodes, with projected scene nodes counted as M7-Q13 (a) |
| In a worst-case scene, all 10,000 nodes may be visible | `e26-mixed-all-*-10k/v2` at camera F: maximum per-run p95 ≤ 33.3 ms (the E26 reading of the worst case) |
| Typical editing targets 60 frames per second | `e26-mixed-view-edit-10k/v2`: maximum per-run p95 ≤ 16.7 ms (M9-Q2) |
| A 10,000-simple-node stress scene targets at least 30 frames per second | `e26-simple-stress-10k/v2`: maximum per-run p95 ≤ 33.3 ms |
| Pointer responsiveness has priority over background or nonessential work | `e26-pointer-busy-10k/v2`: `pointerToWorkDoneMs` p95 < 50 ms, and no long task over 50 ms other than the marked isolation (E26-A04, A05 rules; M9-Q3) |

Each row reports PASS, FAIL or UNVERIFIED by the E26 rules (section 3.2 of that contract: maximum per-run p95, nearest rank, no rounding allowance; every repetition kept).

## 3. Workloads

### 3.1 The v2 document

The v2 document is generated by `tests/m9/document.ts` from indices and one seed (`0x6d39`), as the M1-A13 and M7-A10 generators are. It is built at the current schema version, and the configuration records a SHA-256 of the generated document. It is the M1-A13 document with two changes on page 1. The total stays at 10,000 document nodes, and projected scene nodes on page 1 stay between 9,500 and 11,000:

- **Instances.** About 10 % of the leaves become instances of 10 symbol sources, each source a group of about 10 nodes, so at least 1,000 projected scene nodes come from expansion. Half the instances keep the source size, the other half are scaled. A few carry a text override once text exists in the source.
- **Text.** 200 text nodes replace leaves of the same frames. Each has one to three runs in Noto Sans KR, the family the M6c specs use, 10 to 60 grapheme clusters each, and at least 6,000 clusters in total. Fixed width and auto width alternate.

The M1-A13 move selection keeps its definition, so the edit drag is comparable with v1. CI checks the counts, the hash and that `parseDocument` accepts the document (M9-A01).

### 3.2 Scenarios

New IDs follow the [scenario identity rule](../benchmarks/README.md#scenario-identity). Every v2 scenario runs with `ui=1` (section 4). Cameras, drivers, cadence, window and metrics are the v1 scenario's, except where a row says otherwise.

| ID | Document | Interaction | Target |
| --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v2` | v2, the typical view: U1 chooses the camera by v1's rule, 900 to 1,100 drawn leaves visible | The edit drag | ≤ 16.7 ms |
| `e26-mixed-all-edit-10k/v2` | v2, camera F | The edit drag | ≤ 33.3 ms |
| `e26-mixed-all-pan-10k/v2` | v2, camera F | The pan and zoom path | ≤ 33.3 ms |
| `e26-simple-stress-10k/v2` | v1's stress document, unchanged | The pan and zoom path | ≤ 33.3 ms |
| `e26-pointer-busy-10k/v2` | v2, typical view, autosave on | The v1 latency drag and background work, plus one font-load generation change through the layout port, armed at 2.0 s, which re-lays out every text node on the page | `pointerToWorkDoneMs` p95 < 50 ms; no long task over 50 ms other than the marked isolation |
| `m9-typing-10k/v1` | v2, typical view, autosave on | One click into a 60-cluster text node in the view, then 40 typed characters at 120 ms intervals through `page.keyboard` | Recorded: `keyToWorkDoneMs` per key, from the `keydown` `timeStamp` to the first submitted work done at a scene revision at or after the edit's, as `pointerToWorkDoneMs` is (M9-Q4) |

The v1 scenarios run unchanged in the same sitting, for comparison with U6b. A v1 result is not an MVP verdict (M9-Q1).

## 4. Bench-host flags

- **`ui=1`, with `?bench=1` only.** `CanvasSide` renders the next-host right column (`LayerTree`, `PropertyPanel`, `EditorPanels`, as without `?bench=1`) in place of the bench's Appearance aside.
  - The canvas keeps its size (1280 × 720 CSS px) and its origin.
  - v2 projects use a 1600 × 1000 viewport, so the 300 px column fits beside the canvas. The window must fit unobscured on the main PC's display, and the sitting records the display mode.
  - The column is as M8 ships it: the layer tree expanded at the move selection's frame, and the property panel showing the selection, so the drag re-renders both.
- **`doc=m9-v2`.** Loads the section 3.1 document through the existing bench loader. `doc=` stays inert without `?bench=1`.
- **The font-load change** for `e26-pointer-busy-10k/v2`. A bench-only seam bumps the layout port's generation once, as a real font load does (M6c). It is marked `m9-font-load` with `performance.mark`. The long task it causes is reported, and is not exempt like isolation (M9-Q3).
- No flag changes `?test=1` or a page without `?bench=1`. CI checks that, and that the canvas origin and size are equal with and without `ui=1` (M9-A03).

## 5. Reference sitting (M9-U2)

- **Before the sitting.**
  - A functional pre-run on the laptop with `E26_REPETITIONS=1`. It is not evidence, because the laptop has an Intel iGPU.
  - Then the main PC, through the coordinator's PC queue.
  - The user's own Chrome, Edge and Node processes are closed where practical, and any that stay running are recorded. U6b found them running, so M9 asks first.
- **Runs.** Headed Chrome and Edge at DPR 1 and 2, five repetitions, every v1 and v2 scenario and `m9-typing-10k/v1`. Each record keeps the full metadata of the README's accepted-run list (refresh rate, power and display included). Hidden, occluded or throttled runs are kept and investigated, never replaced.
- **Commit.** The sitting runs at the merge commit of M9-U1 (M9-Q8), with a clean tree.
- **Output.**
  - Raw records and the summary go to `docs/evidence/m9/u2-<commit>/` (runs, `files.txt`, `summary.json`).
  - One result file per scenario and browser goes to `docs/benchmarks/results/` under the README's naming, with the machine named "main PC" and a run-ID suffix. Writers refuse to overwrite.
  - A record `docs/evidence/m9/u2-<commit>.md` holds the results table: section 2's verdict per row, the v1 rows beside U6b, the frame CPU split, long tasks, autosave write timings and typing.

## 6. Identity sitting (M9-U4)

At the exit head (M9-U1's merge, or later if a remedy lands), on the main PC:

- the full `pnpm test:gpu`;
- every next-host headed spec (P5, M1 to M8, M6c);
- the full headed E28 spec at `canvas-2d/raster-v1`.

Every failure is kept and disclosed. A test that passes when repeated alone is disclosed as such, as E26-A08's was.

## 7. MVP exit record (M9-U5)

The record is `docs/evidence/mvp-exit-<date>.md`.

- **Requirements.** One row for every bullet of `requirements.md`, with its section, the evidence (milestone exit record and criterion, or an M9 result) and one verdict: PASS, PASS with disclosure, FAIL, UNVERIFIED, or deferred by the requirements text.
- **Milestones.** A table of M1 to M9 with the exit record, the acceptance date and the disclosures carried.
- **Disclosed defects.** The rendering defects carried from the P3 exit (A01 FAIL on crack width; A02 and A08 INCONCLUSIVE; A04 UNVERIFIED with five classes disclosed) and the P4 exit limitations, each with its backlog item.
- **Backlog.** The open backlog (E4 to E7, E12 to E15, E18, E19, E27, E29 to E32, and the visualization items left open by M1 to M8), one line each.
- **Performance.** Section 2's verdicts, the G1 decision, and the open debt (M9-Q5).
- **Owed user actions.** M6-S0's raw reports, and any other (M9-Q7).

The record makes no claim beyond its evidence. Its status is PROPOSED until the user accepts it on a decision card.

## 8. Acceptance criteria

| ID | Criterion | Validation |
| --- | --- | --- |
| M9-A01 | The v2 document generator is deterministic. Each of these matches section 3.1: document nodes, projected scene nodes, instance-expanded nodes, text nodes and clusters, and the hash. `parseDocument` accepts the document. | Unit test, CI |
| M9-A02 | Every section 3.2 scenario has a configuration, a configuration hash and a stable ID. The typical-view camera of v2 holds 900 to 1,100 drawn leaves. Every drawn leaf is inside the viewport at F. | Unit and check tests, CI; headed check in U2 |
| M9-A03 | `ui=1`, `doc=m9-v2` and the font-load seam are inert without `?bench=1`. The canvas size and origin are equal with and without `ui=1`. | Unit test; headless smoke |
| M9-A04 | The reference sitting is complete: every scenario, browser, DPR and repetition, with records and metadata as section 5 says. | Record review in U2 |
| M9-A05 | Section 2's six rows each carry a measured PASS, FAIL or UNVERIFIED with the evidence path. | The U2 record |
| M9-A06 | The identity sitting ran as section 6 says, with every failure disclosed. | The U4 record |
| M9-A07 | The MVP exit record holds every section 7 part, with one row for every bullet of `requirements.md`. | Independent review of the U5 record |
| M9-A08 | The user accepts the MVP exit record. | Decision card |

M9-A05 asks for a measured verdict, not for PASS. Whether a FAIL blocks the MVP exit is the G1 decision.

## 9. Gate G1 (after M9-U2)

With the U2 results, the user gets one decision card. Its recommendation is made from the measured numbers. The options are:

- **(a) Exit with the misses disclosed.** Every FAIL row goes to the exit record and to backlog (E30, plus a new item for any panel or text cost U2 finds), and M9 goes on to U4 and U5.
- **(b) Remedy within M9.** A contract amendment names the levers (E30's: the mesh per-path pass, mask planning, clip-state assignment, the GPU share; and any panel or text cost U2 finds), their tier and their units, then U3 implements them and U2's scenarios re-run. The amendment needs independent review, and a rendering-track review for renderer changes.
- **(c) Change a target.** This is a requirement change, M9-Q2 or M9-Q4. Only the user can make it, and it is recorded in `requirements.md` by its own PR.

## 10. Units

| Unit | Tier | Content | Criteria |
| --- | --- | --- | --- |
| M9-U1 | Standard | `tests/m9/document.ts`; the v2 and typing scenarios in `tests/e26/scenarios.ts` and the harness; `ui=1`, `doc=m9-v2` and the font-load seam in the bench host; v2 projects in `playwright.e26.config.ts`; the summarizer reads v2 and typing records; unit tests | A01 to A03 |
| M9-U2 | Light (evidence) | Laptop pre-run, the main-PC reference sitting, records and result files, the U2 record; then gate G1 | A04, A05 |
| M9-U3 | Set by G1 (b) | Remedies, only under an approved amendment | Set by the amendment |
| M9-U4 | Light (evidence) | The identity sitting at the exit head and its record | A06 |
| M9-U5 | Light (docs) | The MVP exit record, its review and the acceptance card; then a status PR | A07, A08 |

U1 is the only unit that touches code, and it touches only bench and test code. Each unit merges as its own PR after independent review and green CI.

## 11. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| M9-Q1 | Which workload is judged against the requirements? | (a) The v2 scenarios with `ui=1`, because they are the editor as shipped; v1 is reported for continuity with E26. (b) v1 only, which leaves out panels, instances and text. |
| M9-Q2 | Is the 16.7 ms ceiling read with a rounding allowance? U6b missed it on Edge by 0.1 ms of vsync jitter. | (a) Keep E26's no-rounding verdict, and report a second line: the share of intervals over 1.5 refresh intervals. The user may choose a different reading at G1 (c). |
| M9-Q3 | Latency metric | (a) Keep `pointerToWorkDoneMs`, the named proxy (E26-Q3), so P1 A10's physical presentation stays open. The font-load long task is reported, not exempt. |
| M9-Q4 | Typing target | (a) Recorded only, because the requirements set no typing target. (b) A target such as 50 ms per key would be a requirement change (G1 (c)). |
| M9-Q5 | P1 A09 and A10, P2 A08 | (a) Not MVP criteria. They are listed in the exit record as open debt for a pre-alpha gate, D10 phase R2's "defer to a pre-alpha gate", and the exit card asks the user to confirm that. |
| M9-Q6 | Owner of the E26 v2 scenarios | (a) M9, on the visualization track, while the rendering track is paused; bench and test code only. |
| M9-Q7 | M6-S0's raw JSON reports | (a) Owed by the user, listed in the exit record, not blocking. |
| M9-Q8 | Commit of the reference sitting | (a) M9-U1's merge commit; the identity sitting at the exit head. Laptop and container smoke stay functional only. |

No recommended option needs a new dependency or changes a requirement. They may be adopted as recommended under the user's standing rule of 2026-10-24 once the contract is approved. The G1 card is the user's own decision and is not auto-adopted, because it decides whether the MVP exits with performance misses.

## 12. Risks

- **Length of the sitting.** U6b's 140 runs took 1.1 h. The v1 and v2 scenarios together, with typing, make about 300 runs, about 2.5 h on the main PC.
- **Background load.** U6b ran with the user's browsers open, and Chrome's typical-view p95 doubled without a known cause. Section 5 asks for them to be closed first, and a repeat of the doubling is investigated before G1.
- **Panel cost may dominate.** `layerRows` walks the page on each change, so v2 may miss where v1 passes. That is what M9 has to show.
- **Display fit.** A 1600 × 1000 window needs a display at least that large, unobscured. If the main PC cannot fit it, U1 narrows the column, and both the column and the viewport are stated in the configuration.
- **Text under load.** The font-load change re-lays out 200 nodes on the main thread. Its long task is a real cost and is reported as one.

## 13. Validation of this contract

Documentation only: Markdown formatting (`npx prettier --check`) and local links. Claims about the code are grounded at `d21df69`. No product, browser, GPU or benchmark run is claimed.

## 14. Gate

M9 comes "after M1..M8" (MVP plan, section 7). M8 was accepted on 2026-11-01 (#448). M9-U1 starts after independent review approves this contract. The MVP exit is the user's acceptance of the M9-U5 record.

## 15. Progress

| Unit | State |
| --- | --- |
| M9-U1 | Not started |
| M9-U2 | Not started |
| M9-U3 | Conditional on G1 |
| M9-U4 | Not started |
| M9-U5 | Not started |
