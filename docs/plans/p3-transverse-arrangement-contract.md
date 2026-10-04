# P3.1g test-only transverse arrangement preservation

Status: FROZEN,2026-10-05, after Primary and independent Astra high review of the complete proof/interface/literal corpus before implementation. This follows [P3.2r](p3-transverse-crossing-contract.md). Stable-source review remains required before numerical execution. The [active plan](p3-fill-stroke-meshes.md) owns execution. No native adoption, public API/ABI, dependency, capacity, error allowance or deferred stroke change.

## Claim and limitations

Extend the test-only [rounded-knot homotopy certificate](p3-rounded-knot-topology-contract.md) to a bounded family of transverse crossings. Keep its globally carried source/actual continuity, exact source-final endpoints, complete dyadic partitions and cyclic common-direction projection. Inspect every unordered leaf pair, including cross-contour pairs. Nonadjacent pairs must have disjoint closed expanded hulls or satisfy the [P3.2r pair proof](p3-transverse-crossing-contract.md). Each leaf may have at most one transverse partner across the entire invocation.

The pair proof gives a unique interior crossing with continuous parameters and constant ordered derivative sign throughout H(s,u)=(1-s)C(u)+sL(u). Endpoint separation prevents a crossing escaping through a join. The single-partner condition prevents crossing-order exchanges or triple-event collisions; every leaf is individually injective by its adjacent common projections. After inserting the crossing vertices, the contours form a continuous family of embedded oriented plane graphs with preserved rotation order. Ambient isotopy preserves corresponding face winding and both fill rules. This is topology under spatial transport, not equality of membership at fixed coordinates.

Source-boundary rounding retains the inherited KNOT_MISMATCH at0/0. Tangencies, coincidence and multiple crossing partners remain conservatively UNRESOLVED when the sufficient conditions fail. This is not a product rejection envelope. At64 leaves, the matching restriction permits at most32 crossings; it cannot establish ordinary full-workload readiness. Position error remains the separate P3.1d obligation; mesh/coverage correspondence, general event order, native adoption and larger capacities remain later work.

Implicit closure is a genuine fixed line from the final actual/source endpoint to initial MOVE, omitted on exact equality as before. Its derivative generator is the actual endpoint difference D, not synthetic cubic controls. For cubic/cubic pairs use all16 crosses between true generator sets {3*d0,3*d1,3*d2,chord}; for cubic/closure all8; for closure/closure all4 using {D,chord}. Omitting positive factors3 preserves signs only; the convex-hull derivative argument always uses true scaled generators. Keep duplicate constant-line generators. Expanded closure hull and its two endpoint sweeps are the true segment and endpoint singletons. This needs no fabricated source identity.

## Test-only interface and ownership

Add `certifyTransverseCubicArrangement(contours, limits?)` beside the existing functions in `tests/geometry/simple-cubic-topology/oracle.ts`. Reuse `CubicTopologySegment`, `SimpleCubicTopologyLimits` and `SimpleCubicTopologyStatus`. Add test-only types:

```ts
type TransverseArrangementCrossing = Readonly<{
  leftLeaf: number;
  rightLeaf: number;
  orientation: -1 | 1;
}>;
type TransverseArrangementCertificate = Readonly<{
  polygons: readonly (readonly Point[])[];
  crossings: readonly TransverseArrangementCrossing[];
}>;
type TransverseArrangementResult = Readonly<{
  ok: boolean;
  status: SimpleCubicTopologyStatus;
  leaves: number;
  pairs: number;
  finding: string | null;
  certificate: TransverseArrangementCertificate | null;
}>;
```

Leaf indices refer to the complete append order, including implicit closure, with leftLeaf<rightLeaf. Crossings appear in pair-inspection order. Publish fresh ordinary polygon points from actual carried starts and fresh crossing records only after all checks. Do not publish per-contour signed-area orientations, nesting matrices, face labels, intersection positions or meshes. In particular, a zero signed-area self-intersecting contour is valid. Do not call the old simple-contour publication routine.

Share the existing rounded source-final guard, bounded leaf construction and minimum-leaf checks through one pure preparation helper, retaining every old status/finding/counter/precedence and old result shape. Reuse exact restriction/hull/segment predicates and `RoundedLeaf.sourceDifferences` (three cubic differences or one true closure direction). Do not duplicate parsers or build a generic geometry framework. Native files and P3.2r fixture generator remain unchanged. No production package import/export is added.

Primary owns contract, shared decisions, evidence and integration. One GPT-5.6 Sol high owns only the coupled oracle/preparation extraction. A separate GPT-5.6 Sol medium owns only new `tests/geometry/transverse-arrangement/fixtures.ts` and `tests/unit/geometry-transverse-arrangement.test.ts`. Freeze their shared interface before dispatch: fixture module exports `fixedTransverseArrangementFixtures()` for the12 new positives and `transverseArrangementControls()` for the5 new rejections; each record contains id, contours, expected leaves/pairs, and either literal polygons/crossings or status/findingIncludes. Existing rounded fixtures are reused directly in tests. Workers perform no numeric execution before stable-source review. Independent Astra high proof/source review and Primary review are required; no recursive delegation.

## Bounds, precedence and pair algorithm

Keep inclusive defaults/ceilings4 contours,16 source cubics,64 total leaves including closure,2016 pairs and provenance depth20. Preserve the existing P3.1f order exactly through preparation:

1. Limits, global shape/counts, finite coordinates, unique u32 ordinals, source connectivity and complete dyadic provenance. Declared excess counts win before reading excess contents.
2. Every source-final actual endpoint equals its exact canonical endpoint. Any mismatch returns KNOT_MISMATCH at0/0, after all earlier global validation.
3. Build source leaves and closures in input order, charging before append and before projections. Fewer than three leaves in a contour returns UNRESOLVED after full construction, with zero pairs.
4. Enumerate i<j in append order. Charge before inspecting; an attempted over-limit pair returns WORK_LIMIT with no new inspection. Cyclic adjacent pairs use exactly the existing directed common-projection test, including last-to-first. Failures retain its finding and count the inspected pair.
5. For every nonadjacent pair, closed expanded-hull disjointness passes directly. Otherwise require proper actual-chord crossing, common strict nonzero cross sign for all true generator combinations, then all four closed endpoint sweeps disjoint from the opposing expanded hull, in that order. Use exact hull checks; singleton sweeps must work. Failure is UNRESOLVED with finding containing `nonadjacent` and `i,j`, full leaves and inspected pair count.
6. After a pair passes the transverse proof, check partner slots for both leaves. If either already has a partner, return UNRESOLVED with finding containing `multiple transverse partners` and `i,j`; check the left slot before the right. No partial certificate escapes. Otherwise store both slots and append the pair/sign. Bound records by floor(leaves/2).
7. After complete coverage, publish fresh polygons/crossings with CERTIFIED and null finding. No signed-area or container-winding gate. Repeated success/failure/limit attempts are stateless and deterministic; callers and earlier certificates remain independent.

## Frozen positive candidates

For any straight edge A->B below, use cubic controls A,(3A+B)/4,(A+3B)/4,B and one depth0 actual endpoint B. All listed coordinates and quarter constructions are exactly represented. Assign unique source ordinals in contour/source order. Explicit form includes the final cubic back to the first vertex; implicit form omits it and uses the genuine closure line. No flattening run generates these endpoints.

Let B be the cyclic eight-vertex polygon [(-2,-2),(2,2),(2,3),(-2,3),(-2,2),(2,-2),(2,-3),(-2,-3)]. Only leaves0 and4 cross, with ordered sign-1;8 leaves/28 pairs comprise8 adjacent,1 crossing,19 disjoint. The actual signed area is0. Let N use the same polygon, replacing leaf0 interior controls with(-1,-15/16),(1,15/16) and leaf4 controls with(-1,17/16),(1,-17/16). Both curves cross at their midpoints/origin, all16 derivative signs are negative, and other hull pairs remain separated.

The12 new positive IDs and literal crossing records are:

| ID                            | Input                                                                              | Crossings (left,right,sign) |
| ----------------------------- | ---------------------------------------------------------------------------------- | --------------------------- |
| B-explicit                    | B,8 cubics                                                                         | (0,4,-1)                    |
| B-reflect-x                   | Reflect all B source/actual x values                                               | (0,4,+1)                    |
| B-reverse                     | Reverse B source order, controls and actual chain                                  | (3,7,+1)                    |
| N-explicit                    | N,8 cubics                                                                         | (0,4,-1)                    |
| N-reflect-x                   | Reflect all N source/actual x values                                               | (0,4,+1)                    |
| N-reverse                     | Reverse N source order, controls and actual chain                                  | (3,7,+1)                    |
| B-implicit                    | First7 B cubics plus closure                                                       | (0,4,-1)                    |
| N-implicit                    | First7 N cubics plus closure                                                       | (0,4,-1)                    |
| closure-crossing              | Start at B vertex1, follow vertices2..7,0 with7 cubics, then implicit closure      | (3,7,+1)                    |
| closure-crossing-curved       | Same rotated chain; leaf3 controls(-1,17/16),(1,-17/16)                            | (3,7,+1)                    |
| overlapping-squares           | CCW squares[(0,0),(4,0),(4,4),(0,4)] and[(2,-2),(6,-2),(6,2),(2,2)], each explicit | (0,7,-1),(1,6,+1)           |
| overlapping-squares-reflect-x | Reflect every source/actual x in both squares                                      | (0,7,+1),(1,6,-1)           |

All12 have8 leaves/28 inspected pairs; the two square cases have8 adjacent,2 crossing,18 disjoint. Their common rectangle has winding2 under the unreflected orientation, illustrating why simple-contour nesting is insufficient; no face labels or mesh result is inferred. Expected polygons are exactly the listed supplied starts after the declared transform/order, with no closing duplicate point. Reverse begins at the same original start, then traverses reversed segments; it is not arbitrary cyclic reindexing.

Also require all11 existing `fixedRoundedKnotTopologyFixtures()` to certify with empty crossing lists and exactly their old polygons/counters. This includes rounded internal knots, reflection/reversal, four disjoint contours and true implicit closure. Total23 required positives. Existing P3.1e/P3.1f expectations stay unchanged, including old rejections of the crossing candidates. No new positional tolerance claim is made for this arrangement-only checkpoint.

## Frozen rejection candidates and structural controls

Five new controls use the same exact straight-edge recipe unless stated. Every failure returns a null certificate.

- `multiple-partners`: cyclic [(-3,0),(3,0),(3,3),(-1,3),(-1,-1),(1,-1),(1,2),(-3,2)]. Pair(0,3) certifies with sign-1; pair(0,5) has sign+1 but repeats leaf0. UNRESOLVED at8 leaves/5 pairs with the multiple-partner finding.
- `triple-coincidence`: cyclic [(-3,0),(3,0),(3,3),(0,3),(0,-3),(-2,-2),(2,2),(-3,2)]. Leaves0,3,5 meet at the origin; pair(0,3) certifies-1, pair(0,5) certifies+1 before the partner guard rejects at8/5. The later adjacent pair(3,4) also fails its common direction (dot=-1); this fixture asserts the earlier matching failure, not that every other obligation passes.
- `tangent-displaced-knot`: first contour is the clockwise rectangle[(-4,0),(4,0),(4,-4),(-4,-4)]. Second begins with cubic[(-3,3),(-1,-1),(1,-1),(3,3)], two depth1 actual endpoints(0,-1),(3,3), then straight cubics via(3,5),(-3,5),back(-3,3). Exact source y=3(1-2t)^2 is tangent to the first edge; the first restricted source's final generator is horizontal. Pair(0,4) has proper actual chords but fails strict cross signs. UNRESOLVED9/4, nonadjacent finding.
- `coincident-squares`: two copies of the explicit CCW square[(0,0),(4,0),(4,4),(0,4)], unique source ordinals. Pair(0,4) overlaps, UNRESOLVED8/4.
- `contact-squares`: translate only the second copy above by(4,0). Pair(0,4) has collinear endpoint-only contact at(4,0), UNRESOLVED8/4. Shared vertical-edge overlap occurs later and is not the first finding.

Retain all8 `roundedKnotTopologyControls()` and both `roundedKnotMinimumLeafControls()` with their frozen statuses/counters and finding classes. In particular the cyclic-only6/5 control still rejects; expanded-hull contact fails proper interior crossing, and first containment candidates have disjoint actual chords, so transverse fallback must not rescue them. Preserve later malformed/nonfinite/provenance-over-source-end-mismatch precedence. Do not blanket-require every old simple-cubic geometric rejection to remain rejected under the new function: crossing support is the purpose; old functions' expectations stay immutable.

Explicit B limits maxContours1/maxCubics8/maxLeaves8/maxPairs28 pass. maxContours0 is INVALID_LIMITS at0/0; maxCubics7 or maxLeaves7 is WORK_LIMIT at0/0; maxPairs27 is WORK_LIMIT at8/27. The two-square input with maxContours1 is WORK_LIMIT at0/0. B-implicit with maxLeaves7 passes declared source-leaf count then fails closure append at7/0; maxLeaves8/maxPairs28 passes. Retain four-copy rounded inclusive4/12/48/1128 and one-below controls, all invalid limits and malformed/sparse/duplicate ordinal/connectivity/provenance cases from the existing preflight policy.

Deep-freeze inputs and assert exact polygon copies, ordered literal pair/sign records, repeat-call equality, prior-certificate independence after later failure and caller mutation, and no publication on late failures. Compare existing simple/rounded oracles' unchanged output/findings/counters through their full existing unit suites after shared preparation extraction. Directly assert the zero signed area of B/N polygons and their rotated closure variants, and absence of orientation/nesting fields in the new schema. Freeze source before numerical execution; do not fit data or expectations to observed output.

## Acceptance and validation

G01: Primary/independent full proof, interface, pair/closure semantics, literal candidates and counter review; freeze before implementation and stable-source review before execution. G02: all23 positives with literal polygons/crossings, inclusive caps and old-oracle preservation. G03: five new plus10 inherited rejections, malformed/precedence/ownership/repeat/atomic failure controls. G04: focused new/old geometry oracle tests, bounded two-worker `pnpm check`, `pnpm build`, explicit docs/links/diff, Primary/independent evidence review and required protected CI. No local Rust/WASM, browser/GPU, benchmark or full corpus run is needed for this test-only change; required remote CI remains mandatory.
