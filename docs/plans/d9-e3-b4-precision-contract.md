# D9 E3: B4 A04 corpus and measurement contract

Status: **APPROVED 2026-10-22 by the user** (independent review round 2 READY WITH FOLLOW-UPS, follow-ups applied). See [User decisions, 2026-10-22](#user-decisions-2026-10-22).

Status history, kept as written: DRAFT, 2026-10-22. Written for independent review and user approval. Independent review round 1 was NOT READY and round 2 READY WITH FOLLOW-UPS; the findings of both are applied ([review record](#12-review-and-approval-record)). User approval is pending. Nothing here is in force until the user approves it in chat.

This is rendering-track item E3 ([D9 rendering track](d9-rendering-track.md#status-index)), which is checkpoint B4 of [D8](p3-d8-parallel-tracks.md#two-tracks). It is full tier: it fixes how an acceptance criterion is evidenced and sets a pass rule. It is a contract only. It changes no requirement, threshold, past decision or frozen contract text. The one acceptance-criterion change, the A01 amendment of E3-Q10 (b), was approved by the user and is recorded in the P3 plan, which owns A01.

### User decisions, 2026-10-22

The user approved this contract in chat on 2026-10-22 and answered every open question (section 11):

| Question | Answer | Option text                                                                                                                                                                                 |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-Q1    | (a)    | CPU measurement with an exact shader model plus `β`, including the NDC round trip, and a GPU readback model check on the named subset in Chrome and Edge                                    |
| E3-Q2    | (a)    | `E = max(B_R, B_M, G)`, including its stated discontinuity when sub-tolerance features collapse                                                                                             |
| E3-Q3    | (a)    | Rejected cases are excluded and reported; a declared cell with no measured case is UNVERIFIED. This approves the coverage condition E3-A8                                                   |
| E3-Q4    | (a)    | Commit the generator, the manifest and `corpusSha256`; regenerate the corpus in every run                                                                                                   |
| E3-Q5    | (a)    | An UNDECIDED case keeps A04 UNVERIFIED until the oracle, never the threshold, resolves it                                                                                                   |
| E3-Q6    | (a)    | A case the oracle cannot certify fails the freeze; the generator is revised, disclosed, under a new corpus version, before any kernel run                                                   |
| E3-Q7    | (a)    | Measure the same `∂M` for fringe and region-only draws; rasterizer snapping and the viewport-transform precision are an explicit stated residual with their bounds recorded                 |
| E3-Q8    | (a)    | Measure `k = 0` everywhere and `k = 1, 2` on E3-C8                                                                                                                                          |
| E3-Q9    | (a)    | Corpus v1 of about 25,700 cases (25,752 in section 5.4)                                                                                                                                     |
| E3-Q10   | (b)    | Route watertightness and GPU T-junction cracks to A01; measure A04 on the crack-closed region `M_gpu,closed`; report crack width separately. The user explicitly approved the A01 amendment |
| E3-Q11   | (a)    | The viewport as guard band; clipping modelled as exact plane clipping plus an f32 interpolation bound, checked by readback next to the viewport edge                                        |
| E3-Q12   | (a)    | `Ω` = viewport plus 2 physical px                                                                                                                                                           |

**The A01 amendment.** It is recorded in the A01 row of the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b), which owns it, with a dated note superseding M03's acceptance of T-junction contact for f32 watertightness. Conforming refinement (E3-Q10 (c)) is a rendering-track candidate item as the remedy for A01 watertightness.

**Effect.** This contract is in force as approved. Any change needs a dated amendment and the user's approval. The next step is unit E3-U1 (generator, manifest and the corpus freeze path), followed by E3-U2 and the oracle-only freeze check of section 5.5.

**Amendment.** The [E3-U1 corpus annex, 2026-10-22](#13-e3-u1-corpus-annex-2026-10-22) (section 13) is ACCEPTED, by the Primary under the user's standing instruction of 2026-10-22, after independent review. It makes section 5 executable and changes no criterion, threshold or user decision. This paragraph was "Amendment in review … is a DRAFT" until then.

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
- 2026-10-22: **APPROVED by the user** in chat, with the answers of [User decisions, 2026-10-22](#user-decisions-2026-10-22), including explicit approval of the A01 amendment (E3-Q10 (b)).

## 13. E3-U1 corpus annex, 2026-10-22

Status: **ACCEPTED 2026-10-22 by the Primary under the user's standing instruction of 2026-10-22** (independent review round 2 READY WITH FOLLOW-UPS, follow-ups applied). See [section 13.10](#1310-annex-review-record).

Status history, kept as written: DRAFT, 2026-10-22, for independent review. Under the user's standing instruction of 2026-10-22 (take the recommended option without asking), every choice below picks the recommended option, and the Primary records the annex as accepted after the independent review. This annex makes section 5 executable for unit E3-U1. It changes no criterion, threshold or user decision. Where section 5 named a family, a count or a construction that cannot be executed as written, the annex says so and gives the executable form. Section 5's text above is unchanged; where the two differ, this section governs.

### 13.1 Decisions taken under the standing instruction

Each line below is decided under the user's standing instruction of 2026-10-22 (recommended option). It gives the alternatives and the reason in one line.

| ID     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                | Alternatives and reason                                                                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-N1  | C7 bucket edge: `L = s·I` with `s = RD(2^(−3−e₀) / (d·z))`, rounded toward zero to binary64 (section 13.6)                                                                                                                                                                                                                                                                                                                              | Exact edges only at attainable pairs, or nearest-representable `s`. RN can land above the edge and move the case to bucket `e₀ − 1`, so RD keeps the most edge coverage                                   |
| E3-N2  | Named counts are restated from the enumeration: C5 has 79 rows, not 60; every other named stratum keeps its count. The C5 list is a superset of section 5.2's, adding ST-F24 and ST-U4/tip-ratio                                                                                                                                                                                                                                        | Trim C5 to 60. That would drop fixtures that section 5.2 names, so the count follows the list                                                                                                             |
| E3-N3  | The depth-positive star and zero-closure rows move from C1 to C3                                                                                                                                                                                                                                                                                                                                                                        | Keep them in C1. They contain a cubic arch, and C1 is lines only                                                                                                                                          |
| E3-N4  | C7 takes its stroke rows from C9, not C5                                                                                                                                                                                                                                                                                                                                                                                                | Use lines from C5. C5 has no curve, and C7 needs curved rows                                                                                                                                              |
| E3-N5  | ST-U3f gives 3 geometry rows: `chev-1.40625`, `rev-4/3-3-1` and `rev-4/3-1-7`                                                                                                                                                                                                                                                                                                                                                           | Six rows. The "five `λ = 4/3` turns" are two geometries at several `e`, and `e` comes from the camera here                                                                                                |
| E3-N6  | ST-F16 and ST-F16p are one row                                                                                                                                                                                                                                                                                                                                                                                                          | Two rows. They share the curve and width and differ only in `e`, which the camera sets                                                                                                                    |
| E3-N7  | Gaps in C4 are physical, as section 5.2 says: per case, `g_local = g · 2^(−m)`, where `m = ⌊log2(κ·abs(det S)·norm(t)/norm(S·t))⌋` along the row's own gap normal (tangent `t`, factor `κ`) is decided exactly by comparing squares. This is exact and gives a physical gap in `[g, 2g)` on all eight transforms. The realized gap interval is recorded per case (review round 1, S1; round 2, F1)                                      | Local gaps, or `m = ⌊log2 sigmaMax(S)⌋`. A local `2^-3` gap is 24 px at zoom 64 and DPR 3, so the near-coincidence is lost. With `sigmaMax`, the gap across an anisotropic T's short axis falls below `g` |
| E3-N8  | Seeds: C1 `1`, C2 `0x12345678`, C3 `0x9e3779b9`, and C5 then C9 on `0xdeadbeef` as one stream                                                                                                                                                                                                                                                                                                                                           | A fifth seed. Only four `P2_CORPUS_SEEDS` exist, and one shared stream keeps C5 and C9 reproducible                                                                                                       |
| E3-N9  | Generated shapes use no trigonometry; sizes scale by exact powers of two; widths are powers of two divided by `d·z`                                                                                                                                                                                                                                                                                                                     | Trig and `Math.pow`. They are not specified as correctly rounded, so `corpusSha256` could differ across engines                                                                                           |
| E3-N10 | Every irrational-derived constant enters the generator as a hex literal table. Its value is the correctly rounded (RN) value of the exact function at the stated binary64 argument. The test re-derives it with exact BigInt arithmetic (series with an error bound, rounded only when the interval is clear of a rounding boundary) and bit-compares against the stored hex. No math library is used at test time (review round 1, S2) | Compute at generation, or re-derive with `Math.*` in the test. Both are engine-dependent                                                                                                                  |
| E3-N11 | Camera: centered on the binary64 control-point bounding box, not expanded for stroke width, snapped to the `2^-8` document-unit grid                                                                                                                                                                                                                                                                                                    | An expanded or exact region box. The camera needs only a deterministic anchor, and a symmetric expansion does not move the center                                                                         |
| E3-N12 | The total becomes **27,462 cases**, +1,710 (+6.6%) over section 5.4's "about 25,800" (25,752)                                                                                                                                                                                                                                                                                                                                           | Trim to 25,752. The full list stays within 10% of Q9 (a)'s "about 25.7k", so it is kept                                                                                                                   |
| E3-N13 | Generic scalars (C2, C3, C5 and C9 points, and generic translations) have a full 53-bit significand from two draws: `u53 = (hi·2^21 + (lo >>> 11)) / 2^53`, then an exact power-of-two affine map (review round 1, B1)                                                                                                                                                                                                                  | One 32-bit draw. That yields only about 31-bit dyadics, which are not generic binary64 coordinates and so narrow A04's generic strata                                                                     |
| E3-N14 | Partial placement (E3-C6) first rescales the row by an exact power of two into the large class (`b = 12`), so its realized extent exceeds `Ω`, and asserts it (review round 1, B2)                                                                                                                                                                                                                                                      | Place rows at their own size. Small rows would then lie wholly inside `Ω` and not be partial at all, which narrows E3-C6                                                                                  |

### 13.2 Case schema

One JSON object per case. Keys are sorted at every level, with no whitespace and LF line ends (section 5.1). Every binary64 value is its 16-digit lower-case hex bit pattern, written `h(x)` here. Integers are JSON integers.

| Key            | Value                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `camera`       | `{"c": [h(cx), h(cy)], "dpr": h(d), "zoom": h(z)}`. `c` is the world point at the surface origin (P1 frame)                                                                                                                                                                  |
| `corpus`       | `"a04-corpus/v1"`                                                                                                                                                                                                                                                            |
| `duplicateOf`  | `null`, or for an E3-C7 case at an attainable pair (`s = 1`), the `id` of the T0 named case it repeats (section 13.6)                                                                                                                                                        |
| `gap`          | `null`, or for an E3-C4 case with `g > 0`: `{"local": h(g_local), "m": m, "phys": [h(lo), h(hi)], "target": h(g)}`, where `[lo, hi]` is an outward-rounded binary64 enclosure of the realized physical gap `κ·g_local·abs(det S)·norm(t)/norm(S·t)`, which lies in `[g, 2g)` |
| `id`           | `"<stratum>/<row>/<transform>/z<zoom>-d<dpr>/<placement>/k<offset>"`, for example `"C1/s04-I/T2/z0.01-d3/center/k0"`. A generated row is `g` and a four-digit draw index, for example `g0123`                                                                                |
| `index`        | Global position in generation order, from 0                                                                                                                                                                                                                                  |
| `joint`        | `null`, or `{"group": "<page node id>", "role": "fill" \| "stroke"}` for SB-10 and SB-11 rows                                                                                                                                                                                |
| `opacity`      | `h(1)`; SB-11 rows `h(0.5)`                                                                                                                                                                                                                                                  |
| `paint`        | Fill: `{"kind": "fill", "rule": "nonzero" \| "evenodd"}`. Stroke: `{"cap": …, "join": …, "kind": "stroke", "miterLimit": h(L), "width": h(w)}`                                                                                                                               |
| `partial`      | `null`, or for a partial placement: `{"extent": h(E), "scaleExponent": k}`, where `E` is the realized physical extent after the exact rescaling by `2^k` (section 13.7)                                                                                                      |
| `path`         | `{"points": [h(x0), h(y0), …], "verbs": "ML…Z"}`. Verbs `M`, `L`, `C`, `Z`. `M` and `L` take one point, `C` three and `Z` none                                                                                                                                               |
| `placement`    | `"center"`, `"partial"`, `"far"` or `"pan"` (section 13.7)                                                                                                                                                                                                                   |
| `row`          | The row id from the tables below, with the grid suffix `-I` or `-Q` for C1, or `g<draw>`                                                                                                                                                                                     |
| `servedOffset` | `0`; `1` or `2` in E3-C8 only                                                                                                                                                                                                                                                |
| `sizeClass`    | `null` for named rows; `"sub"`, `"small"`, `"medium"` or `"large"` for generated rows                                                                                                                                                                                        |
| `source`       | The source id (fixture, page node or test) of a named row; `"generated:<seed hex>:<draw>"` for a generated row                                                                                                                                                               |
| `stratum`      | `"C1"` to `"C12"`                                                                                                                                                                                                                                                            |
| `transform`    | `"T0"` to `"T7"`, or `"edge"` (E3-C7)                                                                                                                                                                                                                                        |
| `viewport`     | `[640, 360]`, CSS px                                                                                                                                                                                                                                                         |
| `world`        | `{"l": [h(a), h(b), h(c), h(d)], "t": [h(tx), h(ty)]}` with `L = [[a, b], [c, d]]`, which maps `(x, y)` to `(a·x + b·y, c·x + d·y)`                                                                                                                                          |

**Generation order.**

1. Strata C1, C2, C3, C4, C5, C9, C10, C11, C12, C6, C7, C8.
2. Within a stratum: named rows in table order, then generated rows in draw order.
3. Within a row: transforms T0 to T7 (or the stratum's subset), then the nine pairs, zoom outer (0.01, 1, 64) and DPR inner (1, 2, 3).
4. E3-C6 iterates row, placement (partial, far, pan), pair. E3-C8 iterates row, offset (1, 2), pair.

A named row has placement `center`, offset 0 and `t = (0, 0)` unless its table says otherwise.

### 13.3 Transforms

The entries of `world.l`, frozen as hex, not computed at generation:

| ID  | `a`                | `b`                | `c`                | `d`                |
| --- | ------------------ | ------------------ | ------------------ | ------------------ |
| T0  | `3ff0000000000000` | `0000000000000000` | `0000000000000000` | `3ff0000000000000` |
| T1  | `3febb67ae8584cab` | `bfdfffffffffffff` | `3fdfffffffffffff` | `3febb67ae8584cab` |
| T2  | `3fe97c4efd13afa3` | `bfe35a03c56a1eee` | `3fe35a03c56a1eee` | `3fe97c4efd13afa3` |
| T3  | `4004000000000000` | `0000000000000000` | `0000000000000000` | `3fd8000000000000` |
| T4  | `3ff0000000000000` | `3fe0000000000000` | `0000000000000000` | `3ff0000000000000` |
| T5  | `bfe97c4efd13afa3` | `3fe35a03c56a1eee` | `3fe35a03c56a1eee` | `3fe97c4efd13afa3` |
| T6  | `3fffdb62bc589b8c` | `3fe899a15250cff3` | `3ff83084b6c4a6aa` | `3ff0df912ad60444` |
| T7  | `3ff0000000000000` | `0000000000000000` | `0000000000000000` | `3f30000000000000` |

- **T1** entries are exactly `RN(cos(x))` and `RN(sin(x))` at the binary64 argument `x = Math.PI/6 = 0.5235987755982988`, which equals `30·Math.PI/180`.
  - `x` is not `RN(π/6)`.
  - The sine is `0.49999999999999994`: this is the intended "exact-looking rotation with inexact entries".
  - These are also the values V8 returns, kept as the realistic host input.
- **T2** entries are exactly `RN(cos(x))` and `RN(sin(x))` at `x = 37.21·Math.PI/180 = 0.64943701466709`, evaluated left to right. These too equal V8's values.
- **How these were checked.** Both identities were checked on 2026-10-22 with a 200-bit BigInt series evaluation, and E3-U1's exact test repeats the check (E3-N10).
- **T5** is `diag(−1, 1)·T2`, exact.
- **T6** is the binary64 product `(T2·T3)·T4`, evaluated left to right.
- **Width exponent.** `ℓ_T` of section 13.5 is 1 for T3 and T6, and 0 for the others.

Zoom is binary64 `0.01` (`3f847ae147ae147b`), `1` or `64`; DPR is `1`, `2` or `3`.

### 13.4 Named rows

**Conventions for all named-row tables.**

- **Units and stroke defaults.** Coordinates are local units. A stroke row gives `w`, cap, join and miter limit `L`; the defaults are butt, miter, `L = 4`.
- **Coverage.** Every named row runs at T0 to T7 and the nine pairs (72 cases). The exceptions are E3-C10 (T0, pair (1, 1)) and E3-C12 (T2 and T6).
- **KAPPA.** `KAPPA = 0.5522847498307936` (`3fe1ac5111534a23`).
- **Page helpers.** `circle(cx, cy, r)` and `chevron(h, len, apexY)` are the helpers of `apps/playground/src/p3-b2-strokes-scene.ts`, copied by value. `circle` needs only binary64 basic operations and is evaluated at generation. `chevron` needs sine and cosine, so its vertices come from a hex table (E3-N10).
- **Orientation.** "Reversed" means the point order is reversed (a clockwise contour).
- **Order within a table line.** When one line expands to several rows, the rows are numbered in the order the factors are listed, with the first factor outermost. In C1 the grid is innermost: `s01-I`, `s01-Q`, `s02-I` and so on.

**E3-C1, fill, lines, snapped: 40 rows.** Grid `I` uses the listed integers. Grid `Q` adds `(37/256, 91/256)` to every point. The rule is nonzero unless the row names one.

| Rows    | Shape                                                                                                                                                                               | Grids | Count |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----: |
| s01     | Rectangle `(0,0) (16,0) (16,8) (0,8)`                                                                                                                                               | I, Q  |     2 |
| s02     | Triangle `(0,0) (16,0) (4,12)`                                                                                                                                                      | I, Q  |     2 |
| s03     | Concave L `(0,0) (16,0) (16,4) (4,4) (4,12) (0,12)`                                                                                                                                 | I, Q  |     2 |
| s04–s05 | Pentagram `(0,−10) (6,8) (−10,−3) (10,−3) (−6,8)`; s04 nonzero, s05 evenodd                                                                                                         | I, Q  |     4 |
| s06–s07 | Nested squares of side 24, 16 and 8 at the origin: counter-clockwise, reversed, counter-clockwise; s06 nonzero, s07 evenodd                                                         | I, Q  |     4 |
| s08     | Square of side 16 with a reversed square hole of side 8, both centered                                                                                                              | I, Q  |     2 |
| s09     | Collinear same-direction overlap: rectangles `(0,0)–(16,8)` and `(8,0)–(24,6)`, both counter-clockwise                                                                              | I, Q  |     2 |
| s10     | Coincident opposite edges: rectangles `(0,0)–(16,8)` and `(16,0)–(32,8)`, both counter-clockwise                                                                                    | I, Q  |     2 |
| s11     | Rectangle `(0,0)–(16,8)` plus the zero-area contour `(20,0) (28,0) (20,0)`                                                                                                          | I, Q  |     2 |
| s12     | Pinch figure-eight `(0,0) (8,8) (16,0) (16,16) (8,8) (0,16)`                                                                                                                        | I, Q  |     2 |
| s13     | Comb `(0,0) (32,0) (32,16) (28,16) (28,4) (24,4) (24,16) (20,16) (20,4) (16,4) (16,16) (12,16) (12,4) (8,4) (8,16) (4,16) (4,4) (0,4)`                                              | I, Q  |     2 |
| s14     | Rectangle with a collinear mid-edge vertex `(0,0) (8,0) (16,0) (16,8) (0,8)`                                                                                                        | I, Q  |     2 |
| s15–s16 | Winding 2: counter-clockwise squares `(0,0)–(16,16)` and `(8,8)–(24,24)`; s15 nonzero, s16 evenodd                                                                                  | I     |     2 |
| s17–s20 | Needle `(0,0) (A,0) (0,1)`, `A = 10^3, 10^4, 10^5, 10^6`                                                                                                                            | I     |     4 |
| s21–s26 | T03 analogs at scale 1, as in `tests/geometry/extent-t01/synthetic.ts`: `TRI` `(−64,0) (2^k,0) (−64,64)` and `RECT` `(−64,0) (2^k,0) (2^k,2^(k−2)) (−64,2^(k−2))`, `k = 24, 32, 40` | I     |     6 |

A rectangle `(x0,y0)–(x1,y1)` is `(x0,y0) (x1,y0) (x1,y1) (x0,y1)`.

**E3-C3, fill, cubics: 30 rows.** The rule is nonzero unless the row names one.

| Rows    | Shape                                                                                                                                                                                                                                                                                                                                                                                                                   | Count |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| c01     | `circle(0, 0, 8)`                                                                                                                                                                                                                                                                                                                                                                                                       |     1 |
| c02     | Ellipse: every point of `circle(0, 0, 1)` multiplied by `(12, 4)`                                                                                                                                                                                                                                                                                                                                                       |     1 |
| c03     | Closed S `M(0,0) C(4,8)(8,−8)(12,0) L(12,−6) C(8,−14)(4,2)(0,−6) Z`                                                                                                                                                                                                                                                                                                                                                     |     1 |
| c04–c05 | Self-intersecting loop `M(0,0) C(12,12)(−4,12)(8,0) Z`; nonzero, evenodd                                                                                                                                                                                                                                                                                                                                                |     2 |
| c06     | Exact cusp `M(0,0) C(8,8)(0,8)(8,0) Z`                                                                                                                                                                                                                                                                                                                                                                                  |     1 |
| c07–c09 | Near-cusps: c06 with the second control's `x` set to `2^-10`, `2^-20` and `2^-40`                                                                                                                                                                                                                                                                                                                                       |     3 |
| c10     | Inflection `M(0,0) C(4,8)(8,−8)(12,0) L(12,−4) L(0,−4) Z`                                                                                                                                                                                                                                                                                                                                                               |     1 |
| c11–c12 | Crossing ellipses: c02 plus `circle(0, 0, 1)` multiplied by `(4, 12)`, both counter-clockwise; nonzero, evenodd                                                                                                                                                                                                                                                                                                         |     2 |
| c13     | `circle(0, 0, 12)` with the reversed holes `circle(−5, 0, 3)` and `circle(5, 0, 3)`                                                                                                                                                                                                                                                                                                                                     |     1 |
| c14–c19 | AL-OB5 rings: path 0 of OB5-W2, OB5-W4 and OB5-W8, then of W2U, W4U and W8U, from `generateCellPaths` in `tests/geometry/p3-b0/corpus.ts`. The cell specs come from `ob5Cell` in `tests/geometry/p3-al-ob5/corpus.ts`; W8U is that module's own observation spec (its `ob5ObservationCells`, line 48). **W2U and W4U are derived**: `ob5Cell` with `snapped: false` at `λ = 2` and `λ = 4`, cells AL-OB5 did not define |     6 |
| c20–c23 | `depth-positive/star` and `depth-positive/zero-closure` from `tests/geometry/native-depth-positive-cubic/fixtures.ts`; nonzero, evenodd (moved from C1, E3-N3)                                                                                                                                                                                                                                                          |     4 |
| c24     | Quarter wedge `M(0,0) L(8,0) C(8,8·KAPPA)(8·KAPPA,8)(0,8) Z`                                                                                                                                                                                                                                                                                                                                                            |     1 |
| c25     | Degenerate cubic `M(0,0) C(0,0)(8,8)(8,8) L(0,8) Z`                                                                                                                                                                                                                                                                                                                                                                     |     1 |
| c26     | D-shape `M(0,0) L(0,16) C(12,16)(12,0)(0,0) Z`                                                                                                                                                                                                                                                                                                                                                                          |     1 |
| c27     | `circle(0, 0, 4096)`                                                                                                                                                                                                                                                                                                                                                                                                    |     1 |
| c28–c29 | Concentric `circle` radii 12, 8 reversed, and 4; nonzero, evenodd                                                                                                                                                                                                                                                                                                                                                       |     2 |
| c30     | Double cusp `M(0,0) C(8,8)(0,8)(8,0) C(16,8)(8,8)(16,0) L(16,−4) L(0,−4) Z`                                                                                                                                                                                                                                                                                                                                             |     1 |

c14–c23 are copied as hex literals. A unit test checks them against `generateCellPaths` and against the fixture module.

**E3-C4, near-coincidence, fill: 24 rows.**

- **Gaps.** The target gap `g ∈ {2^-3, 2^-8, 2^-16}` is in physical px. In the shapes below, `g` stands for the per-case local gap `g_local = g · 2^(−m)` (E3-N7, revised by review round 2, F1).
- **Exponent `m`.** `m` is chosen along the row's own gap normal: `m = ⌊log2(κ · |det S| · |t| / |S·t|)⌋`. Here `t` is the row's gap tangent (the direction of the facing edges at the gap), and `κ` is the row's local normal-gap factor (`√2` for n05–n08, else 1).
  - **Decided exactly.** `m` is decided by comparing the squares `κ²·(det S)²·|t|²` and `4^m·|S·t|²` in exact rationals.
  - **Why this works.** A local normal gap `κ·g_local` between lines with tangent `t` maps to the physical normal gap `κ·g_local·|det S|·|t|/|S·t|`. So every C4 row realizes a physical gap in `[g, 2g)` at its gap, on all eight transforms.
  - **Curved rows.** For n09–n14 this is the gap along the contact normal at the contact points, an upper bound on the minimum distance between the curves.
- **Touching.** `g = 0` is exact touching, with no rescaling.
- **Per-case geometry.** The row's geometry is therefore per case. The id is unchanged. The case carries `g_local` and the realized physical-gap interval (section 13.2, key `gap`).

| Rows    | Shape                                                                                                        | Tangent `t` | `κ` | Gaps    | Count |
| ------- | ------------------------------------------------------------------------------------------------------------ | ----------- | --- | ------- | ----: |
| n01–n04 | Facing rectangles `(0,0)–(16,8)` and `(0,8+g)–(16,16+g)`                                                     | `(1, 0)`    | 1   | 3 and 0 |     4 |
| n05–n08 | Oblique facing triangles `(0,0) (16,0) (0,16)` and `(16+g,g) (16+g,16+g) (g,16+g)`; the normal gap is `g·√2` | `(1, −1)`   | √2  | 3 and 0 |     4 |
| n09–n11 | `circle(0, 8+g, 8)` over the rectangle `(−16,−8)–(16,0)`                                                     | `(1, 0)`    | 1   | 3       |     3 |
| n12–n14 | `circle(0, 0, 8)` and `circle(16+g, 0, 8)`                                                                   | `(0, 1)`    | 1   | 3       |     3 |
| n15–n17 | Overlap strip: rectangles `(0,0)–(16,8)` and `(0,8−g)–(16,16)`                                               | `(1, 0)`    | 1   | 3       |     3 |
| n18–n20 | Thin wall: square `(0,0)–(16,16)` with the reversed hole `(g,4)–(12,12)`                                     | `(0, 1)`    | 1   | 3       |     3 |
| n21–n23 | Thin hole: square `(0,0)–(16,16)` with the reversed hole `(4,4)–(4+g,12)`                                    | `(0, 1)`    | 1   | 3       |     3 |
| n24     | Apex contact: triangles `(0,0) (16,0) (8,8)` and `(16,16) (0,16) (8,8)`                                      | —           | —   | 0       |     1 |

**E3-C5, stroke, lines: 79 rows (E3-N2).** `ZIGZAG` is the page's `(−50,22) (−18,−22) (14,22) (46,−22)`.

| Rows    | Source                                                                                                                                                                                                                                                                                                                                               | Count |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| l01–l03 | ST-F1 (butt), ST-F2 (square), ST-F3 (round)                                                                                                                                                                                                                                                                                                          |     3 |
| l04–l06 | ST-F4: miter `L = 2`, bevel, round                                                                                                                                                                                                                                                                                                                   |     3 |
| l07     | ST-F5: miter `L = 1.25`                                                                                                                                                                                                                                                                                                                              |     1 |
| l08–l10 | ST-F6: miter `L = 4`, bevel, round                                                                                                                                                                                                                                                                                                                   |     3 |
| l11–l12 | ST-F7 and ST-F9, butt (expected `empty`)                                                                                                                                                                                                                                                                                                             |     2 |
| l13–l15 | ST-F8: butt, round, square                                                                                                                                                                                                                                                                                                                           |     3 |
| l16–l18 | ST-F10 (miter `L = 2`), ST-F11 (miter `L = 2`), ST-F12 (bevel)                                                                                                                                                                                                                                                                                       |     3 |
| l19–l20 | ST-F13 and ST-F13x (miter `L = 4`)                                                                                                                                                                                                                                                                                                                   |     2 |
| l21–l22 | ST-F14 (a) and (b)                                                                                                                                                                                                                                                                                                                                   |     2 |
| l23     | ST-F21                                                                                                                                                                                                                                                                                                                                               |     1 |
| l24–l25 | ST-F24 with `L = 2^30` and with `L = 4`                                                                                                                                                                                                                                                                                                              |     2 |
| l26–l37 | ST-F25: three turns × miter `L ∈ {1, Math.SQRT2 (3ff6a09e667f3bcd), 4, 100}`, `w = 2`                                                                                                                                                                                                                                                                |    12 |
| l38     | ST-U4/tip-ratio                                                                                                                                                                                                                                                                                                                                      |     1 |
| l39–l44 | SB-1: `ZIGZAG`, `w ∈ {2^-6, 2^-2, 1}` × (butt, miter) and (round, round)                                                                                                                                                                                                                                                                             |     6 |
| l45–l53 | SB-3: `chevron(h, 60, −30)`, `h ∈ {6, 3, 1}°` × `L ∈ {10, 100, 1000}`, `w = 4`                                                                                                                                                                                                                                                                       |     9 |
| l54–l57 | SB-4: `chevron(h, 60, −30)`, `w = 12`: (14°, `L = 4`), (14.4775°, `L = 4`), (15°, `L = 4`), (14.4775°, `L = 1`)                                                                                                                                                                                                                                      |     4 |
| l58–l63 | SB-6: `chevron(h, 52, −26)`, `h ∈ {45, 30, 15}°` (interior angles 90, 60 and 30 degrees, so turns of 90, 120 and 150 degrees) × `w ∈ {4, 12}`, round join                                                                                                                                                                                            |     6 |
| l64–l69 | SB-7 caps: `ZIGZAG` × cap `{round, square}` × `w ∈ {0.25, 1, 14}`                                                                                                                                                                                                                                                                                    |     6 |
| l70–l75 | SB-7 dots: `M(0,0) L(0,0)` × cap `{round, square}` × `w ∈ {0.25, 1, 14}`                                                                                                                                                                                                                                                                             |     6 |
| l76     | SB-13: ST-F26 `edges-1024`: 64 subpaths `M(0, 4i) L(4, 4i)`, `i = 0` to 63, `w = 2`, square caps, miter `L = 4`                                                                                                                                                                                                                                      |     1 |
| l77–l79 | ST-U3f: `chev-1.40625`, `M(−4.401143883191439, 1051.9843385722027) L(−3.125, 1000) L(−1.848856116808561, 1051.9843385722027)`, `w = 12`, round caps, round join; `rev-4/3-3-1`, `M(0,0) L(3,1) L(−1, −0.33333333333333326)`, and `rev-4/3-1-7`, `M(0,0) L(1,7) L(−0.33333333333333326, −2.333333333333332)`, each `w = 12`, butt, round join (E3-N5) |     3 |

**Not in C5, and why.**

- ST-F15 is covered by C9's R1 to R6.
- ST-F16 to ST-F20 are in C9.
- ST-F22, ST-F23 and the other ST-F26 rows are left out. They test numeric guards and work caps, which belong to A01, not precision.

l24 (`L = 2^30`) and l77–l79 are expected to be rejected, so they are evidence for A01 (section 6).

**Source checks for C5 (review round 1, S3).**

- **TypeScript fixtures.** A unit test compares every C5 row whose source is an ST-F id present in `tests/geometry/stroke-oracle/fixtures.ts` (ST-F1 to ST-F6, ST-F8, ST-F10, ST-F12 to ST-F14, ST-F21 and ST-F24) against that module's source path and stroke parameters.
- **Rust literals.** The literals of l76 to l79 are copied from `packages/geometry-wasm/kernel/src/stroke_outline_tests.rs` at `5c691ad`, the file's last change. The generator records each source span's SHA-256, over its LF-terminated lines in the immutable `5c691ad` blob (`git show 5c691ad:<path>`). The test hashes the spans from that blob, so it cannot fail when the file later changes:

| Rows    | Lines at `5c691ad`                                                                                                           | SHA-256                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| l76     | 728–739                                                                                                                      | `d69b3811ec71f4d5e82fbc5788b11a872cd0b89ddd5bc6cd7c4f1eafe2bb8fdc` |
| l78–l79 | 1752–1776 (`st_u3e_review_near_reversals_are_turns`)                                                                         | `26fb12cd9d5c027f22d05dbb09eabe8051642b7e15da03bcaf8ac65a12471dde` |
| l77     | 1890–1901 (path and request `w = 12`, round caps, round join, of `st_u3f_chev_1_40625_is_a_known_topology_ambiguous_defect`) | `97844117e971f7683235531d54617d67d74079e31873ee14f68ad1ded9673dd8` |

**Drift against HEAD.** A second, non-failing check locates each span in HEAD by its function name (and by the `"edges-1024"` case for l76) and reports any textual difference. The manual freeze step (section 5.5) reads that report. The literal in the generator stays authoritative and is never silently re-copied.

**E3-C9, stroke cubics and joint paints: 30 rows.**

| Rows    | Source                                                                                                                           | Count |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ----: |
| k01–k06 | R1 to R6 of `STROKE_S2_FAMILIES` in `stroke-region.ts`, at their widths, butt                                                    |     6 |
| k07     | ST-F16's curve, `w = 0.125`, butt; this row is ST-F16p too (E3-N6)                                                               |     1 |
| k08–k09 | ST-U4/cusp-shared-a (`w = 1`, butt) and cusp-shared-b (`w = 0.25`, round), from the P3 plan's ST-U4 cusp section                 |     2 |
| k10–k18 | ST-F20: the inputs of ST-F18, ST-F17 and ST-F19 at `w = 2`, each × cap `{butt, round, square}`                                   |     9 |
| k19     | ST-U4/folded-arc (stroke contract section 11.3)                                                                                  |     1 |
| k20     | SB-5: page node `wide-cubic`, `w = 24`, round caps and joins                                                                     |     1 |
| k21     | SB-5: R5's controls at `w = 8`, round caps and joins (a width above the curvature radius)                                        |     1 |
| k22     | Self-overlapping stroke `M(0,0) C(12,12)(−4,12)(8,0)`, `w = 2`, round caps and joins                                             |     1 |
| k23–k26 | SB-10: page nodes `fill-stroke-square` and `fill-stroke-circle`, a fill row and a stroke row each, opacity 1                     |     4 |
| k27–k30 | SB-11: `fill-only-half` (fill), `stroke-only-half` (stroke), `both-half` (fill and stroke), opacity 0.5; joint group `both-half` |     4 |

SB-10's stroke alpha does not change geometry, so A04 does not vary it. The joint-feature identity check of E3-K2 runs on group `both-half`.

**E3-C10, controls: 12 rows**, at T0 and pair (1, 1).

| Row | Content                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------- |
| x01 | s01-I with the singular `L = [1, 2, 2, 4]`                                                                                   |
| x02 | s01-I with `L = 0`                                                                                                           |
| x03 | An empty fill path (no verbs)                                                                                                |
| x04 | The MOVE-only fill path `M(4,5)`                                                                                             |
| x05 | ST-F1 with `w = 0`                                                                                                           |
| x06 | s01-I: the base of E3-PC2 and of the PC10 rectangle                                                                          |
| x07 | `circle(0, 0, 8)`: the base of E3-PC3 and of the PC10 `n`-gon                                                                |
| x08 | The dyadic polygon `(0,0) (16,0) (12,8) (4,8)`: the base of the PC10 translated polygon                                      |
| x09 | Three nested contours: a square of side 16, a reversed hole of side 8 and an island of side 4: the base of E3-PC4 and E3-D13 |
| x10 | s04-I: the base of E3-PC5                                                                                                    |
| x11 | Thin ring: a square of side 16 with a centered reversed hole 0.4 wide and 8 tall: the base of E3-PC6                         |
| x12 | s01-I with `t = (2^24, −2^24)`, placement `far`: the base of E3-PC7 and E3-PC8                                               |

**E3-C11, region-only: 8 rows**, at T0 to T7 and the nine pairs.

| Row | Content                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------ |
| f01 | A 200-gon with vertices `(round(1024·cos(2πi/200)), round(1024·sin(2πi/200)))`, from a hex table       |
| f02 | OB5-W8 path 1, by value                                                                                |
| f03 | Star field: s04-I translated to a 4 × 4 grid with spacing 24, nonzero                                  |
| f04 | Staircase: `(0,0)`, then `(i+1, i)` and `(i+1, i+1)` for `i = 0` to 159, then `(0,160)`; 322 vertices  |
| f05 | Four sectors at one vertex: triangles `(0,0) R(8,−2) R(8,2)` for the four exact quarter turns `R`      |
| f06 | Five sectors: as f05, with the far vertices at multiples of 72°, rounded to integers, from a hex table |
| f07 | Two squares touching at one corner: `(0,0)–(8,8)` and `(8,8)–(16,16)`                                  |
| f08 | Six sectors: as f06, with multiples of 60°                                                             |

f01 to f04 are built to reach `fringe-work-cap`, and f05 to f08 to reach `fringe-unsupported`. The status observed in the run is recorded, and no expected status is gated. A row that draws with a fringe anyway is still measured.

**E3-C12, T-junction-heavy: 8 rows**, at T2 and T6 and the nine pairs. Decimal literals are parsed as binary64 by JS.

| Row | Content                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------ |
| j01 | Square `(0,0)–(16,16)` with the reversed hole `(5.3,4.7)–(11.1,12.9)`                                  |
| j02 | Square `(0,0)–(32,32)` with four reversed holes of side 6 at `(5,5)`, `(21,5)`, `(5,21)` and `(21,21)` |
| j03 | s13-I with the reversed hole `(1.3,1.1)–(30.7,2.9)`                                                    |
| j04 | s04-I with a reversed square hole of side 2 at `(−1.1,−0.7)`                                           |
| j05 | A 32-gon ring with radii 16 and 9.7, from a hex table, the inner contour reversed                      |
| j06 | `circle(0, 0, 12)` with the reversed hole `circle(0.3, −0.2, 5)`                                       |
| j07 | s06-I with every point offset by `(0.137, 0.291)`                                                      |
| j08 | s03-I scaled by 2, with the reversed holes `(1.1,1.3)–(6.9,6.7)` and `(1.2,13.1)–(6.8,22.7)`           |

**E3-C6 rows**, 12, at T0:

- C1: s01-I, s04-I, s08-I and s18-I (needle `10^4`);
- C3: c01, c02, c16 (OB5-W8) and c11;
- C5: l04, l32 (ST-F25, ratio 5/3, `L = 4`), l44 (SB-1, `w = 1`, round) and l66 (SB-7, round cap, `w = 14`).

**E3-C7 rows**, 12:

- C3: c01, c02, c03, c04, c06, c08, c14 and c16;
- C9: k03 (R3), k05 (R5), k07 (ST-F16) and k26 (the stroke paint of `fill-stroke-circle`).

**E3-C8 rows.** The 149 named rows of C1, C3 and C5, at T0, offsets 1 and 2, and the nine pairs.

### 13.5 Generated rows

**PRNG.** The PRNG is `nextXorshift32`, copied by value from `packages/geometry-reference/src/corpus.ts`:

```text
v = state >>> 0
v = (v ^ (v << 13)) >>> 0
v = (v ^ (v >>> 17)) >>> 0
v = (v ^ (v << 5)) >>> 0
```

- **Draws.** Each draw advances the state once and gives the 32-bit `state`, and `u = state / 2^32` in `[0, 1)`. Then `int(n) = floor(u·n)`. Scalars are drawn `x` before `y`.
- **53-bit draws (E3-N13).** A 53-bit draw takes two draws, `hi` then `lo`, and gives `u53 = (hi·2^21 + (lo >>> 11)) / 2^53`, an exact binary64 in `[0, 1)` with a full 53-bit significand. Every operation is exact and engine-independent: `hi·2^21 + (lo >>> 11)` is an integer below `2^53`, and the division is by a power of two.
- **`coord`.**
  - In C1, `coord = (2u − 1)·64`, one draw, which is then snapped (below).
  - In C2, C3, C5 and C9, `coord = (2·u53 − 1)·64`, two draws per scalar. Both operations are exact, so the coordinate keeps up to 53 significant bits.
- **Seeds.** Seeds follow E3-N8. C1, C2 and C3 each have their own stream. C5's 150 rows are drawn first, and C9's 150 continue the same stream.

**Draw order per row.**

1. Family.
2. The family's parameters, in the order listed below.
3. Paint. A fill draws its rule, `int(2)`: nonzero, evenodd. A stroke draws its width exponent `int(12)`, cap `int(3)`, join `int(3)` and miter index `int(5)`.
4. Transform, `int(8)`: T0 to T7.
5. Translation kind, `int(3)`, in every stratum:
   - zero;
   - snapped: `floor((2u − 1)·1024)` per axis, one draw each;
   - generic: `(2·u53 − 1)·1024` per axis, two draws each.
6. Size class, `int(4)`: sub, small, medium, large.
7. Extent exponent `b`, drawn with `int` over the class range.

**Fill families (C1 and C2), `int(4)`.**

- **(0) Star polygon.** `n = 3 + int(10)` `coord` points, sorted by exact pseudo-angle about the origin, ties broken by distance.
- **(1) Crossing polygon.** `n = 4 + int(6)` points in draw order.
- **(2) Polygon with hole.** Family 0, plus the same points scaled by `1/4` and reversed.
- **(3) Rectangle set.** `m = 2 + int(3)` rectangles, each from two `coord` corners, counter-clockwise.

**Snapping.** C1 draws `q = 8·int(2)` after the family parameters, so `q` is 0 or 8, and snaps every coordinate `v` to `floor(v·2^q + 0.5)/2^q`. C2 keeps its 53-bit `coord` unsnapped.

**Cubic families (C3), `int(3)`.**

- **(0) Cubic ring.** `n = 2 + int(7)` anchors, sorted by pseudo-angle. Edge `a → b` gets the controls `a + (b − a)/3 + δ₁` and `a + 2(b − a)/3 + δ₂`, where each `δ` is `coord/4` per axis.
- **(1) Closed single cubic.** Four `coord` points, closed with `Z`.
- **(2) Ring with hole.** Family 0, plus its anchors and controls scaled by `1/4` and reversed.

**Stroke families.**

- **C5.** An open polyline of `2 + int(7)` points, closed when `int(10) < 3`.
- **C9.** An open chain of `1 + int(4)` cubics: a start point, then three points per cubic.

**Stroke paint.**

- **Width target.** `w_phys = 2^(−6 + int(12))` px.
- **Caps and joins.** Caps are butt, round, square. Joins are miter, round, bevel.
- **Miter limits.** `1`, `Math.SQRT2`, `4`, `10`, `100`.
- **Local width.** Per case, `w = RN(RN(w_phys / d) / z) · 2^(−ℓ_T)`, with `ℓ_T` from section 13.3.

**Size per case.**

- **Class ranges.** The ranges of `b` are: sub `[−4, 0)`, small `[0, 4)`, medium `[4, 9)` and large `[9, 13)`.
- **Current extent.** For each pair, `E_cur` is the larger side of the binary64 bounding box of `d·z·(L·x)` over the row's points. It is evaluated with binary64 basic operations, in the order `a·x + b·y`.
- **Rescaling.** The row's local coordinates are multiplied by `2^(b − ⌊log2 E_cur⌋)`, where `⌊log2⌋` is read from the binary64 exponent field. The scaling is exact, so a snapped row stays dyadic. The stroke width is set separately, by the rule above.
- **Realized extent.** It lies in `[2^b, 2^(b+1))` and is recorded as a diagnostic.

**Counts.** C1 200, C2 200, C3 300, C5 150 and C9 150 rows, each at its drawn transform and the nine pairs: 9,000 cases.

### 13.6 C7 bucket-edge construction

**Goal.** `2^e · sigmaMax(d·z·L) = 0.125` exactly with binary64 `L`, so that V3 chooses bucket `e` with its curve share used in full.

**Impossibility at five pairs (checked).** The eigenvalues of `SᵀS` are the roots of `t² − F·t + D²`, with `F = ‖S‖²_F` and `D = det S`. So `sigmaMax(S) = 2^j` requires `16^j − F·4^j + D² = 0`.

- **DPR 3.** With `S = 3z·L` and `z`, `L` dyadic, `F = 9z²‖L‖²_F` and `D² = 81z⁴(det L)²`. Scaled by a power of two to integers, the last two terms are divisible by 9 and `16^j·2^N` is not. No `L` exists.
- **Zoom 0.01.** With `z = fl(0.01) = m·2^-59` and `m = 5764607523034235`, which is odd and greater than 1, the same argument holds modulo `m²`.

The unattainable pairs are therefore `(0.01, 1)`, `(0.01, 2)`, `(0.01, 3)`, `(1, 3)` and `(64, 3)`. The attainable pairs are `(1, 1)`, `(1, 2)`, `(64, 1)` and `(64, 2)`. This agrees with the implementer's finding.

**Construction (E3-N1).**

1. `e₀` is the largest integer with `2^e₀·d·z ≤ 0.125`, decided exactly.
2. `L = s·I` with `s = RD(2^(−3−e₀) / (d·z))`, computed in BigInt rationals and rounded toward zero to binary64, so `s ∈ [1, 2)`.
3. At the attainable pairs `s` is a power of two, and the edge is exact. Elsewhere `2^e₀·sigmaMax(S)` is below 0.125 by a relative gap under `2^-52`. V3's exact predicate still chooses `e₀`, at the largest scale binary64 allows.

The record states per case whether the edge is exact. For these cases `transform` is `"edge"` and `world.l` is `s·I`.

**Where C7's value is (review round 1, S5).**

- **Attainable pairs.** At the four attainable pairs `s = 1`, so the C7 case repeats the row's T0 named case: the T0 bucket is already exactly at the edge there.
- **Unattainable pairs.** C7's added value is at the five unattainable pairs, where T0 sits strictly inside its bucket and `s > 1` moves the case to just below the edge.
- **Counts.** The repeats stay in the corpus, so the count is unchanged. The record marks them as duplicates of their T0 case.

### 13.7 Camera

- **Center** (the default). `B` is the world bounding box of `L·x + t` over the path's points, computed with binary64 basic operations. It includes control points and is not expanded for stroke width (E3-N11). Then `c = mid(B) − (320/z, 180/z)`, and each axis is snapped to `floor(c·256 + 0.5)/256`.
- **Partial** (E3-N14).
  - **Rescaling.** First the row's local coordinates are rescaled exactly by `2^(12 − ⌊log2 E_cur⌋)`, with `E_cur` as in section 13.5. This puts the realized extent in `[4096, 8192)` px, the top of the large class, above every side of `Ω`. `Ω`'s longest side is at most `640·3 + 4 = 1924` px.
  - **Placement.** Then the camera is set as for center, with `min(B)` in place of `mid(B)`, so the box's minimum corner lands at the viewport center.
  - **Assertion.** The generator asserts per case that the realized extent exceeds the longer side of `Ω`.
  - **Effect on counts.** The rescaling changes coordinates only, so the counts are unchanged.
  - **Stroke width is not rescaled** (review round 2, F3 and F4). A stroke row keeps its own width `w` under partial placement; only the path's coordinates are scaled. This changes the row's width-to-geometry ratio by `2^-k`, so a partial case is not a scaled copy of its center case: joins, caps and miter switch points meet a relatively thinner stroke. The case records `k` and the extent under `partial` (section 13.2).
- **Far.** `t` gains `(2^24, −2^24)` (`4170000000000000` and its negation), then the camera is centered.
- **Pan.** After centering and snapping, `c` gains `(2^-7, 0.3713)` (`3f80000000000000`, `3fd7c36113404ea5`), not snapped. These are the dyadic and the generic binary64 fractions of E3-K6.

### 13.8 Totals

| Part                                                                        |  Rows |      Cases |
| --------------------------------------------------------------------------- | ----: | ---------: |
| Named C1 (40), C3 (30), C4 (24), C5 (79), C9 (30), × 8 transforms × 9 pairs |   203 |     14,616 |
| E3-C10 (T0, one pair)                                                       |    12 |         12 |
| Generated C1, C2, C3, C5 and C9 (× 9 pairs)                                 | 1,000 |      9,000 |
| E3-C6 (× 3 placements × 9 pairs)                                            |    12 |        324 |
| E3-C7 (× 9 pairs)                                                           |    12 |        108 |
| E3-C8 (× 2 offsets × 9 pairs)                                               |   149 |      2,682 |
| E3-C11 (× 8 transforms × 9 pairs)                                           |     8 |        576 |
| E3-C12 (× 2 transforms × 9 pairs)                                           |     8 |        144 |
| **Total**                                                                   |       | **27,462** |

That is 1,710 cases, +6.6%, over section 5.4's 25,752. All of the increase comes from C5's restated count: 19 more rows add 1,368 cases to the named cross and 342 to C8. The total stays within ±10% of Q9 (a)'s "about 25.7k" (E3-N12).

### 13.9 What E3-U1 delivers against this annex

- **Generator.** `tests/geometry/e3-a04/corpus.ts`, implementing sections 13.2 to 13.7 mechanically.
- **Literal tables.** Hex literal tables for every irrational-derived constant: the `chevron` vertices of SB-3, SB-4 and SB-6, and f01, f06, f08 and j05, plus T1 and T2. Each has a unit test that re-derives it exactly with BigInt arithmetic and bit-compares against the stored hex, with no math library (E3-N10).
- **Manifest.** `corpus-v1.manifest.json`, with the per-stratum counts above and `corpusSha256`.
- **Tests.**
  - The regeneration test (E3-A1).
  - Literal checks of c14 to c23 against their source modules.
  - The C5 check against `tests/geometry/stroke-oracle/fixtures.ts`, and the source-span SHA-256 checks of l76 to l79.
  - The partial-placement extent assertion.
  - A check that every generic scalar was built by a 53-bit draw.
- **Out of scope.** No kernel run. The freeze check belongs to E3-U2 (section 5.5).

### 13.10 Annex review record

- **2026-10-22, independent review round 1 of `a318a3c`: NOT READY.** The arithmetic, ids, hex tables, the C7 proof and the schema were checked and confirmed. Two decisions narrowed A04, and the follow-up commit applies every item, each decided under the user's standing instruction (recommended option):
  - **B1.** Generic scalars now have full 53-bit significands (E3-N13). This changes the seed-stream consumption in section 13.5.
  - **B2.** Partial placement rescales into the large class, with an assertion (E3-N14). The counts are unchanged.
  - **S1.** C4 gaps are physical (E3-N7, revised), with the anisotropic interpretation recorded.
  - **S2.** T1 and T2 are stated as exact `RN` values at the stated binary64 arguments, and the table tests are exact (E3-N10, revised).
  - **S3.** A C5 check against the stroke-oracle fixtures, inline Rust literals with source-span SHA-256s, and c14 to c19 labelled, with W2U and W4U derived from `ob5Cell`.
  - **S4.** The SB-6 turn angles are corrected, E3-N2 notes the superset, and E3-N12 says "about 25,800".
  - **S5.** C7's attainable pairs repeat the T0 cases; its value is at the five unattainable pairs.
- **2026-10-22, independent review round 2: READY WITH FOLLOW-UPS.** The follow-ups are applied in one commit, each decided under the user's standing instruction (recommended option):
  - **F1.** The C4 exponent `m` is taken along each row's own gap normal: `m = ⌊log2(κ·|det S|·|t|/|S·t|)⌋`, decided exactly by comparing squares. Every C4 row now realizes `[g, 2g)` on all eight transforms. The realized physical-gap interval is recorded per case.
  - **F2.** The span-hash test reads the immutable `5c691ad` blob. Drift against HEAD, located by function name, is a non-failing report for the manual freeze step. The l77 span now runs over lines 1890–1901, so it includes the request (`w = 12`, round caps and join).
  - **F3.** Schema keys `gap`, `duplicateOf` and `partial` are added, so `corpusSha256` covers them. Under partial placement a stroke's width is not rescaled.
  - **F4.** Partial rescaling changes a stroke row's width-to-geometry ratio, and the annex states this.
  - **Acceptance.** On 2026-10-22 the Primary recorded the annex as ACCEPTED under the user's standing instruction.
