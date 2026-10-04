# P3.2r private transverse crossing preservation

Status: FROZEN after Primary and independent Astra high proof/interface/all60-fixture review,2026-10-05, before implementation. Stable source and actual scratch inventory review remain required before execution. The [active plan](p3-fill-stroke-meshes.md) owns execution. This builds one missing private predicate for general crossing-aware cubic topology. It does not adopt a new contour certificate, increase capacity or change public API/ABI, P2 emission, dependencies, error allowances or deferred stroke scope.

## Mathematical claim and boundary

For each of two leaves, let C(u) be the exact restriction of its original represented cubic to the declared dyadic cell, and L(u) the segment between its actual carried endpoints. Use the existing [rounded-knot homotopy](p3-rounded-knot-topology-contract.md), H(s,u)=(1-s)C(u)+sL(u), independently for the two leaves at the same s. Certify exactly one transverse intersection of their open parameter intervals for every s in[0,1], with constant ordered derivative orientation, only if all these sufficient conditions hold:

1. The two actual closed chords have an exact proper interior/interior crossing.
2. Form four true derivative generators per leaf:3(Q1-Q0),3(Q2-Q1),3(Q3-Q2),B-A. All16 ordered cross products between first/second leaf generators have the same strictly nonzero sign.
3. Each of the four moving endpoint segments Q0->A and Q3->B is disjoint as a closed set from the other leaf's expanded convex hull conv(Q0,Q1,Q2,Q3,A,B). Closed contact or containment rejects.

Every homotopy derivative is a convex combination of its four true generators. The same is true of interval-averaged derivatives. Strict bilinear cross signs therefore persist for derivatives and interval averages. Each individual piece is injective: its average derivative has strictly nonzero cross product with any opposing generator, hence cannot vanish. Two distinct intersections would make nonzero interval-average directions parallel, contradicting the strict cross condition. Thus every intersection is transverse and at most one exists. Endpoint separation excludes zeros on the boundary of the two-parameter square throughout s. The proper chord crossing at s=1 has nonzero degree; homotopy invariance of degree supplies an interior zero for every s. This proves existence as well as uniqueness; a nonzero Jacobian alone is not the argument.

The returned pair certificate is not global contour equivalence. A later caller must establish common source context/identity, complete pair coverage, adjacency/joins, intersection order along each source, absence or handling of triple-event collisions, source-boundary continuity and positional correspondence. No intersection coordinates, event multiplicity, winding, mesh, physical tolerance or rendering result is returned. Conservative Unresolved is a helper limitation, not a product rejection rule. The historical polygon census motivates crossing work but proves none of these cubic obligations.

## Private interface, validation and bounded arithmetic

Inside the existing `simple_cubic_topology.rs` module add Copy/Debug/PartialEq `TransverseLeafInput { source:[Point;4], provenance:Provenance, actual:[Point;2] }`; Copy/Debug/PartialEq/Eq `TransversePairCertificate { leaves:[Provenance;2], orientation:i8 }`; and `certify_transverse_pair(leaves:&[TransverseLeafInput;2]) -> Result<TransversePairCertificate,TopologyError>`. All are crate-private, with fields crate-private. orientation is exactly+1/-1 for cross(first derivative,second derivative); preserve caller order. No workspace, counters, output state, allocation, export or tolerance parameter.

Validation order is global and frozen:

1. Every source/actual coordinate of both leaves finite, else InvalidInput.
2. Both provenance cells satisfy depth<=20 and1<=end_numerator<=2^depth, else InvalidProvenance. All u32 source_verb values are opaque and allowed.
3. When source_verb agrees, original source control bits must agree exactly, including signed-zero identity, else InvalidInput.
4. For the same source, dyadic parameter interiors must be disjoint, else InvalidProvenance. Duplicate/overlapping cells reject; shared endpoints are allowed. Compare interval endpoint products with u64, each bounded by2^40 after step2. This is not validation of a complete source partition or contour adjacency.
5. Restrict both cubics exactly; perform chord crossing, generator signs and endpoint-sweep separation in that order. Any failed sufficient condition returns Unresolved. Return a complete copied certificate only after all conditions pass; no retained state exists.

Reuse existing exact_cubic/restrict_cell, point_sub/cross_vectors, convex_hull/closed_hulls_intersect and proper orientation tests. The expanded hull has at most6 points; each sweep hull has at most2 and may collapse to a singleton. Process sweeps sequentially using borrowed hull views. Do not change old helpers' accepted sets, layout or resource accounting, or duplicate arithmetic in a generic new framework.

Mathematical derivative generators include factors3, but the implementation may use the unscaled source differences for sign tests: each omitted multiplier is positive, so each cross sign is identical. Do not claim actual derivatives lie in the unscaled convex hull. This preserves existing [P3.2n arithmetic](p3-native-rounded-topology-contract.md): grid2^-1134, Signed<34>/<68>, finite/restricted coordinate magnitude<2^2158, differences<2^2159 and cross-product magnitude<2^4319, within2176/4352 bits. Restriction consumes at most60 trailing bits over20 midpoint levels. No floating determinant, epsilon, saturation, adaptive retry or new dependency.

Inventory fixed source-level scratch below32KiB per nonrecursive helper before execution, including copied arrays/restriction/hull/product locals. Two six-point records and eight generator points consume about11.3KiB with current types; avoid unnecessary copies, process sweeps one at a time and account remaining temporaries. This is not an exact compiler stack-frame claim. No heap allocation or new retained workspace bytes; repeated success/failure calls leave caller inputs and earlier returned value copies intact.

## Frozen analytic corpus

Use default provenance(source_verb1/2,end_numerator1,depth0) and actual endpoints equal source endpoints unless stated. Point tuples are literal represented binary64 inputs. Let H=[(-3,0),(-1,0),(1,0),(3,0)] and V=[(0,-3),(0,-1),(0,1),(0,3)].

Eight positive bases:

| ID  | Literal source/actual pair                                                                                                                                                   | Orientation |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------: |
| S   | H,V                                                                                                                                                                          |          +1 |
| N   | A=[(-3,0),(-1,1/4),(1,-1/4),(3,0)]; B=[(0,-3),(1/4,-1),(-1/4,1),(0,3)]                                                                                                       |          +1 |
| K   | N sources; A actual[(-3,1/64),(3,1/64)], B actual[(1/64,-3),(1/64,3)]                                                                                                        |          +1 |
| U   | Shared source[(3,-6),(-1,7),(-1,-7),(3,6)], source_verb1 for both, cells(6,4)/(11,4). First actual[(27/64,-153/2048),(3/16,21/256)], second[(3/16,-21/256),(27/64,153/2048)] |          -1 |
| D0  | Set n=2^20. H source[(0,0),(n,0),(2n,0),(3n,0)]; V source[(1,-1),(1,n-1),(1,2n-1),(1,3n-1)]. Both cells(1,20), actual[(0,0),(3,0)]/[(1,-1),(1,2)]                            |          +1 |
| D1  | Translate D0 H source x by-3(n-1) and V source y by-3(n-1), leaving actual endpoints as D0. Both cells(n,20)                                                                 |          +1 |
| MIN | S with every nonzero coordinate multiplied by minimum subnormal m (controls at-3m,-m,m,3m)                                                                                   |          +1 |
| MAX | Axis-aligned H/V controls at-MAX,-MAX/2,MAX/2,MAX on their varying axis                                                                                                      |          +1 |

N has midpoint crossing and horizontal/vertical derivative cones: its x/y forward generators are6 and other components within[-3/2,3/4], making all crosses positive. K keeps those cones and its endpoint sweeps remain far from the opposing expanded hull. U has x=3(2t-1)^2 and y=3(3t-1)(3t-2)(2t-1); intersections at parameters1/3 and2/3 lie in the stated disjoint cells. First-cell x generators are negative, second positive, and both y generator sets positive, giving negative cross signs. Endpoint hull separation follows from opposite endpoint y values at each unique extreme x. D0/D1 restrict exactly to[(0,0),(1,0),(2,0),(3,0)]/[(1,-1),(1,0),(1,1),(1,2)]. MIN/MAX exercise exact arithmetic without a floating determinant.

For each base, include base, pair-swap (negate orientation), reflection x->-x on both leaves (negate), and reversal of both parameter directions (preserve). Reversal reverses each source control array and actual pair and maps cell numerator to2^depth-numerator+1; reverse the shared source consistently for U. For the seven distinct-source bases also reverse only the first leaf (negate). These are39 fixed positives; no random/search-selected fixtures. Row order follows table base order, with suffixes `-base`, `-swap`, `-reflect-x`, `-reverse-both`, then `-reverse-first` where applicable; for example S-base. G01-G10 then I01-I11 follow in numeric order.

Ten Unresolved controls, each based on S unless specified:

- G01: translate V source and actual x to4 (disjoint chords).
- G02: translate V source and actual x to3 (endpoint contact).
- G03: second source/actual is H with source_verb2 (overlap).
- G04: first actual[(0,0),(0,0)] (zero chord).
- G05: first source[(-3,0),(-3,0),(1,0),(3,0)], original H actual (zero derivative generator despite proper chords).
- G06: first source[(1,0),(2,0),(3,0),(4,0)], actual[(-3,0),(4,0)] (endpoint sweep crosses V hull).
- G07: first source[(0,0),(1,0),(2,0),(3,0)], original H actual (closed endpoint sweep contact).
- G08: first source[(1/8,0),(1,0),(2,0),(3,0)], actual[(-1/8,0),(3,0)]; second source[(-2,-3),(2,-1),(-2,1),(2,3)], actual[(0,-3),(0,3)]. First endpoint sweep is contained in opposing expanded hull; chords properly cross and generator signs pass.
- G09: first H; second source[(-3,3),(-1,-1),(1,-1),(3,3)], actual[(-3,-1),(3,1)]. Source is tangent to H at its midpoint; proper actual chords do not rescue the failed derivative cone.
- G10: both source H/source_verb1, cells(1,1)/(2,1), actual[(-3,0),(0,0)]/[(0,0),(3,0)]. Adjacent cells are provenance-valid but chords touch.

Eleven invalid controls:

- I01: G01 with second source Q3.y=quiet NaN -> InvalidInput.
- I02: S with first actual A.x=+Infinity -> InvalidInput.
- I03: S with first depth21 -> InvalidProvenance.
- I04: S with first numerator0 -> InvalidProvenance.
- I05: S with first numerator2 at depth0 -> InvalidProvenance.
- I06: both source H/source_verb1/cell(1,0), arbitrary S actual pairs -> InvalidProvenance (duplicate cell).
- I07: I06 cells(1,0)/(1,1) -> InvalidProvenance (overlap).
- I08: S with both source_verb1 -> InvalidInput (contradictory source controls before duplicate-cell check).
- I09: G10 with only second copy's Q0.y=-0 while first Q0.y=+0 -> InvalidInput (identity bits).
- I10: S with first depth21 and second actual B.y=quiet NaN -> InvalidInput (global finite validation wins).
- I11: G01 with second numerator0 -> InvalidProvenance (later provenance wins over geometry).

Total60 rows. Each expected status/orientation is literal; error rows have no certificate. Exact quiet-NaN bits7ff8000000000000 and Infinity7ff0000000000000 are transport data only, never exact-number inputs after rejection.

## Independent evidence, ownership and validation

Use a small deterministic generator `tooling/generate-p3-transverse-pair-fixtures.mjs` and fixed `tests/fixtures/p3-transverse-pairs-v1.txt`, following existing fixture discipline. The generator's independent BigInt rational restriction and explicit3-scaled generators verify every literal status/orientation before emitting/checking bytes. Reuse only existing exact-number conversion/rational primitives as useful. Its endpoint-sweep/hull check uses independent exact separating projections: include x/y and both parallel/perpendicular axes from every nonzero difference of the six opposing hull points and from the sweep endpoints. Strict interval separation is exact; these axes contain every convex-hull edge normal and the degenerate segment/point cases, so absence of a separating axis establishes closed intersection. Do not import the native algorithm or use sampled homotopy states.

Freeze file grammar before parallel implementation: first line `p3-transverse-pairs-v1 60`, then60 LF-terminated ASCII rows with33 space-separated tokens. Row prefix is id, status (`Certified`, `InvalidInput`, `InvalidProvenance`, `Unresolved`), orientation (±1 on success,0 on error). Then left followed by right: source_verb, end_numerator, depth (decimal u32),8 source coordinate bit tokens in point x/y order,4 actual coordinate bit tokens. Bit tokens are lowercase16-digit hexadecimal. IDs are unique nonempty ASCII letters/digits/hyphens up to64 bytes. No blank/trailing extra rows. Native fixture parsing is test-only, bounded128KiB and exactly60 rows; expected certificate identities equal input provenances in caller order. Generator `--check` verifies exact checked-in bytes and literal/oracle agreement; `--write` creates the reviewed fixture. No new transport process, package script or dependency.

Primary owns proof/interface/fixture freeze, lib/test-runner wiring, generated data dispatch, evidence and integration. One Sol high owns native helper in simple_cubic_topology.rs plus new transverse_pair_tests.rs; a separate Sol high owns independent generator only. Neither worker executes numeric fixtures before stable source review. Generated fixture creation follows generator review; source-only native formatting/checks may precede it where possible. No recursive delegation. Independent final source/arithmetic/scratch review precedes numeric dispatch. Do not change any expected row or arithmetic/work bound after observing a result without reporting the mismatch and resolving it against the owning contract.

R01: frozen proof, interface, validation order, arithmetic/scratch inventory and all60 literal rows. R02: native allocation-free pure pair certificate with copied identities, unchanged input bytes/previous certificates, repeated success/failure and old helper behavior/resources. R03: all60 literals agree with independent exact generator and native results, including metamorphs, depth20, extreme arithmetic and failure precedence; malformed fixture controls reject. R04: generator byte check, Rust fmt/Clippy, full `pnpm test:geometry`, unchanged release WASM, bounded two-worker `pnpm check`, `pnpm build`, docs/links/diff, Primary/independent evidence review and required protected CI. No browser/GPU/benchmark/full corpus rerun or full P3 gate claim. Later global adoption needs a separate contract for pair coverage, crossing order and triple-event handling.
