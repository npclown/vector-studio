# P3.1p R2 tiling contract

Status: FROZEN, 2026-10-08, at revision 3 plus two confirmation fixes. T02 implementation is authorized after integration.

**Contract identity.** The integrating `main` commit, plus this note's SHA-256 at that commit.

**Review history.**

- **Revision 1:** Astra high returned NOT READY (6 blocking); Sol medium returned NOT IMPLEMENTABLE (9 blocking). Revision 2 addresses all of them.
- **Revision 2:** Sol medium returned IMPLEMENTABLE with 11 SHOULD-FIX items; Astra high returned NOT READY with 4 blocking items (the reach norm, the pruning bound, the epoch dependence of fringe sets and lists, and the sliver predicate). Revision 3 addresses all of them and the SHOULD-FIX items.
- **Revision 3:** Astra high returned READY, with two optional one-line fixes, which are applied: the fringe and list cache key, and the pair-term locus in the sliver predicate.
- **Main changes in revision 2:**
  - An epoch, so that nothing is assumed constant that is not.
  - The certificate covers every drawn record, so the submesh argument is gone.
  - A fixed list reach.
  - Gates that can fail.
  - A pre-stated sliver hazard.
  - An explicit merged-mesh type and report schema.

The user confirmed E1-E3 in chat on 2026-10-08, choosing the recommended option for each.

**Authorization.** On 2026-10-07 the user decided D1 in chat: [K1 with `T_tile = 256` and D3(a)](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06), after the accepted [T01 evidence](../evidence/p3.1p-t01/review-2026-10-07.md). The standing continuation instruction covered drafting this contract. E1-E3 needed separate confirmation, which the user gave on 2026-10-08, because they change, respectively:

- the C04 representation direction;
- the reading of the architecture's transform-only rule;
- the Q1 coverage reference.

**Ownership.**

- The [R2 readiness note](p3-r2-tiling-readiness.md) owns D1-D7. This contract settles D3, D4, D5 and D7 for K1, and leaves D6 (C04 layout) open.
- The [private contract](p3-private-contract.md) owns C04 and the user decisions.
- The [raster coverage readiness note](p3-raster-coverage-readiness.md) owns Q1, Q10 and Q11. Once confirmed, E3 is recorded there.
- [`graphics-engine-architecture.md`](../graphics-engine-architecture.md) owns the transform-only rule. Once confirmed, E2 is recorded there.
- The [active plan](p3-fill-stroke-meshes.md) owns status.

**What it is not.** It freezes no byte layout, ABI, runtime check or public API, and it adds no dependency. Stroke stays deferred. Its evidence is test-only: T02 is offline and exact, and O03 is a GPU run under its own later contract.

## Question

What exact mechanism and successor certificate make K1 at `T_tile = 256` correct inside the U1 domain, for every frame that reuses uploaded data? The answer settles what T01 left open:

- the certificate itself;
- tile-seam watertightness;
- level selection and the tile cache;
- clearance across tiles;
- the exterior partition;
- evidence.

## Terms

T01's [terms](p3-t01-extent-experiment-contract.md#terms) apply unless restated.

- Physical px are y-down.
- Reference quantities use the original binary64 inputs: `A0` (entries a, b, c, d), `e0`, `zoom0`, `dpr0`, and `s0 = zoom0 · dpr0`.
- Lane quantities use the f32 lanes, as in T01: `‖A‖∞`, `z`, `q`, and `zq = z · q`.
- A reference point `p` lands at physical `(A0·p + e0 − camera) · s0`.

**Guard.** `γ = 4` physical px (P1). `V = [0, W] × [0, H]`.

**Epoch.** An epoch is a key `κ = (O, g, L, W, H, q, A0, e0, mesh revision)` together with a zoom interval.

- `(O, g)` comes from `originPXTarget(camera, zoom, dpr, 128, previous)`, R3's O-PX(128) with carried state.
- `L` is T01's level: the largest integer with `2^L · ‖A‖∞ · zq ≤ 256`.
- `g` is constant exactly for `zq ∈ (64/g, 128/g]`, and `L` exactly for `zq ∈ (128/(2^L‖A‖∞), 256/(2^L‖A‖∞)]`. The epoch's lane interval `(zq_lo, zq_hi]` is the intersection of the two.
- Because `z = fround(zoom0)` and `q = fround(dpr0)` give `|zq − s0| ≤ (2^-23 + 2^-48) · s0`, the reference scale lies within `[s_lo, s_hi] = [zq_lo · (1 − 2^-22), zq_hi · (1 + 2^-22)]`.
- A frame belongs to κ when all of these hold:
  - its key fields are equal to κ's;
  - its camera satisfies `|c − O|∞ ≤ 2g`;
  - its `zq` lies in the epoch's lane interval.

Any other frame starts a new epoch. These are the cases:

- a rebase;
- a level change;
- a DPR change;
- a resize;
- an edit of the object affine;
- a geometry edit.

**Epoch window.** `D̂` is a document-space rectangle:

`[O_x − 2g − γ/s_lo, O_x + 2g + (W + γ)/s_lo] × [O_y − 2g − γ/s_lo, O_y + 2g + (H + γ)/s_lo]`.

It contains the document preimage of `V_γ` for every camera and scale of the epoch. Its local preimage `P̂ = A0⁻¹ · (D̂ − e0)` is a parallelogram, and its exact vertices are rational.

**Cells and owner.** Cells are T01's half-open local squares of side `2^L`. The owner cell of an exact point `v` is `(⌊v_x / 2^L⌋, ⌊v_y / 2^L⌋)`, taken on the exact `R(v)` and never on `v64`. The candidate set holds the cells whose closed square meets `P̂`, by an exact separating-axis test. This replaces T01's bounding-box rule.

**Reach constants.** These are exact rationals:

- `n = sqrtUp(max(c² + d², a² + b²)) / |ad − bc|` on `A0`. `A0⁻¹ = (1/det)·[[d, −c], [−b, a]]`, so `n` is its largest row 2-norm, which bounds `‖A0⁻¹‖₂→∞`. A local ∞-distance is therefore at most `n / s` times the physical distance. A host test checks `n ≥ ‖A0⁻¹‖₂→∞` on shear and non-uniform affines.
- `s_L = 128 / (2^L · ‖A‖∞) · (1 − 2^-22)` is the level band's floor. It is at most every epoch's `s_lo` at level L.
- `ρ_L = 2 · n / s_L`, the fringe reach in the local ∞-norm (P3).
- `λ_L = (3/2 + 2/16) · n / s_L = (13/8) · n / s_L`, the list reach in the local ∞-norm (P4).
- `ρ_L` and `λ_L` depend only on `(L, ‖A‖∞, n)`, never on the epoch's origin or camera.

## User decisions (confirmed 2026-10-08)

### E1. Shared vertex records with a per-vertex carrier (seam watertightness): CONFIRMED

**Problem.** T01 copies every seam vertex into each tile, and each copy gets its own carrier. The copies land at different positions, by up to σ = 9.9e-3 px. A gap or overlap that size sometimes captures a sample, which breaks G3 (one count per sample) and double-blends alpha.

**Proposal.** Each mesh, at each level, has exactly one record per exact reference position. The record holds:

- `u = fround(fl64(v64 − m_owner))`, with `v64 = RN64(R(v))`;
- the index of its owner cell's carrier.

A carrier holds the geometry-owned centre `m`, which must be exact in binary64 (otherwise `NOT_ADMITTED:lane-range`), plus the origin-owned lanes `B = fround(fl64(a·m_x + c·m_y + e − O_x))` (and `B_y`), exactly as in T01.

Every region and fringe triangle indexes shared records. Each drawn position therefore comes from identical inputs through one function, and the drawn mesh is one conforming mesh with no seam copies.

The vertex shader marks its position `@invariant`. That gives bit-equal positions across the main and count pipelines. Neither the role flag nor any per-primitive data may change the position inputs or the position code path.

- `|u_x|, |u_y| ≤ 2^(L−1)` plus one ulp of `v64`, because ownership uses the exact `R(v)` and `v64` may round across a grid line. The bound is reached only on an owner cell's lower or left edge, and it is enforced by S1's lane guard. This matches T01's per-axis bound.
- A kind-4 corner's owner is the cell whose lower-left corner it is.
- A carrier exists for every owner cell that a record references, even one with no piece of its own (a vertex on a cell's upper or right edge).
- Layout, draw grouping and index width stay C04 work (D6).

**Alternatives rejected on soundness.**

- Independent seam copies: the σ gaps.
- Overlapping skirts: double coverage.
- Snapped copies: `B` differs per cell, so the outputs still differ.

### E2. Builds only at epoch changes: CONFIRMED

**Problem.** The architecture says a transform-only change updates instance data without retessellation. Under K1, views bring in cells that do not exist yet.

**Proposal.**

- **What gets drawn.** An epoch draws exactly one level's complete materialized set: candidate cells holding a region piece, plus fringe cells (P3).
- **Inside an epoch.** Panning within the origin window, zooming within the epoch interval and any paint change build nothing. They upload only the frame uniform.
- **At an epoch change.** It builds only cells absent from the cache, and uploads `B` for live carriers.
  - The changes that start an epoch are: a rebase, a level change, DPR, a resize, an object-affine edit and a geometry edit.
  - An object-affine edit changes `P̂`, and its linear part can change `L`. That makes it an incremental build, not a retessellation.
- **What a build is.** It clips the existing tessellated mesh against a cell, then triangulates and records the result. It never re-tessellates the path.
- **Cache.** It has two parts.
  - **Cell geometry** (clipped pieces and records) is keyed by `(mesh identity and revision, L, i, j)`. It depends on that cell alone: the points on its sides that come from the neighbours are the grid-line crossings of source edges, and the cell computes them itself.
  - **Fringe flags and lists** depend on neighbouring pieces within `ρ_L` and `λ_L`. They are keyed additionally by the binary64 linear part of `A0`, the values `n` is computed from, so an object rotation that keeps L rebuilds them and never reuses a reach that is too small.
  - Records are keyed per level by exact position, so their indices survive set changes.
  - Entries are reconstructible, evictable caches under C04 item 5.
  - Keeping recent levels replaces a hysteresis band.
- **Frame completeness.** A frame never mixes levels and never draws a partial set. A frame that starts an epoch builds on its critical path; T02 reports that cost.

This reads "transform-only" as "no build within an epoch; incremental cell builds at epoch changes, including object-affine edits". That is an architecture interpretation; the user confirmed it, and it is recorded in the architecture.

### E3. Q1 restated for the production carrier; features evaluated from shared records: CONFIRMED

**Problem.** O02's Q1 reference is the exact preimage of host-rounded f32 NDC vertices, so drawn = reference. On the production carrier the GPU computes positions. Only the certificate bound `Ē ≤ 1/16` px against `R` is known.

**Proposal.**

- **Coverage reference.** The exact reference tiling `R`, under D3(a). Q4's thresholds are kept, and O03 re-runs the G1-G3 evidence against `R`. This is the D2 basis question, for K1 only, with the displacement bounded by S2.
- **Feature records.**
  - Features are the reference tiling's boundary pieces: edges used by exactly one region triangle, with the region on the left.
  - EDGE: a pair of record indices.
  - VERTEX: a record index, plus per sector the neighbour record indices giving `r_out` and `r_in`.
  - Reflex bits are exact in local space and flipped by `sign(det A0)`.
- **Evaluation.** The fragment shader evaluates features through the same carrier function as the vertex shader. Evaluated features and drawn vertices are each within Ē of `R`. They therefore agree within 2Ē, whether or not the two shader stages round alike.
- **C2.** It covers fringe triangles as well (S3).
- **Expected O03 deviation.** In the band `d* < 1`, `obs − rule` may deviate by up to about √2·Ē ≈ 0.088 in coverage, about 22/255. This differs from O02's same-geometry expectation. It is pre-stated for O03. G1 and G2 are unaffected.

## Primary decisions

**P1. Guard γ = 4 px (Q10).** The [coverage argument](#coverage-argument) needs at most 1.2283 px around `V`: the G3-class sample reach `0.708 + 0.3953`, plus Ē of drawn motion, plus Ē of fringe-boundary motion. T01 found γ 4 and γ 64 identical.

**P2. No hysteresis state.** `L` is a pure function of `‖A‖∞ · zq`. E2's level cache replaces the hysteresis band. The tile side stays in `(128, 256]` by `‖A‖∞`, the band T01's K1 at 256 used.

**P3. Exterior fringe per cell.**

- **Fringe cell.** A candidate cell whose closed square, expanded by `ρ_L` on every side, meets a boundary piece of the candidate set's tiling (exact segment-against-box test).
- **Partition.** Each fringe cell is partitioned exactly into its region pieces and exterior triangles by a new `fringeFaces`, built as follows:
  - Union the cell's per-source convex rings into half-edges, cancelling interior shared edges.
  - Subdivide at every record point on the cell's sides. These are the cell's own grid-line crossings and corners, and they include every point a neighbour places on the shared side.
  - Add the uncovered side segments.
  - Trace faces, with O02's sector pairing at pinches.
  - Nest holes by exact point-in-polygon.
  - Bridge holes and ear-clip, using O02's rules: minimum-distance visible bridge, the closed point-in-triangle test with own-corner exemption, collinear vertices allowed, strictly positive ear area. Exterior triangles take the region's winding.
- **New records.** Cell corners outside the closed region are the only new records, as kind 4 (below). Fringe triangles with empty lists are kept, which keeps the partition structural.
- **Non-fringe cells.** A non-fringe candidate cell with a region piece is fully region. A non-fringe cell without one is not drawn: by P1's reach, it holds no G3-class sample of any epoch frame.

**P4. Lists.**

- A drawn triangle's list holds every feature whose exact local ∞-norm distance to the closed reference triangle is at most `λ_L`.
- `λ_L` uses the cap `1/16` for Ē and the band floor `s_L`. Lists are therefore independent of camera, epoch and Ē. They are cached with the fringe flags (E2).
- Physical distance grows linearly with scale, so `λ_L` covers at least 1.625 px at every scale of the level.
- The global feature order and the tie rule are O02's, keyed by record position order.

**P5. Record order.** Records are ordered as follows:

1. original vertices by index;
2. kind 1, edge × x-line;
3. kind 2, edge × y-line;
4. kind 3, x-line × y-line corners strictly inside a source triangle;
5. kind 4, fringe cell corners outside the closed region.

Within kinds 1-3, records follow T01's keys, with `lowestEdge` taken globally over all source triangles. Kind 4 is ordered by `(x, y)`. This order is canonical for the T02 report only. It is not a layout.

## Mechanism (normative for T02 and O03)

1. **Inputs.** The C2-admitted region mesh in local binary64, the frame and affine lanes, and the epoch κ.
2. **Cells.** Candidate cells from `P̂`. More than 4096 candidates gives `TILE_CAP_EXCEEDED`, which routes to U4. This is reachable inside the domain at large W and H (about 17k cells at 16384²); it is a stated limit.
3. **Clipping.** T01's `exactClip` and convex ear rule, unchanged, per candidate cell.
4. **Fringe.** P3. `fringeFaces` lives in `extent-t02`. It copies the needed O02 routines (`mergeHoles`, `traceWalks`, `twiceArea`, `pointInLoop` and `earClip`), because the pinned `exterior.ts` exports only some of them and stays unchanged. It scales each cell's rational points to integers by the LCM of their denominators.
5. **Records and carriers.** E1, ordered per P5.
6. **Features and lists.** E3 and P4.
7. **Draw.** Every region and fringe triangle of the materialized set. Each primitive carries its role and its list.

**Merged mesh type** (the shared interface for every module):

```ts
type MergedMesh = {
  L: number;
  cells: { i: bigint; j: bigint; m: Q2; region: boolean; fringe: boolean }[]; // candidate order (j, then i)
  records: { pos: Q2; v64: [number, number]; owner: [bigint, bigint]; kind: 0 | 1 | 2 | 3 | 4 }[]; // P5 order
  carriers: { owner: [bigint, bigint]; m: [number, number] }[]; // owner order (j, then i)
  triangles: { ids: [number, number, number]; role: 'region' | 'exterior'; cell: number }[];
  boundary: { edges: [number, number][]; vertices: { id: number; sectors: [number, number][] }[] };
  lists: { offset: number; count: number }[]; // per triangle, into a flat feature array
};
```

## Successor certificate (U1 domain, per epoch)

Every check is exact and uses `Γ8`. "Drawn" means every triangle of the materialized set. "Records" means every record that a drawn triangle references. Features are boundary pieces of drawn region triangles, so their records are records too.

**S1. Domain.**

- T01's domain outcomes, on the original inputs.
- `lanesOk` on every carrier's lanes.
- Guard 4 on every `v64`.
- The epoch window lane `fmax = 2g · (1 + 2^-23) ≤ 2^20`.
- A failure gives `NOT_ADMITTED:lane-range:<locus>` or `OUT_OF_DOMAIN`.

**S2. Epoch position.** For every record, the epoch bound `E_ep ≤ 1/16` must hold, compared as `E_ep_x² + E_ep_y² ≤ 1/256`. The bound is evaluated on the record's owner carrier, per axis:

`E_ep = max_corners (s_hi·|ΔPack(c)| + s_hi·(2^-23 + 2^-48)·|carrierDoc(c)|) + ((2^-24 + 2^-52)·2g + 2^-149)·s_hi + Γ8·(s_hi·absDoc_fmax + size/2) + Phi`

Its terms:

- For a camera corner `c ∈ {O ± 2g}`, call `axisTermsCore` with frame lane `O − c` (exact) and camera `c`.
  - `carrierDoc(c)` is its carrier divided by `zq`, and the reference is divided by `s0`.
  - `ΔPack(c) = carrierDoc(c) − referenceDoc(c)`. The `−c` terms cancel, so it does not depend on `c`.
- `absDoc_fmax` is `axisTermsCore`'s `absSum / zq`, with frame lane `fmax = 2g·(1 + 2^-23)`, as in `certifyWindow`.
- `size` is W or H.
- `F_LANE_REL` and `F_LANE_ABS` are redefined in `extent-t02`, because the pinned `certificate.ts` does not export them.

Why this is a bound:

- M01's Pack at any epoch camera and scale equals `|s0·ΔPack(c) + (zq − s0)·carrierDoc(c)|`.
- That expression is affine in `c` apart from the frame-lane rounding, which `laneRounding` covers as in M01's `E_win`.
- `|zq − s0| ≤ (2^-23 + 2^-48)·s0`.
- Every other term is nondecreasing in scale.
- So `E_ep` bounds `E` at every frame of the epoch. With `s_hi` replaced by `s0` and the zq slack dropped, it reduces to M01's `E_win` exactly when `zq = s0`. A host identity test checks equality against pinned `certifyWindow` on a single bbox-midpoint carrier, for rows whose zoom and DPR are exact in f32 (S, EXT). On other rows it checks `E_ep ≥ E_win`.

`Ē = sqrtUp(max over records of E_ep²)`.

**S3. Clearance.** M04/R0a C2 holds at `δ = Ē`, on the whole drawn merged mesh, at reference scale `s_lo`.

- It is invoked as `c2Q(points, indices, A0 exact, zoom = s_lo, dpr = 1, Ē²)`, with the exact binary64 `A0`.
- **Why `s_lo` suffices.** Every C2 margin has the form `f(s) = X·s² − Y·s − Z` with `X, Y, Z ≥ 0`:
  - vertex and edge: `σ_lo² ∝ s²`;
  - triangle and fan: `|det S| ∝ s²`, `σ̄max ∝ s`, with Plo local;
  - wedge: the cross and `W_lo` terms are `∝ s²`, and `La`, `Lb` are `∝ s`.

  If `f(s_lo) > 0`, then `s_lo·X > Y`, so `f′(s) = 2sX − Y > 0` for every `s ≥ s_lo`.
- The region boundary is interior to the merged mesh. Fold-over there is excluded by the triangle terms of the region and fringe triangles, as R0a argues for interior fans.
- Clearance across tiles is part of this one check.
- The wedge term applies at the merged mesh's boundary, failing closed as in T01.
- **Exact pruning.** A vertex pair or edge pair whose local ∞-norm bounding boxes are more than `2Ē / σ_lo(s_lo)` apart, with `σ_lo` as in C2, cannot violate the vertex or edge term, and may be skipped. This holds because Euclidean distance is at least ∞-distance. Triangle and wedge terms are per-triangle and per-wedge, and are never pruned. Pruned and brute-force runs must agree in host tests.

**S4. Partition.** O02's exact partition check, on the drawn merged mesh:

- consistent non-zero orientation;
- every edge used twice in opposite directions, except the edges on drawn-cell sides whose neighbour cell is not drawn, which are used once;
- no T-junction;
- total area equal to (number of drawn cells) · `2^(2L)`;
- no two records with equal exact positions.

A failure gives `NOT_ADMITTED:partition:<check>`.

**S5. Lists.** For every drawn triangle and every unlisted boundary piece of a drawn region triangle, the exact physical distance at scale `s_L` must exceed `13/8` px.

- It is checked squared, with `A0` exact.
- Pruning by local ∞-norm boxes uses the bound `(13/8)·n / s_L`.
- Features outside the candidate set lie more than γ = 4 > 1.1047 px from every center in `V`, so they cannot matter.
- A failure gives `NOT_ADMITTED:lists:t<index>`.

**Order and outcome.**

- S1, then S2 and S3 (both evaluated even when one fails), then S4, then S5.
- The outcome is `ADMITTED` or the first failure, in T01's vocabulary plus `partition:<check>` and `lists:t<index>`.
- There is no submesh argument: every drawn record is certified, and every drawn vertex lies within one cell of `P̂`.
- At runtime a failure follows U4, `render.submission-failed`, as a last resort.

## Coverage argument

This argument holds per epoch frame, for a sample of a pixel whose center is in `V`. Distances are physical px.

**Proximity.**

- A fragment center lies within 0.3953 px of a covered sample of a drawn triangle.
- The drawn triangle lies within Ē of its reference triangle, because motion is affine.
- Every feature and record that matters to a pixel in `V` lies within `1.625 + 0.3953 + Ē < γ` of `V`. Its piece therefore lies in a candidate cell of `P̂` (by the D̂ construction), and that cell holds a region piece, so it is drawn and certified.
- A G3-class sample within 1.2283 px of the boundary has that boundary point within its own cell's `ρ_L`-dilation. It is therefore in a fringe cell or a region cell.

**Listed nearest.**

- An unlisted reference feature is more than `1.625 − 0.3953 − Ē` from the center (S5).
- Its evaluated copy is therefore more than `1.625 − 0.3953 − 2Ē ≥ 1.1047` away.
- So if `d* < 1.0`, the listed nearest is the true nearest evaluated feature.

**Saturation and role side.**

- If `d* ≥ 1.0`, `c` is saturated, because `w/2 ≤ 0.7072`.
- The drawn boundary is at least `1 − 2Ē ≥ 0.875` from the center.
- The path to the covered sample stays more than 0.4797 px from that boundary, so the role side is correct.

**Simplicity.** S3 runs over every record, so the evaluated boundary is a δ = Ē realization of `R`. It is simple, and its VERTEX sector tests are meaningful with respect to the evaluated polyline.

**What is not covered.** f32 feature evaluation and rasterizer snapping use the remaining margins. Both stay stated limits, observed by O03.

**Partition.** Shared records with `@invariant` make the drawn mesh conforming, and S3 keeps it non-inverted. Shared-edge rules then give at most one covering primitive per sample. That is an API assumption, which G3 verifies.

**Clipping.** `D̂` is sized at `s_lo` and anchored at the top-left. At `s0` near `2·s_lo`, a drawn vertex can therefore lie up to about `8 + 512 + 256 + max(W, H)` px outside `V`. Per axis, `|NDC| ≤ 3 + 1552 / min(W, H)`. That stays below O02's 2^10 bound for `min(W, H) ≥ 2`. A 1-px viewport is a stated limit.

## Pre-stated hazard: grid slivers at thin tips

K1 can turn a thin tip that is admissible unclipped into a sliver piece. This happens when a grid line cuts near the tip.

Take S `TRI` at zoom 1, DPR 1, with the camera on the far vertex 1:

- The tip lies on the grid line `x = D`.
- The last piece is about 256 px long and `64 · 256 / 2^k` px high.
- At k = 20 it is marginal against `2Ē·√2`. At k ≥ 21 C2 is expected to fail.
- R15 has the same tip on local `x = D`, with `2^L = 128`, so it is expected to fail as well.

**Exempt set**, fixed now:

- The ids are `S/TRI/k{20,24,32,40}/z1/d1/{I,R15}/cam:v1`.
- Exempt failures are C2 terms (vertex, edge, triangle, wedge) whose locus lies in a cell incident to record `v1`. For a pair term (vertex, edge), both elements of the pair must lie in such cells.
- `sliver` is set exactly when this predicate holds.
- Any other failure of these ids, and any failure of any other id, is not exempt.

T02 reports the exempt cases; it does not gate them. Each is listed with its piece and term. If any such variant fails, the plan records a user decision on the class A product boundary after T02. No mitigation is designed now.

## T02 offline exact evidence

**Corpus.**

- **C, L, O and S.** T01's corpora, at each row's own camera, with the epoch derived with no previous state. O at DPR 3 is observed only.
- **Class A.** Exactly the three T01 rows: `rectangle/4096x4096/R45/stress`, `rectangle/4096x4096/scale/stress` and `EXT-65536`.
- **Camera variants.** These come from the class A rows and from S at zoom 1 and DPR 1, both shapes, both linear parts, with `k ∈ {16, 20, 24, 32, 40}`.
  - Ids, in order:
    - `<row>/cam:v<index>`, one per referenced vertex, in index order;
    - `/cam:e<index>`, one per boundary-edge midpoint, in boundary order;
    - `/cam:g`, S only: the point of edge 0-1 at `x = i·2^L`, for the smallest integer `i` with `i·2^L > x_0`. `L` is the variant's own level, from its zoom and DPR.
  - The camera is `RN64(A0·p + e0 − (W/2, H/2) / s0)`, with `p` exact.
  - The origin is `originPXTarget(camera, zoom, dpr, 128)` with no previous state.
  - A camera above `2^60` gives `OUT_OF_DOMAIN`.
- **Trajectories.** R3's trajectories, on T01's trajectory rows and on one start camera per class A row (`cam:v1`).
  - Each trajectory's cameras are translated by `(start − frame 0 camera)`.
  - The trajectory's zoom, DPR, W and H replace the row's.
  - Epochs follow from the carried origin state.
  - At very small zooms, class A rows are expected to reach `capFrames`.
- **Epoch guards.** A frame also needs M01 guard checks 2 and 3 on its zoom and DPR lanes. The epoch interval is clipped to them.

**Row keys, in order:**

`corpus, id, variantOf, dpr, outcome, counts {candidates, drawnCells, fringeCells, records, carriers, regionTriangles, fringeTriangles}, L, epoch {zqLo, zqHi, g}, Ebar, c2Failures {vertex, edge, triangle, wedge}, partition, lists {max, p99, total}, reach {rhoL, lambda}, inversions, sliver, evaluated {position, c2, partition, lists}, flags`

- Exact values are rational strings, as in T01.
- `inversions` is T01's `simulateLanes` count at the row camera. Each record is simulated on its owner carrier, and the reference orientation comes from the exact `R`.
- `sliver` holds `{piece, term}` for a pre-stated hazard failure, and is null otherwise.
- `Ebar`, `lists` and `reach` are null for `OUT_OF_DOMAIN`, `TILE_CAP_EXCEEDED`, `NOT_ADMITTED:lane-range` (S1 stops before S2) and `NO_IN_WINDOW_TRIANGLES`.
- A row with no drawn triangle is `NO_IN_WINDOW_TRIANGLES`.
- Every row is Γ8; Γ9 is not run.

**Ordering.** Corpus C, L, O, S, then A (class A rows followed by their camera variants), each in its own order (O by row, then DPR).

**Summary.**

- `admission` per corpus and DPR group: admitted, not admitted by term, out of domain, no drawn triangles, tile cap.
- `classA`, listing each row and variant.
- `gate3`: losses against T01.

**Trajectory keys:**

`row, trajectory, frames, epochs, rebases, levelChanges, builds {total, maxPerEpochStart}, cellsPerEpochStart {max, mean}, liveCarriers {max}, anchorUploads, capFrames, coverageViolations`

- `anchorUploads` sums live carriers at each epoch start.
- Cell sets on trajectories never clip, so the cost stays bounded. A cell counts if it meets `P̂` and either:
  - some region triangle's bounding box meets the cell; or
  - the cell meets the `ρ_L`-dilated bounding box of some boundary edge.

  `builds`, `cellsPerEpochStart` and `anchorUploads` are therefore upper bounds.

**Gates.** All are fixed before results. T02 passes when every one holds.

1. **Partition.** No row that passes S1-S3 fails S4. That is, `partition:*` never occurs.
2. **Class A.** The three class A rows are `ADMITTED` at their own cameras. Every camera variant is `ADMITTED`, except for failures that meet the exempt-set predicate.
3. **No regression on O.** On O acceptance (DPR 1, 1.5 and 2), every row that T01 K1@256 admitted at γ = 4 under G8 is `ADMITTED`.
   - The comparison source is the archived T01 report: `docs/evidence/p3.1p-t01/report.json`, SHA-256 `5e49c8807a57984bb84f6ce4d72b53fe96893e71fc2a6d274088c46277d47a26`.
   - The compared rows are those with candidate `K1`, sweep `{gamma: 4, tTile: 256}` and `gammaModel` `G8`.
   - The join key is `(corpus, id, dpr)`.
   - **Pre-stated risk.** S3 runs at the epoch's `s_lo`, which can be up to 2× below the row's own scale. For example, an O row at DPR 1.5 has `zq = 1.5` and `s_lo ≈ 1`. Vertex and edge terms are then harsher than in T01, so O losses are possible.
   - Any other outcome counts as a loss, including lane-range and out-of-domain.
   - Losses on C and L are listed with their cause and are not gated.
4. **Frame coverage.** On every trajectory frame:
   - the frame's camera, `zq`, W and H lie within its epoch;
   - the exact local preimage of the frame's `V_γ` lies inside the union of the epoch's candidate cells;
   - exactly one level is drawn;
   - the G3-class band (1.2283 px around the reference boundary, inside the frame's `V_γ`) lies in drawn cells, checked by conservative box tests.

   `coverageViolations` must be 0.

A gate failure stops for a user decision. No threshold is tuned after results.

**Report and replay.**

- `P3_T02_WRITE=1 pnpm exec vitest run --config vitest.p3-t02.config.ts` writes `artifacts/p3.1p-t02/report.json`.
  - Its top-level keys are `contract {commit, sha256}`, `sources`, `rows`, `summary` and `trajectories`.
  - It is sharded per corpus, with a 3-hour budget.
- Replay is byte-identical and manual, as in T01.
- The archive goes under `docs/evidence/p3.1p-t02/`, with a review record.
- T02 code lives in new `tests/geometry/extent-t02/`. The `extent-t01` modules and every pinned P3.1m, R0a, R3 and T01 file stay byte-unchanged, and their SHA-256s are asserted.

**Host tests** (`pnpm test:geometry`, each under 60 s):

- the `E_ep`-to-`E_win` identity;
- `fringeFaces` against brute-force area decomposition, on cases for: a boundary touching a side at a point, a pinch on a side, an island hole, collinear seam points, a boundary along a grid line, and a corner outside the region;
- S4 on the same cases plus seeded random meshes;
- equivalence of pruned and brute-force S3 and S5;
- `n ≥ ‖A0⁻¹‖₂→∞` on shear and non-uniform affines;
- record identity and order;
- cell-geometry independence: building a cell's pieces and records alone equals its part of a merged build. Fringe flags and lists are excluded;
- the epoch interval, against brute-force `g` and `L`.

## O03 GPU evidence (separate contract)

O03 gets its own contract after T02. It renders the T02-admitted rows and camera variants with E1 records and carriers and E3 fragment features in WGSL:

- headed Chrome and Edge;
- DPR 1, 1.5 and 2;
- 1x and 4x.

It gates G1-G3 at O02 thresholds against `R`, adds G3 along tile seams, and observes `obs − rule` against the √2·Ē band. Its rule oracle reuses O02's oracle on the reference tiling. Fragment cost is observed: a VERTEX feature reads up to 7 records per fragment.

## Limits

- Implementation-defined clipping, snapping and f32 fragment evaluation: observed by O03 only.
- Viewports with `min(W, H) = 1`, and the tile cap at large viewports.
- Thin-tip slivers (pre-stated above).
- Runtime evaluation of S1-S5: a runtime certificate path is C04 work.
- Byte layout, draw grouping, cache budgets and eviction (D6).
- Stroke.

## Ownership, validation and order

| Owner      | Scope |
| ---------- | ----- |
| Primary    | This contract; `certifyEpochCore` (S2) with its identity test; S3 and S5 with pruning; the camera variants and trajectories; the report and replay; the plan |
| Sol medium | `MergedMesh` construction: cells, records, carriers (E1, P5); `fringeFaces` and S4 (P3); the trajectory cell sets; host tests for these |
| Astra high | Contract review; stable-source review; independent evidence review, recomputing `Ē`, fringe sets and gate 3 on a sample |

**Module order.** `MergedMesh` and `certifyEpochCore` start in parallel, then `fringeFaces` and S4, then S3 and S5, then the report.

**Validation.** `pnpm check`, `pnpm test:geometry`, `pnpm build`, the T02 report and replay, and the Markdown and link checks. T02 has no GPU run.

**Order.** `D1 decided -> this draft -> independent review -> user confirms E1-E3 (done) -> FROZEN (this note) -> T02 implementation -> T02 evidence and review -> O03 contract -> O03 evidence -> C04 layout`.
