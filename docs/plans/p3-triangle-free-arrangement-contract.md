# P3.1i triangle-free transverse arrangement oracle

Status: FROZEN after Primary, Astra high and Sol medium proof/literal/interface review on2026-10-05. The [active plan](p3-fill-stroke-meshes.md) owns execution. This test-only checkpoint follows integrated P3.2w and reuses the [G pair/arrangement proof](p3-transverse-arrangement-contract.md) and [H explicit LINE policy](p3-mixed-line-arrangement-oracle-contract.md). No native adoption, public API/ABI, dependency, runtime policy, positional tolerance, capacity increase, GPU/benchmark or deferred stroke change.

## Claim and proof obligations

Replace the new entry's one-partner sufficient condition with a conservative triangle-free graph of certified nonadjacent transverse leaf pairs. Keep all existing global input, continuity, source-final knot, dyadic partition, leaf construction, cyclic adjacency, closed expanded-hull separation and transverse-pair obligations. Existing entry points keep their exact matching semantics and outputs. This extension does not accept arbitrary crossing graphs or redefine product-supported paths.

For each leaf, the inherited common-projection checks give a nonnegative scalar derivative polynomial and a strictly positive projected chord/source endpoint difference. The polynomial is not identically zero, so its integral over every nonempty interior parameter interval is strictly positive. Convex interpolation with the actual chord retains this property throughout H(s,u)=(1-s)C(u)+sL(u). Each leaf is injective. At a directed adjacent join, the two leaves' interior projections lie strictly on opposite sides of the shared moving knot; their only common point is that knot. This argument includes cyclic last/first adjacency and the true affine LINE/closure generators.

Every nonadjacent pair is either homotopy-disjoint by closed expanded-hull separation or has exactly one persistent transverse interior crossing with continuous parameters and fixed ordered sign by the existing pair lemma. Endpoint sweeps prevent crossing escape through any knot. Two crossings on an injective leaf can exchange their parameter order only by equality, creating a point shared by three leaves. If those leaves are pairwise nonadjacent, all three pairs must be crossing graph edges; a triangle-free graph excludes that event. If any two are adjacent, strict opposite-side projection excludes a shared interior point and endpoint separation excludes the shared knot. Thus no crossing births/deaths, endpoint escapes, triple collisions or order exchanges occur.

Insert the crossing vertices along each source contour. The resulting finite oriented plane graph has continuous injective edges and preserved order/rotation throughout the homotopy, so corresponding faces retain their winding and parity, as in G. This is correspondence under spatial transport, not fixed-coordinate membership equality. The returned pair list is a boolean topology certificate; it is NOT sorted event parameters or a traversal API. Any later traversal consumer must separately contract ordering/recomputation. Position error and mesh/coverage correspondence remain separate obligations.

Triangle rejection is conservative: three pairwise crossings at three distinct points are also rejected. Do not claim all triangles produce an actual collision. Exact coincident/tangent/contact or uncertain source-boundary cases retain earlier rejection mechanisms.

## Interface, bounds and deterministic order

Add only test-only `certifyTriangleFreeCubicArrangement(contours, sourceKinds, limits?)` in `tests/geometry/simple-cubic-topology/oracle.ts`, reusing H's complete explicit boolean source-kind validation and existing result/crossing types. A true kind means a genuine canonical LINE under H's exact full-root rule; false means CUBIC. Implicit closure remains a genuine line without a supplied source descriptor. Reuse the existing private pair loop with an explicit matching/triangle-free policy; old callers select matching. No copied oracle, generic graph framework, retained matrix, new limit field or new output field.

Preserve H's full preflight order: limits/global counts/shape/finite/provenance/connectivity; complete kind array structure then all marked shapes; all source-final knots; append all leaves/closures with charge-before-append; minimum contour leaves; pair enumeration i<j with charge-before-inspect. Defaults/ceilings remain4 contours,16 source descriptors,64 leaves,2016 pairs and provenance depth20.

After an overlapping nonadjacent pair passes the unchanged transverse proof, the new mode checks whether prior crossing records already contain both(i,k) and(j,k) for any k. Scan the existing bounded list without a graph allocation; the precise witness identity need not be published. If so return UNRESOLVED with finding containing `triangle` and `i,j`, full leaf and charged-pair counts, and null certificate. This graph check precedes the crossing-publication check. Otherwise, if32 crossing records already exist, return WORK_LIMIT with finding containing `32` and `crossings`, charged-pair counts and null certificate; never append the33rd record. Otherwise append(i,j,sign). Successful new results have at most32 records, preserving the existing native publication storage envelope without claiming native implementation here. Old matching callers retain their left-partner-before-right-partner checks and findings exactly.

After complete pair coverage publish independent polygon/crossing copies with the existing schema. Every failure is atomic; repeated calls, earlier results and caller mutations remain isolated. Graph work is explicitly bounded by the32-record list; pair counters still count inspected geometric leaf pairs, not graph comparisons.

## Frozen geometry candidates

Unless marked LINE or specifically nonlinear, an edge A->B is supplied as cubic[A,(3A+B)/4,(A+3B)/4,B] with a single depth0/end1 actual leaf at B. The controls are exact dyadic, collinear and monotone: the source and its homotopy have the same geometric segment. This is a set-equivalence topology fixture, NOT a matched-parameter positional claim or P3.1d acceptance. Marked edges use[A,A,B,B] and true. Assign unique source ordinals from1 in flat source order; keep supplied source counts distinct from appended closure leaves. All polygons below are exact expected output in their listed order, without a repeated terminal vertex.

### Multiple-partner family

A=[(-3,0),(3,0),(0,-10)] and B=[(-1,-1),(1,-1),(1,1),(-1,1)]. Explicit form supplies every returning edge, with A leaves0..2 and B3..6. Exactly two crossings: (0,4,+1) at(1,0), (0,6,-1) at(-1,0). Along directed leaf0 the event partner order is[6,4]. Other nonadjacent hull pairs are disjoint and every adjacent projection is strict. All variants below certify7 leaves/21 pairs:

| ID            | Source transformation                                                      | Ordered crossing records | Directed event order |
| ------------- | -------------------------------------------------------------------------- | ------------------------ | -------------------- |
| star          | Exact explicit A/B above, all kinds false                                  | (0,4,+1),(0,6,-1)        | leaf0:[6,4]          |
| star-reflect  | Reflect every control/endpoint by(x,y)->(-x,y)                             | (0,4,-1),(0,6,+1)        | leaf0:[6,4]          |
| star-reverse  | Reverse each contour and controls, retaining its original first vertex     | (2,3,-1),(2,5,+1)        | leaf2:[5,3]          |
| star-implicit | Omit last source from each contour; use true closures                      | (0,4,+1),(0,6,-1)        | leaf0:[6,4]          |
| star-mixed    | Explicit form, mark only source0 LINE                                      | (0,4,+1),(0,6,-1)        | leaf0:[6,4]          |
| star-lines    | Explicit form, all seven sources marked LINE                               | (0,4,+1),(0,6,-1)        | leaf0:[6,4]          |
| star-curved   | Explicit form, source0=[(-3,0),(-1,1/16),(1,-1/16),(3,0)], all kinds false | (0,4,+1),(0,6,-1)        | leaf0:[6,4]          |

For star-curved, x(t)=-3+6t and y(t)=3e*t*(1-t)*(1-2t), e=1/16. Source intersections at x=-1,+1 have y=+1/72,-1/72 respectively, and homotopy scales those y values by1-s. All source/chord cross signs against the vertical partners are constant; endpoint sweeps and noncrossing hulls stay separated. Cyclic adjacent projections retain strict positive signs. Thus this variant exercises real nonlinear multiple-partner preservation; no flattening or positional tolerance claim is made. Freeze literal directed partner order independently of the oracle's pair-enumeration order. The test computes exact proper chord-intersection parameters from the declared polygon and global leaf indices, sorts along the directed leaf and compares with the literal partner list; it must not sort pair-enumeration indices or compare duplicated literals. Monotone x and fixed vertical partners independently justify the curved source order.

All old matching entries reject these variants at7/6, except reversed at7/14. Use old mixed for marked variants and both old plain/mixed-allfalse for the others. These are expected preserved old restrictions, not regressions.

### Inclusive crossing-cap family

A=[(-20,-2),(20,-1),(-20,0),(20,1),(-20,2),(20,3),(20,4),(-41/2,4)]. B=[(-8,-5),(-4,p),(0,-5),(4,q),(8,-5),(12,5),(16,5),(16,-6)]. Both contours supply all8 returning sources:16 sources/leaves and120 complete pairs, all kinds false. All are quarter-control monotone line sets. Each source's strict monotonicity along its chord preserves the directed intersection order on every multiply-crossed leaf, without a matched-parameter positional claim. They are simple contours, so the crossing graph is bipartite. Adjacent chord projections are strictly positive, with minimum B closure/first dot3/4 and A top/closure dot16.

The complete crossing inventory is: for each i=0..4, pairs(i,8+j), j=0..4, with sign(-1)^(i+j), followed by(i,14) with sign(-1)^(i+1). Additionally A-top leaf6 crosses B-right14 with sign+1 and crosses B zigzags whose top exceeds4, with sign-1 for even local j and+1 for odd j. Record order is lexicographic pair enumeration, not this prose grouping. No other pairs intersect.

`cap-32`: p=q=7/2. Only local B zig4 reaches above4: extra records(6,12,-1),(6,14,+1). Exactly32 records; CERTIFIED16/120. This graph has degree greater than2 and four-cycles but no triangles.

`cap-overflow`: p=7/2,q=5. Top extra pairs are(6,10,-1),(6,11,+1),(6,12,-1),(6,14,+1), giving34 geometric crossings. After30 earlier records, pair(6,12) attempts the33rd record and returns WORK_LIMIT16/81, finding `32`/`crossings`, null certificate. Do not run to the34th record or publish a partial graph. Original matching mode remains UNRESOLVED16/9, at its second crossing(0,9).

### Triangle controls

`distinct-triangle`: one explicit7-edge contour[(0,0),(5,6),(5,-1),(-1,5),(7,2),(-2,2),(-3,-2)]. Prior crossing records are(0,2,+1),(0,3,-1),(0,4,+1),(1,3,+1),(1,4,-1). Pair(2,4,+1) closes triangle0/2/4 and returns UNRESOLVED7/13, finding `triangle` and `2,4`. The three target events are distinct:(20/11,24/11),(5/3,2),(2,2). These rational positions are analytic expectations, not Float64 fixture coordinates. Every adjacent projection is strict and no earlier pair fails.

`concurrent-triangle`: explicit7-edge contour[(0,0),(6,6),(6,-2),(-1,5),(15/2,2),(-2,2),(-3,-2)]. Leaves0,2,4 meet at exactly(2,2); the same prior crossing index/sign list and closing pair above apply. Expect UNRESOLVED7/13 with the triangle finding. Primary and both independent reviewers completed the preflight/adjacency/pair audit before freeze, including strict adjacent projections at the narrow turns (3/4 and1/2). The old matching entries reject both triangle controls at7/3, when(0,3) repeats leaf0.

## Compatibility, limits and corruption checks

Require full-result equality with the24 existing certified rows from the frozen39-row transverse corpus, using all-false kinds, and with all seven H mixed positives under their actual kinds. Their existing literal counters/polygons/crossings remain authoritative. Run all old simple/rounded/transverse/mixed unit suites unchanged; do not blanket-freeze old geometric rejection outcomes under the new sufficient condition.

Star passes inclusive limits2 contours/7 cubics/7 leaves/21 pairs; one-below contour/cubic/declared-leaf rejects WORK_LIMIT0/0, maxPairs20 rejects7/20. Implicit star has five supplied sources, six appended leaves before the last closure: maxLeaves6 rejects6/0 and7 passes. cap-32 maxCubics15 rejects0/0, maxPairs119 rejects16/119. cap-overflow maxPairs80 rejects16/80 before inspecting pair81; maxPairs81 reaches crossing-cap rejection16/81. Triangle maxPairs12 rejects7/12 before triangle inspection;13 reaches triangle rejection7/13. Invalid limits preserve the existing INVALID_LIMITS precedence.

Compare new and old mixed preflight results for invalid/missing/extra/sparse/nonboolean kind arrays, canonical shape errors, invalid full-root marked leaves, later malformed/nonfinite/provenance faults before earlier source-final mismatch, duplicate ordinals and connectivity. KNOT_MISMATCH remains0/0 before any graph work. Keep true-closure, signed-zero and copied-array behavior covered by old positive parity and explicit repeat/deep-freeze/caller-mutation controls. Reject literal crossing sign and valid-but-wrong index, event-order and polygon-bit corruptions in independent fixture assertions. No new result expectation may be fitted to execution.

## Ownership and acceptance

Primary owns this contract, active plan, theorem integration, source review and validation/evidence. Sol high owns only the shared oracle implementation after freeze. Sol medium owns only new `tests/geometry/triangle-free-arrangement/fixtures.ts` and `tests/unit/geometry-triangle-free-arrangement.test.ts`. Independent Astra high reviews the full proof and literal corpus, then stable code and evidence. No recursive delegation or worker commits.

The frozen worker interface reuses existing fixture types. `fixedTriangleFreeArrangementFixtures()` returns readonly `TriangleFreeArrangementFixture[]`; `triangleFreeArrangementControls()` returns readonly `TriangleFreeArrangementControl[]`:

```typescript
type TriangleFreeArrangementFixture = TransverseArrangementFixture &
  Readonly<{
    sourceKinds: readonly boolean[];
    directedPartnerOrder?: readonly Readonly<{
      leaf: number;
      partners: readonly number[];
    }>[];
  }>;
type TriangleFreeArrangementControl = TransverseArrangementControl &
  Readonly<{
    sourceKinds: readonly boolean[];
  }>;
```

The inherited positive `expected` contains literal leaves, pairs, polygons and crossings; controls contain literal status, leaves, pairs and findingIncludes, with null certificate required by assertions. Every star has its table's directedPartnerOrder. The cap family uses the analytically proved monotone segment ordering; no order field is added to oracle output.

I01: complete Primary/independent theorem/literal/interface review and contract freeze before implementation. I02: eight positives, two triangle rejections, overflow, old-function restrictions and inherited certified parity; complete limits/preflight/copies/corruptions. I03: stable-source review before numerical dispatch, focused new/old oracle tests, bounded two-worker root check, build, explicit Markdown/link/diff checks and final Primary/independent evidence review. Protected CI/PR integration remains mandatory. No Rust/WASM, browser/GPU, benchmark or full census is required for this test-only checkpoint. Native graph storage/adoption requires a separately frozen follow-on; public mesh/coverage and complete P3 gates remain open.
