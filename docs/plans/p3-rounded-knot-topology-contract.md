# P3.1f rounded internal-knot topology certificate

Status: FROZEN, 2026-10-02, after Primary and independent Astra high mathematical/interface/literal-fixture review, before implementation. This test-only sufficient certificate follows [P3.1e](p3-simple-cubic-topology-contract.md) and the [P3.2m2 observation](../evidence/p3.2m2-cubic-readiness-2026-10-02/README.md). The [active plan](p3-fill-stroke-meshes.md) owns execution. No public API, runtime rejection policy/cap, error allowance, dependency or full P3 acceptance changes.

## Purpose and proof

P3.1e requires every leaf knot to equal the exact restricted cubic value. This separate certificate permits rounded internal subdivision knots while requiring every source cubic's final actual endpoint to equal its represented canonical endpoint exactly. It does not replace or weaken P3.1e. A conservative sufficient-condition failure remains UNRESOLVED, not proof of invalid geometry. The two sufficient certificates need not accept identical geometry.

For each source leaf, compute exact restricted Bernstein controls Q0..Q3 from the represented original cubic and validated dyadic provenance. Carry actual start A from the previous actual endpoint globally through the contour; only the initial MOVE supplies an independent start. Never reset at a source boundary. The global exact source-endpoint guard makes carried boundary starts equal canonical starts and keeps existing P3.1d per-source positional verification applicable. Internal A/B need not equal Q0/Q3. The endpoint of one piece and the start of the next match separately in both source and actual chains.

For each leaf use H(s,u)=(1-s)C(u)+sL(u), where L joins the actual A/B. Its image stays in the closed convex hull of Q0,Q1,Q2,Q3,A,B. For a directed cyclic adjacent pair P,N, including last-to-first, choose the sole candidate d=N.Q3-P.Q0. For EACH piece require all three source control-difference dot products with d to be nonnegative, their total to be strictly positive, and its actual chord dot d to be strictly positive. For an implicit straight closure use exact endpoint derivative directly. No floating epsilon or adaptive direction search is allowed.

The quadratic Bernstein basis is positive in the open interval; nonnegative derivative coefficients with positive sum therefore make each source piece strictly increasing in projection onto d. The actual line also increases strictly; every H_s does too. Consequently the previous piece lies strictly before the shared moving knot and the next strictly after it, except at the shared endpoint. Nonadjacent and cross-contour expanded hulls must be disjoint as closed sets, including contact, edge overlap and containment. These conditions establish simultaneous embeddings of every contour with disjoint components, preserving orientation and nesting. Merely checking source hulls or independent own-chord projections is insufficient.

The implicit closing line is fixed from the final source/actual endpoint to initial MOVE, omitted exactly when those endpoints equal. It has zero boundary displacement and participates in cyclic adjacency and all separation checks. Require at least three leaves after closure. Zero source progress, zero/reversed actual progress in a required direction or an inconclusive pair returns UNRESOLVED; do not omit degenerate source leaves. Source endpoint mismatch is KNOT_MISMATCH, even if positional error is small. A broader rounded source-boundary contract would require a new globally carried positional proof and is out of scope.

After all checks, derive exact polygon orientation and winding using the existing P3.1e publication logic. Publication is atomic; every failure returns a null certificate. Pair with unchanged P3.1d for location error, then separately validate any mesh against its polygonal contours. This test-only certificate by itself claims neither error tolerance, native output support, topology of general crossings nor mesh coverage.

## Interface, bounds and precedence

Add test-only `certifyRoundedKnotCubicTopology(contours, limits?)` beside the existing oracle, reusing its input/result/limit types. Keep default ceilings4 contours/16 source cubics/64 total leaves including closure/2016 inspected unordered pairs and maximum provenance depth20. Smaller limits remain inclusive. No package export or runtime import is added.

1. Validate limits, global input shape/counts, finite coordinates, unique u32 ordinals, canonical connectivity and all dyadic provenance in exactly the existing P3.1e order. The declared source-line count must fit before reading excess contents. Shared pure preflight extraction is allowed only if the old certificate's statuses/findings/counters/precedence remain unchanged; do not duplicate its parser.
2. Check every source's final actual endpoint exactly against its canonical Q3 before geometric work. Any mismatch returns KNOT_MISMATCH with leaves=0,pairs=0. Earlier rounded internal knots do not mask a later malformed input/provenance/source endpoint.
3. Build leaves in contour/source/provenance order using exact restrictions, globally carried actual starts and expanded hulls. Charge before append, including closure. Exhaustion returns WORK_LIMIT with appended count and zero pairs. No projection check precedes this stage's capacity decision. After construction, fewer than three leaves in any contour returns UNRESOLVED with full appended count, zero pairs.
4. Enumerate unordered i<j pairs in append order, charging before inspection. For cyclic adjacent indices orient P,N in contour order, especially the last-to-first pair; apply the common-direction test. For every other pair require expanded closed hull disjointness. A failed pair counts as inspected. The first over-limit pair returns WORK_LIMIT without inspection.
5. Reuse the exact polygon orientation/nesting publication after all pairs pass. Preserve input ownership and deterministic outcomes. No retries, hidden refinement, native/GPU execution or larger-cap diagnostic runner is included.

## Prospective analytic fixtures

All concrete sources, actual endpoints and expected results must be reviewed before first numeric execution. New positives are a bounded analytic corpus; existing P3.1e tests remain unchanged and passing. No full1000 workload acceptance or post-observation fixture fitting is implied.

Use the closed three-cubic contour A=(0,0),B=(3,0),C=(3/2,-3), each uniformly split into four depth2 leaves. A-to-B controls are (1,E),(2,1); B-to-C controls are (5/2,-1),(2,-2); C-to-A controls are (1,-2),(1/2,-1). Set E=2^-54. The supplied actual A-to-B endpoints are (3/4,9/64+2^-55),(3/2,3/8),(9/4,27/64),B. Other edges have exact quarter endpoints. These are literal represented values, not results generated by the candidate oracle. For the paired E=0 control the first actual y is exactly9/64; other endpoints are unchanged.

The exact first curve has x=3t and y=3E*t*(1-t)^2+3t^2*(1-t). Quarter-point y perturbations are27E/64,3E/8,9E/64 respectively; the supplied endpoints are their nearest represented values. Internal knots differ exactly for E>0, while each source endpoint remains exact. |y''|<=12 and quarter width1/4 bound the interpolation error by3/32; rounded endpoint displacement is less than2^-55. Thus P3.1d at identity remains below1/8. Both E variants have orientation -1 and no container.

Upper leaf hulls occupy ordered quarter-width x slabs and y>=0; nonadjacent upper leaves are separated. Lower straight sides lie below y=0 except A/B, and intersect each other only at C. Expanded hulls retain these separations. Common-direction projections are strictly positive at every directed join. Within the upper cubic d has dx=3/2 and |dy|<1/2, while source differences have dx=1/4 and |dy|<=1/4, so their dots exceed1/4. Corner directions at B,C,A are respectively (3/8,-75/64-9E/64),(-3/4,0),(3/8,57/64+27E/64); all participating source differences and actual chords have positive projection. Reflection, uniform scaling, chain reversal and exact x translations preserve these conditions.

For each E variant require identity, x reflection, scale1/2 and reversal of the supplied contour (reverse original controls and actual chain, rebuild matching dyadic provenance without re-evaluating endpoints). Orientation is respectively -1,+1,-1,+1 and winding is[[0]]. Add four disjoint E>0 contours translated only in x by0,16,32,48 with orientations all-1 and zero winding matrix; also reverse their contour order. Globally unique ordinals are assigned in source order. Total10 required certificates; every source is also P3.1d-certified. E>0 positives must remain KNOT_MISMATCH under unchanged P3.1e, while E=0 controls must retain its success.

## Controls and acceptance

The following literal controls are fixed before execution:

- Source-end mismatch: in the E>0 triangle replace the first source's final actual B with (3,MIN_VALUE), leaving canonical controls/provenance unchanged. KNOT_MISMATCH precedes all hull work. Place an earlier internal rounding or a later invalid provenance/NaN to verify global precedence.
- Collapse/reversal: replace the first actual quarter endpoint with A or (-3/4,0), respectively. All other endpoints/provenance and source-final endpoints remain unchanged. Both return UNRESOLVED at a directed adjacent projection; they must not be normalized away.
- Cyclic-only projection: exact linear triangle A=(0,0),B=(9,0),C=(3,-9). Controls are (3,0),(6,0); (7,-3),(5,-6); (2,-6),(1,-3). Use one depth0 leaf A-to-B, two depth1 leaves B-to-C, then C-to-A endpoints (3/2,-9/2),(3/4,-9/4),A with intervals [0,1/2],[1/2,3/4],[3/4,1]. Other directed joins pass and nonadjacent hulls separate. Last-to-first has d=(33/4,9/4); previous actual chord dot d=-9/8. Old P3.1e CERTIFIED; new candidate UNRESOLVED. This catches a missing cyclic check without claiming the input is invalid.
- Expanded-hull contact: square with corners (0,0),(3,0),(3,3),(0,3), exact linear cubics with integer trisection controls, two depth1 leaves per side. Replace right-side actual midpoint (3,3/2) by (6,3/2), keeping source endpoints exact. Add the ordinary square [6,9]x[0,3] at depth1. Source hulls are separated; expanded hulls touch the second contour. UNRESOLVED must report a nonadjacent pair, not an unrelated adjacent failure.
- Expanded-hull containment: use the same perturbed first square, but the second contour is the small square [4,67/16]x[1,19/16], with exact1/16 linear control increments and depth0 leaves. Its hulls lie strictly inside the expanded triangle (3,0),(3,3/2),(6,3/2) without crossing its boundary. Require UNRESOLVED from nonadjacent containment. These deliberately large endpoint displacements are topology-only controls and need not pass P3.1d.
- Retain named old bowtie, adjacent overlap, cross-contour contact, coincident contours and near-contact hull-containment controls as UNRESOLVED. Keep the tiny zero-chord and two-leaf negative-projection controls UNRESOLVED, now with fewer-than-three-leaves detection allowed before pairs. Do not change their old-oracle expectations.
- Late failure: prepend an E>0 passing triangle translated by(-16,0) to the source-end mismatch and to expanded containment controls, reassigning unique ordinals. Return null for the complete invocation despite any prior valid contour. Source-end mismatch retains zero work; geometric containment retains its actual charged leaf/pair counts.
- Invalid limits (noninteger/out of range), malformed/sparse/nonfinite input, duplicate/wrong ordinals, disconnected canonical chains, missing/gapped/overlapping/nonterminating dyadic provenance retain global preflight failures. Add a late malformed source to ensure no early positive publication; over-cap count wins before inspecting malformed excess content.
- The single triangle has12 leaves and66 inspected pairs: exact maxLeaves12/maxPairs66 succeeds, maxLeaves11 fails at preflight with0/0, maxPairs65 fails at12/65. The four-copy corpus has4 contours/12 cubics/48 leaves/1128 pairs; each corresponding exact limit succeeds and lowering each by one yields WORK_LIMIT at the documented stage. Defaults remain4/16/64/2016; excess contour/cubic/declared-leaf counts and invalid above-ceiling limits are exercised directly.
- Closure positive: use the same E>0 upper cubic A-to-B, then a depth2 linear cubic B-to-Cprime with Cprime=(0,-3/2) and controls (2,-1/2),(1,-1). The fixed implicit Cprime-to-A line yields9 leaves/36 pairs, orientation-1, no container. At Cprime the preceding chord dot candidate d is9/64>0; at B the candidate is (0,-51/64-9E/64), and at A it is (3/4,105/64+27E/64), with positive source/chord projections. Source endpoints stay exact and closure displacement is zero. This is an eleventh required certificate, also requiring P3.1d on both cubics. maxLeaves8 fails when appending closure with8/0. A single constant zero-chord cubic has one retained leaf and is UNRESOLVED; a nonreturning sole exact linear cubic plus closure has two and is UNRESOLVED.

Require exact returned polygons from the supplied actual leaf-start sequence, literal orientation/winding, deterministic repeated calls, no mutation of deeply frozen caller data, no aliased writable certificate points and null certificates for every failure. Bounds/expected results must not be tuned after execution. Existing P3.1e success/rejection tests and P3.1d units remain unchanged and passing.

| ID  | Required evidence                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K01 | Primary and independent proof/contract/literal fixture review and freeze before implementation; stable source review before execution.                   |
| K02 | All11 new topology certificates and per-source P3.1d proofs, exact polygon/orientation/winding and unchanged P3.1e counterpart expectations.             |
| K03 | Frozen invalid/unresolved/limit controls, counters/precedence, no partial publication, deterministic repeats and input isolation.                        |
| K04 | Focused new/existing oracle tests, bounded two-worker `pnpm check`, `pnpm build`, docs/links/diff, Primary/independent review and required protected CI. |

Primary owns the contract and integration. Sol high owns the coupled oracle/shared preflight; Sol medium owns disjoint fixtures/unit tests. Independent proof/source review remains read-only. No recursive delegation. Local Rust/browser/GPU/benchmark and full census are NOT RUN for this test-only checkpoint. General crossings/tangencies, runtime adoption/capacity, mesh composition and full P3 gates remain subsequent work; user-deferred stroke remains deferred.

## E8 addendum, 2026-10-23

Status: APPROVED 2026-10-23 by the Primary under the user's standing instruction of 2026-10-22 (independent review round 2 READY WITH FOLLOW-UPS, follow-ups applied; E8.12). Item [E8](d9-rendering-track.md#e8-investigation-2026-10-23) of the rendering track owns execution. The frozen text above is unchanged. This addendum amends only the clauses it names, and only for units E8-U0, E8-U1 and E8-U2, which run in that order (E8-Q5).

Status history: DRAFT, 2026-10-23, written by the Primary under the user's standing instruction (take the recommended option and record the decision), in independent review; revised after review round 1 (E8.12).

Tier: full. Track: rendering. Shared surface: none. No public API, ABI, export, operation identity, kernel revision, cap, threshold, error allowance or dependency changes. The A04 target of the [E3 contract](d9-e3-b4-precision-contract.md) is unchanged.

### E8.1 Owning documents and sites

This contract owns two rules: the common-direction test for cyclic adjacent pairs (line 11) and the source-final restriction (lines 7, 9 and 15, and step 2 on line 24). Its native successors implement both rules unchanged. The addendum is therefore written here, and each successor carries a pointer to it.

| Site on `main` e6eb90f (`packages/geometry-wasm/kernel/src/`)                                    | Native contract                                                                                                                                                                                                                                           | Unit  |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `simple_cubic_topology.rs:831-839`, `RoundedKnotCubicTopologyWorkspace::check_pair`              | [P3.2n](p3-native-rounded-topology-contract.md)                                                                                                                                                                                                           | E8-U1 |
| `simple_cubic_topology.rs:873-885`, its `reference_pair_body` (the B0R O3 reference)             | P3.2n with [B0R](p3-b0r-kernel-performance-contract.md#62-frozen-clauses-this-contract-amends) U2                                                                                                                                                         | E8-U1 |
| `simple_cubic_topology.rs:1085-1102`, `TransverseArrangementWorkspace::check_pair`               | [P3.2s](p3-native-transverse-arrangement-contract.md) line 20 ("Adjacent pairs use unchanged directed common projection"), extended by [P3.2v](p3-native-mixed-line-arrangement-contract.md) and [P3.2x](p3-native-triangle-free-arrangement-contract.md) | E8-U1 |
| `simple_cubic_topology.rs:1190-1207`, its `reference_pair_body`                                  | P3.2s and P3.2x with B0R U2                                                                                                                                                                                                                               | E8-U1 |
| `simple_cubic_topology.rs:2279`, `preflight_source_final`, called at `:664` (`prepare_suffix`)   | P3.2n line 17 and step 3 (line 29); inherited by P3.2s and P3.2x                                                                                                                                                                                          | E8-U2 |
| `cubic_fill.rs:480-515`, `run_prefix` (before `collect_contours` and `validate_leaf_partitions`) | [P3.2h](p3-native-cubic-workspace-contract.md), [P3.2o](p3-rounded-topology-adoption-contract.md) line 7, [P3.2y](p3-triangle-free-cubic-composition-contract.md) line 7                                                                                  | E8-U2 |

Other documents that inherit the test:

- **Test-only oracles.** The oracle of this contract, [P3.1g](p3-transverse-arrangement-contract.md) (line 52) and [P3.1i](p3-triangle-free-arrangement-contract.md) (line 7) inherit the same test. By E8-Q2 (b) they follow the change through an independently written TypeScript mirror of E8.3 (E8-K10).
- **Cascade.** The cascade of the [V2 contract](p3-v2-fill-mesh-transport-contract.md) section c and rung 1 of the [Alt-A1 contract](p3-alt-a1-fill-ladder-contract.md) keep their order and their selection rules. Only the helpers they call accept more inputs.
- **Unchanged.** The fast rung (Alt-A1 FR4, `fill_ladder.rs:1700-1745`) and the exact-knot helper of [P3.1e](p3-simple-cubic-topology-contract.md) are not changed.

### E8.2 Finding

The [E8 investigation](d9-rendering-track.md#e8-investigation-2026-10-23) reproduced both V-2 paths natively and found three mechanisms.

- **M1, a corner beside a cubic leaf.** The sole candidate d = N.Q3 − P.Q0 of line 11 is dominated by the longer piece.
  - At a knot that turns by about 90° or more, a short leaf next to a long segment then has a control difference with a negative dot.
  - The P3.1e exact-knot helper tolerates such corners, but only when every flattening knot is exactly representable.
  - The Q/T path fails at its T-end corner: leaves 32→33, d = (12.5, 88.28). Degree elevation gives non-dyadic thirds, so `preflight_knots` returns KnotMismatch, then `:839` and `:1102` return UNRESOLVED.
- **M1′, a tangential reversal.** The S of the C/S path ends with a vertical tangent, and `L 200 50` returns along the same line: a 180° turn.
  - Its knots are exact, so it reaches P3.1e, whose adjacent hulls overlap along x = 200 (`:512`).
  - No common direction exists.
- **M2, an inexact source-final knot.** The flattener emits each final leaf endpoint as `origin + (p3 − origin)` (`geometry.rs:651-654`).
  - With non-dyadic endpoints this often differs from p3, so step 2 (line 24) returns KNOT_MISMATCH.
  - The two V-2 paths do not hit M2.

### E8.2a E8-U0: a failure-to-success mode for the fill identity tool

Added in review round 1 (S2). E8-K3 cannot run in plain mode, because plain `pnpm test:p3-fill-identity` requires equal digests and E8-U1 and E8-U2 turn failures into successes. E8-U0 is a light-tier tooling unit that runs before E8-U1. It changes no kernel code.

- **Mode.** Add `--failure-to-success` to `tooling/compare-p3-fill-identity.mjs`, beside `--revision-change`, with the same `--compare-only <run-dir>` and `--tamper <case>` support. It replaces the digest equality with a per-record classification of merge base against branch:
  - A record is the whole tuple the tool already writes per case: `digest`, `allocations`, `code` and `crossings` (`compare-p3-fill-identity.mjs:155-168`). The digest covers status, counts, statistics, diagnostics and mesh bytes. Two records are equal only if every field of the tuple is equal (round 2, F1).
  - **identical:** the base record is `ok`, and the branch record equals it in every field.
  - **FAIL:** the base record is `ok`, and the branch record differs in any field, including a change only in diagnostics or statistics.
  - **allowed change:** the base record is a path failure (a non-`ok` path status), and the branch record is `ok` or another path failure. It is listed with both codes.
  - **internal-regression (also FAIL):** the base record is a path failure, and the branch record is an internal error or a batch failure. It is reported as its own class and counts as FAIL (round 2, F3).
  - The run passes only if there is no FAIL or internal-regression. It writes the count of each class and the list of allowed changes to the run directory.
- **Unchanged.** Every other step of the tool stays unchanged: the test-file allow-list (O5), the inline `cfg(test)` module check, the pinned toolchain and the corpus.
- **Self-test.** `--self-test` gains synthetic run directories for each class, and tamper cases that must FAIL:
  - one mesh byte changed on a base-`ok` record;
  - a base-`ok` record that becomes a failure;
  - a base-`ok` record with a changed boundary pair;
  - a base-`ok` record whose digest changes only in diagnostics or statistics, with identical mesh bytes (round 2, F2);
  - a base-`ok` record whose `allocations` or `crossings` field changes;
  - a base path failure that becomes an internal error, and one that becomes a batch failure (both internal-regression);
  - a missing record.
  - One review of the self-test is required before E8-U1 relies on the mode.
- **Acceptance.** The self-test passes. A plain-mode run and a `--failure-to-success` run on an unchanged branch both pass, the latter with 0 allowed changes. Prettier, lint and `pnpm check` pass. One independent diff review.

### E8.3 E8-U1: a second exact candidate direction

**Rule.** At every directed cyclic adjacent pair P, N of the sites in E8.1, and in both reference bodies:

1. **Frozen test.** Apply the frozen test with d₁ = N.Q3 − P.Q0, unchanged. If it passes, the pair passes and nothing else is computed.
2. **Own-progress guard.** For each piece that is not an implicit closure, the actual chord B − A must have a strictly positive exact dot with the piece's own source chord Q3 − Q0. If either piece fails, the pair is UNRESOLVED, as before.
3. **Vector set.** Form the set V for both pieces and drop zero vectors; |V| ≤ 8.
   - A source piece contributes its three control differences Q1 − Q0, Q2 − Q1, Q3 − Q2 and its actual chord B − A.
   - An implicit closure contributes the exact endpoint derivative of line 11 and its actual chord.
4. **Angular extremes.** Write cross(p, q) = p.x·q.y − p.y·q.x, evaluated exactly. Vectors are taken in the order of step 3.
   - a is the first v in V such that, for every u in V, cross(a, u) > 0, or cross(a, u) = 0 and dot(a, u) > 0.
   - b is the first v in V such that, for every u in V, cross(u, b) > 0, or cross(u, b) = 0 and dot(u, b) > 0.
   - If a or b does not exist, the pair is UNRESOLVED.
5. **Candidate d₂.** Let J(x, y) = (−y, x).
   - If cross(a, b) > 0, then d₂ = J(a − b).
   - If cross(a, b) = 0 (every vector points the same way), then d₂ = a.
   - If cross(a, b) < 0, the pair is UNRESOLVED.
6. **Test with d₂.** Apply the frozen test of line 11 with d₂ in place of d₁, unchanged in every other respect: each piece's three source dots are nonnegative with a strictly positive total, and its actual chord dot is strictly positive. If the test passes, the pair passes; otherwise it is UNRESOLVED.

Nothing else changes: nonadjacent pairs, the crossing tests of P3.1g and P3.2s, the triangle-free scan of P3.1i and P3.2x, publication and all counters. A pair that reaches step 2 still counts as inspected exactly once.

**Soundness.** The proof on line 13 uses only one property of d: it is fixed for the pair.

- With nonnegative derivative coefficients and a positive sum, each source piece is strictly increasing in projection onto that d, and so is every H_s.
- So the previous piece lies strictly before the shared moving knot and the next piece strictly after it.
- d₂ is a fixed exact point, computed from the pair's own data before the test, so the proof applies to d₂ unchanged.

The guard of step 2 is not needed for soundness. It keeps the intent of the frozen reversal control (line 46): an actual chord that runs against its own source piece stays UNRESOLVED and is not normalized away by a different direction.

**Completeness note (not a requirement).**

E8-U1 accepts every pair whose V lies in an open half-plane and whose pieces pass the guard of step 2.

- If V lies in an open half-plane, steps 4 and 5 find a and b with cross(a, b) ≥ 0, and every u in V is a nonnegative combination of a and b.
- dot(d₂, a) = dot(d₂, b) = cross(a, b) > 0 (or d₂ = a when all vectors point one way), so d₂ has a strictly positive dot with every vector of V, and step 6 passes.
- A pair whose V does not lie in an open half-plane is UNRESOLVED. That case includes the tangential reversal M1′.

**Clause change.** For E8-U1, two clauses change: the clause on line 11 ("choose the sole candidate d = N.Q3 − P.Q0 … No floating epsilon or adaptive direction search is allowed"), and the matching "no … direction search" of [P3.2n](p3-native-rounded-topology-contract.md) line 17. Both now read: "choose d₁ = N.Q3 − P.Q0, then, only if d₁ fails, the one further exact candidate d₂ of the E8 addendum. No floating epsilon, iteration, subdivision or retry is allowed." d₂ is a single closed-form candidate, not a search.

The work-bound clause of P3.2n line 17, "adjacent pairs require at most eight dots", changes with it. For E8-U1 it reads: "adjacent pairs require at most eight dots for d₁; only if d₁ fails, at most 2 guard dots, 128 cross signs, 128 dots and the 8 dots and 2 totals of the d₂ test more." The nonadjacent bounds of line 17 and the pair ceiling are unchanged.

**Work and width.**

- **Work per adjacent pair** is fixed: at most 2 guard dots, 2 × 8 × 8 = 128 cross signs and as many dots for the extremes, and the 8 dots and 2 totals of step 6. Nothing is allocated.
- **Coordinates** are grid integers below 2^2158 (B0R section 3.3, grid 2^−(1074+60)).
- **Differences:** control differences and chords are below 2^2159, and d₂ = J(a − b) is below 2^2160. Both fit in the 34 × 64 = 2,176-bit `ExactCoordinate`.
- **Products:** every dot and cross product is below 2^4321, which fits in the 68 × 64 = 4,352-bit `ExactProduct`.
- **Test:** E8-U1 adds a unit test at the largest admitted magnitudes that exercises these widths.

**Determinism across native and wasm.**

- Every decision of the rule is an exact sign of an integer computed in `Signed<N>` with `u64` limbs.
- The binary64 filters of B0R U1 (F2.1-F2.3) decide a sign first only when their enclosure is sound; otherwise they fall back to the exact routine. They never change an outcome.
- The rule uses no transcendental function, no square root, no floating-point direction and no platform-dependent operation.
- The same Rust source is compiled for the native tests and for `wasm32`, and Rust does not contract floating-point operations. A path therefore gets the same certificate, the same mesh bytes and the same status on both targets.
- E8-K8 checks this on the E8 corpus.

**Byte identity of previously-ok outputs.** The argument has three steps.

1. **Fast rung.** The fast rung is not changed, so every fast-rung outcome, including its fallback reason, is unchanged.
2. **One certification call.** Inside one call, E8-U1 changes only the result of an adjacent-pair check that used to return UNRESOLVED, and an UNRESOLVED pair ended the call. So any call that used to succeed takes the same branches and publishes the same certificate.
3. **Exact cascade.** The cascade runs step 2 (triangle-free) only after step 1 (`attempt`) returns KnotMismatch or UNRESOLVED.
   - A path whose output came from step 2 passed every adjacent check there with d₁.
   - The step-1 rounded helper ([P3.2o](p3-rounded-topology-adoption-contract.md), which runs after an exact KnotMismatch) builds the same leaves from the same `prepare_suffix`. It checks the same adjacent pairs, in the same B0R candidate set, with the same d₁. So those checks passed in step 1 as well.
   - E8-U1 therefore cannot change step 1's outcome, and step 2 runs and publishes as before.

Hence every request whose result was `ok` keeps the same mesh bytes, and every change is failure-to-success or failure-to-failure. By the [V2 operation identity rule](p3-v2-fill-mesh-transport-contract.md) (lines 36 and 491), the operation stays `'geometry-wasm/fill-v0+r2'` and `fill_v0_revision()` stays 2. The release WASM hash does change, because the code changes.

**Prototype observation (scratch, not evidence).**

- A scratch prototype of E8.3, built on `main` e6eb90f outside the repository, ran `cargo test --release --lib` in `packages/geometry-wasm/kernel`: 464 passed and 4 failed.
- All 4 failures were controls whose expected failure became a success (E8-C5).
- No assertion on an `ok` mesh, on the AL-OB5 admission summary or on the ladder identity failed.
- On the investigation's families it gave the same counts as a binary64-hint prototype.
- The unit repeats this run on its branch as evidence.

### E8.4 E8-U2: a canonical source-final knot in the exact rung

**Rule (revised in review round 1, B1).** The snap runs in the exact rung only, inside `run_prefix`, on the `commands` list after `emit` and **before** `collect_contours` and `validate_leaf_partitions` (`cubic_fill.rs:480-515`).

- **Flag.** `attempt_body` calls `run_prefix` with a new private flag `canonical_final_knots = true`. `prepare_prefix` (the fast rung's S1 view, Alt-A1) calls it with `false` and is otherwise untouched. Every other caller passes `false`.
- **What changes.** For every cubic source, the point of its final flattened leaf command (the leaf with `end_numerator == 2^depth`) is replaced by the source's represented canonical p3. The pass changes no count, order or provenance.
- **Why before collection.** `collect_contours` decides closure on the command points: it drops a returning duplicate when the last point equals the contour's first point, and otherwise pushes a closing owner (`finish_closed_contour` and `finish_open_contour`, `cubic_fill.rs:1019-1062`). It also rejects a zero-length leaf (`:977`). A snap after collection would leave the unsnapped closure decision in place. For E8-F5 that gives a duplicate final point plus a zero-length closing owner, which `validate_topology_ownership` (`:872-875`) rejects as `TopologyOwnership`. That error maps to `Mapped::Internal`, a batch internal error. Snapping first lets collection, the closure rule, the zero-length rule and `validate_leaf_partitions` all see the canonical points, so the command list, the `TopologyInput` and the collected contour agree by construction.
- **Zero-length final leaf.** If the final leaf command's point equals the previous emitted point before the snap, the snap is skipped for that leaf, so collection rejects it with `ZeroLengthLeaf` exactly as today (fixture E8-C6). If the snap itself makes the final leaf zero-length, collection rejects it with `ZeroLengthLeaf`, which maps to `unsupported-geometry`. That is a failure-to-failure change on a path that failed with KNOT_MISMATCH before. Neither case may reach `Mapped::Internal`.
- **Not touched.** LINE sources, internal knots and CLOSE commands.
- **Fast rung.** The fast rung's prefix runs with the flag off. The exact rung re-runs the prefix inside `attempt`, so the snap applies only to that run.

**Executability.** With the snap before collection, E8-F5 becomes executable: its exact-rung run reaches topology with canonical final knots instead of failing at `preflight_source_final`, and no ownership error can arise from the snap. The investigation's E8-U2 numbers came from a prototype that snapped in the flattener (`emit_leaf`), which applies in every rung. The exact-rung-only rule written here has not been prototyped. Its numbers are measured for the first time in E8-U2 (E8-K6).

**No-op on every previously-ok exact-rung path.**

- Every exact-rung certificate that can succeed checks source-final equality before any geometry:
  - P3.1e through `preflight_knots`, which requires every knot, including the final one, to be exact;
  - P3.1f, P3.2n, P3.2s and P3.2x through `preflight_source_final` (step 2, line 24).
- So an exact-rung path that returned `ok` already had every final actual endpoint equal to p3, and the snap writes the value that is already there.
- An all-LINE path never reaches the snap.
- Only paths that failed with KNOT_MISMATCH at a source-final knot change. No `ok` mesh changes, and no revision bump is needed (V2 lines 36 and 491).

**Proof note.**

- **The restriction.** The restriction cited is P3.1f's own: every source cubic's final actual endpoint must equal its represented canonical endpoint exactly (line 7). The [P3.1f review](../evidence/p3.1f-rounded-knot-topology-review-2026-10-02.md), line 13, gives the reason: allowing rounded source endpoints would invalidate the per-source P3.1d boundary proof.
- **What E8-U2 does.** It does not relax that restriction; it establishes it by construction. The guard of step 2 then passes, carried boundary starts equal canonical starts (line 9), and the P3.1d per-source verification stays applicable.
- **Zero error at the knot.** p3 lies exactly on the curve, since C(1) = Q3 = p3, so the snapped endpoint has zero positional error.
- **Open obligation E8-P1.**
  - The flattener certified the final chord [previous actual point, q′] within 2^e, including its guard term.
  - The chord [previous actual point, p3] differs from it by |q′ − p3|, which is at most the rounding of one subtraction and one addition.
  - E8-U2 must show that the guard term of `Cubic::guard` in `geometry.rs` covers that difference, or else that the tolerance relation of V2 section d still holds with the snapped chord.
  - **Sketch.** With r = fl(p3 − o) and q′ = fl(o + r), each coordinate has |q′ − p3| ≤ u·|p3 − o| + u·|q′| with u = 2^−53, so |q′ − p3| is at most about 2ε·max|·|, where ε = 2^−52 and max|·| is the larger of the original and relative magnitudes. The guard at `geometry.rs:369-372` is 128ε·(max_abs_original + (depth + 1)·max_abs_relative), at least 64 times larger.
  - E8-U2 does not merge until E8-P1 is discharged by a written proof and a test at the largest admitted magnitudes (E8-K11).

### E8.5 E8-U3: tangential reversal stays unsupported

M1′ is a knot at which a source piece's end tangent is collinear with the next segment and points the opposite way. It stays UNRESOLVED in every rung and maps to `unsupported-geometry`. It is recorded as a documented known unsupported case.

A certificate for it is deferred and needs its own contract. That certificate (F4) would show that P, minus the knot, lies strictly on one side of N's supporting line, using the Bernstein coefficients after factoring out (1−t)^m.

The V-2 fixture `p3sc` (`M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50 L 200 50 L 0 50 Z`) stays not drawn, with the notice `v2-path fill unsupported-geometry`. Its gated outcome in `tests/gpu/viz-v2-path-data.spec.ts` stays unchanged.

### E8.6 Fixtures and controls

These fixtures are fixed before code. Paths are written as SVG path data, as the V-2 page parses it: Q and T are raised to cubics in binary64 as `(p + 2q)/3` and `(e + 2q)/3`. The fill rule is NONZERO unless stated. In E8-F4 and E8-C2, each coordinate is the binary64 sum c + 0.1 of the integer c shown in the source path.

| ID    | Path                                                                                                                                                                                                           | e         | After E8-U1 alone                                                                      | After E8-U1 + E8-U2                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| E8-F1 | `M 0 0 L 0 -100 Q 100 -200 200 -100 T 400 -100 L 400 0 Z` (V-2 `p3qc`)                                                                                                                                         | −5..0     | `ok` on the exact rung; −8..−6 unchanged (`work-limit`)                                | the same (integer endpoints, so the snap is a no-op)                |
| E8-F2 | `M 0 -100 Q 100 -200 200 -100 Z`                                                                                                                                                                               | −7, −3, 0 | `ok`                                                                                   | the same (snap is a no-op)                                          |
| E8-F3 | Half disc `M 100 0 C 100 k k 100 0 100 C -k 100 -100 k -100 0 Z` with k = 55.22847498                                                                                                                          | −3, 0     | `ok`                                                                                   | the same (snap is a no-op)                                          |
| E8-F4 | `M 0 0 C 20 -100 80 -100 100 -40 C 120 20 180 20 200 -40 L 200 50 L 0 50 Z`, each coordinate + 0.1                                                                                                             | −3, 0     | `ok` (needs E8-U1 only)                                                                | `ok`, expected; not prototyped with the exact-rung snap             |
| E8-F5 | `M -2.9 33.4 C -2.9 31.4 17.1 23.6 17.1 33.4 C 17.1 47.7 -2.9 37.7 -2.9 33.4 Z`                                                                                                                                | 0         | `unsupported-geometry`, unchanged (KNOT_MISMATCH at `preflight_source_final`)          | `ok` (needs E8-U2); never `internal-error`                          |
| E8-F6 | `M 0 0 L 0 -90 Q 90 -180 180 -90 T 360 -90 L 360 0 Z` (V-2 `p3q` variant)                                                                                                                                      | −6..0     | unchanged: `ok`, same mesh bytes                                                       | unchanged: `ok`, same mesh bytes                                    |
| E8-C1 | `M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50 L 200 50 L 0 50 Z` (V-2 `p3sc`, M1′)                                                                                                                          | −6..0     | unchanged: `unsupported-geometry`                                                      | unchanged: `unsupported-geometry`                                   |
| E8-C2 | E8-C1 with each coordinate + 0.1                                                                                                                                                                               | −3, 0     | `unsupported-geometry` (M1′)                                                           | `unsupported-geometry` (M1′)                                        |
| E8-C3 | Native counterparts of the frozen collapse and reversal controls (line 46)                                                                                                                                     | as frozen | UNRESOLVED at a directed adjacent projection                                           | the same                                                            |
| E8-C4 | Every frozen control of this contract and of P3.1g, P3.1i, P3.2n, P3.2s, P3.2v and P3.2x                                                                                                                       | as frozen | unchanged, except the four controls of E8-C5                                           | the same                                                            |
| E8-C5 | The four native controls that become `ok` under E8-U1 in the prototype (list below)                                                                                                                            | as frozen | replaced per control (E8-Q3, decided per control); each old path is kept as a positive | the same                                                            |
| E8-C6 | A cubic source whose final flattened leaf has the same point as the previous emitted point (zero-length final leaf); the unit builds the input, or a `cfg(test)` command-list injection if no input reaches it | as built  | `unsupported-geometry` (`ZeroLengthLeaf`), as today                                    | the same: the snap is skipped for that leaf; never `internal-error` |

The E8-C5 controls and their replacements (E8-Q3, decided per control). A control that needs step 2 (triangle-free) to succeed gets a **crossing replacement**. Every other control gets an **M1′ replacement**.

- **Crossing replacement:** a path with one transverse non-adjacent crossing and non-exact internal knots. The exact helper returns KnotMismatch, the rounded helper rejects the crossing (non-adjacent hull intersection), so the step-1 result stays KnotMismatch (P3.2o), and triangle-free certifies the crossing. The starting candidate is the native `transverse_bowtie` with one interior control offset by 2^−54, as `rounded_failure` does. Before the replaced test runs, the unit checks that this candidate meets all of the above and records it; if it does not, the unit picks another crossing path that does.
- **M1′ replacement:** E8-C1, or E8-C2 where non-exact internal knots are needed. Both fail in every rung under E8-U1.

| Control                                                                                                                                | Its intent                                                           | Replacement                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `fill_export_tests::mapping_row_fixtures_reach_their_kernel_values`, row "Topology(Unresolved) in both cascade steps" (`cubic_bowtie`) | UNRESOLVED in both steps maps to `unsupported-geometry`              | M1′: E8-C1                                                       |
| `fill_export_tests::cascade_retries_triangle_free_only_after_knot_or_unresolved` (`rounded_failure`)                                   | step-1 KnotMismatch is retried and the step-2 result is reported     | crossing replacement (step 2 succeeds)                           |
| `native_cubic_fill_tests::rounded_topology_failure_preserves_exact_knot_mismatch_and_recovers`                                         | a rounded-helper failure keeps the exact KnotMismatch, then recovers | M1′ with non-exact internal knots: E8-C2                         |
| `fill_export_ladder_tests::al_u3_defect_14_cascade_inverted_is_detected` (the step of AL-F6)                                           | an inverted cascade is detected on a step-2 success                  | crossing replacement; AL-F6 gets a dated E8 note in its contract |

**The E8 corpus, `e8-corner/v1`.** It is produced by a frozen generator, an E8-U1 deliverable, and is frozen by its SHA-256 before the units run on it. It contains:

- **Lens families** from the investigation.
  - Knots P0 = (−100, 0) and P1 = (100, 0).
  - Upper controls x-ordered in (−100, 100), with y in [−150, −5].
  - Lower controls in reverse x order, with y in [5, 150].
  - A tangent variant with vertical tangents at both knots.
  - A random integer offset in [−500, 500]², then a scale of 1, 1/10 or 1/3.
- **The wave family** `M 0 0 L 0 -H Q W/4 -(H+A) W/2 -H T W -H L W 0 Z`, with integer W in 4·[25, 100], H in [20, 200] and A in [−150, 150].
- **Size and generator.** 200 paths per family, each at e = −3 and e = 0. The paths come from a seeded 64-bit LCG whose constants and seeds are written in the generator.

### E8.7 Seeded defects

Each defect must be detected by the named check before the unit merges.

| ID     | Defect                                                                                                     | Detected by                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E8-D1  | Guard of step 2 removed                                                                                    | E8-C3: the reversal control certifies                                                                                                                                                                        |
| E8-D2  | d₂ = J(b − a) (sign flipped)                                                                               | E8-F1 to E8-F4 stay unsupported                                                                                                                                                                              |
| E8-D3  | Equal-direction rule of step 4 uses ≥ (accepts opposite vectors)                                           | E8-C1, E8-C2 or a literal antiparallel pair certifies                                                                                                                                                        |
| E8-D4  | Hint applied in a `check_pair` but not in its `reference_pair_body`                                        | The B0R O3 reference-loop equality tests                                                                                                                                                                     |
| E8-D5  | Hint applied in FR4 (the fast rung)                                                                        | AL-I3 spike identity and `pnpm test:p3-fill-identity`                                                                                                                                                        |
| E8-D6  | `run_prefix` flag set to true from `prepare_prefix`, so the snap reaches the fast rung                     | `pnpm test:p3-fill-identity --failure-to-success`: fast-rung `ok` meshes with an inexact final knot are expected to change and must classify as FAIL (56 of 200 lens tangent /10 paths at e = −3 have one)   |
| E8-D7  | Snap applied only to the `TopologyInput` leaves in `certify_topology`, not to `commands` before collection | Ownership validation (`validate_topology_ownership`, `TopologyOwnership`) on E8-F5: the certificate points differ from the collected contour                                                                 |
| E8-D8  | Snap applied to internal knots                                                                             | The P3.1e and P3.2n controls with rounded internal knots (E8-C4)                                                                                                                                             |
| E8-D9  | Snap after collection (the pre-review design): `commands` snapped after `collect_contours`                 | E8-F5 ends with a duplicate final point plus a zero-length closing owner; the ownership check (`cubic_fill.rs:872-875`) must reject it as `TopologyOwnership`, and the E8-F5 test, which expects `ok`, fails |
| E8-D10 | Snap applied even when the final leaf is already zero-length                                               | E8-C6 changes from `ZeroLengthLeaf`                                                                                                                                                                          |

### E8.8 Acceptance

| ID     | Required evidence                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E8-K1  | Independent review of this addendum before code. The decisions on E8-Q1 to E8-Q6 are recorded in E8.11 (decided 2026-10-23 under the standing instruction)                                                                                                                                                                                                                            |
| E8-K2  | E8-F1 to E8-F5 reach their expected status through the export (a `FillEngine` batch) and pass the self-check of `build_path` and the mesh invariants; E8-F6 is unchanged                                                                                                                                                                                                              |
| E8-K3  | Byte identity, run after E8-U0 has merged. `pnpm test:p3-fill-identity --failure-to-success` reports 0 FAIL: no changed `ok` record, and every allowed change was a failure on the merge base. `pnpm test:p2-identity` passes (P2 output unchanged). The AL-OB5 native admission test still matches its committed status, rung and count summary. The AL-U2 ladder dump oracles agree |
| E8-K4  | E8-C1 to E8-C4 hold; the E8-C5 replacements fail in the same rung and step, and the old paths pass as positives                                                                                                                                                                                                                                                                       |
| E8-K5  | E8-D1 to E8-D10 are each detected, and the detecting command is recorded                                                                                                                                                                                                                                                                                                              |
| E8-K6  | On `e8-corner/v1`, after both units: 0 `unsupported-geometry` in every lens family at both values of e; in the wave family only paths that fail a non-adjacent crossing check remain. The per-family counts are recorded in the plan                                                                                                                                                  |
| E8-K7  | Headed V-2: `p3qc` draws in Chrome and Edge at DPR 1 and 2, so its gated outcome changes (E8-Q4); `p3sc` stays `v2-path fill unsupported-geometry`                                                                                                                                                                                                                                    |
| E8-K8  | Native and release-WASM results on `e8-corner/v1` agree in status and mesh bytes                                                                                                                                                                                                                                                                                                      |
| E8-K9  | No threshold, cap, A04 target or kernel revision changes; `fill_v0_revision()` stays 2                                                                                                                                                                                                                                                                                                |
| E8-K10 | E8-U1: an independently written TypeScript mirror of E8.3 in the test-only oracles of P3.1f, P3.1g and P3.1i (E8-Q2 (b)), implemented from this text and not from the native code; the native-versus-oracle tests under `tests/geometry/native-*` agree on every existing corpus and on E8-F1 to E8-F4 and E8-C1 to E8-C3                                                             |
| E8-K11 | E8-U2 does not merge until E8-P1 is discharged: a written proof that the snapped final chord keeps the flattening tolerance relation, and a native test at the largest admitted magnitudes that checks the bound                                                                                                                                                                      |
| E8-K12 | E8-U0 has merged, with its self-test reviewed, before E8-U1 runs E8-K3                                                                                                                                                                                                                                                                                                                |

### E8.9 Validation commands

Run these on each unit's branch while its changes are still uncommitted, with `CARGO_HOME` and `RUSTUP_HOME` under `.tools/rust`:

- `cargo test --release --lib` in `packages/geometry-wasm/kernel`: all native tests, the E8 fixtures and the seeded defects;
- `pnpm test:geometry`: the native tests and the TypeScript geometry tests, including the native-versus-oracle tests under `tests/geometry/native-*`;
- `pnpm test:p3-fill-identity --failure-to-success --allow-test-change <path>`, once for each E8-C5 file and each new test file (the mode of E8-U0);
- `pnpm test:p2-identity`;
- the new E8 corpus test, for E8-K6 and E8-K8;
- `pnpm check` and `pnpm build`;
- the headed V-2 spec `tests/gpu/viz-v2-path-data.spec.ts` under its Playwright config, for E8-K7;
- on changed Markdown: prettier with the explicit config, the link and anchor check, and `git diff --check`.

### E8.10 Risks

- **Controls that flip.** Four native controls become `ok` (E8-C5) and are replaced per control. The TypeScript mirror (E8-K10) must flip the oracles' expectations on the same inputs; any other native-versus-oracle difference is a defect. Each replacement control must keep what the original tests.
- **Identity tool.** Plain `pnpm test:p3-fill-identity` treats any status change as a failure, so E8-U0 adds the `--failure-to-success` mode first (E8.2a). A defect in that mode could hide a changed `ok` mesh; its tamper self-test and review guard against that.
- **Cost.** Paths that were unsupported now run the exact rung to success. The exact rung is slower than the fast rung, and no performance gate covers this. FR4 is unchanged, so no fast-rung path slows down.
- **E8-P1.** The flatness bound with the snapped final chord is an open proof obligation; E8-K11 blocks E8-U2 until it is discharged. The exact-rung-only snap has not been prototyped (E8.4).
- **Coverage.** The prevalence numbers come from synthetic families, not from a real icon corpus. M1′ and non-adjacent crossings stay unsupported.
- **Cross-track.** The gated outcome of `p3qc` lives in a visualization-track spec.

### E8.11 Open questions and decisions

All six were decided on 2026-10-23 under the user's standing instruction, after review round 1 of PR #210. The options are kept for the record. Q2 was decided (b), against the draft's recommendation of (a), because the review showed that keeping the oracles on d₁ would hollow out the native-versus-oracle differential.

- **E8-Q1, scope of E8-U1. Decided (a).**
  - (a) Exact rung only, as written; FR4 unchanged.
  - (b) Also FR4: this moves paths to the fast rung, changes `ok` meshes, and needs revision 3 and new AL-I3 oracles.
- **E8-Q2, the test-only oracles. Decided (b).**
  - (a) Keep the oracles on d₁ only and record the differences as expected.
  - (b) An independently written TypeScript mirror of E8.3 in the oracles of P3.1f, P3.1g and P3.1i, so the native-versus-oracle differential stays meaningful (E8-K10).
- **E8-Q3, replacements for the E8-C5 controls. Decided per control.**
  - The crossing replacement goes to controls that need a step-2 success.
  - The M1′ replacement goes to the others (table in E8.6).
  - The rejected options were all-M1′ and removal.
- **E8-Q4, the V-2 `p3qc` expectation. Decided (a).**
  - (a) The E8-U1 PR changes the gated outcome of `p3qc` in `tests/gpu/viz-v2-path-data.spec.ts` to drawn, with a visualization-track review.
  - (b) A follow-up visualization-track PR.
- **E8-Q5, unit order. Decided (a), extended by review round 1.**
  - Separate PRs in the order E8-U0 (tooling, light tier), then E8-U1, then E8-U2.
  - The rejected option was one PR for both kernel units.
- **E8-Q6, where M1′ is recorded. Decided (a).**
  - (a) In this addendum and in the rendering-track plan only, as a known unsupported case of the fill kernel.
  - (b) Also as a known limitation in `docs/requirements.md`.

### E8.12 Review round 1, 2026-10-23

Independent review of PR #210 returned NOT READY on one blocking item. It found E8-U1 sound and its byte-identity argument correct. The Primary applied every item under the standing instruction:

| Item | Finding                                                                                                                                                                                                                                                                    | Disposition                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | Snapping after collection breaks the closure rule: `collect_contours` decides closure on unsnapped points (`cubic_fill.rs:1019-1062`), so E8-F5 ends with a duplicate point and a zero-length closing owner, `TopologyOwnership` (`:872-875`), mapped to an internal error | E8.4 rule revised: the snap is applied to `commands` before `collect_contours` and `validate_leaf_partitions`, through a `run_prefix` flag set only by `attempt_body`; `prepare_prefix` untouched. E8-C6 (zero-length final leaf) added; E8-D7 revised; E8-D9 (snap after collection) and E8-D10 added; E8-F5 is now executable; the E8-U2 prototype is stated to have snapped in the flattener |
| S1   | E8-P1 must block E8-U2                                                                                                                                                                                                                                                     | E8-K11 added, with the error sketch in E8.4                                                                                                                                                                                                                                                                                                                                                     |
| S2   | E8-K3 cannot run in plain mode                                                                                                                                                                                                                                             | E8-U0 (E8.2a) added as a prerequisite light-tier unit; E8-K3, E8-K12 and E8.9 use `--failure-to-success`                                                                                                                                                                                                                                                                                        |
| S3   | P3.2n line 17's work bound ("at most eight dots") must change too                                                                                                                                                                                                          | Amended in E8.3, beside the "no direction search" clause                                                                                                                                                                                                                                                                                                                                        |
| S4   | E8-Q2 should be (b)                                                                                                                                                                                                                                                        | Decided (b); E8-K10 added                                                                                                                                                                                                                                                                                                                                                                       |
| S5   | E8-Q3 should be decided per control                                                                                                                                                                                                                                        | E8.6 lists each control with its intent and replacement                                                                                                                                                                                                                                                                                                                                         |
| S6   | Each fixture needs its result after E8-U1 alone and after both units                                                                                                                                                                                                       | E8.6 has two result columns                                                                                                                                                                                                                                                                                                                                                                     |
| S7   | The completeness note should state the acceptance                                                                                                                                                                                                                          | Reworded: "E8-U1 accepts every pair whose V lies in an open half-plane" (and that passes the guard)                                                                                                                                                                                                                                                                                             |

**Round 2, 2026-10-23.** The verdict was READY WITH FOLLOW-UPS. The Primary applied the follow-ups under the standing instruction and approved the addendum:

- **F1.** E8-U0 defines "identical" as equality of the whole record tuple (`digest`, `allocations`, `code`, `crossings`). That tuple covers status, counts, statistics, diagnostics and bytes. FAIL means that a base-`ok` record differs in any field.
- **F2.** A tamper case is added: a base-`ok` record whose digest changes only in diagnostics or statistics, with identical mesh bytes. It must FAIL.
- **F3.** A base path failure that becomes an internal error or a batch failure is a new class, internal-regression, and counts as FAIL.
- **F4.** The defect table of E8.7 is in the order D1 to D10.
