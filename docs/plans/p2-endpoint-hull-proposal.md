# P2 endpoint-hull bounds certificate: approval proposal

Status: APPROVED by the user on 2026-10-02. Approval authorizes the narrow contract amendment and validation-gated implementation below; it does not declare acceptance before evidence exists. The [P2 private contract](p2-private-contract.md#cubic-bounds-and-flattening) owns the amended numerical rule. This follow-up was identified during [P3.2h validation](../evidence/p3.2h-native-cubic-workspace-review-2026-10-02.md); it does not resume deferred stroke refinement.

## Approved decision

Approve one narrow addition to the P2 cubic-bounds algorithm: for each coordinate axis, retain the existing derivative coefficient construction and nonfinite checks, then certify the endpoint interval when both interior represented relative controls lie inclusively inside it. Apply this certificate before coefficient scaling/discriminant/root solving. Keep the existing root solver for every other axis. Preserve all guards, tolerance/error budgets, resource caps, failure publication, ABI and independent oracle.

This changes the frozen numerical acceptance rule for some inputs from NUMERIC_RANGE to OK. The user explicitly approved this change before implementation. It changes no product scope, public type, dependency, package boundary or renderer architecture.

## Observed problem

The exact input used to reveal the issue is a canonical cubic segment from (1,0) to (2,0), with interior x bits `3ff5555555555555` and `3ffaaaaaaaaaaaaa` and zero y. These are the Float64 results of translated thirds. Subtracting origin 1 produces relative control bits `3fd5555555555554` and `3fe5555555555554`. The existing derivative power calculation has quadratic coefficient 2^-52 instead of zero, so its uncertain-root enclosure exceeds the coordinate guard and returns NUMERIC_RANGE during bounds calculation.

The entire represented curve is nevertheless on the horizontal segment: every Bernstein control lies between the endpoints. Current rejection is a conservative limitation of the selected root method, not an observed geometric error. The reverse translated segment has the same issue. P3.2h corrected only its raw decoder fixtures to exact integer trisections; its unchanged 94-row corpus and runtime do not contain a workaround for this limitation. Historical failed observations stay unchanged.

## Proposed owning-contract addition

Insert the following exception before the current derivative-root procedure in the P2 private contract's cubic-bounds section:

> For each coordinate, first construct the existing derivative power coefficients a,b,c and retain their nonfinite rejection. With finite coefficients, form the closed interval between the two represented relative endpoint values. If both represented relative interior controls belong to that interval, the Bernstein convex-hull property certifies that the coordinate's extrema are its endpoints. Skip coefficient scaling/discriminant/root solving for that coordinate only. Apply the unchanged depth-0 coordinate guard and existing origin restoration. All other coordinates use the existing scaled derivative-root and uncertain-band procedure without a changed threshold.

For t in [0,1], the four cubic Bernstein weights are nonnegative and sum to one. Thus a scalar curve whose controls all lie in [lo,hi] remains in [lo,hi]; because its endpoints attain lo/hi, those are its exact extrema. This argument does not require monotone controls, an exactly linear parameterization, special bit patterns, a particular translation or a small segment length. It is independently applicable to x and y.

The implementation operates on the same represented relative controls as the current bounds code. The existing depth-0 guard continues to own origin subtraction/restoration and numerical uncertainty; no new allowance is added outside it. This retains the current conservative Float64 policy and its independent-verification requirement, not a new claim of formal IEEE interval arithmetic. Original-control/relative overflow and guard-versus-tolerance checks still run before bounds; derivative coefficient nonfinite rejection remains inside each axis before the certificate. In particular, this proposal does not newly accept coefficient-overflow cases. Signed zeros remain geometrically equal under the inclusive comparisons; source/provenance bits and emission remain unchanged.

## Scope and integration

- One implementation owner changes only the private Rust coordinate-extrema entry and focused native fixtures. Primary owns the P2 contract/active-plan update and integration.
- The TypeScript reference keeps its independent Bernstein derivative bracketing/bisection. Do not copy the native shortcut into the oracle or modify expected bounds using native output.
- Add named regression inputs through the existing native/WASM differential harness. Preserve all original ordinary/named/metamorphic corpora, status checks and continuous error/bounds verification.
- No changes to flatten subdivision, knots, provenance, screen tolerance, cache identity, ABI layout, allocator, geometry-session lifecycle or renderer.
- The release WASM hash is expected to change; require independently reproduced matching new builds rather than the previous P3 preparation hash. Earlier benchmark results remain tied to their original source; latest-source performance stays unverified without a new approved measurement.

## Prospective acceptance

Before implementation, freeze the concrete fixture table and input bits, expected outcomes, test locations and review evidence in a bounded follow-up execution contract. Do not run exploratory inputs and then choose successful cases. The following obligations are mandatory:

| ID  | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H01 | Primary/independent proof and contract review of inclusive per-axis hull containment, unchanged guard accounting, early overflow/tolerance checks and fallback behavior.                                                                                                                                                                                                                                           |
| H02 | The original translated length-one input and its reverse must succeed with independently certified tight endpoint bounds, unchanged continuous flattening error/provenance and zero hot-path allocation. Include translation/reflection and signed-zero variants.                                                                                                                                                  |
| H03 | A curve whose controls stay inside endpoint intervals but are not ordered still uses the sufficient certificate correctly. A mixed-axis curve certifies one axis while the other has a real interior extremum checked by the unchanged independent oracle.                                                                                                                                                         |
| H04 | Endpoint-outside-control and unresolved non-hull controls retain root/failure semantics; existing subtraction-overflow, derivative-coefficient-overflow and guard-consumed-tolerance failures remain failures. Preserve atomic per-path output and later-path progress.                                                                                                                                            |
| H05 | Full existing 10,000-path ordinary corpus, named/metamorphic/failure fixtures and native/real-WASM differential checks pass without density, tolerance, work-cap or expected-failure relaxation. Required static/root/build checks and reproducible new WASM builds pass. Browser WASM parity uses the existing browser geometry runner where required by the owning P2 plan; no GPU or performance claim follows. |

The fixed non-hull controls must be derived analytically and reviewed before first execution. A failure of the frozen mandatory corpus is investigated against the unchanged contract; it does not authorize silently expanding the hull predicate, modifying the root fallback or changing tolerances.

Primary and an independent Sol medium reviewer checked this proposal. Review required placing the certificate after the original coefficient/nonfinite checks to avoid an unintended expansion to coefficient-overflow inputs; the text above incorporates that restriction. No numerical experiment or runtime change was made for this proposal.

## Alternatives and recommendation

Retaining the present rejection is valid under the current numerical policy, but leaves simple represented cubics unresolved and obstructs broader canonical-source readiness. Replacing the quadratic solver or loosening its uncertainty guard would have a larger risk and is outside this proposal. Recommend the bounded endpoint-hull sufficient certificate because it solves the general avoidable-root problem using a short independent mathematical proof while leaving the fallback intact.

The [execution contract](p2-endpoint-hull-execution.md) freezes the approved follow-up fixtures and validation. The [review record](../evidence/p2.6f-endpoint-hull-review-2026-10-02.md) records implementation and evidence. Resume the P3 canonical-source/topology/transport prerequisites after protected integration, without weakening full-P3 gates.
