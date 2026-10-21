# P3 B2 stroke contract: semantics, `stroke_v0` transport and `StrokeMeshPort`

Status: FROZEN 2026-10-20 as unit ST-U1 of the approved [B2 stroke proposal](p3-b2-stroke-proposal.md). The user approved that proposal on 2026-10-20 and answered B2-Q1 to B2-Q9 with (a) each ([approval record](p3-b2-stroke-proposal.md#8-review-and-approval-record)). **Independent review NOT RUN — owed.** The user skipped independent reviews for 2026-10-20 only; the review of this contract is owed and runs before ST-U3, the first kernel unit, merges (section 12.3). **That gate was overtaken; see the ST-A0 amendment below.** Full tier: this contract fixes a public scene field, a new geometry port, a new kernel export family and new visible behavior. It is documentation only. No code, run or record follows from it. The [P3 plan](p3-fill-stroke-meshes.md) owns status.

Amended 2026-10-20 by [ST-U3](p3-fill-stroke-meshes.md#b2-st-u3-line-stroke-kernel), stricter only, as §4.4-4.7 permit. ST-G1 adds the condition that the squared segment length `d̃·d̃` is finite and normal (otherwise `numeric-range`). ST-G3 becomes `64u(‖B‖∞ + r·L³) ≤ 2^(e−1)`, and a kept miter with `L > 2^24` is `numeric-range`; the frozen `32u·L²` underestimates the `1 + d̂` cancellation, which ST-U3 measured at about 1.46·u·ratio³. No fixture outcome changes. ST-F13x (`M(0,0) L(1,1) L(4,4)`, expectation in the τ band) is added beside ST-F13 for ST-D3, because ST-F13's directions (3,1) and (9,3) normalize to the same binary64 unit vector. §7.7's wording is corrected: at e = −1020, 2^(e−4) is subnormal; the code handles it exactly. §4.2's "rounded once" is `C ± fl(r·N)`, two roundings, which ST-G1's bound covers.

Amended 2026-10-20 by [ST-U4](p3-fill-stroke-meshes.md#b2-st-u4-cubic-stroke), stricter only, as §4.5 permits. ST-G4 gains terms for the control error `ε = (4ℓ + 16s)·2^-53·M` per coordinate (`s = 1` on the two ranges of a reversal split): `aLow` loses and `bUp` gains `20·ε·|V|`; `gCtrl` gains `5ε + 3r·max(dN_start, dN_end)`, where `dN = (18·ε·|V| + [end at a reversal split] 600·2^-53·M²)/aLow + 8·2^-53` bounds a computed end normal, a knot's bound is inherited by the next leaf, and a source end has `dN = 0`; a leaf next to a reversal split adds `κ·(|V| + 2r)` with `κ = 2^-52/` (its parameter length). The frozen terms all stay. A non-collinear cubic needs `2^-250 ≤ M ≤ 2^250` (else `numeric-range`), so that no product overflows and `768·2^-53·M²` stays normal. §4.5's "stationary parameter" includes the split `t̃` on both sides of a reversal.

- **Algorithm change (§4.6).** `t̃` is the largest binary64 `≤ t*`, found by bisection on bit patterns with the exact sign of `t − t*`; it is no longer "the Float64 evaluation of `t*`". This applies to both the reversal and the collinear turning points. Proof: `|t̃ − t*| ≤ 2^-53`, and `C′(t*) = 0`, so `|C(t̃) − C(t*)| ≤ ½·34M·2^-106` plus the de Casteljau rounding `√2·15.1u·M`, about `21.4u·M`, which is below ST-G5's `η = 64u·M`. ST-G5 and its requirement `2η ≤ 2^(e−4)` are unchanged. A root with `t̃ = 0` is `numeric-range`.
- **Fixture expectations do change.** ST-U4's ST-F16 note below is one; the ST-U4 fixtures `ST-F16p`, `ST-U4/folded-arc` and `ST-U4/tip-ratio` are added.

Amended 2026-10-20 by user decision (chat, 2026-10-20), with the ST-A0 review, recorded by [ST-U4](p3-fill-stroke-meshes.md#b2-st-u4-cubic-stroke):

- **ST-F16 becomes a current-cap fixture.** At `STROKE_V0_LIMITS` its expected status is **`work-limit`**: the front end completes (91 pieces), and the unchanged arrangement stops it with `NodeLimit`.
- **Its literals are kept.** One interior reversal at `t* = 1/2`, cusp center exactly `(0.5, 0.75)`, `n = 32`, and `(0.5, 0.8)` inside. They are checked under the named `cfg(test)` limit set `WIDE_TEST_LIMITS` of §7.6.
- **Cost moves to ST-U9.** The measured arrangement cost is 78,314 nodes, 101,537 sections, 1,076 columns and 553,015,839 work units, against 8,192 nodes and 64,000,000 work. That makes cubic-stroke performance an ST-U9 (certified fast rung) item.
- **Reference measurements.** ST-F15 R5 at `e = −3` stops at `NodeLimit` and is `ok` under `WIDE_TEST_LIMITS`, with 69,881 nodes and 120,932,305 work units. R6 at `e = −3` stops at `EventLimit`, and under `WIDE_TEST_LIMITS` it stops at 262,144 nodes.
- **ST-F16p is added**, so that ST-S8 keeps evidence at production limits. It is ST-F16's curve and width at `e = −5`. Its literal was fixed before its first run: `ok` at `STROKE_V0_LIMITS`, one cusp disk at `t = 1/2` with center exactly `(0.5, 0.75)` and `n = 8`, and `(0.5, 0.8)` inside.
- **The §7.6, §11.2, §11.3 and §12.2 dated notes** carry the rest.

Amended 2026-10-20 by [ST-U4](p3-fill-stroke-meshes.md#b2-st-u4-cubic-stroke), after the ST-A0 review, correcting ST-U3's ST-G3:

- **The defect.** ST-U3's `64u(‖B‖∞ + r·L³)` used the user's limit `L`, not the actual ratio. So `M(0,0) L(10,0) L(10,10)`, `w = 20`, `L = 1e4`, `e = −3` (ratio `√2`) was `numeric-range`, and any kept miter with `L > 2^24` failed.
- **The correction.** ST-G3 now uses a certified upper bound `ρ` of the actual ratio. ST-U3 proved `|fl(1 + d̂) − (1 + d)| ≤ 14.3u`, so `c² ≥ (fl(1 + d̂) − 15u)/2` when that is positive. Then `ρ = min(L, √(2/(fl(1 + d̂) − 15u))·(1 + 2^-40))`, with the subtraction rounded down; otherwise `ρ = L`.
- **The guard.** A kept miter needs `ρ ≤ 2^24` and `64u(‖B‖∞ + r·ρ³) ≤ 2^(e−1)`, else `numeric-range`. ST-U3's proof holds with `ρ` in place of `L`, because it uses only `c ≥ 1/L`.
- **Strictness.** The guard is at least as strict as the frozen `32u(‖B‖∞ + r·L²)` with the actual ratio in place of `L`, since `ρ ≥ ratio ≥ 1`.
- **Fixtures.** The path above is added as fixture `ST-U4/tip-ratio`: a kept miter, `ok`, area 400. ST-F5, ST-F24 and ST-F25 keep their literal results; ST-F24 at `L = 2^30` has `ρ ≈ 2^21`, which still gives `numeric-range`.

Amended 2026-10-20 (revised 2026-10-21 after the PR #176 reviews), ST-A0 amendment (unit `claude/p3-b2-st-a0-contract-amendments`, documentation only), applying the ST-A0 review. Dated notes and targeted corrections only; no requirement, threshold, user decision (B2-Q1 to B2-Q9, the ST-F16 decision, V1-Q4) or past evidence text changes. Each finding is tagged B, S or M as in the review.

- **B2, review gate.** ST-U3 (#169) and ST-U5 (#174) merged before the review findings were applied, under the user's 2026-10-20 exception, which skipped independent reviews for that day. The ST-A0 contract review did run, before ST-U5 merged, with verdict **NOT READY** (blocking B1 and B2, eight SHOULD-FIX items, five minor ones). The gate now reads: **ST-A0 is met when the ST-A0 amendments land, with an independent review of them READY (or READY WITH FOLLOW-UPS and its follow-ups recorded), before ST-U6 merges**. This keeps the READY requirement of the frozen ST-A0 criterion and moves only its deadline. Adopted findings apply to code already on `main` (for example S3 and S4 below, which ST-U6 implements, and the ST-U4 correction of ST-U3's ST-G3). The status line, §12.2's ST-A0 row, §12.3 item 1 and ST-OB1 carry the same pointer.
- **B1, ST-F16.** Already recorded by the ST-U4 notes above and the dated notes in §7.6, §11.2, §11.3 and §12.2: ST-F16 is a current-cap fixture (`work-limit` at `STROKE_V0_LIMITS`, `NodeLimit`), `WIDE_TEST_LIMITS` is `cfg(test)` only, ST-F16p evidences ST-S8 at production limits, and the ST-U4 note says "Fixture expectations do change". Verified against the text on `main`; nothing further was missing.
- **S2, tip guard.** Already applied by the ST-U4 note above (`ρ`, the certified upper bound of the actual ratio) and fixture `ST-U4/tip-ratio`.
- **M1, κ.** The plan's ST-U4 ST-G4 text and the code agree: `κ = 2^-52/(leaf parameter length)`, computed as `UNIT * 2.0 / (split_length * SLACK_DOWN)` at `packages/geometry-wasm/kernel/src/stroke_cubic.rs:511-514` with `UNIT = 2^-53`. The contract note's `κ = 2^-52/(its parameter length)` is the same value.
- **M2, `t̃`.** The ST-U4 note above is labelled **Algorithm change (§4.6)**; it is not a guard change.
- **S7, cubic `work-limit` findings.** Recorded only: the cubic findings (the canonical cusp at `e = −8` failing, R5 failing at zoom 1, 64 square-capped line subpaths exhausting `max_work`, and the resulting mostly-`work-limit` P3 stress scene) were **escalated to the user in chat on 2026-10-20 as the pending ST-U9 decision**. The [plan](p3-fill-stroke-meshes.md#b2-st-a0-contract-amendments) names that pending decision and the [ST-U3b recommendation](p3-fill-stroke-meshes.md#b2-st-u3b-scaling-probe) carries a pointer to the cubic fixtures. This amendment decides nothing about them.

Amended 2026-10-21 by the [ST-U4 cusp shared triple follow-up](p3-fill-stroke-meshes.md#b2-st-u4-cusp-shared-triple-review-follow-up) (ST-U4 post-merge review SF1), restoring §4.2 and bumping the §7.1 identity:

- **Defect.** At a non-collinear reversal, ST-U4's right range computed its own start triple from its own `D1`, so the cusp knot had two triples. They are mirror images in exact arithmetic, but in binary64 they differed by a few ulps. That broke §4.2's "every generated knot has exactly one sample triple", and the arrangement could fail with `TopologyAmbiguous` (`unsupported-geometry`).
- **Correction.** The right range's first leaf now starts from the left range's last end triple with `E−` and `E+` swapped, computed once, as collinear parts already did. Its normal error bound is that leaf's `dN`, which already contains the split end's limit-direction term. No guard formula changes. The proof is in the plan entry.
- **Revision 2 (§7.1 identity rule).** The change alters `ok` meshes, so the identity moves together: `operationId` `'geometry-wasm/stroke-v0+r2'` and `stroke_v0_revision() == 2`. The §7.1 table's v0 values are as frozen and are superseded by these. `stroke_v0_version()`, the magics, `abi_version()` and `fill_v0_*` are unchanged.
- **Measured effect** on the review's 100-case corpus: 85 results are bit-identical. 5 `ok` results change. Their piece inputs differ only in the right range's first start triple (1 to 2 ulps on four, 64 ulps on a coordinate near zero on the fifth), but the published meshes differ downstream: the arrangement no longer creates the sliver vertices of the duplicate triple, so they have fewer vertices and triangles (68→60, 102→84, 104→90, 66→56 and 326→322 vertices) and other vertices move by a few ulps. All five pass ST-O1 to ST-O3. 4 cases go from `unsupported-geometry` to `ok`. 6 `work-limit` cases change only in piece samples, and none has a mesh. No other status changes.
- **Fixtures.** `ST-U4/cusp-shared-a` and `ST-U4/cusp-shared-b` (the review's two reproductions, `ok`) and a bitwise one-triple-per-knot check are added. A reversal `2^-20` from a segment end is a listed `work-limit` class (`DepthLimit`), with a fixture.

Amended 2026-10-21 by the [ST-U2 oracle hardening follow-up](p3-fill-stroke-meshes.md#b2-st-u2-oracle-hardening-review-follow-up): ST-O3's band mode also bounds the symmetric difference, a test band stricter than the frozen wording; see the dated note in section 11.1.

**Evidence label.** Every stroke result under this contract is functional evidence. Until B4 has A04 evidence, every report, PR description and screenshot states that precision is **UNVERIFIED** against the 0.25 physical-pixel target, as D8 [requires](p3-d8-parallel-tracks.md#rules). Stroke work closes no A01-A08 criterion and no C03-C05 item.

**Identifiers.** This contract prefixes its own IDs with **ST-**: semantics rows ST-S1 to ST-S12, pieces ST-P1 to ST-P7, guards ST-G1 to ST-G6, oracles ST-O1 to ST-O5, fixtures ST-F1 to ST-F26, seeded defects ST-D1 to ST-D14, conformance cases SC01 to SC22, units ST-U2 to ST-U9 (with ST-U3b), acceptance ST-A0 to ST-A12, risks and open obligations ST-OB1 to ST-OB8. V2's cases C01-C18, V3's codes and the proposal's B2-Q1 to B2-Q9 keep their meaning.

## 1. Authority, scope and documents

### 1.1 Decisions this contract implements

| Decision           | Answer (all (a))                                                                                                                                        | Where fixed here       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| B2-Q1 algorithm    | Family A: outline pieces as positive simple polygons, resolved by the existing exact arrangement; a certified fast rung (family B) later only if needed | Section 4, ST-U9       |
| B2-Q2 cusp         | At an interior reversal of a cubic, add the disk of radius `w/2`; at a continuation, nothing; no user join at either                                    | ST-S8, section 4.6     |
| B2-Q3 thin strokes | Exact local geometry, no minimum width; coverage by A5                                                                                                  | ST-S3                  |
| B2-Q4 scene        | `PathStyle.stroke: PathStroke \| null`, required, explicit null                                                                                         | Section 5              |
| B2-Q5 dash         | No dash field in P3                                                                                                                                     | ST-S11                 |
| B2-Q6 opacity      | Staged: two exact draws at opacity 1 and for single-paint paths; both paints at `0 < opacity < 1` is a D8-interim failure until ST-U7                   | Section 9.6            |
| B2-Q7 precision    | Float64 regular-leaf bound with guards in production; A04 by B4's measurement; the deferred tighter bound stays deferred                                | Sections 3, 4.5        |
| B2-Q8 performance  | A native scaling probe on line strokes after ST-U3, no threshold, reported with a recommendation on ST-U9                                               | ST-U3b                 |
| B2-Q9 C04          | The D8 C04 carve-out extends to the stroke transport v0 and the stroke draw                                                                             | Section 10, ST-U5 note |

The Primary technical decisions of the proposal (separate `StrokeMeshPort`, separate `stroke_v0_*` family and engine, the precision split, the endpoint-stationary tangent rule, the culling bound) are fixed here as stated in the proposal, with the refinements this contract makes explicit in sections 3, 4 and 9.

### 1.2 Scope and non-goals

In scope: the stroke semantics, the precision rows, the scene field and its validation, the `stroke_v0_*` export framing, `StrokeMeshPort` and its adapter, the renderer composition, the algorithm, fixtures, oracles, seeded defects, units, acceptance and risks.

Out of scope, unchanged from the [proposal](p3-b2-stroke-proposal.md#1-authority-and-scope): dashes, non-scaling strokes, stroke outlining as an editor command, Boolean operations, stroke hit testing, gradients, P1 primitive strokes, K1 and E1-E3, and the C04 layout. ST-U7's joint-coverage design and ST-U9's fast rung each need their own addendum (section 12.1). No fill, P2 or V3 behavior changes before ST-U6, and ST-U6 changes V3 only as section 9 states.

### 1.3 Documents that change with the code

`AGENTS.md` requires an architecture update before or with a behavior change. This contract changes no frozen text elsewhere. Each listed unit appends dated pointer notes; none rewrites frozen text.

| Document                                                                                                  | Change                                                                                                                                                                                                                                                                                 | Unit       |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [`ARCHITECTURE.md`](../../ARCHITECTURE.md#geometry-contract)                                              | The V1 paragraph gains `StrokeMeshPort` beside `FillMeshPort`; its "fill only until stroke has its own approved contract" clause gets a dated pointer to this contract                                                                                                                 | ST-U5      |
| `docs/decisions/0002-path-scene-and-fill-mesh-port.md`                                                    | A dated note linking this contract; no decision change (ADR 0002 already says stroke gets its own port after B2)                                                                                                                                                                       | ST-U5      |
| [`docs/graphics-engine-architecture.md`](../graphics-engine-architecture.md#primitive-rendering)          | One paragraph after the Alt-A1 paragraph: the stroke operation `'geometry-wasm/stroke-v0'`, its outline-to-arrangement method, and its own engine                                                                                                                                      | ST-U5      |
| [`docs/plans/p3-private-contract.md`](p3-private-contract.md#private-transport-and-lifetime-requirements) | A dated pointer after the D8 carve-out: "Extended 2026-10-20 by user decision B2-Q9 (a) to the B2 stroke transport `stroke_v0` and the stroke draw, under the same conditions; see the [B2 stroke contract](p3-b2-stroke-contract.md)." The carve-out text is unchanged                | ST-U5      |
| [`docs/plans/p3-v3-renderer-mesh-pipeline-contract.md`](p3-v3-renderer-mesh-pipeline-contract.md)         | Dated amendment notes under sections a (style rows), b (stroke key and second port call), d (paint-tagged entries), f (stroke records and draws), g (fill-then-stroke order), h (`paint` context key, `composition-unsupported`) and j (fill and stroke ordering fixed functionally)   | ST-U6      |
| `docs/plans/p3-v2-fill-mesh-transport-contract.md`, Alt-A1 contract                                       | None. The fill export, its identity and its conformance suite are unchanged                                                                                                                                                                                                            | —          |
| `docs/requirements.md`                                                                                    | None. The new visible rows (cusp disk, no minimum width, opacity staging) are recorded in this contract, which the user approved through the proposal. The dash requirement stays in the [appearance model](../requirements.md#initial-appearance-model) for the later appearance plan | —          |
| `docs/plans/p3-fill-stroke-meshes.md`                                                                     | B2 row status, unit entries and evidence                                                                                                                                                                                                                                               | Every unit |

Amended 2026-10-20, ST-A0 amendment (S5), pointer on the ST-U6 row: V1-Q4's interim outcome (a path the kernel cannot fully mesh is not drawn, with the interim notice) is scoped by the private contract to D8 checkpoints V2 to V4. It **extends to B2 stroke failures** under the user-approved [proposal §5.6](p3-b2-stroke-proposal.md#56-renderer-composition-with-v3), whose failure bullet reuses that notice for strokes. **Hiding the fill when the stroke fails is the chosen reading** (§9.6 and §14); it is a Primary interpretation of that approved text, not a new user decision.

## 2. Semantics

All lengths are node-local units. A path has verbs and interleaved points as V1 fixed them, and a stroke `(width w, cap, join, miterLimit L)`. Let `r = w/2`.

### 2.1 Subpaths, drawing segments and tangents

- **ST-S1, drawing segments.** A subpath is a MOVE followed by its drawing verbs, up to the next MOVE or the end. Its drawing segments are its LINE and CUBIC verbs in order, plus, when it ends in CLOSE and its last point differs from its first point exactly, the closing line from the last point to the first. A segment is **zero-length** when all its points are exactly equal (a line `A = B`, a cubic `P0 = P1 = P2 = P3`). Zero-length segments are removed before any tangent, join or cap is decided, as the approved repeated-points row requires. A cubic with `P0 = P3` and other controls different is not zero-length.
- **ST-S2, one-sided tangents.** All tangents are exact differences of source points, never flattened or normalized values:
  - line `A → B`: `B − A` at both ends;
  - cubic start: the first nonzero of `P1 − P0`, `P2 − P0`, `P3 − P0`;
  - cubic end: the first nonzero of `P3 − P2`, `P3 − P1`, `P3 − P0`.

  The cubic rules are the limit tangent at a stationary endpoint (proposal section 3.7), so such an end is a regular end.

- **Source joins.** A source join is the point between two consecutive remaining drawing segments of one subpath, and, for a closed subpath with at least one remaining segment, the seam between its last and first remaining segments. Generated points inside a segment (subdivision knots, the cusp of section 2.5) are never joins.
- **Open subpath ends.** An open subpath with at least one remaining segment has a start cap at the start of its first remaining segment and an end cap at the end of its last. A closed subpath has no caps.

### 2.2 The stroke region

The stroke region is the union of these closed sets:

1. **Sweeps.** For each remaining segment, the union over its regular parameters of the normal segments `[C(t) − r·N(t), C(t) + r·N(t)]`, `N` the unit left normal of `C'(t)`. For a line, its rectangle.
2. **Joins** at source joins (ST-S5, ST-S6).
3. **Caps** at open ends (ST-S7).
4. **Cusp disks** at interior reversals of cubics (ST-S8).

The fill's implicit closing edge of an open subpath is never stroked, and the fill rule does not affect the stroke. The region is a union, so overlap is covered once: a self-overlapping stroke never accumulates alpha. The proposal's [section 3.1](p3-b2-stroke-proposal.md#31-the-stroke-region) is this definition; this section is normative.

### 2.3 Rows

| ID     | Case                                   | Output                                                                                                                                                                                                                                                                  | Source          |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| ST-S3  | Width                                  | Finite and `≥ 0`. `w = 0` gives no stroke and no port call. Negative or nonfinite width is invalid. **No minimum width**: thin strokes keep their exact local geometry and fade by A5 coverage                                                                          | Approved; B2-Q3 |
| ST-S4  | Miter limit, cap, join validity        | `L` finite and `≥ 1`, required for every join kind; cap in `butt, round, square`; join in `miter, round, bevel`; no public defaults                                                                                                                                     | Approved        |
| ST-S5  | Bevel, round and miter joins           | At a turn, with `O_in` and `O_out` the outer offset points: bevel is the triangle `(B, O_in, O_out)`; round is the disk of radius `r` at `B`; miter is the bevel plus the triangle `(O_in, T, O_out)` to the miter tip `T` when the miter test keeps it, else the bevel | Approved        |
| ST-S6  | Miter test, continuation and reversal  | Miter iff (distance from `B` to `T`) / `r ≤ L`, equality keeping the miter (section 4.3). An exact forward continuation (cross 0, dot > 0) adds no join. An exact reversal (cross 0, dot < 0): miter falls back to bevel, bevel adds nothing, round adds the disk once  | Approved        |
| ST-S7  | Caps                                   | Butt: nothing. Square: the rectangle of length `r` beyond the end along the outward end tangent, width `w`. Round: the disk of radius `r` at the end point                                                                                                              | Approved        |
| ST-S8  | Interior stationary point of a cubic   | Interior reversal (cusp): the disk of radius `r` at `C(t*)`. Continuation: nothing. Never a user join                                                                                                                                                                   | B2-Q2           |
| ST-S9  | MOVE-only; fully collapsed closed      | Empty                                                                                                                                                                                                                                                                   | Approved        |
| ST-S10 | Open subpath, all segments zero-length | Butt empty; round a disk of radius `r`; square a local-axis-aligned square of side `w`, both at the point. Coincident caps of one point form one region                                                                                                                 | Approved        |
| ST-S11 | Dashes                                 | Not representable in P3: `PathStroke` has no dash field (B2-Q5), so no dash intent can be expressed or silently ignored                                                                                                                                                 | Approved; B2-Q5 |
| ST-S12 | Coordinate space                       | Scaling strokes: the region is node-local and mapped by the node's world affine, the camera and the DPR. A non-uniform map makes the screen width vary with direction. A singular world linear map draws nothing. No constant-screen-width stroke                       | Approved        |

**Regular near-reversals and folds.** A regular curve near a reversal is refined as a regular curve; it is never snapped to a reversal by an epsilon (P3.0b-s1). Where the curvature radius is below `r`, the inner offset folds; the union definition covers the fold.

**Composition with fill.** Unchanged from the approved invariant: `L = S + F·(1 − S.a)`, `P = L·opacity`, source-over, with fill and stroke attributed separately until composition. Section 9 states which draws satisfy it.

## 3. Precision

The total stays 0.25 physical px with the private contract's [three rows](p3-private-contract.md#numeric-compatibility-decision). Inside them, the stroke operation uses this split, a technical choice inside existing rows that changes no threshold. `e` is the request's tolerance exponent, chosen by the renderer as V3 chooses it for fills, so that `2^e·sigmaMax(S) ≤ 0.125` ([V3 section c](p3-v3-renderer-mesh-pipeline-contract.md#c-tolerance-and-fringe-buckets)); a local distance `2^k` then maps to at most `2^(k−e)·0.125` physical px in every direction.

| Private-contract row             |  Share | Stroke use                                                                                                                              | Local bound per piece |
| -------------------------------- | -----: | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------: |
| Curve to intended boundary       |  0.125 | Sweep pieces of lines and cubic leaves (offset, normal and hull error), miter tips, square caps, cusp-disk centers, all guards          |                 `2^e` |
| Topology, intersections and arcs | 0.0625 | Round joins, round caps and cusp disks as inscribed polygons: sagitta plus construction `≤ 2^(e−2)`; arrangement rounding `τ = 2^(e−2)` | `2^(e−2)` + `2^(e−2)` |
| Float32 storage and projection   | 0.0625 | V3's packing, unchanged                                                                                                                 |                     — |

- **Union of pieces.** If every emitted piece lies within Hausdorff distance `h` of its ideal piece, the union of the emitted pieces lies within `h` of the ideal region. So the per-piece bounds carry to the region with no sum over pieces.
- **Resolution.** The arrangement resolves the union of the emitted pieces exactly up to its rounded embedding at `τ`. The stroke uses `τ = 2^(e−2)`, half the fill's `2^(e−1)`, because the stroke shares the topology row with arcs ([V2 section d](p3-v2-fill-mesh-transport-contract.md#d-tolerance) is unchanged for fills).
- **Region, not only position.** The region is resolved exactly from the emitted polygons (section 4.8), so the obligation that remains is per piece, as P3.0b-s1 [requires](p3-stroke-boundary-certificate.md#proof-boundaries-and-next-numerical-checkpoint).
- **Evidence method.** A04 for strokes is evidenced by B4's measurement on a frozen corpus against the independent oracle (B2-Q7). The construction bounds of section 4 are design obligations with a stage-to-proof table, checked by ST-O1 on every dumped output. They are not a precision claim.

Amended 2026-10-20, ST-A0 amendment (S1):

- **The metric.** The "Hausdorff distance `h`" of the union bullet above is the **two-sided Hausdorff distance between closed regions** (each emitted piece against its ideal piece, then the union against the ideal union), **plus the no-crack property** of §4.2 (no gap opens inside the ideal region). It is not a bound on boundary displacement.
- **Residual: hole closing.** A two-sided Hausdorff bound of `h` does not stop an ideal hole or gap narrower than `2h` from closing (for example the inner hole of a small closed ring). The private contract's curve and topology rows speak of boundary displacement, so this direction is **a stated residual, to be measured by B4's A04 metric** (ST-OB3). It is not claimed here.

## 4. Algorithm

### 4.1 Pipeline

Per path, after the stages that decide before any geometry (section 7.8):

1. **Decode** subpaths and drawing segments, remove zero-length segments (ST-S1), compute the exact one-sided tangents (ST-S2).
2. **Classify** each cubic's stationary points exactly (section 4.6).
3. **Emit pieces** in the fixed order of section 4.9: sweep pieces per segment (lines in one piece, cubics in leaves), cusp disks, join pieces, cap pieces. Every piece is a **positively oriented convex polygon** (section 4.2).
4. **Resolve** the piece set with `RoundedFillWorkspace::tessellate(pieces, Nonzero, τ = 2^(e−2))` under `STROKE_V0_LIMITS` (section 7.6). Each piece is one contour. With every piece positive and simple, the winding number is at least 1 exactly on the union, so nonzero gives the union.
5. **Refine and derive boundary** with V2's conforming cell-ladder refinement, once-only boundary scan and ledger cross-check ([V2 section f](p3-v2-fill-mesh-transport-contract.md#f-boundary-edges)), reusing `FillScratch` reserved from `STROKE_V0_LIMITS`.

The arrangement code, the refinement and the boundary scan are reused unchanged; the stroke engine passes its own limits and tolerance. The Alt-A1 fast rung is not used: stroke pieces share edges by construction, which its clearance condition rejects ([proposal section 4.3](p3-b2-stroke-proposal.md#43-can-the-stroke-outline-reuse-the-fill-ladder)).

### 4.2 Pieces and canonical samples

**Arithmetic.** The front end uses only IEEE 754 binary64 `+ − × ÷` and `sqrt`, which are correctly rounded on native and WASM targets alike, plus exact `Signed` integer arithmetic of `fill_exact.rs` for predicates. It calls no `sin`, `cos`, `atan2`, `pow`, `hypot` or other library function, so native and WASM outputs are bit-identical.

**Unit vectors.** For an exact direction `d` (a difference of two Float64 values, rounded once to Float64 as `d̃`), `n(d) = d̃ / sqrt(d̃.x·d̃.x + d̃.y·d̃.y)`, and the left normal is `(−n.y, n.x)`.

**Canonical samples.** Every segment end and every generated knot has exactly one sample triple `(E−, C, E+)` with `E± = C ± r·N` (each coordinate rounded once), computed once and used by every piece that touches that point. At a source end, `C` is the exact source point and `N` the left normal of the one-sided tangent. At a knot, `C` and `N` come from the leaf construction of section 4.5. **At an exact forward continuation** (ST-S6) the outgoing segment's start triple is the incoming segment's end triple, bit for bit, so no seam opens between the two sweeps.

**Boundary-inclusive convex hull.** `hull(S)` is the convex hull of a point set `S`, decided by exact `orient2d`, keeping every point of `S` that lies on the hull boundary (collinear boundary points included) and dropping strictly interior points and exact duplicates. Its vertices are listed counter-clockwise starting at the lexicographically smallest `(x, y)`. A hull of zero exact area is dropped and contributes nothing.

| Piece | Kind                               | Polygon                                                                                                                                                       |
| ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-P1 | Line sweep `A → B`                 | `hull{E−(A), A, E+(A), E−(B), B, E+(B)}`                                                                                                                      |
| ST-P2 | Cubic leaf `[t0, t1]`              | `hull{E−(t0), C(t0), E+(t0), E−(t1), C(t1), E+(t1)}` (section 4.5)                                                                                            |
| ST-P3 | Bevel join at `B`                  | `hull{B, O_in, O_out}`, with `O_in`, `O_out` the outer points of the incoming end triple and the outgoing start triple                                        |
| ST-P4 | Miter join                         | `hull{B, O_in, T, O_out}`, `T` per section 4.3                                                                                                                |
| ST-P5 | Round join or round cap; cusp disk | `hull(D(c, r) ∪ X)`: `D` the disk polygon of section 4.4, `X = {B, O_in, O_out}` for a join, `{B, E−, E+}` of the end triple for a cap, empty for a cusp disk |
| ST-P6 | Square cap at end `B`              | `hull{E−, B, E+, E− + r·τ̂, E+ + r·τ̂}`, `τ̂` the outward unit end tangent (the end tangent at an end cap, its negation at a start cap)                          |
| ST-P7 | Zero-length open subpath at `p`    | Butt: none. Round: `hull(D(p, r))`. Square: `hull{(p.x ± r, p.y ± r)}`                                                                                        |

The outer side at a turn is the right side (`E−`) when `cross(d_in, d_out) > 0` and the left side (`E+`) when it is `< 0`, decided exactly on the exact tangents. At an exact reversal, `O_in` and `O_out` are the incoming end triple's outer points on both sides; bevel and miter emit nothing and round emits ST-P5 with `X = {B, E−_in, E+_in}`.

**Why each piece is within its share** (the stage-to-proof table of ST-U3 and ST-U4 carries these):

- ST-P1, ST-P3, ST-P4, ST-P6, ST-P7 are hulls of points each within `g_off` (ST-G1) or `g_tip` (ST-G3) of the ideal polygon's vertices; for convex polygons, moving each vertex by at most `h` moves the hull by at most `h` in Hausdorff distance. The ideal ST-P1 also contains `A` and `B`, which are exact.
- ST-P2 is section 4.5's bound.
- ST-P5 lies inside the disk up to rounding, with sagitta and construction bounded by ST-G2. Including `B` and the outer points keeps the seam polylines shared with the adjacent sweeps; those points lie on the ideal circle up to `g_off`.

**Seams have no cracks.** Two pieces adjacent across an ideal interior seam always share the seam's polyline exactly: consecutive leaves and segments share the triple `E−–C–E+`; a join or cap shares `B–O` with each sweep it touches; a round piece covers a full neighborhood of radius `r·cos(π/n) − g` around its center. Each piece is convex and contains the shared polyline, so it covers a one-sided neighborhood of the seam on its own side. No hairline gap can therefore appear inside the ideal region. A seeded defect (ST-D3) checks this.

### 4.3 Exact join predicates and the miter tip

- **Turn, continuation, reversal.** `cross(d_in, d_out)` and `dot(d_in, d_out)` of the exact tangents, evaluated exactly with `Signed` products of the exact source differences.
- **Miter test.** With `u = d_in`, `v = d_out` and `L` the Float64 miter limit, all exact dyadic values: miter iff `L²·(u·v) ≥ (2 − L²)·|u|·|v|`, the non-unit form of `2 ≤ L²·(1 + d)`. Let `A = L²·(u·v)`, `K = 2 − L²`, `U = |u|²`, `V = |v|²`. Decide exactly:
  - `K ≤ 0` and `A ≥ 0`: miter;
  - `K ≤ 0` and `A < 0`: miter iff `A² ≤ K²·U·V`;
  - `K > 0` and `A < 0`: bevel;
  - `K > 0` and `A ≥ 0`: miter iff `A² ≥ K²·U·V`.

  Every term is a polynomial of degree at most 8 in Float64 inputs, evaluated in `Signed<N>` with `N ≥ 8·COORDINATE_LIMBS + 2`, a width ST-U3 fixes with a compile-time assertion. No epsilon and no Float64 comparison decides it. It is called only at a turn (cross ≠ 0); a reversal never keeps a miter.

- **Tip.** With `n_in`, `n_out` the Float64 outer unit normals and `d̂ = n_in·n_out`, `T = B + r·(n_in + n_out)/(1 + d̂)`, rounded per operation. When the miter is kept, `1 + d ≥ 2/L²`, so the amplification is at most `L²/2`.

### 4.4 Disk polygons

- **Directions.** For `n = 2^(k+2)`, `1 ≤ k ≤ 6` (8 to 256 vertices), the quadrant-I directions are built by bisection from `(1, 0)` and `(0, 1)`: level by level, each new direction is `(a + b)/sqrt((a + b)·(a + b))` from its two neighbors at the previous level. The other quadrants are exact 90° rotations `(x, y) → (−y, x)`. Directions are listed counter-clockwise from `(1, 0)`.
- **Count.** `k` is the smallest value with `r·C_ARC ≤ (2^(e−2) − g_arc)·n²·(1 − 2^-40)` in Float64, where `C_ARC = 4.9348023 > π²/2` bounds the sagitta `r·(1 − cos(π/n)) ≤ r·π²/(2n²)`. If no `k ≤ 6` satisfies it, the path is `work-limit` (`DiskLimit`).
- **Vertices.** `c + r·dir_j`, two roundings per coordinate.
- **ST-G2, arc guard.** `g_arc = (8k + 16)·2^-53·(‖c‖∞ + r)` bounds the direction and vertex rounding. The polygon is inscribed up to `g_arc`, so its Hausdorff distance to the disk is at most the sagitta plus `g_arc`, which the count rule keeps within `2^(e−2)`.

Amended 2026-10-20, ST-A0 amendment (M4): the count rule's `(1 − 2^-40)` relative slack does not cover absolute subnormal rounding. A subtraction whose result is subnormal is exact, so `2^(e−2) − g_arc` itself carries no error. The residual is the rounding of `g_arc = (8k + 16)·2^-53·(‖c‖∞ + r)` and of the product with the slack factor when those results are subnormal. At `e = −1020`, `2^(e−4)` is subnormal (`2^-1024`), and each such rounding is at most a few units of `2^-1075`, an absolute error of about `2^-49` relative to `2^(e−4)`. The slack absorbs this except when `2^(e−2) − g_arc` is below about `2^-1035`; there the count rule guarantees `2^(e−2) + 2^-1075` instead of `2^(e−2)`. The code does not make these roundings exact (`stroke_outline.rs:1911-1912`). (Revised 2026-10-21 after the PR #176 re-review.)

### 4.5 Cubic leaves

A remaining cubic segment, split at its interior stationary parameters (section 4.6), is subdivided by de Casteljau midpoint splitting in Float64, depth-first and left-first, to a depth of at most 20. A leaf with controls `Q0..Q3` (the computed subcurve controls) is **accepted** when:

```text
deltaUp + 4·r·sinUp + gCtrl + gOff ≤ 2^e · (1 − 2^-40)
```

- `q1 = Q1 − (2·Q0 + Q3)/3`, `q2 = Q2 − (Q0 + 2·Q3)/3`, `delta = max(|q1|, |q2|)`.
- `V = Q3 − Q0`, `D0 = 3(Q1 − Q0)`, `D1 = 3(Q2 − Q1)`, `D2 = 3(Q3 − Q2)`. The **cone set** is `{D0, D1, D2}`, except on a leaf whose start is a stationary parameter, where it is `{D1, D2}`, and on a leaf whose end is one, where it is `{D0, D1}`: there the hodograph is `(t − t*)·L(t)` and the directions of `C'` are those of `±L`, whose Bernstein coefficients are proportional to the remaining two. `a = min dot(V, Di)`, `b = max |cross(V, Di)|` over the cone set; `aLow > 0` is required, else the leaf splits.
- `sinUp = min(1, bUp / sqrt(aLow² + bUp²)·(1 + 2^-40))`.
- The factor 4 is P3.0b-s1's `2·r·sin(alpha)` plus the hull term: the hull of a band whose two emitted normal segments meet at angle `θ ≤ 2α` lies within `r·sin θ ≤ 2·r·sin α` of the band's bilinear patch, which covers the case where the inner offset folds and the band quadrilateral is a bowtie. This is a strengthening of the s1 condition, not a new allowance.
- **ST-G4, leaf guards.** With `M` the largest coordinate magnitude among the segment's source controls and `ℓ` the leaf depth: `deltaUp = delta·(1 + 2^-40) + 32·2^-53·M`; `aLow = a·(1 − 2^-40) − 768·2^-53·M²` and `bUp = b·(1 + 2^-40) + 768·2^-53·M²`; `gCtrl = 4·ℓ·2^-53·M·(1 + 12·r·|V|/aLow)` for the subdivision error of the computed controls and its effect on the normal; `gOff` is ST-G1.
- **Samples.** At each accepted leaf's ends, `C` is the computed control `Q0` or `Q3`, and `N` the left normal of the leaf's end direction: `D0` (start) or `D2` (end), or, at a stationary end, the first nonzero of the cone set taken toward the interior. Adjacent leaves share the knot's triple (section 4.2).
- A leaf that is not accepted at depth 20, or a path whose leaves exceed the piece cap, is `work-limit`. A coarse leaf is never emitted.

ST-U4 may strengthen any guard constant above (larger guards, never smaller) before ST-U5 lands, recording it in its PR. After ST-U5 a guard change that can alter an `ok` mesh is an identity change (section 7.1).

Amended 2026-10-20, ST-A0 amendment (S1), the hull argument in full. Let a band between samples `t0` and `t1` have end segments `s0 = [E−(t0), E+(t0)]` and `s1 = [E−(t1), E+(t1)]`, each of length `2r`, at an angle `θ ≤ 2α` to each other (both end normals lie within `α` of the chord normal). The argument is over the unrounded points `C ± r·N`; their rounding is covered separately by ST-G1 and `gCtrl`, because the hull and the bilinear patch each move by at most the largest vertex displacement. The ideal band region is the bilinear patch `P` of the quadrilateral `E−(t0), E+(t0), E+(t1), E−(t1)`; its sides include `s0` and `s1`. The emitted piece is the hull `H` of the four end points and the two centres.

- **Crossing (folded) case.** Suppose `s0` and `s1` cross at `X` (the inner offset folds, so the band quadrilateral is a bowtie). The patch `P` contains the two triangles with apex `X` (it can contain more, since rulings between points of `s0` and `s1` with different parameters also lie in `P`), and `H` is the union of those two triangles with two added triangles. Each added triangle `(X, A, B)` has `A` on `s0` and `B` on `s1`, apex angle `π − θ` (assuming `θ < π/2`, see below) and legs `a = |XA|`, `b = |XB|`, both `≤ 2r` because `X` lies on both segments. The legs lie on `s0` and `s1`, which belong to `P`. Write a point `Y = X + s(A − X) + t(B − X)` with `s, t ≥ 0`, `s + t ≤ 1`. Its distance to the line of `XA` is `t·b·sin θ` and to the line of `XB` is `s·a·sin θ`.
- **Foot inside the leg.** If the perpendicular foot onto a leg falls inside that leg, the distance to the leg is that line distance.
- **Foot outside a leg (assumes `θ < π/2`).** Because the apex angle is then obtuse, the foot of `Y` onto the line of `XA` falls beyond `X` exactly when `s·a < t·b·|cos θ|`. The foot onto the line of `XB` is then at `t·b − s·a·|cos θ| ≥ 0` and `≤ t·b ≤ b`, so it lies inside `XB`. The two feet cannot both fall outside. In this case the distance to `P` is at most `s·a·sin θ`, and `s·a < t·b`.
- **Bound.** In every case `dist(Y, P) ≤ min(s·a, t·b)·sin θ`. With `s + t ≤ 1` this is at most `a·b/(a + b)·sin θ ≤ ((a + b)/4)·sin θ ≤ r·sin θ ≤ 2·r·sin α`, which is the hull term of the factor 4. (`sin θ ≤ 2·sin α` holds for every `θ ≤ 2α` with `α < π/2`: with end normals at angles `φ0, φ1` from the chord normal, `|φ0|, |φ1| ≤ α`, so `sin(φ1 − φ0) ≤ |sin φ1| + |sin φ0| ≤ 2·sin α`.)
- **The case `θ ≥ π/2`.** It needs `α ≥ π/4`, which can occur (thin strokes have no minimum width, B2-Q3, and a short sharply curved leaf can be accepted). The proof above does not cover it; it is covered by ST-O1's exact hull term on dumped outputs. A numeric search over crossing bands up to `α = 1.5` found a worst distance of at most `0.49·2r·sin α`; this is diagnostic, not a proof.
- **Non-crossing case, setup.** Take the chord frame: `V = (ℓ, 0)` with `ℓ > 0`, and the end normals `N(φ) = (−sin φ, cos φ)` at angles `φ0` (start) and `φ1` (end). The leaf test needs `aLow > 0`, so every end direction `D` satisfies `dot(V, D) > 0`, that is `cos φi > 0`.
- **The chords cannot cross.** Both `E+(ti) = Ci + r·N(φi)` have `y = r·cos φi > 0`, and both `E−(ti)` have `y < 0`, because `C0` and `C1 = C0 + V` lie on `y = 0`. The `+` chord and the `−` chord therefore lie in opposite open half-planes. A simple quadrilateral has at most one reflex vertex (two would exceed the angle sum `2π`), and a non-simple one has two crossing opposite sides: the chords (excluded) or `s0` and `s1` (the bowtie case above). So, when `s0` and `s1` do not cross, the quadrilateral is simple.
- **Non-crossing, convex.** `H = P` and the hull term is 0.
- **Non-crossing, one reflex vertex.** By symmetry (swapping the ends, or the sides) let it be `E+(t1)`, and let `Δ = φ1 − φ0 > 0` (mirror the frame otherwise), so `θ = Δ`. `E+(t0)` lies beyond the line of `s1` by `δ = r·sin Δ − ℓ·cos φ1`, which is positive exactly because the vertex is reflex, and `E+(t1)` is the apex of the notch triangle `T = (E+(t0), E+(t1), E−(t1))` that `H` adds to `P`. Its legs, the `+` chord and `s1`, are sides of the patch (boundary rulings), so they lie in `P`. The other vertex `E+(t0)` is convex, so `ℓ·cos φ0 > r·sin Δ`; with `ℓ·cos φ1 < r·sin Δ` this gives `cos φ0 > cos φ1`, hence `φ1 > |φ0| ≥ 0`.
  - **Size of `δ`.** `δ < r·sin Δ·(1 − cos φ1/cos φ0) < r·sin Δ ≤ r·sin θ ≤ 2·r·sin α`.
  - **Distance of a point of `T`.** Every `Y` in `T` is within `δ` of the line of `s1`, because the three vertices are at distances `δ`, 0 and 0 from it. Let `p` be the position of the foot of `Y` on that line, measured from `E+(t1)` toward `E−(t1)`; `p` is a convex combination of the foot positions of the vertices, and the foot of `E+(t0)` is at `r·(1 − cos Δ) − ℓ·sin φ1 < 2r` (since `φ1 > 0`), so `p ≤ 2r`. If `p ≥ 0` the foot is on `s1 ⊂ P`, and `dist(Y, P) ≤ δ`. If `p < 0`, the apex angle `ψ` of `T` is obtuse and `Y = E+(t1) + s·u + t·w` (`u` toward `E+(t0)` with `|u| = a`, `w` toward `E−(t1)` with `|w| = b`, `s, t ≥ 0`, `s + t ≤ 1`) has `t·b < s·a·|cos ψ|`. Its foot on the `+` chord line is at `s·a − t·b·|cos ψ| ∈ [0, a]`, hence on the chord, and `dist(Y, P) ≤ t·b·sin ψ < s·a·|cos ψ|·sin ψ ≤ s·a·sin ψ = dist(Y, line of s1) ≤ δ`.
  - **Result.** The hull term is below `δ < 2·r·sin α` in the non-crossing case too. ST-O1 stays as the independent check on every dumped output; no residual remains for `θ < π/2` apart from the stated assumption of the crossing case.
- **Carry to the union.** The per-piece bound carries to the union by §3's union bullet, with the metric named there.

### 4.6 Stationary classification

All in exact arithmetic on the Float64 controls. Let `D(t) = C'(t)`, a quadratic in each component.

1. **All controls equal:** zero-length, removed by ST-S1.
2. **Collinear controls** (every `cross(Pi − P0, Pj − P0) = 0`): the curve lies on one line. Its image is a segment; its turning points are the odd-order roots in `(0, 1)` of the projected derivative. The segment is emitted as consecutive ST-P1 sweeps between its end points and its turning points, in parameter order, with a cusp disk (ST-P5) at each turning point, an even-order root adding nothing (ST-S8). Turning-point positions are Float64 evaluations with the bound ST-G5.
3. **Otherwise:** `Dx` and `Dy` are not proportional, so their common roots are the roots of a polynomial gcd of degree at most 1. A common root `t* ∈ (0, 1)` is therefore rational and exact; it is a simple root of the hodograph, so it is an interior reversal (cusp). The cubic is split at `t̃`, the Float64 evaluation of `t*`, with a cusp disk at `c = C(t̃)` evaluated by de Casteljau. A common root at `0` or `1` is a stationary endpoint, handled by the cone rule of section 4.5 and the tangent rule ST-S2.

- **ST-G5, cusp and turning-point guard.** `|c − C(t*)| ≤ eta = 64·2^-53·M`. The cusp disk piece then lies within `2·eta` of the ideal disk plus the neighbouring sweep (the sweep over `[t̃, t*]` lies inside the disk of radius `r + eta` at `C(t*)`), which must satisfy `2·eta ≤ 2^(e−4)`, else `numeric-range`.
- A classification case that the code cannot decide is an internal error, never a silent routing: with the cases above the classification is complete for cubics.

### 4.7 Guards and `numeric-range`

| Guard | Bound                                                                                             | Requirement, else `numeric-range`       |
| ----- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| ST-G1 | Offset sample `g_off = 16·2^-53·(M + r)`, with `M` the path's largest source coordinate magnitude | `g_off ≤ 2^(e−4)`                       |
| ST-G2 | Arc `g_arc`, section 4.4                                                                          | Inside the count rule                   |
| ST-G3 | Miter tip `g_tip = 32·2^-53·(‖B‖∞ + r·L²)`                                                        | `g_tip ≤ 2^(e−1)`; never a silent bevel |
| ST-G4 | Leaf guards, section 4.5                                                                          | Inside the leaf test                    |
| ST-G5 | Cusp and turning point `eta`, section 4.6                                                         | `2·eta ≤ 2^(e−4)`                       |
| ST-G6 | Every emitted coordinate finite                                                                   | Finite                                  |

**Collapse.** If `r` is so small against the coordinates that offset samples round onto the centerline, pieces have zero area and are dropped (section 4.2); a path whose pieces all drop is `empty`. This needs `r < g_off ≤ 2^(e−4)`, a stroke narrower than 1/64 physical px. Fixture ST-F22 fixes it.

### 4.8 Resolution and output

The pieces, in emission order, are the contours of one `tessellate` call under `LineFillRule::NonZero` and `τ = 2^(e−2)`. The output mesh, after V2's refinement and boundary rules, has V2's [section g](p3-v2-fill-mesh-transport-contract.md#g-positions-bounds-and-indices) form: Float64 node-local positions in kernel vertex order, counter-clockwise `u32` triangles in refinement order, `boundaryEdges` once per region-boundary mesh edge, exact vertex bounds. A successful tessellation with zero triangles is `empty`.

### 4.9 Emission order and determinism

Per subpath in source order: the start cap; then per remaining segment in order, its sweep pieces in parameter order with each cusp disk placed between the leaves it separates, then the join that follows the segment; for a closed subpath, the seam join last; for an open subpath, the end cap last. A zero-length open subpath emits its one ST-P7 piece. Each attempt resets all front-end and arrangement state, so a path's result does not depend on the batch (V1 rule 6). Equal requests give bit-identical results within one kernel revision, on native and WASM.

## 5. Scene field and validation

`packages/contracts/src/scene.ts` gains, in ST-U6:

```ts
export type SceneStrokeCap = 'butt' | 'round' | 'square';
export type SceneStrokeJoin = 'miter' | 'round' | 'bevel';
export type PathStroke = Readonly<{
  color: SceneColor;
  /** Node-local units, finite, >= 0. */
  width: number;
  cap: SceneStrokeCap;
  join: SceneStrokeJoin;
  /** Finite, >= 1, required for every join kind. */
  miterLimit: number;
}>;
export type PathStyle = Readonly<{ fill: SceneColor | null; stroke: PathStroke | null }>;
```

`stroke` is required and explicitly `null` when absent. This is a breaking change to V3's `PathStyle`; the playground, fixtures and tests update in ST-U6. `SceneStroke` (primitive strokes) is unchanged.

**Validation rows,** refining [V3 section a](p3-v3-renderer-mesh-pipeline-contract.md#a-path-node-landing-and-scene-validation), in the same precedence (path content in `copyNode`, then graph checks, `unsupported-feature` last):

| Input                                                                                                | Result                |
| ---------------------------------------------------------------------------------------------------- | --------------------- |
| `style` fields other than exactly `fill, stroke`                                                     | `invalid-value`       |
| `stroke` not `null` and not an object with exactly `color, width, cap, join, miterLimit`             | `invalid-value`       |
| `stroke.color` not a valid `SceneColor`                                                              | `invalid-value`       |
| `width` not a number, nonfinite or negative                                                          | `invalid-value`       |
| `cap` or `join` not one of its three strings                                                         | `invalid-value`       |
| `miterLimit` not a number, nonfinite or below 1                                                      | `invalid-value`       |
| Nonfinite world bounds of the stroke bounds box of section 9.7, for a nonempty path with `width > 0` | `invalid-value`       |
| `stroke` with `width > 0` while the mirror's `pathStrokes` option is `'unsupported'`                 | `unsupported-feature` |
| `stroke` with `width = 0`, with or without a stroke port                                             | Accepted; no stroke   |

Amended 2026-10-20, ST-A0 amendment (S3), the nonfinite-world-bounds row: the stroke bounds box uses `k = min(L, 2^24)` for miter joins (§9.7), so `{width: 4, join: 'miter', miterLimit: Number.MAX_VALUE}` no longer gives `r·k = Infinity`. ST-S4 says that limit is valid, and scene validation must not reject it as `invalid-value` for that reason. A width so large that `r·k` or the world bounds still overflow remains `invalid-value`, as before.

`RetainedSceneMirrorOptions` gains `pathStrokes: 'supported' | 'unsupported'`, default `'unsupported'`, fixed at construction; the service passes `'supported'` exactly when a stroke port is injected. Replay equality compares every stroke field with `===`, color channels included. The geometry revision is unchanged by stroke fields (it covers `verbs` and `points` only).

## 6. `StrokeMeshPort`

`packages/contracts/src/geometry.ts` gains, in ST-U5:

```ts
export interface StrokeMeshRequest {
  /** u32, unique within one batch; echoed. */
  readonly requestId: number;
  readonly verbs: Uint8Array;
  /** Interleaved node-local x, y. */
  readonly points: Float64Array;
  readonly width: number;
  readonly cap: 'butt' | 'round' | 'square';
  readonly join: 'miter' | 'round' | 'bevel';
  readonly miterLimit: number;
  /** Integer e; the curve share is 2^e local units (stroke contract section 3). */
  readonly toleranceExponent: number;
}

/** Same shape and meaning as FillMesh (V1 rule 5), for the stroke region. */
export type StrokeMesh = FillMesh;

export type StrokeMeshFailureCode = FillMeshFailureCode | 'invalid-stroke';

type StrokeMeshEcho = Readonly<{ requestId: number; toleranceExponent: number }>;

export type StrokeMeshResult =
  | (StrokeMeshEcho & Readonly<{ status: 'ok'; mesh: StrokeMesh }>)
  | (StrokeMeshEcho & Readonly<{ status: 'empty' }>)
  | (StrokeMeshEcho & Readonly<{ status: 'failed'; code: StrokeMeshFailureCode }>);

export type StrokeMeshBatchResult =
  | Readonly<{ status: 'ok'; results: readonly StrokeMeshResult[] }>
  | Readonly<{
      status: 'batch-failed';
      code: 'invalid-request' | 'disposed' | 'resource-limit' | 'internal-error';
    }>;

export interface StrokeMeshPort {
  readonly portVersion: 0;
  /** Names the operation and its error budget, for example 'geometry-wasm/stroke-v0'. */
  readonly operationId: string;
  buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult;
}
```

V1 rules 1-8 apply unchanged, with rule 5's region being section 2.2's stroke region and rule 8's request-shape list extended by section 8's checks. `invalid-stroke` is a per-path failure for a width or miter limit that is well-typed but invalid (ST-S3, ST-S4); the renderer never sends one, because scene validation rejects it first. `FillMeshPort` v0, its conformance suite and its cache keys are unchanged.

## 7. Kernel export `stroke_v0_*`

### 7.1 Identity

| Item               | v0 value                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| Export prefix      | `stroke_v0_`                                                                        |
| Transport version  | `stroke_v0_version() == 0`, also in both headers                                    |
| Input magic        | `0x30544756` (bytes `VGT0`)                                                         |
| Output magic       | `0x30554756` (bytes `VGU0`)                                                         |
| Port `operationId` | `'geometry-wasm/stroke-v0'`                                                         |
| Kernel revision    | `stroke_v0_revision() == 1`; the adapter accepts only the revision it was built for |

The magics differ from P2's (`VGS2`, `VGR2`) and fill's (`VGF0`, `VGM0`). `abi_version()` stays 1 and `fill_v0_*` is unchanged. **Identity rule,** as V2's: a change that can alter an `ok` stroke mesh for some request changes the `operationId` and the revision together (for example to `'geometry-wasm/stroke-v0+r2'`); a change that only turns a failure into a success, such as a limit raise, keeps them.

Amended 2026-10-21 (cusp shared triple; see the header notes): the identity is now `'geometry-wasm/stroke-v0+r2'` with `stroke_v0_revision() == 2`. The table above, the §8 adapter interface (`operationId`) and the SC21 row keep the frozen v0 values; all three are superseded by revision 2.

### 7.2 Exports

All parameters and returns `u32`, as P2 and V2: `stroke_v0_version`, `stroke_v0_revision`, `stroke_v0_reserve(inputBytes, outputBytes)`, `stroke_v0_input_ptr`, `stroke_v0_input_capacity`, `stroke_v0_output_ptr`, `stroke_v0_output_capacity`, `stroke_v0_memory_epoch`, `stroke_v0_process(inputLength)`, `stroke_v0_result_len`, `stroke_v0_required_output_bytes`, `stroke_v0_dispose`. Each has the meaning of its [`fill_v0_` counterpart](p3-v2-fill-mesh-transport-contract.md#exports). A third module-level engine, `StrokeEngine`, owns this state and shares no field, epoch, arena or workspace with the P2 `Engine` or `FillEngine`. Batch statuses are P2's (`OK=0` to `INTERNAL_ERROR=6`). Path statuses: `OK=0`, `EMPTY=1`, `INVALID_PATH=2`, `INVALID_TOLERANCE=3`, `NUMERIC_RANGE=4`, `WORK_LIMIT=5`, `UNSUPPORTED_GEOMETRY=6`, `INVALID_STROKE=7`.

### 7.3 Input framing

Little-endian; V2's [rules](p3-v2-fill-mesh-transport-contract.md#input-framing) for section order, alignment, zero padding, computed offset fields, offset tables and checked arithmetic apply unchanged. Header, twelve `u32` (48 bytes): magic `0x30544756`, version 0, totalBytes, pathCount, verbCount, pointScalarCount, requestsOffset (= 48), pathOffsetsOffset, pointOffsetsOffset, verbsOffset, pointsOffset, reserved 0. Sections in that order: requests (8-aligned), path offsets, point offsets, verbs, points (8-aligned).

Request record, 32 bytes, 8-aligned:

| Offset | Field                                 |
| -----: | ------------------------------------- |
|      0 | requestId `u32`                       |
|      4 | cap `u32`: 0 butt, 1 round, 2 square  |
|      8 | join `u32`: 0 miter, 1 round, 2 bevel |
|     12 | toleranceExponent `i32`               |
|     16 | width `f64`                           |
|     24 | miterLimit `f64`                      |

`INVALID_BATCH` for the whole input: V2's list, with "a `cap` or `join` value above 2" in place of the `fillRule` item. Width and miter-limit bits, verb bytes, points, point counts and the exponent are path content and give per-path statuses.

### 7.4 Output framing

V2's [output framing](p3-v2-fill-mesh-transport-contract.md#output-framing) exactly, with output magic `0x30554756`: a 64-byte header, 80-byte result records, one block per `OK` path in request order (positions, indices, boundary pairs, padding to 8), contiguous blocks, every non-`OK` record zero beyond its echoes and status.

### 7.5 Capacity, caps, publication, memory and lifetime

- **Capacity and publication.** V2 [section a](p3-v2-fill-mesh-transport-contract.md#capacity-sizing-and-publication) unchanged: one pass, exact `required_output_bytes`, one adapter retry, header written last, any failure leaves `result_len = 0`.
- **Transport caps.** Input at most 64 MiB, output at most 256 MiB, as P2 and V2.
- **Memory.** `stroke_v0_reserve` allocates the arenas, the stroke front-end workspace (sample, piece and contour storage, leaf stack, direction table), a `RoundedFillWorkspace` built from `STROKE_V0_LIMITS`, and a `FillScratch` reserved from `STROKE_V0_LIMITS`. `stroke_v0_process` allocates nothing and moves no storage; a native tracking-allocator test asserts it. Construction failure maps as V2's memory rules do. The combined stroke heap is checked at reserve against `STROKE_V0_HEAP_CAP = 48 MiB` with checked arithmetic and is included in `linearMemoryBytes()`.
- **Lifetime (C04 item 4).** V2 [section b](p3-v2-fill-mesh-transport-contract.md#b-instance-and-arena-c04-item-4) applies with "stroke" for "fill": the stroke adapter instantiates its own `WebAssembly.Instance`, which it shares with no P2 session and no fill adapter; epochs advance once per mutating call and saturate; views are re-read after every call; results are owned copies; dispose is terminal and idempotent; instances are isolated. A host may pass one compiled `WebAssembly.Module` to all three factories.

### 7.6 Limits

The source limits keep every accepted stroke path inside P2 ABI v1's per-path limits (65,536 output verbs; `MAX_DEPTH` 20), so a stroke source is always a valid P2 v1 path, and the transport caps equal P2's. Limits are kernel internals, not port behavior; raising one keeps the identity (section 7.1). No conformance case depends on their values.

| Limit (front end)                | Value | On excess    |
| -------------------------------- | ----: | ------------ |
| Source verbs per path            | 1,024 | `work-limit` |
| Source point scalars per path    | 6,144 | `work-limit` |
| Remaining drawing segments       |   512 | `work-limit` |
| Subpaths                         |   256 | `work-limit` |
| Leaf subdivision depth per cubic |    20 | `work-limit` |
| Pieces (contours) per path       |   512 | `work-limit` |
| Disk polygon vertices (`n`)      |   256 | `work-limit` |

`STROKE_V0_LIMITS: RoundedFillLimits`:

| Field                |      Value | Field              |  Value |
| -------------------- | ---------: | ------------------ | -----: |
| `max_contours`       |        512 | `max_nodes`        |  8,192 |
| `max_input_vertices` |      1,024 | `max_cells`        |  8,192 |
| `max_edges`          |      1,024 | `max_boundaries`   | 16,384 |
| `max_pairs`          |    523,776 | `max_contributors` | 16,384 |
| `max_events`         |      4,096 | `max_vertices`     |  8,192 |
| `max_sections`       |    262,144 | `max_triangles`    |  8,192 |
| `max_work`           | 64,000,000 | `max_bytes`        | 32 MiB |

`max_pairs` is `pair_count(1024)`. ST-U3 records `allocated_bytes()` of the workspace and the scratch, natively and for `wasm32`, in its PR. If these values fail `RoundedFillWorkspace::new`'s validation or the byte caps, ST-U3 stops and the Primary amends this table with a dated note before any code merges; values are never changed silently.

Amended 2026-10-20 by ST-U4 (ST-A0 review; see the header notes).

The front-end limits gain two rows:

| Limit (front end)                                        | Value | On excess                   |
| -------------------------------------------------------- | ----: | --------------------------- |
| Piece records per path, dropped zero-area hulls included | 4,096 | `work-limit` (`PieceLimit`) |
| Leaf stack (depth-first, one pending sibling per level)  |    22 | not reachable (depth ≤ 20)  |

`STROKE_V0_LIMITS` is unchanged. The test-only limit set `WIDE_TEST_LIMITS` (`cfg(test)` only, never a production configuration) is `STROKE_V0_LIMITS` with only these arrangement fields raised: `max_events` 65,536 (events and columns), `max_sections` 4,194,304, `max_nodes` 262,144, `max_work` 4,000,000,000, and `max_bytes` 1 GiB for their storage. The front-end limits, `τ = 2^(e−2)`, `max_input_vertices`, `max_edges`, `max_contours`, `max_pairs`, `max_cells`, `max_boundaries`, `max_contributors`, `max_vertices` and `max_triangles` are the same. Current-cap fixtures are checked under it.

Amended 2026-10-20, ST-A0 amendment (S6):

- **Piece store.** The 4,096-record piece store above is `MAX_PIECE_RECORDS: usize = 4_096` at `packages/geometry-wasm/kernel/src/stroke_outline.rs:55`; its overflow is `FrontEndError::PieceLimit` (`stroke_outline.rs:129`), mapped to `work-limit` in §7.8. The 512-piece cap (`MAX_PIECES`, `stroke_outline.rs:49`) is unchanged.
- **Memory rows.** ST-U3's recorded rows are stale after ST-U4 (the front end grew to 1,255,120 B). ST-U5 re-measured them (and corrected ST-U3's native row, which does not reproduce at `ae91297`: front end 376,992 B, total 17,293,472 B) and recorded them in the [ST-U5 plan section](p3-fill-stroke-meshes.md#b2-st-u5-stroke-export): native heap total **18,171,600 B** (front end 1,255,120 B, `RoundedFillWorkspace` 14,262,272 B, `FillScratch` 2,654,208 B), and `wasm32` linear memory **13,828,096 B** after `stroke_v0_reserve(0, 0)` (1,114,112 B before). The native heap total (18,171,600 B) fits the 48 MiB heap cap; the `wasm32` figure is total linear memory, a different quantity from ST-U3's workspace-parts total (11,690,144 B), so it does not replace that figure but is the current `wasm32` row. The native total supersedes ST-U3's 17,117,344 B. The source limits' fit with P2 ABI v1's per-path limits is a separate check (the paragraph above §7.6's tables) and is unaffected. The table needs no change; the ST-U3 text is left as written.

### 7.7 Tolerance

Accepted range **`−1020 ≤ toleranceExponent ≤ 1023`**, so that `2^e`, `2^(e−2)` and `2^(e−4)` are normal binary64 values, built from exponent bits as V2 builds its tolerances. Outside it: `invalid-tolerance`. A non-integer or nonfinite exponent is `invalid-request` for the batch, and the adapter encodes an integer outside `i32` as `−2^31`, as V2 does.

### 7.8 Status mapping and precedence

**Per-path stage order;** the first failing stage decides:

1. Grammar and values: P2's `validate_path` (`invalid-path`).
2. Stroke values: width finite and `≥ 0`, miter limit finite and `≥ 1` (`invalid-stroke`).
3. Tolerance range (`invalid-tolerance`).
4. Empty: no verbs, or width 0 (`empty`).
5. Front end: source caps, decoding, stationary classification, leaves, pieces, guards (section 4).
6. Arrangement (`tessellate`).
7. Refinement and boundary (V2 section f).
8. Empty region: zero triangles (`empty`).

**Mapping.** One exhaustive Rust `match` per error type, with no wildcard arm:

| Kernel value                                                                                                                                                                                        | Port outcome                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Front end `SourceLimit`, `SegmentLimit`, `SubpathLimit`, `DepthLimit`, `PieceLimit`, `DiskLimit`                                                                                                    | `work-limit`                                                                                           |
| Front end `NumericRange` (ST-G1 to ST-G6)                                                                                                                                                           | `numeric-range`                                                                                        |
| `Rounded(InputLimit \| EdgeLimit \| PairLimit \| EventLimit \| SectionLimit \| NodeLimit \| CellLimit \| BoundaryLimit \| ContributorLimit \| WorkLimit \| OutputLimit)`                            | `work-limit`                                                                                           |
| `Rounded(TopologyAmbiguous)`                                                                                                                                                                        | `unsupported-geometry`                                                                                 |
| `Rounded(InvalidTolerance)` (unreachable: `τ` is normal and positive)                                                                                                                               | `invalid-tolerance`                                                                                    |
| `Rounded(InvalidInput)` (unreachable after ST-G6), `Rounded(InternalInvariant)`, a front-end invariant failure (including an undecided classification), a refinement or boundary self-check failure | _batch_ `internal-error`                                                                               |
| `Rounded(InvalidLimits \| AllocationFailed \| ByteLimit)`, heap cap                                                                                                                                 | At reserve: `INTERNAL_ERROR` or `ALLOCATION_FAILED`, as V2; during `process`: _batch_ `internal-error` |

**Precedence.** V2's, unchanged: a batch failure publishes nothing; inside a path the stage order decides; inside the batch class, `DISPOSED`, `INVALID_BATCH`, `ALLOCATION_FAILED` for a missing workspace, the first path self-check `INTERNAL_ERROR`, `RESOURCE_LIMIT`, `OUTPUT_CAPACITY`.

## 8. Adapter

```ts
// packages/geometry-wasm/src/stroke-adapter.ts, exported from the package index.
import type { StrokeMeshPort } from '@vector-studio/contracts';

export interface StrokeMeshAdapter extends StrokeMeshPort {
  readonly portVersion: 0;
  readonly operationId: 'geometry-wasm/stroke-v0';
  /** Terminal and idempotent. Later calls return batch-failed: disposed. */
  dispose(): void;
  /** Current byteLength of this adapter's own linear memory. */
  linearMemoryBytes(): number;
}

export function createStrokeMeshPort(
  source: WebAssembly.Module | BufferSource,
): Promise<StrokeMeshAdapter>;
```

The factory and the adapter follow [V2 section h](p3-v2-fill-mesh-transport-contract.md#h-typescript-adapter) with "stroke" for "fill": a new instance with no imports, every `stroke_v0_*` export present, version 0, the built revision, batch-level checks in order, one capacity retry, kernel self-check failures returned as `batch-failed: internal-error` without disposing, and the fail-closed list unchanged. The `invalid-request` list replaces the `fillRule` item with: `cap` not exactly one of its three strings; `join` not exactly one of its three strings; `width` or `miterLimit` not of type `number`. A `width` or `miterLimit` that is a number but invalid (NaN, infinite, negative width, limit below 1) is passed through and returns per-path `invalid-stroke`.

## 9. Renderer composition (ST-U6)

### 9.1 Service options

`PrimitiveRendererServiceOptions` gains `strokeMesh?: StrokeMeshPort` and `strokeMeshMemoryBytes?: () => number`, with V3's port shape check (`portVersion === 0`, nonempty `operationId`, callable `buildStrokeMeshes`). A stroke port without a fill port is allowed. Statistics add `strokePortLinearMemoryBytes`, and `pathMeshMemoryBytes` includes it.

Amended 2026-10-20, ST-A0 amendment (S4), for ST-U6, consistent with [V3 section a](p3-v3-renderer-mesh-pipeline-contract.md#a-path-node-landing-and-scene-validation), which sets `pathNodes: 'supported'` exactly when a fill port is given:

- **`pathNodes` derivation.** The service passes `pathNodes: 'supported'` when **a fill port, a stroke port, or both** are given, and `'unsupported'` otherwise. With neither port, every path node stays `unsupported-feature`, as in V3. This widens V3's "exactly when a port is given" from the fill port to either port; V3's no-port behavior is unchanged.
- **`pathStrokes`.** As in §5: `'supported'` exactly when a stroke port is given.
- **A fill without a fill port.** The mirror also needs the fill-side fact. `RetainedSceneMirrorOptions` gains `pathFills: 'supported' | 'unsupported'` (fixed at construction; **when omitted it takes the value of `pathNodes`**, so V3's existing calls such as `new RetainedSceneMirror(cb, { pathNodes: 'supported' })` keep their meaning, fills accepted; the service always passes it explicitly, `'supported'` exactly when a fill port is given, so only a stroke-only host passes `'unsupported'`), and a path with `fill !== null` while it is `'unsupported'` is **`unsupported-feature`**, in the same precedence slot as the stroke row (last, after `invalid-value` and graph reasons). A path with `fill === null` is accepted without a fill port. A stroke-only host therefore sees the fill-on-path case rejected at scene validation instead of silently drawn without its fill.
- **Open for the ST-U6 PR.** `pathFills` is a new mirror option introduced here as the consistent reading of V3's gating; the ST-U6 PR must record it in its V3 amendment notes.

### 9.2 Drawable paints

Per path node, after V3's derivations:

- **Fill drawable:** V3's rule, unchanged.
- **Stroke drawable:** not hidden, `stroke !== null`, `stroke.width > 0`, at least one verb, nonsingular world linear map, and the stroke world bounds (section 9.7) meet the viewport plus P1's guard.
- A path is culled only when neither paint's bounds meet the viewport.

### 9.3 Cache keys, memo and reuse

- **Stroke key:** `('stroke', portVersion, operationId, nodeId, geometryRevision, width, cap, join, miterLimit, toleranceExponent)`, read from the stroke port at every `prepare`. The fill key gains the tag `'fill'` and is otherwise V3's. Fields are compared with `===`; no hash is trusted (C04 item 5).
- One mesh cache and one failure memo hold both paints. V3's byte budget (64 MiB), memo capacity (4,096) and working-set rules apply to the total. The tolerance-variant cap (3) and the reuse rule (a finer entry within two levels serves) apply per node and paint. A change of any stroke key field makes that paint's entries unreachable. Stroke color, node opacity and fill changes build no stroke mesh.
- **Tolerance bucket.** The stroke uses V3's `e` and `f` for the node. A bucket `e < −1020` is the state failure `tolerance-range` for the stroke paint; `e > 1023` requests 1023.

### 9.4 Port calls

After V3's fill call, all missing drawable stroke keys go into **one** `buildStrokeMeshes` call, with V3's batch-failure isolation, settling, resume and memo rules applied to the stroke port independently, and its own bound of 32 calls per `prepare`. Responses are validated as V3 validates fill responses (`invalid-response`, `invalid-mesh`), before packing.

### 9.5 Draws and records

- A drawn stroked path emits its fill draw (if its fill is drawable) and then its stroke draw, both `MeshFillDraw` entries with the same `position`, consecutive in `draws`; V3 keeps array order for equal positions. The type name and fields are unchanged.
- The stroke draw has its own `meshInstances` record from a second path slot allocated by V3's slot allocator for the node's stroke; the record layout is V3's 64-byte layout, with the stroke color in the straight color lanes and the served stroke variant's bases. A fill-only scene packs byte-identically to V3.
- The stroke mesh uses V3's fringe builder, coverage rule, pipeline and shader unchanged, because a stroke mesh has the fill mesh's shape. Device loss rebuilds stroke data from CPU entries without a port call, as V3 section i does.

### 9.6 Composition and the opacity staging (B2-Q6)

For premultiplied coverage-adjusted `F` and `S`, two source-over draws in fill-then-stroke order give `S + F·(1 − S.a) + D·(1 − F.a)·(1 − S.a) = L + D·(1 − L.a)`. Two draws are therefore exact when node opacity `o = 1`, for any paint alphas; a single-paint path is exact at any opacity; and at `o = 0` both draws output zero. With both paints and `0 < o < 1`, two draws of `o·F` and `o·S` apply opacity twice in the overlap, which the approved invariant excludes.

**Interim rule until ST-U7.** A path with `fill !== null`, a stroke with `width > 0` and `0 < opacity < 1` is the renderer state failure **`composition-unsupported`**: neither paint is drawn, no port call is made for it, cached meshes stay, and a notice is emitted on the `(node, code)` transition, as V3's state failures are. It clears when either condition clears. This is the D8-interim failure approved by B2-Q6 (a).

**Failures of one paint.** If either drawable paint of a path fails (any port, response, fringe or state failure), the whole path is not drawn, as V1-Q4 approved for a failing path, and every other node draws. The other paint's cached mesh stays.

### 9.7 Culling bounds

The stroke bounds box is the box of the path's points expanded by `r·k` in local units before mapping, with `k = max(1, L if join = 'miter', 1.5 if cap = 'square')`. A miter tip lies within `L·r` of its join point, a square-cap corner within `sqrt(2)·r < 1.5·r` of its end, and every other piece within `r` of a point of the curve's control hull. World bounds follow P1's arithmetic rule, as V3 does for the fill's point box.

Amended 2026-10-20, ST-A0 amendment (S3): the stroke bounds box uses `k = max(1, min(L, 2^24) if join = 'miter', 1.5 if cap = 'square')`. With `k = L`, a valid limit such as `Number.MAX_VALUE` made `r·k` infinite and the scene change `invalid-value`, although ST-S4 accepts it. The cap is sound for culling: a kept miter needs the certified ratio bound `ρ ≤ 2^24` (the ST-U4 correction in the header), and the tip lies within `ratio·r ≤ ρ·r` of its join point. A kept miter with `ρ > 2^24` is `numeric-range`, so that path is not drawn and its bounds are irrelevant. Where `L ≤ 2^24` the bound is unchanged.

### 9.8 Notices

V3's D8-interim notice context gains `paint: 'fill' | 'stroke' | null`: `'fill'` or `'stroke'` for path and batch scopes and for state failures of one paint, `null` for `composition-unsupported`, `port-version` of both ports and `mesh-pipeline-unavailable`. The failure-code table gains `invalid-stroke` (path scope) and `composition-unsupported` (renderer scope). Transport, caps and removal are V3's.

## 10. C04 items for the stroke transport and draw

Under the carve-out extended by B2-Q9 (a), `stroke_v0` is a functional transport v0 and the stroke draw a functional packet extension, both disposable and UNVERIFIED. Nothing here is the C04 layout.

| Item | v0 fixes                                                                                                                                              | Left open for the C04 layout                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | `stroke_v0_*` names, version 0, magics, revision, headers, 32-byte requests, offsets, alignment, padding, checked arithmetic, reserved-byte rejection | Version negotiation; the final operation and budget identity scheme                                           |
| 2    | V2's mesh form for the stroke region; fill-then-stroke draw order at one paint position; separate instance records; the opacity staging rule          | Joint fill and stroke coverage (ST-U7), local origin, Float32 packing, region labels across paints, K1 and E1 |
| 3    | Echoes, complete publication, stage order and precedence, capacity sizing and one retry, no partial mesh, transport caps, the limits of section 7.6   | Product limits for pieces, edges and arcs; a distinguishable topology-ambiguity failure                       |
| 4    | Own instance, epochs, views, owned copies, dispose, isolation, `linearMemoryBytes()`                                                                  | A shared-arena design                                                                                         |
| 5    | The stroke key with every mesh-affecting stroke value compared exactly; paint-tagged entries and memo; color and opacity build nothing                | Final budgets; per-cell identity under E2                                                                     |
| 6    | V3's arena, receipts, generation and reconstruction, applied to stroke records                                                                        | Tile caches and epoch builds                                                                                  |

## 11. Fixtures, oracles, seeded defects and conformance

### 11.1 Oracles

ST-U2 adds an independent oracle in `packages/geometry-reference/src/stroke-region.ts`. It imports nothing from `geometry-wasm` and uses BigInt rationals and the existing exact fill-region oracle.

| Oracle | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-O1  | **Piece bounds.** For each emitted piece, the ideal piece from the source: polygon vertices compared exactly with their irrational ideal positions (radicals isolated and squared); cubic leaves by the [P3.0b-s1 continuous verifier](p3-stroke-boundary-certificate.md#independent-continuous-verifier) on both sides, plus the hull term computed exactly from the emitted points; disk pieces by exact chord-to-center distances; cusp centers against the exact `C(t*)`. Each piece within its section 3 share |
| ST-O2  | **Inventory.** One sweep sequence per remaining segment whose leaf intervals tile its parameter range with no gap or overlap; one join piece of the oracle's own exact kind at each source join and none elsewhere; caps at open ends only; cusp disks exactly at the oracle's own stationary classification; the forward-continuation triple shared                                                                                                                                                                |
| ST-O3  | **Resolution.** On the mesh: the V2 mesh checks of `tests/support/fill-mesh-check.ts` (positive interior-disjoint conforming triangles, `boundaryEdges` equal to edges used once, bounds), and the mesh region against the exact nonzero union of the emitted pieces: equal area and boundary on exact fixtures, the `τ`-band (area difference at most perimeter times `τ`) otherwise                                                                                                                               |
| ST-O4  | **Exact region.** On fixtures whose ideal pieces are exact polygons (axis-aligned segments, integer data, no arcs): the mesh area and region boundary equal the ideal union exactly                                                                                                                                                                                                                                                                                                                                 |
| ST-O5  | **Literal membership.** Named points inside or outside the mesh region, decided exactly against its triangles                                                                                                                                                                                                                                                                                                                                                                                                       |

**Hand-off.** An ignored Rust test `emit_stroke_dump` writes framed JSON per case: the request, the classification, every piece with its kind, source segment, parameter interval and emitted points, and the export's mesh. `tests/geometry/stroke-oracle.test.ts` runs it with the pinned toolchain and the existing Rust runner environment, as `p3-fill-ladder-oracle.test.ts` does, and applies ST-O1 to ST-O5.

**Positive controls,** each rejected by the named oracle before any fixture result counts: the s2 chord-normal R4 leaf and flipped R3 start normal (ST-O1); a removed and a duplicated leaf interval, a join piece at a generated knot, a missing cusp disk (ST-O2); a dropped, a flipped and a duplicated triangle and a dropped boundary pair (ST-O3).

Amended 2026-10-21, ST-U2 oracle hardening (review of PR #169, S1; see [the plan section](p3-fill-stroke-meshes.md#b2-st-u2-oracle-hardening-review-follow-up)): ST-O3's `τ`-band is **stricter than the wording "area difference at most perimeter times `τ`"** in the table above. The oracle now also requires the **symmetric difference** of the mesh region and the exact union of the emitted pieces to be at most `perimeter·τ·(1 + 2^-40)`. An area difference alone passes a mesh translated far from the pieces. Under a one-sided displacement of at most `τ` the symmetric difference is at most `perimeter·τ`; the strict two-sided `τ`-tube allows about twice that plus a corner term per loop. The band is therefore a test band justified by the measured margin (the 72 band-mode instances of the corpus use at most 23% of it), not a consequence of section 3; an over-band result on a new fixture means re-checking the band first. The frozen text above is unchanged. The exact mode of ST-O3 also applies only where every ideal vertex round-trips through binary64 (review minor M1).

### 11.2 Named fixtures

All at identity transform, `e = −3` (zoom 1, DPR 1), unless stated. "Area" is the mesh region's area; "16-gon" is the disk polygon with `n = 16`, whose area at `r = 1` is `8·sin(π/8) = 3.0614674589207183`, a half of it `1.5307337294603591` and a quarter `0.7653668647301796`. Areas involving disk polygons or irrational normals are expected within `1e−12` absolute; others exactly. Every expectation is fixed before its first execution.

| ID     | Input                                                                                                                                                                                                                                                                                      | Expected                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-F1  | `M(0,0) L(4,0)`, `w = 2`, butt, miter `L = 4`                                                                                                                                                                                                                                              | Area 8, bounds `(0,−1,4,1)`, region boundary the rectangle (ST-O4)                                                                                                                                                     |
| ST-F2  | ST-F1 with square caps                                                                                                                                                                                                                                                                     | Area 12, bounds `(−1,−1,5,1)` (ST-O4)                                                                                                                                                                                  |
| ST-F3  | ST-F1 with round caps                                                                                                                                                                                                                                                                      | `n = 16` per cap; area `8 + 3.0614674589207183`                                                                                                                                                                        |
| ST-F4  | `M(0,0) L(4,0) L(4,4)`, `w = 2`, butt                                                                                                                                                                                                                                                      | Miter `L = 2`: area 16, tip `(5,−1)`. Miter `L = 1`: bevel, 15.5. Bevel: 15.5. Round: `15 + 0.7653668647301796`                                                                                                        |
| ST-F5  | `M(0,0) L(25,0) L(32,24)`, `w = 2`, butt, miter                                                                                                                                                                                                                                            | Ratio exactly 5/4. `L = 1.25`: miter, tip within `g_tip` of `(25.75,−1)`. `L = 1.2499999999999998`: bevel. `L = 1.2500000000000002`: miter. The predicate on `u = (25,0)`, `v = (7,24)` returns the same three answers |
| ST-F6  | `M(0,0) L(4,0) L(0,0)`, `w = 2`, butt                                                                                                                                                                                                                                                      | Miter `L = 4` and bevel: area 8, region `[0,4]×[−1,1]` (ST-O4). Round: `8 + 1.5307337294603591`                                                                                                                        |
| ST-F7  | `M(4,5)`, every cap and join                                                                                                                                                                                                                                                               | `empty`                                                                                                                                                                                                                |
| ST-F8  | `M(4,5) L(4,5)`, `w = 2`                                                                                                                                                                                                                                                                   | Butt: `empty`. Round: one 16-gon at `(4,5)`, area `3.0614674589207183`. Square: area 4, bounds `(3,4,5,6)` (ST-O4)                                                                                                     |
| ST-F9  | `M(4,5) L(4,5) Z`, every cap and join                                                                                                                                                                                                                                                      | `empty`                                                                                                                                                                                                                |
| ST-F10 | `M(0,0) L(4,0) L(4,0) L(4,4)`, miter `L = 2`                                                                                                                                                                                                                                               | Same region as ST-F4 miter: area 16                                                                                                                                                                                    |
| ST-F11 | `M(0,0) L(4,0) L(4,4) L(0,4) Z`, `w = 2`, every cap                                                                                                                                                                                                                                        | Miter `L = 2`: area 32, region `[−1,5]² ∖ (1,3)²` (ST-O4). Bevel: 30. Round: `28 + 3.0614674589207183`. The cap has no effect                                                                                          |
| ST-F12 | `M(0,0) L(8,0) L(0,8)`, `w = 2`, butt, bevel                                                                                                                                                                                                                                               | `(0,4)` and `(−0.5,4)` outside; `(4,4)` and `(4,0.5)` inside: the implicit closing edge is not stroked (ST-O5)                                                                                                         |
| ST-F13 | `M(0,0) L(3,1) L(12,4)`, `w = 2`, butt, miter `L = 4`                                                                                                                                                                                                                                      | No join piece; the outgoing start triple equals the incoming end triple bit for bit; one boundary loop; area `2·sqrt(160) = 25.298221281347036`                                                                        |
| ST-F14 | (a) `M(0,2) L(4,2) M(2,0) L(2,4)`, `w = 2`, butt. (b) `M(0,2) L(4,2) L(4,4) L(2,4) L(2,0)`, `w = 2`, butt, miter `L = 2`                                                                                                                                                                   | (a) Area 12. (b) Area 20, three unit miter squares. Both: interior-disjoint triangles; no overlap counted twice (ST-O3, ST-O4)                                                                                         |
| ST-F15 | The s2 regular families [R1-R6](p3-stroke-numeric-experiment.md#frozen-literal-corpus), their stated widths, butt caps, at the nine s2 zoom/DPR pairs through `e = floor(log2(0.125/(zoom·DPR)))`: `e` = 3, 2, 2 (zoom 0.01), −3, −4, −5 (zoom 1), −9, −10, −11 (zoom 64), for DPR 1, 2, 3 | R1 and R2 `ok` at every `e`; R3 and R4 `ok` at `e = −3`; every other case `ok` or `work-limit`, listed; ST-O1 passes on every `ok`                                                                                     |
| ST-F16 | `M(0,0) C(1,1)(0,1)(1,0)`, `w = 0.125`, butt, `e = −8`                                                                                                                                                                                                                                     | One interior reversal at `t* = 1/2`; cusp center exactly `(0.5, 0.75)`; `n = 32`; `(0.5, 0.8)` inside (ST-O5)                                                                                                          |
| ST-F17 | `M(3,0) C(−1,0)(−1,0)(3,0)`, `w = 2`                                                                                                                                                                                                                                                       | Collinear, one turning point at `(0,0)`. Butt: `6 + 1.5307337294603591`. Square: `8 + 1.5307337294603591`. Round: `6 + 3.0614674589207183`                                                                             |
| ST-F18 | `M(0,0) C(0,0)(1,0)(3,1)`, `w = 2`, square                                                                                                                                                                                                                                                 | Start tangent `(1,0)`; stationary start on the first leaf's reduced cone; `(−0.9, 0.9)` inside, `(−1.1, 0)` and `(−0.5, 1.1)` outside                                                                                  |
| ST-F19 | `M(−1,0) C(1,0)(−1,0)(1,0)`, `w = 2`, butt                                                                                                                                                                                                                                                 | Collinear continuation at `t = 1/2`, no cusp disk; area 4, region `[−1,1]×[−1,1]` (ST-O4)                                                                                                                              |
| ST-F20 | The three s2 stationary probes, which s2 required to be `STATIONARY_UNSUPPORTED`; they are the inputs of ST-F18, ST-F17 and ST-F19, at `w = 2` and every cap                                                                                                                               | `ok`, classified as endpoint stationary, collinear reversal and collinear continuation; ST-O1 and ST-O2 pass                                                                                                           |
| ST-F21 | `M(0,0) L(4,0)`, `w = 2^-20`, butt                                                                                                                                                                                                                                                         | `ok`, area `2^-18` exactly (ST-O4)                                                                                                                                                                                     |
| ST-F22 | `M(2^40, 2^40) L(2^40 + 1, 2^40 + 1)`, `w = 2^-41`, butt                                                                                                                                                                                                                                   | `empty` (collapse, section 4.7)                                                                                                                                                                                        |
| ST-F23 | `M(2^60, 0) L(2^60 + 2^20, 0)`, `w = 2`                                                                                                                                                                                                                                                    | `numeric-range` (ST-G1)                                                                                                                                                                                                |
| ST-F24 | `M(0,0) L(1,0) L(0, 2^-20)`, `w = 2`, miter `L = 2^30`; and `L = 4`                                                                                                                                                                                                                        | `L = 2^30`: miter kept, `numeric-range` (ST-G3). `L = 4`: bevel, `ok`                                                                                                                                                  |
| ST-F25 | 90° turn (ST-F4) and the turns `M(0,0) L(25,0) L(18,24)` (ratio 5/3) and `M(0,0) L(25,0) L(1,7)` (ratio `sqrt(50)`), miter `L` in `1`, `Math.SQRT2`, `4`, `100`                                                                                                                            | Miter exactly where the ratio is at most `L`; every `ok` within the curve share (ST-O1)                                                                                                                                |
| ST-F26 | Current-cap fixtures: pieces 512 and 513; edges 1,024 and 1,025; `n = 256` and the next width that needs 512                                                                                                                                                                               | At the limit `ok` or another listed status; at limit + 1 `work-limit`. Labelled current-cap fixtures that a limit raise may re-baseline                                                                                |

Transport fixtures, outside this table, mirror V2's: each framing rejection, the status mapping with one fixture per reachable row, capacity retry with exact `required_output_bytes`, transport caps at limit and limit + 1, epoch exhaustion, zero allocation in `process`, and every fail-closed trigger through a wrapped export object.

Amended 2026-10-20 by ST-U4 (user decision and ST-A0 review; see the header notes):

- **ST-F16** is a labelled current-cap fixture. At `STROKE_V0_LIMITS` it is `work-limit`. Its literals above are checked under `WIDE_TEST_LIMITS` (§7.6).
- **ST-F16p** is ST-F16's curve and `w` at `e = −5`. Expected: `ok` at `STROKE_V0_LIMITS`, one interior reversal at `t* = 1/2`, one cusp disk with center exactly `(0.5, 0.75)` and `n = 8`, and `(0.5, 0.8)` inside.
- **ST-U4/tip-ratio** is `M(0,0) L(10,0) L(10,10)`, `w = 20`, butt, miter `L = 1e4`. Expected: `ok`, a kept miter, and the region is the square `[0,20]×[−10,10]`, area 400 (ST-O4).
- **ST-U4/folded-arc** is section 11.3's ST-D8 catcher.

Amended 2026-10-20, ST-A0 amendment (S8, M3), registering fixtures already in the code and plan:

- **ST-F13x** is `M(0,0) L(1,1) L(4,4)`, `w = 2`, butt, miter `L = 4`, added by ST-U3 beside ST-F13 for ST-D3, because ST-F13's directions `(3,1)` and `(9,3)` normalize to the same binary64 unit vector and so cannot detect an unshared continuation triple. Expectation: no join piece and the outgoing start triple equals the incoming end triple bit for bit. Its area is checked by ST-O3's `τ` band, not to `1e−12`, because the arrangement rounds its slanted sections at interior columns.
- **ST-U4/folded-arc, ST-U4/tip-ratio and ST-F16p** are registered in the notes above and in §11.3; they are listed here so that §11.2 is the complete fixture index.
- **ST-F26 at-limit statuses and causes are observations ST-U3 printed, not assertions** (its report table in the [ST-U3 plan section](p3-fill-stroke-meshes.md#b2-st-u3-line-stroke-kernel)). The test `st_f26_current_cap_fixtures` (`stroke_outline_tests.rs`) still accepts `ok` or `work-limit` for `edges-1024` and does not assert the causes named below; ST-U2's reference fixture set for ST-F26 differs (`packages/geometry-reference/src/stroke-region.ts:3028-3069`, staircase paths). Follow-up, owned by ST-U6: tighten those tests to the observed statuses and causes. Each row is a current-cap observation that a limit raise may re-baseline: pieces 512 (closed convex 256-gon, bevel) `work-limit` (arrangement `InputLimit`, more than 1,024 vertices); pieces 513 (open 256-segment staircase, square caps, bevel) `work-limit` (`PieceLimit`); edges 1024 (64 square-capped horizontal subpaths) `work-limit` (`max_work` exhausted); edges 1025 `work-limit` (`InputLimit`); `n = 256` (ST-F1 with round caps, `w = 400`) `ok`; `n = 512` (`w = 1000`) `work-limit` (`DiskLimit`).
  - Done 2026-10-21 in [ST-U6](p3-fill-stroke-meshes.md#b2-st-u6-renderer-stroke) (review S2), test-only: `st_f26_current_cap_fixtures` now asserts every row above as observed, status and cause: `pieces-512` and `edges-1025` `work-limit` (arrangement `InputLimit`), `pieces-513` `work-limit` (`PieceLimit`), `edges-1024` `work-limit` (arrangement `WorkLimit`, with `work_units` equal to `max_work`), `disk-256` `ok`, `disk-512` `work-limit` (`DiskLimit`). They stay current-cap observations that a limit raise may re-baseline; the release WASM is unchanged.

### 11.3 Seeded defects

Each is a `cfg(test)` fault switch or a test-only variant; the unit's PR lists each with its failing test.

| ID     | Defect                                                | Caught by                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-D1  | Miter decided by a Float64 comparison with an epsilon | ST-F5 neighbours                                                                                                                                                                                               |
| ST-D2  | Equality treated as bevel                             | ST-F5 at `L = 1.25`                                                                                                                                                                                            |
| ST-D3  | Forward-continuation triple not shared                | ST-F13 triple equality; ST-O3 boundary-loop count                                                                                                                                                              |
| ST-D4  | Implicit fill closing edge stroked                    | ST-F12                                                                                                                                                                                                         |
| ST-D5  | Zero-length segments kept for tangents                | ST-F10                                                                                                                                                                                                         |
| ST-D6  | User join applied at generated knots                  | ST-O2 on ST-F15 and ST-F16                                                                                                                                                                                     |
| ST-D7  | Cusp disk omitted                                     | ST-F16 membership; ST-O2                                                                                                                                                                                       |
| ST-D8  | Leaf test with factor 2 instead of 4                  | ST-O1 on a leaf whose band folds (inner offset crossing): a ST-F15 case named in ST-U4 before its first run, or, if none exposes it, a synthetic folded-band fixture added in ST-U4 with a literal expectation |
| ST-D9  | Disk count `n` halved                                 | ST-O1 on ST-F3 and ST-F16                                                                                                                                                                                      |
| ST-D10 | Square cap along the normal instead of the tangent    | ST-F2                                                                                                                                                                                                          |
| ST-D11 | Reversal treated as a miter turn                      | ST-F6                                                                                                                                                                                                          |
| ST-D12 | Arrangement tolerance `2^(e−1)`                       | A native assertion on the `τ` passed to `tessellate`                                                                                                                                                           |
| ST-D13 | A piece emitted clockwise                             | ST-O3 area on ST-F14 (b)                                                                                                                                                                                       |
| ST-D14 | Tip guard ST-G3 skipped                               | ST-F24 at `L = 2^30`                                                                                                                                                                                           |

Amended 2026-10-20 by ST-U4 (ST-A0 review):

- **ST-D8's catcher is the synthetic folded-band fixture `ST-U4/folded-arc`.** The ST-F15 case named before its first run (R6 at `e = −3`) did not expose the defect. The fixture is a cubic arc of radius 1 over 0.2 rad, with controls `(0.9950041652780257, ∓0.09983341664682815)` and `(1.001665278240658, ∓0.03344447228510901)`, `w = 9.94`, butt, `e = 0`. Its expectation was fixed before its first run: factor 4 gives `ok` with two depth-1 leaves that ST-O1 accepts; factor 2 gives one depth-0 leaf that ST-O1 rejects.
- **ST-D6 and ST-D7's ST-F16 checks** (ST-O2, and membership of `(0.5, 0.8)`) run under `WIDE_TEST_LIMITS`. ST-D6 is also caught by ST-O2 on ST-F15 R3 at `e = −5`, at production limits.

Amended 2026-10-20, ST-A0 amendment (S8): **ST-D9** (disk count halved) is named above as caught by ST-O1 on ST-F3 and ST-F16. ST-O1 is ST-U2's oracle, so ST-U3 caught it with **ST-F3's literal area** (8-gon caps), as its plan section records; the named ST-O1 catcher stays as the contract's check.

### 11.4 Stroke conformance suite

`tests/support/stroke-mesh-port-conformance.ts` exports `describeStrokeMeshPortConformance(name, createPort)` and runs against the WASM adapter in `pnpm test:geometry` and against a test double (`tests/support/stroke-mesh-port-double.ts`) in `pnpm test:unit`, as V2's suite does.

| ID   | Case                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC01 | Result length and order for 0, 1 and 5 requests                                                                                                                 |
| SC02 | `requestId` (0 and `2^32 − 1`) and `toleranceExponent` echoed on `ok`, `empty` and `failed`                                                                     |
| SC03 | Empty verbs, MOVE-only, and width 0 give `empty`                                                                                                                |
| SC04 | `invalid-path`: grammar error, odd point count, unknown verb byte, NaN coordinate                                                                               |
| SC05 | `invalid-stroke`: width −1, NaN, `Infinity`; miter limit 0.5, NaN, `Infinity`                                                                                   |
| SC06 | `invalid-tolerance` at −1021, 1024 and `1e10`; ST-F1 at −1020, 0 and 1023 is not `invalid-tolerance`                                                            |
| SC07 | Precedence: `invalid-path` beats `invalid-stroke` beats `invalid-tolerance`                                                                                     |
| SC08 | Per-path isolation: a failing path between two good paths leaves both identical to their single-request results                                                 |
| SC09 | A failed path carries no mesh field                                                                                                                             |
| SC10 | Each `invalid-request` row of section 8, with no results                                                                                                        |
| SC11 | Owned results across a second batch, forced memory growth (WASM run) and dispose                                                                                |
| SC12 | After dispose: `disposed`, also for an empty array; dispose twice is harmless                                                                                   |
| SC13 | Determinism: same request twice and at another batch position, bit-identical                                                                                    |
| SC14 | V2 mesh checks on every `ok` (conformity, boundary equals edges used once, orientation, bounds)                                                                 |
| SC15 | ST-F1, ST-F2, ST-F6, ST-F11 miter and ST-F14: exact area and region boundary against the independent oracle                                                     |
| SC16 | ST-F7 and ST-F9 `empty`; ST-F8 square: bounds `(3,4,5,6)`                                                                                                       |
| SC17 | `work-limit` for 65,537 `LINE` verbs, which exceeds P2 v1's per-path limit and so every stroke source cap (WASM run); configured code for the double            |
| SC18 | `numeric-range` for ST-F23 (WASM run); configured code for the double                                                                                           |
| SC19 | Request buffers mutated after the call do not change results                                                                                                    |
| SC20 | Stroke values reach the mesh: ST-F1, ST-F2 and ST-F3 differ only in `cap` and give their three expected areas; ST-F4 gives its expected area per join and limit |
| SC21 | `operationId` is `'geometry-wasm/stroke-v0'` and `portVersion` 0 (WASM run)                                                                                     |
| SC22 | Fill and stroke adapters from one compiled module are isolated: disposing one leaves the other usable (WASM run)                                                |

## 12. Units, acceptance and review

### 12.1 Units

Each unit is its own PR from an updated `main`. ST-U3, ST-U4 and ST-U5 are high-risk numeric and lifecycle work: the Primary or an Opus implementer does them.

| Unit   | Tier  | Scope                                                                                                                                                                                                                                              | Files (expected)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Needs        |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| ST-U2  | Light | Independent oracle ST-O1 to ST-O5 with positive controls; exact radical comparisons; the s1 verifier for leaves                                                                                                                                    | `packages/geometry-reference/src/stroke-region.ts` (new), `packages/geometry-reference/src/index.ts`, `tests/unit/geometry-stroke-region.test.ts` (new)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | ST-U1        |
| ST-U3  | Light | Kernel front end for line-only strokes: ST-S1 to ST-S7, ST-S9, ST-S10, pieces ST-P1 and ST-P3 to ST-P7, disk table, exact predicates, guards ST-G1 to ST-G3 and ST-G6, resolution with `STROKE_V0_LIMITS`, the dump hook, the stage-to-proof table | `packages/geometry-wasm/kernel/src/stroke_outline.rs` (new), `stroke_outline_tests.rs` (new), `stroke_dump_tests.rs` (new), `lib.rs` (module declarations only), `tests/geometry/stroke-oracle.test.ts` (new), `tests/geometry/stroke-oracle/` (dump reader)                                                                                                                                                                                                                                                                                                                                                                             | ST-U1, ST-U2 |
| ST-U3b | Light | B2-Q8 native scaling probe: an ignored native test timing line strokes of 1 to 512 segments with each join and cap, within the limits; reported to the user as an observation with a recommendation on ST-U9; no threshold, no performance claim   | `packages/geometry-wasm/kernel/src/stroke_probe_tests.rs` (new, `cfg(test)`), the plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ST-U3        |
| ST-U4  | Light | Cubic strokes: stationary classification (section 4.6), leaves (section 4.5), cusp disks, guards ST-G4 and ST-G5, work limits                                                                                                                      | `packages/geometry-wasm/kernel/src/stroke_cubic.rs` (new), `stroke_cubic_tests.rs` (new), `stroke_outline.rs`, `stroke_dump_tests.rs`, `lib.rs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ST-U3        |
| ST-U5  | Full  | `stroke_v0_*` export and `StrokeEngine`; `StrokeMeshPort` types; `createStrokeMeshPort`; the conformance suite and double; transport fixtures; the documents of section 1.3 for ST-U5                                                              | `packages/geometry-wasm/kernel/src/stroke_export.rs` (new), `stroke_export_tests.rs` (new), `lib.rs` (exports), `packages/contracts/src/geometry.ts`, `packages/geometry-wasm/src/stroke-adapter.ts` (new), `packages/geometry-wasm/src/index.ts`, `tests/support/stroke-mesh-port-conformance.ts`, `tests/support/stroke-mesh-port-double.ts`, `tests/geometry/stroke-mesh-port.test.ts`, `tests/geometry/stroke-adapter.test.ts`, `tests/unit/stroke-mesh-port-double.test.ts`, `ARCHITECTURE.md`, `docs/decisions/0002-path-scene-and-fill-mesh-port.md`, `docs/graphics-engine-architecture.md`, `docs/plans/p3-private-contract.md` | ST-U3        |
| ST-U6  | Full  | Scene `PathStroke` and validation; renderer-core stroke port, keys, memo, batch, records, draws, culling, notices and the opacity staging; V3 amendment notes                                                                                      | `packages/contracts/src/scene.ts`, `packages/contracts/src/diagnostics.ts`, `packages/renderer-core/src/scene-validation.ts`, `scene-mirror.ts`, `primitive-renderer-service.ts`, `path-mesh-pipeline.ts`, `path-mesh-packet.ts`, `path-buckets.ts`, the playground and tests that build `PathStyle`, `tests/unit/` stroke tests (new), `tests/support/v3b-mesh-harness.ts`, `docs/plans/p3-v3-renderer-mesh-pipeline-contract.md`                                                                                                                                                                                                       | ST-U5        |
| ST-U7  | Full  | Joint-coverage fill draw for both paints at `0 < opacity < 1`, removing `composition-unsupported`. Starts with its own design addendum (overlay of the two meshes, feature lists, roles), independently reviewed and approved before code          | Fixed by its addendum                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ST-U6        |
| ST-U8  | Light | Playground stroke page with headed screenshots (UNVERIFIED label); stroke rows proposed for the B4 corpus (thin strokes, extreme miters, wide strokes on curves, zoom 0.01/1/64, DPR 1/2/3)                                                        | `apps/playground/src/`, `tests/browser/` or `tests/gpu/` stroke cases, the plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ST-U6, V4    |
| ST-U9  | Full  | Conditional: a certified direct-tessellation fast rung (family B), only if ST-U3b's report and the user ask for it; its own contract                                                                                                               | Fixed by its contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ST-U4, probe |

### 12.2 Acceptance criteria

| ID     | Criterion                                                                                                                                                                                                                                                                                                 | Command or check                                                                                                                                                                                                                                                                    | Units          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| ST-A0  | Contract frozen; its independent review recorded                                                                                                                                                                                                                                                          | Status line and section 15. The owed `reviewer` review READY before ST-U3 merges                                                                                                                                                                                                    | U1, U3         |
| ST-A1  | Semantics: every row of section 2.3 with a stroke component has a fixture whose result equals its literal expectation                                                                                                                                                                                     | `pnpm test:geometry`: ST-F1 to ST-F14, ST-F16 to ST-F19 and ST-F21 to ST-F24 natively and through `tests/geometry/stroke-oracle.test.ts`                                                                                                                                            | U3, U4         |
| ST-A2  | Union: self-overlapping strokes produce a conforming mesh with interior-disjoint triangles and the oracle's union area; no overlap counted twice                                                                                                                                                          | `pnpm test:geometry`: ST-O3 and ST-O4 on ST-F14, ST-F6 and ST-F17                                                                                                                                                                                                                   | U3, U4         |
| ST-A3  | Curve share: every `ok` piece within its section 3 share by ST-O1; non-finishing cases are `work-limit` and listed, never accepted coarse                                                                                                                                                                 | `pnpm test:geometry`: ST-O1 on every dumped fixture, including ST-F15 and ST-F20; the list of `work-limit` cases in the PR                                                                                                                                                          | U3, U4         |
| ST-A4  | Joins and tips: the miter predicate is exact on ST-F5 and its Float64 neighbours; tips at `L = 1`, `sqrt(2)`, 4 and 100 within the share or `numeric-range`                                                                                                                                               | `pnpm test:geometry`: ST-F5, ST-F24, ST-F25                                                                                                                                                                                                                                         | U3             |
| ST-A5  | Oracle validity: every positive control of section 11.1 rejected                                                                                                                                                                                                                                          | `pnpm test:unit` (`tests/unit/geometry-stroke-region.test.ts`)                                                                                                                                                                                                                      | U2             |
| ST-A6  | Seeded defects: each ST-D defect fails its named test                                                                                                                                                                                                                                                     | The unit's PR lists each defect, its switch and the failing test output                                                                                                                                                                                                             | U3, U4         |
| ST-A7  | Transport: framing, capacity, epochs, dispose, zero allocation, limit and limit + 1, status mapping                                                                                                                                                                                                       | `pnpm test:geometry` (native `stroke_export_tests.rs` and `tests/geometry/stroke-adapter.test.ts`)                                                                                                                                                                                  | U5             |
| ST-A8  | Port: SC01-SC22 pass on the WASM adapter and the double                                                                                                                                                                                                                                                   | `pnpm test:geometry` and `pnpm test:unit`                                                                                                                                                                                                                                           | U5             |
| ST-A9  | Nothing else changes: P2 output bytes, fill outputs, fill conformance, dependencies                                                                                                                                                                                                                       | `pnpm test:p2-identity` PASS; `pnpm test:p3-fill-identity` PASS in plain mode; C01-C18 unchanged and passing; `git diff --exit-code main -- packages/geometry-wasm/kernel/Cargo.toml packages/geometry-wasm/kernel/Cargo.lock pnpm-lock.yaml` exits 0; `pnpm check:boundaries` PASS | U3, U4, U5, U6 |
| ST-A10 | Renderer: validation rows, keys, one stroke call per `prepare` with isolation, paint order, two-draw composition at opacity 1, single-paint paths at opacity 0.5, `composition-unsupported` at 0.5 with both paints, culling bounds, notices with `paint`, device-loss reconstruction without a port call | `pnpm test:unit` (renderer-core stroke tests); `pnpm test:gpu` stroke fixtures, including the approved example's stroke-only and fill-only pixels and the interim failure for its overlap case                                                                                      | U6             |
| ST-A11 | Joint coverage: the approved example (red fill, blue stroke, opacity 0.5) gives `(0, 0, 0.5, 0.5)` in the overlap                                                                                                                                                                                         | Fixed by ST-U7's addendum; `pnpm test:gpu`                                                                                                                                                                                                                                          | U7             |
| ST-A12 | Static checks, documentation and labels                                                                                                                                                                                                                                                                   | `pnpm check`, `pnpm build`; `cargo fmt` and `clippy -D warnings` inside `pnpm test:geometry`; `pnpm exec prettier --check` on changed Markdown, a local link and anchor check, `git diff --check`; UNVERIFIED label in every PR and plan entry; plan B2 row updated                 | every unit     |

Amended 2026-10-20 by ST-U4 (user decision and ST-A0 review): ST-A1's ST-F16 entry reads "ST-F16 under the test-only limits `WIDE_TEST_LIMITS` (§7.6), and `work-limit` at production limits". ST-F16p, which is `ok` at production limits, evidences ST-S8 there.

Amended 2026-10-20, ST-A0 amendment (B2): ST-A0's check "The owed `reviewer` review READY before ST-U3 merges" is superseded. ST-U3 and ST-U5 merged first under the user's 2026-10-20 exception; the review ran with verdict NOT READY. ST-A0 is met when the ST-A0 amendments land, with an independent review of them READY (or READY WITH FOLLOW-UPS and its follow-ups recorded), before ST-U6 merges.

Each PR follows the `AGENTS.md` description format, states `NOT RUN` with a reason for any check it skips, carries the UNVERIFIED label and makes no performance claim.

### 12.3 Review plan

1. **This contract:** the owed fresh-context `reviewer` review, full tier, with specific checks of section 4.5's factor 4 and hull argument, section 4.6's classification, the crack-freeness argument of section 4.2, the guards of section 4.7, the limits of section 7.6 and the opacity rule of section 9.6. Findings are applied as dated amendments before ST-U3 merges; a finding that changes a user decision goes to the user.
   - Amended 2026-10-20, ST-A0 amendment (B2): the review ran before ST-U5 merged (verdict NOT READY) and its findings are applied by dated notes before ST-U6 merges, not before ST-U3. The amendments themselves need an independent review READY (or READY WITH FOLLOW-UPS and its follow-ups recorded) before ST-U6 merges. The cubic `work-limit` findings (S7) were escalated to the user as the pending ST-U9 decision.
2. **ST-U2, ST-U3, ST-U3b, ST-U4:** one independent diff review each, with the stage-to-proof table checked for ST-U3 and ST-U4.
3. **ST-U5, ST-U6:** independent diff review and evidence review.
4. **ST-U7, ST-U9:** independent review of the addendum or contract, then of the diff and evidence.

## 13. Risks and open obligations

**Risks.**

- **Cost of the exact arrangement.** Every stroke takes the exact path with all-pairs work (`max_pairs` 523,776). B0 found exact arithmetic to be the fill cost driver. ST-U3b observes it; ST-U9 is the planned answer, gated by that report and the user.
- **Limits.** A stroke beyond section 7.6 is `work-limit`, visible as an interim failure. Wide round caps at deep zoom need many disk vertices (`n ≤ 256` allows a half-width of about 400 physical px at the arc share); beyond that, `work-limit`.
- **Whole-path failure.** Under section 9.6, a failing stroke hides the path's fill too. This follows V1-Q4's approved outcome; it makes stroke limits visible on filled paths.
- **Thin strokes and A5.** O02's coverage rule was measured on fills. Its behavior on regions narrower than a pixel is untested; ST-U8 and B4 include sub-pixel strokes.
- **Guard constants.** The constants of sections 4.4 to 4.7 are conservative design values; their proofs land in ST-U3 and ST-U4. A constant found insufficient is strengthened, never relaxed, and ST-O1 checks every output independently.
- **Slivers.** Hull pieces and shared seams create thin triangles in the arrangement output; they bear on R0 and on the fringe builder's cost (V4's gate).
- **Fill and stroke seams.** The fill boundary lies under the stroke center; at opacity 1 the stroke covers the fill's fringe exactly, and ST-U7 handles the rest.

**Open obligations.**

- **ST-OB1.** The independent review of this contract is owed (status line). Amended 2026-10-20: it ran (NOT READY); its amendments are due before ST-U6 merges, with an independent review of them READY (or READY WITH FOLLOW-UPS and its follow-ups recorded).
- **ST-OB2.** The stage-to-proof tables of ST-U3 and ST-U4 discharge the per-piece bounds of section 4; P3.0b-s1's proof boundaries are assigned as follows: resolved-region topology by the arrangement; stationary handling by section 4.6; miter tips by ST-G3; round arcs by section 4.4.
- **ST-OB3.** A04 for strokes, through B4, with the rows ST-U8 proposes.
- **ST-OB4.** C04 items 1-6 stay open (section 10).
- **ST-OB5.** ST-U7's joint-coverage design addendum.
- **ST-OB6.** ST-U9, conditional on ST-U3b and the user.
- **ST-OB7.** The deferred tighter regular-stroke bound stays deferred unless ST-U4's work limits or B4 show the need (B2-Q7).
- **ST-OB8.** Dashes, in the later appearance plan.

## 14. Decisions

No new user decision is asked. The Primary technical choices made here, open to the owed review: convex hull pieces with shared sample triples (section 4.2); the factor 4 in the leaf test (section 4.5); the reduced cone at stationary ends and the classification of section 4.6; transcendental-free arithmetic (section 4.2); the limits and heap cap (section 7.6); the tolerance range `−1020 ≤ e ≤ 1023` (section 7.7); `invalid-stroke` before `invalid-tolerance` (section 7.8); per-node second slot for stroke records (section 9.5); whole-path failure when one paint fails (section 9.6); the `1.5` square-cap factor in the culling bound (section 9.7).

## 15. Review and approval record

- **2026-10-20, frozen.** Written by a Primary-delegated agent as ST-U1, from the approved proposal and the user's answers B2-Q1 to B2-Q9 (a). Independent review NOT RUN — owed: the user skipped independent reviews for 2026-10-20 only.
