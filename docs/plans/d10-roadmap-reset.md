# D10: roadmap reset after MVP 1

Status: APPROVED 2026-10-23 by the user in chat. It changes work order, process tiering and document rules. It changes no requirement, threshold, acceptance criterion or milestone gate. [D9](d9-post-mvp1-tracks-proposal.md) ownership, the shared surface and the two tracks stay in force.

## Why

At `main` 728f271, P3 exit criteria A01-A08 were all TODO, four merged items waited for independent review (E1, V-1, V-2, V-3), eight rendering items were open without an order, and plan documents had grown large (`p3-fill-stroke-meshes.md` alone is about 930 KB). Process cost was growing faster than closed work.

## Decisions

1. **One next goal: the P3 exit.** Work that does not move A01-A08 goes to a backlog and does not start until it blocks an exit criterion or the user moves it.
2. **Phases.**

   | Phase | Target (proposal) | Content | Gate |
   | --- | --- | --- | --- |
   | R0 cleanup | about 2026-10-31 | Close the reviews of E1, V-1, V-2, V-3; merge PR #216; this record | No item waiting for review |
   | R1 P3 exit | about 2026-11-14 | E3 U3/U4 (A04), E8-U2, A01-A06 evidence; V-4 (A08 page); finish A07 | X1 lists evidence for A01-A08; the user accepts |
   | R2 performance debt | alongside R1 | P1 A09/A10 and P2 A08: re-measure, or defer to a pre-alpha gate | One user decision |
   | R3 P4 | after the P3 exit | Clip and mask | P4 exit gate |
   | R4 P5 | plan after V-4; build in parallel with R1 since 2026-10-25 (decision 4); exit accepted 2026-10-26 ([record](../evidence/p5-exit-2026-10-26.md)) | Editor slice | P5 exit gate |

3. **Backlog.** E2, E4 (the ST-U3f cases stay a known defect with fixtures), E5, E6, E7. E7 is the first candidate to promote if A01 needs it.
4. **P5 planning.** The visualization track writes the P5 editor-slice contract after V-4 (item V-5). Implementation waits for the P3 exit or a separate user approval. This answers the start of P5 planning only; the P5 entry rule of [`prototype-plan.md`](../prototype-plan.md) is otherwise unchanged. The separate approval was given on 2026-10-25 ([P5 plan, section 14](p5-editor-slice.md#14-implementation-decision-and-progress-2026-10-25)).
5. **WIP limit.** A track with two or more items "merged, independent review pending" starts no new implementation.
6. **Tiering.** Playground demo pages (for example V-1 and V-2) are light tier. Shared-surface, threshold, acceptance and product-behavior changes stay full tier.
7. **Document rules.** Status index cells are one line: state and a link. Dated detail goes into evidence sections or `docs/evidence/`. New contracts aim for 300 lines or fewer. Moving finished P0-P3 documents to an archive folder is a separate later PR.

## Validation

Documentation only: Markdown formatting and local links. No product, browser, GPU or benchmark run is claimed.
