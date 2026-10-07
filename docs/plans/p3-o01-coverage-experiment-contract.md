# P3.1o O01 observational raster coverage experiment contract

Status: FROZEN, 2026-10-07, after independent Astra high technical review and Sol medium implementability review, in two rounds plus confirmation fixes. Implementation is authorized after integration. It is the first experiment named in the [raster coverage readiness note](p3-raster-coverage-readiness.md). The [private contract](p3-private-contract.md) owns C03-C05, and the [active plan](p3-fill-stroke-meshes.md) owns status.

This is a test-only observation. It adopts no antialiasing mechanism, threshold, renderer path, composition scheme or requirement. The choices below that correspond to Q1-Q3 are fixed for observation only, and do not bind Q4 or Q5. Any need for offscreen isolation or stencil stops the work and becomes an architecture proposal. Stroke stays deferred.

The contract identity is the `main` squash-merge commit that integrates FROZEN status, together with this note's file SHA-256 at that commit, as in P3.1l. The runner records both, and requires that commit to be an ancestor of the run base.

## Question

On real hardware, at 1x and 4x MSAA, how do three candidate fill-coverage mechanisms compare against an exact pixel-area reference?

| ID  | Candidate                                                            |
| --- | -------------------------------------------------------------------- |
| A1  | Outward fringe with an opaque interior, discontinuous at the contour |
| A2  | Inside-only ramp                                                     |
| A5  | Symmetric straddling ramp                                            |

O00's shifted A1 variant (an opaque interior with `clamp(1 - d)` over the fringe) is excluded. It moves the 0.5 iso-line outward by about 0.5 px by construction, which the private contract already rejects.

The comparison observes these quantities:

- interior and exterior error;
- band deviation, with and without corner pixels;
- equivalent boundary shift;
- seams on internal edges;
- the 1x/4x difference;
- a diagnostic overlap mass.

O00's "edge location under the region-transition oracle" is replaced by the equivalent boundary shift, because coverage is scalar here.

## Inputs

**Fixture rows.**

- **Selection.** The row ids are the `policy: fixture, status: ADMITTED` rows of the [R0a report](../evidence/p3.1n-r0a-wedge/report.json). Its SHA-256 `a25b53af41db7b5600fcaba3d7a687e0ad4ce3f28cd191f4a7f8f34c7e3f77cc` is asserted, and the count must be 143.
- **Inputs.** The inputs are read through `loadFixtureRows()` in `tests/geometry/position-certificate/corpus.ts`. That function asserts the K archive SHA-256 and the identity of every input.
- **Evaluation.** Each row is evaluated in its own fixture camera, origin, zoom, DPR and viewport (`640·DPR × 360·DPR`).

**Literal rows.** Each vertex is transformed in this order: linear part, then translation, then zoom. All literal rows use:

- translation `(10.265625, 10.7734375)`, so no edge is pixel-aligned;
- camera and origin (0, 0);
- DPR 1, viewport 640x360;
- vertices given in local units and scaled by zoom.

R15 rows use the exact `LINEARS` R15 bits from `tests/geometry/mesh-projection/fixtures.ts`, applied about the local origin before translation.

| Row        | Zoom | Vertices                                        | Triangles                                       |
| ---------- | ---- | ----------------------------------------------- | ----------------------------------------------- |
| F07-Z16    | 16   | (0,0) (2,0) (4,0) (4,2) (2,2) (0,2)             | [0,1,4] [0,4,5] [1,2,3] [1,3,4]                 |
| F07-Z16R15 | 16   | Same as F07-Z16, with linear part R15           | Same as F07-Z16                                 |
| F11-Z8     | 8    | (0,0) (4,0) (4,4) (2,4) (0,4) (6,4) (6,8) (2,8) | [0,1,2] [0,2,3] [0,3,4] [3,2,7] [2,5,6] [2,6,7] |
| SQ-Z1      | 1    | (0,0) (37.5,0) (37.5,21.25) (0,21.25)           | [0,1,2] [0,2,3]                                 |
| SQ-Z1R15   | 1    | Same as SQ-Z1, with linear part R15             | Same as SQ-Z1                                   |
| THIN-Z1    | 1    | (0,0) (40,0) (40,0.3125) (0,0.3125)             | [0,1,2] [0,2,3]                                 |

The internal edges are:

- **F07:** 1-4 (x = 2) and the diagonals 0-4 and 1-3.
- **F11:** the span 2-3 (y = 4, x ∈ [2, 4]) and the fan diagonals.

A test asserts that no axis-aligned boundary edge of an unrotated literal row has an integer physical coordinate.

**Mesh validity.** Every mesh must pass:

- `inspectTriangleMesh`;
- a self-parent `verifyConformingRefinement` check, which means no T-junctions, no partial collinear overlap and no zero-area triangle.

A failing row is recorded as `INPUT_UNSUPPORTED:<reason>` and is not evaluated. A boundary edge is an index pair used by exactly one triangle; every other edge is internal.

## Position and distance path

**NDC.** For each vertex the CPU computes the exact reference physical position R with K's original-input formula, as an exact rational from the original binary64 inputs. The existing exact helpers are reused, and `tests/geometry/coverage-oracle/positions.ts` owns this computation.

From R it computes:

- `ndcX = 2·Rx/W - 1`;
- `ndcY = 1 - 2·Ry/H`.

Each value is rounded once to binary32 with RNE. The vertex shader outputs these words unchanged, with z = 0 and w = 1.

**Reference region (Q1).** The reference region is the exact preimage of the submitted NDC bits:

- `rx = (ndcX + 1)·W/2`;
- `ry = (1 - ndcY)·H/2`.

These values are exact dyadic rationals. The report records, for each row, the exact maximum of |preimage - R|.

**Edge coefficients.** For each boundary edge, the CPU computes, in binary64 from the preimage endpoints:

- the outward unit normal `n`, where "outward" is decided by the interior side (the triangle's third vertex), not by winding;
- `c = -n·(P0 - o)`, where `o` is the crop origin.

Both are rounded to binary32.

**Fragment distance.** The fragment shader computes `d = n·(fragPos.xy - o) + c` from `@builtin(position).xy`, which is the pixel center. Since fwidth(d) = |n_x| + |n_y| ∈ [1, √2] for a unit-normal affine distance, the ramp reaches 0 at d ≤ 0.71 px. A 1-px fringe therefore suffices.

**Recorded displacement.** The report records, for each row and edge, the exact maximum distance between the rasterized edge (the preimage segment) and the line represented by the f32 coefficients, within the crop. Rows above 1/255 px are listed separately.

## Candidates and observation rules (Q2/Q3)

**Common ramp.** Every candidate uses `ramp(d) = clamp(0.5 - d / max(fwidth(d), 1e-6), 0, 1)`. All attributes are `@interpolate(flat)`. The fragment shader runs once per pixel at its center, with no sample shading and no alpha-to-coverage.

**Vertex record.** Every vertex is 64 bytes:

| Floats | Contents                  |
| ------ | ------------------------- |
| 0-3    | ndc.x, ndc.y, 0, 0        |
| 4-7    | Edge 0: n.x, n.y, c, flag |
| 8-11   | Edge 1: n.x, n.y, c, flag |
| 12-15  | Edge 2: n.x, n.y, c, flag |

`flag` is 1 for a boundary edge that applies. A flag of 0 means the edge contributes coverage 1; this is constant per primitive, so it acts as a sentinel. Interior triangles are an unshared soup with 3 vertices each. Each fringe is a quad of 2 triangles (6 vertices) spanning exactly its edge, with no end caps. Its edge 0 is that boundary edge; edges 1 and 2 have flag 0. The inner vertices P0 and P1 reuse the exact NDC words of the edge endpoints. The outer vertices are Q0 = preimage(P0) + n and Q1 = preimage(P1) + n, computed in binary64, converted to NDC and rounded once with RNE. The two triangles are `[P0, P1, Q1]` and `[P0, Q1, Q0]`. All vertices of a primitive carry identical edge records, so the provoking vertex does not matter.

| Candidate | Interior triangles                                                           | Fringe quads                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1        | Output 1                                                                     | Output `d >= 0 ? ramp(d) : 0`                                                                                                                                                                      |
| A2        | Output the minimum of `ramp` over the triangle's flagged edges, or 1 if none | Not drawn                                                                                                                                                                                          |
| A5        | As A2                                                                        | Output `ramp(d)` unconditionally, with no `d >= 0` test. Both sides evaluate the same function at the same pixel center, so the per-pixel value is equal on both sides of the contour at 1x and 4x |

**Q3, observation rule.** There is no corner or thin-feature rule. Coverage uses only the edges of the fragment's own primitive, and fringes have no caps. Convex-corner gaps, concave-corner overlaps and nearby edges not owned by the primitive (for example THIN-Z1's opposite edge) are expected. They are measured, not corrected.

**Main pass.** The target is `rgba8unorm`, cleared to 0, with blend operation `max` and factors `one`/`one`. White is written with coverage on every channel.

**Diagnostic passes, 1x only.** Each candidate is rendered twice into `rgba16float` targets cleared to 0: once with blend operation `max` and once with `add`, both with factors `one`/`one`. The overlap mass is add minus max between these two float targets. This is the double coverage that max blending hides, and it bears on Q6 and Q9.

**Rendering.** Each candidate is rendered at sample counts 1 and 4. The 4x pass resolves into a fresh single-sample texture. The full viewport `W × H` is rendered, and only the crop is copied out.

**Shader source.** Each candidate's WGSL is one literal module string, and its SHA-256 is recorded. The stable-source review checks the literals against these semantics. Any deviation in semantics is a contract change.

## Crop, oracle and metrics

**Crop.** The crop is the integer pixel bounding box of the reference region dilated by 3 px, then clipped to the viewport. A row whose region does not meet the viewport has an empty crop, and every metric for it is recorded as `N/A:empty`. The 3-px dilation covers the 1-px fringe plus a ramp of at most 0.71 px.

**Oracle.** `tests/geometry/coverage-oracle` (Sol medium) computes exact, dyadic per-pixel reference coverage. It takes an O(boundary length + crop rows × edges) approach:

1. Mark crossing pixels by exact segment traversal.
2. Classify the remaining pixels as fully inside or fully outside by exact row spans (parity of boundary crossings at the row center).
3. Compute the exact area of crossing pixels by clipping the triangles that overlap each pixel. Overlapping triangles are found by traversing all mesh edges, internal edges included.

Row-span parity uses a half-open crossing rule: an edge counts when `min(y) ≤ yc < max(y)`, and horizontal edges never count.

Class membership is bounded the same way. Band candidates are marked by traversing each boundary segment's 2-px-dilated pixel neighbourhood, and exact squared-distance tests run only on those pixels. Every other crop pixel takes inside or outside from the parity spans.

Host tests on synthetic shapes compare it with a brute-force per-pixel clipping oracle, and they run in `pnpm test:geometry`. The full-corpus oracle runs offline through `pnpm coverage:p3-o01`, not in `pnpm test:geometry`.

**Pixel classes.** Distances are exact squared Euclidean distances between the closed pixel square and the closed boundary segment, compared with 4 (that is, 2 px).

| Class    | Definition                                                                |
| -------- | ------------------------------------------------------------------------- |
| interior | Inside, and at least 2 px from every boundary segment                     |
| exterior | Outside, and at least 2 px from every boundary segment                    |
| band     | All other crop pixels                                                     |
| corner   | Band pixels within 2 px of a boundary vertex                              |
| seam     | A subset of interior: interior pixels whose square meets an internal edge |

**Metrics.** These are computed per row, candidate and sample count. Exact values are `{n, d, approx}` with `approx` from `toExponential(5)`.

| Metric           | Definition                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interior error   | Maximum of `1 - obs`. For A1 this is 0 by construction and is not a merit                                                                                                       |
| Exterior error   | Maximum of `obs`                                                                                                                                                                |
| Band deviation   | Maximum and RMS of `obs - ref`, with and without corner pixels                                                                                                                  |
| Boundary shift   | `Σ(obs - ref) / L`. L is the exact length of boundary ∩ V′, where V′ is the viewport inset by 3 px; the sum runs over band pixels whose square lies in V′. It is `N/A` if L = 0 |
| Seam error       | Maximum of `1 - obs`                                                                                                                                                            |
| 1x/4x difference | Maximum of `abs(obs1 - obs4)`                                                                                                                                                   |
| Overlap mass     | Count and maximum of (add − max) per class, from the two 1x `rgba16float` targets                                                                                               |
| THIN-Z1 area     | Observed and reference integrated area                                                                                                                                          |

There are no thresholds; Q4 remains a user decision.

**Stated limits.**

- Conversion of unorm8 values and 4x resolve averaging are implementation-defined. `obs4` includes resolve quantization, so the 1x/4x difference has a floor near 1/255.
- Rasterizer subpixel snapping is implementation-defined and not modeled. The rasterizer's viewport transform `(ndc + 1)·W/2` and the clip-space clipping of far-offscreen vertices run in implementation precision. They fall under this limit and are not part of the recorded displacement.
- `metrics.json` reports the count of `INPUT_UNSUPPORTED` rows, with their reasons.

## Runner, records and evidence

**Command and configuration.** `pnpm test:gpu:p3-coverage` runs `playwright.p3-coverage.config.ts` on port 4179.

- Headed Chrome and Edge, workers 1, retries 0, test timeout 1,500,000 ms.
- `.gitignore` gets `artifacts/p3.1o/`.
- The Vite entry is `p3-coverage.html`.
- `docs/validation.md` gets a row: headed, runner gates only, no threshold or performance claim.

**Page API: `window.__vectorStudioP3Coverage`.**

- **`init()`** returns `{status: READY | CAPABILITY_UNAVAILABLE | DEVICE_ERROR | RUNNER_ERROR, adapter, limits, shaderSha256}`. Preflight follows P3.1l:
  - a secure context;
  - a non-fallback adapter, using `adapter.info.isFallbackAdapter` plus a vendor/description blocklist for `swiftshader`, `basic render` and `llvmpipe`;
  - `requestDevice` with no extras.

  Creating the pipelines for both sample counts and formats is also a preflight step. A failure gives `CAPABILITY_UNAVAILABLE:<reason>`.

- **`render(request)`** takes `{rowIndex, width, height, crop: {x, y, w, h}, origin: [ox, oy], soupBase64, fringeBase64}`. It returns `{status: RENDERED | DEVICE_ERROR | DEVICE_LOST | ABORTED, reason, crops: [{candidate, sampleCount, pass: 'main' | 'diagMax' | 'diagAdd', format: 'rgba8unorm' | 'rgba16float', rleBase64, sha256}]}`.
  - Copies use `copyTextureToBuffer` with `bytesPerRow` aligned to 256. The page extracts channel R as unorm8 for `main`, and as float16 (uint16 bits) for `diagMax` and `diagAdd`.
  - Each crop is run-length encoded in row-major order as `(value, count)` pairs.
  - Error scopes `validation`, `out-of-memory` and `internal` wrap each render and are popped LIFO.
- **`snapshot()`** and **`dispose()`** follow P3.1l. `dispose()` is accepted in any state, and a pending render settles as `ABORTED`.

**Timeouts.** `init` 15,000 ms, each `render` 10,000 ms, `dispose` 5,000 ms, and the whole case 1,200,000 ms. The case statuses are as in P3.1l: `COMPLETE`, `PARTIAL`, `INTERRUPTED`, `CAPABILITY_UNAVAILABLE`, `DEVICE_ERROR`, `DEVICE_LOST` and `RUNNER_ERROR`.

**Records.** These follow P3.1l:

- exclusive writes;
- the record is written before any assertion;
- start and end source manifests, listing the config, spec, page, shader literals, builder, oracle and evidence-writer paths with SHA-256;
- contract identity;
- adapter metadata;
- one record per browser.

`capture.json` (schema `p3-coverage-capture-v1`) holds the inputs, NDC bits, edge coefficients, crop RLEs and their hashes. It may be split into parts. In that case `capture-index.json` lists each part with its SHA-256, and replay reads the index. Each crop `sha256` is over the decoded row-major bytes; float16 values are encoded as their uint16 bits. `metrics.json` (schema `p3-coverage-metrics-v1`) is computed offline from the capture alone (via `capture-index.json` when split). It uses fixed key order, two-space JSON and a final newline, and a replay test must reproduce it byte for byte. No timing fields appear in either file.

**Runner gates.** The test asserts only:

- the case is `COMPLETE`;
- every row is rendered or `INPUT_UNSUPPORTED`;
- the shader and upload hashes match;
- cleanup passes;
- the source manifest is unchanged.

**Archive.**

- The first complete record per browser goes to `docs/evidence/p3.1o-coverage/`, with no single file over 25 MB.
- Larger captures are split per candidate.
- `metrics.json` and a review record accompany it.

**Confirmation run.** For each browser, the per-crop SHA-256 values must be equal. Otherwise the differing pixels are reported, and runs are never averaged.

## Ownership and validation

There is no recursive delegation.

| Owner      | Scope                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary    | This contract; the config, script, Vite entry and `p3-coverage.html`; the page and shader literals; the CPU position, edge-coefficient and soup builder; the spec; the evidence writer; `.gitignore`; the validation.md row; the plan |
| Sol medium | `tests/geometry/coverage-oracle/*`: positions, the exact oracle, classes and metrics, synthetic host tests, the `pnpm coverage:p3-o01` script and the replay test                                                                     |
| Astra high | The stable-source review before GPU dispatch, and the independent evidence review                                                                                                                                                     |

**Validation:**

- `pnpm check`, `pnpm test:geometry` and `pnpm build`;
- headed `pnpm test:gpu:p3-coverage`, a first and a confirmation run, as local hardware evidence;
- `pnpm coverage:p3-o01`;
- changed-Markdown and link checks.

GitHub CI cannot run the headed GPU steps.

**Dependency order:** `O00 integrated -> this contract FROZEN -> oracle and runner implementation -> stable-source review -> headed observations -> offline metrics and replay -> independent evidence review -> user decisions Q4/Q5`.
