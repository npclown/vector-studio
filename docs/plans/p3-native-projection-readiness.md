# P3.1l native vertex projection readiness

Status: L00 documentation/readiness review; executable contract NOT FROZEN. This note narrows the next dependency after [K's ordered numeric model](p3-mesh-projection-experiment.md). The [private contract](p3-private-contract.md) still owns C03-C05; this note does not select a production mesh ABI or pass those gates. The [active plan](p3-fill-stroke-meshes.md) owns execution status.

## Selected next question

Observe the instrumented vertex-stage projection of all158 K mesh rows on hardware WebGPU in headed Chrome and Edge. Preserve original Float64 input bits, CPU-packed bytes and raw native clip words, then independently classify the unchanged1/16 physical-pixel position share and indexed topology. The separate legacy arithmetic counter remains K evidence, not a mesh input. This is a correctness experiment, not a performance run or production renderer integration.

All158 native rows are observational initially. K dispositions remain historical provenance only, including its thin-triangle rejection: that result relies on K's declared nearest-even graph and need not be reproduced by another permitted arithmetic evaluation. Do not infer required native outcomes from K's success count or from a first GPU run. Any additional guaranteed negative fixture requires a prospective literal input and independent proof before execution; no observed row may be replaced or removed to obtain a pass.

The first probe's hard gates are faithful packing/capture, complete identity, independent classification, corruption controls and retained evidence. Certification still requires the unchanged position bound AND topology; observational status never means that a failing mesh satisfies product requirements. Full P3 requires its own ordinary-success and raster gates.

## Why K cannot be used as a native bit oracle

The pinned [WGSL 2026-09-21 numeric rules](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-evaluation), sections15.7.2-15.7.5, permit rounding choices, subnormal flushing and reassociation; fusion has an accuracy condition. Division has its own accuracy allowance. Consequently K's binary64-then-binary32 nearest-even sequence does not describe every permitted native evaluation. Intermediate-bit equality to K is not native acceptance. Preserve the exact original-input geometric reference while evaluating actual final clip bits. These rules also prevent using runtime nonfinite behavior as a reliable overflow detector.

The existing P1 probe relocates point primitives into readback cells and passes the calculated clip position through flat varyings. The proposed experiment adopts that technique, so it observes an instrumented program. It does not observe the original triangle rasterization, clipping, subpixel coverage or an uninstrumented production shader. Even identical expression text can compile differently when instrumented; record exact shader source and keep that limitation explicit.

## Existing seams and bounded ownership

| Existing source                              | Reusable technique                                                                 | Boundary                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/playground/src/p1-position-probe.ts`   | Vertex execution, flat varyings, rgba32float targets, staging readback and cleanup | Its four-vertex primitive packet, shader replacement and resource IDs are P1-specific; do not extend its API for meshes |
| `playwright.gpu.config.ts`                   | Serial headed Chrome/Edge and isolated GPU output                                  | New targeted entry must be documented before use; preserve existing P1 tests                                            |
| `apps/playground/vite.config.mjs`            | Separate fixture HTML/TypeScript build entries                                     | A dedicated test page accepts serialized inputs; no public scene/path type or renderer port                             |
| `tests/support/p1-evidence.ts`               | Exclusive artifacts outside Playwright cleanup and source manifests                | Use a distinct P3 schema/root; never overwrite or relabel P1 records                                                    |
| `tests/geometry/mesh-projection/fixtures.ts` | Frozen original158 mesh inputs and K provenance                                    | No fixture reshaping after native output is seen                                                                        |
| `tests/geometry/conforming-mesh/oracle.ts`   | Independent projected-complex verification                                         | Verify the actual readback; do not refine or repair its mesh                                                            |

Primary owns the new contract, shared runner/configuration seams, evidence interpretation and integration. After freeze, one Sol high worker may own the isolated browser probe, and one Sol medium worker may own independent host decoding/audit fixtures only if their interface and file ownership are fixed first. Astra high reviews arithmetic/provenance and final claims. No recursive delegation or backend lifecycle changes are needed.

## Freeze checklist before any runner implementation

| ID  | Required concrete contract                                                                                                                                                 | Evidence method to freeze                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| L01 | Exact input identity/order, original64-to-packed32 arithmetic, byte offsets/alignment/padding, row/vertex index units, counts and checked size arithmetic                  | Independent byte provenance and malformed/overflow controls; no K result used as a native oracle                                      |
| L02 | Literal WGSL, entry points, binding/vertex lookup, w=1 and z convention, shader hash, row/vertex-to-texel mapping, bounded textures/chunks/submissions                     | Raw32 clip words plus identity/completeness sentinels; detect zero, stale, duplicate, swapped or missing captures                     |
| L03 | Exact rational viewport reconstruction from readback, original-input reference, reflection normalization and represented64 guard before the J verifier                     | Exact worst squared error/witness, separate position/topology, explicit nonfinite/nonrepresentable precedence and corruption fixtures |
| L04 | Device/format/limit preflight, detached uploads/readbacks, completion/unmap/destroy rules, terminal disposal and loss behavior                                             | Distinguish capability/device/capture failures from numerical classifications; deterministic ownership/cleanup checks                 |
| L05 | Versioned exclusive artifact schema, first complete record before assertions, partial/interrupted-run status, source-end integrity, browser/adapter/backend/flags metadata | Reproduction from original inputs/raw bits; immutable hashes and independent final review                                             |
| L06 | Actual named runner command, serial browser cases, local/static validation and prospective hardware evidence disposition                                                   | Runner acceptance remains separate from numeric feasibility; unavailable hardware is UNVERIFIED, never a pass                         |

The packed layout is an experimental carrier, not C04 adoption. Freeze actual caps and resource byte totals rather than borrowing unexplained P1 limits. No public export, new dependency, alternate renderer, mesh-cache policy or production rejection envelope follows from this note. A need for those changes returns to Primary and the existing user decision policy.

## Dependency order and readiness acceptance

`K integrated -> L00 readiness -> complete L01-L06 written freeze -> isolated runner/audit implementation -> stable-source review -> serial native observations -> independent evidence review -> separate production/raster decisions`.

L00 passes only when Primary and independent reviewers agree on source seams, evidence limits, the concrete missing freeze items and this dependency order; changed Markdown formatting, local links/anchors, whitespace and scope checks must pass. No new product test, GPU run or benchmark is needed for L00. Required protected PR CI still applies. L00 completion authorizes the next contract work; it does not authorize a GPU dispatch with unresolved L01-L06 details.

Production mesh operation/layout, CPU/GPU cache generations, completion-safe allocator retirement, public path composition and actual raster coverage/fringe/MSAA remain separate. Deferred stroke remains deferred. The finite K corpus and this future probe cannot establish ordinary1,000-path capacity or universal precision.
