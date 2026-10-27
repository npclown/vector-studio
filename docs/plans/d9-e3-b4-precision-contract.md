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

**E3-U2 note, 2026-10-23.** The [E3-U2 oracle annex](#14-e3-u2-oracle-annex-2026-10-23) (section 14) records the executable choices of the oracle. Each was decided under the user's standing instruction of 2026-10-22. It changes no criterion, threshold or user decision, and it awaits the independent E3-U2 review.

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

### 13.11 E3-U1 implementation interpretations, 2026-10-22 (accepted under the user's standing instruction)

Dated note. The E3-U1 implementation (PR #206) reads the points that section 13 leaves silent as listed below. The Primary accepted them under the user's standing instruction of 2026-10-22 after review round 1 of PR #206 (READY WITH FOLLOW-UPS), taking the recommended option each time. Each one is part of `corpusSha256`. The [E3-U1 evidence append](d9-rendering-track.md#e3-e3-u1-evidence-2026-10-22) records the resulting hashes.

1. **Closing and placement.**
   - Every named fill polygon is closed with `Z`.
   - "Centered" and "at the origin" squares (s06 to s08, x09, x11) are centered on the origin.
   - A hole "at (x, y)" (j02, j04) has its minimum corner there.
2. **`source` strings.** The stroke-oracle fixture name where one exists, `page:<node>`, `T03:S/TRI/k24` and similar, `AL-OB5/<cell>/path<i>`, `SB-<n>`, and `e3-annex/<row>` for annex-defined shapes.
3. **Generated ids.** The seed is written as `0x%08x`. C9's draw indices continue the shared stream, `g0150` to `g0299`.
4. **Generated draws.**
   - C5 and C9 draw no family index.
   - C5 draws `n`, then the points, then the closed flag.
   - The C3 ring draws its anchors, then per edge `δ₁x, δ₁y, δ₂x, δ₂y`.
   - The pseudo-angle order is the exact angle in `[0, 2π)` from +x, counter-clockwise, with the origin first.
   - C1 snaps after the whole family is built, including the 1/4 hole.
   - Rectangle-set corners become their minimum and maximum.
5. **Table expressions.** Each table entry is the JavaScript expression with `sin` and `cos` correctly rounded:
   - f01: `2 * Math.PI * i / 200`;
   - f06 and f08: `(deg * k * Math.PI) / 180`, with `R(x, y) = (x·c − y·s, x·s + y·c)`;
   - j05: `r * cos(2 * Math.PI * i / 32)`;
   - f03: the grid is row-major, with y outer.
6. **Camera and leftovers.**
   - The midpoint is `(min + max) / 2`, and world points are `(a·x + b·y) + t`.
   - `E_cur` is `(d·z)·(a·x + b·y)`.
   - The empty path x03 uses the box `{t}`.
   - x01 and x02 keep the label `T0`, with `world.l` overridden.
   - The two joint statements of the first reading are replaced by the joint decision below.

**Decisions of review round 1.**

- **Joint.** `joint` is `null` for every copy into C6, C7 and C8. It is also `null` for the SB-11 single-paint rows k27 and k28, which keep opacity 0.5. A joint group therefore always has exactly one fill and one stroke paint per transform and pair: k23 to k26 and k29 to k30. Single-member groups are vacuous, and they would invite pairing failures in E3-U3.
- **No −0.** No table and no case carries −0. f01's one −0 entry is normalized to +0. No other table had one. The test asserts both properties for every table and every case.
- **F1, the C4 gap of n12 to n14.** For the two-circle rows, the recorded `gap.phys` interval encloses the slab gap along the contact normal. It is a **lower bound** on the true minimum physical gap, which lies in `[slab, |S·(g_local, 0)|]`. This qualifies the `gap` row of section 13.2 for those rows. No new value is computed.

## 14. E3-U2 oracle annex, 2026-10-23

Status: dated note for the independent E3-U2 review. Every choice below is **decided under the user's standing instruction of 2026-10-22** (take the recommended option), where section 4 leaves the choice open. It changes no criterion, threshold or user decision. The module is `packages/geometry-reference/src/a04-region.ts`; its paired tests are in `tests/geometry/e3-a04-oracle.test.ts`.

### 14.1 Executable form of section 4.2

| ID     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Alternatives and reason                                                                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-O1  | **Fill `∂R` is explicit.** The path, with its implicit closing edges, is mapped exactly by Φ. Collinear overlapping lines are split at every endpoint and their signed counts summed, and exact cubic duplicates or reversals are summed too (section 4.4). A collinear cubic becomes its chord. Line-line crossings are exact, line-cubic crossings are isolated by Sturm sequences, a cubic's self-crossing is the closed form `s + t = −cross(a₃, a₁)/cross(a₃, a₂)`, and cubic-cubic crossings are isolated by exact subdivision to `2^-24` px. Every portion between cuts is classified by the exact windings on its two sides                                                                                                                                                                                           | An overlay of approximations, or one method for both paints. A fill is a dyadic arrangement, so its portions can be exact                                                                                         |
| E3-O2  | **Uniqueness of a crossing bit.** A cubic-cubic bit is certified to hold at most one crossing when the two pieces' hodograph cones are disjoint as undirected lines (a chord between two common points would lie in both). Two pieces that share an exact end point meet only there when `σA·KA` and `σB·KB` are disjoint. A bit then takes the class of its neighbours: boundary, non-boundary or partial. Otherwise its class is `unknown`                                                                                                                                                                                                                                                                                                                                                                                  | Classify each bit by sampling. A bit is smaller than the floor, so it can only be classified through its certified neighbours                                                                                     |
| E3-O3  | **Stroke `∂R` is an implicit certified cover**, which is the "interval subdivision with exact sign confirmation" of obligation (d). The pieces of stroke contract section 2.2 are built in node-local units: sweeps, joins (via `classifyStrokeSource` and its exact miter test), caps, cusp disks and collinear turning disks. Each has exact point membership. A quadtree cell of physical px is mapped to a local parallelogram. It is IN when it lies in one piece, OUT when it misses every piece, and otherwise undecided. An undecided cell is **certain** when it holds an inside and an outside witness, which are exact memberships of sample points. A boundary point then lies on the segment between them                                                                                                        | Explicit offset and evolute arcs. These are not rational, and the boundary of a folded sweep includes evolute arcs (the ST-F16 sweep passes through its cusp along the evolute). The cover needs no curve algebra |
| E3-O4  | **Sweep membership** is a root `t ∈ [0, 1]` of `f(y, t) = (y − C(t))·D(t)` with `‖y − C(t)‖ ≤ r`. Here `D` is `C′` divided by the common factor `(t − t*)` at a stationary parameter in `[0, 1]`, or the constant line direction for a collinear cubic. So the sweep ranges over regular parameters, with limit normals at stationary points, and a cusp adds its disk as a separate piece (obligation (b)). For a cell, IN uses the intermediate-value theorem: sign changes of `f` at grid parameters, uniform over the cell, and a hull bound of the distance. Where one bracket cannot serve the whole cell (inside a fold), the cell is IN when the union of single-sub-arc brackets covers it: `f` is affine in `y`, so the points one sub-arc misses are two convex pieces, cut exactly from the cell's exact vertices | The naive `C′`. It would include the disk of every point at a stationary parameter                                                                                                                                |
| E3-O5  | **Seams.** Pieces that abut along an end-normal line (a sweep and its join, cap or forward continuation) do not cover a straddling cell alone. The union classifier splits such a cell along that rational line, up to 3 levels, and tags the halves. A piece then treats its constraint on that line as satisfied symbolically. A cell's exact vertices are carried too, so a convex piece (and a collinear sweep, which is a rectangle) certifies a cell that touches its boundary exactly                                                                                                                                                                                                                                                                                                                                  | Accept undecided cells along seams. They would make `B_R` unbounded inside `R`                                                                                                                                    |
| E3-O6  | **`G` uses a certified quadtree** on `Ω ⊕ 1`. A cell that neither boundary can meet lies in one overlay face, which is classified at one interior point. A disagreeing cell is bounded by convexity, and the other cells are refined. An exact agreement certificate resolves a cell whose `∂M` and `∂R` pieces all lie on one exact line: when M and R agree at one corner on each side, the cell contributes nothing. Obligation (f) is in this form: the leaves partition the window, so no face is skipped. E3-D13 is seeded as "boundary-free leaves skipped", which is the quadtree form of skipping a face's interior                                                                                                                                                                                                  | Enumerate the overlay's faces explicitly. A quadtree leaf free of both boundaries is inside one face, so the lemma of section 4.2 applies leaf by leaf                                                            |
| E3-O7  | **Distance bounds.** A lower bound is the distance to every superset element of `∂R` (`∂M` is exact). An upper bound uses a certain element, and over a cell it is the maximum over the cell's generators of a convex distance: a segment, an on-curve point, or the far end of a witness pair. That maximum is the hook point of E3-D6. Intervals round outward one binary64 step per operation                                                                                                                                                                                                                                                                                                                                                                                                                              | Lipschitz bounds from the cell center. They are looser; center-only bounds are the seeded defect                                                                                                                  |
| E3-O8  | **Window.** `Ω ⊕ 1` is tested exactly, as `dist²(p, Ω) ≤ 1`. `window-empty` is decided on `Ω` itself (section 3.3). The window point is Ω's center, or the first of three fixed rational points of `Ω` where exact closure membership is decidable. With no boundary in `Ω`, both regions are constant there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Always the center. A center on a pinch vertex or on two tangent branches has no decidable closure membership                                                                                                      |
| E3-O9  | **Early exit.** Once a term's lower bound exceeds the FAIL threshold, the remaining terms are reported as `[0, +∞)` unless the caller asks for separate terms. The harness passes `passBelow = 0.25 − β_c` and `failAbove = 0.25 + β_c` (section 7.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Always refine all terms. This costs more and does not change any verdict                                                                                                                                          |
| E3-O10 | **T-junctions.** The count is the number of distinct (edge, vertex) incidences with the vertex strictly inside the edge, found exactly. `a04StorageCracks` re-checks each incidence of the Float64 port mesh in `M*` (section 3.2). When the harness supplies `β_c`, the crack bound is reported as `2β_c` if the mesh has a T-junction, else 0 (E3-Q10 (b))                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A geometric crack width per junction. That needs the GPU model of E3-U3 and E3-U4                                                                                                                                 |
| E3-O12 | **Witnesses and exactness at cells.** A sample that the certified cell test leaves open is decided by exact membership. A piece thinner than the sample spacing (a thin wedge or strip, common under T7) is found from the pieces: the centroid of a convex piece clipped to the cell, or the cell point nearest to a disk center, tested exactly. Convex polygonal pieces also separate a cell by the cell's own edges                                                                                                                                                                                                                                                                                                                                                                                                       | Samples only. Thin features under the strong anisotropy of T7 would leave lines of unwitnessed cells                                                                                                              |
| E3-O13 | **Root finding** runs on integer polynomials: primitive pseudo-remainder sequences for gcds, squarefree parts and Sturm sequences, and homogeneous integer evaluation at dyadic points. The sign at an isolated root is decided by refining until the interval holds no root of the other polynomial, after an exact gcd test for a common root                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Rational coefficients. They renormalize by a BigInt gcd at every operation, which made one exact membership take seconds                                                                                          |
| E3-O11 | **Seeded defects** are applied through test-only hooks (`A04Hooks`). The committed oracle never sets a hook, and each mutant is a function written in the unit test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Patch the source per test. The hooks keep the committed source unmutated, as section 8.2 requires                                                                                                                 |

### 14.2 Parameters (section 4.4, work limit)

| Parameter                    | Value                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolution target and floor  | `r_m = 2^-10` px, halved while E straddles a threshold, down to `2^-20` px (section 4.3)                                                                                                                                                                                                                                                                                                                          |
| Crossing bit size (fills)    | `2^-24` px                                                                                                                                                                                                                                                                                                                                                                                                        |
| Margin around `Ω ⊕ 1`        | 64 px. `∂R` is resolved within it. Beyond it a lower bound saturates at the margin, which already exceeds the target                                                                                                                                                                                                                                                                                              |
| Work cap at measurement      | Superseded by section 14.7 (2026-10-23). Was 2·10^8 units per case (a unit is one cell, element or root step). Exceeding it is UNDECIDED                                                                                                                                                                                                                                                                          |
| Work cap at the freeze       | Superseded by section 14.7 (2026-10-23). Was 2·10^6 units per case (about 10 min for a stroke at about 0.3 ms per cover cell). Exceeding it is `ORACLE-WORK`                                                                                                                                                                                                                                                      |
| Freeze cell size (strokes)   | `2^-4` px. Every undecided cover cell of `∂R ∩ (Ω ⊕ 1)` at that size must hold witnesses. Otherwise, within 12 more levels, its unwitnessed descendants that have no witnessed or opposite-class neighbour must shrink to at most 16 cells (point-like: a thin wedge of R or of its complement narrowing to a corner leaves up to about a dozen per level); a level with more than 4,096 such cells fails at once |
| Sub-arc refinement (strokes) | Not below `r·2^-36` for a cell (`r·2^-24` for a point, whose exact membership is the fallback), with a budget of 4,096 sub-arcs per test. An exhausted budget leaves the cell undecided, which is sound                                                                                                                                                                                                           |

Notes on these parameters (review S4 of PR #212):

- **The freeze criterion is a heuristic proxy for decidability.** A case that passes the freeze check is not guaranteed to be decided at measurement time. The rule stays conservative: a case the oracle cannot decide is UNDECIDED and never PASS (section 7.2).
- **The point-like bound was raised from 8 to 16 cells** after the oracle-only observation of `C5/l34/T3/z1-d2` (section 14.4 and the track evidence). No kernel output had been read, so the freeze stays blind (section 5.5).
- **The stride-25 partial run** predates that change. Its 894 `ok` results are not tied to the committed source SHA `1a85af04…` or to any later SHA. The complete freeze run must use the frozen oracle version.
- **The two work caps**, 2·10^8 units at measurement and 2·10^6 at the freeze, are an interpretation of the work limit of section 4.4. The contract fixes neither number. Section 14.7 replaces both with weighted caps.

### 14.3 Controls and seeded defects in E3-U2

- **Implemented at oracle level, on synthetic meshes given as `M*`:**
  - E3-PC1, PC2, PC4, PC5, PC6, PC10, PC11, PC13 and PC14.
  - E3-PC3 with its circle row only. The S-curve row needs the harness's chord construction (E3-U3).
- **Seeded defects:** E3-D1 to E3-D6, E3-D8 and E3-D11 to E3-D13, as section 9.1 assigns them.
- **Left to later units:** E3-PC7 to PC9 and PC12, and E3-D7, D9, D10 and D14. They need `β`, the record or the GPU (E3-U3, E3-U4).
- **PC10's exact circle** is the ST-S10 round point cap of radius 8: it is the only exact circle that the case schema can express. x07's four-cubic circle departs from the circle by up to about `2.2·10^-3` px at radius 8, so its E is not closed-form. Each chord of the n-gon is split at 0.3 of its length, so that no dyadic cell center falls on a chord midpoint.
- **E3-D6's case** is a fill: `R` is the regular 16-gon of radius 8, and `M` is the 8-gon on every other vertex, as a fan with each chord split at 0.3 of its length. `B_M` is attained at the chord midpoints, at the closed-form distance from a midpoint to the two 16-gon edges beside it. With the upper bound taken at cell centers only, the `B_M` interval misses that value.
- **E3-D13's closed form.** `R` is the outer square, the hole `H` (`|x|∞ ≤ 4`) and the island `I` (`|x|∞ ≤ 2`). The mesh fills `H \ I` too, so it covers the whole outer square. `G` is attained on the diagonal of the annulus, where `4 − t = √2·(t − 2)`, so `G = 4 − 2√2`. `B_R = 6`, at `∂I`.
- **E3-D8's size.** Inside `Ω`, every point lies within `(640·d + 4)/(d·z)` local units of the camera. At `z = 0.01` and DPR 3, the fround(z) shift of a visible edge is therefore about `4·10^-5` px, not the `5·10^-4` px that section 8.2 estimates from the 8,192 px extent. It is still above `2^-16` px, which the test asserts.
- **E3-D5's mesh** is the ear-clipped closed-form outline of the ST-F16 sweep at zoom 16:
  - the outer offsets for `|s| ≥ s_r`, where the curvature radius `ρ(s) = 3|s|(1 + 4s²)^{3/2}` equals `r`;
  - the evolute `C ± ρn̂` through the cusp;
  - the butt ends;
  - the inner offsets down to their crossing on `x = 0.5`.

  The oracle fails it: `B_M > 0.95` px, because `∂M` runs inside the cusp disk about `r` = 1 px from its circle. The mutant drops the disk and computes `B_M` alone (`onlyTerms`), for CI time (section 14.4). Its `B_M` falls below 0.25 px, and its status is UNDECIDED, because the other terms are not computed.

### 14.4 Known limits

- **Cost.** At measurement time, the stroke cover and `G` refine near the boundaries to about `E_lo + r_m`. A case with E near 0 therefore costs in proportion to its boundary length divided by `r_m`. The fill agreement certificate removes this for straight boundaries that coincide exactly. The cost is a planning item for E3-U5 (E3-R1). It never changes the metric.
- **Folded sweeps at measurement.** Inside the swallowtail of a folded sweep (the curvature radius below `r`), the cover leaves some cells undecided that are inside `R`. Where `∂M` is far from them, `B_R` refines them deeply. On the E3-D5 mesh, with the disk omitted, `B_R` alone exceeded 3·10^5 cover cells at `r_m = 2^-4`. That test therefore checks `B_M` only (section 14.3). The union-of-brackets IN test (E3-O4) removes most such cells. The rest are an E3-U5 cost item and never a soundness item: an undecided cell only widens the interval.
- **Undecidable closure points.** Two distinct branches that leave a point in the same direction, or a point on a cubic at an irrational parameter, make exact closure membership `ORACLE-UNSUPPORTED` at that point. The oracle then uses another point where it may (window point, G samples).

### 14.5 Soundness arguments (section 4.5 review material)

These are the arguments behind the certified steps of the oracle. They were checked against the source after review S6 of PR #212.

- **Seam split (E3-O5).** The split line `L` is a rational end-normal line, and the cell's exact vertices are cut by it exactly. The two closed halves therefore enclose exactly the two halves of the cell, and their union is the cell. In the half tagged with the closed side `L⁻`, the constraint that a piece skips is exactly that seam's closed half-plane `L⁻`, which every point of the half satisfies. Skipping it changes nothing on that half. So IN on both halves gives `cell ⊂ A ∪ B ⊂ R`.
- **Union-of-brackets IN test (E3-O4).** A point in the bracket of a sub-arc (a sign change of `f` and the distance hull bound at most `r`) is in the sweep, by the intermediate-value theorem. The points that a sub-arc misses are cut with closed half-planes, so each clip over-approximates the uncovered set. When the distance bound fails, the sub-arc misses the whole cell. Strict sign conditions make the true uncovered set an open set intersected with the convex cell. Such a set is empty, or it has positive area. So dropping the zero-area pieces is valid, and an empty remainder proves the cell IN.
- **Undecided-cell cover (E3-O3).** An IN cell lies in `R`, and an OUT cell misses `R`. So an IN cell and an OUT cell cannot share a point. Take a point `p` of `∂R` inside the root cell. The closed leaves around `p` cover a neighbourhood of it. If they were all IN, `p` would be interior to `R`. If they were all OUT, `p` would not be in `R`, but `R` is closed. A mixture of IN and OUT cannot meet at `p`. So `p` lies in an undecided cell, and `∂R` stays inside the undecided cells.
- **Witnesses (E3-O3, E3-O7, E3-O12).** An undecided cell with an exact inside point `a` and an exact outside point `b` contains the segment `[a, b]`, because the cell is convex. The parameters of the segment's points in `R` form a closed set that holds 0 and not 1. Its largest element gives a point of `R` that is a limit of points outside `R`, so a point of `∂R` on the segment. Hence `dist(q, ∂R) ≤ max(|q − a|, |q − b|)` for every `q`, which is the "far end of a witness pair" upper bound.
- **`G` strip certificate (E3-O6).** Every element of `∂R` that can meet the cell is a certain segment, and it and every `∂M` segment that can meet the cell lie on one exact line `L`. Each open side of `L` within the cell is convex, so connected, and it meets neither boundary. So `R` and `M` are each constant on it, and one corner per side decides agreement. Both are closures of their interiors, so on `L` itself each contains a point exactly when it contains an adjacent side. Agreement on both sides therefore gives agreement on `L`, and the cell holds no point of `M △ R`. For `M`, this holds because the oracle measures only meshes of positive-area triangles with disjoint interiors (S2, closed in section 14.7): a finite union of closed triangles of positive area is the closure of its interior.
- **Early exit (E3-O9).** Each lower bound is attained by an exact or certified point, so `E_lo` is valid whenever the loop stops. A term stopped early still reports the maximum of its unrefined upper bounds. A term that is not computed reports `[0, +∞)`, so `E_hi` becomes `+∞` and the interval is `[E_lo, +∞)`. That interval is valid, and it can only lead to FAIL (`E_lo > 0.25 + β_c`) or UNDECIDED.

### 14.6 Open pre-freeze items (E3-U2b)

Review of PR #212 found three items that the freeze depends on. Each is **decided under the user's standing instruction of 2026-10-22** (the recommended option): E3-U2 lands as a partial unit, and a follow-up unit E3-U2b closes these items before the freeze note. They are recorded here, not implemented.

Status, 2026-10-23: E3-U2b closes S2, S3 and S7 in code (section 14.7).

| ID  | Item                                                                                                                                                                                                                 | Planned resolution in E3-U2b                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| S2  | `∂M` is found by edge count (an edge used once). That is unsound for zero-area or overlapping triangles: their edges can cancel or count once without lying on `∂M`, and `M` is then not the closure of its interior | The oracle rejects such a mesh or marks the case UNDECIDED, or the harness enforces a precondition of positive-area, non-overlapping triangles |
| S3  | The work cap does not charge root-isolation steps or arc nodes, so the cost of one case is not bounded                                                                                                               | A deterministic weighted work cap that charges every unit of work, required before E3-A4                                                       |
| S7  | The crack bound counts only the T-junctions of `M*`. Storage cracks of the port mesh, which `a04StorageCracks` finds, do not feed `a04Measure`                                                                       | `a04Measure` takes the storage cracks of `a04StorageCracks` into its crack bound, or E3-U3 closes them in the harness                          |

### 14.7 E3-U2b pre-freeze closure, 2026-10-23

Dated append. E3-U2b closes the three open items of section 14.6 in `a04-region.ts`. Each choice below is **decided under the user's standing instruction of 2026-10-22 (recommended option)**. No A04 threshold, criterion or user decision changes.

**S2, mesh preconditions.** `buildMesh` checks every triangle of `M*` exactly:

- A triangle whose exact orientation is 0 is a zero-area triangle. This includes a repeated vertex.
- Two triangles overlap when their interiors meet. Candidate pairs come from the triangle grid index. A pair is disjoint exactly when the line of some edge of one triangle has the other triangle in its closed opposite half-plane. This is the separating-axis argument for convex polygons: the edge of the Minkowski difference that faces the origin comes from an edge of one of the two triangles. Triangles that only share an edge or a vertex are disjoint.
- `a04Measure` reports such a mesh as UNDECIDED, with reason `invalid mesh: zero-area triangle k` or `invalid mesh: overlapping triangles j and k`, before any term is computed. It never reports PASS for it.
- Under these preconditions, and with edges split at T-vertices, a sub-edge used by one triangle lies on `∂M`. A sub-edge used by two triangles has them on opposite sides, so it is interior, and no sub-edge is used three times. So `∂M` by edge count is exact, and `M` is the closure of its interior (section 14.5).
- Alternative not taken: let the harness drop zero-area triangles before measurement. That changes the set `M*`, because a zero-area triangle adds a segment to the union of closed triangles. It stays a harness decision for E3-U3, which must disclose it.
- Tests: the reviewer's sliver (the 16×8 rectangle's fan plus the triangle `(116, 104), (121, 104), (118.5, 104)`), a repeated vertex, an overlapping triangle, a touching triangle (valid, so it is measured, and it FAILS) and a valid fan (PASS).

**S3, a weighted work cap.** Every exact-arithmetic loop whose cost the structural units did not bound is now charged where it runs, through the work of the call in progress. The charges come at its rational normalizations and gcd steps and at the other kinds below. A unit is a nominal microsecond, and the bound on wall time that it gives is empirical (calibration below).

| Kind                 | Where it is charged                                                                   | Weight                       |
| -------------------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| structure            | Cover cells, fill elements and pairs, B&B nodes, distance queries (as in E3-U2)       | 3                            |
| gcd step             | Every BigInt Euclid loop (`qmk`, `toZ`, `zprimitive`): `s·(1 + s/37)` for `s` steps   | 0.3                          |
| rational             | Every rational normalization (`qmk`)                                                  | 2                            |
| horner step          | `zsign` (Sturm counts, `isolateRoots`, `refineRoot`, `signAtRoot`), by the point size | 0.13 per `deg·(1 + b(t)/64)` |
| pseudo-division step | `zpdivmod` (Sturm sequences, gcds, squarefree parts), per coefficient touched         | 0.23                         |
| sub-arc node         | `CubicSweep` `outside`, both `collect` trees, sign samples, `pointsNear`              | 7.5                          |
| clip vertex          | `clipExact` in the union-of-brackets IN test                                          | 1.5                          |
| seam split           | Every `classifyPoly` call, including the seam recursion                               | 85                           |
| membership           | Every exact membership (stroke `containsLocal`, fill `contains`), witnesses included  | 5                            |
| cell lookup          | `cellAt`, including the freeze check's `nearBoundary` lookups                         | 2.5                          |
| mesh pair            | Each candidate triangle pair of the S2 overlap test                                   | 2.5                          |

Here `b(t)` is the bit length of the numerator and denominator of the point `t`.

- **Caps.** Freeze: 1.8·10^9 units, a nominal 30 min. Measurement: 7.2·10^9 units, a nominal 2 h, four times the freeze cap. Exceeding a cap is `ORACLE-WORK` at the freeze and UNDECIDED at measurement, as before. Both remain interpretations of section 4.4.
  - Update 2026-10-23 (E3-U2c, section 14.8): the weights in this table are superseded by section 14.8. The 30 min figure holds for the E3-U2b build only. On the E3-U2c stride-25 run the worst stroke case took 1.53 µs per unit, so the 1.8·10^9 freeze cap bounds a stroke case at about 46 min on this machine under a 14-shard load. One fill case took 5.8 µs per unit (21 s). The bound remains empirical.
- **Determinism.** The charge depends only on the case, the mesh and the options: counts and bit lengths, never a clock. The freeze result also reports the unweighted count per kind (`workByKind`).
- **Calibration.** The machine is Windows 11 with 16 logical CPUs and Node v24.15.0, loaded with 14 processes as in a freeze run.
  - A first fit used 114 cases of at most 5 min: every 250th corpus case from index 7, plus the open cases of the E3-U2 run.
  - The stride-25 freeze run with those weights (commit `4fe4679`, 1,099 cases) then took up to 4.4 µs per unit on long cases. Heap growth and very large rationals make long cases slower per unit.
  - The weights were therefore refitted on that run's 161 cases above 20 s, by least squares on the log of the time, and scaled by 2.5 so that no case took more than 1 µs per unit. The largest was 0.97 µs per unit, and the median 0.40.
  - So the freeze cap bounds a case at about 30 min on this machine under that load. A slower machine or a heavier load scales the bound. The bound is empirical, not a proof.
- **Cost of the bound.** On the first stride-25 run's counts, 17 cases that were `ok` after 4.5 to 38 min exceed the new cap. Under E3-Q6 (a), they become `ORACLE-WORK`, like the slow open cases. The rerun below gives the outcome on the final build.

**S7, storage cracks.** `a04Measure` takes an optional `portMesh`: the Float64 port mesh with the same indices as `M*`.

- It runs `a04StorageCracks` and adds the port mesh's T-junctions to those of `M*` for the crack bound: `2β_c` when either count is positive, else 0.
- The result reports `storage`: the port T-junctions and the storage cracks.
- Test: the E3-PC13 mesh, with its T-vertex moved off its edge in `M*`. `M*` then has no T-junction, and the crack bound is `2β_c` only when the port mesh is given.
- The harness (E3-U3) must pass the port mesh.

**Stride-25 freeze run on the final build.** The command was `pnpm e3-a04:freeze --shards 14 --stride 25`. The oracle was commit `7c8ac51`, with `a04-region.ts` SHA-256 `218ed5891c1392239b5400578d27ea45225af657e2089113422ec777aa1e26e5`. The run went from 05:26 to 06:35 UTC (69 min wall), with 10.5 CPU hours on the machine above.

- **1,099 cases checked: 1,062 `ok` and 37 `ORACLE-WORK`.** No case was `ORACLE-UNSUPPORTED` or `ORACLE-INCONSISTENT`.
- **Strata.** C1 to C4, C6, C7, C10, C11 and C12 are all `ok`. C5 has 277 `ok` and 5 `ORACLE-WORK`. C8 has 106 `ok` and 1. C9 has 109 `ok` and 31.
- **Time.** The slowest case took 1,168 s (`C9/g0178/T4/z64-d2`, at the cap). No case above 20 s took more than 0.69 µs per unit. Mean time per case: C5 38 s, C8 9 s and C9 186 s. The fill strata are below 0.2 s.
- **The `ORACLE-WORK` cases.**
  - 35 cases reached the work cap: gcd steps (19), sub-arc nodes (14), rationals (1) and seam splits (1). They include `C9/g0220/T5/z1-d2` (473 s) and `C9/g0259/T7/z1-d1` (552 s), and all 17 cases that the refit predicted.
  - Two cases have a cover cell that does not resolve point-like: `C9/k10/T7/z64-d3` at `(667.9375, 540)` (137 s), and `C9/g0234/T0/z1-d1` at `(316.875, 172.5625)` (173 s).
- **Full-run estimate.** 25 times this sample is about 263 CPU hours, about 19 h on 14 shards. That is above the 17 h of the E3-U2 estimate, so the full run was **not started**.
- **Disposition under E3-Q6 (a).** Every `ORACLE-WORK` case fails the freeze, so the corpus is not frozen. About 3.4 % of the sample fails, all in the stroke strata C5, C8 and C9. On the full corpus that is about 900 cases. The freeze needs one of two things:
  - a faster oracle on these strokes. The dominant costs are BigInt gcds of large rationals in the exact cell tests, and sub-arc refinement;
  - or a disclosed generator revision.

**Review of PR #214, 2026-10-23.** Decided under the user's standing instruction of 2026-10-22 (recommended option):

- `a04Measure` reports `crackBound: null` whenever the mesh was not fully built and checked: a work cap hit before `buildMesh` returns, or before the port mesh's storage check ends. It never reports 0 for an unknown mesh.
- `a04StorageCracks` now runs inside the active work, so it is charged and capped. A cap hit there is UNDECIDED.
- The S2 tests add a triangle strictly inside another, two triangles on the same side of partly shared collinear edges, a duplicated triangle in both orientations, and a pair that only the second triangle's edge separates, in both orders.
- The source SHA-256 is now `0544b1dc8c4e8fced559e406851ff0dcca9e85b3fee06c9c9ed8992b3b3e0725`.
- The stride-25 result above (1,062 `ok`, 37 `ORACLE-WORK`) is tied to SHA `218ed589…` and was not rerun. The change adds charges only after the freeze terms: the storage check runs only in `a04Measure`, with a port mesh, and the crack-bound change does not touch the freeze check.

### 14.8 E3-U2c oracle speed-up, 2026-10-23

Dated append. E3-U2c makes the oracle faster on the stroke strata, so that the `ORACLE-WORK` cases of the E3-U2b freeze run (section 14.7) end within the caps. It is the E3-Q6 (a) path of an oracle fix, with no corpus change. Every choice below is **decided under the user's standing instruction of 2026-10-22 (recommended option)**. No A04 threshold, criterion, cap or user decision changes. The work weights are refitted, which section 14.7 allows and this section discloses.

**Changes, each an exact identity or a sound filter.**

| Change                    | What it does                                                                                                                                                                                                                                                                                                                                                                             | Why it is sound                                                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scaled local frame        | The stroke region is built in coordinates `y′ = σ·y` with `σ = det L`. `Φ⁻¹` scaled by `σ` is the adjugate of `L`, which is dyadic like `Φ`, so the exact cell tests of the dyadic cell corners need no gcd. Every source point is scaled by `σ`, and the radius by `\|σ\|`                                                                                                              | `y ↦ σ·y` is a similarity (a uniform scaling, and for `σ < 0` a rotation by π), so every piece predicate (distances, signs of crosses and dots, sweep roots) is unchanged. The classification of the source is scale-free and runs on the unscaled numbers |
| Seam-split budget         | At most 24 seam splits per top-level stroke classification, nearest seams first                                                                                                                                                                                                                                                                                                          | An exhausted budget returns undecided. A smaller cover cell meets fewer seams, so the quadtree refines it                                                                                                                                                  |
| Vertex box filter         | The exact all-vertices test of a convex piece is skipped when a vertex enclosure lies outside the piece's outward box                                                                                                                                                                                                                                                                    | A vertex outside the box is outside the piece, so the test could not succeed                                                                                                                                                                               |
| Lazy exact halves         | The exact vertices of a seam half are computed on first use                                                                                                                                                                                                                                                                                                                              | The same values, computed later                                                                                                                                                                                                                            |
| Bernstein hull            | `CubicSweep` also excludes a sub-arc when every Bernstein coefficient of `f(y, t)` on it keeps one sign at every vertex enclosure of the polygon. The coefficients are subdivided from the root by outward-rounded de Casteljau halving                                                                                                                                                  | `f = Σ bᵢ(y)·Bᵢ(t)` with `bᵢ` affine in `y`, and `Bᵢ ≥ 0` with `Σ Bᵢ = 1` on the sub-arc. This is the convex hull property                                                                                                                                 |
| Exact halving             | Interval midpoints `(u + v)·½` round the sum outward and halve exactly                                                                                                                                                                                                                                                                                                                   | Halving a binary64 is exact unless the result is subnormal, where the general product is used                                                                                                                                                              |
| Interval `signAtRoot`     | Before the exact gcd and Sturm test, the isolating interval is refined up to 64 times, and an outward-rounded Horner enclosure of `h` on it that excludes 0 decides the sign                                                                                                                                                                                                             | The enclosure contains `h` on the interval, which contains the root                                                                                                                                                                                        |
| Integer clipping          | The union-of-brackets IN test (E3-O4) clips in integer homogeneous coordinates. A line is an integer triple, and a vertex is the cross product of its two lines. A clip of a convex polygon of positive area by `{g ≥ 0}` has positive area exactly when `g > 0` at some vertex, which replaces the area test                                                                            | The same exact polygons, after a fix of 2026-10-23 (review B1 of PR #216). As first committed (`52f5177`), a kept vertex on `g` whose next vertex was cut away kept its old outgoing line. A later clip could then place a new vertex wrongly and drop a piece as covered, which is unsound. Such a vertex now takes `g` as its outgoing line, and as its incoming line when its previous vertex was cut away; its point is unchanged. A randomized test compares the clip with the rational clip of E3-U2b. If `g ≤ 0` at every vertex, then `max g ≤ 0` on the polygon, which meets `{g ≥ 0}` only on the line. If `g > 0` at a vertex, points of the interior near it satisfy `g > 0`                                                       |
| Shared sub-arc collection | The fine bracket test and the union-of-brackets test use one collection of sub-arcs                                                                                                                                                                                                                                                                                                      | The collection is deterministic, so both tests see the same sub-arcs as before                                                                                                                                                                             |
| Witness candidates        | The witness search runs on first use of a cell's witness. A cell with an outside sample and no inside sample tries, after the existing candidates, normal segments `C(t) ± r·n̂(t)` of sub-arcs with a possible foot in the cell (at most 512 nodes and 16 segments). It tests three points of each segment's part inside the cell. The certified point test runs before exact membership | A witness is a function of the box alone. Every point of a normal segment is in the sweep (foot `t`, distance at most `r`), and every candidate is still tested by exact membership. Candidates only affect which witness is found, never a class          |

**Work weights.** The speed-up changes the cost of each kind, so the weights of section 14.7 are refitted. The fit used the 37 cases and the 114 calibration cases of section 14.7, all run on the E3-U2c build with a cap of 6·10^9. It is a log-error fit on the cases above 20 s, scaled so that none of them took more than 1 µs per unit. The caps are unchanged.

| Kind       | structure | gcd step | rational | horner step | pseudo-division step | sub-arc node | clip vertex | seam split | membership | cell lookup | mesh pair |
| ---------- | --------- | -------- | -------- | ----------- | -------------------- | ------------ | ----------- | ---------- | ---------- | ----------- | --------- |
| E3-U2b     | 3         | 0.3      | 2        | 0.13        | 0.23                 | 7.5          | 1.5         | 85         | 5          | 2.5         | 2.5       |
| **E3-U2c** | 9.5       | 0.22     | 1.15     | 0.17        | 0.38                 | 12           | 0.26        | 80         | 8.2        | 4.2         | 4.2       |

- **The bound held on the fitting sample but not on the freeze run.** On the 102 cases above 20 s of the freeze run below, the worst stroke case took 1.53 µs per unit. One fill case (`C4/n14/T2/z64-d1`, 21 s) took 5.8 µs per unit. So the freeze cap now bounds a stroke case at about 46 min on this machine under a 14-shard load, not 30 min.
- **The alternative not taken.** Refitting on that freeze run and scaling to 1 µs per unit would keep the 30 min bound. On the run's own counts, it would turn five more slow C9 cases into `ORACLE-WORK`, for 10 in all. **Decided 2026-10-23 under the user's standing instruction of 2026-10-22 (recommended option): keep the loose weight fit.** The user's decision of 2026-10-23 keeps the 1.8·10^9 cap and improves the oracle later (E3-U2d). The weights only change cost accounting, and an `ORACLE-WORK` outcome is never a pass, so the choice cannot produce a false PASS. The strict refit (10 failures, a 30 min bound) stays recorded as the alternative.

**Results on the E3-U2c build** (commit `52f5177`, `a04-region.ts` SHA-256 `411c81780e0c83439633e64a5eb00a8c7184744bbe5a88f20839912edec442a1`; Node v24.15.0, Windows 11, 16 logical CPUs).

- **The 37 cases, with a cap of 6·10^9:** 36 `ok` and `C9/k10/T7/z64-d3`. The slowest took 1,658 s. `C9/g0234` is `ok` through the normal-segment candidates.
- **The stride-25 freeze run:** `pnpm e3-a04:freeze --shards 14 --stride 25`, 12:28 to 13:10 UTC (42 min wall) and 6.7 CPU hours.
  - **1,099 cases: 1,094 `ok` and 5 `ORACLE-WORK`.** Every stratum except C9 is all `ok`. C9 has 135 `ok`.
  - Four cases reach the work cap on sub-arc nodes: `C9/g0270/T2/z1-d2`, `C9/g0195/T4/z1-d2`, `C9/g0178/T4/z64-d2` and `C9/g0187/T4/z0.01-d2`. With the cap lifted to 6·10^9, all four end `ok` in 19 to 28 min.
  - `C9/k10/T7/z64-d3` still has an unresolved cover cell, at `(1333.8125, 540)`. Exact sampling finds no inside point near it. The cell is outside `R`, beside the butt corner of a 4096:1 anisotropic stroke, and the interval test does not certify it OUT.
- **Full-run estimate.** About 168 CPU hours, or about 12 h on 14 shards, which is below 17 h. The sample is not 100 % `ok`, so the full run was **not started**.

**Rerun after the review of PR #216, 2026-10-23.** The review fixes are the integer clipping fix above (B1), test-only self-tests and an unscaled reference, and comments. The source SHA-256 is now `47117f777812e43cb68c0793ac6db7a1dd4238f3500afcadd38a940efc4cbe09` (commit `0941180`).

- `pnpm test:e3-a04` passes 78 tests in 3 files: the 60 before and 18 new ones in `tests/geometry/e3-a04-oracle-u2c.test.ts`. They check the integer clip against the rational clip of E3-U2b on 4,000 chains, the scaled frame against the unscaled region on T3, T6, T7, T5 and a reflected T3, the Bernstein halvings against exact coefficients, and the `signAtRoot` prefilter against the exact test. The clip test fails on the code before the fix.
- The stride-25 freeze run, with the same command and 14 shards, went from 14:16 to 15:00 UTC (44 min wall) and took 6.7 CPU hours. **1,099 cases: 1,094 `ok` and 5 `ORACLE-WORK`**, the same five cases with the same outcomes. No status changed. The work of one case changed: `C9/k05/T0/z64-d1` went from 204,105,186 to 204,079,950 units and stays `ok`.

**Disposition under E3-Q6 (a).** Five sampled cases still fail the freeze, so the corpus is not frozen. Left: one further oracle speed-up on sub-arc refinement, or a different weight choice; and the outside certification of the k10 cell, or a disclosed generator revision for it.

## 15. E3-U3 harness annex, 2026-10-24

Dated append. E3-U3 is the harness, the record and the run tool of section 9.1. This section is their executable form. Every choice below is **decided under the user's standing instruction of 2026-10-22 (recommended option)**. No A04 threshold, criterion, cap or user decision changes. The items of section 15.9 depart from a premise of this contract or extend it, and are listed for the evidence review.

The corpus is **not frozen** (section 14.8). E3-U3 therefore runs the kernel on no corpus case. Its WASM test and `pnpm e3-a04:run --smoke` use the smoke cases of section 15.6, whose paths are written in the test source. `pnpm e3-a04:run` without `--smoke` refuses to start until this contract holds a `**Freeze record**` line with the manifest's `corpusSha256` (section 5.5).

### 15.1 The product path under measurement

`measureCase` (`tests/geometry/e3-a04/harness.ts`) drives the product path, not a copy of it:

- A one-node scene goes through `RetainedSceneMirror`, `PrimitiveSceneSource` and `PathMeshPipeline`, with the release WASM ports (`createFillMeshPort`, `createStrokeMeshPort`) and `renderer-core`'s `buildPathFringe` builder. The scene affine is `[a, c, b, d, tx, ty]` for the corpus matrix `L = [[a, b], [c, d]]`.
- The draws and their frame lanes are taken where the pipeline hands them to `PathMeshPacker.prepare`. That is after bucket selection, mesh origin selection and K4 packing, and before the GPU. The harness patches that one method for the call and restores it.
- For E3-C8 (`k > 0`), one frame at zoom `z·2^k`, centred on the same world point, primes the mesh cache before the measured frame, so the served tolerance is the cached one.
- Joint cases (SB-10, SB-11) draw the partner paint in the same node. The feature identity of E3-C9 is checked against a second scene at opacity 1. A difference makes the case UNDECIDED (`joint-feature-identity`).
- A port result of `empty`, and a path the pipeline culls, are measured with `M = ∅` and `β_c = 0` (E3-K2).

### 15.2 The shader model and `β`

For each stored offset `u`, `p*` is the exact rational value of the WGSL `toPhysical`, `((A·u + B) + (O_m − c))·z·d`, from the f32 lane values. Products and sums are exact dyadics.

- **Feature path.** Six roundings on the longest chain, in any association, so `β_f = γ_6·Σ|terms|·|z·d|` per axis. A fused multiply-add only removes roundings, so the bound holds either way.
- **Vertex path.** `β_f`, then the NDC step `x·2/W − 1` and `1 − y·2/H` (division within 2.5 ulp, WGSL), then the viewport transform modelled in f32 as three roundings (`γ_3`). `ndcAxisError` carries the error through each step.
- **Absolute and f64 terms.** Each axis adds `η = 2^-100` px for flushed or subnormal results. Every bound the harness evaluates in binary64 is scaled by `1 + 2^-20`.
- `β(p)` is the Euclidean norm of the two axis bounds. `β_c` is the maximum over the points of both paths, plus the clip bound of section 15.3.
- A unit test checks the model against an f32 emulation on 20,000 random points, fused and unfused. A shader-identity test pins `toPhysical` and `meshPositionNdc` in `MESH_FILL_SHADER`. The record carries the SHA-256 of the shader source.

### 15.3 Guard band and clipping (E3-Q11 (a))

The guard band is the viewport `[0, W] × [0, H]`. A triangle with a mapped vertex outside it, and not wholly beyond one clip plane, is clipped by the GPU.

- **The clip model.** For each such triangle the bound is `(planes crossed)·γ_8·Σ(|x − W/2| + |y − H/2|) + γ_3·(W + H)`, summed over the triangle's vertices. Each new vertex is an f32 interpolation in clip space along an edge of the polygon clipped so far, then the viewport transform.
- `β_clip` is the maximum over the crossing triangles. **UNDECIDED** if `β_clip ≥ 0.25` px or if `β_c ≥ 1` px.
- The readback next to the viewport edge that E3-Q11 (a) asks for is E3-U4's.

### 15.4 No-flip certificate

For every mapped triangle whose box meets `Ω ⊕ 2`, with `e1` and `e2` the edges at the vertex shared by the two shortest edges, the certificate is `|e1 × e2| > 2β_c(|e1| + |e2|) + 4β_c²`.

- The cross product is exact. The lengths are rounded up, and the area is rounded down.
- A zero-area triangle fails, and the case is UNDECIDED, **unless it is collapsed**: two of its vertices have the same `p*`. They then have the same stored offset and lanes, so the GPU maps them to the same position bit for bit (the bit-identity assumption of section 7.1). The triangle has zero area on the GPU as well and covers no sample.
- `M*` leaves collapsed triangles out, because the oracle's mesh model takes triangles of positive area only. Since section 21.4 it leaves out every zero-area triangle (`withPositiveArea`). The storage-crack check still sees the full port mesh.
- See section 15.9, item 2.

### 15.5 `window-empty` on the drawn mesh

When the oracle finds `∂R` and `∂M*` both off `Ω` (status `window-empty`), the harness also checks that no boundary candidate of `M*` meets `Ω ⊕ 1`, so that a `β_c` move cannot bring `∂M_gpu` into `Ω`.

- A candidate is any edge not shared by exactly one triangle on each side. That includes T-junction sub-edges and the edges of zero-area triangles, so the candidates are a superset of `∂M*`.
- Otherwise the case is UNDECIDED (`window-empty within the guard`).

### 15.6 Smoke cases

`tests/geometry/e3-a04/smoke.ts` holds five non-corpus cases with the centre placement of section 13.7.

| Case                            | Shape                                    | Expected | In `pnpm test:geometry` |
| ------------------------------- | ---------------------------------------- | -------- | ----------------------- |
| `smoke/rect/T0/z1-d1`           | 96 × 48 rectangle fill                   | PASS     | Measured                |
| `smoke/rect/T0/z64-d3`          | 4 × 2 rectangle fill                     | PASS     | Measured                |
| `smoke/blob/T2/z1-d2`           | Closed four-cubic blob fill              | PASS     | Measured                |
| `smoke/segment-butt/T0/z1-d1`   | Segment of length 32, width 4, butt caps | PASS     | Drawn only              |
| `smoke/polyline-miter/T0/z1-d1` | Three-segment polyline, width 3, miter 4 | PASS     | Drawn only              |

They show that the whole path runs on the release WASM. They are not A04 evidence. `tests/geometry/e3-a04-harness-wasm.test.ts` runs them in `pnpm test:geometry`. The oracle takes minutes on a stroke region, so that test only draws the two stroke cases. `pnpm e3-a04:run --smoke` measures all five.

### 15.7 The record (`tests/geometry/e3-a04/record.ts`)

- **Schema.** `e3-a04-record/v1`: provenance, selection (stride, shards, corpus size), the GPU check or `null`, control outcomes, rows, aggregates, rejection counts, uncovered cells, maximum interval width, verdict and the reasons that keep it from PASS.
- **Aggregates.** Overall, and per stratum, transform, pair and paint. For each: counts, max `U` and its case, and p99 and p50 by nearest rank, over measured cases only.
- **Coverage (E3-A8).** The cells are paint × T0 to T7 × the nine pairs. A cell with no PASS, FAIL or UNDECIDED case is uncovered.
- **Verdict (section 7.3).**
  - **FAIL** on any FAIL case.
  - Otherwise **UNVERIFIED** if any of these holds: a case is UNDECIDED; a control is not met; there is no GPU check or it failed; a cell is uncovered; the stride is not 1; not every corpus case has a row; the worktree is dirty.
  - Otherwise **PASS**.
- **Validator (E3-A7, E3-D10).** It reconciles row indices and ids with the corpus in generation order, and checks that each status agrees with its bounds. It recomputes the aggregates, the coverage and the verdict, and lists every difference.
- **Encoding.** `record.json` writes non-finite numbers as strings (`"Infinity"`), because JSON has none. `record.md` is the Markdown view.

### 15.8 Controls, seeded defects and the run

**Controls.** `tests/geometry/e3-a04/controls.ts` runs each control as a synthetic port answer through the same `measureCase`. No kernel runs.

| Control                   | Executable form                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-PC1, E3-PC2            | A rectangle with one top vertex moved outward by 0.26 or 0.24 px. The realized offset against the ideal top edge must lie in `[E_lo, E_hi]` for PC2 |
| E3-PC3                    | A 9-gon of a radius-16 disk (sagitta 0.9649 px), and an S-curve as 6 chords (closed-form error 0.8990 px, foot checked): FAIL with the value inside |
| E3-PC4                    | One interior triangle dropped from a 64 × 64 square                                                                                                   |
| E3-PC5                    | See section 15.9, item 3                                                                                                                              |
| E3-PC6                    | A ring with a 0.4 px hole, meshed without the hole                                                                                                    |
| E3-PC7                    | Linear lane 0 raised by `2^16` ulps at the far translation (about 0.3 px)                                                                            |
| E3-PC8                    | The pan lanes offset by 0.3 px                                                                                                                        |
| E3-PC9                    | Width raised by 0.3 px; a kept miter drawn as a bevel; a round cap drawn as a square cap                                                              |
| E3-PC11, E3-PC14          | An `empty` answer for a rectangle (`B_R = +∞`), and for a shape that covers `Ω` (FAIL at the window point)                                          |

All 14 control outcomes are met (`pnpm test:e3-a04`).

**Seeded defects**, each in `tests/geometry/e3-a04-harness.test.ts`:

- **E3-D7.** A `z = 64`, `d = 3` rectangle bumped by `0.25 − β_c/2` is UNDECIDED, and PASS with `β` omitted.
- **E3-D9.** A rectangle whose right edge lies at 641.75 px with an inward dent to 641.25 px, inside the 2 px guard. It is FAIL, and not FAIL when an oracle window hook shrinks `Ω ⊕ 2` by 2 px.
- **E3-D10.** The validator accepts a record with a rejected row, and catches the same record with that row dropped and with a forged PASS verdict.
- **E3-D14.** On small lanes near the surface origin, where `toPhysical` is almost exact and the NDC round trip dominates, `β` without the NDC step is below the emulated vertex error for some points. The full `β` bounds every one.

**The run** (`pnpm e3-a04:run`, `tooling/run-e3-a04.mjs`, manual and never CI).

- **Before any shard.** It refuses a corpus run without the freeze note. It uses the release WASM that `pnpm test:geometry` builds, or `--wasm <path>`.
- **Provenance.** It records the commit, the dirty state, the run id, and the SHA-256 of the contract, the generator, the oracle source and the WASM. It also records `corpusSha256`, the Node version and the OS.
- **Shards.** It measures the corpus in `--shards N` processes of `tests/geometry/e3-a04/run.check.ts`. Each case goes to the shard of its rank, and a joint case is paired with its partner of the same group, transform and camera.
- **Finalize.** A finalize process adds the operation identities, the shader hash, the carrier `K4` and the builder placement. It runs the controls, attaches `--gpu <file>` if given, and writes and validates the record.
- **Evidence copy.** A clean, stride-1 run with no validator problem is copied to `docs/evidence/e3-a04/<stamp>-<run id>/`, never over an existing directory.

### 15.9 Departures and extensions, for the evidence review

1. **`fringe-unsupported` is rejected, not measured.** Section 6 measures `fringe-unsupported` because "the region still draws". In the product it does not: `PathMeshPipeline.servePaint` returns no draw, and the path is hidden. With no drawn mesh, the case is rejected with code `fringe-unsupported`, as for a renderer state failure. `fringe-range` is rejected the same way. A joint case whose partner paint fails is rejected as `joint-partner-<code>`, because the product hides the whole path. `fringe-work-cap` still draws and is measured.
2. **Collapsed triangles** (section 15.4). Kernel meshes can hold triangles that become degenerate after f32 storage, for example at near-duplicate path end points (`smoke/blob/T2/z1-d2` has one). Other zero-area triangles near the window fail the certificate and go to section 20; those off it are left out of `M*` (section 21.4).
3. **E3-PC5 uses another shape.** The star's evenodd mesh has pinch vertices that the fringe builder rejects as `fringe-unsupported`. PC5 uses two nested squares of the same orientation instead: nonzero fills the inner square, and the evenodd mesh (an annulus) does not. It is FAIL through `G`, which is the control's intent.
4. **An oracle test hook.** E3-D9 needs a narrower window. `A04Hooks` gains a test-only `window` hook, which `makeFrame` applies to `Ω`. It changes no default behaviour, but it changes the oracle source SHA-256. The freeze note records the SHA of the build it certifies.

## 16. E3-U4 GPU model-check annex, 2026-10-24

Dated append. E3-U4 is the GPU model check of section 7.1: the page, the headed spec and E3-PC12 (section 9.1). Every choice below is **decided under the user's standing instruction of 2026-10-22 (recommended option)**. No A04 threshold, criterion or user decision changes. Section 16.4 lists what the check does not observe.

### 16.1 What runs where

- **Node** (`tests/geometry/e3-a04/readback.ts`, called by the spec) draws each readback case through the product path of section 15.1 on the release WASM. It takes the stored binary32 offsets and the packed lanes of each draw, and computes `p*`, `β_vertex` and `β_feature` for every point with the model of section 15.2.
- **The page** (`apps/playground/e3-a04-readback.html`, source `apps/playground/src/e3-a04-readback.ts`) receives the WGSL source of `MESH_FILL_SHADER` from the spec. It appends two entry points and draws one point per stored vertex into two `rgba32uint` targets.
  - The vertex entry point calls `meshPositionNdc`, the helper of both mesh vertex entry points, and carries the result as flat `u32` bits.
  - The fragment entry point calls `toPhysical`, as the mesh fragment stage does for features.
  - The page is test-only and is not a host. It has no WASM and no renderer.
- **The check** (`modelCheck`) requires all of the following:
  - **Vertex path.** The read-back NDC, taken back to pixels exactly as `(n + 1)·W/2` and `(1 − n)·H/2`, lies within `β_vertex` of `p*`.
  - **Feature path.** The read-back `toPhysical` lies within `β_feature` of `p*`.
  - **Invocations.** The NDC bits of each vertex are equal in two separate draws, so the vertex is mapped by two invocations.
  - **Hashes.** The SHA-256 of the offsets the page uploaded equals Node's, and the SHA-256 of the shader source the page compiled equals the hash in the record.
- **E3-PC12** (`perturbedReadback`) moves one read-back position to `p* + 2β(p)` along x, on both paths. The check must then fail. The spec applies it to the real readback, and a unit test applies it to a CPU binary32 stand-in.

### 16.2 The cases before the freeze

The named readback subset of section 7.1 (the rows of E3-C1, E3-C3, E3-C5, E3-C9 and E3-C12 at every transform and pair) is made of corpus cases. Its kernel output may be read only after the freeze (section 5.5). Until then the spec reads back non-corpus cases only:

- the five smoke cases of section 15.6;
- a rectangle at the far translation `2^24` (DPR 2);
- a rectangle at `z = 0.01`, DPR 3;
- a rectangle across the viewport's left and top edges.

E3-U5 switches the spec to the named subset after the freeze note. That is a case list change only.

### 16.3 Record and E3-A6

- **Per-browser record.** Each project writes `.tools/e3-a04-readback/<stamp>/<project>.json` (`e3-a04-gpu-check/v1`). It holds:
  - the browser's version and launch flags, the adapter's vendor, architecture and description, the user agent and the DPR;
  - the shader and WASM SHA-256;
  - the counts, the largest error-to-`β` ratios, the failures, the PC12 outcome and the page errors.
- **Attaching it.** `pnpm e3-a04:run --gpu <chrome.json>,<edge.json>` attaches both files to the record. `combineGpuChecks` passes E3-A6 only when all of these hold:
  - Chrome and Edge are both present and both passed;
  - each ran on the run's shader source and release WASM;
  - neither ran on a software adapter.
- **Software dry run.** `?allowSoftware=1`, set by `E3_A04_READBACK_ALLOW_SOFTWARE=1`, lets the page run on a software adapter to check that it works. Such a record never passes.

### 16.4 Not observed

- **The fixed-function viewport transform.** The check reads NDC, not the rasterizer's pixel position. The viewport transform stays part of the residual of E3-Q7 (section 7.1). `β_vertex` still includes its `γ_3` model term.
- **The `@invariant` position output.** The page carries the helper's result through a flat varying, not through `@builtin(position)`. The invocation check compares two draws of the same entry point. It does not compare the two mesh vertex entry points. Both of them call the same helper (section 7.1).
- **Clipping.** A clipped triangle's new vertices are not read back. The readback next to the viewport edge reads the stored vertices only. The clip model of section 15.3 is therefore not checked against hardware. E3-Q11 (a) asks for that check, and it stays open for E3-U5.
- **Cracks.** Crack widths at T-junctions (E3-C12) need the named subset, so they wait for E3-U5.

### 16.5 Runs

The spec ran on the cloud container's headless Chromium 153 with SwiftShader WebGPU (software, so it is not evidence). The page produced 8 draws and 77 points, with no failures. The largest error was 0.076 of `β_vertex` and 0.118 of `β_feature`, and E3-PC12 was rejected. The page itself is checked by the headed run below.

**Headed run, 2026-10-24.** The spec ran on the user's machine at commit `f856b96`: Windows 11 Pro (build 26200), NVIDIA GeForce GTX 1660 SUPER (driver 32.0.16.1088, adapter `nvidia`/`turing`, not a fallback adapter), and Node v24.15.0.

- **Build.** The release WASM was rebuilt with `pnpm test:geometry`: exit 0, 1,159 tests passed and 6 skipped. Its SHA-256 is `8034d36ba4491616ea250f7e21745a09abe8c2d3f0a2a05903674d4138101d6f`.
- **Result.** Both projects passed in 12.5 s: **Chrome 155.0.8059.85 and Edge 156.0.4314.42, each PASS**. Each read back 8 draws and 77 points, with no failures and no page errors.
  - The largest error was 0.109 of `β_vertex` and 0.118 of `β_feature`.
  - E3-PC12 was rejected in both browsers, on both paths.
  - The shader SHA-256 was `d306137cf0770f6bf7f9237f1c98b9ecd0a165cfdbfda916196d299e36b831a3`.
- **Browser version.** The record's `browser.version` comes from Playwright's `browser.version()`. The `userAgent` field reads 151.0.7922.34 because the `Desktop Chrome` and `Desktop Edge` device presets fix the user agent string, so it is not the browser's version.
- **Scope.** This is E3-A6 on the non-corpus cases of section 16.2. The named subset follows the freeze.

## 17. E3-U2d oracle speed-up and freeze annex, 2026-10-24

Dated append. E3-U2d makes the oracle fast enough that the five `ORACLE-WORK` cases of section 14.8 end within the freeze cap, then runs the freeze. It is the E3-Q6 (a) path of an oracle fix, with no corpus change. Every choice below is **decided under the user's standing instruction of 2026-10-22 (recommended option)**. On 2026-10-23 the user kept the 1.8·10^9 freeze cap and asked for a faster oracle (E3-U2d). No A04 threshold, criterion, cap or work weight changes.

### 17.1 What the five cases needed

- **Four cases reached the cap on sub-arc nodes** (`C9/g0270/T2/z1-d2`, `C9/g0195/T4/z1-d2`, `C9/g0178/T4/z64-d2`, `C9/g0187/T4/z0.01-d2`).
  - A CPU profile of the E3-U2c build shows that every sweep traversal started at the root sub-arc. This held for each cover cell's OUT test, for both of its collections, and for every witness sample point.
  - Counted by call site on `C9/g0187`, the coarse collection of the cover cells was 60 % of the sub-arc nodes, the point samples' collections 14 %, and the fine collections 9 %.
  - The garbage collector took 56 to 62 % of the time, mostly on sub-arcs below the cache depth that are rebuilt for every traversal.
- **`C9/k10/T7/z64-d3` had a line of unresolved cells**, beside the butt corner of the end cap. The cause was not one test but two.
  - The local image of a 2^-4 px cell under T7 (`diag(1, 2^-12)`, so 4096:1) is a strip 6 local units long and 0.0015 wide, longer than the stroke is wide (`r = 9` in the scaled frame).
  - Inside R, a cell next to the corner holds only a thin wedge, about 6 % of the strip. The nine samples missed it, and the normal-segment candidates of section 14.8 used up their node budget on sub-arcs whose normals cross the strip beyond `r`. In a fine grid of 585 exact samples, 37 were inside.
  - Past the corner, a cell is outside R, but its strip holds points within `r` of the end and points on the end normal, and no point that is both. The sub-arc test bounds the distance over the whole strip, so it cannot certify the cell OUT.

### 17.2 Changes, each a sound filter or an exact identity

| Change | What it does | Why it is sound |
| ------ | ------------ | --------------- |
| Sub-arc frontier (`ArcHint`) | A sweep's coarse collection for a polygon P is kept as P's frontier: disjoint sub-arcs that cover every `t` except those certified farther than `r` from P | The certificate is a statement about the true sets: the sub-arc's enclosure is farther than `r` from an enclosure of P. So it holds for every polygon inside P, and such a `t` has no foot within `r` of it |
| Collect first | `CubicSweep.classify` collects to the polygon's size first. The OUT test and the fine collection continue from that collection instead of the root | Starting from the frontier only skips the sub-arcs that are certified far. Every test on the way down is the same sound test |
| Warm start in the cover | A cover cell's classification starts from its parent's frontiers. The root starts from the sub-arc roots | A child cell lies inside its parent. By induction, a cell's class and frontiers are a function of its box alone, however the cover is built |
| Warm start inside a cell | The witness samples and candidates, the seam halves and the halves below start from the cell's own frontiers | Each of them lies inside the cell |
| Frontier cache | The frontiers of at most 2^14 undecided cells are kept, least recently used first. An evicted cell's frontiers are recomputed from its parent's on demand, and charged again | The recomputation is the same classification, so it gives the same frontiers. The charge depends on the order of the run, which is deterministic, never on a clock. A measurement builds its cover in another order, so the freeze work approximates the measurement work, as the freeze already does (section 14.2) |
| Anisotropic witness samples | A cell whose local image has one side 8 or more times the other, and which has an outside sample but no inside one, tries points on its midline along the long local axis: `min(64, 2^⌈log2(long/short)⌉)` of them, so spaced at about the short side up to an aspect of 64 and at `long/64` above it (64 times the short side under T7) | A witness is a function of the box alone. Each candidate is still tested by the certified point test and exact membership |
| OUT by halves | An undecided anisotropic cell at the freeze cell size or below, without a witness, is OUT when both halves along its long local axis miss every piece. The test recurses to a local aspect of about 2, at most 12 levels, and stops at the first half that is not certified. The first half is certified in full before the second is tried, so a cell on `∂R` can cost up to about 2^11 `excludesPoly` calls plus one chain, all charged | Two closed halves cover the cell. A half misses R when every piece's OUT test certifies it (`excludesPoly`). A witnessed cell holds a point of R, so it is never tested |

**The node budget.** The sub-arc budget of 4,096 per test (section 14.2) is unchanged, but a test now starts at a frontier instead of the root. So the refinement that a cell gets adds up over its ancestors, and a kept frontier is not bounded by one budget. Each node is still charged. This changes what the budget limits, not a cap or a weight, and it can change a class only toward a more refined, still sound one.

**Memory.** The cache bounds the number of kept cells, 2^14. Each keeps one frontier per sweep piece, and its sub-arcs below the cache depth stay alive through their parents.

**Scope of the halves test.** It runs only at the freeze cell size and below. Larger cells are refined anyway, so the cost stays with the small cells that the freeze check reads. A larger undecided cell keeps class 0, which is sound.

**Classification is unchanged in practice.** On `C9/g0187` and `C9/g0270` the cover has the same number of cells as before (761,329 and 1,376,069). The rational and structure counts are the same, so the classes are the same. In the tests of section 17.3, the point test from a frontier decides every sample that the root traversal decides. That is observed, not a theorem: the budgets are spent on other nodes.

### 17.3 Tests

`tests/geometry/e3-a04-oracle-u2d.test.ts` adds six tests through `a04CoverSelfTest`, a test-only export.

- **Warm against cold.** It takes random undecided cover cells of four stroke cases, under T0, T4, T6 and T7. In each cell it tests random points and 24 bisection points between the witness pair, which lie next to `∂R`. The point test runs from the frontiers of the cell's own classification from the sub-arc roots, and from the root. Exact membership decides the truth. No point disagrees, the cell classes agree with the samples, every witness is exact, and the warm test decides at least as often as the cold one.
- **The k10 cells.** Three cells across the wedge get a witness. Cells past the corner are certified OUT by halves, and no exact sample inside them is in R.

`pnpm test:e3-a04` passes 113 tests in 6 files.

### 17.4 Results

The oracle is commit `c4a9644`. `a04-region.ts` has SHA-256 `3211486c2417f446f8187d3b26324f72b15378b83274a578317b0b35b65fc0fa`.

**Single cases, on the cloud container** (4 CPUs, Node v22, up to 3 processes). The cap was 6·10^9. Work is in units, `ok` unless stated.

| Case | E3-U2c | With the first warm start (inside a cell) | E3-U2d |
| ---- | ------ | ----------------------------------------- | ------ |
| `C9/g0187/T4/z0.01-d2` | 1.82·10^9, 813 s | 0.94·10^9, 307 s | 0.58·10^9, 225 s |
| `C9/g0195/T4/z1-d2` | 2.80·10^9, 1,290 s | 1.53·10^9, 696 s | 0.92·10^9 (freeze run below) |
| `C9/g0178/T4/z64-d2` | above the cap | 1.68·10^9, 929 s | 1.39·10^9 (freeze run below) |
| `C9/g0270/T2/z1-d2` | above the cap | 1.85·10^9, 836 s | 1.14·10^9, 479 s |
| `C9/k10/T7/z64-d3` | `ORACLE-WORK`, unresolved cell, 0.42·10^9 | `ok`, 0.22·10^9 (anisotropic steps only) | `ok`, 0.19·10^9, 53 s |

- **The anisotropic steps alone, on T7.** On the 43 T7 stroke cases of the stride-25 sample, they leave the work within 20 % of E3-U2c, except `C9/k10` (now `ok`) and `C9/k09/T7/z1-d3` (5.9·10^6 down to 0.7·10^6). A first version that also ran the halves test above the freeze cell size cost 2 to 4 times as much on T7, so it was not kept.

**Stride-25 freeze run.** The machine is the one of section 14.7: Windows 11, 16 logical CPUs, Node v24.15.0, 14 shards. The command was `pnpm e3-a04:freeze --shards 14 --stride 25`. It ran from 04:15:43 to 04:37:28 UTC (21.7 min wall), with case times summing to 3.43 h.

- **1,099 cases: all `ok`.** No case was `ORACLE-WORK`, `ORACLE-UNSUPPORTED` or `ORACLE-INCONSISTENT`.
- **Strata.** C1 188, C2 72, C3 194, C4 69, C5 282, C6 13, C7 5, C8 107, C9 140, C10 1, C11 23 and C12 5 cases. C9 took 10.6 of the 12.3 million case milliseconds and C5 1.6.
- **Work.** The largest was 1.39·10^9 units (`C9/g0178/T4/z64-d2`, 976 s), 77 % of the cap. 43 cases were above 10^8 units and 37 took more than 60 s. The ten largest are all C9, from 0.58 to 1.39·10^9.
- **Time per unit.** Of the ten slowest cases, the highest was 1.24 µs per unit (`C9/g0189/T2/z64-d3`, 852 s for 0.69·10^9 units). That is within the 1.53 µs of section 14.8.
- **Full-run estimate.** 25 times the sample is about 86 CPU hours, about 6 to 7 h on 14 shards.
- The run directory `.tools/e3-a04-freeze/2026-10-24T04-15-44-388Z/` is machine-local and not committed.

### 17.5 Independent review of PR #227, 2026-10-24

A fresh-context review of the diff (`dbbaaeb..367450c`) found **no soundness, determinism or charging defect** (verdict READY WITH FOLLOW-UPS). It checked these arguments against the code: the frontier, the reorder of `classify`, the warm start, the cache and the halves. Disposition, decided under the user's standing instruction of 2026-10-24 (recommended option):

- **Applied here, in this section's text.**
  - The cost of the halves test.
  - The sample count above an aspect of 64.
  - The changed meaning of the node budget, and memory.
  - That "decides at least as often" is observed, not proved.
  - That freeze work only approximates measurement work.
- **Deferred to the first oracle change after the freeze.** The full freeze run pins the oracle SHA `3211486c…0fa`, so its source does not change before the freeze record. Three items wait for that change:
  - `a04CoverSelfTest` should also use the cover's own frontiers, inherited and recomputed after eviction (`arcsOf`), and compare the cover's classes with the cold class and exact membership. An injectable cache size would let a test force eviction.
  - Two code comments repeat the overstatements corrected above (the halves cost and the sample spacing).
  - `splitPoly` builds the merged frontier map twice.

## 18. E3-U2e oracle fixes and freeze annex, 2026-10-25

Dated append. The full freeze run of section 17 (oracle `c4a9644`) did not pass. E3-U2e fixes the oracle so that every failed case ends within the freeze cap, then runs the full freeze again. It is the E3-Q6 (a) path of an oracle fix, with no corpus change. No A04 threshold, criterion, cap, work weight or freeze parameter changes. Choices are **decided under the user's standing instruction of 2026-10-24 (recommended option)**. On 2026-10-25 the user chose the full re-run over a run of the heavy cases and a stride sample.

### 18.1 The full run of section 17

The run used oracle `c4a9644` (SHA-256 `3211486c…0fa`) on the machine of section 17.4, with 14 shards. It took 8.2 h wall and 107 CPU hours.

- **27,399 `ok`, 58 `ORACLE-WORK`, 2 `ORACLE-ERROR`.** The 3 `not-drawable` cases are `C10` x01, x02 and x05, as section 6 expects. They are not failures.
- **Where the time went.** The 1,064 cases at or above 10^8 units took 85 % of it.
- **The failures.**
  - The two `ORACLE-ERROR` cases (`C9/k03` and `C9/k04` at T7) were a pseudo-division defect.
  - Seven `C5` cases had a cell left unresolved (`l18`, `l78`, `g0090`, `g0141`).
  - The rest were `C9` strokes at the cap, mostly under T6 and T7 (`k19`, `k22`, `g0154`, `g0178`, `g0186`, `g0207`, `g0209`, `g0249`, `g0290`, `g0291`), plus `C7/k05/edge/z64-d3`.
  - The ids are in [d9-e3-a04-freeze-failures-2026-10-24.txt](d9-e3-a04-freeze-failures-2026-10-24.txt) (60 ids).
  - The 51 ids still failing after the first fixes are in [d9-e3-a04-freeze-failures-2026-10-24b.txt](d9-e3-a04-freeze-failures-2026-10-24b.txt).

### 18.2 Changes, each a sound filter or an exact identity

| Change | What it does | Why it is sound |
| ------ | ------------ | --------------- |
| Pseudo-division | `zpdivmod` pads the remainder before the subtraction loop | A remainder that dropped more than one degree had holes, and BigInt arithmetic on a hole threw. With the padding, `lc^(δ+1)·a = q·b + r` holds. `a04PseudoDivisionSelfTest` checks it on random pairs |
| Pair split | An undecided polygon whose open pieces include two convex pieces, with crossing edges not within 8° of parallel, is split along the bisector of the two edges, through the point nearest the polygon's center. It is IN when both halves are | The halves cover the polygon for any line. The split uses the seam budget and depth of section 14.5 |
| Outside samples (anisotropic) | An anisotropic cell with an inside sample and no outside one tries the midline candidates of section 17.2 for an outside point | A candidate is tested by exact membership |
| IN by halves | The mirror of OUT by halves (section 17.2), for an undecided anisotropic cell at the freeze cell size or below | Two closed halves cover the cell. A half is IN when `classifyPoly` certifies it |
| Halves before candidates | When the nine samples of such a cell are all on one side, that side's halves test runs before the candidate search for the other side | A cell certified by halves holds no point of the other side, so the search would fail. The outcome is the same |
| Integer polygons | `insideUnion` builds its lines as integer cross products of homogeneous vertices, and reads zero area as fewer than three edges | Each line is a positive multiple of the rational one, so its orientation is kept |
| Point stages | A point is refined in stages to `r·2^-8`, `2^-16` and `2^-24`, each from the last. The OUT and IN tests run after each stage | The last stage is the former single collection. "Decided whenever it was before" is observed, not proved: the budgets are spent differently |
| Sample cache | Witness samples are kept by position, at most 2^16 | A sample's value is its membership in the closed region, whichever frontiers its test started from |
| Footless sub-arcs | A sub-arc whose sweep equation keeps one sign over a polygon is recorded with that sign. Collections and tests for polygons inside it reuse the sign | The sign holds over an enclosure of the polygon, so over every polygon inside it. Known nodes skip the budget decrement, so a collection can differ from before, and it stays sound |
| Approximate normals | Normal-segment candidates use float Horner on rounded coefficients and skip footless sub-arcs | Candidates only: each is tested by exact membership |
| OUT by the local hull | The OUT test bounds the distance between a polygon and a sub-arc's box by the box distance, and also by the separations along the polygon's edge normals and the center direction (`hullBoxDistLo`) | A linear form's minimum over the hull is at a vertex, and its maximum over a box is at a corner. Each separation, divided by an upper bound of the direction's length, is a lower bound on the distance. Under T6 a cell's local image is a skewed parallelogram far smaller than its box. The box distance left outside cells beside a foot undecided, and the freeze check descended below them |
| Coarse-only and deep-OUT cells | Cover cells above the freeze cell size skip the finer collection. Freeze-size cells refine the OUT test 16 times finer | Each changes only how far a test refines |
| Sample order | Witness samples try the kept samples first, then the corners and edge middles, which neighbouring cells share, then the center | Whether a witness exists depends only on the box. Which samples form it can depend on the kept samples |
| Neighbour test | `nearBoundary`, the "witnessed or opposite-class neighbour" of the freeze cell size rule (section 14), tests the neighbours already in the cover first, the uniform ones before the witness searches, and the center's class only for a uniform neighbour | An OR over the same eight neighbours. The outcome is the same |
| Pruned descent | Below the last of the 12 levels, the point-like descent drops the cells without unwitnessed children before the neighbour test | Such a cell adds no children, so every next level is the same. The pruning runs only when the level has at most 4,096 cells, so the 4,096 test is the same. The last level is filtered in full, so the final 16-cell test is the same. The pruning can cost more: it builds the children of cells that the neighbour test would drop. The work is charged |

### 18.3 Tests

`tests/geometry/e3-a04-oracle-u2e.test.ts` adds seven tests through `a04CoverSelfTest` and `a04PseudoDivisionSelfTest`. They cover the pseudo-division, pair splits on `g0090` and `g0141`, outside samples on `l78` and `l18`, IN by halves on `k22`, and OUT by the local hull on a `C9/g0249/T6` cell. Without `hullBoxDistLo` that cell stays undecided. `pnpm test:e3-a04` passes 120 tests in 7 files.

### 18.4 Results before the full run

Work is in units, at the 1.8·10^9 cap unless stated.

| Case | Before | After |
| ---- | ------ | ----- |
| `C9/g0249/T6/z1-d2` | 2.32·10^9 with no cap (oracle `249a4e6`) | 0.65·10^9 |
| `C9/g0154/T6/z64-d3` | at the cap | 1.60·10^9 |
| `C9/g0154/T6/z0.01-d3` | 1.99·10^9 with no cap (oracle `60dfb98`) | 1.62·10^9 |
| `C9/k22/T7/z64-d3` | at the cap | 0.73·10^9 |
| `C7/k05/edge/z64-d3` | at the cap | 0.70·10^9 |

- **Profile of the T6 cases.** On `C9/g0249/T6/z1-d2`, 82 % of the work was the point-like descent below freeze cells without a witness. In a sample of 80 such cells, 79 were outside R by exact membership. Most were 0.02 to 0.05 local units outside, beside a foot.
- **Rerun of the 51 ids** on the user's PC, oracle `60dfb98`, 8 shards: 50 `ok` and 1 at the cap (`C9/g0154/T6/z0.01-d3`, fixed above). It took 1.5 h wall.

### 18.5 Independent review, 2026-10-25

A fresh-context review of `9a72534..0d0bf50` found **no soundness defect** (verdict READY WITH FOLLOW-UPS). It checked the arguments above against the code. Disposition, decided under the user's standing instruction of 2026-10-24 (recommended option):

- **Applied here.**
  - The pruned descent can cost more than before, and its outcome is the same only below the cap.
  - The point stages and the footless sub-arcs are observed, not proved, to decide whenever they did before.
- **Applied in the freeze tool**, which is not part of the oracle SHA.
  - A listed id that is not a corpus case is now an error.
  - `--ids` without a file is an error.
  - `--ids` with `--stride` is an error.
- **Time per unit.** The integer lines of `zClip` no longer drop their gcd, and `hullBoxDistLo` adds float work per sub-arc unit. So the time per unit is checked against the 1.53 µs of section 14.8 on the slowest cases of the full run (section 18.6).
- **Deferred to the first oracle change after the freeze.** The full run pins the oracle SHA, so its source does not change before the freeze record.
  - Two comments overstate. Near the point stages, "decided whenever it was before" should say observed. In `collectNodes`, "the same outcome at no cost" should note the budget.
  - The pruned descent's comment says "superset" where the pruned set is a subset of the level.
  - The section 17.5 items: `a04CoverSelfTest` should use `arcsOf`, the two comments named there, and `splitPoly` building the merged frontier map twice.

### 18.6 Full freeze run

The oracle is commit `0d0bf50`. `a04-region.ts` has SHA-256 `aad4b5829989b191250adca44c18d4658dc38fb21814c897578630a6dde1fb00`. The run is `pnpm e3-a04:freeze --shards 8` on the machine of section 17.4 (31.9 GB RAM, so 8 shards). It started at 04:41:55 UTC on 2026-10-25, with output in `.tools/e3-a04-freeze/2026-10-25T04-41-55-181Z/`.

It ended at 11:37:28 UTC, after 6.93 h wall, and every shard exited with code 0.

- **All 27,462 cases were checked: 27,459 `ok` and 3 `not-drawable`.** No case was `ORACLE-WORK`, `ORACLE-UNSUPPORTED`, `ORACLE-INCONSISTENT` or `ORACLE-ERROR`. The 3 `not-drawable` cases are the `C10` inputs that section 6 expects: `x01` and `x02` (`det L = 0`) and `x05` (`w = 0`).
- **Strata.** These are case counts, all `ok` except in C10.

  | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 | C11 | C12 |
  | -- | -- | -- | -- | -- | -- | -- | -- | -- | --- | --- | --- |
  | 4,680 | 1,800 | 4,860 | 1,728 | 7,038 | 324 | 108 | 2,682 | 3,510 | 12 | 576 | 144 |

- **Time.** Case times sum to 52.9 h, against 107.0 h for the run of section 18.1. C9 took 151.0 million of the 190.3 million case milliseconds, and C5 35.5 million.
- **Work.**
  - The largest was 1.62·10^9 units (`C9/g0154/T6/z0.01-d3`, 1,895 s), 90 % of the cap.
  - The next were `C9/g0154/T6/z64-d3` at 1.31·10^9 and `C9/g0154/T6/z1-d3` at 1.31·10^9.
  - Then `C9/g0252/T7/z0.01-d3` at 1.11·10^9 and `C9/g0260/T0/z0.01-d3` at 1.08·10^9.
- **Time per unit.** Of the ten slowest cases, the highest was 1.27 µs per unit (`C9/g0154/T6/z64-d3`, 1,670 s for 1.31·10^9 units). The lowest was 1.01 µs. Both are within the 1.53 µs of section 14.8.
- The run directory is machine-local and not committed. It holds 27,462 shard lines with 27,462 distinct ids.

**Freeze record** (2026-10-25): the A04 corpus `a04-corpus/v1` with `corpusSha256` `7f4bb1c97b2358ef45d23fdcab31aadc35fe4e7d3d5de25ce1bea7a8203d721c` is frozen.

- Generator `tests/geometry/e3-a04/corpus.ts` SHA-256: `3c4f12991f0554cad2dde1d96eb549cb343b6ecee3e24539e8083320e7e0d438`.
- Oracle `packages/geometry-reference/src/a04-region.ts` SHA-256: `aad4b5829989b191250adca44c18d4658dc38fb21814c897578630a6dde1fb00` (commit `0d0bf50`).
- 27,462 cases, with the strata counts above.
- Freeze check: passed. There were 27,459 `ok`, 3 `not-drawable` (C10, section 6) and no `ORACLE-*` case. The largest work was 1.62·10^9 units, against a cap of 1.8·10^9.
- No kernel output on the corpus was inspected before this record (section 5.5).

## 19. E3-U5 measurement annex, 2026-10-25 (in progress)

Dated append. E3-U5 is the reference run of section 9.1, after the freeze of section 18.6. Choices below are **decided under the user's standing instruction of 2026-10-24 (recommended option)**. No A04 threshold, criterion, cap, work weight or corpus case changes. This section records the work so far. The reference run itself has not been made.

### 19.1 The GPU model check on the named subset

The spec now reads back, after the non-corpus cases of section 16.2, the named subset of section 7.1. That is the named rows of E3-C1, E3-C3, E3-C5, E3-C9 and E3-C12 at every transform and pair. E3-C6 is added for the clip readback. The subset holds 13,364 corpus cases, drawn in chunks of 64. Joint cases of E3-C9 are drawn with their partner, as the measurement draws them.

- **Clip readback (E3-Q11 (a)).** For a draw that the GPU clips, the page also rasterizes the mesh at `meshPositionNdc` into an `r32uint` target of the frame's size, with one sample at each pixel centre. It returns the coverage of a 4 px strip along the viewport edge.
  - `clipCheck` requires the GPU to cover a centre exactly when `M*` contains it. This applies to centres farther than `β_c` plus the snapping residual from every boundary candidate of `M*` and from every edge of a clipped triangle. The snapping residual is `√2·2^-5` px, Vulkan's minimum of 4 subpixel bits, E3-Q7 (a).
  - The clipped-triangle edges are left out because clipping makes new vertices per triangle. A shared clipped edge can therefore open a hairline crack within the clip bound. The SwiftShader dry run saw such cracks. The crack-closed region of E3-Q10 (b) does not score them.
  - A draw that `measureCase` makes UNDECIDED for `β` is counted but not compared. That covers `β_c ≥ 1` px and a clip bound of 0.25 px or more.
  - As E3-Q11 (a) states, agreement confirms the model only to pixel resolution. A mismatch falsifies it.
- **Cracks (E3-Q10 (b)).** At each T-junction of `M*`, found exactly on `p*`, the record gives the read-back distance of the T-vertex from its edge. It is reported, never gated.
- **Dry run.** The spec was run on the container's SwiftShader. That is software, so it is not evidence (section 16.3).
  - 11,545 draws and 1,211,506 points, with no failure.
  - The largest error-to-`β` ratios were 0.19 on the vertex path and 0.37 on the feature path.
  - 2,644 clipped draws were compared over 41.1 million pixel centres with no mismatch. 591 clipped draws were not measurable for `β`.
  - There were 159,636 T-junctions. The largest crack was 7.7·10^-4 px, on `C9/k26/T2/z64-d2`.
  - The headed run on the user's machine waits for main after E11's PR #242, which makes the WASM SHA host-independent.

### 19.2 Starting resolution

`pnpm e3-a04:run --start-resolution K` starts the oracle at `2^-K` px instead of `r_m = 2^-10` (section 4.3). The default stays `K = 10`. The record's selection names `K`.

- **What does not change.** The oracle still halves the resolution while `E` straddles a threshold, down to the floor `2^-20`. So PASS (`U ≤ 0.25`), FAIL (`L > 0.25`) and UNDECIDED are decided by the same rule. A coarser start widens the reported intervals, never past `2^-K` plus `β_c` for a PASS case.
- **The cost.** On two `C1` cases, `K = 6` took 6 s and 55 s, against 78 s and 109 s at `K = 10`. `K = 4` took 2 s and 23 s.
- **`K = 2` (2026-10-25).** The stride-200 container sample of section 19.4 gave the same status and reason at `K = 2` as at `K = 6` on every one of its 138 cases (81 PASS, 0 FAIL, 27 UNDECIDED, 24 rejected, 6 `window-empty`), in 24 CPU minutes instead of about 150. Its max `U` is 0.2499 px and its p50 `U` 0.148 px, against 0.080 px at `K = 6`, which is the looser bound of the next item. A full run at `K = 2` is about 80 container CPU hours, plus the heavy stroke cases of section 19.5.
  - **Decided 2026-10-25 (standing rule, recommended option).** The freeze-check-certified reference run uses `K = 2`, given on every host as `--start-resolution 2`. The tool's default stays `K = 10`, and the merge refuses hosts whose `K` differs. The status of every case is decided by the same rule, and the cost is about a sixth. The U statistics of the record are upper bounds at the resolution that decided each case.
- **The departure.** The section 7.3 statistics (p50, p99 and max `U`) are upper bounds that are looser by up to `2^-K`. This is recorded for the evidence review.

### 19.3 Oracle defect found by the first sample (E3-R2)

The PC sample of section 19.4 reported `C1/s15-I/T3/z64-d2` as FAIL with `E = 384` px. Its kernel mesh is exactly `R`: the union of the squares `[0, 16]²` and `[8, 24]²`, nonzero, as eight triangles of the same area.

- **The cause.** `buildArrangement` cut its curves only at crossings with curves that meet the index region (`Ω ⊕ 1` plus the 64 px margin). A kept edge that extends beyond the region was not cut where a dropped edge crosses it outside the region, so its one portion was classified at its midpoint. Here the top edge of the first square runs through the window inside the second square, and its midpoint lies on the second square's left edge, outside the region. The edge was taken as `∂R`, and `B_R` scored it at 384 px. `C1/s15-I/T4/z64-d2` gave 512 px the same way.
- **The fix.** Each kept piece is now also cut at its crossings with the dropped pieces whose boxes meet it. Those are the pieces of curves outside the region, filtered by the hull of the kept boxes. They are recorded on the kept piece only. A dropped piece has a different parameter range from every kept piece, so no crossing is counted twice, and same-origin pieces stay with `selfIntersections`.
- **The test.** `tests/geometry/e3-a04-oracle-u5.test.ts` measures that case on the exact union. It is `window-empty`, because the window lies inside `R` and `M`. Without the fix it is FAIL. A mesh missing two triangles stays FAIL. `pnpm test:e3-a04` passes 125 tests in 8 files. On the `z = 64` rows of `s15` and `s16`, 42 measured with the fix gave no FAIL.
- **Consequence (E3-R2 and section 4.2).** This is a new oracle version, and it needs a full freeze check before a measurement on it counts.
  - The run tool now refuses a stride-1 corpus run on an oracle whose SHA-256 has no freeze check record in this contract.
  - A strided sample may still run. Its record names the oracle as uncertified, and the verdict gives that as a reason.
  - Records made on the oracle of section 18.6 are superseded. No such record was committed.

### 19.4 Samples (not evidence)

| Run | Machine and WASM | Selection | Result |
| --- | ---------------- | --------- | ------ |
| Container | Linux build of the kernel (cost estimate only) | Stride 200, 138 cases, `K = 6`, oracle of section 18.6 | 108 measured: 81 PASS, 0 FAIL, 27 UNDECIDED. Also 24 rejected and 6 `window-empty`. Max `U` 0.080 px. 83 min wall on 3 shards |
| Container | Linux build at `e84cceb` | Stride 200, 138 cases, `K = 2`, oracle of section 19.3 | Same statuses as the `K = 6` row. Max `U` 0.2499 px. 24 CPU min, 17 min wall on 2 shards |
| PC | Release WASM `0bc67a3a…7373`, commit `4e18e58` | Stride 25, 1,099 cases, `K = 6`, oracle of section 18.6 | At 978 cases: 542 PASS, 3 FAIL, 238 UNDECIDED, 164 rejected, 31 `window-empty`. Max `U` on a PASS 0.137 px. Shard 2 died after 104 cases (section 19.5); its other cases were measured in the container at `K = 2` |

- **Cost.** The container sample took about 1.1 CPU-min per case, and 3.2 min per `C5` stroke case. A full run at `K = 6` is about 600 container CPU hours, or about two days on the PC.
- **UNDECIDED.** About a quarter of the measured cases are UNDECIDED. The reasons are known before the reference run, and they keep A04 UNVERIFIED under section 7.3 until they are remedied:
  - The no-flip certificate (section 15.4) fails on sub-pixel or sliver triangles, mostly at `z = 0.01` and under T4, T6 and T7.
  - `β_c ≥ 1` px or a clip bound of 0.25 px or more comes from far vertices at `z = 64`. These are the far-offscreen vertices of E3-R3, the K4 carrier's class A limitation.
  - `window-empty` within the guard (section 15.5).
- **FAIL.** `C1/s15-I/T3/z64-d2` was the oracle defect of section 19.3: on the fixed oracle it is `window-empty`. `C4/n07/T5/z64-d3` (`L` 1536 px) and `C4/n23/T2/z64-d3` (`L` 768 px) stay FAIL on the fixed oracle. Both are the collapsed sub-tolerance features E3-R3 predicted: the mesh closes a `2^-16` px gap (n07) or slit (n23), and `B_R` is half the feature's length at that scale. They are kernel results, not oracle defects.
- **UNDECIDED in the PC sample.** No-flip certificate 196, `β_c ≥ 1` px 22, `window-empty` within the guard 9, clip bound 5, zero-area triangle 5, gcd-step work cap 1.
- **Next.** The remedies go to the user with these results (E3-R3). After that come the freeze check of the new oracle, the headed GPU check, and the reference run on the E11 exit snapshot. The snapshot now waits for the E16 fill remedy.

### 19.5 A worker that dies

- **What happened.** The stride-25 sample lost one shard of six. Its worker ran out of its 6 GB heap on `C5/l36/T6/z64-d3` (corpus position 15650), and the shard's 79 remaining cases were never measured.
  - The oracle's lazy stroke cover (section 15 of `a04-region.ts`) keeps every cell it builds, about 1.3 KB each. At `K = 6` the distance queries along a stroke boundary thousands of pixels long build cells faster than the work cap charges for them, so the heap fills before the work cap is reached.
  - At `K = 2` the same case is a PASS after 6 minutes in the container (`E ∈ [0.00095, 0.126]`, `β_c = 0.043`).
- **The rule.** A heap limit is not an exception the harness can catch, so section 7.3's rule for harness exceptions is applied by the tool:
  - Before each case, a shard writes the case's corpus position to `shard-<i>.current`.
  - When the worker exits non-zero, `pnpm e3-a04:run` starts the shard again after that case. The case gets an UNDECIDED row with reason `harness-error: worker exited (code …) while measuring`, unless its row was already written. A shard is restarted at most 64 times, and never twice at the same position.
  - `pnpm e3-a04:freeze` does the same. There the case is `ORACLE-ERROR`, which fails the freeze check (E3-Q6 (a)).
  - The record's provenance lists each shard's exit code and restarts (`shardExitCodes`, `shardRestarts`, indexed by shard), and so does the freeze summary. A restart names the position and the exit code. Any non-zero exit counts, so a harness bug outside a case's measurement shows up as restarts with code 1, not as a failed shard.
- **No oracle change.** The cover cache is not bounded in the oracle. A bound would only turn these cases into `ORACLE-WORK`, which is UNDECIDED too. The remedy for the cost is the starting resolution of section 19.2.

### 19.6 One run on several hosts

- **Decided 2026-10-25 by the user.** The full freeze check and the reference run may be split across cloud containers and the PC, to bring the PC's two days down to under one.
- **How.** Every host runs the same global shard count `N`, on the same commit, release WASM and options, with `--only` and its own shard indices. One host then runs `--merge` on every host's run directory.
  - The merge refuses when any host differs from the merging checkout in commit, dirty state, contract, corpus, generator, oracle or WASM SHA-256, `N`, stride or `K`.
  - It also refuses when a shard is missing or appears twice.
  - It then finalizes as a single-host run does. The record's provenance lists each host's run id, Node version, OS, CPU count, shards, exit codes and restarts.
  - `pnpm e3-a04:freeze` takes the same `--only` and `--merge`. Its summary names the oracle SHA-256 and commit, and lists the hosts.
- **WASM.** Since E11 PR #242, a Linux build of the pinned toolchain gives the same release WASM as the PC. The merge compares WASM hashes, so a host whose build differs cannot take part.
- **Checkouts.** Each host's run directory stays under `.tools/`. A copy inside the tracked tree makes the merging checkout dirty, and the merge then refuses.
- **Memory.** A container has 15 GB and every shard gets a 6 GB heap, so a container runs two or three shards.

### 19.7 Freeze check of the fixed oracle

The oracle of section 19.3 got its full freeze check, split across two hosts as section 19.6 allows. It is commit `d7bd7ad`, where `a04-region.ts` has SHA-256 `5b2fafc3708a08ceb6ed5c5e0ce498ac6c23720f8a8d718425a94a7e17724e80`. The check ran as `pnpm e3-a04:freeze --shards 20` with `--only` on each host:

- the PC of section 17.4 ran shards 0 to 7, from 21:54 UTC on 2026-10-25, in 2.36 h wall;
- the user's laptop (Windows, 20 threads, 39.6 GB RAM) ran shards 8 to 19, from 21:57 UTC, in 2.25 h wall;
- both used Node 24.15.0, and every shard exited with code 0, with no restart.

The shard files came back through transfer branches, and `--merge` combined them in a cloud container checked out at `d7bd7ad`. The merge refuses hosts with a different oracle, commit or shard plan.

- **All 27,462 cases were checked: 27,459 `ok` and 3 `not-drawable`.** No case was `ORACLE-WORK`, `ORACLE-UNSUPPORTED`, `ORACLE-INCONSISTENT` or `ORACLE-ERROR`. The 3 `not-drawable` cases are the `C10` inputs of section 18.6.
  - The strata counts are those of section 18.6, and every case is `ok` outside C10.
  - The run holds 27,462 shard lines with 27,462 distinct ids.
- **Time.** Case times sum to 42.0 h. C9 took 32.9 h of them and C5 8.2 h.
- **Work.**
  - The largest was 1.62·10^9 units (`C9/g0154/T6/z0.01-d3`), 90 % of the cap, as in section 18.6.
  - The next were `C9/g0154/T6/z64-d3` at 1.31·10^9 and `C9/g0154/T6/z1-d3` at 1.31·10^9.
  - The new kept-by-dropped cut pass of section 19.3 did not raise the largest work.
- **Time per unit.** Of the ten slowest cases, the highest was 1.07 µs per unit (`C9/g0240/T0/z1-d3`) and the lowest 0.84 µs. Both are within the 1.53 µs of section 14.8.
- The merged directory is `.tools/e3-a04-freeze/2026-10-26T01-00-55-201Z/` in the merging container. It is machine-local and not committed.

**Freeze record** (2026-10-26): the A04 corpus `a04-corpus/v1` with `corpusSha256` `7f4bb1c97b2358ef45d23fdcab31aadc35fe4e7d3d5de25ce1bea7a8203d721c` stays frozen. Its freeze check is repeated on the fixed oracle.

- Generator `tests/geometry/e3-a04/corpus.ts` SHA-256: `3c4f12991f0554cad2dde1d96eb549cb343b6ecee3e24539e8083320e7e0d438`. Unchanged.
- Oracle `packages/geometry-reference/src/a04-region.ts` SHA-256: `5b2fafc3708a08ceb6ed5c5e0ce498ac6c23720f8a8d718425a94a7e17724e80` (commit `d7bd7ad`).
- 27,462 cases, with the strata counts of section 18.6.
- Freeze check: passed. There were 27,459 `ok`, 3 `not-drawable` (C10, section 6) and no `ORACLE-*` case. The largest work was 1.62·10^9 units, against a cap of 1.8·10^9.
- Kernel output on the corpus was inspected before this record, in the samples of section 19.4. The corpus did not change, so section 5.5 still holds: the corpus was frozen before any kernel output was seen. The oracle fix, unlike the corpus, is not blind: it was found from kernel output (section 19.3).

**Oracle withdrawn** (2026-10-26, E3-R2): `aad4b5829989b191250adca44c18d4658dc38fb21814c897578630a6dde1fb00`, the oracle of section 18.6, has the soundness defect of section 19.3. `pnpm e3-a04:run` treats it as uncertified.


## 20. E3-U6 flip-tolerant bound annex, 2026-10-26

The samples of section 19.4 left 219 cases UNDECIDED on the no-flip certificate of section 15.4. Most are meshes with a triangle thinner than about `2β_c`. For example, `C1/g0046/T7/z64-d1` has a strip 1.5·10^-5 px high, against `β_c = 3.7·10^-4`. No certificate on the triangle alone can hold there, because a `β_c` move can flip it. This annex replaces "UNDECIDED on the certificate" by a bound that tolerates flips, under stated preconditions. It is harness code only (`flipTolerantBound` in `tests/geometry/e3-a04/harness.ts`). The oracle does not change, so the freeze record of section 19.7 stands.

### 20.1 When it applies

The harness tries the bound only when the no-flip certificate fails and no triangle crosses the guard band (section 15.3). Clipped triangles are outside its argument. It applies when all of these hold, all checked exactly on `M*` without its collapsed triangles:

1. **One orientation.** Every triangle of positive area has the same orientation. A triangle of zero area (three distinct collinear points) covers nothing in `M*`, but it stays in the chain below: on the GPU it can open into a thin triangle. Each zero-area triangle whose box meets `Ω ⊕ 3` must have its segment covered by collinear edges of triangles of positive area, so that the segment is in `M*`. The kernel emits such triangles folded onto a boundary edge.
2. **The chain near the window is `∂M*`.** The chain is every directed triangle edge, with `a → b` and `b → a` between the same two `p*` cancelling. `C*` is the union of the edges whose count does not cancel. Zero-area triangles count here. A zero-area triangle that closes a T-junction cancels both sides of it exactly. For every chain edge `ab` whose box meets `Ω ⊕ 3`:
   - the collinear edges of positive-area triangles that overlap it cover it, and their triangles all lie on one side of it;
   - no open triangle of `M*` meets the open edge.
3. **The outside is reachable.** Every candidate edge whose box meets `Ω ⊕ 2` passes the offset certificate of section 20.3, with offsets at most 0.5 px.

Otherwise the case stays UNDECIDED on the no-flip certificate. The row records why under `flipTolerant.reason`.

### 20.2 The bound

Let `f_t` move each vertex in a straight line from `p*` to its GPU position, `0 ≤ t ≤ 1`. Every point of an edge then stays within `β = β_c` of the edge at `p*`.

- **Winding.** The oriented triangle boundaries sum, as a 1-chain, to the edges of `C*` alone. A pair `a → b`, `b → a` cancels at every `t`, because equal `p*` means equal stored offsets, and so bit-identical GPU positions (section 7.1). So the winding number `w_t(x)` of the moving mesh is constant in `t` for `dist(x, C*) > β`.
- **Inside.** At `t = 0`, `w_0(x)` is the number of triangles of positive area that cover `x`, with the sign of precondition 1, so it is nonzero for `x ∈ M*` off `C*`. Then `w_1(x) ≠ 0`, and some GPU triangle contains `x`.
- **Outside.** `M_gpu ⊂ M* ⊕ β` holds unconditionally: a point of a GPU triangle has a partner with the same barycentric coordinates in the `M*` triangle, at most `β` away. A zero-area triangle's image is within `β` of its segment, which is in `M*` by precondition 1. If `x ∈ M_gpu` and `x ∉ M*`, then either `x` is within `β` of `C*` or the nearest point of `M*` is on `∂M*`, within `β`. And `∂M* ⊂ C*`, because `w_0` is 1 or more on one side of a point of `∂M*` and 0 on the other, so it changes there, and `w_0` changes only across `C*`. So `dist(x, C*) ≤ β`.

Hence `M_gpu △ M* ⊂ C* ⊕ β` and `∂M_gpu ⊂ C* ⊕ β`. By precondition 2, `C* = ∂M*` within `Ω ⊕ 3`, which covers every window the terms use. A point `p` of such an open edge is in `M*`, by the covering edges. A triangle that has points near `p` on the other side contains `p`. It cannot contain `p` in its interior, along a collinear edge (that triangle lies on the covered side), or on an edge that crosses the line (its interior would then meet the open edge). So it has `p` as a vertex, and its wedge there misses the directions along the edge, which leaves points off `M*` arbitrarily near `p`. So:

- **`G` and `B_M` of `E(M_gpu, M*)`** are at most `β`.
- **`B_R`.** A point `p ∈ ∂M*` is within `β` of `M_gpu`: its own triangle's image covers the partner point. It is also within `D(p)` of a point `x ∉ M*` with `dist(x, C*) > β`, and such an `x` is off `M_gpu`. The segment between the two crosses `∂M_gpu` inside the disk of radius `max(β, D(p))` around `p`.

So `E_Ω(M_gpu, M*) ≤ ρ` with **`ρ = max(β_c, D_hi)`**. Here `D_hi` bounds `D` on `∂M* ∩ (Ω ⊕ 2)`. Since `ρ ≤ 0.5 < 1`, the windowed inequality of E3-K4 needs `M*` against `R` only on `Ω ⊕ ρ`, inside the oracle's window `Ω ⊕ 1`, and the case uses

**`U = E_hi + ρ`** and **`L = max(0, E_lo − ρ)`**,

with the oracle's early exits at `0.25 ∓ ρ`. Without flips the no-flip path of section 7.1 still applies with `β_c`, and `ρ ≥ β_c` is never smaller.

### 20.3 The offset certificate for `D`

For each candidate edge whose box meets `Ω ⊕ 2`, the harness looks for a translate of the edge away from its triangles. It tries 0°, ±30°, ±60° and ±75° from the outward normal, and offsets `s` from `1.0625·β` upward by factors of `√2`, up to 0.5 px.

- **Accepting a translate.** A translate `S` is accepted when two things hold. First, it is more than `β` from every candidate edge. Then `S` lies in one component of the complement of `C*`, so it is wholly inside or wholly outside `M*`. Second, one exact point test finds its midpoint outside `M*`.
- **The bound.** Each point of the piece then has its translate in `X_out`, at distance `s`. So `D ≤ s`, plus the allowance below.
- **Splitting.** If no translate of a piece passes, the piece is halved, to depth 12 and no shorter than `β/4`. Splitting handles the ends of an edge at a reflex corner. A gap narrower than `2β` between two parts of the boundary has no point of `X_out`, so the certificate fails there.
- **Exact and inexact parts.** The point test and the preconditions are exact over the dyadics. The distances and offset points are binary64, evaluated from coordinates of magnitude at most `k`. They carry an allowance of `2^-30·(1 + k)`, which is far above their few roundings. `ρ` is rounded up with the slack of section 15.2.
- **Lookup.** Triangles and chain edges are found through a grid of 8 px cells over `Ω ⊕ 8`. A box off the grid is clamped into its border cells, so a lookup anywhere, also for a translate or a midpoint off the grid, sees every item whose box meets it. The independent review found that dropping such boxes instead let two long slabs 10^-5 px apart pass the certificate (a regression test keeps it).
- **Work.** The certificate stops at 5·10^7 work units, and the case then stays UNDECIDED.

### 20.4 Tests

`tests/geometry/e3-a04-flip-tolerant.test.ts` covers these cases:

- a square fanned around a vertex 10^-5 px above its bottom edge, which the no-flip certificate fails and the bound covers with `ρ` within 10 % of `β`;
- an L shape with a reflex corner;
- each precondition failing: a dangling zero-area triangle, mixed orientation, a triangle across a boundary edge, and an edge with triangles on both sides, whole or along part of it. A triangle that touches a boundary edge at one vertex is covered. There is also a 10^-4 px gap between two squares;
- a zero-area triangle folded onto a boundary edge, in both orientations, which the bound covers;
- a T-junction closed by a zero-area triangle, which the bound covers, and the same mesh without that triangle, which it refuses. Its long edge then has triangles on both sides;
- a sampled check that random vertex moves of at most `β` change membership only within `ρ` of `∂M*`, with the sliver flipped in half of the trials.

### 20.5 Effect on the samples

The sample of section 19.4 is re-measured with the bound, on the cases it left UNDECIDED on the no-flip certificate with no clipped triangle. That is 168 of its 202 such cases; the other 34 clip, so the bound does not apply. The re-run was on 2026-10-26, in a cloud container, at K = 2, with the kernel at `d7bd7ad` and the code of this annex. These are samples, not evidence (section 19.4).

- **Measured: 162 of the 168.** One C9 case was still in the oracle after 2 h, and 5 were queued behind it on the same worker.
- **PASS: 132.** By stratum: C1 21, C2 11, C3 15, C4 9, C5 54, C8 6, C9 15 and C11 1. One of them, a C9 case, no longer fails the certificate on the current kernel, so it passes on `β_c`. The other 131 pass on `ρ`, with a median `ρ` of 1.6·10^-3 px and a largest of 0.248 px. The largest `U` is 0.2499 px.
- **Still UNDECIDED: 30.**
  - 15 have a zero-area triangle off `M*` (C1, C3, C5, C8, C9);
  - 7 have a chain edge with triangles on both sides, a T-junction left open (C1, C5, C9);
  - 5 fail the offset certificate (C3, three C4 collapse cases, C5);
  - 3 straddle 0.25 px at the oracle's floor (C3, C5, C6).
- No case turned FAIL.

## 21. Known classes and `PASS with disclosure`, 2026-10-26

**Decision (2026-10-26, 추천안 자동 채택).** The user's standing instruction of 2026-10-24 adopts the recommended option of the [A04 sample results and remedy options](https://claude.ai/artifact/KQi8C82HX3ovB2JDLbZbje) decision: the flip-tolerant bound of section 20 for the no-flip cases, and disclosure of three known classes for the rest. E3-R3 stands: the 0.25 px threshold does not change, and the oracle does not change, so the freeze record of section 19.7 stands.

### 21.1 The classes

A FAIL or UNDECIDED row is in a known class when one of these holds. Each test reads only the row (`knownClassOf` in `tests/geometry/e3-a04/record.ts`).

| Class | Test | Why | Backlog |
| --- | --- | --- | --- |
| `collapsed-feature` | Stratum E3-C4, target gap `g < 2^-8` px (that is, `g = 2^-16`), FAIL or UNDECIDED, except the overlapping-rectangle rows n15 to n17, where `g` is an overlap and not a gap | The kernel closes a gap, slit or wall far below one pixel. The boundary metric scores the lost boundary at the feature's length, but no pixel sample can land in the gap. E3-R3 named this class before any run | None: a kernel that keeps such gaps is not planned |
| `far-vertices` | UNDECIDED with reason `beta ≥ 1 px` or `clip bound ≥ 0.25 px` | Vertices far off screen: the K4 carrier's class A limit and the GPU's clipping of far triangles | E18 |
| `degenerate-stroke-triangle` | Stroke paint, UNDECIDED, with `flipTolerant.reason` = `zero-area triangle off M*` | The stroke kernel emits zero-area triangles that no positive-area triangle covers | E19 |

A FAIL outside the first class is never disclosed. A row in a known class does not cover its E3-A8 cell. Two limits are stated for the evidence review:

- `collapsed-feature` does not bound the error's size: any FAIL on such a row is disclosed. Its rows are 18 named shapes of 16 by 16 document units, and the review reads each disclosed case.
- `far-vertices` would also take a kernel defect that throws a vertex far off screen, and A04 does not catch it. The E11-U2 structure checker does: it requires the mesh's vertices to lie in the path's enclosing bounds, on every corpus request.

A validator problem is reported for a row without `gapTarget` (a shard written before this section), so that old and new rows are not merged silently.

### 21.2 The verdict

Section 7.3 is applied to the rows outside the known classes. When it would give PASS and some row is in a known class, the verdict is **`PASS with disclosure`**: the record lists every disclosed case id per class under `disclosed`, and `record.md` prints them. The validator recomputes the list. Any FAIL outside the classes is still FAIL, and any UNDECIDED outside them still keeps A04 UNVERIFIED.

### 21.3 E11

The three classes join the [E11 section 7.2](d9-e11-p3-c03-c05-closure-contract.md#72-known-defects-at-the-exit) closed list for A04, with this section as their definition.

### 21.4 Zero-area triangles off the certificate's region

The oracle's mesh model takes triangles of positive area only, and before this section a zero-area triangle off the certificate's region of section 15.4 reached it and left the case UNDECIDED (`invalid mesh`). The oracle's `Ω` is the window with a 2 px margin, and the certificate checks the triangles whose box meets the window with a 4 px margin, that is `Ω ⊕ 2`. When the certificate holds, every zero-area triangle that is not collapsed lies off that region, more than 2 px from `Ω`. With `β_c < 1`, its β-moved image is off `Ω ⊕ 1`. It changes neither `G` on `Ω` nor `∂M ∩ Ω`, and it can only change a boundary distance of more than 2 px, which is a FAIL either way (`L > 2 − β > 0.25`). The T-junction count of `M*`, and so the reported crack bound, can drop with it; those cracks lie off the window, and the storage-crack check still runs on the full port mesh. So `M*` now leaves out every zero-area triangle (`withPositiveArea`) on both paths.

## 22. Re-measuring dead-worker cases, 2026-10-26

The full reference run of 2026-10-26 (96 shards on several hosts, section 19.6) showed stroke cases at `z = 64` (for example `C5/l22/T6/z64-d2` and `C5/g0088/T2/z64-d3`) whose worker hits the 6 GB V8 heap. Section 19.5 restarts the shard after such a case and records it UNDECIDED (`harness-error: worker exited …`), so one such case keeps A04 UNVERIFIED. This section adds a re-measure path. It changes no measurement code: `measureCase`, the oracle and the record are unchanged.

- **Heap.** `--heap MB` sets the shard workers' heap (default 6144). It is a host resource, recorded per host, and not part of the run identity.
- **Retry.** `pnpm e3-a04:run --retry-cases i,j,… --heap MB` re-measures those corpus indices in one worker into a retry directory (`retry.ndjson`, with `retryCases` in its provenance). It uses the same `--shards`, `--stride` and `--start-resolution` as the run.
- **Merge.** `--merge <dirs> --retried <retry dirs>` replaces exactly the rows whose worker died by the retry rows of the same index and id. It refuses a retry row that names any other row, a case retried twice, or a retry row that matches no row. The merged provenance lists every replaced row under `retried`, with its index, id, former reason, and the retry's run id, commit, `changedFromHead`, heap and exit codes. A record is copied to `docs/evidence/` only when every retry also exited 0.
- **Commits.** A run directory may come from an earlier commit than the merging checkout, when that commit is an ancestor and the two differ only in `tooling/run-e3-a04.mjs`, `tests/geometry/e3-a04/run.check.ts` or `docs/`. The diff is taken without rename detection, so a moved file counts on both sides. Its contract SHA may then differ; every other identity field (corpus, generator, oracle and its certification, WASM, shards, stride, start resolution, clean tree) must still agree. Each host's and each retry's commit and the paths it differs in (`changedFromHead`) are recorded, and the evidence review reads those diffs, because `run.check.ts` also sets the measurement options. The run of 2026-10-26 at `7443c2b` is merged on this change's own commit, whose parent is `7443c2b`. A later `main`, which carries other packages' changes, would refuse it.
- **A retry that dies again** is refused at the merge, with all of its directory's rows. Re-run the retry without that case, and leave the case UNDECIDED or retry it alone with a larger heap.

## 23. E3-U5 reference run record, 2026-10-27

Dated append. This section records the A04 reference run of section 9.1 on the E11 exit snapshot. The record is [`docs/evidence/e3-a04/2026-10-27T00-33-11-173Z-de2951d7/`](../evidence/e3-a04/2026-10-27T00-33-11-173Z-de2951d7/record.md). The measured disposition is **FAIL**. A04 acceptance stays with the Primary after the independent evidence review of section 7.4.

**Decision (2026-10-27, user).** On the decision card "A04 전체 측정 결과(FAIL)를 어떻게 처리할까요?", the user chose the recommended option, "결과 그대로 기록" ("record the result as it is"):

- The run is recorded as measured, with its FAIL and UNDECIDED breakdown.
- The remedies go to the backlog as E3-U7 (section 23.5).
- A04 enters the P3 exit as a disclosed defect.

The 0.25 px threshold, the oracle and the corpus do not change, and the freeze record of section 19.7 stands.

### 23.1 The run

- **Commit.** All 96 shards ran on `7443c2b`, which is the E11 snapshot `5ddec4e` plus tests, docs and CI only (E11 §12).
  - The merge and all retries ran on `a83b7db`: `7443c2b` plus the section 22 tooling (PR #277).
  - Every host's `changedFromHead` is `tooling/run-e3-a04.mjs` and `tests/geometry/e3-a04/run.check.ts`, or empty.
- **Identity.** All hosts and retries share these:
  - The release WASM `58f26517…fd35`, with `geometry-wasm/fill-v0+r4` and `geometry-wasm/stroke-v0+r7`.
  - The oracle `5b2fafc3…7e80`, certified in section 19.7.
  - `corpusSha256` `7f4bb1c9…721c`.
  - `--shards 96 --stride 1 --start-resolution 2`.
- **Hosts.** There were 25 run directories:
  - 20 cloud containers, Linux, 4 cores.
  - The user's laptop, Windows, 20 threads, 12 shards twice.
  - The user's PC, Windows, 16 threads, 16 shards.
  - Each host's Node version is recorded. 22 directories ran on Node 24.15.0 (the repository's pin).
  - The PC's three directories (shards 75 to 90) ran on the system Node 24.22.1.
  - One container directory (shards 48 to 50) ran on Node 22.22.0.
  - The measurement is deterministic JavaScript and WASM with no platform-dependent arithmetic, so the review reads this as a disclosure, not a defect.
  - The merge ran on Node 24.15.0.
- **Dead workers (section 22).** 61 cases hit the 6 GB worker heap: 59 `C5` strokes (33 at `z = 64`, 18 at `z = 1`, 8 at `z = 0.01`), one `C3` and one `C9`.
  - Each was re-measured once with `--heap 13000` (24,500 MB for three cases on the PC), in 24 retry directories that all exited 0.
  - One retry, `19871` at 13 GB, died again. Its directory was set aside unmerged, and its three cases were re-measured together on the PC.
  - After the retries no row is a harness error. 59 of the 61 end UNDECIDED on the oracle's work cap and 2 PASS. The work-cap reasons are `gcd step`, `rational`, `distance query`, `seam split` and `membership`.
- **Set-aside directories.** Several hosts' first launches were killed when an idle container was suspended. One duplicate launch was stopped within a minute. None of these was merged, and the merge checks that every shard appears exactly once.

### 23.2 Result

| Stratum | PASS | FAIL | UNDECIDED | Disclosed (section 21) | `window-empty` | Rejected |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 3,760 | 5 | 158 | 564 | 84 | 109 |
| C2 | 1,584 | 0 | 157 | 0 | 5 | 54 |
| C3 | 3,145 | 0 | 439 | 21 | 164 | 1,091 |
| C4 | 1,283 | 0 | 136 | 143 | 39 | 127 |
| C5 | 5,478 | 0 | 592 | 193 | 294 | 481 |
| C6 | 209 | 0 | 21 | 6 | 61 | 27 |
| C7 | 75 | 0 | 4 | 0 | 15 | 14 |
| C8 | 2,056 | 0 | 64 | 158 | 188 | 216 |
| C9 | 1,596 | 0 | 315 | 233 | 132 | 1,234 |
| C10 | 7 | 0 | 0 | 0 | 2 | 3 |
| C11 | 235 | 0 | 23 | 24 | 54 | 240 |
| C12 | 120 | 0 | 15 | 0 | 3 | 6 |
| All | 19,548 | 5 | 1,924 | 1,342 | 1,041 | 3,602 |

FAIL and UNDECIDED count only rows outside the known classes. The disclosed rows break down as follows:

- `collapsed-feature`: 143, of which 22 are FAIL.
- `far-vertices`: 757.
- `degenerate-stroke-triangle`: 442.

Other results:

- **Controls and validator.** All 14 positive controls hold, and the validator reports no problem.
- **Bounds.** The maximum oracle interval width is 0.2497 px.
- **`U` over the PASS and FAIL rows.** p50 is 0.150 px and p99 is 0.250 px. The max `U`, 0.517 px on `C2/g0161/T4/z0.01-d2`, is an UNDECIDED row: its `L` is below 0.25 px.
- **E3-A8.** No declared cell is uncovered.

### 23.3 The FAIL rows outside the known classes

The five rows are `C1/g0029/T2` at `z0.01-d3`, `z1-d1`, `z1-d2`, `z64-d1` and `z64-d2`. The generated row is a sub-pixel triangle of the `sub` size class, about 0.06 px across at `z = 0.01`.

- At these five pairs, every triangle of the kernel's mesh maps to coincident positions (`noFlip.collapsed` = 2 of 2). So `M*` is empty.
- With `∂R` in `Ω` and `M = ∅`, the boundary distance `B_R` is infinite. The case is a FAIL by the `empty` rule of section 3.2 (E3-K2): with `∂R` in `Ω`, an empty drawn region never passes.
- The other four pairs of the same row keep a positive-area mesh and PASS, with `U` between 0.12 and 0.24 px.
- The true visual error is far below 0.25 px, because the whole shape is below a pixel. But A04 scores boundaries, not pixels, and a kernel that drops a sub-pixel shape's interior fails it. This is a kernel result, not an oracle defect.

### 23.4 UNDECIDED outside the known classes

| Reason | Rows | What it means |
| --- | --- | --- |
| No-flip certificate, clipped draw (`flipTolerant` not run) | 658 | Section 20's argument does not cover clipped triangles |
| No-flip certificate, fill zero-area triangle off `M*` | 304 | The fill counterpart of the `degenerate-stroke-triangle` class |
| No-flip certificate, edge with triangles on both sides | 217 | The flip-tolerant bound's open T-junction case |
| No-flip certificate, boundary offset | 208 | The offset certificate of section 20.3 fails |
| No-flip certificate, edge below binary64 | 24 | |
| `window-empty` within the guard | 261 | Section 15.5 |
| Straddles at the floor `2^-20` | 100 | `E` stays at 0.25 px within the oracle's resolution |
| Oracle work cap | 152 | `gcd step` 41, `rational` 40, `distance query` 39, `seam split` 31, `membership` 1 |

With these rows, A04 would be UNVERIFIED even without the FAIL rows.

### 23.5 E3-U7 (backlog)

E3-U7 collects the remedies. None was made for this record.

- A fourth known class, or a kernel change, for sub-pixel shapes whose mesh collapses (section 23.3).
- The flip-tolerant bound for clipped draws, and for fill zero-area triangles.
- A cheaper oracle path for the work-cap stroke cases.

A new reference run on a later snapshot would supersede this record. This record is immutable (section 7.4).

### 23.6 GPU model check

The headed check of section 19.1 (E3-A6) ran on the user's PC on 2026-10-27, from 00:17 to 00:32Z, on `a83b7db` with the same WASM. Its two outputs are committed beside the record as [`chrome.json`](../evidence/e3-a04/2026-10-27T00-33-11-173Z-de2951d7/chrome.json) and [`edge.json`](../evidence/e3-a04/2026-10-27T00-33-11-173Z-de2951d7/edge.json). The record names them by the merging host's local paths.

- **Browsers.** Chrome 155.0.8059.85 and Edge 156.0.4314.42, headed, with `--enable-unsafe-webgpu`, at DPR 1.
- **Adapter.** NVIDIA, Turing architecture (GTX 1660 SUPER), not a fallback adapter. The user agent reports 151.0.7922.34 in both, which is user-agent reduction. The version field is the browser's own.
- **Result.** Both browsers **PASS**, with identical numbers.
  - 13,364 subset cases: 1,429 rejected and 216 empty are skipped. That leaves 11,719 draws and 1,236,334 points, with no failure.
  - The largest error-to-`β` ratio is 0.267 on the vertex path and 0.368 on the feature path.
  - 2,668 clipped draws were compared over 41,503,238 pixel centres, with no mismatch. 591 of them were not measurable for `β`.
  - There are 151,848 T-junctions. The largest crack is 0.00108 px, on `C5/l40/T6/z64-d3`.
  - E3-PC12 was rejected, as it should be.
  - The shader hash `d306137c…31a3` and the WASM hash equal the record's.

This completes E3-A6 on the named subset. It does not change the FAIL.
