# D9 visualization track plan

Status: active from the `mvp-1` tag. This plan holds the visualization track's status index, items, acceptance checks and evidence rules. The decision, the ownership boundary, the shared surface and the operating model are owned by [D9](d9-post-mvp1-tracks-proposal.md) (approved 2026-10-22) and are not repeated here. The Track A name from [D8](p3-d8-parallel-tracks.md) is retired for post-MVP 1 work (D9-Q5 (a)).

Ownership: the packages and pages listed in [D9, visualization track](d9-post-mvp1-tracks-proposal.md#visualization-track). The track uses only the shared surface, makes no kernel performance claim and files defects or missing capabilities as items in the [rendering track plan](d9-rendering-track.md) with a fixture. Branches use the prefix `claude/viz-<item>-<slug>`.

## Status index

| Item | Subject                                            | Tier                                                    | State                        |
| ---- | -------------------------------------------------- | ------------------------------------------------------- | ---------------------------- |
| V-1  | Path appearance editing on the existing P3 surface | Full (user-visible behavior, AGENTS.md change workflow) | contract in review (PR #200) |

## V-1: path appearance editing

Source: D9-Q4 (a), see [D9 user decisions](d9-post-mvp1-tracks-proposal.md#user-decisions-2026-10-22).

Scope: as stated in [D9-Q4 (a)](d9-post-mvp1-tracks-proposal.md#open-questions-for-the-user): interactive editing of path fill and stroke parameters with live re-rendering through the ports, as UI over the existing draw and not new draw work.

Deferred: dash editing, gradients and full appearance controls, as in [`docs/prototype-plan.md`](../prototype-plan.md#deferred-from-the-graphics-prototype).

Boundary: the item uses only the shared surface. Durable scene data stays independent of renderer, GPU and WASM objects ([`AGENTS.md`](../../AGENTS.md#working-rules)). A needed change to the shared surface or to a rendering-track package is split out per the [D9 conflict rule](d9-post-mvp1-tracks-proposal.md#operations).

Acceptance criteria and validation method: to be written before code, in a V-1 contract that follows [`docs/validation.md`](../validation.md). No product code starts until that contract has them. Precision results carry the UNVERIFIED label until the rendering track's B4 evidence ([E3](d9-rendering-track.md#status-index)) exists.

## Evidence rules

- Headed pages that A07 and A08 need are supplied to the rendering track's [P3 exit evidence index](d9-rendering-track.md#p3-exit-evidence-index-x1); this plan links them and does not own the exit.
- A performance number is requested from the rendering track as a committed record; this track makes no kernel performance claim.
- Every PR names its track, the packages touched and whether the shared surface changed, per the [PR gate in `AGENTS.md`](../../AGENTS.md#pull-request-gate).
