# D9 E3: B4 A04 corpus and measurement contract

Status: DRAFT, 2026-10-22. Written for independent review and user approval. Independent review round 1 was NOT READY and round 2 READY WITH FOLLOW-UPS; the findings of both are applied ([review record](#12-review-and-approval-record)). User approval is pending. Nothing here is in force until the user approves it in chat. This is rendering-track item E3 ([D9 rendering track](d9-rendering-track.md#status-index)), which is checkpoint B4 of [D8](p3-d8-parallel-tracks.md#two-tracks). It is full tier: it fixes how an acceptance criterion is evidenced and sets a pass rule. It is a contract only. It changes no requirement, threshold, acceptance criterion, past decision or frozen contract text, and it authorizes no code until it is approved.

**Evidence label.** Until the run under this contract has produced an accepted evidence record, every fill and stroke result keeps the label that precision is **UNVERIFIED** against the 0.25 physical-pixel target, as [D8](p3-d8-parallel-tracks.md#rules) requires.

**Identifiers.** IDs in this contract use the prefix **E3-**: definitions E3-K1 to E3-K6, corpus strata E3-C*, positive controls E3-PC1 to E3-PC14, seeded defects E3-D1 to E3-D14, units E3-U1 to E3-U5, acceptance E3-A1 to E3-A9, risks E3-R1 to E3-R9 and open questions E3-Q1 to E3-Q12.

## 1. Sources and the A04 criterion

### 1.1 The criterion, quoted

The [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b) owns A04:

> A04 | Combined geometric error <=0.25 physical pixel across declared transforms/zoom/DPR, with rejecting positive controls | TODO; measured on a frozen corpus against an independent oracle (D8)

[D8, A04 verification method](p3-d8-parallel-tracks.md#roadmap-changes-adopted-with-d8) owns the evidence method:

> The target is unchanged: combined geometric error of at most 0.25 physical pixel across the declared transforms, zoom and DPR.

It also says, under primary evidence:

> - The corpus covers the declared transforms, zoom 0.01/1/64 and DPR 1/2/3.
> - A sample that exceeds 0.25 px fails A04.

[D8 B4](p3-d8-parallel-tracks.md#two-tracks) adds that the oracle is drawn from `geometry-reference` (continuous error, fill region, triangle mesh), that the corpus is versioned and frozen before its run, and that B4 "measures the V2 export through the V3 pipeline". A certificate is optional, stronger evidence and is not required for every transform.

### 1.2 Where the 0.25 target is worded

The target does not appear in [`docs/requirements.md`](../requirements.md). That document states no geometric-precision number; its "Platform and performance" section is about frame rates and node counts. The target and its unit are worded by these documents, and this contract quotes them without change:

| Document                                                                                             | Wording                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`graphics-engine-architecture.md`, Anti-aliasing](../graphics-engine-architecture.md#anti-aliasing) | "Zoom-aware flattening tolerance targeting no more than 0.25 screen pixel of geometric error"                                                                                                        |
| The same document, its P2 flattening paragraph                                                       | "the geometric target is 0.25 **physical display pixel**, accounting for world linear transform, camera zoom and DPR using the largest singular value"                                               |
| [`prototype-plan.md`, P3 exit gate](../prototype-plan.md#p3-fill-and-stroke-meshes)                  | "Geometry error remains within the 0.25-screen-pixel target." Its path stress scenes list "Fractional transforms and rotations" and "Zoom range from 1% to 6400%"                                    |
| [P3 private contract, numeric compatibility](p3-private-contract.md#numeric-compatibility-decision)  | "Prospective allocation of the unchanged total <=0.25 physical-pixel geometric error", in three rows: curve 0.125, topology and arcs 0.0625, Float32 storage, shader transform and projection 0.0625 |
| [P1 private contract, precision](p1-private-contract.md#precision-and-rebase-contract)               | P1's position rule, "every tested visible point in the viewport plus two physical pixels", against an independent Float64 evaluation                                                                 |

The unit is therefore the **physical display pixel** (CSS pixel times DPR). "Screen pixel" in the older wording is read as the physical pixel, as the architecture's P2 paragraph and the P3 table already state. This reading changes no text.

The three private-contract rows are allocations inside the total. They are design obligations for the kernel and the renderer, not gates of A04. A04 measures the total once, after every stage (section 3).

### 1.3 Prior precision work this contract builds on

- **The parked P3.1p line.** The [T04 contract](p3-t04-sliver-mitigation-contract.md) is FROZEN and parked by D8. It was the next step of an exact precision-certificate line for the K1 tiled carrier: the [R2 tiling contract](p3-r2-tiling-contract.md) aimed to certify every transform exactly through an epoch-based successor certificate. T02 failed, and T03 was FAIL-AS-PREDICTED with a residual set R of 16 ids: 4 depth-positive star and zero-closure rows, 6 needle triangles `S/TRI/k{24,32,40}` and 6 near-diagonal rectangles `S/RECT/k{24,32,40}` ([T03 review](../evidence/p3.1p-t03/review-2026-10-08.md)). T04 was written to compare sliver mitigations offline and adopt nothing. D8 parked it because an exact certificate for every transform had become the critical path, and replaced it as A04's evidence by measurement on a frozen corpus. R stays a known open risk, not a waiver ([D8](p3-d8-parallel-tracks.md#two-tracks)). T04 also disclosed that one of its constants was chosen after a census. This contract keeps the corpus blind for that reason (section 5.5).
- **The stroke contract.** [Section 3](p3-b2-stroke-contract.md#3-precision) of the B2 stroke contract splits the stroke's share of the three rows and says: "A04 for strokes is evidenced by B4's measurement on a frozen corpus against the independent oracle (B2-Q7)." Its ST-A0 amendment (S1) fixes the stroke construction metric as the two-sided Hausdorff distance between closed regions plus no-crack. It records **hole closing** as "a stated residual, to be measured by B4's A04 metric (ST-OB3)". Oracles ST-O1 to ST-O3 ([section 11.1](p3-b2-stroke-contract.md#111-oracles)) check the kernel's emitted pieces against the ideal pieces and the mesh against the union of the emitted pieces. They make no precision claim.
- **The ST-U8 rows.** [ST-U8](p3-fill-stroke-meshes.md#b2-st-u8-stroke-playground) proposed stroke rows SB-1 to SB-13 for B4, each run at the nine zoom and DPR pairs. Section 5 adopts them.
- **V3.** [V3 section c](p3-v3-renderer-mesh-pipeline-contract.md#c-tolerance-and-fringe-buckets) chooses the tolerance bucket `e` with `2^e · sigmaMax(S) ≤ 0.125` by exact predicates. [Section f](p3-v3-renderer-mesh-pipeline-contract.md#f-the-mesh-packet-part-and-the-mesh-draw) fixes the K4 position carrier and the vertex stage `p = ((A·u + B) + (O_m − camera)) · zoom · DPR`. [Section e](p3-v3-renderer-mesh-pipeline-contract.md#e-a5-coverage-on-k4) maps EDGE and VERTEX features with the same offsets in the shader. Section e says that K4 "carries no position certificate".
- **Existing oracles** in `packages/geometry-reference` (`continuous-error.ts`, `fill-region.ts`, `triangle-mesh.ts`, `stroke-region.ts`, `tolerance.ts`) and in `tests/geometry` (`cubic-boundary/oracle.ts`, P3.1d exact cubic distance; `p3-b0-spike/oracle.ts` and `p3-fill-ladder/oracle.ts`, SL-O1 to SL-O3 and AL-M5). Each of them checks a kernel **intermediate** (a dumped polygon, piece set or leaf) against its ideal counterpart in local units. None measures the drawn result in physical pixels. `fill-region.ts` and `triangle-mesh.ts` also cap their inputs at 32 source vertices, 32 combined edges and 256 triangles, which is below the A04 corpus. Section 4 states what is reused and what is new.

## 2. Scope

**In scope.** Fill (nonzero and evenodd) and stroke (every cap, join and miter case of ST-S3 to ST-S12) meshes, produced by the release WASM through `createFillMeshPort` and `createStrokeMeshPort`. They are mapped to physical pixels by V3's bucket choice and K4 packing, and by the WGSL position mapping of the V3 mesh shader. The measurement covers the declared transforms, zoom 0.01, 1 and 64 and DPR 1, 2 and 3.

**Out of scope.**

- Coverage values, the A5 ramp's isoline offset, MSAA and color. These belong to A08 and the [V3 section k](p3-v3-renderer-mesh-pipeline-contract.md#k-a08-visual-contract) Q4 gates.
- Dashes, which do not exist in P3 (ST-S11).
- Performance. The run is timed only as a diagnostic, and no timing claim is made.
- A01 to A03 and A05 to A08. Section 6 states how A04 relates to A01 to A03.
- The K1 carrier and the parked P3.1p line.

A04 evidence produced under this contract is evidence for the carrier, operation identities and builder placement named in its record (section 7.4). A change of any of them requires a re-run (E3-R4).

## 3. The measured quantity

### 3.1 E3-K1: the case and its ideal region

A **case** is one paint of one path under one camera:

- the path: verbs and binary64 points in node-local units;
- the paint: a fill with its rule, or a stroke with width `w`, cap, join and miter limit;
- the node's world affine `W(x) = L·x + t`, binary64;
- the camera position `c`, zoom `z` and DPR `d`, binary64;
- the viewport, 640 × 360 CSS pixels as in P1's numeric fixtures;
- the served-bucket offset `k ∈ {0, 1, 2}` (section 3.5).

Every binary64 value is a dyadic rational, so the **ideal map** `Φ(x) = d · z · (L·x + t − c)` is exact over the rationals. It gives P1's physical-pixel frame (y down, the camera at the surface origin as P1 places it). The **ideal region** `R = Φ(R_loc)` is a closed set, where `R_loc` is defined as follows:

- **Fill.** `{x : rule(winding(P, x))}` for the path `P` with its implicit closing edges.
- **Stroke.** The union of sweeps, joins, caps and cusp disks of [stroke contract section 2.2](p3-b2-stroke-contract.md#22-the-stroke-region), under rows ST-S3 to ST-S12.

The ideal uses the scene's binary64 values exactly. That includes the binary64 value of `0.01`, which is not 1/100, and the binary64 entries of a rotation matrix, which need not be exactly orthogonal. The f32 rounding of `L`, `z` and `d` in the shader lanes is therefore part of the measured error, as the private contract's third row requires. A case with `det L = 0` is not drawable under V3 section c, and appears only as a control.

### 3.2 E3-K2: the drawn region

The **drawn region** `M` is defined in five steps:

1. The renderer chooses the bucket `e` for the case exactly as `renderer-core` does (V3 section c).
2. The request goes to the real port at the served exponent `e − k`.
3. If the result is `ok`, its triangles have vertices `v_i`, Float64 node-local.
4. Each `v_i` becomes the K4 offset `u_i = fround(v_i − m)`. The lanes `A`, `B`, `O_m − camera`, `zoom` and `DPR` are packed exactly as `renderer-core` packs them (V3 section f).
5. Each point is mapped to physical pixels by the WGSL function the V3 mesh shader uses for a stored point.

`M` is the union of the mapped closed **region** triangles of the port mesh, and `∂M` is its topological boundary. The fringe's exterior triangles are not part of `M`: they follow the region triangles in a variant's range ([V3 section f](p3-v3-renderer-mesh-pipeline-contract.md#f-the-mesh-packet-part-and-the-mesh-draw)) and carry coverage, not region. EDGE and VERTEX features use the same offsets as the vertices (V3 section f), so `∂M` is also the boundary that the A5 coverage rule places its 0.5 isoline on. Joint fill and stroke draws keep each paint's features unchanged ([V3 section e, ST-U7 amendment](p3-v3-renderer-mesh-pipeline-contract.md#e-a5-coverage-on-k4)), so a joint draw is measured per paint, with an identity check that its features equal the separate draws' features (E3-C9).

**Conformity is not assumed.** A stored port mesh need not be conforming. In the rounded line-fill construction each slab cell becomes two triangles, so a neighbour's node can lie inside a cell side: a T-junction. These T-junctions are on record in the [P3.1j conforming-mesh review](../evidence/p3.1j-conforming-mesh-oracle-review-2026-10-05.md). **What stays exact in `M*`.**

- **Constant-x edges.** For a T-vertex on a constant-x edge (a slab side), the exact mapped mesh `M*` (section 7.1) keeps it on the edge. All three points share one f32 offset `fround(x − m_x)`, and the exact map from f32 offsets to `p*` is affine.
- **Other edges.** For a T-vertex on any other edge, collinearity is not guaranteed even in `M*`, because each offset is rounded separately.
- **On the GPU.** The T-vertex and the edge's endpoints are mapped independently by the f32 lane products of `toPhysical` (`packages/renderer-webgpu/src/mesh-fill-shader.ts`). Under a non-diagonal linear map the three mapped points are no longer collinear, which can open a hairline crack up to about `2β` wide inside the region.

The oracle therefore:

- detects T-vertices exactly on the Float64 port mesh: a T-vertex is a mesh vertex in the relative interior of another triangle's edge;
- checks each T-vertex again in `M*`. A T-vertex that is off its edge in `M*` is reported as a storage crack and treated like a GPU crack under the approved E3-Q10 option;
- extracts `∂M` with every triangle edge split at every T-vertex on it, so that a T-junction is never mistaken for boundary in `M*`;
- records the T-junction count and the crack bound per case.

How a GPU crack is scored is open question [E3-Q10](#11-open-questions), which the contract does not decide. Until the user answers it, the bound of section 7.1 is stated only for conforming cases.

**`empty` results.** A result of `empty` gives `M = ∅`. It is measured, not excluded. It passes only when `R` has no boundary in `Ω` **and** one point of `Ω` classifies outside `R`. With no boundary of `R` in the connected set `Ω`, `R` is either disjoint from `Ω` or contains it, so one point decides. A missing mesh over a shape that covers the window is therefore a FAIL, not a pass (E3-PC14). The rejected results are listed in section 6.

### 3.3 E3-K3: the window

`Ω = [−2, 640·d + 2] × [−2, 360·d + 2]` in physical pixels: the viewport plus two physical pixels, P1's rule for visible points. Error is measured only inside `Ω`. Distances are taken to the unclipped `∂M` and `∂R`, so the window adds no boundary of its own. The window is an interpretation of "visible" that the user approves under [E3-Q12](#11-open-questions).

**`window-empty`.** A case is `window-empty` when neither `∂R` nor `∂M` meets `Ω`. Then `M` and `R` are each constant on the connected set `Ω`, so the oracle classifies one point of `Ω` (its center) against both.

- If the two classifications agree, the case is recorded as `window-empty` and counted, not measured.
- If they disagree, the case is measured and FAILS. For example, `R` covers the window and `M` does not.

### 3.4 E3-K4: the error

With `dist` the Euclidean distance in physical pixels, `sup ∅ = 0` and `dist(p, ∅) = +∞`:

- `B_R = sup { dist(p, ∂M) : p ∈ ∂R ∩ Ω }`: ideal boundary that the drawn boundary misses;
- `B_M = sup { dist(q, ∂R) : q ∈ ∂M ∩ Ω }`: drawn boundary that is not near the ideal boundary;
- `G = sup { dist(x, ∂R) : x ∈ (M △ R) ∩ Ω }`: wrong-side area;
- **`E(M, R) = max(B_R, B_M, G)`**, in physical pixels.

**Why these three terms.**

- `max(B_R, B_M)` is the two-sided Hausdorff distance between boundaries. It is the boundary displacement that the private contract's rows speak of. It catches a hole or gap that closes: the hole's ideal boundary has no drawn boundary near it. That is the ST-OB3 residual, which a region Hausdorff bound cannot see.
- `G` catches a wrong fill rule, a missing region and dropped interior triangles. A boundary distance alone cannot see a wrong rule, because the complement of a region has the same boundary.
- `G` does **not** see flipped or doubled triangles. The mesh pipeline draws with cull mode none (`packages/renderer-webgpu/src/mesh-pipeline.ts`), and `M` is a union of closed triangles, so a flipped or doubled triangle covers the same set. Overlap and orientation are mesh validity, which belongs to A01. Double blending of overlapping triangles is a coverage effect, which belongs to A08.
- When `E ≤ ε` inside `Ω`, two things hold there. First, `R ⊖ ε ⊆ M ⊆ R ⊕ ε` (erosion and dilation by a disk of radius ε), which is the stroke contract's region Hausdorff bound. Second, the boundaries are within ε of each other.

**Triangle inequality.** For any third region `Z`, `E(M, R) ≤ E(M, Z) + E(Z, R)`. The boundary terms are Hausdorff distances. For `x ∈ M △ R`, either `x ∈ Z △ R`, where `dist(x, ∂R) ≤ G(Z, R)`, or `x ∈ M △ Z`, where `dist(x, ∂R) ≤ dist(x, ∂Z) + d_H(∂Z, ∂R)`.

**Windowed form.** `E` is restricted to `Ω` (written `E_Ω`). The point of `∂Z` nearest a point in `Ω` may lie outside `Ω`, but within `E_Ω(M, Z)` of it. So the windowed inequality is

`E_Ω(M, R) ≤ E_Ω(M, Z) + E_{Ω ⊕ ρ}(Z, R)` with `ρ = E_Ω(M, Z)`,

where `Ω ⊕ ρ` is `Ω` dilated by `ρ`. The harness uses it with `Z = M*` and `ρ = β_c` (section 7.1). The oracle therefore measures `M*` against `R` on the enlarged window `Ω ⊕ 1` px, which covers every `β_c` below 1 px. A case with `β_c ≥ 1` px is UNDECIDED.

**How this maps onto the target.** A case passes A04 when the certified upper bound of `E` is at most 0.25 (section 7.3). `E` is one number in physical pixels, measured after every stage of the pipeline: the kernel's curve and topology construction, the arrangement rounding, Float64-to-binary32 storage, the f32 lanes of the transform and the shader arithmetic. It is the "combined" error of A04 directly. No per-stage share is summed or checked. The three private-contract rows remain design obligations whose sum is designed to fit in 0.25, but A04 does not test the split.

**What `E` does not include, and what stays open.**

- **Coverage.** `E` excludes the coverage ramp's own isoline offset, which A08's Q4 bounds at 1 px.
- **Rasterizer sample snapping.** This is not decided here: [E3-Q7](#11-open-questions) presents it as an explicit term with its known bound, or as an exclusion, for the user to decide.
  - On fringe draws, the visible edge comes from the fragment shader's feature distance at the pixel center, and snapping only selects which fragments run.
  - Region-only draws (`fringe-work-cap`, `fringe-unsupported`) are aliased by design, and their edge is the snapped triangle edge.
  - WebGPU does not expose the subpixel precision. Vulkan's minimum `subPixelPrecisionBits` is 4, which bounds snapping by `2^-5` px per axis, about 0.044 px. Direct3D requires 8 bits, about 0.0028 px.
- **Clipping.** Clipping of triangles with vertices outside the clip volume is implementation-defined. That is class A in [V3 section m](p3-v3-renderer-mesh-pipeline-contract.md#m-risks). Its treatment is [E3-Q11](#11-open-questions) (section 7.1).

### 3.5 E3-K5: zoom, DPR, transforms and buckets

- **Zoom and DPR.** `z ∈ {0.01, 1, 64}` and `d ∈ {1, 2, 3}`, nine pairs, exactly D8's set. A08 uses DPR 1.5; A04 does not add it.
- **Declared transforms.** The set `T` of section 5.3. The bucket depends only on `sigmaMax(d · z · L)`, so the transforms' scales sweep the intermediate zooms of the prototype plan's 1% to 6400% range without adding zoom values.
- **Bucket edges.** Stratum E3-C7 uses scales with `2^e · sigmaMax(S) = 0.125` exactly. That is the largest tolerance V3 can choose, so the curve share is used in full.
- **Served bucket.** `k = 0` for every case: a cold cache, so the exact entry at `e`. Under V3's reuse rule, a resident entry at `e − 1` or `e − 2` may serve. Stratum E3-C8 measures `k = 1` and `k = 2` on a subset (E3-Q8).

### 3.6 E3-K6: camera placement

By default the camera centers the ideal physical bounding box of `R` in the viewport. Stratum E3-C6 adds three placements:

- partial: the path is larger than `Ω`, and its bounding-box corner is at the viewport center;
- far-translation: `t` and `c` are near `±2^24` document units, with the camera following the path, which exercises `O_m` and the anchor `B`;
- fractional pan: offsets of `2^-7` and of a generic binary64 fraction.

## 4. The independent oracle

### 4.1 Location and independence

The new module is `packages/geometry-reference/src/a04-region.ts` (unit E3-U2), exported from the package index. Its independence rests on five rules:

- **Imports.** It imports nothing from `geometry-wasm`, `renderer-core` or `renderer-webgpu`. The existing boundary checker enforces this for `geometry-reference`. E3-A2 adds a test that fails if such an import appears.
- **Inputs.** It reads only the case of E3-K1 and the drawn triangles and mapped positions of E3-K2. It never reads a kernel intermediate: no polygon view, no piece list, no dump and no certificate. This is the main difference from ST-O1, SL-O1 and AL-M5, which check the kernel's own intermediates.
- **Algorithms.** It shares no algorithm with the kernel. The kernel flattens by tolerance-bucket de Casteljau leaves and resolves regions by a sweep arrangement with rounded embedding. The oracle uses exact point classification and certified branch-and-bound distances (section 4.2). It never flattens to a tolerance tied to `e`.
- **Reuse.** It may reuse the exact rational helpers and the reviewed semantic functions in `geometry-reference`: `stroke-region.ts`'s `classifyStrokeSource`, `strokeMiterKept` and `strokeDiskVertexCount` (for the semantics only, never for the kernel's polygon), and `tolerance.ts`. Those modules are themselves independent of the kernel, under the ST-U2 and P2.1 reviews. It reuses `inspectTriangleMesh` only for meshes within that function's caps. Larger meshes get the same checks from the new module.
- **Arithmetic.** Every predicate on membership, orientation, winding and incidence is exact, using BigInt dyadic rationals and exact real-root isolation. Distances are bounded by outward-rounded binary64 interval arithmetic. Every reported number is an interval that contains the true value.

### 4.2 What the oracle computes

The oracle returns a certified interval `[E_lo, E_hi]` containing `E(M, R)` (E3-K4). It does not return an estimate.

- **Exact membership.**
  - **Fill.** `x ∈ R` is decided from the exact winding number of `Φ(P)` around `x`. Line crossings are exact. A cubic crossing comes from exact real-root isolation of the cubic's `y(t) − y_x`, by Sturm sequences over rationals, refined until the sign of `x(t) − x_x` at each root is certain. A point exactly on a curve is decided by an exact polynomial gcd.
  - **Stroke sweeps.** Under section 2.2's definition, `x` is in the sweep of `C` on `[t0, t1]` exactly when `(x − C(t)) · C'(t) = 0` has a root in `[t0, t1]` with `|x − C(t)|² ≤ r²`. That root equation has degree 5 and is isolated exactly.
  - **Stroke pieces and the union.** Joins, caps and cusp disks are decided by exact squared-distance and half-plane tests, with miter keep or bevel decided by `strokeMiterKept`. A stroke point is in `R` when it is in at least one piece.
- **Boundary portions.** A curve portion lies on `∂R` exactly when the membership on its two sides differs. The oracle finds the portions by exact classification at curve-curve crossings, isolated by interval subdivision and confirmed by exact sign changes, and at tangencies and coincidences, decided exactly (section 4.4).
- **Distance bounds.** `B_R`, `B_M` and `G` are evaluated by branch-and-bound. A boundary edge of `M`, or a boundary portion of `R`, is split into cells. In each cell `dist(·, target)` is bounded below by an interval distance to the target's candidate pieces, and above by an explicit witness point on the target. The target's candidate pieces come from a uniform grid over `Ω`. `dist` is 1-Lipschitz, so a cell of diameter `δ` closes once its upper and lower bounds differ by at most the resolution `r_m`.
  - `G` uses the lemma that, wherever `dist(x, ∂R) > E_b` with `E_b = max(B_R, B_M)`, neither boundary passes, so `M` and `R` are constant on each component of that set. The oracle therefore classifies one interior point per face of the overlay of `∂M` and the boundary portions of `∂R`. It bounds `dist(x, ∂R)` only over faces where `M` and `R` disagree, using a certified quadtree on the face.
- **Early exit.** Once `E_lo > 0.25`, the case is a certain fail and the oracle may stop refining. It then reports the lower bound it reached.

### 4.3 Its own error bound

The oracle's error on a case is the width `E_hi − E_lo` of its certified interval. Soundness of each primitive is a proof obligation of E3-U2, checked by its independent review and by positive controls (section 8.1).

- **Resolution.** The default target is `r_m = 2^-10` px, about 0.4% of the target. A case whose interval straddles 0.25 is refined, halving `r_m` down to the floor `2^-20` px. A case still straddling at the floor is UNDECIDED (section 7.3, E3-Q5).
- **Line-only cases.** `R` is a polygon with dyadic vertices, so the boundary portions and `G`'s faces are exact. The only width left is the distance interval, which is narrowed in exact arithmetic to width 0 where the extremum is at a vertex.
- **Reported width.** The record reports `max(E_hi − E_lo)` over measured cases, and over the closed-form controls E3-PC10 the difference between the oracle's interval and the known value.

### 4.4 Fill rules, strokes and cubics

- **Fill rules.** Both rules apply to the exact winding number. Coincident edges with opposite orientations cancel exactly in the winding count, so no sliver appears where the ideal region has no boundary.
- **Strokes.**
  - **Joins.** Bevel, round and miter joins follow ST-S5 and ST-S6. The miter test is exact, with equality keeping the miter. The tip `T` is an algebraic point bounded by intervals. An exact forward continuation adds no join, and an exact reversal follows ST-S6.
  - **Caps.** Butt, square and round caps follow ST-S7. Zero-length subpaths follow ST-S10.
  - **Folds.** The fold of the inner offset where the curvature radius is below `r` is covered by the sweep definition. The oracle needs no fold logic.
- **Cubics.**
  - **Stationary points.** They come from the oracle's own exact classification, the same semantics as ST-S8 via `classifyStrokeSource`. A cusp adds the disk of radius `r` at `C(t*)`. A regular near-cusp is regular: it is never snapped by an epsilon.
  - **Self-intersecting cubics and crossings.** Crossings are isolated as section 4.2 says.
  - **Exact coincidence by construction.** A reversed copy, or the two sides of an exact reversal, is detected exactly and handled by exact cancellation or exact union, never by two separate approximations.
  - **Partial cubic-cubic coincidence.** It does not occur in generated cases and is excluded from named cases. If such a case is detected, the oracle reports `ORACLE-UNSUPPORTED`, which is a freeze failure (section 5.5).
- **Work limit.** Each case has an oracle work cap: E3-U2 sets the number of cells and roots before the freeze. It is a limit on the oracle, not on the kernel.
  - At the freeze check, which covers the ideal side only, a case that exceeds the cap is `ORACLE-WORK`, a freeze failure.
  - At measurement time, a case that exceeds the cap against the drawn mesh is UNDECIDED. It is never dropped or passed.
- **Oracle version.** The oracle is frozen with the corpus by its source SHA-256. Any oracle change after the freeze is a new oracle version, with its own independent review and a full re-run of the corpus.

### 4.5 Proof obligations

E3-U2 proves each obligation below in its review material, and pairs it with a test. The independent review of E3-U2 checks both before the freeze.

| Obligation | Statement                                                                                                                                                                                                                                                                | Paired test                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| (a)        | Winding: the exact winding number of lines and cubics around a dyadic point, including roots at `t = 0, 1`, tangential crossings and points on a curve                                                                                                                   | Closed-form windings of the E3-C1 star and nested contours; points on vertices and on curves     |
| (b)        | Sweep membership at stationary parameters: the sweep ranges over regular parameters only, with the limit normal at interval endpoints, per [stroke contract section 2.2](p3-b2-stroke-contract.md#22-the-stroke-region); a cusp contributes its disk, not a sweep normal | ST-F16 and ST-F19 against hand-derived membership at points next to the cusp                     |
| (c)        | Completeness of the `∂R` portions: every boundary portion of `R` inside `Ω ⊕ 1` is found. A missed portion lowers `B_R` and `G`, so it is **unsound toward PASS**                                                                                                        | E3-PC6 and E3-PC10; a seeded defect that drops one crossing (E3-D12)                             |
| (d)        | Offset-curve crossings and tangencies, which are not rational: the method that isolates them (interval subdivision with exact sign confirmation, or a resultant on the squared form), and its termination or `ORACLE-WORK`                                               | E3-C9 folded-band and wide-stroke rows with crossing points derived independently in closed form |
| (e)        | Extraction of `∂M` from a non-conforming mesh: edges split at T-vertices, an edge used once after splitting is boundary, and nothing else is                                                                                                                             | E3-PC13 (a T-junction mesh); seeded defect E3-D11                                                |
| (f)        | Overlay-face enumeration for `G`: every face of the overlay of `∂M` and the `∂R` portions is enumerated and classified once                                                                                                                                              | E3-PC4 and E3-PC5; seeded defect E3-D13                                                          |
| (g)        | Outward-rounded intervals: every binary64 interval operation rounds outward, so every reported bound contains the true value                                                                                                                                             | Interval unit tests against BigInt evaluation at random dyadic inputs                            |

The cost of this oracle is plausible only as an offline run of hours (E3-R1). It is not a CI check.

## 5. The frozen corpus

### 5.1 Identity

The corpus is `a04-corpus/v1`. It is produced by a deterministic generator, `tests/geometry/e3-a04/corpus.ts` (E3-U1), with the PRNG and seeds of `geometry-reference/src/corpus.ts`, reused unchanged and recorded by value.

**Canonical serialization.** One JSON object per case, in generation order. Keys are sorted, binary64 values are written as 16-digit lower-case hex bit patterns, there is no whitespace, and lines end with LF. **`corpusSha256`** is the SHA-256 of that UTF-8 text.

**The manifest.** `tests/geometry/e3-a04/corpus-v1.manifest.json` records the version, generator source SHA-256, seeds, per-stratum counts and `corpusSha256`. A unit test regenerates the corpus and fails on any difference from the manifest. Any generator change is a new corpus version (E3-Q4).

### 5.2 Case strata

Counts are the draft's proposal (E3-Q9). "Named" rows take every transform of section 5.3 at all nine zoom and DPR pairs. "Generated" rows are seeded: each takes one transform drawn from `T` at all nine pairs.

| Stratum | Content                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rows                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| E3-C1   | Fill, lines, snapped (integer and `2^-8` grids): rectangle, triangle, concave polygon, five-point star under both rules, nested contours with alternating winding, holes, collinear overlapping edges, coincident opposite edges, zero-area contour, pinch vertex, needle triangles of aspect `10^3` to `10^6`, and the T03 residual analogs (needle `TRI` and near-diagonal `RECT` at `k = 24, 32, 40`; depth-positive star and zero-closure) | 40 named, 200 generated      |
| E3-C2   | Fill, lines, generic binary64 coordinates: the same shapes with seeded generic coordinates                                                                                                                                                                                                                                                                                                                                                     | 200 generated                |
| E3-C3   | Fill, cubics: four-cubic circle and ellipse, closed S-curve, self-intersecting cubic loop, exact cusp, near-cusps at control perturbations `2^-10`, `2^-20` and `2^-40`, inflections, two crossing ellipses, multi-contour with holes; the AL-OB5 ring of 32 cubics at `λ = 2, 4, 8`, snapped (OB5's generator) and unsnapped (OB5-W8U)                                                                                                        | 30 named, 300 generated      |
| E3-C4   | Near-coincidence and tangency, fill: line-line and cubic-line pairs at physical gaps `g ∈ {2^-3, 2^-8, 2^-16}` px and `g = 0` (exact touching, lines only)                                                                                                                                                                                                                                                                                     | 24 named                     |
| E3-C5   | Stroke, lines: ST-F1 to ST-F14, ST-F21, ST-F25, and the ST-U8 rows SB-1 (widths `2^-6`, `2^-2`, 1), SB-3 (miter half angles 6, 3, 1 degrees at limits 10, 100, 1000), SB-4 (the miter switch point and either side), SB-6 (round joins at 90, 60, 30 degrees), SB-7 (caps and dots at widths 0.25, 1, 14), SB-13's 64-subpath path; the ST-U3f cases (`chev-1.40625` and the five `λ = 4/3` turns)                                             | 60 named, 150 generated      |
| E3-C6   | Camera placements of E3-K6 (partial, far-translation, fractional pan) on 12 rows taken from E3-C1, E3-C3 and E3-C5, at T0 and the nine pairs                                                                                                                                                                                                                                                                                                   | 12 named × 3 placements      |
| E3-C7   | Bucket-edge scales (`2^e · sigmaMax(S) = 0.125` exactly) on 12 curved rows from E3-C3 and E3-C5, at the nine pairs                                                                                                                                                                                                                                                                                                                             | 12 named                     |
| E3-C8   | Served buckets `k = 1, 2` on the named rows of E3-C1, E3-C3 and E3-C5 at transform T0 and the nine pairs                                                                                                                                                                                                                                                                                                                                       | 130 named × 2                |
| E3-C9   | Stroke, cubics: the s2 families R1 to R6 (ST-F15, SB-9), ST-F16, ST-F16p, `ST-U4/cusp-shared-a` and `-b` (SB-8), wide strokes on curves including a width above the curvature radius (SB-5), a stroked four-cubic circle; and fill plus stroke pairs SB-10 and SB-11, measured per paint with the joint-feature identity check                                                                                                                 | 30 named, 150 generated      |
| E3-C10  | Controls: singular `L`, an empty path, and the closed-form shapes of E3-PC10                                                                                                                                                                                                                                                                                                                                                                   | 12 named, at T0 and one pair |
| E3-C11  | Region-only draws: 4 fills with more than 128 distinct boundary vertices (`fringe-work-cap`: a 200-gon, the AL-OB5 ring at `λ = 8`, a 4-contour star field, a 160-step staircase), and 4 fills built to be `fringe-unsupported` (a vertex with more than 3 sectors, duplicate coordinates)                                                                                                                                                     | 8 named                      |
| E3-C12  | T-junction-heavy fills: filled polygons with interior holes and rounded contours, whose meshes have slab T-junctions, at T2 and T6 only                                                                                                                                                                                                                                                                                                        | 8 named × 2 transforms       |

**Size classes.** Every generated stratum draws its physical extent class uniformly from: sub-pixel (below 1 px), small (1 to 16 px), medium (16 to 512 px) and large (512 to 8,192 px, wider than `Ω` at DPR 1). The class is reached by scaling the local geometry against the case's `σ(S)`. So the class is defined in physical pixels and is stable across zoom.

**ST-U3f rows.** The ST-U3f cases in E3-C5 are expected to be rejected (`unsupported-geometry`, a known defect). While they are rejected, they are evidence for A01, not for A04 (section 6). They stay in the corpus so that a later fix moves them into the measured set.

**Coverage of the ST-U8 rows.** SB-2 (the whole scene at zoom 0.01) is covered by every row at `z = 0.01`. SB-12 (non-uniform scale, rotation, shear and negative determinant on strokes) is covered by `T` on E3-C5 and E3-C9. SB-13's 256-path scene is a performance scene, so A04 takes only its 64-subpath path.

### 5.3 Declared transforms `T`

| ID  | `L` (binary64 entries)               | Purpose                                             |
| --- | ------------------------------------ | --------------------------------------------------- |
| T0  | identity                             | Baseline                                            |
| T1  | rotation by 30 degrees               | Exact-looking rotation with inexact entries         |
| T2  | rotation by 37.21 degrees            | Generic rotation                                    |
| T3  | diag(2.5, 0.375)                     | Non-uniform scale; stroke width varies by angle     |
| T4  | [[1, 0.5], [0, 1]]                   | Shear                                               |
| T5  | diag(−1, 1) composed with T2         | Negative determinant (`σ = −1`)                     |
| T6  | T2 composed with T3 composed with T4 | Generic full-rank linear map                        |
| T7  | diag(1, 2^-12)                       | Strong anisotropy (`sigmaMin` far below `sigmaMax`) |

Translations: `t` is `0`, a snapped value (integer) or a generic binary64 value, drawn per generated row. E3-C6 adds the far translation.

### 5.4 Size of v1

As proposed: 212 named path rows and 1,000 generated path rows, about 25,800 cases in all. E3-Q9 sets the size.

| Part                                                                                   |      Cases |
| -------------------------------------------------------------------------------------- | ---------: |
| Named rows of E3-C1, E3-C3, E3-C4, E3-C5 and E3-C9 (184 rows × 8 transforms × 9 pairs) |     13,248 |
| E3-C10 controls (12 rows, T0, one pair)                                                |         12 |
| Generated rows (1,000 rows × 9 pairs)                                                  |      9,000 |
| E3-C6 (12 rows × 3 placements × 9 pairs)                                               |        324 |
| E3-C7 (12 rows × 9 pairs)                                                              |        108 |
| E3-C8 (130 rows × 2 offsets × 9 pairs)                                                 |      2,340 |
| E3-C11 (8 rows × 8 transforms × 9 pairs)                                               |        576 |
| E3-C12 (8 rows × 2 transforms × 9 pairs)                                               |        144 |
| **Total**                                                                              | **25,752** |

### 5.5 Freeze procedure and blindness

1. This contract is approved.
2. E3-U1 (generator, manifest) and E3-U2 (oracle) merge.
3. **Oracle-only freeze check.** The oracle builds the ideal boundary portions of every case and confirms that each case is certifiable within the oracle work cap. It runs no kernel. A case that is `ORACLE-WORK` or `ORACLE-UNSUPPORTED` fails the freeze (E3-Q6).
4. **Freeze record.** A dated note is appended to this contract with `corpusSha256`, the generator SHA-256, the oracle source SHA-256, the strata counts and the freeze-check result.
5. Only then is the kernel run on the corpus (E3-U3 to E3-U5).

**Blindness.** The generated strata are blind: no kernel output on them is inspected before the freeze. The named rows are not blind. They are chosen from cases already known to be hard (ST-U8's rows, T03's residual analogs, ST-U3f, AL-OB5), and this is disclosed, as T04 disclosed its post-census K. A generator or corpus change after the first kernel run is a new corpus version. The new version must keep every case of the old version that failed or was undecided.

## 6. Rejected cases

A case is **rejected**, and excluded from the precision statistic, when no drawn mesh exists for it:

| Source                                                  | Codes                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Port result `failed`                                    | `work-limit`, `unsupported-geometry`, `numeric-range`, `invalid-tolerance`, `invalid-path`                    |
| Renderer state failure before a draw (V3 sections c, h) | `tolerance-range`, `packing-range`, `invalid-response`, `invalid-mesh`, `port-version`, `overlay-unsupported` |
| Not drawable                                            | `det L = 0` (E3-C10 only); `w = 0`                                                                            |

These are **measured, not rejected**: `empty`, because `M = ∅` is a drawn answer, measured with the membership check of E3-K2; and `fringe-work-cap` and `fringe-unsupported`, because the region still draws and `∂M` is the same (named rows in E3-C11).

**Reporting.** The record lists every rejected case with its code. It reports the rejection rate per stratum, per transform, per zoom and DPR pair, and per paint.

**Relation to A01 to A03.**

- A rejection is not an A04 pass and not an A04 failure.
- It is evidence for A01 (deterministic failure isolation and bounded adversarial work). The record's rejection list is an input to A01's evidence.
- A rejected ordinary case is a gap in A02 (fill) or A03 (stroke) semantics coverage. The private contract forbids reducing the ordinary-success corpus or silently returning coarse geometry. So A04 PASS never implies A02 or A03 PASS, and an A04 record makes no A02 or A03 claim.
- Whether a rejection rate is acceptable is A02's and A03's question, not A04's.
- To keep "across declared transforms/zoom/DPR" honest, A04 has a coverage condition (E3-A8): every declared cell needs a measured case. A cell is fill or stroke, times a transform, times a zoom and DPR pair. A cell with no measured case makes A04 **UNVERIFIED** for that cell, not PASS. This coverage condition is an interpretation of the criterion's wording, and the user approves it under E3-Q3. Today's known stroke `work-limit` cases (ST-U8, stroke contract S7) will probably leave some stroke cells unmeasured until an outcome-changing stroke change such as E2 lands. E1 (ST-U10, #202) preserves every outcome, so it does not change this.

## 7. Measurement procedure

### 7.1 Where it runs

- **Kernel.** The release WASM is loaded in Node, at the pinned Node version of `package.json`, through the real `createFillMeshPort` and `createStrokeMeshPort` adapters. Its SHA-256 is recorded. This is the product artifact and the product port path, which is what D8 B4 names ("the V2 export"). Native is not measured. Native and WASM byte identity is already gated by the existing differential and identity checks (`pnpm test:geometry`), and the product never runs native. Measuring native would add a second artifact without adding A04 evidence.
- **Renderer CPU stages.** `renderer-core`'s own bucket selection and K4 packing are called as unit tests call them. This is the product code under measurement, not part of the oracle.
- **Shader mapping, CPU model.** For each stored point, the WGSL mapping is evaluated exactly over the rationals from the f32 lane values, giving `p*` in physical pixels. The mapping is fixed by a shader-identity test that hashes the WGSL source, as P3.1l did. `β(p)` is a forward error bound for f32 evaluation of every post-mapping stage that positions the point. It is a standard `γ_n` bound on each multiply and add, and it holds whether or not the compiler fuses multiply and add. `β_c` is the maximum of `β(p)` over the case's points. `β(p)` covers the larger of two paths:
  - **The vertex path.** `toPhysical`, then the NDC step `x·2/W − 1` and the y flip `1 − y·2/H`, both in f32 (`meshPositionNdc`), then the viewport transform back to pixels, modelled in f32. This is the NDC round trip that P1's position rule includes ([P1 private contract](p1-private-contract.md#precision-and-rebase-contract)).
  - **The feature path.** `toPhysical` for the EDGE and VERTEX feature points evaluated in the fragment stage, which has no NDC step.
- **Assumptions of the model.**
  - **Bit-identical shared vertices.** A shared vertex is mapped bit-identically in every invocation and in both vertex entry points. Both entry points use the one helper `meshPositionNdc`, and the position output is `@invariant`. Without this assumption, even a conforming mesh could crack. The readback of E3-U4 confirms it on the run's adapters by comparing the positions of one vertex across invocations.
  - **The fixed-function viewport transform.** The transform from NDC back to pixels runs in hardware at a precision that WebGPU does not specify. The f32 model above is an assumption about it, not a guarantee. Its unspecified precision is part of the rasterization residual of [E3-Q7](#11-open-questions), alongside snapping.
- **Guard band and clipping.** A triangle with a mapped vertex outside the clip volume is clipped by the GPU, and clipping is implementation-defined (class A, [V3 section m](p3-v3-renderer-mesh-pipeline-contract.md#m-risks)). A case with any mapped vertex outside the stated guard band is **UNDECIDED** unless clipping is modelled. The band and the model are [E3-Q11](#11-open-questions).
- **No-flip certificate and conformity.** Each mapped triangle's orientation is certified stable under a `β_c` perturbation of its vertices, from its exact area and edge lengths. For a **conforming** mesh with the certificate holding, the piecewise-affine map moving each vertex by at most `β_c` moves `∂M` by at most `β_c`. So `E_Ω(M_gpu, M*) ≤ β_c`, and by the windowed inequality (E3-K4), `E_Ω(M_gpu, R) ≤ β_c + E_{Ω⊕β_c}(M*, R)`. Here `M*` is the mesh at `p*`. For a mesh with T-junctions this bound is false: a crack opened on the GPU lies inside `R`, and `B_M` scores it at its depth. The rule for such cases follows the approved option of [E3-Q10](#11-open-questions). Under E3-Q10 (b), the bound is restored on the crack-closed region defined there. A case where the certificate fails is UNDECIDED unless E3-U4's readback covers it (E3-Q1).
- **GPU model check.** A test-only page in headed Chrome and Edge evaluates the same WGSL mapping function for every stored point of a declared readback subset and reads the positions back. The subset is the named rows of E3-C1, E3-C3, E3-C5, E3-C9 and E3-C12, at every transform and pair. E3-C12 lets the readback observe real crack widths at T-junctions. The page is owned by the rendering track as a measurement page. Every read-back position must lie within `β(p)` of `p*`, and the browser's mesh bytes must hash equal to Node's. The check reads back both NDC-path and feature-path positions. A position outside its box falsifies the model, and A04 is then UNVERIFIED until the model is corrected (E3-R5). The check contributes to the "later real GPU evidence" of the private contract's third row; it does not complete that evidence. Pixel readback is not used: pixels carry coverage (A08), not sub-pixel geometry.

E3-Q1 records the alternatives: GPU readback for every case, or CPU only.

### 7.2 Per-case result

For each measured case, the record keeps:

- `E_lo` and `E_hi` from the oracle on `M*`, on the window `Ω ⊕ 1`;
- `β_c`;
- the T-junction count and the crack bound;
- the guard-band result;
- **`U = E_hi + β_c`**, the certified upper bound on the drawn error;
- **`L = max(0, E_lo − β_c)`**, the certified lower bound;
- the case status, defined in section 7.3.

### 7.3 Pass rule and statistic

**Case status.**

- **PASS** when `U ≤ 0.25`.
- **FAIL** when `L > 0.25`.
- **UNDECIDED** otherwise, after refinement to the resolution floor (E3-Q5). A case is also UNDECIDED when it:
  - exceeds the oracle work cap at measurement time;
  - has `β_c ≥ 1` px;
  - fails the no-flip certificate without readback;
  - has a mapped vertex outside the guard band with no clipping model.

  An UNDECIDED case is never counted as a pass.

**A04 verdict.**

- **PASS** only when all of these hold:
  - every measured case is PASS;
  - E3-A1 to E3-A9 hold, including every positive control rejected and every negative control accepted;
  - the GPU model check passes;
  - the coverage condition holds;
  - no case is UNDECIDED.
- **FAIL** when any measured case is FAIL. "A sample that exceeds 0.25 px fails A04" (D8): one case suffices.
- **UNVERIFIED** otherwise.

**Statistic.** The pass rule uses the maximum, because D8's wording is per sample. The record reports, per stratum, per transform, per zoom and DPR pair, per paint and overall:

- the maximum `U` and the case that attains it;
- p99 and p50 of `U` by nearest rank, as [`docs/benchmarks/README.md`](../benchmarks/README.md#samples-and-aggregation) declares it;
- the counts of measured, rejected, `window-empty` and UNDECIDED cases.

p99 is reported, never gated.

### 7.4 Record format: an evidence record, not a benchmark result

A04 is a deterministic correctness measurement, not a timing measurement. [`docs/validation.md`](../validation.md#principles) keeps correctness tests deterministic and separate from performance measurements, and [`docs/benchmarks/README.md`](../benchmarks/README.md) defines timing scenarios, samples and regression baselines that do not apply to a deterministic error bound. The result is therefore an **evidence record**, written in the existing `docs/evidence/` pattern:

- **Location.** `docs/evidence/e3-a04/<UTC timestamp>-<run id>/` with `record.md` and a raw `record.json`. The run id is collision-free, and the writer refuses to replace an existing artifact, as the benchmark policy requires of results.
- **Immutability.** Committed records are immutable. A correction is a new review record or a new run.
- **Provenance.** Source commit and clean or dirty state (a dirty run is not accepted). The contract SHA-256 at its freeze commit, the release WASM SHA-256, and the fill and stroke operation identities, at baseline `geometry-wasm/fill-v0+r2` and `geometry-wasm/stroke-v0+r4`. `corpusSha256`, the oracle source SHA-256, the shader-identity hash, the carrier `K4` and the builder placement (D8-interim TypeScript builders in `renderer-core`). The Node version and the OS.
- **GPU part.** The metadata of [accepted reference runs](../benchmarks/README.md#accepted-reference-runs) that applies to a readback: OS, GPU adapter and driver, browser product, channel and exact version, DPR, and launch flags. Timing metadata is not needed.
- **Results.** Every case's id, status, `E_lo`, `E_hi`, `β_c`, `U` and `L`, or its rejection code. The aggregates of section 7.3. The positive-control outcomes. The maximum oracle interval width. The verdict, written as the measured disposition. Acceptance is the Primary's, after an independent evidence review, as for benchmark baselines.
- **Diagnostic timing.** The oracle's and the harness's wall time are recorded as diagnostics only, never as a performance claim.

## 8. Fixtures, controls and seeded defects

### 8.1 Rejecting positive controls

Each control is a deliberate defect applied to a correct case, or a known-answer case. Each must be rejected, or for the negative controls accepted, before any corpus result counts (E3-A5).

| ID      | Control                                                                                                                                                                                                                                                                                                                                                            | Must be detected by                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-PC1  | One boundary vertex of a correct mesh moved 0.26 physical px along its outward normal                                                                                                                                                                                                                                                                              | FAIL (`B_M`)                                                                                                                                                        |
| E3-PC2  | Negative control. Base case: a snapped axis-aligned rectangle at T0, `z = 1`, `d = 1`, whose exact mesh has `E = 0`. One boundary vertex is moved 0.24 px along its outward normal                                                                                                                                                                                 | PASS, with `0.24 ∈ [E_lo, E_hi]`                                                                                                                                    |
| E3-PC3  | Coarse flattening, synthetic, built by the harness and not the kernel: a circle and an S-curve row replaced by inscribed chord polygons at the chord count that the `e + 3` tolerance admits. The rows are chosen so that their independent closed-form chord error is above 0.25 px (0.3 to 1 px)                                                                 | FAIL, with the closed-form error inside `[E_lo, E_hi]`                                                                                                              |
| E3-PC4  | One interior triangle dropped from a filled square                                                                                                                                                                                                                                                                                                                 | FAIL (`G` and `B_M`)                                                                                                                                                |
| E3-PC5  | The fill rule flipped on the star (evenodd mesh against a nonzero case)                                                                                                                                                                                                                                                                                            | FAIL (`G`)                                                                                                                                                          |
| E3-PC6  | Hole closing: a ring whose ideal hole is 0.4 px wide, meshed without the hole (the ST-OB3 residual)                                                                                                                                                                                                                                                                | FAIL (`B_R`)                                                                                                                                                        |
| E3-PC7  | One f32 lane of `A` perturbed by `2^k` ulps so that the projection error at a far-translation case is 0.3 px                                                                                                                                                                                                                                                       | FAIL                                                                                                                                                                |
| E3-PC8  | The pan `O_m − camera` offset by 0.3 px                                                                                                                                                                                                                                                                                                                            | FAIL                                                                                                                                                                |
| E3-PC9  | Stroke, at T0, `z = 1`, `d = 1`, where one local unit is one physical px: the half-width `r` raised by 0.3 local units, so each side moves 0.3 px; a kept miter replaced by a bevel on a row whose tip lies more than 0.3 px beyond the bevel line; a round cap replaced by a square cap with `r ≥ 1` px, whose corner lies `r(√2 − 1) ≥ 0.41` px outside the disk | FAIL on each                                                                                                                                                        |
| E3-PC10 | Closed-form controls: an axis-aligned rectangle (known `E = 0`); an inscribed regular `n`-gon of a circle drawn as a mesh against the exact circle as `R` (known `E` = sagitta); an exact polygon translated by a known dyadic offset                                                                                                                              | Interval contains the known value                                                                                                                                   |
| E3-PC11 | An `empty` result for a non-empty case                                                                                                                                                                                                                                                                                                                             | FAIL (`B_R = +∞`)                                                                                                                                                   |
| E3-PC12 | A model-check control: a read-back position replaced by `p* + 2β(p)`                                                                                                                                                                                                                                                                                               | GPU model check fails                                                                                                                                               |
| E3-PC13 | A synthetic T-junction mesh under T4, whose f32 entries are exact: a square split into a two-triangle cell and a neighbour whose node lies inside the shared constant-x side. The coordinates are f32-exact offsets with full 24-bit significands, so `M*` is exact against `R`, the square, while the GPU's f32 products round and the readback can show a crack  | In `M*`: `∂M` has no spurious inner boundary and `E = 0`. The T-junction count is 1 and the crack bound is reported. The verdict follows the approved E3-Q10 option |
| E3-PC14 | A missing mesh over a large shape: `R` covers `Ω`, and the result is `empty` (or `window-empty` with no `∂R` in `Ω`)                                                                                                                                                                                                                                               | FAIL (membership disagrees at the window point)                                                                                                                     |

### 8.2 Seeded defects in the oracle and harness

Each seeded defect is a mutation that the named control or test must catch. Each is applied in a unit test, not in the committed source.

| ID     | Seeded defect                                                   | Caught by                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-D1  | `G` term omitted                                                | E3-PC4, E3-PC5                                                                                                                                                                                                                                                                                                                                                             |
| E3-D2  | `B_R` term omitted (one-sided Hausdorff)                        | E3-PC6, E3-PC11                                                                                                                                                                                                                                                                                                                                                            |
| E3-D3  | Membership with the wrong fill rule                             | E3-PC5 and the E3-C1 star under both rules                                                                                                                                                                                                                                                                                                                                 |
| E3-D4  | Stroke sweep membership by nearest point instead of normal foot | A folded-band row of E3-C9 against a closed-form check                                                                                                                                                                                                                                                                                                                     |
| E3-D5  | Cusp disk omitted in the oracle                                 | A synthetic mesh for ST-F16 built by the harness with the cusp disk at a closed-form bound (oracle FAIL). The kernel's mesh is not used, because no kernel output is read before the freeze (section 5.5)                                                                                                                                                                  |
| E3-D6  | Branch-and-bound upper bound taken at the cell center only      | E3-PC10 `n`-gon (interval misses the known value)                                                                                                                                                                                                                                                                                                                          |
| E3-D7  | `β` omitted from `U`                                            | E3-PC7 near the threshold and the `β` unit test                                                                                                                                                                                                                                                                                                                            |
| E3-D8  | Ideal map with `fround(z)` instead of the binary64 `z`          | A T0 `z = 0.01` closed-form row of 8,192 px extent, run at resolution `2^-16` px. The f32-versus-f64 `z` effect there is about `5·10^-4` px, below the default `r_m = 2^-10` px, so the default resolution cannot catch it                                                                                                                                                 |
| E3-D9  | Window `Ω` without the 2 px guard                               | An E3-C6 partial-placement row with a defect inside the guard band                                                                                                                                                                                                                                                                                                         |
| E3-D10 | Rejected cases silently dropped from the record                 | The record validator (counts must reconcile with the corpus)                                                                                                                                                                                                                                                                                                               |
| E3-D11 | `∂M` extracted without splitting edges at T-vertices            | E3-PC13 (a spurious inner boundary makes `B_M` positive in `M*`)                                                                                                                                                                                                                                                                                                           |
| E3-D12 | One curve crossing dropped from the `∂R` portions               | E3-C1 star and the E3-C3 crossing ellipses against closed-form boundaries                                                                                                                                                                                                                                                                                                  |
| E3-D13 | Overlay faces with holes skipped in `G`                         | A variant of E3-PC4 built so that the disagreeing face has a hole: `R` has three nested contours (outer square, hole `H`, island `I` inside `H`), and the mesh also fills `H \ I`, so the face of disagreement is the annulus `H \ I` around `I`. The test asserts the value of `G` itself against its closed form, not only the verdict, because `B_R` fails the case too |
| E3-D14 | NDC step omitted from `β`                                       | The `β` unit test on a far-translation point                                                                                                                                                                                                                                                                                                                               |

### 8.3 Fixtures

The corpus itself is a fixture (section 5). Named rows reuse the literal inputs of ST-F1 to ST-F26, the ST-U4 and ST-U3f cases, the AL-OB5 generator and the T03 residual geometry by value, copied into the generator with their source ids. They are not imported from kernel test code.

## 9. Units, acceptance and validation

### 9.1 Units

Every unit is test-only. No unit changes product source, a contract, an ABI or a dependency. Each is light tier under this contract once it is frozen, with one independent diff review. E3-U5's evidence also gets an independent evidence review.

| Unit  | Content                                                                                                                                                                                                                                                                   | Files (proposed)                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| E3-U1 | Generator, canonical serialization, manifest, regeneration test                                                                                                                                                                                                           | `tests/geometry/e3-a04/corpus.ts`, `corpus-v1.manifest.json`, `tests/geometry/e3-a04-corpus.test.ts` |
| E3-U2 | Oracle with exact membership, boundary portions, conformity test and certified `E`; proof obligations (a) to (g) of section 4.5; E3-PC10 and E3-PC13; seeded defects E3-D1 to E3-D6, E3-D8 and E3-D11 to E3-D13; the oracle-only freeze check and freeze note             | `packages/geometry-reference/src/a04-region.ts`, `tests/geometry/e3-a04-oracle.test.ts`              |
| E3-U3 | Harness: Node WASM through the ports, `renderer-core` buckets and packing, exact shader model and `β` with the NDC round trip, guard-band check, no-flip certificate, record writer and validator; E3-PC1 to E3-PC9, E3-PC11 and E3-PC14; E3-D7, E3-D9, E3-D10 and E3-D14 | `tests/geometry/e3-a04/harness.ts`, `record.ts`, `tooling/run-e3-a04.mjs`                            |
| E3-U4 | GPU model-check page and headed spec (Chrome, Edge); E3-PC12                                                                                                                                                                                                              | `apps/playground/e3-a04-readback.html` and source, `tests/gpu/e3-a04-readback.spec.ts`               |
| E3-U5 | Reference run, evidence record, independent evidence review, X1 row update                                                                                                                                                                                                | `docs/evidence/e3-a04/…`, `d9-rendering-track.md`                                                    |

### 9.2 Acceptance criteria

| ID    | Criterion                                                                                                                                            | Evidence                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| E3-A1 | The regenerated corpus equals the manifest's `corpusSha256`                                                                                          | Unit test id, command, pass count               |
| E3-A2 | The oracle imports nothing from `geometry-wasm`, `renderer-core` or `renderer-webgpu`, and reads no kernel intermediate                              | Boundary check and import test                  |
| E3-A3 | Every seeded defect E3-D1 to E3-D14 is caught by its named check, and every proof obligation of section 4.5 has its paired test passing              | Unit test ids; E3-U2 review record              |
| E3-A4 | The freeze check passes, with no `ORACLE-WORK` or `ORACLE-UNSUPPORTED`, and is recorded before any kernel run                                        | Freeze note in this contract                    |
| E3-A5 | E3-PC1 to E3-PC14 meet their expectations in the reference run, before any corpus result counts                                                      | Evidence record                                 |
| E3-A6 | The GPU model check passes in headed Chrome and Edge                                                                                                 | Browser evidence: versions, spec id, record     |
| E3-A7 | The record validator reconciles measured, rejected, `window-empty` and UNDECIDED counts with the corpus                                              | Validator output in the record                  |
| E3-A8 | Coverage: every declared cell (paint × transform × zoom and DPR pair) has at least one measured case; otherwise the record names the cell UNVERIFIED | Evidence record                                 |
| E3-A9 | The verdict follows section 7.3 exactly                                                                                                              | Evidence record and independent evidence review |

### 9.3 Validation commands

- **Existing commands.** `pnpm check`, `pnpm build`, `pnpm test:geometry` (release WASM build and its SHA-256), and `pnpm test:gpu` for the regression GPU specs.
- **Proposed commands.** Each unit adds one, and the [`docs/validation.md`](../validation.md#current-command-surface) table gains its row:
  - `pnpm test:e3-a04` (E3-U1 to E3-U3 unit tests; CI);
  - `pnpm e3-a04:freeze` (oracle-only freeze check; manual);
  - `pnpm e3-a04:run` (reference measurement and record; manual, not CI);
  - `pnpm exec playwright test -c playwright.gpu.config.ts tests/gpu/e3-a04-readback.spec.ts` (headed; manual).
- **This documentation checkpoint.** `pnpm exec prettier --check --config .prettierrc.json --ignore-path "" <changed .md files>`, the link and anchor check and `git diff --check`. No product, browser, GPU or measurement run is required or claimed.

## 10. Risks

- **E3-R1: oracle cost.**
  - **Cause.** Exact root isolation and certified branch-and-bound on about 25,800 cases may take hours. The cost is plausible only as an offline run of hours, not as a CI check. The AL-OB5 rings and large strokes are the heaviest.
  - **Mitigation.** Grid candidates, early exit on certain FAIL, per-case work caps checked at the freeze, and an E3-Q9 size choice.
  - **Limits.** Cost is a planning risk only. It never changes the metric, the resolution floor or the threshold.
- **E3-R2: oracle soundness.** The certified interval is only as sound as its primitives. The mitigations are E3-U2's proof obligations, an independent review of them, E3-PC10's closed forms and the seeded defects. A soundness defect found after a run invalidates that run's record: a review record says so, and the run is repeated.
- **E3-R3: the kernel fails A04.**
  - **The threshold never changes.** A FAIL stays a FAIL: the 0.25 target, the metric and the corpus are not adjusted to pass.
  - **Reporting.** The failing cases and their strata go to the user as a remedy decision, for example a kernel or packing change under its own contract.
  - **Re-run.** A04 is re-run on the same frozen corpus, or on a new version that keeps every failing case (section 5.5).
  - **Likely failures.** These are stated here before any run:
    - the K4 carrier's known class A limitation (far-offscreen vertices);
    - the T03 needle and diagonal analogs;
    - collapsed sub-tolerance features. The metric of E3-Q2 (a) is discontinuous there. When a feature narrower than the tolerance collapses in the mesh, `B_R` becomes the distance from its ideal boundary to the nearest surviving drawn boundary. So a `2^-16` px gap of E3-C4, a thin hole, or a needle can score several pixels, not a fraction of the tolerance;
    - GPU cracks at T-junctions, if E3-Q10 (a) is chosen.
- **E3-R4: identity drift.** A04 evidence holds for the recorded operation identities, carrier, builder placement and shader hash. Each of these requires a re-run when it changes:
  - a new fill or stroke revision;
  - the K1 carrier;
  - the move of the D8-interim builders (E6);
  - a WGSL mapping change.

  Stroke rows are re-run when E1 or E2 changes stroke outcomes, as [D9](d9-post-mvp1-tracks-proposal.md#rendering-track-engine) requires.

- **E3-R5: the f32 model.** If the WGSL compiler evaluates the mapping outside the `γ_n` model, E3-U4 detects it. A04 is then UNVERIFIED until `β` is corrected, or until E3-Q1 (b) is adopted for the affected cases.
- **E3-R6: gaming by rejection.** A kernel could pass A04 by rejecting hard cases. Rejections are listed, rated and routed to A01 to A03 (section 6), and the coverage condition keeps unmeasured cells UNVERIFIED. A later run that rejects more named cases than an earlier one says so in its record.
- **E3-R7: named rows are not blind.** They are disclosed as chosen from known-hard cases (section 5.5). The generated strata carry the blind evidence.
- **E3-R8: the fringe-work-cap and region-only edges.** `E` measures the same `∂M` whether or not a fringe exists. Whether rasterizer snapping, which positions region-only edges, is an explicit term or a stated exclusion is the user's decision under E3-Q7.
- **E3-R9: coverage is separate.** A04 PASS does not show that the A5 isoline lands on `∂M`. That is A08's Q4, and O02's G1 to G3 PASS does not transfer to K4 (V3 section e).

## 11. Open questions

The first option of each question is the recommended one, except E3-Q10, whose option letters follow the review's wording and whose recommended option is marked. Independent review round 1 also recommended these options:

- Q1 (a), after the T-junction (B1) and post-mapping (B2) fixes;
- Q2 (a), with its discontinuity stated;
- Q3 to Q6 and Q8 (a);
- Q7 (a), with snapping presented explicitly;
- Q9 (a).

Round 1 did not rank Q10 to Q12, which it raised. Review round 2 ranked them:

- Q10: (b) with the A01 amendment, then (c), then (a);
- Q11: (a), (b), (c);
- Q12: (a), (b), (c).

**E3-Q1: measurement mode.**

- **(a) Recommended.** CPU measurement with an exact shader model plus `β`, including the NDC round trip, and a GPU readback model check on the named subset in Chrome and Edge. The core is deterministic and CI-reproducible. GPU evidence checks the model on real hardware. The costs:
  - no-flip failures, model violations and out-of-band vertices become UNDECIDED or UNVERIFIED cases;
  - T-junction cases depend on E3-Q10.
- **(b)** GPU readback of every case's positions, with `M` built from read-back values and no `β`. This is the strongest evidence for the tested GPUs. Its costs are a long headed run per browser and results tied to one adapter.
- **(c)** CPU only, with no GPU. This leaves the private contract's third row without "later real GPU evidence", so A04 could not reach PASS under it.

**E3-Q2: metric.**

- **(a) Recommended.** `E = max(B_R, B_M, G)` as in E3-K4. It covers boundary displacement, hole closing (ST-OB3) and wrong-side area.
  - **It is discontinuous.** When a sub-tolerance feature collapses, `B_R` jumps to the distance to the nearest surviving boundary. `2^-16` px gaps, thin holes and T03 needles can then score several pixels (E3-R3).
  - It does not see flipped or doubled triangles, which go to A01 (E3-K4).
- **(b)** Two-sided region Hausdorff only, the stroke construction metric. It misses hole closing, which the stroke contract assigns to B4.
- **(c)** Symmetric-difference area per boundary length. That is an average, so it can hide a local 1 px error. It does not match "a sample that exceeds 0.25 px".

**E3-Q3: rejected cases.**

- **(a) Recommended.** Rejected cases are excluded and reported, and a declared cell with no measured case is UNVERIFIED (E3-A8). No new threshold is added. Approving (a) also approves the coverage condition E3-A8, the contract's interpretation of "across declared transforms/zoom/DPR".
- **(b)** Require a minimum measured fraction per stratum. This adds a numeric criterion, which is a new acceptance threshold that needs the user's decision and an A04 owner update.
- **(c)** Count every rejection as an A04 failure. This conflates A01 to A03 with A04 and would fail A04 on known `work-limit` strokes that have no precision defect.

**E3-Q4: corpus storage.**

- **(a) Recommended.** Commit the generator, the manifest and `corpusSha256`, and regenerate the corpus deterministically in every run. The repository stays small and the SHA test detects drift. It depends on the generator staying runnable.
- **(b)** Commit the serialized corpus file, which may be several MB. It is reproducible without the generator, at the cost of a large tracked file.
- **(c)** Both: the strongest provenance and the largest diff.

**E3-Q5: UNDECIDED cases.**

- **(a) Recommended.** An UNDECIDED case keeps A04 UNVERIFIED until the oracle, but never the threshold, resolves it. This is conservative and honest. It may leave A04 open on near-threshold cases.
- **(b)** Count UNDECIDED as FAIL. This is simpler. It may fail A04 on a case that actually passes.
- **(c)** Judge by `E_lo`. This is optimistic and would count an unproven case as a pass, so it is not acceptable as evidence.

**E3-Q6: freeze failure.**

- **(a) Recommended.** A case the oracle cannot certify fails the freeze. The generator is revised and the change disclosed before any kernel run, under a new corpus version. No kernel result can influence this.
- **(b)** Drop the case and report the count. This is faster and leaves a silent hole, possibly at exactly the hard geometry.
- **(c)** Keep the case as `ORACLE-INDETERMINATE` and measure the rest. This keeps the case visible, but A04 then has unmeasurable cases inside its corpus.

**E3-Q7: region-only draws and rasterizer snapping.**

Rasterizer snapping moves a triangle edge by at most `2^-(s+1)` px per axis for `s` subpixel bits. WebGPU does not expose `s`:

- Vulkan's minimum `s = 4` gives `2^-5` px per axis, about 0.044 px in distance;
- Direct3D's required `s = 8` gives about 0.0028 px.

The options:

- **(a) Recommended.** Measure the same `∂M` for fringe and region-only draws, and **exclude snapping explicitly** as a stated residual with its bound recorded:
  - on fringe draws, the A5 edge comes from feature distance at pixel centers, so snapping only selects the fragments that run;
  - region-only draws are aliased by design.

  This keeps one geometric definition. The cost: A04 makes no claim about where a region-only edge's pixels flip, within up to 0.044 px.

  The same residual covers the unspecified precision of the fixed-function viewport transform from NDC to pixels (section 7.1). It is recorded as part of the rasterization residual, not as a term of `U`.

- **(b)** Exclude region-only draws (`fringe-work-cap`, `fringe-unsupported`) as rejected. Large meshes above 128 boundary vertices would then never be measured.
- **(c)** Add an explicit snapping term `σ_snap = √2 · 2^-5` px, about 0.044 px, the Vulkan-minimum bound, to `U` for region-only draws, or for every draw. This is conservative. It uses up about 18% of the target on an assumption about hardware that WebGPU does not expose.

**E3-Q8: served buckets.**

- **(a) Recommended.** Measure `k = 0` everywhere and `k = 1, 2` on E3-C8. This exercises V3's reuse rule at about 9% extra cases.
- **(b)** Measure `k = 0` only. This is cheaper, and it leaves the reuse rule's "finer is within the share" argument unmeasured.
- **(c)** Measure `k = 0, 1, 2` on every case. This is complete and about three times the cost.

**E3-Q9: corpus v1 size.**

- **(a) Recommended.** About 25,800 cases (section 5.4): named rows cross every transform and pair, and generated rows take one transform at every pair. Every declared cell is covered several times.
- **(b)** A smoke corpus first (named rows at T0, T2, T5 and T6 only, about 7,000 cases), then v1. It gives an earlier signal at the cost of two freezes.
- **(c)** The full cross for generated rows too, about 89,000 cases. This is the strongest coverage, at about 3.5 times the oracle cost.

**E3-Q10: are GPU T-junction cracks A04 errors?**

The kernel's stored meshes may have T-junctions (E3-K2). Under rotation or shear the GPU's per-vertex f32 mapping can open cracks up to about `2β` wide inside the region, and `B_M` would score such a crack at its depth, not its width. The contract does not decide this question.

- **(a)** Model the crack width explicitly in `β`, and score cracks under `E`.
  - This is the most literal reading of "combined geometric error".
  - Almost every non-conforming mesh under T1, T2, T4, T5 or T6 would then FAIL A04 at the crack's depth, often many pixels, even though the crack is far narrower than a pixel. A04 would fail on watertightness, not on boundary position.
- **(b) Recommended.** By an approved decision, route watertightness and cracks to A01 mesh validity. Measure A04 on `M*` with the per-vertex `β` (the T-vertex stays on its edge in `M*`), and report the crack bound and T-junction count separately in the record. The reasons:
  - It keeps A04 a statement about where the boundary is.
  - It hands the crack, which is a validity defect that can drop a pixel center, to the criterion that owns mesh validity.
  - It hides nothing, because the crack bound is published per case.
  - The cost: an A04 PASS then says nothing about cracks, and A01 must gain a watertightness check before P3 exit.
  - **It amends A01.** A01 is defined in the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b) as "Valid mesh/index/range structure, deterministic failure isolation and bounded adversarial work". Today's mesh-validity oracle accepts T-junction contact: M03 in the [P3.1b mesh-oracle review](../evidence/p3.1b-mesh-oracle-review-2026-09-29.md). Option (b) therefore adds a watertightness-under-f32 check to A01. That is an acceptance-criterion change owned by the P3 plan, and it needs the user's approval with this answer. The practical remedy for that check is option (c).
  - **What A04 is measured on under (b).** A04 is defined on the crack-closed drawn region `M_gpu,closed`: `M_gpu` with every T-junction crack filled. Equivalently, each T-vertex is placed on the mapped segment `[a_gpu, b_gpu]` of the edge it touches, at its exact parameter `λ` from `M*`, so that `t* = (1 − λ)·a* + λ·b*`. Then `E(M_gpu,closed, M*) ≤ β_c` still holds:
    - in `M_gpu,closed`, each T-vertex lies on its mapped edge, so the split edges form a conforming mesh;
    - every vertex is within `β_c` of its `p*`. A placed T-vertex is too: `|(1 − λ)·a_gpu + λ·b_gpu − t*| ≤ (1 − λ)·|a_gpu − a*| + λ·|b_gpu − b*| ≤ β_c`;
    - the piecewise-affine argument of section 7.1 then applies to the split mesh.

    The crack, whose width is at most about `2β`, is reported separately and judged by A01.
- **(c)** Require the kernel to emit conforming meshes, by refinement using existing vertices as P3.1j proposed, as a rendering-track item before the A04 run. This removes the problem at its source and needs no routing decision. It is a kernel change under its own contract, with new fill revisions, the identity runs and the AL-OB5 baseline affected. It delays A04 until it lands. It can also follow (b) later as the remedy for A01.

**E3-Q11: guard band and clipping.**

A triangle with a vertex outside the clip volume is clipped, and clipping is implementation-defined (class A).

- **(a) Recommended.** Use the viewport (NDC `[−1, 1]²`) as the guard band, and model clipping as exact clipping against the four clip planes plus an f32 interpolation bound per new vertex, added to `β`. The model is checked by readback of pixel centers next to the viewport edge on E3-C6 partial-placement rows.
  - Partial and large cases become measurable.
  - It adds a model that needs its own review, and that is tested only on the browsers and adapters of the run.
  - A case whose clip bound cannot be computed, or reaches 0.25 px, is UNDECIDED.
  - **The assumption.** The GPU clips by linear interpolation along each crossing edge, at a precision no worse than f32 evaluation of that interpolation. WebGPU does not specify this, so it is an assumption.
  - **The readback's limit.** Pixel-center readback next to the viewport edge sees only whether a center is covered. It confirms the model only to pixel resolution near the edge, not to the sub-pixel `β`. A mismatch falsifies the model, but agreement does not prove it.
- **(b)** No clipping model: any case with a mapped vertex outside the viewport is UNDECIDED. This is simple and certainly sound. The large size class, E3-C6's partial placements and many medium cases at DPR 1 become UNDECIDED, so A04 stays UNVERIFIED for them until a model is written.
- **(c)** Assume a hardware guard band of stated size within which clipping is invisible. WebGPU exposes no guard-band size, so this is an assumption, not evidence.

**E3-Q12: the window `Ω`.**

The contract reads "declared transforms/zoom/DPR" over what can be seen.

- **(a) Recommended.** `Ω` is the viewport plus 2 physical px, P1's rule for visible points (E3-K3). Geometry outside it is not measured, and the triangle inequality uses `Ω ⊕ 1` px for intermediate terms. This matches the P1 precedent and the fringe's reach. Off-screen error is not measured, so class A far-offscreen geometry is measured only where it enters `Ω`.
- **(b)** The viewport only, with no guard. This is smaller, and it misses geometry within 2 px outside the viewport that still sets coverage of edge pixels.
- **(c)** The whole plane: every point of `∂R` and `∂M`. It is independent of the camera, but it measures error that never reaches a pixel. Far-offscreen class A cases would fail on invisible geometry, and the cost grows with path size.

## 12. Review and approval record

- 2026-10-22: DRAFT written for independent review.
- 2026-10-22, independent review round 1 (PR #204): **NOT READY**, with 3 blocking items. The reviewer confirmed the sources and both readings: physical pixels, and the private-contract shares left ungated. Applied in the follow-up commit:
  - **B1, T-junctions.** E3-K2 no longer assumes conformity. The oracle tests conformity and splits edges at T-vertices, PC13 and D11 are added, the bound of section 7.1 is restricted to conforming cases, and new question E3-Q10 is left for the user.
  - **B2, post-mapping stages.** `β` includes the NDC round trip, an out-of-band vertex makes a case UNDECIDED unless clipping is modelled (E3-Q11), and snapping is presented explicitly in E3-Q7.
  - **B3, `empty` and `window-empty`.** Both now check membership at one point of `Ω` (PC14).
  - **Should-fix items.**
    - S1: the `G` text is corrected, with overlap and orientation routed to A01 and blending to A08.
    - S2: the windowed triangle inequality is stated.
    - S3: the metric's discontinuity is stated in E3-Q2 and E3-R3.
    - S4: proof obligations (a) to (g) are listed with their tests in section 4.5.
    - S5: oracle work at measurement time and oracle versioning are defined.
    - S6: PC2, PC3, PC9, D5 and D8 are made precise.
    - S7: strata E3-C11 and E3-C12 are added and the ST-U3f rows are routed to A01.
    - S8: "contributes to" the third row's GPU evidence.
    - S9: the fringe exterior triangles are excluded from `M`.
    - The interpretive conditions now have approval points: `Ω` in E3-Q12, and E3-A8 in E3-Q3 (a).
  - The reviewer's question recommendations are recorded at the head of section 11.
- 2026-10-22, independent review round 2 (PR #204): **READY WITH FOLLOW-UPS**; CI passed. Applied in one follow-up commit:
  - **F1.** E3-Q10 (b) is stated as an amendment of A01 that adds a watertightness-under-f32 check. A01's text is quoted, and today's oracle accepts T-junction contact (M03). The amendment is an acceptance-criterion change owned by the P3 plan that needs the user's approval, and option (c) is its practical remedy.
  - **F2.** E3-PC13 now uses T4, whose f32 entries are exact, with f32-exact offsets, so `E = 0` holds in `M*` and the GPU can still crack. E3-D13's control is built with an annular disagreeing face.
  - **F3.** The collinearity claim for `M*` is limited to constant-x edges. T-vertices are detected on the Float64 port mesh and re-checked in `M*`.
  - **F4.** The crack-prone transforms are T1, T2, T4, T5 and T6. T3 and T7 are diagonal and are removed from that list.
  - **F5.** Section 7.1 states the assumption that shared vertices map bit-identically (`@invariant`, one helper, confirmed by readback). The fixed-function viewport precision is folded into E3-Q7's residual. E3-Q11 (a) states its clipping-precision assumption and the readback's pixel-resolution limit.
  - **F6.** Under E3-Q10 (b), A04 is defined on the crack-closed region, with the proof that `E(M_gpu,closed, M*) ≤ β_c`.
  - The round 2 ranking of Q10 to Q12 is recorded at the head of section 11.
