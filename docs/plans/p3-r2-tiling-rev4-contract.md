# P3.1p R2 tiling contract, revision 4 (delta)

Status: FROZEN, 2026-10-08, at revision 2 plus confirmation fixes. T03 implementation is authorized after integration.

**Contract identity.** The integrating `main` commit, plus this note's SHA-256 at that commit.

**Review history.**

- **Revision 1.** Astra high: NOT READY, with 4 blocking items:
  - the gate exemptions weakened frozen acceptance;
  - D-C flip order broke cell locality;
  - D-D's owned set depended on the epoch;
  - the sub-band rule and gate 4 were inconsistent.

  It confirmed that D-A (localized C2) is sound. Sol medium: IMPLEMENTABLE after 7 text fixes. Revision 2 addresses all of them.
- **Revision 2.** Astra high: READY. Its non-blocking points are applied as confirmation fixes: the R staleness note, gate 2 wording, the `EmaxLocal` definition, the runtime budget and the D-B wording.

**Basis.** The [FROZEN R2 tiling contract](p3-r2-tiling-contract.md), revision 3, stays in force except where this note changes it. Its evidence run is called T03.

The [T02 evidence](../evidence/p3.1p-t02/review-2026-10-08.md) failed:

- **Gate 2:** 16 class A camera variants failed.
- **Gate 3:** 100 of 429 O rows were lost. The losses were driven by δ and scale (Ē 1.4 to 2.3 times T01's δ̄, S3 at `s_lo`), with fringe triangles adding to them.

**Authorization.** On 2026-10-08 the user chose, in chat:

- for gate 3: reduce δ and improve the fringe (recommended option);
- for gate 2: compare grid-sliver mitigations, then decide (recommended option).

The mitigation comparison is a later experiment, T04. These choices change mechanisms only. **No gate is relaxed.** E1-E3, D1 and D3(a) are unchanged.

**Ownership.** As in revision 3. The [active plan](p3-fill-stroke-meshes.md) owns status.

## Pre-freeze census (disclosure, not evidence)

Before writing this note, Primary ran a test-only census. It applied the deltas below cumulatively to T02's merged meshes. Its code is not committed and its numbers are not evidence. They only motivate the deltas and the prediction under "T03 evidence".

The census used two prototype readings that this note replaces:

- the owned set as the records in the merged mesh (now defined geometrically in D-D);
- the flip order by string key (now defined in D-C).

The comparison set is the rows T01 K1@256 admitted at γ = 4 under G8.

| Configuration | O acceptance lost (of 429) | C lost (of 139) | L lost (of 12) | Class A rows | Variants failing (of 184) |
| --- | --- | --- | --- | --- | --- |
| T02 as frozen | 100 | 32 | 0 | 3/3 admitted | 16 |
| + D-A without rotation, D-B, D-C | 36 | 8 | 0 | 3/3 | 15 |
| + D-D | 24 | 4 | 0 | 3/3 | 14 |
| + D-A best rotation | 4 | 0 | 0 | 3/3 | 12 |

What else the census showed:

- **Untiled K4.** It admits all 429 O rows under the same epoch certificate.
- **k20 variants.** All four T02 k20 variant failures recover.
- **Sub-bands.** K = 8 adds nothing over K = 4.
- **Grid phase.** A half-cell grid phase trial added nothing.

## Deltas

### D-A. Localized C2 (replaces S3's δ = Ē)

Each C2 instance is charged only the displacement bounds `E_p` of its own points. `E_p = sqrtUp(E_ep,x(p)² + E_ep,y(p)²)` comes from the same sub-band's S2. `S = s_lo(sub-band) · A0`, and `σ_lo` and `σ̄max` are as in C2.

| Term | Condition (strict) |
| --- | --- |
| vertex pair `(u, v)` | `σ_lo² · ‖u − v‖² > (E_u + E_v)²` |
| edge pair `(ab, cd)`, no shared endpoint | `σ_lo² · dist(ab, cd)² > (max(E_a, E_b) + max(E_c, E_d))²` |
| triangle `t` | Some rotation `(p0, p1, p2)` of `t`, with `u = p1 − p0` and `v = p2 − p0`, satisfies `abs(det S) · A2_t / (‖u‖₁ + ‖v‖₁) > 2·δ_t·σ̄max + 4·δ_t² / (‖u‖∞ + ‖v‖∞)`, where `δ_t = max(E_p0, E_p1, E_p2)` |
| wedge `(v; a, b)` | R0a's cross and W margins, with `δ_w = max(E_v, E_a, E_b)` in place of δ̄ |

**Soundness.** It was reviewed and accepted.

- Motion is affine along each element. A point therefore moves at most `E_p`, and a point of a segment moves at most its endpoints' larger bound.
- **Triangle.** `A2_t` does not depend on the rotation. M04's perturbation bound holds for any base vertex, and needs only `Plo_t ≤ ‖u‖₁ + ‖v‖₁`.
- **Plo.** The shared Plo served only M04's fan pairs, and R0a replaces those with the self-contained wedge term.
- **Wedge.** Its ray tips move at most `2·δ_w`.
- **Dominance.** At the same `s`, the localized C2 accepts every instance and row that the global C2 at δ = Ē accepts.
- **Coverage argument.** Its Ē becomes the per-sub-band `max E_p`, which stays ≤ 1/16.

**Pruning.** The reported run prunes. Vertex and edge pairs whose local ∞-norm boxes are more than `τ = 2·max_used E_p / σ_lo` apart are skipped. Triangle and wedge instances are never pruned. A brute-force run is a test-only oracle.

### D-B. Certificate sub-bands

**Split.** The epoch's guard-clipped lane interval `(zq_lo, zq_hi]` (as in `epoch.ts`) is split into `K = 4` equal-width sub-intervals.

- Sub-interval `k` is `(zq_lo + k·w, zq_lo + (k+1)·w]`, with `w = (zq_hi − zq_lo)/4`.
- Its scales are `s_lo,k = (zq_lo + k·w)·(1 − 2^-22)` and `s_hi,k = (zq_lo + (k+1)·w)·(1 + 2^-22)`.

**Assignment.** A frame's `zq_f = q(fround(zoom)) · q(fround(dpr))`, as in `frameInEpoch`. The frame lies in the unique `k` with `lo_k < zq_f ≤ hi_k`.

**Per sub-band.**

- S2 uses `s_hi,k`, and S3 (D-A) uses `s_lo,k`.
- These stay on the whole epoch and the level band: `D̂`, the candidate and materialized sets, `ρ_L`, `λ_L` and S5.

**Recertification.** Crossing a sub-band within an epoch causes recertification only, with no build and no upload. That is an evaluation, not a build, so it is consistent with E2. Its runtime cost is C04 work.

**Row outcome.** A row is decided by its own frame's sub-band. The row also reports:

- `subBandsAdmitted`: the number of sub-bands of the row's epoch whose S2 and S3 pass;
- `epochAll`: whether all four pass.

**New runtime case (stated consequence).** The S3 margin is relatively harder at lower scale, because E has a scale-independent term (`Γ·size/2`). A lower sub-band can therefore fail while the row's own sub-band passes. A zoom within one epoch could then reach U4 (`render.submission-failed`) without any epoch change, which revision 3 did not have. `epochAll` measures how often this happens. It is a limit to confirm, not a gate.

### D-C. Fringe Delaunay flips (amends P3)

After `fringeFaces`, each fringe cell's exterior triangles get exact Lawson flips.

- **When.** Flips run before records are finalized, and before lists, S4 and S5.
- **What can flip.** Only an edge shared by two exterior triangles of that cell, used in opposite directions; this is asserted. Every edge used once is a constraint.
- **Flip test.** The opposite vertex must lie strictly inside the circumcircle, under a sign normalized by the cell's winding. Both new triangles `(p, d, c)` and `(q, c, d)` must keep the region winding strictly.
- **Order.** Each iteration flips the flippable edge whose endpoint pair is smallest by exact position. Endpoints are compared lexicographically by `(x, y)`; the pair is (smaller endpoint, larger endpoint), compared lexicographically. Then the scan restarts.
- **In-place.** Triangle slots are replaced in place.
- **Guard.** After 10,000 iterations the outcome is `NOT_ADMITTED:partition:delaunay`, which fails closed.
- **Locality.** The order uses exact positions only, so the result depends on the cell alone. A host test asserts that it is invariant under record renumbering and under different neighbour materialization.
- **Coordinates.** Flips run in local coordinates. Under an anisotropic `A0` the result is not physical Delaunay; it is still sound and cacheable.

### D-D. Owner carrier centre (amends E1's carrier detail)

**Owned set.** It is defined geometrically and depends on cell `(i, j)` and the source mesh only:

- source vertices in the half-open cell;
- crossings of source edges with the cell's own lower line `y = j·2^L` and left line `x = i·2^L`, within the cell's half-open extent;
- the lower-left corner, if it lies strictly inside a source triangle (kind 3).

**Centre.**

- If the owned set is non-empty, `m = ((x_min * 0.5) + (x_max * 0.5), (y_min * 0.5) + (y_max * 0.5))` in binary64 round-to-nearest. The bounds are taken over the owned points' `v64`.
- Otherwise `m` is the lower-left corner, exact.
- A cell that no record references has no carrier.

**Bounds.** Owned points lie within half a side, plus rounding, of `m`. A kind-4 corner lies within one side.

**What stays the same.** E1's shared records, per-vertex carrier index and seam argument are unchanged. Cache identity is unchanged, because `m` is cell-local. A host test asserts that `m` from the cell alone equals `m` in merged builds with different neighbour sets, including a non-drawn owner cell.

## T03 evidence

**Harness.** T02's harness and corpora (C, L, O, S, A) with D-A to D-D applied. The code is new, under `tests/geometry/extent-t03/`, with `tests/p3-t03/report.test.ts`, `vitest.p3-t03.config.ts` and a `package.json` script.

- Logic from T02's unexported `report.ts` is copied exactly.
- T02 and T01 files stay byte-unchanged, and their hashes are asserted.
- The `contract` key records the rev 3 and rev 4 commits and their SHA-256s.

**T02 behaviour not carried over.** T03 has no sliver exemption; `SLIVER_EXEMPT_IDS` and `sliver` are not used. Trajectory carriers and anchor-upload upper bounds are unchanged, because D-D changes `m` but not the owner set.

**Row keys.** T02's keys, with `sliver` removed. Then, appended in this order:

- `subBand {k, zqLo, zqHi, sLo, sHi}`;
- `subBandsAdmitted`;
- `epochAll`;
- `EmaxLocal`;
- `k4Epoch`.

`Ebar`, `c2Failures` and `inversions` are per sub-band.

- `EmaxLocal` is `max E_p` over the points that the row's drawn triangles use in its own sub-band.
- `Ebar` stays as in T02: `sqrtUp(max E_ep²)` over all records in the row's own sub-band.
- Both are rational strings. All of these are null wherever the epoch is null.

**`k4Epoch`** is a reported baseline only. It never affects a row outcome.

- **Mesh.** The original region mesh, untiled.
- **Records.** The referenced source vertices.
- **Carrier.** One carrier at `bboxMidpoint` of the mesh vertices.
- **E.** `E_ep` on that carrier, with the row's sub-band.
- **C2.** D-A on all source triangles at the sub-band's `s_lo`.
- **Not run.** S4 and S5.
- **Values.** `ADMITTED`, `NOT_ADMITTED:<position|lane-range|term>` or `OUT_OF_DOMAIN`.

**Trajectories.** These do not certify. A frame's sub-band is assigned by the D-B rule, computed independently of the helper that builds sub-bands. Each trajectory adds the keys `subBandFrames[4]` and `subBandChanges`. `subBandChanges` counts consecutive non-cap frame pairs within one epoch whose `k` differs.

**Gates.** These are the frozen T02 gates without T02's sliver exemption, so they are stricter:

1. **Partition.** No row that passes S1-S3 fails S4.
2. **Class A.** The three class A rows are `ADMITTED` at their own cameras, and every camera variant is `ADMITTED`.
3. **No regression on O.** Every O acceptance row that T01 K1@256 admitted is `ADMITTED`. The source, filter and join are unchanged from T02, imported as T02's `T01_REPORT` and `T01_REPORT_SHA256`. C and L are reported, not gated.
4. **Frame coverage.** As in T02, plus: for every non-cap frame, exactly one `k` satisfies `lo_k < zq_f ≤ hi_k`, with the bounds computed independently. A violation is a coverage violation.

**Pre-registered prediction.** It is fixed before T03 runs. The predicted failure set R has 16 entries, each with a predicted outcome:

| Ids | Predicted outcome |
| --- | --- |
| `carrier/Z/depth-positive/star:nonzero/S5`, `carrier/Z/depth-positive/star:evenodd/S5`, `carrier/Z/depth-positive/zero-closure:nonzero/S5`, `carrier/Z/depth-positive/zero-closure:evenodd/S5`, all at `dpr` `"1"` (O) | `NOT_ADMITTED:triangle` |
| `S/TRI/k24/z1/d1/I/cam:v1`, `S/TRI/k24/z1/d1/R15/cam:v1`, `S/TRI/k32/z1/d1/I/cam:v1`, `S/TRI/k32/z1/d1/R15/cam:v1`, `S/TRI/k40/z1/d1/I/cam:v1`, `S/TRI/k40/z1/d1/R15/cam:v1` (A) | `NOT_ADMITTED:vertex` |
| `S/RECT/k24/z1/d1/I/cam:v2`, `S/RECT/k24/z1/d1/R15/cam:v2`, `S/RECT/k32/z1/d1/I/cam:v2`, `S/RECT/k32/z1/d1/R15/cam:v2`, `S/RECT/k40/z1/d1/I/cam:v2`, `S/RECT/k40/z1/d1/R15/cam:v2` (A) | `NOT_ADMITTED:vertex` |

**R may be stale.** R's outcomes come from the census, which used the two prototype readings that D-C and D-D replace. A mismatch caused only by those readings gives FAIL. It is a stale prediction, not by itself a mechanism defect, and it fails safe to a user decision.

**Rows in R also run S4 and S5,** after their C2 failure. The report records whether those pass.

**Verdict.** Exactly one of the following applies.

- **PASS:** all four gates hold.
- **FAIL-AS-PREDICTED.** All of the following hold:
  - gates 1 and 4 hold;
  - every gate 2 and gate 3 failure is in R, with exactly its predicted outcome;
  - every failing row in R passes S4 and S5.
- **FAIL:** anything else.

**What each verdict means.**

- **FAIL-AS-PREDICTED is not acceptance.** It means the deltas behave as designed and the remaining failures are exactly the grid-sliver set. That set goes to T04, the mitigation comparison, which needs its own contract and a user decision.
- **FAIL stops for a user decision.**

No threshold, prediction or delta is changed after results.

## Limits

- Everything in revision 3's limits.
- The runtime cost of sub-band recertification.
- The zoom-only U4 case (D-B).
- The fringe flips are not physical Delaunay, and they do not bound the minimum angle.
- The census is disclosure only.

## Ownership, validation and order

| Owner | Scope |
| --- | --- |
| Primary | This note; `extent-t03/local.ts` (D-A, D-B); the report harness, gates, prediction and evidence |
| Sol medium | `extent-t03/delaunay.ts` (D-C, exact-position order, guard, opposite-use assertion); the D-D owned set and centre; host tests for both, including the locality tests |
| Astra high | Contract review, stable-source review, evidence review |

**Host tests.**

- `c2Local` against brute force at the sub-band's `s_lo`.
- Dominance over `c2Merged` at δ = Ē.
- Single-rotation and best-rotation cases.
- Sub-band boundary assignment: a frame exactly on an inner bound goes to the lower sub-band.
- The D-C and D-D locality tests.
- The T02 and T01 pinned hashes.

**Validation.** `pnpm check`, `pnpm test:geometry`, `pnpm build`, the T03 write and replay, and the Markdown and link checks. Reporting `subBandsAdmitted` runs S2 and S3 four times per row. The write budget is therefore 3 hours, sharded per corpus as in T02.

**Order.** `T02 FAIL evidence integrated -> this draft -> independent review -> FROZEN -> T03 implementation -> T03 evidence and review -> (FAIL-AS-PREDICTED) T04 contract, or (FAIL) user decision -> O03`.
