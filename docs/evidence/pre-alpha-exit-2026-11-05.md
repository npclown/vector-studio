# Pre-alpha exit record (2026-11-05)

**Status: PROPOSED**, awaiting the user's exit card (PA-A11). This record is unit PA-U10 of the [pre-alpha gate plan](../plans/pre-alpha-gate-plan.md) (V-22), in the form of plan section 6. It lists PA-A01 to A10 with one verdict each and the record that holds it, the gate exceptions the user decides on the card, every remedy PR, the section 2 carried items by name, the machines, the backlog after the gate and the owed user actions. It makes no claim beyond the records it cites.

**The gate does not pass as written.** PA-A02, A09 and A10 pass (A02 and A09 with disclosure). PA-A01, A03 and A04 miss on the main PC at the gate head. PA-A05 is UNVERIFIED, and could read FAIL. PA-A08 was waived by the user. Under plan section 3 each of these is a gate exception, never adopted automatically. Section 3 below lists them for the exit card. PA-A06 (UNVERIFIED) and PA-A07 (FAIL) meet the non-blocking rules the user chose (PA-Q3 (a), PA-Q4 (a)).

## Verdict words

- **PASS**: the cited criterion passed.
- **PASS with disclosure**: as PASS, with a limit the cited record discloses; the limit is named in the row.
- **FAIL**: a measured miss.
- **UNVERIFIED**: no cited record shows the criterion holding; the reason is in the row.
- **Non-blocking**: a verdict that meets the rule the user chose for that row (PA-Q3, PA-Q4).
- **Waived**: removed from the gate by a recorded user decision.

## 1. Gate head and machines

- **Gate head** `eadc1d7` (origin/main after #502), where PA-U9 ran. Under the plan's gate-head rule, the earlier records count when no `packages/` or `apps/` file they measure changed before the gate head. `git diff --stat <head> eadc1d7 -- packages apps` is empty for PA-U6 (`6e17276`), PA-U5 (`6eb90f2`), PA-U7 (`e396f34`) and PA-U8 (`f9fb912`), so all four count.
- **Main PC** DESKTOP-DKVUSAV (Ryzen 7 3700X, GTX 1660 SUPER, Windows 11, Chrome 156.0.8078.81, Edge 156.0.4314.58) is the reference machine. It holds every gated timing, memory, presentation and identity record.
- **Laptop** DESKTOP-O0IIPP6 (i9-13900H) ran PA-U7. WebGPU took its RTX 4050, not the integrated GPU, because the renderer requests the high-performance adapter. So the sitting is a discrete-GPU observation, not the PA-Q5 lower-tier reference.
- **Cloud containers** ran CI and headless checks only. They make no performance claim.

## 2. Criteria

| ID     | Criterion (short)                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Verdict                         | Record                                                                                       |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| PA-A01 | Typical editing `e26-mixed-view-edit-10k/v2` ≤ 16.7 ms                    | 16.8 ms max per-run p95 in all four projects, which is one refresh (idle rAF median 16.7 ms). 0.1 ms over the ceiling, so PA-Q6 sends the reading to the user.                                                                                                                                                                                                                                                                                                                                         | FAIL (reading to the user)      | [PA-U9](pa-u9-eadc1d7.md)                                                                    |
| PA-A02 | Stress `e26-simple-stress-10k/v2` ≤ 33.3 ms                               | 16.8 ms in all four projects. The user's Chrome was open when timing started (PA-U9 departure); contention can only add time                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS with disclosure                            | [PA-U9](pa-u9-eadc1d7.md)                                                                    |
| PA-A03 | All visible: `e26-mixed-all-edit-10k/v2` and `-all-pan-10k/v2` ≤ 33.3 ms  | Edit 50.1 ms and pan 66.7 to 66.8 ms in every project (three and four refreshes)                                                                                                                                                                                                                                                                                                                                                                                                                       | FAIL                            | [PA-U9](pa-u9-eadc1d7.md)                                                                    |
| PA-A04 | Pointer priority `e26-pointer-busy-10k/v2` p95 < 50 ms, E26-A05 clauses   | Max per-run p95: busy 259.6 to 483 ms and plain 244.1 to 295.9 ms per project. Busy E26-A05: no write during the press, but the first write after up comes 69 to 84 ms later (not within one frame), and one font-load task of 60 to 73 ms runs during the press in every run. The release was applied in all 40 runs.                                                                                                                                                                                  | FAIL                            | [PA-U9](pa-u9-eadc1d7.md)                                                                    |
| PA-A05 | Memory ≤ 256,000,000 bytes on `e26-simple-stress-10k/v2` (PA-Q2 (a))      | Floor sum: 250.0 to 251.4 MB at DPR 2 and about 162 MB at DPR 1, all under the bound. M1, M2 and M7 have no exact high-water mark. PA-U4c's `start_memory_size` floor was not implemented; PA-U4c saw it 0 to 17.2 MB (Chrome) and 0 to 20.7 MB (Edge) above the previous GC's end, more than this sitting's 4.6 to 6.0 MB margin, so it could take DPR 2 over the bound (FAIL under A09-Q4 (a)). The raw traces are kept on the main PC.                                                                                                                                 | UNVERIFIED (possible FAIL)      | [PA-U9](pa-u9-eadc1d7.md), [PA-U4c](pa-u4c/8d873e8.md)                                       |
| PA-A06 | Presentation (P1 A10): one bounded, correlated attempt                    | One elevated PresentMon capture, correlated. The weak lower bound of pointer-to-present is 17.0 ms at p50 and 61.1 ms at most. No frame identity joins a present to a move, so the result is not validated.                                                                                                                                                                                                                                                                                           | UNVERIFIED, non-blocking (PA-Q3 (a)) | [PA-U5](pa-u5-6eb90f2.md)                                                               |
| PA-A07 | Batch geometry (P2 A08) re-run                                            | Functional PASS. Reference median paired B/A is 0.991 to 1.004 in all ten repetitions, against ≥ 1.20, on a changed kernel.                                                                                                                                                                                                                                                                                                                                                                            | FAIL, non-blocking (PA-Q4 (a))  | [PA-U6](../benchmarks/results/20261104-p2-batch-v1-pa-u6/README.md)                          |
| PA-A08 | Lower tier: tier 2 on the lower-tier reference                            | Not run on an integrated GPU. On 2026-11-04 at 21:43Z the user decided a lower-tier test is not needed. The laptop sitting on the RTX 4050 (tier 2 343 of 343, v2 workloads observed) is kept as an observation.                                                                                                                                                                                                                                                                                         | Waived (user decision)          | [PA-U7](pa-u7-e396f34.md)                                                                    |
| PA-A09 | R34 system fonts by name, R68 "not failures" cases                        | R34: headed check 4 of 4 in Chrome and Edge, max \|layout − canvas\| = 0. R68: the three cases are checked by unit test. On 2026-11-04 at 12:00Z the user reworded the stroke-port case to match ST-A10. The R34 run shared the PA-U6 sitting, whose P2 runner recorded `dirty: true` (sources equal `6e17276`).                                                                                                                                                                                                                                                                                                 | PASS with disclosure                            | [PA-U6 record, R34](../benchmarks/results/20261104-p2-batch-v1-pa-u6/README.md#pa-u8-r34-same-sitting), #497 |
| PA-A10 | Tier 3 at the gate head 0 failed, flaky or skipped; CI green              | Tier 3: 460 passed, 0 failed, 0 flaky, 0 skipped (14 stages, 89.1 min). CI `Validate` passed on the `eadc1d7` push (Actions run 41921042484, 2026-11-04 21:58Z).                                                                                                                                                                                                                                                                                                                                                                                       | PASS                            | [PA-U9](pa-u9-eadc1d7.md#pa-a10-tier-3)                                                      |
| PA-A11 | This record accepted on a decision card                                   | Pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Pending                         | this record, section 9                                                                       |

## 3. Gate exceptions for the exit card

Each item is a non-PASS outside PA-Q3 and PA-Q4, so the user decides it.

1. **PA-A01, 16.8 ms against 16.7 ms.** The frame takes one refresh in every run. On this PC a refresh measures 16.7 to 16.8 ms, so the row can pass only if the refresh interval is read as meeting 60 fps. Under the no-rounding rule (PA-Q6 (a)) it is a miss. The reading is the user's (plan section 5).
2. **PA-A03, all visible.** The frames take three and four refreshes. E30 closed with its CPU share removed; [E30 U6](e30/u6-80e4789.md) reads the remainder as GPU-bound (the main pass is about 35 to 40 ms), and that remedy is backlog E34.
3. **PA-A04, pointer priority.** The latency misses in both variants, and the busy run misses two E26-A05 clauses: the held write after up and the font-load task during the press. E30 U6 names the owners: the editor's handler share (about 11 ms of a median move) and the claim-to-done share (frame pacing and GPU queue; E34's frames-in-flight candidate). Plan section 5's single return to PA-U1 for the handler share was not taken: removing about 11 ms of a median move passes no row (worst per-run p95 259.6 to 483 ms), as with the earlier V-20 and V-21 returns. The share goes to this card with the rest of PA-A04.
4. **PA-A05, memory.** It reads UNVERIFIED and could read FAIL. On 2026-11-02 at 22:26Z the user chose to disclose it, take no memory remedy now and put memory reduction in the backlog. That still applies, and the PA-U9 numbers do not change it.
5. **PA-A08, lower tier.** It was waived by the user on 2026-11-04. [`prototype-plan.md`](../prototype-plan.md#accepted-implementation-constraints) constraint 2 ("a lower-tier GPU gate is added before alpha distribution") is unchanged by the waiver. Unless the user removes it, a lower-tier check stays owed before alpha distribution (section 8).

## 4. Remedy work by unit

| Unit                     | What                                                                                                                                                        | PRs                                                                         | Record                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| PA-U0                    | The plan and the user's decisions                                                                                                                           | #458, #460                                                                  | —                                                   |
| PA-U1 (V-20)             | Right column: no re-render per camera step                                                                                                                  | #461, #464, #466, #470                                                      | [V20-U3](viz-v20/u3-b810f89.md)                     |
| PA-U2 (V-21)             | Font load: one dispatch per registration, family-scoped invalidation                                                                                       | #472, #473, #474, #475, #476                                                | [V21-U3](viz-v21/u3-b6e9343.md)                     |
| PA-U3 (E30)              | Renderer cost: frame and latency split, kept outcomes across camera moves, unchanged frames, word-wise compare, GPU profile                                  | #462, #463, #469, #477 to #489, #491 to #496                                | [E30 U6](e30/u6-80e4789.md)                         |
| PA-U4                    | A09 memory method and validation                                                                                                                            | #467, #468, #471                                                            | [PA-U4c](pa-u4c/8d873e8.md)                         |
| PA-U5                    | PresentMon tooling and capture                                                                                                                              | #499, #501                                                                  | [PA-U5](pa-u5-6eb90f2.md)                           |
| PA-U6                    | P2 benchmark config and re-run                                                                                                                              | #498, #500                                                                  | [PA-U6](../benchmarks/results/20261104-p2-batch-v1-pa-u6/README.md) |
| PA-U7                    | Laptop sitting                                                                                                                                              | #502                                                                        | [PA-U7](pa-u7-e396f34.md)                           |
| PA-U8                    | R34 and R68 checks, R68 wording                                                                                                                             | #497                                                                        | plan section 10                                     |
| PA-U9                    | Gate-head sitting                                                                                                                                           | #503                                                                        | [PA-U9](pa-u9-eadc1d7.md)                           |
| Headed tiers (alongside) | Tier 2 under 30 minutes                                                                                                                                     | #459, #465                                                                  | [validation](../validation.md#headed-run-tiers)     |

**What moved.** These are the per-project maxima of the v2 rows, from the MVP exit sitting [M9-U2](m9/u2-89393f1.md) to the gate head:

- Stress went from 83.2 to 83.4 ms (a miss) to 16.8 ms (a pass).
- The typical view went from 33.4 to 33.5 ms to 16.8 ms.
- All-edit went from 83.4 to 83.5 ms to 50.1 ms, and all-pan from 100 to 100.1 ms to 66.7 to 66.8 ms.
- The pointer busy row went from 888.2 to 1,347.9 ms to 259.6 to 483 ms.

## 5. Section 2 carried items, by name

- **In the gate**, with their rows above:
  - MVP exit section 5.1, the four FAIL rows: PA-A01 to A04.
  - Section 5.2's causes: V-20 and V-21 are done, and E30 is closed with E34 in the backlog.
  - Section 5.4's debt: P1 A09 (PA-A05), P1 A10 (PA-A06) and P2 A08 (PA-A07).
  - D10 phase R2: carried by M9-Q5 (a) and closed when this record is accepted (PA-A11).
  - The prototype-plan lower tier: PA-A08, waived, with constraint 2 still standing.
  - R34 and R68: PA-A09.
- **Not in the gate**, carried unchanged:
  - The P3 disclosed defects: the A01 crack, A02 and A08 INCONCLUSIVE, and A04 UNVERIFIED. Also E7, E18, E19 and E29.
  - E27, E31, E32.
  - The M4 miter first frame: about 20 s on 10,000 miter-joined rectangles.
  - Typing cost at 16,384 units.
  - Whole-document autosave serialization.
  - R33, real Korean IME (PA-Q7 (a)): UNVERIFIED unless the user records a real-IME session.
  - The decision cards M6c-Q15 and Q16.
  - New features.

## 6. Disclosures

- **PA-U9 sitting conditions.** The user's Chrome was open when timing started; it was gone before memory and tier 3. One `ui=0` v1 control failed with "browser closed" and was not re-run. Neither touches a gated row's verdict ([PA-U9](pa-u9-eadc1d7.md#departures-from-the-sitting-conditions)).
- **PA-U6 tree.** The P2 runner recorded `dirty: true`. All 111 hashed sources equal the blobs at `6e17276`.
- **An intermittent drag defect.** Sometimes a drag stops applying moves, an autosave write runs during the press, and the release is not applied. It was seen twice: V-21 U3 attempt 1 (`edge-dpr2-v2` busy r1) and the PA-U5 busy run. It did not occur in PA-U9's 40 pointer runs, and PA-U7's 72 E26 runs all passed. Its cause is not found. It can silently drop a user's drag, so it is named here as a follow-up (section 7).
- **Precision.** Every renderer output stays UNVERIFIED against 0.25 px (P3 A04). Headed evidence is Chrome and Edge 156 on the main PC with Playwright input.

## 7. Backlog after the gate

- **E34**: the GPU cost of the all-visible main pass, the mask passes in pan and the `vs-gpu` delay. It targets PA-A03 and the claim-to-done share of PA-A04.
- **The editor's pointer handler share**: about 11 ms of a median move, from the E30 U6 attribution. It needs an item.
- **The held write after pointer up** (busy, 69 to 84 ms against one frame): cause not established (E30 U6); not covered by E34. It needs an item.
- **The font-load long task during the press** (60 to 73 ms, one per busy run): what remains of V-21's cost after V-21 closed; V-21's slicing lever was not taken. It needs an item.
- **Memory reduction** (user decision 2026-11-02): GPU and canvas memory at DPR 2.
- **Memory method** (PA-U4c's next steps): an in-GC bound or route for M1, and routes for M2 and M7.
- **PA-A05 floor**: compute the `start_memory_size` floor from the kept PA-U9 traces, implement it in `tests/support/memory-trace.ts`, and count an unended GC as unpaired.
- **The intermittent drag defect**: find the cause and add a regression check.
- **P2 performance** (D7): the shared per-sample cost that makes the batch ratio about 1.0.
- Every item of section 5's "not in the gate" list.

## 8. Owed user actions

- **The exit card** (section 9).
- **PA-Q8, what alpha distribution is**: its audience and form. It is still open. The plan asks for it before the exit card; this record departs from that order because the gate does not depend on the answer, and alpha distribution does. It is asked separately.
- **Prototype-plan constraint 2**: keep it (a lower-tier check before alpha distribution) or remove it. The PA-A08 waiver decided the gate, not alpha.
- **Branch clean-up**: the PC and laptop evidence branches `claude/pa-u4c-sitting`, `claude/pa-u6-p2-a08-pc-02`, `claude/pa-u5-presentmon-pc-01`, `claude/pa-u7-laptop-01` and `claude/pa-u9-pc-01` are merged in substance and can be deleted.
- **The MVP exit's other owed actions** (M6-S0's raw JSON reports, the P4-A09 byte-identity comparison, the M6c-Q15 and Q16 cards, a real-IME record): unchanged from the [MVP exit record](mvp-exit-2026-11-02.md#10-owed-user-actions).

## 9. Acceptance

Pending: the user's exit card (PA-A11).
