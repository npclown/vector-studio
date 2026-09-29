# P3.0b-s1 regular stroke boundary certificate

Status: reviewed analytic feasibility, 2026-09-29; NOT an executable numeric contract or P3 runtime acceptance. This supplements the [private contract](p3-private-contract.md), which owns the unchanged combined physical error budget. The [approved visible behavior](p3-visible-semantics-proposal.md) is unchanged. This checkpoint derives a sufficient condition for regular cubic offset generators and identifies the remaining proof obligations before a bounded numeric experiment or production implementation.

## Scope and checkpoint acceptance

P3.0b-s1 is documentation-only: (1) derive a width-aware sufficient bound, (2) derive an independent continuous verifier, (3) fix an exact counterexample to centerline-only refinement, and (4) separate unsupported proof cases and numerical obligations. Primary owns the decision and derivations; one GPT-5.6 Sol worker with medium reasoning independently audits them read-only, without further delegation. Completion requires that review, explicit Markdown/link/whitespace checks and protected CI/integration. It does not complete P3 C03-C05 or authorize a new runtime operation.

Current [P2 flattening](../../packages/geometry-wasm/kernel/src/geometry.rs) checks centerline control-to-chord deviation plus a numerical guard. The existing [continuous reference](../../packages/geometry-reference/src/continuous-error.ts) verifies centerline interpolation with second derivatives and its P2 0.25 target. Neither proves stroke-side error or the prospective P3 0.125 share. Preserve both existing behaviors and tests.

## Regular leaf sufficient condition in exact arithmetic

Let a cubic leaf have local parameter s in [0,1], controls P0..P3, centerline C(s), radius r=width/2, and endpoint chord Q(s)=(1-s)P0+sP3. Let S be the physical linear transform DPR*zoom*worldLinear; sigma is a conservative upper bound on its operator norm. Translation cancels in exact differences but must be included in a later floating-point error analysis.

The degree-elevated controls of Q give:

```text
q1 = P1 - (2*P0 + P3)/3
q2 = P2 - (P0 + 2*P3)/3
delta = max(norm(q1), norm(q2))
D0 = 3*(P1-P0), D1 = 3*(P2-P1), D2 = 3*(P3-P2)
u = (P3-P0)/norm(P3-P0)
m = min_i dot(u, Di)
q = max_i abs(cross(u, Di))
```

The Bernstein convex-hull bound gives norm(C(s)-Q(s)) <= delta. Require a nonzero chord and m>0. Every derivative is a convex combination of D0..D2, so its projection on u is positive and its transverse magnitude is at most q. Thus it is nonzero and lies within angle alpha=atan2(q,m)<pi/2 of u.

Let N(s) be the unit left normal of C'(s). For either side, the intended raw offset is O+(s)=C(s)+r*N(s) or O-(s)=C(s)-r*N(s). Approximate a side by the line L+ or L- joining its canonical endpoint-normal samples O+(0),O+(1) or O-(0),O-(1). Any two normals in the cone differ by at most 2*sin(alpha); the same bound holds between N(s) and the convex combination (1-s)*N(0)+s*N(1). Consequently:

```text
norm(S * (O±(s)-L±(s))) <= sigma * (delta + 2*r*sin(alpha))
```

This is a sufficient, possibly conservative, bound over the whole leaf, not sampled evidence. Adjacent leaves share one canonical endpoint-normal sample at their subdivision knot. Such knots are approximation seams, not source joins: applying a user-selected miter/bevel/round join at every generated knot would change the curve's stroke semantics.

The prospective machine-arithmetic test is:

```text
sigmaUpper * (deltaUpper + 2*rUpper*sinAlphaUpper + gOffset) <= 0.125
```

Each quantity must have an outward/conservative bound. deltaUpper includes control/subdivision error; the guarded derivative cone must enclose the true derivatives with a strictly positive mLower; gOffset includes endpoint evaluation, normalization, shared-sample storage and side-chord emission error. The transform-norm bound, all comparisons and underflow/overflow behavior also require justification. Guards are inside 0.125, never additional allowances. This equation is not yet executable: no numerical constants, guard implementation or workload limits have been accepted by this analytic checkpoint.

For exact rational inputs, one need not compute atan2: with V=P3-P0, a=min dot(V,Di)>0 and b=max abs(cross(V,Di)), sin(alpha)=b/sqrt(a*a+b*b). Interval square roots can provide outward bounds in a future test-only feasibility tool. This is not a decision to add arbitrary-precision arithmetic to the production kernel.

## Independent continuous verifier

The verifier must not reuse the candidate's derivative cone as its success test. On each verification cell in canonical parameter t, independently bound speed below by vMin>0, acceleration norm above by A, and jerk norm above by J. With v=C', a=C'', j=C''', speed z=norm(v), tangent T=v/z and fixed 90-degree rotation R:

```text
abs(z') <= A
abs(z'') <= J + 2*A*A/vMin
T'' = j/z - 2*a*z'/z^2 - v*z''/z^2 + 2*v*(z')^2/z^3
N = R*T
norm(N'') <= 2*J/vMin + 6*A*A/(vMin*vMin)
norm(O±'') <= M = A + r*(2*J/vMin + 6*A*A/(vMin*vMin))
```

These inequalities follow from differentiating the normalized tangent and triangle/Cauchy bounds. Let eLeft/eRight bound the actual physical errors between O± and the candidate returned chord at this cell's endpoints. Because that returned chord has zero second derivative, an interpolation remainder bounds the entire cell:

```text
errorUpper = max(eLeft,eRight) + sigmaUpper*MUpper*h*h/8 + oracleGuard
```

Here h is the canonical t interval length. If derivatives are instead measured in a normalized leaf parameter, convert the derivative scale consistently; do not apply h twice. All bounds must cover the complete cell, not just derivative samples. The oracle independently bisects cells and rejects an uncertified cell at its frozen cap; dense sampling or a candidate-provided vMin is insufficient. Its guards, speed-bound method and cell/depth limits remain prerequisites for executable verification.

## Exact positive control: small centerline error, wrong stroke

Use dyadic controls P0=(0,0), P1=(1,0), P2=(2,1/64), P3=(3,3/64), identity physical transform and r=32 (width 64). Bernstein expansion gives C(t)=(3t,3*t*t/64), while Q(t)=(3t,3*t/64). The centerline control residuals q1=q2=(0,-1/64), so delta=1/64<1/8; the actual maximum centerline error is 3/256 at t=1/2.

At t=0 the true unit left normal is (0,1). Offsetting the chord using its own normal instead uses (-1,64)/sqrt(4097). The x error of that offset endpoint is 32/sqrt(4097)>1/8: squaring positive quantities reduces the comparison to 65536>4097. The full endpoint error is at least this x error. Therefore a chord accepted by the centerline criterion can fail the stroke share even at its endpoint. A future verifier must reject this literal wrong-normal output independently of the candidate algorithm.

This is an exact analytic counterexample, not a measured result. The worker independently checked the expansion, residuals, endpoint normals, squared inequality and derivative-bound derivation; Primary checked them again. No script, benchmark or numeric experiment was run for this checkpoint.

## Proof boundaries and next numerical checkpoint

- Raw offset correspondence does not prove the boundary of the final resolved stroke region. Self-intersections, overlaps and cancellation can change connectivity; topology, area/multiplicity and region-boundary evidence remain separate. A positional budget cannot excuse a connectivity change.
- A stationary derivative cannot satisfy m>0. Endpoint-stationary, interior stationary, cusp and constant curves require separately specified isolation and one-sided tangents. Factoring a derivative root may distinguish continuation from reversal mathematically, but this document does not silently equate all cubic cusps with a polyline join or implement that routing.
- A regular near reversal must refine as a regular curve; it cannot be snapped to exact reversal by epsilon. With speed approaching zero or width growing, no uniform finite leaf bound follows from this lemma. Work limits and the named ordinary-success corpus must be frozen before execution.
- Source joins and open caps use canonical one-sided tangents. Exact miter equality, near-cutoff uncertainty and amplified tip error remain independent obligations. For unit tangents with dot d, the ideal ratio is sqrt(2/(1+d)); away from exact reversal, miter is selected iff 2 <= limit*limit*(1+d), including equality. Machine rounding cannot decide an uncertain comparison by an invented tolerance.
- A concrete equality fixture uses tangents (1,0) and (7/25,24/25), giving ratio 5/4 at limit 5/4. Those rational values are ideal analytic data, not an assertion that decimal/binary64 approximations have exact equality. A numeric fixture must explicitly specify represented inputs and a certified predicate.
- Round arcs belong to the remaining 0.0625 construction share; mesh packing/projection has its separate 0.0625 share. Neither is proved here. P2 v1, P1 GPU precision and public scene contracts remain unchanged.

The next bounded checkpoint must first freeze outward arithmetic, finite input/transform envelope, endpoint sharing, counters and inclusive work limits, an independent speed-bound/verifier method, exact literal corpus and rejecting positive controls. Candidate corpus families are straight/wide strokes, the dyadic parabola above, regular inflections, positive-epsilon near reversals, and separately expected stationary-route cases. Include both traversal directions, reflection/shear, zoom 0.01/1/64 and DPR 1/2/3, with immutable source/results and explicit uncertified outcomes. Ordinary corpus success and resource feasibility must be observed before any production cap is selected. Until that contract exists, no executable feasibility script or production stroke implementation follows from this note.
