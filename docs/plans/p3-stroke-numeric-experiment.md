# P3.0b-s2 bounded regular-stroke numerical experiment

Status: prospective contract, 2026-09-29, frozen before execution after Primary and independent review. Depends on the [analytic certificate](p3-stroke-boundary-certificate.md). This is an isolated, non-accepting diagnostic using exact rational arithmetic and outward square-root intervals, not a production Float64 implementation, new runtime dependency or full P3 acceptance.

## Question and ownership

Determine whether the conservative regular-leaf cone criterion produces independently certified raw offset chords within explicit experimental work caps, and record where it cannot. Preserve every unsuccessful case. The [private contract](p3-private-contract.md) retains all stationary/join/topology/coverage/ABI obligations and the unchanged total target. These experimental caps and limited corpus must never become product limits or replace the roadmap corpus.

Primary freezes this contract, reviews source before execution, runs and archives the experiment and interprets evidence. One Sol high worker may implement only `.tools/p3-stroke-numeric.cjs`; a separate Sol medium auditor reads the contract/source/results without editing. No recursive delegation or runtime/package changes. Standard Node built-ins only. Source and complete raw results will be archived under `docs/evidence/p3.0b-s2/`; stdout is one JSON record, stderr may contain case progress. No benchmark timer or performance claim.

## Exact arithmetic and emitted samples

Represent every input finite binary64 number by its exact IEEE dyadic rational, including the represented value of zoom 0.01. Use reduced BigInt numerator/positive-denominator pairs for all arithmetic and comparisons. Zero is canonical 0/1. Addition/subtraction/multiplication/division are exact; division by zero explicitly fails. Reduced numerator and denominator magnitude may use at most 4096 bits; bounded temporary integer expressions may use at most 8193 bits (two 4096-bit products plus an addition), checked before continued use. Count rational arithmetic/comparison operations and square-root calls, with a limit of 2,000,000 per case; bounded integer GCD/square-root iterations operate only within that bit envelope. An attempted excess operation produces ARITHMETIC_LIMIT, not a rounded/coarse answer.

For nonnegative rational x=n/d, the square-root enclosure uses a fixed grid of 2^-80: k=floor(sqrt(floor(n*2^160/d))), with integer-square-root checks k*k*d <= n*2^160 < (k+1)*(k+1)*d. Return [k/2^80,(k+1)/2^80], except exact equality uses a singleton. Negative input fails. Enclose all divisions/normalization with rational interval arithmetic; a denominator interval containing zero fails certification. No Math.sqrt, atan2, hypot, epsilon, Number conversion or float determinant may decide a certificate. Decimal summaries are informational; exact rational bounds decide results.

Square-root verification fits the transient cap: writing N=n*2^160 (at most 4256 bits), k*k*d<=N and (k+1)^2*d<=(2*k*k+2)*d<=2*N+2*d, at most 4258 bits. Do not estimate the factors as independent unbounded values. Count each reduced-rational add/subtract/multiply/divide/compare and each square-root call once; interval/vector operations count their constituent primitives. Integer GCD/isqrt loop iterations are not separate rational operations. Each corpus case and control gets a fresh budget, including input conversion, candidate and verifier work; arithmetic self-checks have their own fresh budget. Counter tests exercise the same guard used by geometry.

Candidate subdivision uses exact dyadic de Casteljau, so no subdivision roundoff is hidden in a guard. Compute endpoint normals from exact original C'(t) at canonical dyadic parameters. Emit each side endpoint as the midpoint of its enclosing rational coordinate intervals. It is a finite rational diagnostic sample, not a Float64/GPU vertex. Memoize by exact t so neighboring leaves share identical endpoint samples. Enclose the Euclidean endpoint displacement from the mathematical offset with interval arithmetic; the maximum endpoint displacement is gOffset. All further chord arithmetic is exact, so no unaccounted machine guard exists in this diagnostic. This does not prove finite-precision production guards or translated Float64 emission.

Compute a conservative physical operator norm from the exact 2x2 matrix S using outward square roots: tau=sum of squared entries, determinant det, lambdaMax=(tau+sqrt(tau*tau-4*det*det))/2, sigmaUpper=sqrt(lambdaMax).upper. Matrices below are nonsingular; negative discriminants are arithmetic defects, not silently clamped. Compare exact rational upper bounds to 1/8 physical pixel.

## Candidate and independent verifier

Candidate: follow the analytic certificate's exact control residual delta and chord/derivative cone. Use V=P3-P0, a=min dot(V,Di), b=max abs(cross(V,Di)). A zero chord or a<=0 requests subdivision; otherwise enclose sinAlpha=b/sqrt(a*a+b*b). Accept a leaf only when sigmaUpper*(deltaUpper+2*r*sinAlphaUpper+gOffset) <= 1/8. Generated seams are shared canonical samples, not user joins. For radius zero, this diagnostic may still test both coincident raw sides; it does not implement width-zero visible output.

Verifier: do not call the candidate cone/bound or consume its derivative enclosures. Convert the original cubic independently to power coefficients, evaluate C/C'/C''/C''' from those coefficients and interval Horner evaluation on each canonical t cell. A speed lower bound is the norm of the componentwise distance of the derivative interval box from zero, rounded downward; acceleration and jerk use outward norm upper bounds. If speed cannot be bounded positively, subdivide. Evaluate the true offset enclosure independently at cell endpoints and compare against the emitted candidate chord at those same parameters. Use the analytic note's M and endpoint-error + sigmaUpper*M*h*h/8 bound. Sharing basic rational/interval arithmetic is permitted; sharing geometric acceptance calculations is not.

The endpoint-error term is physical: apply the exact S to each local error interval vector, then enclose its Euclidean norm. errorUpper=max(ePhysicalLeft,ePhysicalRight)+sigmaUpper*MUpper*h*h/8. Every terminal cell of both sides must satisfy errorUpper<=1/8. Also compute a physical norm lower bound from each endpoint error box; if it exceeds 1/8, report GEOMETRIC_REJECTION immediately, rather than trying subdivisions that cannot fix a bad endpoint. An unavailable positive speed bound is never success.

Require both sides of every accepted leaf to be certified. The verifier splits its own cells within each returned leaf and uses canonical t derivatives and h. Check complete ordered [0,1] provenance with no gaps/overlap, shared sample equality, finite represented inputs and all output rational shapes before geometric verification. No sampled-only success. Discard partial emitted paths from certification when any stage fails; retain diagnostic counts and first failing interval.

Inclusive per-case caps: candidate depth 20, 1023 visited candidate nodes, 512 emitted leaves; verifier depth 24 in canonical t, 8192 total verifier cells across both sides. Check before visiting/emitting the first excess item. Counters are monotone and include failed work. Do not restart a case with larger caps. Record CANDIDATE_LIMIT, VERIFIER_LIMIT, ARITHMETIC_LIMIT or UNCERTIFIED as distinct outcomes. Fixed stationary probes below receive STATIONARY_UNSUPPORTED after exact zero-derivative detection at t=0,1/2,1; this is only a preflight for those fixtures, not general root isolation or approved cusp rendering.

Both depth counts start at zero on [0,1]; verifier depth is absolute dyadic depth, including candidate leaf depth. A visit means a popped node/cell whose work is about to start. At a depth cap, a certifiable node/cell may still succeed; a required split at that depth returns the corresponding LIMIT. Before excess visit or emission return that stage's LIMIT. UNCERTIFIED is reserved for a non-limit enclosure failure such as a normalization divisor containing zero. Structural errors precede geometric verification; exact stationary preflight precedes candidate work; a primitive arithmetic failure propagates immediately. During an already admitted verifier cell, endpoint rejection precedes subdivision/next-visit checks. Never continue after the first stage failure for that case.

Traverse candidate nodes depth-first left-before-right; output leaves in increasing t. Verify leaves in that order, left side then right side, each with its own depth-first left-before-right cells; share the total cell budget. For ties inspect endpoint t0 before t1 and coordinate x before y. A LIFO implementation pushes right then left. Freeze these choices for this source version. Different conforming future implementations need not use the same primitive operation count; replay of the archived source must reproduce its outcomes, counts and geometry digests.

## Frozen literal corpus

Controls below are in order P0,P1,P2,P3. Every numeric literal is dyadic except the separately represented zoom 0.01. No random seed is used.

| Family | Controls                                | Width |
| ------ | --------------------------------------- | ----- |
| R1     | (0,0),(1,0),(2,0),(3,0)                 | 2     |
| R2     | R1                                      | 64    |
| R3     | (0,0),(1,0),(2,1/64),(3,3/64)           | 2     |
| R4     | R3                                      | 64    |
| R5     | (0,0),(1,1),(2,-1),(3,0)                | 2     |
| R6     | (3,-3/64),(-1,-1/64),(-1,1/64),(3,3/64) | 2     |

Run each family with identity worldLinear and every zoom in [0.01,1,64] and DPR in [1,2,3]: 54 regular cases. R6 has C'(t)=(24*t-12,3/32), so its derivative never vanishes; no epsilon reversal classification is allowed.

Add five R4 cases at zoom=1,DPR=1: reverse control order; worldLinear diag(-1,1); quarter-turn [[0,-1],[1,0]]; shear [[1,1/4],[0,1]]; and controls translated by (2^30,-2^30). All have exact literal metadata. Total regular cases: 59. Translation tests only the exact diagnostic, not production cancellation/packing precision.

Add three width-2 identity/zoom1/DPR1 probes: endpoint stationary controls (0,0),(0,0),(1,0),(3,1); interior reversal (3,0),(-1,0),(-1,0),(3,0); interior stationary continuation (-1,0),(1,0),(-1,0),(1,0). Require STATIONARY_UNSUPPORTED; do not emit a result or invent cap/join behavior. Total primary corpus: 62 cases.

Required minimum successes are R1 and R2 at all nine scale pairs, and R3/R4 at zoom1/DPR1 (20 cases). Remaining regular cases are feasibility probes: preserve any capped/uncertified outcome and mark candidate-wide feasibility PARTIAL if any fails. This distinction is fixed prospectively and changes no ordinary-success P3 requirement. Do not remove a family, raise a cap or lower the target to obtain complete success.

Experimental completion therefore cannot claim feasibility for inflections, near reversals or any transformed family that remains uncertified. The analytic note's ordinary-family and eventual full P3 corpus obligations remain open for those cases; the minimum success set is only an experiment sanity gate.

## Arithmetic checks and rejecting controls

Before corpus execution, assert exact rational arithmetic/signed-zero conversion and square-root bracket inequalities on 0,1,2,1/4,2^-160 and 2^80; exercise positive/negative interval multiplication/division and denominator-zero rejection. Exercise counter guards at limit and limit+1 without thousands of dummy geometric operations; this tests guards only, not workload feasibility.

All five controls use identity/zoom1/DPR1 and structurally complete two-side outputs unless the mutation intentionally targets structure. Construct their baselines independently of the candidate, with canonical endpoint normals enclosed using the original power-polynomial definition and the specified midpoint emission:

1. R4, one interval [0,1], both sides: replace both endpoint normals by the chord normal (-1,64)/sqrt(4097) and its negative. Geometry must reject at the left-side t=0 endpoint, with a certified physical error lower bound above 1/8; both sides and provenance remain present.
2. R3, one interval [0,1]: change only its left-side start from (0,1) to (0,-1); retain its canonical left end and right side. Reject geometrically with start-error lower bound 2.
3. R1, one interval [0,1]: change only its left-side start from (0,1) to (1,1); retain the other endpoints. Reject geometrically with start-error lower bound 1.
4. R4 baseline with exactly [0,1/2] and [1/2,1] and shared canonical side samples: remove the first interval. Require STRUCTURAL_REJECTION for initial coverage gap, before geometry.
5. The same two-interval R4 baseline: insert a copy of its first interval immediately after itself. Require STRUCTURAL_REJECTION for overlap/order, before geometry.

Check the unmutated R3/R1 single-interval and R4 two-interval baselines independently certify first, so malformed carriers cannot mask a wrong-output test. Controls live outside the candidate and contain no candidate-specific success branches. Limit exhaustion alone is not successful detection. Record rejection reason and exact endpoint bound where applicable.

## Evidence and validation

Run once only after contract/source review, using the pinned Node runtime. Primary captures stdout/stderr and exit status to fresh exclusive files; preserves source bytes and SHA-256 before/after. Any failed run stays archived with its source identity and is followed by a separately named run only after the defect and correction are recorded. A process timeout of 600 seconds is an operational safeguard, never a performance result; timeout is incomplete evidence, not permission to omit cases.

The JSON contains contract/version, base SHA, source SHA, Node/platform, full fixed inputs/matrices, caps, all 62 primary outcomes, exact maximum accepted candidate/verifier bounds, output counts and a deterministic output digest for each certified case, five controls and arithmetic-check results. Archive source plus lossless raw JSON and stderr with hashes and reproduction commands. Source/result archival does not make the script a runtime/test package or a benchmark.

Encode every rational as a reduced signed `numerator/denominator` string, intervals as `[lower,upper]`, and points as `[x,y]`. Hash the UTF-8 compact `JSON.stringify` of ordered leaf objects with keys in this order: `t0`, `t1`, `left`, `right`; each side is `[startPoint,endPoint]`. Use SHA-256 and include both sides, all coordinates and canonical t. The raw JSON uses two-space indentation and a final LF. Store exact maxima only over accepted nodes/cells plus the first failure record; maxima never imply a failed case is certified. Run wrapper timestamps identify execution, outside deterministic geometry digests.

Checkpoint acceptance: arithmetic checks and five controls pass, all 62 cases have preserved outcomes, the 20 required cases are independently certified, no accepted bound exceeds 1/8, and Primary plus independent review find no unbounded/false-success path. Report experimental completion separately from candidate-wide feasibility; any other regular failure keeps the latter PARTIAL. Explicit Markdown formatting, links/anchors, whitespace, archive hash verification and protected CI apply. Local runtime unit/build/native/browser/GPU/benchmarks are NOT RUN because product source is unchanged. C03-C05 remain open regardless of the result.
