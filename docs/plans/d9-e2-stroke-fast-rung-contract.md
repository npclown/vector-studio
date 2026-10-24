# D9 E2: stroke seam merge, band leaves and the family-B rung

Status: **DRAFT for independent review**, documentation only. Questions E2-Q1 to E2-Q4 are answered by their recommended option (a), adopted automatically on 2026-10-24 under the user's standing instruction ([section 10](#10-questions-and-decisions)).

This is rendering-track item E2 ([D9 rendering track](d9-rendering-track.md#status-index)), the ST-U9 family-B fast-rung contract that [D9](d9-post-mvp1-tracks-proposal.md#rendering-track-engine) lists and the [B2 stroke contract](p3-b2-stroke-contract.md#121-units) defers to. The user moved E2 from the backlog to phase R1 on 2026-10-24, with the cause investigation E14, because stroke `work-limit` blocks the P3 exit sweep. It is full tier: it changes stroke output, adds a sufficient condition to a precision obligation and sets caps. It changes no threshold of the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b), no tolerance and no share of the 0.25 px budget. Identifiers use the prefix **E2-**.

D9 asks this contract to fix "the certificate, the fallback rule to family A and its own performance gate", and to decide E2-alt (raise `STROKE_V0_LIMITS`, or a swept crossing collector above 64 edges) citing E1's result. Sections 4 to 7 do that.

## 1. Cause

The [cause record](../evidence/e2-stroke-work-limit-cause-2026-10-24.md) runs the 1,000 strokes of the E11-U2 scene `p3-exit-stress/v1` natively at `stroke-v0+r4`. 121 mesh. Of the 879 `work-limit` rows, 712 are `Front(PieceLimit)` (more than 512 pieces), 140 `Rounded(InputLimit)` (more than 1,024 arrangement input vertices), 109 `Front(DepthLimit)` (very wide or looping strokes), and only 15 are arrangement cost classes (`NodeLimit`, `EventLimit`).

- **No stroke wider than 0.16 device px meshes** on these smooth closed paths. Piece demand grows about linearly with the device width, about 800 pieces per device px, at about 5.9 hull vertices each.
- **Mechanism.** B2 [§4.5](p3-b2-stroke-contract.md#45-cubic-leaves) accepts a cubic leaf only when `deltaUp + 4·r·sinUp + gCtrl + gOff ≤ 2^e`. The term `4·r·sinUp` is linear in the half width `r` and in the leaf's normal turn, so for a fixed path the leaf count is proportional to `r / 2^e`. Each leaf is a separate contour of about six vertices, and the arrangement admits 1,024 vertices.
- **E1's result** ([E1.1](p3-b2-stroke-contract.md#e11-where-failing-strokes-spend-their-time)): the costly crossing class is `NodeLimit`, which is not abortable. On this scene that class is small (12 rows), so arrangement cost is not what fails ordinary strokes.

## 2. Decision on E2-alt

E2-alt is **not pursued** (E2-Q1 (a)). `STROKE_V0_LIMITS` stays as it is. A 1 px stroke on the scene's rings needs about 7,500 input vertices and a 16 px stroke about 100,000; the exact all-pairs arrangement at those sizes would trade `work-limit` for unbounded time. The `ok` strokes already take 45 ms median per path natively (diagnostic). A swept crossing collector addresses crossing cost, which is not the failing class here. E2-alt may be reopened only if the scene report after E2-U3 (section 8) shows arrangement cost classes as the largest `work-limit` class.

E2 instead removes the two multipliers: six vertices per leaf (E2-K1) and leaves proportional to width (E2-K2), and adds a fast rung for strokes whose merged outline is simple (E2-K3).

## 3. Terms

- **Piece**, **canonical triple** `(E−, C, E+)`, **hull** and **seam**: as B2 [§4.2](p3-b2-stroke-contract.md#42-pieces-and-canonical-samples). Consecutive sweep pieces share their seam triple bit for bit.
- **Band quad** of a sweep piece (ST-P1 or ST-P2) between samples `a` and `b`: the polygon `E−(a), E−(b), E+(b), E+(a)`.
- **Band piece**: a sweep piece whose band quad is strictly convex and positively oriented, decided by exact `orient2d` on its four consecutive vertex triples.
- **Winding sum.** For a set of oriented polygons, the winding number at a point not on an edge is the sum of their winding numbers. It is a function of the multiset of directed edges only.

## 4. E2-K1: seam merge (lossless)

Per path, after the front end and before resolution (B2 [§4.1](p3-b2-stroke-contract.md#41-pipeline) step 4):

1. **Piece polygons.** Every piece that is not a band piece contributes its hull, unchanged. A band piece contributes its band quad, plus, as an extra vertex on its seam, each of its two samples `C` that lies strictly outside the quad (exact `orient2d` against the seam) and is not covered by the neighbour across that seam.
2. **Covered.** `C` is covered when a neighbouring piece shares the seam triple and `C` lies in that neighbour's band quad (a band piece) or hull (any other piece), decided by exact `orient2d` against each of its edges. A hull neighbour always covers it, because `C` is one of the points of its hull. The test uses quads and hulls only, never another step-1 polygon, so it has no circularity.
3. **Cancellation.** In the multiset of directed edges of all piece polygons of the path, remove each pair of opposite edges whose endpoints are bit-identical.
4. **Contours.** Trace the remaining edges into closed contours. At a vertex with several outgoing edges, take them in emission order (B2 [§4.9](p3-b2-stroke-contract.md#49-emission-order-and-determinism)). Contours may touch at vertices.

**Why it is lossless.** Every piece is positively oriented and simple, so under nonzero the stroke region is the union of the pieces. A band piece's hull is the convex hull of its quad and its two samples `C`, so a `C` inside the quad adds nothing. A `C` outside the quad adds at most the triangle `E−, C, E+`. When `C` is covered, that triangle lies in the neighbour's polygon, which is convex and contains all three points, so dropping it leaves the union unchanged; otherwise `C` is kept. Steps 3 and 4 keep the edge multiset's winding sum, so the winding number at every point off the edges is unchanged. The union of the pieces, and therefore every precision obligation of B2 sections 3 and 4, is unchanged. Only the arrangement input changes.

**Effect.** A run of `n` band leaves becomes about `2n` vertices in one contour (two rings on a smooth closed subpath) instead of `n` contours of about six vertices. The projection gives 275 of the scene's 750 non-looping strokes within the caps, against 142 today.

## 5. E2-K2: the band leaf rule

A second, alternative acceptance test for a cubic leaf, beside B2 §4.5's (which is unchanged). With the leaf's computed controls, cone set, `V`, `aLow` and the ST-G4 guards as §4.5 defines them:

```text
c2Up = 2 · max(|D1 − D0|, |D2 − D1|) · (1 + 2^-40)
Kup  = c2Up · |V|² / aLow² · (1 + 2^-40)            curvature bound: |C''| / |C'|², |C'| ≥ aLow / |V|
lUp  = (|D0| + |D1| + |D2|) / 3 · (1 + 2^-40)       control-polygon length
require  aLow > 0  and  r · Kup ≤ 1/2               no fold of either offset
KO   = Kup / (1 − r · Kup),  lO = lUp · (1 + r · Kup)
require  KO · lO ≤ π/2
accept when  KO · lO² / 8 · (1 + 2^-40) + gCtrl + gOff ≤ 2^e · (1 − 2^-40)
             and the leaf is a band piece (section 3)
```

A leaf that this test does not accept is tested by §4.5; if neither accepts, it splits, as today. Depth 20 and the piece caps are unchanged.

**Proof obligation E2-P1.** Under `r · Kup ≤ 1/2`, the ideal band (the union of the normal segments of B2 §2.2 over the leaf) is the region bounded by the two offset curves `C ± r·N` and the two end normal segments, and each offset curve is regular with tangent parallel to `C'`. Each offset has curvature at most `KO` and length at most `lO`. By Schur's comparison theorem, a curve with curvature at most `K` and length `l ≤ π/K` lies within `K·l²/8` of its chord. The band quad is bounded by the two chords and the same end segments up to rounding, so the two-sided Hausdorff distance between the regions (the metric of the B2 [§3 S1 amendment](p3-b2-stroke-contract.md#3-precision)) is at most `KO·lO²/8` plus the guard terms. Unit E2-U2 writes the full argument in the stage-to-proof table, including the step from boundary deviation to region distance for two strips with shared ends; the independent review checks it before code merges. The term `4·r·sinUp` does not appear, so the leaf count no longer grows with the width.

**Effect.** Projected 326 of 750 within the caps with E2-K1. On four-cubic circles at `e = −3`: radius 64 width 4 needs 64 leaves (256 today), radius 1,024 width 1 needs 256 (408 today). A leaf whose inner offset folds stays on §4.5.

## 6. E2-K3: the family-B rung and its fallback

After E2-K1, a path whose contours are line polygons only (always true for strokes) runs the polygon stages of Alt-A1 rung 0 ([stages](p3-alt-a1-fill-ladder-contract.md#31-rungs-and-stages)) on its contours as a line-only fill input: FR1, FR3 to FR8 and AL-FR9, under nonzero, with clearance `2^(e−1)` (twice the stroke's `τ = 2^(e−2)`). S1 and FR2 are not run: the contours have no source curves, and every edge is its own source, as on a line-only fill path.

- **Certificate.** Rung 0's proof that the polygon set is simple with the stated clearance, consistently oriented and nested (FR4 to FR6), so that its triangulation (FR7, FR8) covers exactly the nonzero region. With E2-K1 that region is the union of the pieces.
- **Result.** A proved path is published with rung 0's output form ([Alt-A1 §3.5](p3-alt-a1-fill-ladder-contract.md#35-output-form-of-a-fast-mesh-and-the-always-on-check-al-fr9)), after AL-FR9. Its vertices are the piece vertices, unrounded.
- **Fallback.** Any rung 0 reason, or more than `STROKE_B_MAX_POINTS` vertices, sends the path to family A: the existing arrangement under `STROKE_V0_LIMITS` on the E2-K1 contours, then B2 §4.1 step 5. Its result, mesh or failure, is the path's result. One output per path, deterministic.
- **What falls back.** Pieces that overlap make the contours non-simple: the inner side of a corner join, cusp disks, folded offsets and crossings of the path with itself. Those strokes stay on family A, as all strokes are today.
- **Instance.** A separate rung instance sized from E2's own cap, so a fill-side cap change (E14) does not change stroke limits.

## 7. Caps, identity and performance gate

| Cap | Today | Under E2 |
| --- | ---: | --- |
| `MAX_PIECES` | 512 emitted pieces | 512 contours after E2-K1 (equal to `max_contours`) |
| `MAX_PIECE_RECORDS` | 4,096 | unchanged; it now bounds the leaves |
| `STROKE_V0_LIMITS` | section 7.6 | unchanged (E2-alt not pursued) |
| `STROKE_B_MAX_POINTS` | — | 4,096 contour vertices for E2-K3; above it the path goes to family A |

- **Identity.** Each unit that can change an `ok` mesh bumps the stroke revision (B2 [§7.1](p3-b2-stroke-contract.md#71-identity)): E2-U1 `r5`, E2-U2 `r6`, E2-U3 `r7`. The E11 exit snapshot takes the last one. The E3 stroke rows are measured on it, or re-run by E3-R4 if E3-U5 runs first (E2-Q3 (a)).
- **Precision label.** Unchanged: UNVERIFIED until E3's measurement.
- **E2-G1, outcomes (deterministic).** Every stroke that is `ok` at `r4` in ST-F1 to ST-F26, SC01 to SC22, the E1 corpus and the scene stays `ok`. No row moves to `unsupported-geometry` or `numeric-range`.
- **E2-G2, cost (diagnostic A/B).** In one native release run on one machine, the per-stroke median time of the new revision on the ST-U3b families and on the scene's `r4`-`ok` strokes is at most 1.10 × the `r4` median, per family. A failure blocks the unit. This is a gate, not a performance claim.
- **E2-G3, claims.** E2 makes no speed claim. A claim needs a committed record under [`docs/benchmarks/README.md`](../benchmarks/README.md).

## 8. Acceptance, fixtures and validation

Fixtures at `e = −3`, zoom 1, DPR 1, butt cap and miter join unless named; "today" is `r4` ([cause record](../evidence/e2-stroke-work-limit-cause-2026-10-24.md#four-cubic-circles-at-e--3-zoom-1-dpr-1)).

| Fixture | Path and width | Today | Expected |
| --- | --- | --- | --- |
| E2-F1 | Four-cubic circle, radius 64, width 1 | `ok` | `ok` after every unit (regression control) |
| E2-F2 | Circle, radius 64, width 4 | `work-limit` (`InputLimit`) | `ok` from E2-U1 |
| E2-F3 | Circle, radius 256, width 16 | `work-limit` (`PieceLimit`) | `ok` from E2-U2 |
| E2-F4 | Circle, radius 16, width 16 (inner offset folds) | `work-limit` | E2-K2 refuses every leaf; E2-K3 refuses; outcome unchanged (negative control) |
| E2-F5 | Circle, radius 1,024, width 1 | `work-limit` (`InputLimit`) | `ok` from E2-U1 |
| E2-F6 | Square of four lines, side 100, width 4 | `ok` | `ok`; E2-K3 refuses (corner overlap), family A on E2-K1 contours |
| E2-F7 | Open two-cubic S curve, width 4, round caps | recorded by E2-U1 | `ok` through E2-K3 from E2-U3 |
| E2-F8 | Scene path 3 (looping) | `work-limit` | E2-K3 refuses (crossing); outcome recorded |

| ID | Criterion | Unit |
| --- | --- | --- |
| E2-A1 | E2-G1 and E2-G2 pass | each |
| E2-A2 | The fixture table holds | each |
| E2-A3 | ST-O1 passes on every dumped output of E2-F1 to E2-F8 and the SC suite | each |
| E2-A4 | Lossless merge: for every fixture and every scene stroke, the winding number of the E2-K1 contours equals the winding sum of the hull pieces at a fixed sample set (cell centres of the arrangement, exact) | U1 |
| E2-A5 | Every E2-K3 mesh passes AL-FR9 and the `triangle-mesh` oracle, and its covered region equals the E2-K1 contours' nonzero region at the same sample set | U3 |
| E2-A6 | Seeded defects are caught: E2-D1 step 2 skipped (A4 fails); E2-D2 the fold test removed (E2-F4 accepted, ST-O1 fails); E2-D3 the bound halved (ST-O1 fails on E2-F3); E2-D4 FR5 skipped in E2-K3 (E2-F6 or E2-F8 published, A5 fails) | U1-U3 |
| E2-A7 | Scene report: `pnpm p3-exit:sweep --scene` on the release WASM after each unit, with the stroke `ok` count, the cause breakdown and zero structure issues, appended to the cause record. The projections (275, 326) are for comparison, not a gate | each |

**Validation per unit.** `pnpm check`, `pnpm build`, `pnpm test:geometry` (native kernel tests including the new fixtures and seeded defects), the E2-G2 A/B run, and the scene report. No GPU or headed run is needed: E2 changes mesh content, not the renderer. The E3 stroke rows follow E2-Q3.

## 9. Units

| Unit | Tier | Scope | Files |
| --- | --- | --- | --- |
| E2-U1 | Full | E2-K1, the `MAX_PIECES` reading of section 7, `r5`, E2-F1 to E2-F8 recorded, E2-A4, E2-D1 | `stroke_outline.rs`, a new merge module, its tests |
| E2-U2 | Full | E2-K2 with the E2-P1 stage-to-proof entry, `r6`, E2-D2, E2-D3 | `stroke_outline.rs`, tests |
| E2-U3 | Full | E2-K3, `STROKE_B_MAX_POINTS`, the separate rung instance, `r7`, E2-A5, E2-D4 | `stroke_outline.rs`, `fill_ladder.rs` (a line-only entry that skips S1 and FR2, with no change to the fill rung's stage order or outcomes), tests |

Each unit: independent review of the diff and evidence; it starts only when the rendering track's WIP limit allows. The order is fixed: E2-K2 and E2-K3 assume E2-K1's contours. B2 [§12.1](p3-b2-stroke-contract.md#121-units)'s ST-U9 row points here.

## 10. Questions and decisions

**E2-Q1. Which remedy?** (a) **Recommended.** E2-K1 to E2-K3 in three units; E2-alt not pursued; `STROKE_V0_LIMITS` unchanged. (b) E2-alt: raise `STROKE_V0_LIMITS` (a 1 px stroke needs about 7,500 vertices, with all-pairs cost). (c) E2-K1 only (projected 275 of 750, nothing above about 1 px).

**E2-Q2. Caps.** (a) **Recommended.** Section 7's table: `MAX_PIECES` caps contours after the merge, records stay 4,096, and E2-K3 has its own 4,096-vertex cap separate from the fill prefix. (b) Keep 512 emitted pieces: the 712 `PieceLimit` rows stay `work-limit` whatever the merge saves.

**E2-Q3. Revisions and E3.** (a) **Recommended.** One revision per unit; land before E3-U5's stroke measurement where possible, else re-run the E3 stroke rows (E3-R4). (b) One bump after E2-U3, which would hold merged code unexposed.

**E2-Q4. Cost gate.** (a) **Recommended.** E2-G2 at 1.10 × median, native A/B, not a claim. (b) No time gate: a slower certificate could pass unnoticed.

**Decision record.** 2026-10-24: E2 promoted to R1 by the user ("추천대로 진행해", in chat, with E14). E2-Q1 to E2-Q4 (a): recommended options adopted automatically on 2026-10-24 under the user's standing instruction of 2026-10-24 (auto-adopt the recommended option and notify). The contract is approved when the independent review is READY.

## 11. Risks

- **E2-R1, proof gap in E2-P1.** The boundary-to-region step is sketched, not written. Mitigation: E2-U2 writes it; ST-O1 checks every output; E3 measures. If it cannot be closed, E2-U2 is dropped and E2-U1 and E2-U3 still apply.
- **E2-R2, near-continuous knots.** Snapped smooth knots that are not exact continuations emit join pieces whose inner sides overlap, so E2-K3 refuses them. E2-A7 reports how many; a follow-up may treat joins below a turn bound as continuations, by its own contract.
- **E2-R3, large radii.** Paths above about 256 device px exceed any cap here, as for fill. That is E14 and R2 (tiling), not E2.
- **E2-R4, fill rung coupling.** E2-U3 adds a line-only entry to `fill_ladder.rs`. The fill rung's outcomes must stay bit-identical (Alt-A1 §5.1 outcome identity), checked by the existing ladder identity tests.

## 12. Review record

None yet.
