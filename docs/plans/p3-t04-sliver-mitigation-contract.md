# P3.1p T04 grid-sliver mitigation comparison contract

Status: FROZEN, 2026-10-08, at revision 4 plus confirmation fixes. Implementation is authorized after integration.

**Contract identity.** The integrating `main` commit, plus this note's SHA-256 at that commit.

**Review history.**

- **Revision 1.**
  - Astra high: NOT READY, 6 blocking items. M-C chamfered ordinary corners, was vacuous at the residual cameras, and its deviation metric hid a visible change. M-B had specification gaps. C0 was under-specified. Decision routing was inconsistent.
  - Sol medium: NOT IMPLEMENTABLE, 7 blocking items. The builders cannot be injected, M-C used exact rationals while inputs are binary64, and K is hard-wired.
- **User decision, 2026-10-08, in chat** (recommended option). M-C, needle-tip truncation, is withdrawn. Under the A5 rule a 0.01-px needle renders as a coverage ≈ 0.5 line, and truncating it would remove a visible line. M-D, needle-as-fringe, is evaluated instead.
- Revision 2 addresses all blocking items.
- **Revision 2.**
  - Astra high: NOT READY, 4 blocking items, all on M-D. The tip was never thin. Face roles were undefined. The `|Δc|` bound was wrong: features narrower than 2Ē can swap, so `|Δc|` reaches 1. The physical bound was understated.
  - Sol medium: NOT IMPLEMENTABLE, 7 blocking items, mostly on M-D:
    - partners;
    - the exact thin test;
    - face roles;
    - the dependence radius;
    - features and records;
    - D-D;
    - `cam:t`.
- **User decision, 2026-10-08, in chat** (recommended option). Evaluate a relaxed coverage meaning for features narrower than 2Ē, together with M-D.
- Revision 3 addresses all the revision 2 blocking items.
- **Revision 3.**
  - Astra high: NOT READY, 3 blocking items.
    - `thinPairsWithin2E` used an upper bound, so it undercounted.
    - The role claim was unproven, and the 0.48 threshold sat above the 0.4797 margin.
    - Which cells use the M-D partition was unspecified.
  - Sol medium: IMPLEMENTABLE, with SHOULD-FIX items.
  - Revision 4 addresses all of them.
- **Revision 4.** Astra high: NOT READY, with one one-line blocking item: apex partner pairs need the wedge term. The fix is applied verbatim. The two SHOULD-FIX items are applied too: the global locality of the spur fixpoint, and "meets" instead of "contains". Per the reviewer, no further round is needed.

**Authorization.** On 2026-10-08 the user decided, in chat:

- compare grid-sliver mitigations, then decide;
- evaluate M-D rather than truncation;
- evaluate the relaxed coverage meaning for features narrower than 2Ē.

**What T04 is.** Test-only, offline and exact. It compares configurations and adopts nothing.

- **Every adoption is a user decision, followed by a revision 5 of the R2 contract under independent review.** K = 8, M-B and M-D all change frozen revision 3 and 4 text: D-B's K, Mechanism 3, P3, the P5 record set and the coverage argument.
- The reference region and its features stay unchanged in every configuration.
- E3 coverage semantics stay unchanged except in C3 and C4. There, the relaxation stated under M-D is evaluated. Adopting it needs a requirements update.
- Stroke stays deferred.

**Basis.** The [T03 evidence](../evidence/p3.1p-t03/review-2026-10-08.md) found FAIL-AS-PREDICTED, with residual set R:

- **4 O rows:** `carrier/Z/depth-positive/{star,zero-closure}:{nonzero,evenodd}/S5` at DPR 1. They fail the triangle term at the floor of sub-band 3 of 4.
- **6 TRI variants:** `S/TRI/k{24,32,40}/z1/d1/{I,R15}/cam:v1`. These are needles narrower than E over many cells. They fail every C2 term in every sub-band, and also at `s0`.
- **6 RECT variants:** `S/RECT/k{24,32,40}/z1/d1/{I,R15}/cam:v2`. The region is wide, but the internal diagonal 0-2 crosses grid lines near grid corners and creates near-coincident records.

**Pre-freeze census** (disclosure, not evidence; T03 code, uncommitted).

- At K = 8, all 4 O residual rows pass in their own sub-band. K = 16 and 32 also pass. Their lower sub-bands still fail, so the zoom-only U4 case remains.
- TRI and RECT fail at every K, and also at `s0`.
- **K was chosen after seeing this census.** The revision 4 census statement "K = 8 adds nothing" was measured before the best-rotation triangle term existed. Both statements are disclosed. K = 8 is therefore a post-census choice, and the evidence below is not a blind test of it.

## Configurations

These are cumulative. Anything not named stays as in revisions 3 and 4.

| Id | Change |
| --- | --- |
| C0 | None. It reproduces T03 through the T04 pipeline and is the control |
| C1 | K = 8 certificate sub-bands |
| C2 | C1 + M-B, per-cell region retriangulation |
| C3(w) | C2 + M-D, thin-feature fringe, for `w ∈ {1/32, 1/16, 1/8}` physical px |
| C4(w) | C1 + M-D, without M-B, for the same `w` values. Its M-D cells still retriangulate their union. C4 differs from C3 only in the side points and in the non-M-D cells, so it does not fully isolate M-D |

### M-B: per-cell region retriangulation

**Kept points.** These are defined per closed cell from global source data only:

- cell corners that lie in the closed region (exact point-in-region test);
- crossings of **boundary** source edges with the closed cell sides, plus the ends of the overlap where a boundary edge lies along a side;
- **boundary vertices** in the closed cell, meaning endpoints of boundary edges, taken by exact position.

A boundary edge is an edge used by exactly one non-degenerate source triangle.

**Faces.** The union of the cell's clipped region pieces is built as half-edges, subdivided at all of the cell's points. Shared edges cancel. The faces are traced with the face on the left, holes are nested and bridged, and pinches are paired as in `fringeFaces`. Every vertex that is not a kept point is then deleted from the walks. Each such vertex is asserted to be straight-through, that is, a collinear point on a cell side or an internal point.

**Triangulation.** O02's `earClip`, followed by D-C's flips on the cell's region triangles. Only edges shared by two region triangles of the same face may flip; the face boundary, including region/exterior edges, is never flipped. The order, guard and in-place slots are as in D-C.

**Fringe.** `fringeFaces` receives the new region triangles as rings and the kept side points as `sidePoints`. Exterior flips are as in D-C.

**Consequences.**

- Both sides of every grid line carry the same kept set. The kinds of conformance this covers:
  - a fringe cell next to a region cell, a fringe cell, or a non-drawn cell;
  - a boundary edge lying on a grid line;
  - a pinch on a side;
  - a hole inside a cell.
- The reference region R is unchanged as a point set. Records become a subset of the old records, with no new positions. Boundary pieces and features are unchanged. E3 and D3(a) hold.
- A kept corner on an internal source edge keeps its P5 kind relative to that edge, through the global `lowestEdge`.
- **D-D is unchanged in every configuration.** The owned set is still T03's source-derived set. It is a superset of the kept records, so every record still lies in its owner's owned set. Dropped and internal points still count toward the centre.

### M-D: thin-feature fringe

**Pieces and partners.**

- A **boundary piece** is a source boundary edge intersected with a closed cell, when the intersection has positive length. Every cell counts, candidate or not. An edge lying on a grid line therefore yields one piece in each of the two adjacent cells.
- Two pieces are **partners** unless they lie on the same source edge. Pieces that meet at an endpoint, such as the two edges of a wedge apex, are partners.
- `w_loc = w · n / s_L` uses the R2 reach constants of the row's level.

**Thin test (exact).**

- For a piece `a` and each partner `b` whose cell lies in the 3×3 block around `a`'s cell, compute the closed sub-interval of `a` that lies inside `b ⊕ [−w_loc, w_loc]²`. This is a convex polygon with at most 6 vertices, clipped by rational half-planes.
- `a` is **thin** when the union of these intervals covers `a`. All comparisons use `≤`.

**Dropped points.** A point `c` is **dropped** when:

- it is an endpoint of at least one thin piece;
- it is an endpoint of no non-thin piece; and
- it is not a cell corner.

`dropped(c)` is a global predicate of the source mesh and L, so every cell removes the same points. A cell's content depends on the 5×5 block around it. That block is computable from the source mesh, so the cache key `(mesh, L, i, j)` still determines the content.

**Bounds asserted per row.**

- `w_loc ≤ 2^L`.
- `D = s_hi · w_loc · sqrtUp(2 · ‖A0‖_F²) < 0.6047 − 2Ē` px, compared exactly, which is at most 0.4797 at Ē = 1/16. This bounds the physical distance of any point within local ∞-distance `w_loc` of a feature: `‖A0‖_{∞→2} ≤ √2 · ‖A0‖_F`. `s_hi` is the sub-band's, so `thin-bound` is evaluated **per sub-band** as a certificate failure, which feeds `subBandsAdmitted` and `epochAll`. `w_loc ≤ 2^L` is checked once per row.
- A row that fails either check is `NOT_ADMITTED:thin-bound`.

At the identity, `‖A0‖_F² = 2` and `n = 1`, so `D = 2 · w · (s_hi/s_L) ≤ 4w`. At `w = 1/8` that is 0.5, so `w = 1/8` is expected to fail this bound; the failure is pre-stated.

**Drawn partition.**

- **M-D cells.** A drawn cell is an **M-D cell** when its closed square meets (closed intersection) a thin piece or a dropped point, so a thin piece lying on a shared side makes both cells M-D cells. Every other cell keeps its configuration's base builder: C1 for C4, and C2 for C3.
  - **Seam.** A non-M-D neighbour has no dropped point on a shared side, because such a point would make it an M-D cell. So the side sets match across the seam.
  - **Equality.** A row without M-D cells equals its base configuration, and the report asserts this.
- **Arrangement.** In each M-D cell, the non-thin pieces plus the cell sides form an arrangement. It is traced into faces with `traceWalks`, `mergeHoles` and `pointInLoop`.
  - A piece lying on a cell side coincides with the side. It is one undirected edge that carries the piece's role information: the region lies on the left of the directed piece.
  - **Spur avoidance.** Thinness is iterated to a fixpoint. Any piece whose removal would leave a kept piece with a degree-1 endpoint off the cell sides is un-thinned. `dropped(c)` is evaluated on the final marks.
  - **Locality of the fixpoint.** Un-thinning can propagate along a chain of pieces across many cells, so the 5×5 dependence statement no longer holds. The marks are still a global function of the source mesh and L, so the cache key `(mesh, L, i, j)` stays valid. The locality host test compares a cell against a full global evaluation.
- **Spurs.** A spur that survives the fixpoint gives `NOT_ADMITTED:thin-spur:<locus>`. It is reported separately from `thin-role`.
- **Mis-role check (exact).** For each face, the mis-roled set is the face minus the role's side of the source region: the face ∩ (R Δ role). This set minus the union of `b ⊕ [−w_loc, w_loc]²` over all boundary pieces `b` in the 3×3 block must be empty. Otherwise the row is `NOT_ADMITTED:thin-role:<locus>`. Membership uses the closed union of the non-degenerate source triangles.
- **Face roles.**
  - A face is `region` when an adjacent kept piece has it on its left, in the region winding, and `exterior` when it is on the right.
  - If adjacent pieces disagree, the row is `NOT_ADMITTED:thin-role:<locus>`.
  - A face with no adjacent kept piece takes the exact source-region membership of the first point, among the four corners and then the cell centre, whose ∞-distance to every boundary piece in the 3×3 block is greater than `w_loc`. If no such point exists, the row is `NOT_ADMITTED:thin-role`.
- **Points.** In C3, the M-B kept points minus dropped points. In C4: on the sides, the T03 side points minus dropped points; in the interior, the endpoints of kept pieces only, so internal source vertices are not points.
- **Triangulation.** As in M-B: ear clipping, then flips within each face, with the same in-place slots for faces with holes. Bridge edges may flip.
- **Roles across the transition side.** At a needle transition, an exterior thin cell can meet a region wedge across a side. That role discontinuity is expected, and S4 still holds.

**Records, features and flags.**

- **Boundary pieces for features and sectors** are the source boundary edges clipped to the candidate cells and subdivided at cell sides. They do not depend on the drawn triangles.
- **Records** are the drawn-triangle vertices plus every boundary-piece endpoint. The endpoints that no drawn triangle references are the dropped and thin ones.
- **Certification follows T03.**
  - S2 runs over all records.
  - C2 and `EmaxLocal` run over the ids that drawn triangles reference.
  - Lists and S5 run over all features.
- **Flags.** Fringe flags and `cells[].region` are unchanged.

**Coverage semantics: the relaxation being evaluated.**

- **The relaxation.** Wherever some thin pair of features lies within `2Ē`, the evaluated features may cross. Within the `d* < 1` band around them, `|Δc| ≤ 1`: a pixel there may render anywhere from 0 to 1. The user chose, on 2026-10-08, to evaluate this relaxed meaning.
- **Adoption.** Adopting it needs a requirements update that names this exception. That update must amend:
  - G2's THIN-Z1 visible-geometry clause, because the relaxation allows `c = 0` at the nearest-row centre;
  - E3's pre-stated O03 band of `√2·Ē`.
- **What still holds** under S2 and S3 on the drawn mesh:
  - the drawn partition and G3 single coverage;
  - feature positions within Ē;
  - role constants for `d* ≥ 1`. The exact mis-role check places every mis-roled point within local ∞-distance `w_loc` of a feature, so within D px. And `D < 0.6047 − 2Ē = 1 − 0.3953 − 2Ē`.
- **Report per row:**
  - `thinPieces`;
  - `droppedPoints`;
  - `thinPairsWithin2E`: pairs of a thin piece and any partner in the 3×3 block, thin or not, that fail D-A's vertex or edge clearance at the sub-band's `s_lo`, using the lower bound `σ_lo(s_lo · A0) · ‖·‖` against `E_u + E_v`. Partner pairs that share an endpoint are tested with D-A's localized wedge term instead (R0a cross and W margins, `δ_w = max E`) at the sub-band's `s_lo`, and a pair counts when that test fails. This set conservatively includes every pair that may cross;
  - `relaxedLengthPx`: the sum, over thin pieces that appear in those pairs, of `sqrtUp(s_hi² · ‖A0‖_F² · |a|₂²)`, an upper bound on their physical length;
  - `D`.

**Pre-stated fail-closed regressions.** These are reported per corpus, separately from certificate failures:

- boundary edges shorter than about `w_loc` can still give `thin-role` after the fixpoint;
- vertices within about `w_loc` of a grid line can give `thin-spur`.

**Feature source per switch.**

- With M-D on, boundary pieces come from the clipped source boundary, deduplicated where an edge lies on a side.
- Otherwise they come from T02's derivation, which keeps the builder-equivalence test and C0 exact.

**Pre-stated hazard: needle transitions.** These are defined for TRI only. The tip is vertex 1.

- **Transition cell.** Edge (v1, v0) lies on `y = 0`, so each of its pieces appears in two cells; the piece in the cell on the region side is the one that counts. Order those pieces by the distance of their end nearer v1. The first non-thin piece's cell is the transition cell. It is found by bisection over cell index, using the needle's monotone width. A host test checks the bisection against brute force at small k.
- **Camera.** The narrow side is the side through which that piece enters from the tip. The camera point is the midpoint of the entry point and the crossing of edge (v1, v2) with the same grid line. The camera is `cameraAt(...)`, RN64.
- **Ids.** `<row>/cam:t<w>`, giving 6 rows × 3 values of w = 18 ids.
- **Where they run.** They are evaluated in every configuration. They are new keys outside the C0 archive join, and the 187 archived A rows must stay unchanged.
- **Domain.** A camera outside the input domain is flagged `CAMERA_OUT_OF_DOMAIN`.

## Evaluation

**Pipeline.** A new configurable copy of the T03 pipeline, under `tests/geometry/extent-t04/`.

- It parameterizes `evaluateSpec`, `certifySubBand`, `k4EpochOf`, `inversionsOf`, `exponentCovering`, `emptyRow` and `evaluateTrajectories` on K, the builder and the M-B/M-D switches.
- **Builder.** `merged-b.ts` copies T02's `buildMergedMesh` steps 1-8 and `boundarySectors`, with the source context as a parameter, and adds M-B and M-D.
- **Builder equivalence.** A host test asserts that with both switches off, the builder deep-equals `buildMergedMesh` on a stated sample.
- **Pinned files.** All T01, T02 and T03 files stay byte-unchanged. The reference is the T03 archive's `sources` table.

**C0 control.** C0 runs through the T04 pipeline with K = 4 and both switches off.

- Every T03 row field (the T04-only keys `configuration`, `K`, `droppedRecords` and the M-D fields excluded) and every trajectory record must equal the pinned T03 archive (SHA `5679e76e…`), joined on `(corpus, id, dpr)`. The report asserts that T04 only adds keys.
- A mismatch is a harness defect and stops the run.

**Corpora.** T03's corpora, plus the transition variants defined under M-D.

**Row keys.** T03's keys, plus:

- `configuration` and `K`;
- `droppedRecords` (M-B);
- M-D: `thinPieces`, `droppedPoints`, `thinPairsWithin2E`, `relaxedLengthPx` and `D`.

`subBand.k` runs up to K − 1. `subBandsAdmitted` is out of K. The row key is `(configuration, corpus, id, dpr)`.

**Per-configuration summary.**

- T03 gates 1-4, pass or fail, with failure lists.
- R's outcomes.
- Regressions against C0, with `NO_IN_WINDOW_TRIANGLES` counted separately from certificate failures.
- Admission counts.
- Zoom-only U4 counts.

T03's verdict and prediction fields are not reused.

**Trajectories.** Computed once for K = 4, which must equal the archive, and once for K = 8. They are independent of the mesh switches.

**Reuse and sharding.**

- C0 and C1 may share one mesh build per row.
- A row with no M-D cell reuses its base configuration's mesh, and the equality is asserted.
- Parts are sharded per `(configuration, corpus)` and assembled with no overwrite.

**Budget.** About 10 configuration runs at 20-40 min each. The write budget is 6 hours, sharded, and replay is sharded too.

**Expectations.** These are pre-registered and not gated.

| Configuration | Expected |
| --- | --- |
| C1 | The 4 O rows pass in their own sub-band; TRI and RECT still fail |
| C2 | RECT clears; TRI is unchanged |
| C3 and C4 | For I, `w = 1/8` fails `thin-bound` (D ≈ 0.5). For R15, D ≈ 2.44w ≈ 0.31, which passes. At 1/32 and 1/16, the TRI tip cells are thin and `cam:v1` clears. Transition variants are undetermined. RECT under C4 is unchanged |

**Comparison rule.** Fixed before results: the configurations are tabulated side by side. Nothing is selected and no `w` is chosen after results. The user decides.

## Limits

- Everything in the revision 3 and revision 4 limits.
- The M-D coverage argument is reported, not proved.
- No GPU run, so G1-G3 under M-D are not measured. That is O03 work, after adoption.

## Records, ownership and validation

**Records.**

- `P3_T04_WRITE=1` with `vitest.p3-t04.config.ts` writes the report.
- Replay is byte-identical.
- The archive goes under `docs/evidence/p3.1p-t04/`.
- The `contract` key records the revision 3, revision 4 and T04 commits with their SHA-256s, plus the T03 archive SHA.

**Ownership.**

| Owner | Scope |
| --- | --- |
| Primary | This contract; the configurable pipeline, C0 control, report, replay and evidence; the transition variants |
| Sol medium | `merged-b.ts`; M-B faces and kept rule; M-D thin marking and constrained partition; region flips; their host tests |
| Astra high | Contract review, stable-source review, evidence review |

**Host tests.**

- Builder equivalence with both switches off.
- M-B: the union is unchanged (exact area and point-in tests), conformance in all the listed cases, and region-flip locality.
- M-D: thin marking against brute force, cell locality under renumbering and different neighbour sets, the role-side check, and conformance.
- A C0 control sample.
- Pinned hashes.

**Validation.** `pnpm check`, `pnpm test:geometry`, `pnpm build`, write and replay, and the Markdown and link checks.

**Order.** `T03 integrated -> this draft -> independent review -> FROZEN -> T04 implementation -> evidence and review -> user decision -> revision 5 -> O03`.
