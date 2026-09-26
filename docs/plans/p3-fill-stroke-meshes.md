# P3 fill and stroke meshes execution plan

Status: P3.0a planning entry under [D7](p2-follow-on-entry.md). P3.0b contract freeze is TODO. No P3 implementation acceptance or public API extension is claimed.

## Scope and current seams

Implement only the [P3 roadmap scope](../prototype-plan.md#p3-fill-and-stroke-meshes): multiple subpaths/holes, nonzero/evenodd fill, open/closed paths, required caps/joins, thin/extreme strokes and coverage-fringe/MSAA comparison. [Graphics architecture](../graphics-engine-architecture.md) owns algorithms and numeric policy; [system architecture](../../ARCHITECTURE.md) owns inward dependency direction. Dash editing remains in the roadmap's later editor coverage; P3.0b must explicitly resolve the dash design gate without silently adding runtime dash scope.

P2 already supplies local Float64 bounds and flattened paths, source provenance, a private batch/reserve ABI and owned adapter/cache results. Its fillRule/strokeStyleHash fields currently affect cache identity only. They are not implemented fill/stroke behavior. Preserve [P2 v1](p2-private-contract.md) rather than reinterpreting its output as triangles.

`packages/contracts/src/scene.ts` accepts primitives and containers, with a color/width stroke; it has no path node or cap/join contract. `packages/renderer-core/src/primitive-packet.ts` and the existing WebGPU path consume primitive packets. Thus private numeric mesh work can be planned independently, but end-to-end path integration requires a concrete scene/API proposal before changing those exported meanings. Do not hide a path API in primitive data or import geometry-wasm directly from renderer-core.

The composition root must inject geometry through plain contracts. Rust/geometry-wasm owns reconstructible geometry; renderer-core owns retained scene/order/cache coordination; renderer-webgpu alone owns GPU resources and its scheduler/device generation. No worker independently redesigns these boundaries.

## P3.0 planning acceptance

| ID  | Required result                                                                                                                        | Current status                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| C01 | D7 authority, measured revision, original FAIL and latest performance uncertainty linked consistently                                  | Recorded by P3.0a; document validation required |
| C02 | Existing package/scene/ABI seams inspected; public path integration identified as a separate decision                                  | Recorded by P3.0a; no API selected              |
| C03 | Exact private fill/stroke numeric semantics, combined error budget, work limits and error precedence fixed with deterministic fixtures | TODO P3.0b                                      |
| C04 | Mesh ABI/version/layout, ownership, cache keys and stale/dispose behavior fixed without reinterpreting P2 v1                           | TODO P3.0b                                      |
| C05 | Independent oracle, positive controls, corpus, commands and evidence rules fixed before corresponding implementation                   | TODO P3.0b                                      |

P3.0a completes only after document checks, Primary review and protected integration. P3.0b completes only with C03-C05 and an explicit implementation readiness review. The downstream code tasks below are proposed dependencies, not authorization supplied by this docs-only D7 checkpoint; resolve implementation-entry scope and any API/product decisions after the contract is concrete. Unresolved choices remain blockers for affected work, not permission for workers to invent defaults.

## Next checkpoint: P3.0b contract and feasibility

Primary owns the future `docs/plans/p3-private-contract.md`, which will be the single owner of C03-C05 technical details; this execution plan links it once created. A Sol medium worker may independently inspect algorithm/numeric feasibility; a Terra medium worker may inventory analytic fixtures in disjoint test-only files after fixture requirements are fixed. Prefer read-only audit before allocating implementation workers. No recursive delegation by default.

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

Local checks: explicit Prettier check for the six changed Markdown files PASS; the existing local-link/anchor check documented in the P1.0b review PASS (481 links across 90 Markdown files); `git diff --check` PASS. Source-of-truth review keeps D7 limited to entry, leaves C03-C05 unresolved and preserves product requirements, public exports, dependencies, evaluator and immutable observations. Local product/build/browser/GPU/benchmark runs are NOT RUN for this documentation-only checkpoint. Protected PR CI and integration remain required before P3.0a is complete.
