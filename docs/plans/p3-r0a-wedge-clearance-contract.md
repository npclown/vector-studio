# P3.1n R0a exterior-wedge clearance contract

Status: FROZEN, 2026-10-07, after independent Astra high proof review. Round 1 was NOT FREEZE-READY: W5 rounding was inexact. Revision 2 confirmation added the coincident-ray rule and separated the throw codes. Implementation is authorized after integration. It implements the user's 2026-10-07 choice of R0a in the [R0 readiness note](p3-r0-triangulation-readiness.md). The [position certificate](p3-position-certificate-contract.md) and its archived evidence remain unchanged; this contract defines a successor clearance variant, C2. The [private contract](p3-private-contract.md) owns C04, and the [active plan](p3-fill-stroke-meshes.md) owns status.

This is test-only. It makes no visible change and adopts nothing. C2 changes only which sufficient topology condition the certificate checks. Positions, guards, Pack, Shader and Phi are reused unchanged. The vertex, edge and triangle terms, including P3.1m's shared `Plo` over triangle and fan pairs, are also reused unchanged.

## Motivation

The P3.1m `fan` term requires every pair of edges incident at a vertex to keep a cross or dot margin. That is K's `shared` predicate, which preserves the sign of every incident pair. Its false positive is a nearly straight boundary bend that may flip between convex and reflex without any folding. The rounded embedding creates exactly such bends at slab-column nodes. The readiness review showed that they bind every Y class B row.

## Input validity (precondition)

Validity at t = 0 is a precondition.

- **Carrier rows** are checked by J's `verifyConformingRefinement` and by `inspectTriangleMesh`.
- **Literal rows** are valid by construction.

Wedge identification also checks two things on exact original local coordinates:

- **Orientation:** all triangles must share one nonzero orientation sign σ_m. Otherwise it throws `input:wedge-orientation`.
- **Directed edges:** no directed edge may be used twice. Otherwise it throws `input:wedge-nonmanifold`.

## Sufficiency theorem (W1)

Take a valid input mesh: conforming, with consistently oriented triangles, interiors pairwise disjoint, possibly with several components, holes or pinch vertices. Each vertex moves along a straight segment, at physical distance at most δ from its reference position, for t ∈ [0, 1]. The mesh stays a valid embedding for every t if, for every t, all of the following hold:

1. Every triangle keeps its orientation sign. This is the unchanged `triangle` term.
2. Distinct vertices stay distinct. This is the unchanged `vertex` term.
3. Non-incident edges stay disjoint. This is the unchanged `edge` term.
4. The new `wedge` condition holds: the two rays bounding each exterior wedge never coincide in direction.

**Proof, for review.** The steps below must each be written out in the evidence review.

- **(a) Interior vertices.** Under condition 1, each triangle angle stays in (0, π) and varies continuously. The incident angles sum to 2π·k. The sum is continuous and k is an integer, so k stays 1.
- **(b) Boundary vertices, including pinch vertices.**
  - Take the cyclic sequence of incident wedges fixed at t = 0.
  - The counterclockwise angle from a to b is continuous on non-coincident pairs, so condition 4 keeps every exterior wedge angle in (0, 2π) without jumping between 0 and 2π. Interior wedges are triangle angles in (0, π).
  - All cyclic gaps are therefore positive and sum to 2π, so all ray directions are distinct.
  - Hence incident edges meet only at their shared vertex. This covers a boundary vertex sliding onto an adjacent incident edge.
- **(c) Edge interiors.** Orientation preservation keeps the two triangles of an interior edge on opposite sides.
- **(d) Global injectivity.**
  - The set of times at which the mesh is injective is open, because the domain is compact and the mesh is locally injective.
  - By invariance of domain, the first coincidence must be between boundary features: vertex-vertex, vertex-edge or edge-edge.
  - Vertex-vertex coincidence is excluded by condition 2.
  - Edge-edge coincidence between non-incident edges is excluded by condition 3; incident edges are handled by (b).
  - Vertex-edge: let vertex v touch edge ab. If every edge at v ends in {a, b}, then v has degree 2 and its unique triangle is (v, a, b), which condition 1 excludes. Otherwise some edge vw with w ∉ {a, b} is non-incident to ab, and condition 3 excludes the contact.

Interior fan pairs need no separate condition, so `wedge` replaces `fan` entirely.

## Exterior wedge identification (W4)

1. At each vertex, sort incident edges counterclockwise by exact angular comparison on local coordinates: half-plane, then cross sign. The cyclic wrap is included. If two incident rays have cross = 0 and dot > 0 (P3.1m's `overlappingFan`), throw `input:wedge-degenerate`.
2. Take a triangle (p, x, y) in index order. The interior ordered pair at p is (px, py) if σ_m > 0, and (py, px) otherwise.
3. A consecutive pair (e_i, e_{i+1}) is exterior if it is not an interior ordered pair. Every vertex has at least two edges.

The wedge term below is symmetric in a and b, so the sign of det S is irrelevant.

## Wedge term (W2, W3)

For an exterior wedge with exact reference physical rays `a = S·u` and `b = S·v`, where `S = zoom0 * dpr0 * L`:

- **Lengths:** `La = min(sqrtUp(a·a), σ̄max * ‖u‖₁)`, and likewise `Lb`. Both are upper bounds on |a|, because `|Su|₂ ≤ ‖S‖_F |u|₂ ≤ σ̄max ‖u‖₁`.
- **`W_lo`:**
  - if `a·b ≤ 0`: `W_lo = max(sqrtDown((a·a)(b·b)), -a·b) - a·b`. This uses `|a||b| ≥ |a·b|`, and is exactly `2|a·b|` for collinear-opposite rays;
  - otherwise: `W_lo = cross(a, b)² / (2 * sqrtUp((a·a)(b·b)))`.
- **Root helpers:**
  - `sqrtDown(v) = floor(sqrt(floor(v * 2^128))) / 2^64`, computed by integer Newton iteration;
  - `sqrtUp` is the existing upward root.

**Pass condition, strict.** The wedge passes if either margin holds:

- **Cross margin:** `abs(cross(a, b)) > crossRHS = 2δ̄(La + Lb) + 4δ̄²`. If cross keeps its sign, the rays never coincide.
- **W margin:** `W_lo > WRHS = 4δ̄(La + Lb) + 8δ̄²`. This keeps `a·b < |a||b|`.

Otherwise the result is `NOT_ADMITTED:clearance:wedge`.

**W2 (perturbation).** Ray tips move by at most 2δ. Hence `|Δcross| ≤ 2δ(|a| + |b|) + 4δ²` and `|ΔW| ≤ 4δ(|a| + |b|) + 8δ²`.

**Slack.** Per-wedge slack is `max(abs(cross) - crossRHS, W_lo - WRHS)`. The report gives the minimum over exterior wedges, together with the vertex and the winning margin.

## Monotonicity (W5)

Every exterior pair at a vertex is a fan pair in P3.1m. Because the shared `Plo` includes fan pairs, `Plo ≤ ‖u‖∞ + ‖v‖∞ ≤ ‖u‖₁ + ‖v‖₁`.

- **Non-collinear case:**
  - `|cross(a, b)| = |det S| |cross_l| ≥ |det S| κ̄ (‖u‖₁ + ‖v‖₁)`;
  - `|det S| κ̄ (‖u‖₁ + ‖v‖₁) > 2δ̄σ̄max(‖u‖₁ + ‖v‖₁) + 4δ̄²(‖u‖₁ + ‖v‖₁)/Plo`;
  - `2δ̄σ̄max(‖u‖₁ + ‖v‖₁) + 4δ̄²(‖u‖₁ + ‖v‖₁)/Plo ≥ 2δ̄(La + Lb) + 4δ̄²`.
- **Collinear-opposite case:**
  - `W_lo = 2|a·b| ≥ 2σ_lo²λ̄(‖u‖₁ + ‖v‖₁)`, since `σ_lo ≤ σmin`;
  - `2σ_lo²λ̄(‖u‖₁ + ‖v‖₁) > 2(2δ̄σ̄max + 4δ̄²/Plo)(‖u‖₁ + ‖v‖₁)`;
  - `2(2δ̄σ̄max + 4δ̄²/Plo)(‖u‖₁ + ‖v‖₁) ≥ WRHS`.

Hence C2 admits every row that P3.1m admits, exactly. `input:wedge-degenerate` coincides with P3.1m's `overlappingFan`, so it never occurs on a P3.1m-admitted row. `input:wedge-nonmanifold` and `input:wedge-orientation` violate the precondition and are expected on no corpus row. A test asserts both properties on every row, and expects zero throws on the corpus.

## C2 outcome and result shape

C2 checks guards, then position, then clearance in the order `vertex`, `edge`, `triangle`, `wedge`. The outcome strings are the M03 strings with `fan` replaced by `wedge`.

The result has the shape `{status, reason, delta2Max, clearance: {term ∈ vertex | edge | triangle | wedge | null}, wedge: {vertex, margin: 'cross' | 'W', slack} | null, p31mFan}`. Here `p31mFan` is the P3.1m outcome, reported for comparison.

**Policies:**

- the fixture origin;
- `O-PX(128)` pointwise;
- `O-PX(128)` window.

The window uses `δ² = max_i(ewx_i² + ewy_i²)` from `certifyWindow` at `O-PX(128)` with `halfWidth = 2g`, as in R3's `clearanceAtDelta`. O-P1 is excluded.

## Corpus, counterfactual and evidence

**Inputs.** All inputs are reused unchanged:

- 158 fixture rows;
- the P3.1m literal rows;
- prospective controls.

**Prospective counterfactual.** The 12 Y and 4 Z S5 class B `fan` rows are expected to be admitted, provided their vertex, edge and triangle terms pass. The 12 Z `edge` rows are expected to stay `edge`. Every P3.1m-admitted row stays admitted, by W5. THIN and FTZ stay `vertex`.

**Disclosure.** The independent reviewer of revision 1 ran a read-only scratch estimate at the fixture origin:

| Rows                    | Estimated C2 outcome | Minimum margin ratio |
| ----------------------- | -------------------- | -------------------- |
| 12 Y class B `fan` rows | All admitted         | 5.20                 |
| 4 Z S5 rows             | All admitted         | 139.6                |
| 12 Z `edge` rows        | Unchanged            | —                    |
| All other rows          | Unchanged            | —                    |

The estimate found no new rejection, no throw, and pinch vertices with two or more exterior wedges in Y and Z. It did not evaluate O-PX(128). The estimate is not an acceptance target. The rule changes in this revision (exact W5 rounding, orientation handling and slack definition) are soundness fixes and do not depend on it.

**Controls:**

- a straight boundary node passes;
- a nearly closed acute exterior wedge passes only through the cross margin when it qualifies;
- a nearly closed acute wedge fails when neither margin holds;
- a pinch vertex (bowtie) has two exterior wedges;
- an interior vertex has no exterior wedge;
- a reflected (`det L < 0`) input gives the same wedges;
- inconsistent orientation throws `input:wedge-orientation`;
- coincident same-direction rays throw `input:wedge-degenerate`;
- a duplicated directed edge throws `input:wedge-nonmanifold`;
- `sqrtDown ≤ sqrt ≤ sqrtUp` holds, including at large magnitudes;
- a separate worker module independently recomputes wedge identification and both margins.

**Evidence report.** `docs/evidence/p3.1n-r0a-wedge/report.json` is regenerated byte for byte by its test, and written only when `P3_R0A_WRITE=1`. It contains:

- per row and per policy: the C2 result, `p31mFan`, the binding term and the minimum wedge slack (exact and approximate);
- the hashes of `certificate.ts`, `r3-window.ts`, the archived reports and the new sources;
- the admitted-row lists.

There are no timing fields. The test asserts the `certificate.ts` SHA-256 `dea97bcd…`. The review record is `docs/evidence/p3.1n-r0a-wedge/review-2026-10-07.md`.

## Ownership and validation

| Owner      | Files                                                                                                                                                                                                | Constraint                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary    | `tests/geometry/position-certificate/wedge.ts`, exporting `exteriorWedges(mesh)`, `wedgeTerm(input, delta2)`, `sqrtDown`, `certifyC2(input, origin)` and `certifyC2Window(input, origin, halfWidth)` | —                                                                                                                                              |
| Primary    | The test `tests/geometry/position-certificate-r0a.test.ts`                                                                                                                                           | —                                                                                                                                              |
| Sol medium | `tests/geometry/position-certificate/wedge-independent.ts`                                                                                                                                           | May import only `rounded-fill/exact.ts`, plus `sqrtUp` and `q` from `certificate.ts`. Must not import `wedge.ts` or other clearance internals. |

`certificate.ts`, `r3-window.ts` and the archived reports are unchanged.

Validation is `pnpm check`, `pnpm test:geometry`, `pnpm build`, and the changed-Markdown and link checks. There is no GPU run and no Rust change. The active plan gets a status entry.

**Dependency order:** `R0a decided -> this contract FROZEN -> implementation -> stable-source review -> exact evaluation -> independent evidence review -> later decision on whether C2 replaces the P3.1m clearance for any adoption`.
