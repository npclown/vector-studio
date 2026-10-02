# P3.1d exact continuous cubic boundary oracle

Status: FROZEN test-only contract, 2026-10-02, after Primary and independent B01 contract review. Decoder unit conversion, exact error precedence and literal carriers were clarified before implementation; all fixed corpus densities and the 1/8 budget remain unchanged. The [active plan](p3-fill-stroke-meshes.md) owns execution and evidence. This closes only the continuous cubic-to-polyline verification dependency of the [private P3 budget](p3-private-contract.md). It does not prove curved fill topology, certify stroke offsets, change P2 acceptance or authorize a runtime/public mesh API.

## Scope and independent arithmetic

Implement test support under `tests/geometry/cubic-boundary/` and unit fixtures under `tests/unit/geometry-cubic-boundary.test.ts`. Production packages, P2's 0.25-pixel oracle and Rust remain unchanged. Reuse only rational arithmetic/IEEE decoding from `tests/geometry/rounded-fill/exact.ts`, with explicit division by 2^1074 because that decoder returns integer subnormal units. Never import native geometry, flattening decisions or the rounded-fill topology oracle. Direct Bernstein evaluation and the independent interpolation remainder below determine acceptance.

Inputs are four finite Float64 control points, finite row-major screen matrix S, an expected u32 source verb ordinal and ordered returned lines with finite local endpoints and dyadic provenance. S already contains world linear transform, zoom and DPR; no translation enters error evaluation. Decode every supplied Float64 exactly as a rational number. Finite extreme/subnormal values are allowed; exact arithmetic must not overflow through a Number conversion. Signed zero denotes the same mathematical zero. This test utility introduces no renderer numeric envelope.

Use `UNIT = rational(1n, 1n << 1074n)` and `decodeBoundaryNumber(v) = mul(exactNumber(v), UNIT)`. Convert each coordinate and matrix coefficient exactly once to ordinary units before A/R/B/E arithmetic. Export this test-only helper for literal unit checks: 1 maps to 1; MIN_VALUE maps to 1/2^1074; MAX_VALUE maps to (2^53-1)*2^971; negative zero maps to zero. Reject nonfinite helper input rather than manufacturing a rational value.

The target is fixed at 1/8 physical pixel (squared target 1/64), inclusive. It cannot be provided or relaxed by the caller. This is a sufficient Euclidean continuous certificate, not dense sampling, and no performance claim follows from its counters.

## Provenance and local ownership

Require 1..8192 lines. Each provenance has the expected source ordinal, integer depth 0..20 and integer end numerator 1..2^depth. Each line covers [(n-1)/2^depth,n/2^depth]. Intervals start at zero, are adjacent without overlap/gaps and terminate at one. The first start point is the canonical P0; subsequent starts are the preceding returned endpoint. The source ordinal is u32 and never inferred from output.

Independently require each emitted endpoint to agree with exact canonical B(t) within the exact local guard G(d) = 128*2^-52*(A+(d+1)*R), where A=max(1,absolute original control coordinates), R=max absolute component of original Pi-P0, evaluated rationally. Compare squared Euclidean local distance with G(d)^2. A line's start uses its preceding endpoint's emission depth, not the current line's depth; P0 is exact. This is the inherited local representation allowance, evaluated without Float64 roundoff. It remains required even for zero/rank-one S. A physical certificate cannot hide wrong reusable local geometry in a screen nullspace. This new checker leaves the P2 verifier and its semantics untouched.

Preflight validates limits, basic input structure and cardinality, complete input shape/finiteness, complete provenance, then all local knots, before continuous work. Zero lines is INVALID_INPUT; line count above maxLines is WORK_LIMIT with zero cells, before inspecting line contents. A source ordinal outside u32 is INVALID_INPUT. Invalid input/provenance/knot cases report zero continuous cells. Missing, duplicate, reordered, wrong-source and malformed dyadic intervals cannot pass on a geometric coincidence.

All provided limit values must be finite safe integers in their named ranges or return INVALID_LIMITS. Malformed cubic/screen/endpoint tuples, nonfinite coordinates or invalid expected ordinal return INVALID_INPUT. Missing/malformed provenance objects, wrong source ordinals, invalid numerator/depth and incomplete/nonadjacent intervals return INVALID_PROVENANCE. Knot displacement returns LOCAL_KNOT_ERROR. During continuous evaluation, test the physical endpoint witness before the upper-bound/depth decision; PHYSICAL_ERROR takes precedence over UNRESOLVED for a visited cell. Charge/cap the cell before either evaluation, so attempting cap+1 returns WORK_LIMIT.

## Exact continuous certificate

For each returned line on [t0,t1], define its affine parametrization L(t) from the actual returned endpoints and E(t)=S*(B(t)-L(t)). Evaluate B directly in the cubic Bernstein basis at rational t. Independently evaluate B''(t)=6*((1-t)_(P2-2P1+P0)+t_(P3-2P2+P1)); E''=S*B'' since L''=0.

For a verification cell [a,b] within one line, h=b-a, use coordinate bounds:

```text
Ux = max(abs(Ex(a)), abs(Ex(b))) + max(abs(Ex''(a)), abs(Ex''(b)))*h*h/8
Uy = max(abs(Ey(a)), abs(Ey(b))) + max(abs(Ey''(a)), abs(Ey''(b)))*h*h/8
```

Each E'' component is affine, so its maximum absolute value is attained at an endpoint. The scalar linear-interpolation remainder bounds the coordinate error everywhere by U. Thus Ux^2+Uy^2 <= 1/64 certifies the entire cell in Euclidean norm. Endpoint error squared >1/64 is an actual PHYSICAL_ERROR witness. Otherwise bisect exactly, visiting left before right. A conservative bound above the target is not itself a measured violation. No square root, floating norm, epsilon, sampled-only acceptance or production subdivision decision is used.

Default absolute verification depth is 24 (initial depth is the source leaf depth); total visited cells per call is 1,048,576. Charge each cell before evaluation, allow exactly the cap and reject the next cell. A noncertified cell at maximum depth returns UNRESOLVED. Exhausted cells return WORK_LIMIT. Tests may supply smaller maxLines (1..8192), maxDepth (0..24) and maxCells (1..1,048,576), never larger values or a different tolerance. A leaf deeper than a smaller maxDepth is still evaluated once and may certify; it cannot be subdivided. Limit options themselves are validated first.

Result status is CERTIFIED, INVALID_LIMITS, INVALID_INPUT, INVALID_PROVENANCE, LOCAL_KNOT_ERROR, PHYSICAL_ERROR, UNRESOLVED or WORK_LIMIT. Results include actual visited cells and a diagnostic finding. Only CERTIFIED publishes a maximum accepted squared upper bound, as a normalized rational; every failure publishes null for that certificate even after earlier accepted cells. No arrays are modified and no state survives between calls. Input cardinality/provenance depth and fixed cell/depth ceilings bound rational arithmetic and traversal. Test-only BigInt allocation is not a production workspace or resource-accounting claim.

The test-only module exports `certifyCubicBoundary(input, limits?)`, where input is `{cubic, lines, screen, sourceVerbOrdinal}` using the existing reference package's numeric tuple/line types only. Optional limits are `{maxLines?, maxDepth?, maxCells?}`. Its result is `{ok, status, cells, finding, maxCertifiedSquared}`; finding is null on success and a descriptive string on failure. Export the corresponding TypeScript types from this module only, without adding a package/index export. `maxCertifiedSquared` uses the existing normalized `Rational` type. No physical certificate is inferred from a non-CERTIFIED status.

## Frozen fixtures and positive controls

Fixture generation is declarative test support, source-reviewed before the first run. Direct exact Bernstein values at uniform dyadic endpoints supply successful candidate polylines, with a separately reviewed rational-to-Float64 conversion for these bounded dyadic fixtures only. Do not import the certificate to decide fixture density, expected acceptance or which cases to keep.

Named controls (x,y), in order:

1. constant: [(2,3),(2,3),(2,3),(2,3)].
2. linear: [(0,0),(1,1),(2,2),(3,3)].
3. arch: [(0,0),(0,4),(4,4),(4,0)].
4. inflection: [(0,0),(0,4),(4,-4),(4,0)].
5. closed loop: [(0,0),(4,4),(-4,4),(0,0)].
6. collinear retrace: [(0,0),(8,0),(-8,0),(0,0)].
7. stationary: [(0,0),(4,0),(0,0),(4,0)].
8. asymmetric: [(-3,2),(5,-4),(-6,7),(2,-1)].

Each runs against seven profiles: identity I; 90-degree rotation times16 R16=[0,-16,16,0]; anisotropic D32=[32,0,0,1/32]; shear/high-zoom S192=[192,96,0,192]; low zoom Z01=[0.01,0,0,0.01] using exact represented coefficients; rank-one Q=[1,2,0,0]; zero Z=[0,0,0,0]. Uniform depths are respectively 6,8,8,10,6,6,6. These 56 cases are all mandatory successes; they test positions along source curves, not their fill regions.

Add 16 seeded controls: one continuous xorshift32 stream with seed 0x50333144 and shifts 13,17,5 (unsigned after each), eight words per cubic, components (word%17)-8. Cycle I/R16/D32/S192 and their fixed depths, giving 16 mandatory successes. For each of the eight named cubics at I/depth6, independently apply reversal, translation (x+2^20,y-2^20), reflection (-x,y), and uniform scale1/1024 (32 cases). Add left/right exact half-cubic controls of the arch at I/depth6, preserving reparameterization (2 cases). Total baseline: 106 mandatory certificates. The coordinate bound is at most 8 before transforms; for untransformed sources each B'' component is <=192. Combining the declared profiles and fixed depths bounds the interpolation remainder strictly below 1/8; dyadic knot rounding is separately within G. No after-run density/corpus fitting.

Additional literal controls must test: one-line quadratic arch with controls [(0,0),(1,1/8),(2,1/8),(3,0)], certified by the exact 3/32 maximum; doubled y, whose midpoint is 3/16 and must give PHYSICAL_ERROR; that same failure at maxDepth0 must be UNRESOLVED (endpoints alone pass); exact subnormal and MAX_VALUE constant cubics; mixed-depth valid dyadic coverage; and inclusive local guard equality/next-representable outside it on a constant zero cubic under zero S. A constant-zero endpoint displacement of 2^-45 equals G exactly; its next Float64 value must fail. A constant-zero endpoint displaced by 2^-45 under S=diag(2^42,0) is exactly at physical 1/8, must certify inclusively; doubling S must yield PHYSICAL_ERROR while local knots still pass.

Literal carriers use expected source ordinal 7 and that same ordinal on every line; default limits unless stated. One-line carriers use (endNumerator=1,depth=0). The two arch carriers above return end=(3,0), S=I. Extreme constants have all four controls and the sole returned endpoint equal to (MIN_VALUE,-MIN_VALUE) or (MAX_VALUE,-MAX_VALUE), S=S192, expected CERTIFIED with squared upper bound zero. For mixed depth, use the named linear cubic and S=I with ordered (n,d,end) = (1,1,(3/2,3/2)), (3,2,(9/4,9/4)), (7,3,(21/8,21/8)), (8,3,(3,3)), expected CERTIFIED with bound zero. The local/physical equality carriers use all-zero controls and sole end=(2^-45,0); local equality S=Z, physical equality S=[2^42,0,0,0], doubled physical S=[2^43,0,0,0]. The next-local-guard carrier uses end=(2^-45+2^-97,0), S=Z and expects LOCAL_KNOT_ERROR. Late physical failure uses zero controls, S=[2^43,0,0,0], lines (1,1,end=(0,0)) then (2,1,end=(2^-45,0)); its first cell certifies, second returns PHYSICAL_ERROR, and the result publishes no certificate.

Before first execution, Primary additionally fixes a successful refinement control: cubic [(0,0),(1,1/4),(2,-1/4),(3,0)], sole end=(3,0), S=I. Its y error is (3/4)_t_(1-t)*(1-2*t), with maximum sqrt(3)/24 < 1/8. The root and two half-cell bounds exceed the target, while all four quarter-cell bounds are at most 27/256. Thus maxDepth2 certifies after exactly seven visited cells; maxDepth1 is UNRESOLVED; maxCells7 succeeds and maxCells6 returns WORK_LIMIT after six cells. This supplements, and does not change, the 106 baseline cases or their densities. An 8192-line zero-constant carrier with uniform depth13 tests the inclusive line ceiling; 8193 entries reject before content inspection.

Corruptions independently reject endpoint displacement (including nullspace), missing/duplicate/reordered intervals, incorrect source, invalid numerator/depth, nonfinite controls/endpoint/matrix, wrong line count, and late physical failure after an earlier certified cell. Exercise each smaller limit at its boundary and first exceedance, maximum admissible source ordinal and overflow rejection, zero/singular matrices, deterministic repeats, immutability, no certificate on failure and invalid-limit/input/provenance/knot precedence. Finite depth-limit exhaustion is distinct from a witnessed error.

## Acceptance and ownership

| ID  | Required evidence                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 | Primary plus independent review of exact units, interpolation proof, local knot policy, complete provenance, bounds and fixed fixture source before first execution.                                                              |
| B02 | All 106 frozen baseline certificates and the literal physical/local equality, extreme, mixed-depth and witnessed/unresolved controls pass.                                                                                        |
| B03 | All named corruptions and inclusive resource/error/precedence/atomicity controls reject for their intended reason; input remains unchanged.                                                                                       |
| B04 | Focused unit suite, `pnpm check`, `pnpm build`, explicit Markdown formatting/links/whitespace, Primary stable-source review and protected CI pass. P2 source/tests/acceptance and production package boundaries remain unchanged. |

Primary owns contract, plan, review and integration. Sol medium implements only the oracle; a separate Sol medium implements only fixed fixtures/unit tests after the interface is shared. One independent Sol medium may review read-only. No child delegation. Browser/GPU/benchmark and local Rust validation are NOT RUN because this checkpoint changes test-only TypeScript; required repository CI remains mandatory.

After this slice, a separate curved-region/topology contract and independent oracle are still prerequisites for cubic fill integration: a small continuous positional error alone does not preserve crossings, tangencies, cusps, winding regions or near-contact connectivity. The existing rounded line-fill proof only applies once its input line contours are defined. The 1,000-path/32-cubic corpus, production flattening/mesh limits, mesh ABI, coverage and GPU budgets remain open; deferred stroke refinement stays deferred.
