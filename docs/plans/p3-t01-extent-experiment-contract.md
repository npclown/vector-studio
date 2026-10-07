# P3.1p T01 offline extent experiment contract

Status: FROZEN, 2026-10-07, at revision 3 plus confirmation fixes. Implementation is authorized after integration.

Independent review history:

- Astra high technical review: NOT READY twice, then READY with one required line, which is applied.
- Sol medium implementability review: NOT IMPLEMENTABLE twice, then IMPLEMENTABLE on revision 3. Its SHOULD-FIX items are folded into "Implementation details" below.

**Authorization.** On 2026-10-07 the user chose to start T01 (chat decision, recommended option), after the [R2 readiness note](p3-r2-tiling-readiness.md) was integrated. That note owns D1-D7, the [private contract](p3-private-contract.md) owns C04, and the [active plan](p3-fill-stroke-meshes.md) owns status.

**What it is not.** This is a test-only, offline, exact comparison. It adopts no mechanism, tile size, guard width, threshold or layout. Its use of D3(a) and of the D2 reference decides neither D3 nor D2. D1 stays a user decision after T01. Stroke stays deferred.

**Contract identity.** The integrating `main` commit, plus this note's SHA-256 at that commit.

## Question

The comparison is made inside the U1 window, under the production carrier's error model, against the untiled baseline K4.

| ID  | Candidate                                                        |
| --- | ---------------------------------------------------------------- |
| K1  | Local fixed-grid tiling, with D3(a) exact Steiner references     |
| K2c | Feature-decoupled boundary with coarse K1                        |
| K5  | f32-pair transform, as an assumed reference row and not ranked  |

Each is compared on:

- admission;
- the largest far magnitude admitted;
- inversions;
- seam split;
- cost.

K6 is excluded: it needs K2 and cannot be separated in T01.

## Terms

**U1 window.** `V` is the viewport `[0, W] × [0, H]`, in physical px. The U1 window is `V` expanded by a guard `γ ∈ {4, 64}` px, a declared sweep; Q10 stays open. "Window" below always means the U1 window. R3's camera window is called the origin window, and it is used only where stated.

**Origin.** Every row is re-originated to `originPXTarget(camera, zoom, dpr, 128)`, computed with no previous state. This replaces fixture, O-P1 and literal origins. On trajectories the state carries from frame to frame, through the `previous` argument, as in `rebaseCounts`.

**In-window triangle.** A drawn triangle whose exact reference triangle (closed) meets the closed window.

**Admission vertices.** Every vertex of every in-window triangle, including any vertex that lies outside the window.

**δ̄.** `δ̄ = sqrtUp(max over admission vertices of (E_x² + E_y²))`, pointwise, at the row camera. The R3 origin-window variant (`E_win` with `halfWidth = 2g`) is reported only.

**Submesh argument.** C2 runs on the in-window submesh only. Every drawn triangle `t` that is not in-window must satisfy

`dist(ref(t), V) > max_{v∈t} sqrtUp(E_x(v)² + E_y(v)²) + 1.5 + ε`

where `ε = 0` for K4, K1 and K5. Motion is affine along each triangle, so no point moves further than its triangles' largest vertex E.

- For K1 and K2c, only materialized tiles are drawn.
- The distance is compared exactly, in squared form, against the closed rectangle V.
- `submesh.firstViolation` records the first violating triangle.
- A violation gives `NOT_ADMITTED:submesh:t<index>`, checked after C2 in first-failure order.

**Orientation.** y-down physical px, with `cross(a, b) = a.x·b.y − a.y·b.x`.

## Corpus

**C: C2 fixture corpus.** 158 rows (`loadFixtureRows()`), including the two class A stress rows.

**L: P3.1m literal rows.** `prospectiveRows()` and `termRows()`, including EXT-65536.

**O: O02 corpus.** All 149 rows at DPR 1, 1.5, 2 and 3, from `o02Variants()`.

- DPR 3 is run and recorded but excluded from the admission counts.
- The 6 O02 `EMPTY_CROP` rows are listed separately.
- `INPUT_UNSUPPORTED` rows are recorded as `OUT_OF_DOMAIN`.

**S: synthetic class A family.**

| Parameter         | Values                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Size              | W × H = 1280 × 720                                                                                                                             |
| Camera            | (0, 0)                                                                                                                                         |
| Zoom              | `zoom ∈ {2^-6, 1, 2^6}`                                                                                                                        |
| DPR               | `dpr ∈ {1, 2}`                                                                                                                                 |
| Scale             | `z·q = zoom·dpr`, an exact power of two                                                                                                        |
| Affine            | Linear part `I = [1, 0, 0, 1]`, or `R15` from the fixture constants in corpus.ts. Translation `e = 640/(z·q)`, `f = 360/(z·q)`, so local (0, 0) maps to the viewport center (640, 360) |
| Units             | `D = 2^k/(z·q)` and `s = 64/(z·q)`, both exact powers of two in document units                                                                 |
| `k`               | `{10, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 28, 32, 40}`; a variant whose original inputs exceed 2^60 is skipped and listed                |

Shapes:

- `R15` binary64 literals are copied into `synthetic.ts`, because `corpus.ts` is hash-pinned and does not export them. A test asserts hex equality with the `affine` of the `termRows()` PACK-R15 row.
- `TRI`: vertices `(−s, 0)`, `(D, 0)`, `(−s, s)`, with indices `[0, 1, 2]`.
- `RECT`: vertices `(−s, 0)`, `(D, 0)`, `(D, D/4)`, `(−s, D/4)`, with triangles `[0, 1, 2]` and `[0, 2, 3]` (diagonal 0-2).

In both shapes the edge from 0 to 1 crosses the viewport center. The far vertex 1 lies `2^k` px from it under `I`, and `|R15·(D, 0)|·z·q` px under R15.

**Domain outcomes.** These checks follow `certificate.ts` (`laneRangeOk`, the `A` check, `singular`).

| Check                                                                 | Applies to                    | Outcome                       |
| --------------------------------------------------------------------- | ----------------------------- | ----------------------------- |
| zoom/DPR scale in [2^-20, 2^10]; integer size 1..16384; every original binary64 input at most 2^60 in magnitude; `INPUT_UNSUPPORTED` | Original inputs | `OUT_OF_DOMAIN` |
| Lane magnitudes at most 2^20; `A ≤ 2^1000`                            | The candidate's own lanes      | `NOT_ADMITTED:lane-range` (counts as not admitted) |
| Affine determinant 0                                                  | Original inputs               | `NOT_ADMITTED:singular`       |

Consequences:

- K4 at large `k` is therefore `NOT_ADMITTED:lane-range` (`|u| ≈ (D + s)/2` exceeds 2^20), as intended.
- The 256-vertex and 256-triangle `validInput` cap is not applied to tile meshes.

## Carrier and error model

All candidates except K5 use the production carrier from the [C04 position readiness note](p3-c04-position-readiness.md), on K's binary32 graph. Errors follow M01: `E = Pack + Shader + Phi`, with `Γ = Γ8`. Pack is evaluated exactly against the reference `R`. Pack64 and proof obligation P1 are not used. O02's host-NDC model is not used.

**Γ9 sensitivity.** Position only, run on the rows that Γ8 admits.

**Cores (Primary).** These are new files under `tests/geometry/extent-t01/` (`core.ts`).

- `certifyLanesCore(core: {points: Q2[], indices, affine, camera, zoom, dpr, width, height}, lanes: {m, u, B, linear, frame, z, q}, origin, gamma)` returns per-vertex `ex`/`ey` and M01's failure reasons.
- `clearanceAtDeltaQ(points, indices, affine, zoom, dpr, delta2)` and `c2Q(points, indices, affine, zoom, dpr, delta2)` are the clearance cores.

These files stay byte-unchanged: `certificate.ts`, `wedge.ts`, `r3-window.ts`, `corpus.ts` and every archived report. The T01 tests assert their pinned SHA-256s. An identity test asserts that the cores exactly reproduce `certifyPosition`, `certifyC2`, `clearanceAtDelta` and `wedgeTerm` on C, L and O.

### K4 (baseline)

The untiled production carrier, with `m` set to the bbox midpoint as in M01. Admission requires both of the following:

- every admission vertex satisfies `E_x² + E_y² ≤ 1/256`;
- C2 holds on the in-window submesh at `δ = δ̄`.

### K1

**Level.** `L` is the largest integer with `2^L · ‖A‖∞ · z · q ≤ T_tile`, evaluated exactly.

- `‖A‖∞ = max(|a| + |c|, |b| + |d|)` from the f32 lanes.
- `z` and `q` are `q(fround(zoom))` and `q(fround(dpr))`, as in `originPXTarget`.
- The sweep is `T_tile ∈ {256, 1024}`.
- No hysteresis is modelled; D4 stays open.
- If no `L ≥ −1074` qualifies, the result is `NOT_ADMITTED:lane-range`.

**Cells.** Cells are local squares `[i·2^L, (i+1)·2^L) × [j·2^L, (j+1)·2^L)`.

- Only cells that meet the exact local preimage bounding box of the window are materialized.
- More than 4096 materialized cells gives `TILE_CAP_EXCEEDED`, which is not an admission.
- A tile exists if and only if its clip yields at least one positive-area piece. Cost metrics count tiles.

**Clipping.** `exactClip` applies Sutherland-Hodgman against `x ≥ x0`, `x ≤ x1`, `y ≥ y0` and `y ≤ y1`, in that order.

- It starts from the vertex that comes first in the source triangle's order.
- It preserves the source triangle's winding.
- It removes consecutive duplicates.
- Fewer than 3 vertices, or zero area, yields no piece.

**Ear rule.** Each convex piece is triangulated by repeatedly taking the ear at the lowest ring position whose triangle has strictly positive exact area, and whose removal leaves either a ring with area greater than 0 or a single triangle. Every vertex is kept, so no T-junction arises. Winding follows the source triangle.

**Identity and indexing.**

- Vertices are merged within a tile by exact rational equality. Copies in different tiles stay separate, each on its own carrier. Their seam identity key is the exact position.
- Original vertices keep their indices.
- Steiner points are indexed after them by kind:
  1. edge × x-line, ordered by x-line, then by edge `(a, b)`, both ascending;
  2. edge × y-line, ordered likewise;
  3. x-line × y-line corners strictly inside a triangle, ordered by `(x-line, y-line)`, ascending.
- A point on an edge that also lies on both lines counts as kind 1.

**Tile carrier.**

- `m` is the cell center, exact in binary64.
- A Steiner point `v` is stored as `v64 = RN64(v)`.
- `u = fround(fl64(v64 − m))`.
- `B = fround(fl64(a·m_x + c·m_y + e − O_x))`, following K's graph exactly; `B_y` is analogous.
- The reference is the exact rational `R(v)`, so Pack includes the `v → v64` step.
- Guard check 1 applies to the tile's lanes, and check 4 applies to `v64`.

**Admission.** Both of the following must hold:

- position on every admission vertex, using each vertex's own tile carrier;
- C2 per tile at `δ = δ̄`.

A C2 input exception is recorded as `NOT_ADMITTED:input:<code>`.

**Seams.** Seams are reported, not gated.

- For each seam vertex `v`, report `σ(v)`: the maximum, over pairs of tiles A and B containing `v`, of `sqrtUp((E_x^A + E_x^B)² + (E_y^A + E_y^B)²)`. Report its overall maximum and the seam-vertex count.
- Report reference seam conformance: both sides of every grid line carry the same exact vertex set.
- T01 makes no watertightness claim. Gaps and overlaps at seams are a stated limit, left for the R2 contract (D3, D4).

### K2c

**Drawn triangles.** The K1 tiling with `T_coarse ∈ {4096, 65536}` in place of `T_tile`. The sweep is γ × T_coarse; T_tile does not apply.

**Displacement.** `ε = sqrtUp(max over admission vertices of (E_x² + E_y²))`, which equals C2's δ̄.

**Admission.** C2 on the in-window drawn triangles at `δ = ε`. This is non-inversion for region triangles.

K2c has no 1/16-px position test by design (D2), so its admission is not like-for-like with K1. The report flags this.

**Features.** Features are taken from the exact projected original boundary, which is the D2 reference and test-only.

- **Storage-rounding bound.** `(2^-24 + 2^-50) · |value|` per word, relative to the crop origin (the crop is the window here). Evaluation error is excluded, as for O02's 0.104-px margin.
- **Reported.** The maximum bound over features within `1.5 + ε` of any in-window drawn triangle.
- **Feature count.** The number of features within `1.5 + ε` of each exact reference triangle.

### K5-ASSUMED

This row is never a certificate, for two reasons:

- WGSL §15.7's faithful ("either neighbour") rounding alone breaks the exactness of TwoSum and TwoProduct;
- flush-to-zero (FTZ), reassociation and fusion break it further.

Its formula is

`E5_x = Pack5 + Γ_p · (absSum + W/2) + 2^-23 · (|P*_x − W/2| + Pack5_x + Γ_p · (absSum + W/2)) + Phi`, and on the y axis the same form with `H/2` and `P*_y`

where:

- `u`, `a..d`, `z` and `q` are f32;
- `B` and `F` are f32 pairs, `hi = RN32(x)` and `lo = RN32(x − hi)`;
- `Pack5` is exact against `R`, using `B = hi + lo` and `F = hi + lo`. It includes the f32 `u` term, which grows with `|u|` and is reported separately;
- `P*` is the exact physical coordinate of the reference `R`;
- `Γ_p = (1 + 2^-44)^9 − 1`;
- `absSum` is M01's absolute monomial sum;
- Phi is assumed, not proved.

A round-to-nearest (RN) sensitivity case replaces `2^-23` with `2^-24`. Admission uses the same tests as K4, on the untiled mesh. γ affects only which triangles are in-window.

## Metrics

**Per row, candidate, sweep and Γ:**

- Outcome: `ADMITTED`, `NOT_ADMITTED:<term>:<locus>`, `OUT_OF_DOMAIN`, `NO_IN_WINDOW_TRIANGLES` or `TILE_CAP_EXCEEDED`.
  - `term ∈ {lane-range, singular, position, vertex, edge, triangle, wedge, input, submesh}`.
  - `locus` is `v<index>`, `t<index>` or `tile(<L>,<i>,<j>)`.
- Counts: tiles, in-window triangles, vertices.
- Maximum `E`, δ̄ or ε.
- Inversions: in-window triangles whose orientation differs from the reference. The orientation is evaluated exactly on the `recovered` viewport coordinates of a lane-explicit simulator, `simulateLanes(lanes, v64)`, which runs K's binary32 graph in JavaScript RN with each tile's own carrier. Not applicable to K5.
- Failing C2 term instances, counted per term.
- K1 Steiner deviation: the maximum Pack and maximum E over in-window Steiner points, with the vertex and tile.
- K1 seam split, as described above.
- K2c feature bound and count.
- The submesh-argument assertion.

**Per candidate:**

- Admission counts on C, L and O; DPR 3 is reported separately. Class A rows are listed individually.
- **M_max:** per zoom, DPR, linear part and shape, the largest `k` such that every tested `k' ≤ k` is `ADMITTED`. Censored values are reported as `≥ k_max`.

**Cost** (K1, K2c, and K4 as zero), on a fixed set of trajectory rows:

- Trajectory rows:
  - S `TRI` and `RECT` with `k ∈ {16, 20}`, linear `I`, zoom 1, DPR 1, at 1280 × 720;
  - the class A stress rows `rectangle/4096x4096/R45/stress` and `rectangle/4096x4096/scale/stress`, at their own size.
- Trajectories: R3 `trajectories()`, with each frame's camera, zoom and DPR replacing the row's own.
- Per trajectory:
  - frame-0 tiles;
  - builds: `(L, i, j)` cells that contain at least one region triangle and were not materialized in any earlier frame of the trajectory, as a total and as the maximum per frame;
  - per-frame in-window tile count, as maximum and mean;
  - anchor uploads at R3 rebase frames, summed as live tiles;
  - on TR-ZOOM, level changes and tiles rebuilt per level change.
- An unbounded tile cache is assumed.
- The cost computation uses cell sets only, with no certificate.

**Comparison rule** (fixed before any results). The report tabulates these metrics side by side, with K4 as the baseline and K5 as an unranked reference. No candidate is selected, and no threshold or sweep is changed after results. D1 is a user decision. If no candidate admits class A, that is reported as such.

**Evaluation order** per row and candidate:

1. Guards.
2. Position. E is computed for every admission vertex, and the outcome records the lowest failing vertex.
3. C2. It is evaluated and recorded even when position fails; only the outcome follows first-failure order. K2c skips step 2, and the record says so.

**Γ9 rows.** The Γ9 position rows follow the Γ8-admitted rows, in the same order key.

## Implementation details (frozen)

1. **`core.ts`.** It re-implements the pinned formulas verbatim, over rational points: the axis and Shader terms, the clearance summary and its segment helpers, the exterior wedges and the wedge term.
   - It imports only exported symbols: `q`, `sqrtUp`, `GAMMA8`, `GAMMA9`, `PHI`, the `exact.ts` helpers and `originPXTarget`.
   - The identity test is what makes this copy safe.
   - The expected pinned hashes live in a constants table in `extent-t01/sources.ts`.
2. **C2 cost bound.** When position fails, C2 runs only if the in-window submesh has at most 128 edges.
   - Otherwise `evaluated.c2` is false, and the row records `c2Skipped: "edges>128"`, counted in `summary.skipped`.
   - Shards are per corpus and per candidate. A failed shard is rerun whole.
3. **Submesh E.** E is evaluated for every vertex of every excluded drawn triangle, using the same lanes, Γ8 and the row origin.
   - If the carrier rejects a vertex with a lane-range failure, `submesh` is `{ok: null, firstViolation: null, reason: "lane-range"}`.
   - The outcome is then already `NOT_ADMITTED:lane-range`.
4. **C2 failure counts.** `c2Q` returns the slacks `{vertex, edge, triangle, wedge}`; a slack is null when its term is not evaluated.
   - `c2Failures.<term>` counts the tiles (K1, K2c) whose slack for that term is ≤ 0.
   - For meshes (K4, K5) it is 0 or 1.
5. **Row ids and DPR.** S row ids are `S/<shape>/k<k>/z<zoom n/d>/d<dpr n/d>/<I|R15>`, for example `S/TRI/k20/z1/d2/R15`.
   - The `dpr` key is the row's physical DPR as a rational string, in every corpus.
6. **Nulls and units.**
   - `maxE`, `delta` and `deltaWindow` are null when no admission vertex was evaluated.
   - `counts` is always present, and is zero when nothing was evaluated.
   - `inversions`, `c2Failures` and `submesh` are null for `OUT_OF_DOMAIN`.
   - `maxE` is `sqrtUp(max(E_x² + E_y²))`.
   - `deltaWindow` is reported for K4 only, and is null for K1, K2c and K5.
7. **Summary arrays.** Each is sorted by the row ordering key.
   - `summary.admission` is an array of `{candidate, sweep, gammaModel, corpus, dprGroup, admitted, notAdmitted, outOfDomain, noInWindow, tileCap}`.
   - `summary.mMax` is an array of `{candidate, sweep, zoom, dpr, linear, shape, mMax}`. `mMax` is an integer k or `">=40"`.
   - `trajectories` is an array of `{row, trajectory, candidate, sweep, frame0Tiles, builds, tilesPerFrame, anchorUploads, zoomLevelChanges, rebuildsPerChange}`.
8. **Anchor uploads.** For each frame after frame 0 whose carried-state `originPXTarget(…, 128, previous)` differs from the previous frame's, add that frame's in-window tile count.
9. **Parallel start.** Sol may implement `clip.ts` and `tile.ts` in parallel with `core.ts`. `tile-certificate.ts` waits for `core.ts`.

## Limits

Offline exact evidence cannot certify any of the following:

- GPU clipping of vertices outside the clip volume;
- the `FRAME_DEFERRED` far-field bound;
- rasterizer snapping;
- f32 fragment evaluation;
- watertightness across tile seams;
- exterior and complement partition, which is excluded for every candidate.

Every `ADMITTED` is therefore a necessary-condition result conditional on these limits. K2c's full obligation (the readiness note's K2 risks) is not evaluated, and K2c establishes nothing about the O02 gates G1-G3; D2 would need O02-style evidence to be re-run.

## Records, ownership and validation

**Code** is test-only, under `tests/geometry/extent-t01/`.

**Report.** `P3_T01_WRITE=1 pnpm exec vitest run --config vitest.p3-t01.config.ts` writes `artifacts/p3.1p-t01/report.json`.

- Top-level keys, in order: `contract {commit, sha256}`, `sources`, `sweeps`, `rows`, `summary`, `trajectories`.
  - `sources`: `{path: sha256}` for every T01 file, plus the pinned P3.1m/R0a/R3 files.
  - `sweeps`: `{gamma: [4, 64], tTile: [256, 1024], tCoarse: [4096, 65536]}`.
- Exact values are rational strings `"n/d"` in lowest terms, with `/d` omitted when the denominator is 1. They are never JSON numbers. Counts are JSON integers. Binary64 inputs are 16-digit hex.
- **Row keys, in order:** `corpus, id, dpr, candidate, sweep, gammaModel, outcome, counts, maxE, delta, deltaWindow, inversions, c2Failures, steiner, seam, features, submesh, evaluated`.
  - `sweep`: `{gamma, tTile, tCoarse}`, with `null` for fields that do not apply. K4 and K5 have both tile fields `null`; K1 has `tCoarse` `null`; K2c has `tTile` `null`.
  - `gammaModel`: `"G8"` or `"G9"`.
  - `counts`: `{tiles, cells, triangles, vertices}`.
  - `inversions`: an integer, or `null` for K5.
  - `c2Failures`: `{vertex, edge, triangle, wedge}`.
  - `steiner`: `{maxPack, maxE, locus}` or `null`.
  - `seam`: `{count, maxSigma, conforming}` or `null`.
  - `features`: `{maxBound, maxCount}` or `null`.
  - `submesh`: `{ok, firstViolation}`.
  - `evaluated`: `{position, c2}`, booleans.
  - `deltaWindow`: the R3 `E_win` variant.
- **`summary` keys:** `admission` (per candidate, sweep, Γ and corpus, with DPR 3 separate), `classA` (rows listed individually), `mMax` (per candidate, sweep, zoom, DPR, linear and shape; censored values as `">=k_max"`), `skipped`.
- **`trajectories`:** per row, trajectory, candidate and sweep: `{frame0Tiles, builds: {total, maxPerFrame}, tilesPerFrame: {max, mean}, anchorUploads, zoomLevelChanges, rebuildsPerChange}`.
- **Ordering:** corpus C, L, O, S, each in its own order (O by row, then DPR); then candidate K4, K1, K2c, K5; then sweep by `(gamma, tTile, tCoarse)` ascending, with `null` last; then G8 before G9.
- No timing or platform fields.
- **Runtime.** `vitest.p3-t01.config.ts` is new and excluded from `pnpm test:geometry`. The report test has a 3-hour timeout and is sharded per corpus.

**Replay.** A replay test under the same config reproduces the report byte for byte. Replay is a manual validation, not part of CI. It compares per-row SHA-256 digests in order, so a mismatch names the first differing row. The report is archived under `docs/evidence/p3.1p-t01/` together with a review record.

**Host tests**, in `pnpm test:geometry`, each `it` bounded at 60 s:

- the exact clipper against brute force, including edges through grid corners and along grid lines;
- the clipped area sum and the absence of T-junctions;
- cross-tile seam conformance;
- core identity against the pinned modules, plus their pinned SHA-256s;
- `simulateLanes` equals `simulateMeshProjection` on a single binary64 tile whose bbox midpoint equals its cell center;
- the level invariant: for every tile, its side in px is at most `T_tile`, and doubling it exceeds `T_tile`;
- the S literals;
- the K5-ASSUMED formula.

**Ownership.** There is no recursive delegation.

| Owner      | Scope                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary    | This contract; `core.ts` and its identity test; `synthetic.ts` (S, trajectory rows); `k2c.ts`, `k5.ts`, `report.ts`; the plan                                                                                                                                                                                                              |
| Sol medium | `clip.ts`: `exactClip(triangle: Q2[3], cell): Q2[]` and convex ear clipping. `tile.ts`: `tileRow(input, T, window): {L, cells: {L, i, j, m, points: Q2[], indices}[]}`, plus vertex merging and indexing. `tile-certificate.ts`: tile-carrier lanes, position via `certifyLanesCore`, `simulateLanes`, inversions, seams, Steiner deviation. Host tests for these |
| Astra high | Contract review; stable-source review; independent evidence review, including an independent recomputation of the K1 cell sets and K2c ε                                                                                                                                                                                                                                  |

**Validation:**

- `pnpm check`, `pnpm test:geometry` and `pnpm build`;
- the report and its replay;
- Markdown and link checks.

There is no GPU run.

**Dependency order:** `R2 readiness integrated -> this contract FROZEN -> cores (Primary) -> Sol modules -> remaining Primary modules -> stable-source review -> report -> independent evidence review -> D1 user decision`.
