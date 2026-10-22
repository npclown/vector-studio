# D9 visualization track plan

Status: active from the `mvp-1` tag. This plan holds the visualization track's status index, items, acceptance checks and evidence rules. The decision, the ownership boundary, the shared surface and the operating model are owned by [D9](d9-post-mvp1-tracks-proposal.md) (approved 2026-10-22) and are not repeated here. The Track A name from [D8](p3-d8-parallel-tracks.md) is retired for post-MVP 1 work (D9-Q5 (a)).

Ownership: the packages and pages listed in [D9, visualization track](d9-post-mvp1-tracks-proposal.md#visualization-track). The track uses only the shared surface, makes no kernel performance claim and files defects or missing capabilities as items in the [rendering track plan](d9-rendering-track.md) with a fixture. Branches use the prefix `claude/viz-<item>-<slug>`.

## Status index

| Item | Subject                                            | Tier                                                    | State                                                                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-1  | Path appearance editing on the existing P3 surface | Full (user-visible behavior, AGENTS.md change workflow) | implemented 2026-10-22 on `claude/viz-v1-path-appearance-impl` ([PR #201](https://github.com/npclown/vector-studio/pull/201)); evidence in [V-1 implementation evidence](#v-1-implementation-evidence-2026-10-22); independent evidence review pending, so not complete ([contract](viz-v1-path-appearance-contract.md), PR #200) |
| V-2  | SVG path-data input page                           | Full (user-visible behavior, AGENTS.md change workflow) | contract approved ([contract](viz-v2-path-data-contract.md), PR #203); next implementation                                                                                                                                                                                                                                        |

## V-1: path appearance editing

Source: D9-Q4 (a), see [D9 user decisions](d9-post-mvp1-tracks-proposal.md#user-decisions-2026-10-22).

Scope: as stated in [D9-Q4 (a)](d9-post-mvp1-tracks-proposal.md#open-questions-for-the-user): interactive editing of path fill and stroke parameters with live re-rendering through the ports, as UI over the existing draw and not new draw work.

Deferred: dash editing, gradients and full appearance controls, as in [`docs/prototype-plan.md`](../prototype-plan.md#deferred-from-the-graphics-prototype).

Boundary: the item uses only the shared surface. Durable scene data stays independent of renderer, GPU and WASM objects ([`AGENTS.md`](../../AGENTS.md#working-rules)). A needed change to the shared surface or to a rendering-track package is split out per the [D9 conflict rule](d9-post-mvp1-tracks-proposal.md#operations).

Acceptance criteria and validation method: to be written before code, in a V-1 contract that follows [`docs/validation.md`](../validation.md). No product code starts until that contract has them. Precision results carry the UNVERIFIED label until the rendering track's B4 evidence ([E3](d9-rendering-track.md#status-index)) exists.

### V-1 implementation evidence (2026-10-22)

Implementation of the [approved contract](viz-v1-path-appearance-contract.md), on branch `claude/viz-v1-path-appearance-impl` ([PR #201](https://github.com/npclown/vector-studio/pull/201)). Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence; no performance claim.

Environment: Windows 11 Pro 10.0.26200; headed Chrome 155.0.8059.85 and Edge 155.0.4283.62 (`playwright.gpu.config.ts`, DPR 1 and 2); kernel WASM built by `pnpm test:geometry` (fill-v0+r2, stroke-v0+r4). Evidence directories (git-ignored, `artifacts/viz-v1-appearance/<run>/<browser>/dpr<N>/`) hold `UNVERIFIED.txt`, `observations.json` and a PNG per stage. Latest headed V-1 spec runs (after the review round 2 follow-ups, 4 of 4 PASS): Chrome `2026-10-22T09-39-53-178Z-5356`, Edge `2026-10-22T09-40-45-913Z-2316`; the preceding round-2 runs were Chrome `2026-10-22T09-34-44-222Z-1300` and Edge `2026-10-22T09-35-33-820Z-19228`.

Files: `apps/playground/viz-v1-appearance.html`, `src/viz-v1-appearance.ts` (host), `src/viz-v1-appearance-scene.ts`, `src/viz-v1-appearance-state.ts`, the rollup input in `vite.config.mjs`, `tests/unit/viz-v1-appearance.test.ts`, `tests/gpu/viz-v1-appearance.spec.ts`, the third host in `tests/unit/v3a-path-pipeline.test.ts` and `tests/unit/v3b-mesh-backend.test.ts` (D9-Q8 (a)), the `docs/validation.md` command row and the `.gitignore` line for the evidence directory (precedent: every other GPU spec).

| ID                 | Evidence                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1-A1, A2          | GPU spec scenario `n0`: capability supported, operation ids `geometry-wasm/fill-v0+r2` and `geometry-wasm/stroke-v0+r4`, no page or error diagnostic, label visible; every control found by role and name with initial values equal to `v1-square`'s. PASS, 4 of 4 runs                                                                                                        |
| V1-A3 to A6 (unit) | `tests/unit/viz-v1-appearance.test.ts`, 28 tests PASS inside `pnpm check` (76 files, 1121 tests)                                                                                                                                                                                                                                                                               |
| V1-A6 (GPU)        | scenario `a6`: width -1, opacity 1.01 and empty width leave the revision unchanged, set `aria-invalid` and show a message. PASS                                                                                                                                                                                                                                                |
| V1-A7              | scenario `a7`: fill color, stroke color, opacity, fill off and on 0/0; fill rule 1/0; width, miter limit, cap, join 0/1; width to 0 0/0; width 0 to 5 0/1. Identical in all 4 runs                                                                                                                                                                                             |
| V1-A8              | scenarios `s1` to `s5` probes PASS (colors A to D, star center, zigzag band, caps, chevron switch ratio 1/sin 15 = 3.864 with limits 3.80 and 3.90)                                                                                                                                                                                                                            |
| V1-A9              | scenarios `n0`, `n1`, `n2` against the literals below, identical in Chrome and Edge, `noticesDropped` 0, page count equals hook count. PASS                                                                                                                                                                                                                                    |
| V1-A10, A11, A12   | scenarios `a10`, `a11`, `a12` and `blur` PASS (the `blur` scenario: blur commits a number field and the miter slider commits on `change`; opacity 0.5 adds no notice and separates single from double opacity; 20 inputs give +1 for opacity and +0 then +1 on `change` for width; keyboard, outline, live region and canvas label). Chromium fires `change` per keyboard step |
| V1-A13             | latencies written to `observations.json` (about 35 to 50 ms per edit on the reference machine), finite and non-negative; FUNCTIONAL observation, no performance claim, no threshold                                                                                                                                                                                            |
| V1-A15 (suite)     | `pnpm test:gpu`: 64 passed (27.4 min) in Chrome and Edge, including the unchanged p3-b2-strokes, p3-v4-paths, p3-st-u6-stroke and p3-st-u7-joint specs and the new spec                                                                                                                                                                                                        |
| V1-A14, A15        | `git diff --stat origin/main` over `packages`, `package.json`, `apps/playground/package.json`, `pnpm-lock.yaml` and over the B2/V4 specs, pages and scenes is empty; `pnpm check` and `pnpm build` PASS                                                                                                                                                                        |
| V1-A16             | this section, and the `pnpm test:gpu` row of `docs/validation.md`                                                                                                                                                                                                                                                                                                              |

Notice literals fixed at the first headed run (identical at DPR 1 and 2, Chrome and Edge): `n0` none (so `v1-circle` fill only meshes); `n1` fill only none, stroke on `v1-circle stroke work-limit`, stroke off the same one entry stays, stroke on again two `v1-circle stroke work-limit`; `n2` butt none, round `v1-zigzag stroke fringe-work-cap`; `s4` `v1-zigzag stroke fringe-work-cap`; `s1`, `s2`, `s3`, `s5`, `a6`, `blur`, `a10`, `a7`, `a11`, `a12` none.

Deviation resolved by the user-approved 2026-10-22 amendment of §3.4 (contract §11). Residual: independent evidence review not yet run.

## V-2: SVG path-data input

Added 2026-10-22. Source: the user's choice of 2026-10-22 (chat) of the next visualization item.

Scope: a playground page with a text area for the `d` data of one SVG path, parsed on an explicit Apply into one scene path node and rendered through the ports with a subset of the V-1 controls. P3 scope; no file import or export, no SVG documents and no persistence. Scope, grammar, acceptance criteria, validation and open questions are in the [V-2 contract](viz-v2-path-data-contract.md), approved by the user on 2026-10-22 with V2-Q1 to V2-Q10 answered (a).

## Evidence rules

- Headed pages that A07 and A08 need are supplied to the rendering track's [P3 exit evidence index](d9-rendering-track.md#p3-exit-evidence-index-x1); this plan links them and does not own the exit.
- A performance number is requested from the rendering track as a committed record; this track makes no kernel performance claim.
- Every PR names its track, the packages touched and whether the shared surface changed, per the [PR gate in `AGENTS.md`](../../AGENTS.md#pull-request-gate).
