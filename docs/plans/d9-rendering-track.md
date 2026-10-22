# D9 rendering track plan

Status: active from the `mvp-1` tag. This plan holds the rendering track's status index, items, acceptance checks and evidence rules. The decision, the ownership boundary, the shared surface and the operating model are owned by [D9](d9-post-mvp1-tracks-proposal.md) (approved 2026-10-22) and are not repeated here. P3 history and the P3 acceptance table stay in [`p3-fill-stroke-meshes.md`](p3-fill-stroke-meshes.md). The Track B name from [D8](p3-d8-parallel-tracks.md) is retired for post-MVP 1 work (D9-Q5 (a)).

Ownership: the packages and pages listed in [D9, rendering track](d9-post-mvp1-tracks-proposal.md#rendering-track-engine). Branches use the prefix `claude/eng-<item>-<slug>`. A change to the shared surface is full tier with both-track review ([D9, Boundary](d9-post-mvp1-tracks-proposal.md#boundary)).

## Status index

| Item | Subject                                                    | Tier                                       | State       |
| ---- | ---------------------------------------------------------- | ------------------------------------------ | ----------- |
| E1   | ST-U9 early abort when failure is certain                  | Full                                       | Not started |
| E2   | ST-U9 family-B fast-rung contract                          | Full                                       | Not started |
| E3   | B4: A04 corpus and measurement contract                    | Full                                       | Not started |
| E4   | ST-U3f fix decision                                        | Full                                       | Not started |
| E5   | Unmeasured-scope measurements after the AL-Q6 (a) decision | Full (scenario contract), then light (run) | Not started |
| E6   | Remove or move the D8-interim overlay and fringe builders  | Full                                       | Not started |
| X1   | P3 exit evidence A01-A08 index                             | — (Primary acceptance)                     | Open        |

E1 comes before E2: the early abort is a smaller, independent bound and needs no new certificate. The order is otherwise D9's.

## Items

Each item's scope and outcome are owned by the matching row of the [D9 first-items table](d9-post-mvp1-tracks-proposal.md#rendering-track-engine); this section adds only the acceptance check and the evidence it needs. A contract's acceptance criteria and validation method are written in that contract before code, as [`AGENTS.md`](../../AGENTS.md#working-rules) requires, and are not invented here.

| Item | Acceptance check (before code)                                                                                                                                                                                            | Evidence rule                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | To be written in the ST-U9 addendum of the [stroke contract](p3-b2-stroke-contract.md); expected to include the meaning of "certain", the failing-case bound and the unchanged outcomes of every case that succeeds today | Independent contract review before code; a compatible stroke baseline record at `stroke-v0+r4` must be committed before any speed claim, or the ST-U9 addendum defines the comparison |
| E2   | To be written in the same addendum: the certificate, the fallback rule to family A and its own performance gate. E2-alt (raise `STROKE_V0_LIMITS` or a swept crossing collector above 64 edges) is decided there          | Independent contract review before code; the same baseline rule as E1; the choice between E2 and E2-alt cites E1's result                                                             |
| E3   | To be written as the B4 corpus and measurement contract per [D8 B4](p3-d8-parallel-tracks.md#two-tracks): frozen versioned corpus, independent oracle, rejecting positive controls                                        | Measurement run on the frozen corpus; until it exists every result keeps the UNVERIFIED precision label; stroke rows are re-run when E1 or E2 changes outcomes                        |
| E4   | A written decision between S2 and A1, the candidates recorded in the [ST-U3f follow-up](p3-fill-stroke-meshes.md#b2-st-u3dst-u3e-stroke-sharing-review-follow-up); A1 is cross-track (see D9 E4)                          | Decision record with the fixture evidence the contract names; the investigator's counts are re-run, not quoted                                                                        |
| E5   | A scenario contract that fixes a decision rule for the scope the [AL-OB5 verdict](p3-al-ob5-workload-scenario-proposal.md#4-decision-use) does not cover; the run does not set the rule                                   | Committed benchmark records per [`docs/benchmarks/README.md`](../benchmarks/README.md); a result cannot redefine its threshold                                                        |
| E6   | A kernel-placement contract at the R2/K1 decision; a move into the kernel changes port output and is reviewed by both tracks                                                                                              | Independent review of contract and evidence; the exception in [graphics-engine-architecture.md](../graphics-engine-architecture.md#anti-aliasing) ends only by removal or move        |

## In-flight and exit items

State and evidence are owned by the [D9 in-flight table](d9-post-mvp1-tracks-proposal.md#rendering-track-engine) and by the P3 status index; this table carries only what the track still has to close. Update a state here only when the cited evidence exists.

| Item                                               | State                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| B2 ST-U6 re-review, ST-A0 amendment review, ST-U7  | Done per D9 (ST-U7c+d merged in #193); no action                                                       |
| B3 kernel defects found by the visualization pages | Open as found; viewer findings arrive as rendering-track items with a fixture; ST-U3f is tracked as E4 |
| C04 transport                                      | Open; the D8 carve-out keeps V2's transport functional and disposable                                  |
| P1 A09/A10                                         | Open; performance evidence UNVERIFIED ([P1 plan](p1-instanced-primitives.md))                          |
| P2 A08                                             | Open; FAIL, D7 entry exception only ([P2 plan](p2-geometry-kernel.md))                                 |

## P3 exit evidence index (X1)

By D9-Q2 (a) this plan carries the evidence index for the P3 exit gate. The visualization track supplies the headed pages for A07 and A08, and the Primary accepts the exit. The requirement text and thresholds stay in the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b). A row is marked done only when its evidence link exists.

| ID  | Evidence location | State                                          |
| --- | ----------------- | ---------------------------------------------- |
| A01 | None yet          | TODO                                           |
| A02 | None yet          | TODO                                           |
| A03 | None yet          | TODO                                           |
| A04 | None yet          | TODO; depends on E3                            |
| A05 | None yet          | TODO                                           |
| A06 | None yet          | TODO                                           |
| A07 | None yet          | TODO; headed page from the visualization track |
| A08 | None yet          | TODO; headed page from the visualization track |

## Evidence rules

- Baseline: per the [closure record baseline marking](p3-fill-stroke-meshes.md#mvp-1-closure-record-2026-10-22), AL-OB5 is the only accepted baseline, for fill and for its measured scope; no stroke baseline exists. Compatibility is stated per comparison ([D9, Baseline](d9-post-mvp1-tracks-proposal.md#baseline-and-performance-claims). A performance claim needs a committed record following [`docs/benchmarks/README.md`](../benchmarks/README.md).
- GPU specs that check kernel outcomes are updated in the same PR as the change that alters the outcome.
- Every PR names its track, the packages touched and whether the shared surface changed, per the [PR gate in `AGENTS.md`](../../AGENTS.md#pull-request-gate).
- The weekly integration checkpoint is described in [D9, Operations](d9-post-mvp1-tracks-proposal.md#operations); this plan records its results by link only.
