# P3 fill and stroke meshes execution plan

Status: P3.0a integrated through [PR #52](https://github.com/npclown/vector-studio/pull/52) as `4928a88` after required CI (run 36246634960). P3.0b contract preparation is IN PROGRESS under [D7](p2-follow-on-entry.md); the [private-contract draft](p3-private-contract.md) is PARTIAL and [visible behavior](p3-visible-semantics-proposal.md) is now APPROVED. The separately frozen [P3.1a test-only line oracle](p3-line-oracle-contract.md) has local acceptance PASS, pending protected CI/integration. No P3 runtime implementation acceptance or public API extension is claimed.

## Scope and current seams

Implement only the [P3 roadmap scope](../prototype-plan.md#p3-fill-and-stroke-meshes): multiple subpaths/holes, nonzero/evenodd fill, open/closed paths, required caps/joins, thin/extreme strokes and coverage-fringe/MSAA comparison. [Graphics architecture](../graphics-engine-architecture.md) owns algorithms and numeric policy; [system architecture](../../ARCHITECTURE.md) owns inward dependency direction. Dash editing remains in the roadmap's later editor coverage; P3.0b must explicitly resolve the dash design gate without silently adding runtime dash scope.

P2 already supplies local Float64 bounds and flattened paths, source provenance, a private batch/reserve ABI and owned adapter/cache results. Its fillRule/strokeStyleHash fields currently affect cache identity only. They are not implemented fill/stroke behavior. Preserve [P2 v1](p2-private-contract.md) rather than reinterpreting its output as triangles.

`packages/contracts/src/scene.ts` accepts primitives and containers, with a color/width stroke; it has no path node or cap/join contract. `packages/renderer-core/src/primitive-packet.ts` and the existing WebGPU path consume primitive packets. Thus private numeric mesh work can be planned independently, but end-to-end path integration requires a concrete scene/API proposal before changing those exported meanings. Do not hide a path API in primitive data or import geometry-wasm directly from renderer-core.

The composition root must inject geometry through plain contracts. Rust/geometry-wasm owns reconstructible geometry; renderer-core owns retained scene/order/cache coordination; renderer-webgpu alone owns GPU resources and its scheduler/device generation. No worker independently redesigns these boundaries.

## P3.0 planning acceptance

| ID  | Required result                                                                                                                        | Current status              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| C01 | D7 authority, measured revision, original FAIL and latest performance uncertainty linked consistently                                  | PASS P3.0a / PR #52         |
| C02 | Existing package/scene/ABI seams inspected; public path integration identified as a separate decision                                  | PASS P3.0a; no API selected |
| C03 | Exact private fill/stroke numeric semantics, combined error budget, work limits and error precedence fixed with deterministic fixtures | TODO P3.0b                  |
| C04 | Mesh ABI/version/layout, ownership, cache keys and stale/dispose behavior fixed without reinterpreting P2 v1                           | TODO P3.0b                  |
| C05 | Independent oracle, positive controls, corpus, commands and evidence rules fixed before corresponding implementation                   | TODO P3.0b                  |

P3.0a completes only after document checks, Primary review and protected integration. P3.0b completes only with C03-C05 and an explicit implementation readiness review. The downstream code tasks below are proposed dependencies, not authorization supplied by this docs-only D7 checkpoint; resolve implementation-entry scope and any API/product decisions after the contract is concrete. Unresolved choices remain blockers for affected work, not permission for workers to invent defaults.

## Next checkpoint: P3.0b contract and feasibility

Primary owns the [private-contract draft](p3-private-contract.md), the single owner of C03-C05 technical details. Its [visible semantics](p3-visible-semantics-proposal.md) were approved by the user after PR #53; technical C03-C05 obligations remain open. A Sol medium worker may independently inspect algorithm/numeric feasibility; a Terra medium worker may inventory analytic fixtures in disjoint test-only files after fixture requirements are fixed. Prefer read-only audit before allocating implementation workers. No recursive delegation by default.

Before implementation, specify:

- Fill topology: contour orientation, holes, nonzero/evenodd winding, implicit closure for fill versus open-path stroke, intersections, coincident/retraced edges, zero-area contours and deterministic treatment of boundary samples. Freeze ordinary-success versus intentionally rejected adversarial fixtures.
- Stroke meaning: local/world units, width, miter ratio/cutoff, cap/join construction, zero-length segments and closed seams. Identify any product decision requiring approval; do not assume new exported defaults. Resolve dash scope explicitly against the roadmap.
- Numeric policy: retain the total <=0.25 physical-pixel target through flattening, tessellation/round approximation and GPU conversion/projection. P2's complete 0.25 flattening allowance cannot also be spent independently by later stages. Define conservative budgets, screen transforms/zoom/DPR, precision guards and fail-closed behavior before accepting an algorithm. The current P2 adapter fixes the full 0.25 allowance, so it cannot simply be requested to supply a smaller share. Resolve this compatibility blocker explicitly: prove later stages fit the residual budget, define a separate P3 operation/budget, or seek the required decision for a P2 behavior change. Preserve P2 v1 meaning and include budget identity in affected cache keys.
- Bounded work: cap input edges, intersection/split work, triangles/vertices, scratch/output bytes and retries; specify inclusive limits and the first rejected operation. Ordinary frozen corpus must succeed; prevent blanket NUMERIC_RANGE/WORK_LIMIT from masking unsupported geometry.
- Private mesh transport: vertex position/coverage or edge-distance semantics, triangle winding/cull convention, fill/stroke range identity and paint order, overlap handling to avoid repeated alpha accumulation, coverage/blend behavior, version/operation identity, scalar types, offset units/alignment, index/range validation, bounds/source tokens, batch versus per-path errors, reserve/view invalidation, owned copies and terminal disposal. Decide an extension only after checking its effect on P2 v1 compatibility and tests.
- Cache/lifetime: geometry revision, fill/stroke geometry parameters and tolerance budget identity; color/opacity independence; latest-source publication; separate CPU mesh and GPU device generations; deferred GPU allocation reuse only after completion. Define transform-only reuse and affected-node bucket invalidation without changing shared backend lifetime ownership.
- Independent verification: analytic area/winding/cap/join cases and a separately implemented membership/error oracle; positive controls for wrong winding, missing/overlapping triangles, bad indices, nonfinite vertices, incorrect caps/joins and stale results. A screenshot or triangle-count comparison alone is insufficient.

Record a versioned deterministic corpus, all seeds and concrete transforms: nested alternating-winding contours, intersecting and coincident edges, degenerates, fractional translation/rotation, reflections/shears, zoom 0.01/1/64, DPR 1/2/3, and the roadmap's 1,000 paths x 32 cubics. Freeze exact numeric/raster comparisons and reference provenance before running acceptance. Do not add a reference library without the required dependency review.

Before choosing production fill topology, review feasibility on already-flattened line contours, especially intersections and coincident/retraced edges. Any executable spike needs a bounded non-accepting plan first and independent expected membership results; it cannot supply runtime acceptance or change public contracts. Freeze that review before P3.2 rather than letting a worker select an untested topology algorithm during implementation.

## Runtime acceptance coverage to freeze in P3.0b

These IDs reserve required evidence; they are not executable acceptance until C03-C05 supply exact fixtures, tolerances and commands.

| ID  | Required evidence                                                                                                         | Status                            |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| A01 | Valid mesh/index/range structure, deterministic failure isolation and bounded adversarial work                            | TODO                              |
| A02 | Both fill rules, holes, intersections and winding agree with independent analytic/membership and image fixtures           | TODO                              |
| A03 | Required caps/joins, open/closed paths, thin strokes and miter/degenerate cases match fixed semantics                     | TODO                              |
| A04 | Combined geometric error <=0.25 physical pixel across declared transforms/zoom/DPR, with rejecting positive controls      | TODO                              |
| A05 | ABI capacity/growth/view ownership, copied results, stale work, disposal and recreation                                   | TODO                              |
| A06 | Stable mesh reuse; only affected geometry rebuilds across revision/style/bucket changes; color/opacity avoid mesh rebuild | TODO                              |
| A07 | Ordered path/primitive integration, upload/resource lifetime and latest-scene device recovery                             | TODO; scene/API decision required |
| A08 | Headed Chrome/Edge corpus, coverage fringe versus MSAA comparison and reproducible evidence                               | TODO; visual contract required    |

P3 defines no new performance multiplier here. A later performance assertion requires its own prospective measured event/workload/environment/sample/threshold contract. D7 does not authorize changing P1/P2 metrics or using a functional run as performance evidence.

## Task graph and ownership

| Task  | Purpose and expected files                                                                     | Predecessors                                                        | Parallelism / owner                                                                        | Risk / model and effort                                       |
| ----- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| P3.0a | Entry decision, roadmap/navigation and this plan                                               | D7                                                                  | Primary; read-only independent review                                                      | Medium consistency; Primary                                   |
| P3.0b | Private contract, topology/error-budget feasibility and fixture specification under docs/plans | P3.0a                                                               | Primary single owner; bounded independent review                                           | High cross-module/numeric; Primary, Sol medium audit          |
| P3.1  | Independent mesh oracle/corpus in geometry-reference and test support                          | P3.0b                                                               | Oracle and positive controls precede production fill                                       | High verification; Sol medium; Terra medium analytic fixtures |
| P3.2  | Fill topology/tessellation in geometry-wasm/kernel private modules                             | P3.0b + P3.1                                                        | After independent oracle review; no shared ABI edits                                       | High algorithm/numeric; Sol high                              |
| P3.3  | Stroke mesh generation in geometry-wasm/kernel private modules                                 | P3.2 shared topology review + P3.0b                                 | Sequential by default until reuse boundary is proven independent                           | High degeneracy/overlap; Sol high                             |
| P3.4  | Mesh ABI/adapter/cache integration in geometry-wasm and tests                                  | P3.2 + P3.3                                                         | Single owner of engine/codec/adapter; no concurrent lifecycle edits                        | High ownership/regression; Sol high with Primary review       |
| P3.5  | Native/WASM/browser differential acceptance                                                    | P3.1 + P3.4                                                         | Independent audits after integration; validation commands may run separately               | High numeric interpretation; Sol medium; Primary acceptance   |
| P3.6  | Concrete path scene/port proposal, then ordered core/backend composition and coverage          | P3.0b for proposal; P3.5 + explicit API decision before integration | Primary owns contracts and lifecycle; only disjoint shader/fixture delegation after freeze | High API/lifecycle; Primary, Sol high bounded implementation  |
| P3.7  | Headed visual/cache/recovery corpus and milestone review                                       | P3.6 + frozen visual contract + valid environment                   | Serial hardware execution, then independent evidence audit                                 | High acceptance; Primary; Luna low command collection         |

```text
D7 -> P3.0a -> P3.0b -> implementation-entry scope review
                           -> P3.1 oracle -> P3.2 -> P3.3 -> P3.4 -> P3.5 --+
                    -> P3.6 API proposal -> decision ---------------------+-> P3.6 integration -> P3.7
```

The P3.1 oracle joins P3.4 implementation at P3.5. Each integrated work unit uses its own protected PR. Task subdivision may change as feasibility becomes concrete; requirements, ownership and acceptance cannot silently change with it.

## Validation and next execution batch

For P3.0a/P3.0b documentation: explicit changed-Markdown formatting, local path/anchor checks, whitespace, source-of-truth and source-claim review; required PR static/unit/build CI. Local product tests, browser/GPU runs and benchmarks are NOT RUN for planning-only changes. Any numeric feasibility script must preserve source/inputs/results and be labeled feasibility, not implementation acceptance.

After P3.0a integration, the next executable batch is P3.0b: Primary contract draft and one independent Sol medium feasibility audit. The proposed first code checkpoint is P3.1 after contract freeze and implementation-entry scope resolution; production P3.2 additionally waits for its independent oracle and positive-control review; coordinate shared build/exports/test configuration through Primary. Final milestone completion requires all applicable A01-A08 evidence; integration alone does not pass a gate.

## P3.0a local review

Base: clean `b4316201af38af5afda36379ba5e3088b3cdf686`, equal to fetched origin/main. Primary wrote the D7 decision and execution/navigation documents. One GPT-5.6 Sol worker, medium reasoning, independently audited the existing seams and draft read-only; no child delegation. Primary checked the scene union, private geometry ownership, error-budget gate and archived aggregate directly. Review corrections make oracle validation precede production fill, reserve an explicit later implementation-entry scope review, name the private-contract owner, and add mesh coverage/order plus the fixed-P2-budget compatibility blocker. Its ten rows retain original FAIL, paired medians above 1.00 and the six documented p95 failures. PR #51's merged SHA and successful required check were verified separately; contemporaneous evidence files remain unchanged.

Local checks: explicit Prettier check for the six changed Markdown files PASS; the existing local-link/anchor check documented in the P1.0b review PASS (481 links across 90 Markdown files); `git diff --check` PASS. Source-of-truth review keeps D7 limited to entry, leaves C03-C05 unresolved and preserves product requirements, public exports, dependencies, evaluator and immutable observations. Local product/build/browser/GPU/benchmark runs are NOT RUN for this documentation-only checkpoint. Required CI passed on `8679645886c3cdb612c69715fb86aca57edd9a53` (run 36246634960); protected PR #52 integrated as `4928a88eb45ef3f4b1d4716e432a2a1fe9eca358`. P3.0a is complete.

## P3.0b preparation review: 2026-09-29

Base: clean `4928a88`, equal to fetched origin/main. Primary prepared the private-contract draft and visible-output proposal; one GPT-5.6 Sol worker with medium reasoning independently audited feasibility and reviewed the documents read-only, with no child delegation. Code inspection confirms both P2 flattening and P1 GPU precision independently permit the full 0.25 physical-pixel budget. The draft preserves those contracts and identifies separate P3 operation/budget and mesh-specific precision work.

The reviewed candidate includes independent winding/analytic fixtures, explicit ownership and cache obligations, and bounded topology feasibility. Primary did not adopt unproven worker suggestions for a single fill/stroke union paint, an inside-only coverage ramp, or arbitrary work caps. Those would not establish color/edge correctness or ordinary-corpus feasibility. C03-C05 remain incomplete; no ABI, numeric/visual acceptance or product implementation is falsely marked frozen.

The next dependent step is the concrete visible-semantics decision. Remaining technical work is topology/continuous-stroke/packing/fringe feasibility and exact transport/work-limit/corpus freeze; an approval of visible semantics alone does not pass these gates. Local documentation validation and protected CI results are recorded on this checkpoint PR. No local product/build/GPU/benchmark run is claimed for this preparation-only checkpoint.

### Independent closed-contour topology experiment

While the visible decision is pending, a bounded non-accepting experiment may test only the closed integer-coordinate fill fixtures F01-F07/F09-F11 in the private draft, including both orientations for F10. Exclude open contours, stroke, cubic flattening, ABI, renderer, GPU and benchmark work. This uses existing approved nonzero/evenodd meaning, not a proposed cap/closure behavior.

Method frozen before execution: an ignored standalone Node script under `.tools/p3-0b-*` uses exact BigInt rational arithmetic to enumerate intersections and vertical event slabs, group directed crossings and emit disjoint trapezoids for each fill rule. Input coordinates remain literal integers. An independently coded direct ray-crossing oracle checks rational points strictly within/outside each resolved interval, skipping source-edge points; exact analytic fixture areas validate total area. Check sorted nonoverlapping interior intervals and independent expected shared-edge interior samples. Positive controls remove one nonzero-area cell and duplicate one cell; area and multiplicity checks must reject them. Do not import production helpers or copy the future Rust implementation.

Bound this experiment to 16 directed source edges per fixture, 120 pair tests per fixture, 256 x events and 4,096 emitted cells per rule. Count actual pair/event/cell work and fail before exceeding a bound. All fixture cases must match their exact rational area and sample membership; unhandled numeric/algorithm cases fail the experiment, not silently skip. These small-input experiment limits are not proposed production limits or evidence that the 1,000-path cubic stress scene fits.

Archive source, raw JSON observations, invocation/base revision, hashes and Primary review under `docs/evidence/p3.0b/`. Outcome is feasibility-only and leaves C03-C05/runtime acceptance incomplete even if every fixture agrees. Exact rational Node arithmetic does not prove robust Float64 Rust predicates or browser performance. Primary owns scope/interpretation; a single Sol medium worker may implement only the ignored diagnostic script, with no child delegation.

Local outcome: [archived tool, raw result and Primary review](../evidence/p3.0b/README.md) record FEASIBILITY_ONLY PASS for 12 closed-contour variants / 24 rule cases, 60 literal and 516 generated probes, four shared-edge interior cases and two rejected corrupt outputs. Maximum work is 8 edges / 28 pair tests / 4 events / 4 cells. Primary corrected event-column membership, separated F09 variants and required interval probes before the first execution; independently checked all raw areas and byte hashes afterward. C03-C05 remain incomplete and the visible-semantics decision is still pending.

Local documentation validation: explicit Prettier check of four changed Markdown files and the new archive manifest PASS; local link/anchor checker PASS (496 links across 93 Markdown files); whitespace and source/raw archive review PASS. Product, dependency and historical-result scope review found no changes. Required CI passed on `38b12da1fd2aa2a008c272b1f7f67a6283ca39b3` (run 36557040749); PR #53 integrated as `7bf9a17d6c7907c34c24f0d26aefea3d9e5ad88c`. P3.0b itself is not complete.

## Approved visible behavior and P3.1a slice: 2026-09-29

The user replied to the concrete visible-output question after PR #53 with an instruction to proceed. The [visible-semantics decision](p3-visible-semantics-proposal.md) is approved; the earlier preparation/evidence text remains historical. No further approval is needed for those same choices. The user's ongoing authorization permits ordinary task refinement inside the roadmap without expanding product scope.

Primary separates a test-only line-membership subset, P3.1a, from the full P3.1 oracle. Its [contract](p3-line-oracle-contract.md) freezes input/error limits, exact represented-number semantics, resolved boundary behavior and L01-L08 evidence before code. It depends on approved fill semantics and that slice contract, not the still-open stroke/fringe/mesh ABI. This replaces only the full P3.0b prerequisite for P3.1a; production P3.2-P3.6 and the remaining P3.1 work retain all relevant contract/oracle gates. No runtime acceptance or performance threshold is weakened.

```text
approved visible behavior -> P3.1a contract -> independent line oracle + literal fixtures
                           -> focused/root validation -> Primary review -> protected PR
P3.0b remaining stroke/topology/coverage/ABI freeze -> remaining P3.1 -> production gates
```

Base is clean `7bf9a17`, equal to fetched origin/main. Primary owns shared exports, docs and integration. Sol high owns only `packages/geometry-reference/src/line-fill.ts`; Terra medium owns only `tests/unit/geometry-line-fill.test.ts`. Their interface is frozen before parallel work. No child delegation. This is test-only infrastructure in the existing independent reference package, with no new dependency or public editor/renderer API.

### P3.1a local acceptance

The [Primary review and evidence](../evidence/p3.1a-line-oracle-review-2026-09-29.md) map L01-L08 to the independent literal fixtures. Focused Vitest passes 12 tests; `pnpm check` passes formatting, lint, TypeScript, 327 tests across 44 files and dependency boundaries; `pnpm build` passes workspace packages and production playground. Primary corrected fixture isolation/coverage and the F08 implicit-edge coordinate description; the initial unnecessary-type-assertion lint failure was repaired and the complete check rerun successfully. No product API/dependency/lifecycle changes or historical artifact edits are included.

Explicit Prettier check of the six changed Markdown files PASS; existing local-link/anchor checker PASS (508 links across 95 Markdown files); `git diff --check` PASS. Protected CI and integration are still required for checkpoint completion. Browser/GPU/native-WASM/benchmark commands are NOT RUN locally for this test-only TypeScript slice. Full P3.0b C03-C05 and remaining P3.1/production gates remain open. Next technical work is continuous stroke error and the remaining topology/coverage/transport freeze.
