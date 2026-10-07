# P3.1o O02 A5 coverage rule contract

Status: FROZEN, 2026-10-07, at revision 3 plus confirmation fixes. Independent Astra high technical review: NOT READY, NOT READY, then READY. Sol medium implementability review: NOT IMPLEMENTABLE, NOT IMPLEMENTABLE, then IMPLEMENTABLE. Implementation is authorized after integration.

**Review history.**

- **Revision 1:** NOT READY (Astra high technical review) and NOT IMPLEMENTABLE (Sol medium implementability review).
- **Revision 2:** resolved every revision 1 finding. Re-review raised new BLOCKING items: a frame-deferral rule that was unachievable by census, the VERTEX record size, G3 sample positions, and the complement decomposition.
- **Revision 3:** addresses those.

**Authorization:** implementation and GPU runs only after this FROZEN text is integrated on `main`.

**Ownership.**

- The [raster coverage readiness note](p3-raster-coverage-readiness.md) owns Q1-Q14.
- The [private contract](p3-private-contract.md) records the user decisions.
- The [graphics architecture](../graphics-engine-architecture.md#anti-aliasing) records A5.
- The [active plan](p3-fill-stroke-meshes.md) owns status.

**What this work is.** It is test-only. It fixes the exact per-pixel coverage rule that realizes the user-approved A5 mechanism, together with the drawn geometry. It then measures the rule on headed Chrome and Edge against the Q4 thresholds and the Q9 no-double-coverage obligation.

**What it does not add.** No production renderer path, layout, ABI, public API, dependency or requirement. Stroke stays deferred. Q10 guard clipping (R2), Q11 cache identity, and the numeric partial-coverage tolerance stay open. Q6 for coincident edges between separate meshes (conflation) is out of scope. Any need for offscreen isolation or stencil stops the work and becomes an architecture proposal.

**Contract identity** follows O01: the integrating `main` commit, plus this note's SHA-256 at that commit.

## User decisions, 2026-10-07

These answers came after the revision 1 reviews.

**A5 realization.** The user accepted three refinements of the recorded A5 text as its test-only realization:

1. **Segment distance.** Distance is measured to boundary segments and vertices, not to edge lines. This fixes the O01 line-not-segment deficit.
2. **Complement fringe.** The outer fringe is a triangulation of the complement within a frame, not per-edge quads. This removes the O01 corner overlap.
3. **Analytic width.** The ramp width is analytic, not `fwidth`. This makes per-pixel values identical across primitives.

A Q4 verdict from this contract applies to A5 realized this way. Adopting the complement triangulation in production is not implied, because cache identity (Q11) and cost belong to R2/C04.

**Q3.** Screen-space distance is accepted. It equals P1 for straight edges in any affine, and for convex corners under similarity transforms. It differs from P1 in two cases:

- under nonuniform scale or shear, corner isolines are circles in screen space, where P1's are ellipses;
- reflex corners have no P1 precedent.

The user accepted both.

**Q12.** P1's encoded-sRGB premultiplied blending applies unchanged.

## Question

On the admitted corpus at DPR 1, 1.5 and 2, at both 1x and 4x, does the rule meet G1 and G2 (Q4) and G3 (Q9)? Secondary questions:

- Is the O01 deficit gone?
- Do 1x and 4x agree?
- What do features, overdraw and DPR 3 look like?

## Inputs and variants

**Variants.**

- The corpus is O01's 149 rows. Each row is re-projected at `d ∈ [1, 1.5, 2, 3]`.
- The variant key is `{rowIndex, dpr}`, ordered by row and then by `d`.
- The CSS size is the row's physical `width`, `height` divided by its recorded `dpr`. Every row is 640×360 CSS, so the physical size is exact.
- Only `dpr`, `width` and `height` change. The world geometry, affine, camera, zoom and origin are unchanged.
- The variant whose `d` equals the row's recorded `dpr` is flagged `identity`. A host test asserts that identity variants reproduce O01's inputs and NDC bits.
- All six literal rows (F07-Z16, F07-Z16R15, F11-Z8, SQ-Z1, SQ-Z1R15, THIN-Z1) are `ProjectionInput`s and are re-projected the same way.

**Row statuses.** Each variant gets exactly one status.

| Status                   | Meaning                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `RENDERED`               | All checks below pass and the variant is drawn                                                                                 |
| `INPUT_UNSUPPORTED`      | As in O01                                                                                                                      |
| `NOT_ADMITTED`           | The C2 certificate rejects the region mesh, as in O01, with the row's own `input.origin` and the certificate reason            |
| `EMPTY_CROP`             | As in O01                                                                                                                      |
| `FRAME_DEFERRED`         | A frame corner's NDC magnitude exceeds 2^10. This is a far-field guard needing R2 clipping; the census expects none            |
| `VERTEX_UNSUPPORTED`     | A boundary vertex has more than 3 region sectors (degree greater than 6), or two boundary vertices share a preimage coordinate |
| `EXTERIOR_NONCONFORMING` | An exact partition check fails, or the triangulator throws; the failed check is named                                          |

**Census before freeze.** The census covers the 149 rows at each of the four DPRs, measured with the O01 geometry path and crop.

| Per DPR                           | Count | Detail                                                                                |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| Renderable                        | 143   |                                                                                       |
| `EMPTY_CROP`                      | 6     |                                                                                       |
| Frame NDC magnitude above 16      | 10    | Maximum frame NDC magnitude is 31.2, so no variant reaches the `FRAME_DEFERRED` bound |
| `NOT_ADMITTED`                    | 0     | Independent re-check by the Sol medium reviewer                                       |
| Rows with a degree-4 pinch vertex | 96    | Bowtie, star and zero-closure carriers; k = 2 sectors                                 |
| Rows with a higher-degree vertex  | 0     |                                                                                       |
| Rows with a duplicate coordinate  | 0     |                                                                                       |

The O01 deficit rows are the `rowIndex` values 77, 83, 89 and 95 in `coverageCorpus()` order: `carrier/Z/depth-positive/{star,zero-closure}:{nonzero,evenodd}/S8`. They are renderable at every DPR, with frame NDC magnitude about 3.5.

**Reference boundary (Q1, unchanged).** The reference is the exact preimage of the once-rounded f32 NDC vertices. Boundary edges are the mesh edges used by exactly one region triangle, oriented with the region on the left.

**Corners at a vertex.** At each boundary vertex `v`, the incident boundary edges are sorted by exact angle. Each outgoing ray `r_out` is paired with the next ray counterclockwise, which must be a reversed incoming edge `r_in`. A failed pairing gives `EXTERIOR_NONCONFORMING`. The counterclockwise sweep from `r_out` to `r_in` is one region sector, so a vertex has one sector per pairing, from 1 to 3.

**Orientation convention.** Coordinates are y-down physical px. Orientation is `cross(a, b) = a.x·b.y − a.y·b.x`. "Counterclockwise", "left" and "region on the left" all mean positive `cross`. The shader uses the same formula.

## Coverage rule (Q2, Q3)

**Definition.** For a pixel center `p` (`@builtin(position).xy`), let `q` be the nearest point of the reference boundary and `v = p - q`. Then:

- `s = ±|v|`, negative inside;
- `w = (|v.x| + |v.y|) / |v|`, with `c = 0.5` when `|v| = 0`;
- `c = clamp(0.5 - s / w, 0, 1)`.

Equivalently, `s / w = ±|v|² / (|v.x| + |v.y|)`. This is rational, so the rule oracle is exact.

**Sign.**

- If `q` is interior to an edge, `p` is inside when it is on the region side of that edge.
- If `q` is a vertex, `p` is inside when `v` lies strictly inside one of the vertex's region sectors.

Any nearest point gives the same, correct sign. The open segment from `p` to any nearest boundary point does not meet the boundary, so `p` and the region side at `q` agree. Ties are broken by a fixed order (edges before vertices, then lower index), and with exact arithmetic the choice does not change `c`. At a medial axis `w` may jump, so `c` may be discontinuous there; this is observed under thin features.

**Value is a function of the pixel center only.** Every primitive evaluates `c` with the same shader function, the same pipeline per sample count, and the same shared feature records. Values are therefore bit-identical across primitives. The shader must not use `sample` interpolation, `@builtin(sample_index)` or alpha-to-coverage. `@builtin(position)` at 4x is assumed to be the pixel center (inherited from O01), and `obs − rule` observes this assumption.

## Features and reach

**Feature records.** Each record is 16 words (64 B) in a read-only fragment storage buffer declared as `array<u32>`. `kind`, `k` and the flag bits are u32. Every other word is f32 and is read with `bitcast<f32>`. All values are computed in float64 from the exact preimage relative to the crop origin, then rounded once to f32. The shader works in the per-record frame, so offscreen endpoints never enter absolute f32 differences.

| Kind   | Words                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EDGE   | `kind = 0`; `n.x`, `n.y` (outward unit normal); `c` (`n·p + c` is the signed line distance); `ta`, `tb` (endpoint parameters along `t = (−n.y, n.x)`); 10 pad words                                                             |
| VERTEX | `kind = 1`; `x`, `y`; `k` (1-3) in the low 8 bits, with bit `8 + i` set when sector `i` is 180° or more (computed exactly on the host); then `k` pairs (`r_out`, `r_in`) of unit directions, 4 words per sector; unused words 0 |

**Evaluation.**

- **EDGE** contributes only when `ta ≤ t·p ≤ tb`. Its distance is `|n·p + c|` and its sign is the sign of `n·p + c`. Its `w` is `|n.x| + |n.y|`.
- **VERTEX** contributes `|p − x|`, with `w` computed from `p − x`. Its sign comes from the sector tests:
  - with `d = p − x`, a sector of less than 180° is inside when `cross(r_out, d) > 0` and `cross(d, r_in) > 0`;
  - a sector of 180° or more is inside when NOT (`cross(r_out, d) ≤ 0` and `cross(d, r_in) ≤ 0`);
  - at exactly 180° both tests reduce to the same strict half-plane test;
  - the reflex bit selects the test, so no f32 angle decision is made.

**Robustness of the vertex tests in f32.** In a vertex's Voronoi cone, `p − x` makes at least 90° with every incident ray, so a sector test is near zero only when `|p − x|` is about one ulp. There `c` is about 0.5 either way. `obs − rule` records any effect.

**Per-primitive lists.** A primitive carries a flat `(featureOffset, featureCount)`. The list holds every EDGE and VERTEX within an exact distance of R = 1.5 px of the closed primitive triangle in the preimage.

**Global order.** Every feature has a global id: edges are sorted by `(a, b)`, and vertices by index. Lists are sorted by `(kind, global id)`. The shader compares f32 distances, not exact squared ones, and updates the nearest feature only on a strict `<`. "Identically" therefore means identical f32 operations on identical records,, so tied features resolve identically in every primitive.

**Far-field clamp.** Let `d*` be the minimum distance over the listed features. If the list is empty or `d* ≥ 1.0`, then `c` is the primitive's role constant: 1 for region, 0 for exterior. Otherwise `c` is the rule over the listed features.

Why the clamp is sound:

- A fragment's center lies within 0.396 px of a covered sample. The 4x standard sample offsets are at most `sqrt(0.375² + 0.125²) = 0.3953` px from the center.
- An unlisted feature is therefore more than `1.5 − 0.396 = 1.104` px from the center. So if `d* < 1.0`, the listed nearest feature is the true nearest.
- If `d* ≥ 1.0`, the true distance is at least `min(d*, 1.104) ≥ 1.0`. That exceeds the ramp half-width `w/2 ≤ 0.7072`, so `c` is saturated.
- The center is also on the role's side. The path of at most 0.396 px from the center to the primitive stays more than 0.6 px from the boundary, so it cannot cross it.
- The remaining 0.104-px margin absorbs f32 evaluation and rasterizer snapping. Neither is bounded normatively by WebGPU; this is a stated limit.

**Recorded statistics.** Features per primitive (maximum, p99, total bytes) and fragment feature evaluations, measured as the sum over drawn primitives of covered-pixel count times feature count, from the 1x count pass. No cap is adopted.

## Drawn geometry and partition (Q6, Q9)

**Region triangles.** The C2-admitted region mesh, as in O01.

**Frame.**

- The frame corners are the boundary's physical bounding box expanded by 2 px, rounded outward to integer physical px. They are mapped to local space by the exact inverse affine and rounded to binary64. They then follow the same NDC path as the region vertices.
- The frame need not be axis-aligned or f32-exact.
- The builder asserts exactly, on the preimage, that the frame is a non-inverted quadrilateral and that every boundary point is at least 1.5 px inside it.

**Exterior triangles.** A test-only exact rational triangulator with no Steiner points triangulates the frame minus the region.

The triangulator reuses the region's boundary vertex indices and tolerates collinear boundary vertices. Exterior triangles with an empty feature list are dropped, because they only cover `c = 0` samples.

**Complement faces.**

- Boundary loops are traced by following each boundary edge to its successor. At a pinch vertex, the successor is given by the sector pairing.
- Loops are nested by exact point-in-polygon tests on the midpoint of a loop edge. Loops share no edges, so the midpoint never lies on another loop.
- Each complement face is one of two kinds: the frame minus its directly enclosed region loops, or a bounded pocket (a reversed region-hole loop) minus any islands inside it. Each face is triangulated separately.

**Ear clipping.**

- Holes are processed in descending maximum x, with ties broken by the lower index. Each merged hole becomes part of the chain that later holes bridge to.
- A hole bridges to the vertex at minimal exact distance whose coordinate differs from the hole vertex. The bridge segment must meet the face boundary only at its endpoints (exact, strict visibility). Ties are broken by the lower index.
- A pinch vertex may occur more than once in a face chain. The point-in-triangle test is closed: any chain point on the closed candidate triangle blocks the ear, except occurrences coincident with the triangle's own corners. This prevents T-junctions.
- Collinear (180°) vertices are allowed.
- Ears must have strictly positive exact area.
- No ear means `EXTERIOR_NONCONFORMING:no-ear`.
- Host tests cover a bowtie pinch, an even-odd star and a zero-closure synthetic.

**Exact partition check.** This runs on the submitted preimage coordinates of the region and exterior triangles together.

- The orientation is consistent and non-zero.
- Every non-frame edge is used exactly twice, in opposite directions, and each frame edge exactly once.
- There is no T-junction: no vertex lies in the interior of an edge.
- The areas sum exactly to the frame area.
- Each exterior triangle's minimum orientation slack, against a 1/16-px snap displacement, is reported only.

C2 is not applied to exterior triangles, because the drawn mesh is the reference mesh.

**GPU partition.** That every sample in the frame is covered by at most one drawn primitive is an assumption on the underlying APIs' shared-edge rules. WebGPU does not state a normative tie rule. G3 verifies it.

O01's limit on clip-space clipping of far-offscreen vertices is inherited. A G3 failure on a triangle with a vertex outside the clip volume is attributed to that limit, and to U1/Q10, rather than relabelled. An attributed G3 failure still counts as a G3 failure in the verdict. The review separately counts failing variants that have no vertex outside the clip volume.

**Seams.** Internal and region-to-exterior seams carry bit-identical per-pixel values. F07 internal edges produce no feature. F11-Z8 is a single mesh whose coincident span is internal.

**Composition.**

- Blending is P1's premultiplied `one / one-minus-src-alpha`, onto `rgba8unorm` cleared to transparent black, with opaque white fill. So `obs = R / 255`.
- Region and exterior primitives are separate draw ranges in one pass with one pipeline. The role is a flat attribute.

## Oracles and acceptance

**References.**

- **Area oracle:** O01's exact pixel-area oracle, unchanged, gives `ref`.
- **Rule oracle:** gives `rule` exactly, as a rational, from all boundary edges and vertices. It is not restricted to R.

**Acceptance.** Each metric is evaluated per variant and per sample count. Results are never pooled.

| ID  | Obligation | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Q4         | At pixel centers at least 2 physical px from every boundary segment, by exact squared distance of at least 4, `obs` is within 2/255 of 255 inside and of 0 outside. This is P1's center-based class, chosen deliberately instead of O01's pixel-square class                                                                                                                                                                                                                                                     |
| G2  | Q4         | P1 region transition: a pixel with `obs ≥ 128` is classified inside. Every misclassified pixel center lies within 1 physical px of the boundary, by exact distance. Visible geometry for THIN-Z1, at every DPR and both sample counts: `obs > 0` holds in every pixel column whose center lies within the strip's x-extent, in the pixel row whose center is nearest the strip, with ties going to the lower row. The rule never covers a 0.3125-px strip's pixel centers, so a classification test cannot apply |
| G3  | Q9         | The four counts of a pixel are an order-independent multiset, because WebGPU fixes no sample-index-to-position order. Pixels whose center is inside the region or within 0.708 px of the boundary (0.708 + 0.3953 = 1.1033 < 1.104, so every sample lies within 1.104 px) require all four counts to equal 1. Elsewhere in the crop every count is at most 1. At 1x the center count obeys the same classes                                                                                                      |

**G3 measurement.**

- At 1x, an additive `rgba16float` pass of 1.0 per fragment gives the count at the pixel center.
- At 4x, the same additive pass renders into a `sampleCount: 4` `rgba16float` texture. A readout pass writes `textureLoad(t, p, i)` for `i = 0..3` into the RGBA channels of a 1x `rgba16float` target. That makes it a direct hardware sample count.
- The set of sample positions is assumed to be WebGPU's standard 4x pattern, on which the 0.3953-px reach bound relies. Only the index-to-position order is not assumed. A position-specific comparison may be reported as an observation, never as a gate.
- The readout is a fullscreen triangle with no depth. It reads `vec2<i32>(position.xy)` from a `texture_multisampled_2d<f32>` binding (unfilterable-float). The 4x count texture has `TEXTURE_BINDING | RENDER_ATTACHMENT` usage. Readout pipeline creation is part of `init` preflight.
- The count shader always writes 1.0, with no discard. It uses the same vertex stage, buffers and draw ranges as `main`, so dropped exterior triangles are absent from both.

**Verdict.** The verdict is PASS when G1-G3 hold for every `RENDERED` variant at DPR 1, 1.5 and 2. It is INCONCLUSIVE if:

- any acceptance DPR has fewer than 130 `RENDERED` variants, against a census of 143 renderable; or
- any of the six literal rows, or any of the O01 deficit rows 77, 83, 89 and 95, is not `RENDERED` at an acceptance DPR.

The review reports admitted and rendered counts per DPR and per status.

**Observations, with no threshold:**

- `obs − rule`, the main conformance signal, reported per class (interior, exterior, band);
- `obs − ref` band deviation, with and without corners;
- O01 boundary shift;
- the 1x/4x difference;
- THIN-Z1 area;
- F07 and F11 seam values;
- the O01 Z S8 deficit pixels;
- feature and overdraw statistics;
- per-DPR breakdowns;
- DPR 3.

**Stated limits.** These follow O01: unorm conversion, resolve averaging, snapping and clip-space clipping are implementation-defined. G1 at 4x includes resolve rounding. A failure is attributed, never relabelled.

**f32 feature magnitude.** Crop-relative feature coordinates reach about 3·10^4 px for the largest frames (frame NDC magnitude about 31). There, f32 rounding is about 0.002 px. This is a pre-stated cause for any `obs − rule` outliers on those rows.

**`FRAME_DEFERRED` bound.** 2^10 is about 32 times the census maximum. It guards only against far-field magnitudes outside this corpus.

## Runner and records

The runner follows O01's lifecycle, timeouts, record rules, archive rules and confirmation run, with these changes.

**Files and commands.**

- `pnpm test:gpu:p3-o02` runs `playwright.p3-o02.config.ts` on port 4180.
- `vitest.p3-o02.config.ts`; `pnpm coverage:p3-o02` runs `tooling/run-p3-o02-metrics.mjs`.
- Vite entry `p3-o02.html`.
- `.gitignore` gets `artifacts/p3.1o-o02/`, and `docs/validation.md` gets a row.

**Page API: `window.__vectorStudioP3O02`.**

- `init` creates the shader modules (`main`, `count`, `readout`) and records their SHA-256 values. It creates these pipelines:
  - main at 1x and 4x: `rgba8unorm`, premultiplied blend;
  - count at 1x and 4x: `rgba16float`, additive;
  - the readout pipeline.
- `render` takes `{variant: {rowIndex, dpr}, width, height, crop, origin, soupBase64, featuresBase64, regionDraw: {first, count}, exteriorDraw: {first, count}}`. It renders the full viewport and copies only the crop.
- Upload SHA-256 values for the soup, features and uniform are echoed and gated.

**Vertex record.** 32 B: NDC `x`, `y` as `float32x2`; flat `uint32` attributes `featureOffset`, `featureCount` and `role`; 3 reserved words. The upload digest covers these exact bytes. All three vertices of a primitive carry identical flat words.

**Crops per variant.** In this order: `main/1`, `main/4`, `count/1` (R channel), `count/4` (RGBA). They are RLE-encoded as in O01. `count` is stored as float16 bits.

**Schemas.**

- Schemas are `p3-o02-capture-v1`, `p3-o02-capture-index-v1` and `p3-o02-metrics-v1`, in a new `capture-schema-o02.ts`. O01's schema and its archive replay are untouched.
- The capture is split per DPR, with no part over 25 MB. A DPR part that would exceed 25 MB is split further by row range.
- DPR 3 parts are written to artifacts only and are not archived.

**Timeouts.** `render` is 10,000 ms per variant and the case is 1,200,000 ms. There are 596 variants, 572 of them renderable by census. The expected run is 5-8 min per browser, from O01 timing and the measured certification cost of about 20 ms per variant. This estimate is re-checked on the first run.

**Runner gates.** The runner asserts only:

- `COMPLETE`;
- that row statuses are among those listed;
- hashes;
- cleanup;
- an unchanged source manifest.

G1-G3 are evaluated offline and reported in the review record.

## Ownership and validation

There is no recursive delegation. Sol medium's interface module is delivered first, and Primary's builder depends on it.

| Owner      | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary    | This contract; page, shaders, pipelines; vertex and feature builder; spec; evidence writer; config, scripts, Vite entry, `.gitignore`; validation.md row; plan                                                                                                                                                                                                                                                                                                         |
| Sol medium | `tests/geometry/coverage-oracle/variants.ts`: `variantInput(input, dpr)`, identity flag, ordering. `exterior.ts`: `frameFor(geometry, input)`, `triangulateComplement(...)`, `checkPartition(...)`, `vertexSectors(...)` (statuses as above). `rule.ts`: the exact rule oracle. `capture-schema-o02.ts`. G1-G3 and observation metrics. `pnpm coverage:p3-o02` and byte-identical replay. Host tests against brute force on synthetic shapes, including a bowtie pinch |
| Astra high | Contract re-review; stable-source review before GPU dispatch; independent evidence review                                                                                                                                                                                                                                                                                                                                                                              |

**Validation.**

- `pnpm check`, `pnpm test:geometry` and `pnpm build`.
- Host tests, including identity-variant reproduction of O01.
- Headed `pnpm test:gpu:p3-o02`: a first run and a confirmation run.
- `pnpm coverage:p3-o02` and its replay.
- Markdown and link checks.

GitHub CI cannot run the headed steps.

**Dependency order:** `Q4/Q5 and A5 realization decided -> this contract FROZEN -> Sol interfaces -> implementation -> stable-source review -> headed observations -> offline metrics -> independent evidence review -> Q4/Q9 verdict for A5 -> R2 guard clipping and C04 layout contracts`.
