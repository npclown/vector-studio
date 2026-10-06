# P3.1m M01-M06 position certificate contract

Status: FROZEN, 2026-10-06, after Primary review and two independent review rounds plus confirmation (Astra high proof review and Sol medium implementability review). N01-N03 implementation is authorized after integration. It answers the M01-M06 checklist of the [C04 position readiness note](p3-c04-position-readiness.md). The [private contract](p3-private-contract.md) still owns C04, and the [active plan](p3-fill-stroke-meshes.md) owns status.

This is a test-only sufficient condition for K's mesh-local midpoint carrier. Nothing here adopts a representation, layout, origin rule, runtime check or rejection behavior. `NOT_ADMITTED` is a test outcome, not product behavior. The lane-range limits below define the certificate domain only; they are not clamps on camera, zoom or scene data, which P1 forbids. Adoption remains a user decision (see U1-U4) after this certificate is implemented, verified and reviewed.

## Pinned evaluation model

The pinned [WGSL §15.7](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-evaluation) gives the following rules for an operation with exact result `x`:

- **Addition, subtraction and multiplication.** `x + y`, `x - y` and `x * y` return x when x is representable. Otherwise they return either neighbour, with no rounding mode specified. For normal x the error is therefore `|r - x| < ULP(x) ≤ 2^-23 |x|`.
- **Division.** `x / y` has error `≤ 2.5 ULP(x)` when |y| is in [2^-126, 2^126].
- **Flushing.** Any input or output of these operations may be flushed to zero.
- **Reassociation and fusion.** Implementations may reassociate, and may fuse when the fused result is at least as accurate. A fused operation is modelled as one rounding with one `(1 + δ)` factor.
- **Overflow.** Overflow may give an indeterminate value.

Write the x-axis monomials of the instrumented L02 expression as follows; the y axis is analogous, with b, d, uy, `H` and `1 - (py * 2)/H`:

- `t1 = a*ux*z*q*2/W`
- `t2 = c*uy*z*q*2/W`
- `t3 = B*z*q*2/W`
- `t4 = F*z*q*2/W`
- `t5 = -1`

**Family F (syntactic).** F is the set of DAGs obtained from the frozen L02 `projectVertex` expression using only these rewrites:

- commutativity and associativity of `+` and `*`;
- distribution or factoring of `*` and `/W` over `+` and `-`;
- rewriting `x/W` as `x*(1/W)`;
- rewriting `x*2` as `x+x` (an exact doubling `x+x` counts as the single formal term `2x`);
- folding exact constant subexpressions;
- sharing of common subexpressions;
- fusion.

No other operand or constant may be introduced. In every DAG in F, each formal monomial t1..t5 appears exactly once in the expanded value, and no other formal term appears. The divisor of every division is the lane `W` (or `H`).

**Residual risk R1.** WGSL's wording does not literally forbid rewrites outside F, such as `a/(W/ux)`, a newly introduced divisor or cancelling added terms. The certificate makes no claim about them. Together with adapter specificity and the gap between the instrumented and production shaders, R1 is an explicit limit.

## M01 certificate formula

For each referenced vertex i and each axis, `E_axis(i) = Pack_axis(i) + Shader_axis(i) + Phi`. All quantities are exact rationals unless stated otherwise.

**Pack.**

- `Pack_axis(i) = |P*_axis(i) - R_axis(i)|`.
- P\* is the exact real value of the carrier over the packed binary32 lanes. For x it is `(a*ux + c*uy + B + F) * z * q`, where all lanes are the stored f32 values.
- R is K's exact original-input reference: `(a0*x + c0*y + e0 - cameraX) * zoom0 * dpr0`, using the original binary64 values.
- The test certificate evaluates Pack exactly.

**Pack64 (runtime-feasible upper bound).** Pack64 is evaluated in binary64 with round-to-nearest-even, in this order:

```
T1 = ((((a*ux) + (c*uy)) + B) + F) * z * q
T2 = ((((a0*x) + (c0*y)) + e0) - cameraX) * zoom0 * dpr0
D  = T1 - T2
```

Every root-to-leaf path has at most 8 operations. Let A be the expanded absolute sum `(|a*ux| + |c*uy| + |B| + |F|)*z*q + (|a0*x| + |c0*y| + |e0| + |cameraX|)*zoom0*dpr0`. Then

`Pack64 = |fl(D)| + 2^-49 * A + 2^-1000`, where `|fl(D)|`, A and the final sum are evaluated exactly in rationals from the binary64-computed `fl(D)` and the lane values. They are never rounded in binary64. The term 2^-1000 covers binary64 underflow amplified by `zoom0 * dpr0` (at most 2^21) and the other factors in the unguarded original inputs.

- **Proof obligation P1:** `Pack64 ≥ Pack` whenever `A ≤ 2^1000`. The argument uses `γ_8 = 8u/(1 - 8u) < 2^-49` for `u = 2^-53`, plus one absolute underflow term per operation, each amplified by at most the remaining factors. The total is below 2^-1000 whenever `A ≤ 2^1000` and every original input has magnitude at most 2^60.
- Tests additionally check `Pack64 ≥ Pack` on every row.

**Shader.**

- `Shader_x(i) = Γ * ((|a||ux| + |c||uy| + |B| + |F|) * z * q + W/2)`, where `Γ = (1 + 2^-23)^8 * (1 + 2.5 * 2^-23) - 1`, about 1.2517e-6.
- `Shader_y` is the same with b, d, uy and H.
- **Proof obligation P2 (operation count).** For a monomial t_j, count every rounded operation whose result its contribution passes through, whether or not that operation lies on a particular leaf's path. The count is at most 4 multiplications, at most 1 division and at most 4 additions:
  - The 5 non-constant factors a, ux, z, q and either `/W` or `1/W` need at most 4 binary multiplicative operations, of which at most one is a division. Writing `1/W` contributes one division plus one multiplication; that is counted within the same limit.
  - Combining the 5 summands needs at most 4 additions.
  - The factor 2, whether written as `x*2` or `x+x`, is error-free: §15.7.4 returns an exact result when one is representable, and the guard excludes overflow. A flushed subnormal input to it is covered by Phi.
  - Hence the computed value is `sum_j t_j * prod(1 + δ_k)` over at most 8 factors with `|δ| < 2^-23` and at most one factor with `|δ| ≤ 2.5 * 2^-23`.
  - Recovery `(nx + 1) * W/2` maps the NDC error exactly to physical units, which gives the stated Shader term.
- **Sensitivity.** If P2 were weakened to 9 non-division operations, `Γ9 ≈ 1.3709e-6` would replace Γ. The report records outcomes under both values.

**Phi.**

- Phi is the constant `2^-40` physical pixel.
- One `η` with `|η| ≤ 2^-126` is attached to each DAG edge, that is, to each operation output and each leaf occurrence. This covers subnormal rounding and flushing of any input or output; only values whose exact magnitude is below 2^-126 can be flushed or subnormal.
- **Proof obligation P3:**
  - F's DAGs have fewer than 256 edges.
  - Each η is amplified by at most the remaining leaf factors of its monomial, which the guard bounds by `2^20 * 2^20 * 2^10 * 2^10 * 2 = 2^61`. Division by `W ≥ 1` cannot amplify.
  - It is then multiplied by `(1 + Γ)` and by the recovery factor `W/2 ≤ 2^13`.
  - The total is below `256 * 2^-126 * 2^75 = 2^-43`, which is less than 2^-40.

**Guard.** The checks below run in this order; the first failure decides the outcome:

| Order | Check                                                                                                                  | Failure outcome           |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1     | Every lane among a, b, c, d, ux, uy, B and F has magnitude ≤ 2^20                                                      | `NOT_ADMITTED:lane-range` |
| 2     | The zoom and DPR lanes lie in [2^-20, 2^10]                                                                            | `NOT_ADMITTED:lane-range` |
| 3     | W and H are integers in 1..16384                                                                                       | `NOT_ADMITTED:lane-range` |
| 4     | `A ≤ 2^1000`, and every original binary64 input (vertex coordinates, a0..f0, camera, zoom0, dpr0) has magnitude ≤ 2^60 | `NOT_ADMITTED:lane-range` |
| 5     | The original affine is not singular                                                                                    | `NOT_ADMITTED:singular`   |

Checks 1-3 bound every exact intermediate by 2^63 and keep the divisor within [1, 16384].

**Position admission.** Position is admitted when, for every referenced vertex, the exact comparison `E_x^2 + E_y^2 ≤ 1/256` holds. Otherwise the outcome is `NOT_ADMITTED:position:<lowest failing vertex>`.

**Dominance (evidence, per vertex and per axis, exact).** `|actual_axis(i) - R_axis(i)| ≤ E_axis(i)` must hold on every row, whether or not the row is admitted, for each of these actual sources:

- **(K)** `simulateMeshProjection(input).recovered`.
- **(L)** Decoded archived native clip words for Chrome and Edge, recovered exactly as `(nx + 1) * W/2` and `(1 - ny) * H/2`.
- **(N02)** Every evaluation of the adversarial evaluator defined in M06.

The K and L checks use each row's fixture origin, because the archived native words exist only for that origin. Derived-origin variants are checked against a K re-simulation with the derived origin and against N02. They are never checked against L.

## M02 origin integration

Both policies use the same mesh, transform, camera, zoom, DPR and size.

- **O-P1.** P1's rule: `O = 256 * floor(c / 256)` on both axes. O is kept while each camera-axis displacement from O is at most 512; otherwise it is re-snapped. P1's "try the snapped current-camera anchor once" retry is not modelled, because each evaluation uses the current rule state.
- **O-PX.** A test-only physical-window origin with `g = 2^floor(log2(1024 / (z * q)))` document units, a power of two, re-derived on any zoom or DPR change.
  - `O = g * floor(c / g)` per axis.
  - O is kept while each camera-axis displacement is at most `2g`, and re-snapped otherwise or when g changes.
  - Hence `|O - c| * z * q ≤ 2048` physical pixels.

**Window-uniform bound.** For a fixed origin O, define the window `Wn = [O - D, O + D]^2`, with D = 512 for O-P1 and D = 2g for O-PX. Then

`E_win_axis = max_corners PackF_axis + ((2^-24 + 2^-52) * Fmax_axis + 2^-149) * z * q + Shader_axis(|F| := Fmax_axis * (1 + 2^-23)) + Phi`,

where:

- `PackF` is Pack with the F lane replaced by the exact value `O - c`;
- `Fmax_axis = D`.

**Proof obligation P4:**

- `f32(fl64(O - c))` differs from `O - c` by at most `(2^-24 + 2^-52) * |O - c| + 2^-149`. The absolute term covers a binary32-subnormal result; it is included in E_win as `2^-149 * z * q`.
- PackF is the absolute value of an affine function of c, so it is convex and maximal at window corners.
- The Shader term is monotone in |F|.

Therefore `E_win ≥ E(c)` for every camera c in Wn. Window admission uses `E_win_x^2 + E_win_y^2 ≤ 1/256` per vertex. Tests check `E_win ≥ E(c)` at the corners, at the actual camera and at 16 deterministic interior cameras (a 4x4 grid).

**Re-evaluation triggers.** The certificate is re-evaluated on:

- a geometry, transform or origin change;
- a zoom, DPR or viewport-size change;
- a mesh newly entering evaluation.

These match P1's budget-recheck rule, which by itself does not dirty geometry. Choosing O-PX for production would need a separate mesh origin or a change to P1's frozen rule, and is user decision U3.

## M03 obligation domain, outcomes and user decisions

The domain is the whole mesh: every referenced vertex, as in K and L.

The success outcome is `ADMITTED`. Otherwise the first failure applies, in this order:

1. `NOT_ADMITTED:lane-range`
2. `NOT_ADMITTED:singular`
3. `NOT_ADMITTED:position:<vertex>`
4. `NOT_ADMITTED:clearance:<term>`

The clearance result is computed and recorded even when position fails. No fallback, retry, alternative representation or user-visible error is selected.

The following user decisions remain open:

- **U1.** Whole-mesh versus visible-plus-guard obligation domain.
- **U2.** Runtime behavior when the certificate fails.
- **U3.** O-PX, implemented either as a mesh origin or as a change to P1's origin rule.
- **U4.** Any reuse of P1's `render.submission-failed` numeric-preparation outcome for meshes, with confirmation that it adds no new user-visible rejection.

## M04 topology clearance

Let `S = zoom0 * dpr0 * L`, with L the exact original linear part. Let `δ² = max_i (E_x(i)^2 + E_y(i)^2)` over referenced vertices.

All irrational quantities are replaced by conservative rational bounds:

- `δ̄ ≥ sqrt(δ²)` is the upward rational square root with denominator 2^64.
- `σ̄max ≥ ‖S‖_F ≥ σmax` uses the same upward square root of the squared Frobenius norm.
- `σmin ≥ σ_lo = |det S| / σ̄max`.
- Lengths use L1 norms as upper bounds and L∞ norms as lower bounds of Euclidean length.

**Geometry-owned summaries.** These are computed exactly from original local coordinates and correspond to K's [eligibility](../evidence/p3.1k-projection/carrier-eligibility-exact.json) terms:

| Term       | K term                           | Summary                                                                                                                                                                                                 |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vertex`   | `distinct`                       | `dV2` = minimum squared distinct-vertex distance                                                                                                                                                        |
| `edge`     | `disjoint`                       | `dE2` = minimum squared distance between non-incident edges                                                                                                                                             |
| `triangle` | `triangle`                       | For each triangle with edge vectors u and v from its first vertex: `ρ̄ = min A2_t / (‖u‖₁ + ‖v‖₁)` with `A2_t = abs(cross(u, v))`, and `Plo = min (‖u‖∞ + ‖v‖∞)`                                         |
| `fan`      | `shared` (rays sharing a vertex) | For every pair of distinct edges incident at a common vertex: non-collinear `κ̄ = min abs(cross(u, v)) / (‖u‖₁ + ‖v‖₁)` with `Plo` as above; collinear opposite `λ̄ = min abs(dot(u, v)) / (‖u‖₁ + ‖v‖₁)` |

**Conditions.** All must be strict. They are checked in table order (vertex, edge, triangle, fan), and the first failure gives `NOT_ADMITTED:clearance:<term>`:

| Term                      | Condition                                      |
| ------------------------- | ---------------------------------------------- |
| `vertex`                  | `σ_lo² * dV2 > 4 * δ̄²`                         |
| `edge`                    | `σ_lo² * dE2 > 4 * δ̄²`                         |
| `triangle`                | `abs(det S) * ρ̄ > 2 * δ̄ * σ̄max + 4 * δ̄² / Plo` |
| `fan`, non-collinear      | The triangle form, with κ̄ in place of ρ̄        |
| `fan`, collinear opposite | `σ_lo² * λ̄ > 2 * δ̄ * σ̄max + 4 * δ̄² / Plo`      |

**Proof obligation P5:**

- **Transport.** Distances scale by at least σmin, crosses by det S, lengths by at most σmax, and opposite-collinear dot magnitudes by at least σmin².
- **Perturbation.** If each vertex moves by at most δ along a straight line, each edge vector moves by at most 2δ, and the change in a cross or dot product is at most `2δ(‖Su‖ + ‖Sv‖) + 4δ²`.
- **Ratio algebra.** `A2 ≥ ρ̄ * P` together with `P ≥ Plo` gives the sufficient condition shown.
- **Sufficiency.** The four terms are exactly K's reviewed `distinct`, `disjoint`, `triangle` and `shared` predicates transported by S. They therefore exclude collision, flip, crossing and fan-order change throughout the motion.

## M05 corpus and prospective expectations

**Data rows.** All 158 K mesh rows use their fixture origin and are reported. The pinned inputs are:

| Input                                         | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| K archive `observations-20261005T073041.json` | `b3b372db13ec4ad07bb31a8f79a8a99745f3b91ff8d0ed0e3d07a307e7a85dff` |
| L Chrome `capture.json`                       | `850899aca187ab736d137ba1668d130f84f3e9a10a2a8ef33e771784daf81092` |
| L Edge `capture.json`                         | `4b79065e327ea0bed3a8d5d5afec1d6aa3890e66eb99503c38f5c4152cdc0469` |

Both L files are under `docs/evidence/p3.1l-native-projection/2026-10-06T07-28-57-641Z-22556/<browser>/native_projection_corpus/capture.json`.

**Prospective literal rows.**

- **Rectangle and square meshes** use K's rectangle vertex and index layout (`rectangle(w, h)`). Size means the physical lanes W x H. The transform is I. Pack is exactly 0 for all of these dyadic rows, so expected values are computed with Γ8.
- **The thin control** follows K. Its δ is about 4.6e-4, which is far larger than half its 2^-25 separation.

| ID           | Mesh, translation, camera                                                      | Origin                                       | zoom, DPR, size | E² (Γ8)         | Expected                                                                     |
| ------------ | ------------------------------------------------------------------------------ | -------------------------------------------- | --------------- | --------------- | ---------------------------------------------------------------------------- |
| P1-CANCEL-64 | 16x8, (256.75, 1), (255.75, 0)                                                 | O-P1 (0, 0)                                  | 64, 2, 1280x720 | 7.310e-3        | `NOT_ADMITTED:position:0`. Window: reject                                    |
| PX-CANCEL-64 | same                                                                           | O-PX (248, 0), g = 8                         | 64, 2, 1280x720 | 3.968e-5        | `ADMITTED`. Window (D = 16): admit, 7.65e-5                                  |
| P1-CANCEL-1  | same                                                                           | O-P1 (0, 0)                                  | 1, 1, 640x360   | 1.18e-6         | `ADMITTED`. Window: admit, 2.82e-6                                           |
| EXT-4096     | 4096², (0, 0), (0, 0)                                                          | (0, 0)                                       | 1, 1, 640x360   | 5.92e-5         | `ADMITTED`                                                                   |
| EXT-16384    | 16384², same                                                                   | (0, 0)                                       | same            | 8.67e-4         | `ADMITTED`                                                                   |
| EXT-32768    | 32768², same                                                                   | (0, 0)                                       | same            | 3.416e-3        | `ADMITTED`. Under Γ9 it would be 4.098e-3, a reject; the report records this |
| EXT-65536    | 65536², same                                                                   | (0, 0)                                       | same            | 1.356e-2        | `NOT_ADMITTED:position:0`                                                    |
| N03P-0..6    | 16x8, (0.25, 0.5), camera x `0, 255.75, 256, 511.75, 512, 512.25, 511.75`, y 0 | O-P1, must equal x `0, 0, 0, 0, 0, 512, 512` | 1, 1, 640x360   | —               | `ADMITTED` at every step                                                     |
| N03N-0..4    | same, camera x `0, -0.25, -256, -512, -512.25`                                 | O-P1, must equal x `0, 0, 0, 0, -768`        | same            | —               | `ADMITTED` at every step                                                     |
| THIN         | K thin control                                                                 | (0, 0)                                       | 1, 1, 640x360   | position admits | `NOT_ADMITTED:clearance:vertex`                                              |

**Term-targeting rows.** For these, dominance must hold and status is reported, except where an outcome is stated:

- **PACK-R15:** a 16x8 rectangle with R15, translation (0.1, 0.2), camera (0.05, 0), origin (0, 0), zoom 1.5, DPR 1, size 960x540. Pack is nonzero.
- **FTZ:** vertices `[(0, 0), (2^-140, 0), (0, 1)]`, indices `[0, 1, 2]`, identity, translation (0, 0), camera (0, 0), origin (0, 0), zoom 1, DPR 1, size 640x360. The binary32 local offsets are subnormal, so this row exercises Phi. Expected: `NOT_ADMITTED:clearance:vertex`.
- **Lane-range boundary rows** (16x8, identity, camera (0, 0), origin (0, 0), DPR 1, size 640x360):
  - translation (0, 0) at zoom `2^10`: `ADMITTED` (Shader_x ≈ Γ·(16384 + 320) ≈ 0.0209);
  - translation (0, 0) at zoom `2^10 + 2^-13`: `NOT_ADMITTED:lane-range`;
  - translation `(2^20 - 8, 0)` at zoom 1, giving `B_x = 2^20`: the guard passes, then `NOT_ADMITTED:position:0`, because Shader_x ≈ 1.31;
  - translation `(2^20 - 7, 0)` at zoom 1: `NOT_ADMITTED:lane-range`.
- **WIN-EDGE:** PX-CANCEL-64 with camera x = 264 = O + 2g, origin kept at (248, 0): `ADMITTED`, with E² ≈ 5.73e-5. At camera x = 264.25 the origin must re-snap to O-PX (264, 0) with g = 8, which is asserted.

The prospective values were recomputed independently by both round-1 reviewers.

**Unit controls:**

- **Overrides.** `gamma: 0` must make the L or N02 dominance check fail on at least one row; the test names the failing rows. `packZero: true` must change E on PACK-R15.
- **Mutated summaries.** A mutated `dV2` or `ρ̄` must change the THIN or rectangle clearance outcome.
- **Import test.** A static import test must show that N02 does not import N01.
- **Input-magnitude boundary.** These rows are as amended by A1 below.
- **Square-root bounds.** Each upward square-root bound must be at least the exact square root.

## M06 ownership, interfaces, budget and evidence

All files below are new and test-only, with no package exports. They make no runtime, ABI, API, dependency, threshold or stroke change.

| Unit | Owner      | File                                                                                              | Exports                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N01  | Primary    | `tests/geometry/position-certificate/certificate.ts`                                              | `certifyPosition(input: ProjectionInput, origin: ProjectionPoint, overrides?: {gamma?: Rational; packZero?: boolean}): PositionCertificate`, `certifyWindow(input, origin, halfWidth: number): WindowCertificate`, `originP1(camera, previous?): ProjectionPoint`, `originPX(camera, zoom, dpr, previous?): {origin, g}`, `clearanceSummary(mesh): ClearanceSummary`, `pack64(input, origin): Rational[][]` |
| N02  | Sol medium | `tests/geometry/position-certificate/adversarial.ts`                                              | `adversarialDisplacement(input, origin, vertex, axis): {maxAbs: Rational, evaluations: number}`, `independentClearanceSummary(mesh)`                                                                                                                                                                                                                                                                        |
| N03  | Sol medium | `tests/geometry/position-certificate/corpus.ts` and `tests/geometry/position-certificate.test.ts` | Literal rows, archive loaders and the report writer                                                                                                                                                                                                                                                                                                                                                         |

`PositionCertificate` has the shape `{status, reason, ex, ey, delta2Max, worstVertex, clearance: {term}}`, typed as follows:

- `status` is the closed union `'ADMITTED' | 'NOT_ADMITTED'`.
- `reason` is `null` or one of the M03 reason strings: `lane-range`, `singular`, `position:<vertex>` or `clearance:<vertex|edge|triangle|fan>`.
- `ex` and `ey` are `(Rational | null)[]`, with null for unreferenced vertices.
- `clearance.term` is the first failing clearance term or null.
- `clearance.collinear` is a boolean that records which `fan` case failed.

`WindowCertificate` adds `ewx` and `ewy`.

**Allowed imports.**

- The exact helpers in `tests/geometry/rounded-fill/exact.ts`.
- `roundExact32`/`roundExact64`.
- `fixedProjectionFixtures`.
- `simulateMeshProjection`, for K actuals only.
- `decodeCapture`, for L words only.
- `verifyConformingRefinement`.
- The three pinned archives, with their hashes asserted.
- N02 may not import N01; N01 may not import N02.

**N02 scope (deterministic and bounded).** For each selected vertex-axis, N02 evaluates the expression in binary32 using exact dyadic BigInt `(mantissa, exponent)` arithmetic. Division by the integer W uses an exact BigInt quotient and remainder.

- **Forms (225 DAG forms in total):**
  - **Factored:** `((((s * z) * q) * 2) / W) - 1`, where s ranges over the 15 parenthesizations of the four summands.
  - **Distributed:** each `t_j` is computed as `((((leaf * z) * q) * 2) / W)`, or with `* (1/W)` in place of the division, and the five summands with -1 are combined in each of their 105 parenthesizations.
- **Rounding:**
  - uniform round-to-nearest-even, toward +∞, toward -∞ and toward 0;
  - plus two adversarial passes, s ∈ {+1, -1}. In each pass, every operation rounds in direction `s * sign(∂root/∂op)`, where the sign is the product of the signs of the remaining multiplicative factors on its way to the root, negated for a subtrahend.
  - Division takes the binary32 value farthest from the exact quotient within 2.5 ULP, on the side that pushes away from P\*, and is also evaluated correctly rounded.
- **Flushing:** flush-to-zero off, and on for both inputs and outputs, with sign preserved.
- **Selected vertex-axes:**
  - per fixture row, the vertex with the largest Shader absolute sum on each axis;
  - every vertex of each prospective and term-targeting row.
- **Determinism and budget:**
  - N02 runs only at each row's evaluated camera; window corner and interior cameras are checked only for `E_win ≥ E(c)`.
  - Monomial results are shared across sum trees.
  - Each vertex-axis has exactly 225 forms × 6 rounding variants × 2 FTZ settings × 2 division variants = 5400 evaluations. In uniform round-to-nearest-even, the extremal division pushes away from P*. In directed modes it follows the mode, and in adversarial passes it follows the pass direction. The correctly rounded division variant uses the evaluation's rounding mode.
  - The test asserts these exact per-vertex-axis and total evaluation counts.
  - Wall time is recorded in the report as an observation and is not asserted.
  - Each `it` block has a timeout of at most 60 s.

**Evidence.**

- The test regenerates `docs/evidence/p3.1m-position-certificate/report.json` and requires it to match the committed file byte for byte. It is written only when `P3_POSITION_CERTIFICATE_WRITE=1`.
- The report holds:
  - the schema, source hashes and archive hashes;
  - for each row and policy: id, status, reason, worst vertex, exact `delta2Max`, the window result, the clearance term, and the maximum actual displacement for K, L-Chrome, L-Edge and N02;
  - the admitted-rows list;
  - the Γ9 sensitivity outcomes.
- A review record accompanies it, following the K and L precedent.

**Validation:**

- `pnpm check`;
- `pnpm test:geometry`, which picks up `tests/geometry/**/*.test.ts` and is run by CI;
- `pnpm build`;
- changed-Markdown and link checks.

No GPU or browser run is needed.

**Dependency order:** `M00 integrated -> this contract FROZEN -> N01-N03 implementation -> stable-source review -> exact evaluation and report -> independent evidence review -> user decisions U1-U4 and adoption`.

## Amendment A1 (2026-10-06, during implementation)

The original input-magnitude control described "a 16x8 identity row with one vertex coordinate equal to 2^60". That row cannot isolate guard check 4, for two reasons:

- If the other vertices stay near 0, the midpoint offsets exceed 2^20, so guard check 1 fails first.
- Binary64 cannot represent a 16-wide rectangle at 2^60. The ULP is 256 above 2^60 and 128 below it.

**Primary ruling.** Replace the row with a 4096x8 identity mesh: vertices `[(2^60 - 4096, 0), (x1, 0), (2^60, 8), (2^60 - 4096, 8)]`, indices `[0, 1, 2, 0, 2, 3]`, translation (0, 0), camera = origin = `(2^60 - 2048, 0)`, zoom 1, DPR 1, size 640x360.

- With `x1 = 2^60`, the row passes guard check 4.
- With `x1 = 2^60 + 2^8`, the next binary64 value, the outcome is `NOT_ADMITTED:lane-range`.

This changes only the literal used to exercise the stated boundary. No formula, threshold or other expectation changes. It is reviewed in the stable-source and evidence review of the implementation.

## Amendment A2 (2026-10-06, stable-source review clarification)

The implementation makes three clarifications. None changes an outcome in the corpus, and none weakens the certificate.

- **Shared `Plo`.** `Plo` is a single minimum of `‖u‖∞ + ‖v‖∞` over every triangle pair and every fan pair. Every triangle pair is also a fan pair at its first vertex, and the ratio algebra needs only `Plo ≤ ‖u‖₂ + ‖v‖₂` for each pair, so the shared minimum is sound. Reading "`Plo` as above" as the triangle-only minimum would be unsound for fan pairs in general. A separate recomputation found no outcome difference across the 158 fixtures.
- **Overlapping incident edges.** Two incident edges that overlap in the same direction report `clearance:fan` with `collinear: true`.
- **Window lane bound.** `certifyWindow` reports the window as not admitted when `Fmax > 2^20`, because the F lane would leave the guard range.
