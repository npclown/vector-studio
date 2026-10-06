# P3.1l native vertex projection readiness

Status: L00 integrated through PR #96. L01-L06 written contract below is FROZEN, 2026-10-06, after Primary review and two rounds of independent arithmetic/WebGPU and implementability/governance review. Its contract identity is defined in that section. After this freeze is integrated, L07-L09 implementation may start. GPU dispatch still requires the stable-source review. This note narrows the next dependency after [K's ordered numeric model](p3-mesh-projection-experiment.md). The [private contract](p3-private-contract.md) still owns C03-C05; this note does not select a production mesh ABI or pass those gates. The [active plan](p3-fill-stroke-meshes.md) owns execution status.

## Selected next question

Observe the instrumented vertex-stage projection of all158 K mesh rows on hardware WebGPU in headed Chrome and Edge. Preserve original Float64 input bits, CPU-packed bytes and raw native clip words, then independently classify the unchanged1/16 physical-pixel position share and indexed topology. The separate legacy arithmetic counter remains K evidence, not a mesh input. This is a correctness experiment, not a performance run or production renderer integration.

All158 native rows are observational initially. K dispositions remain historical provenance only, including its thin-triangle rejection: that result relies on K's declared nearest-even graph and need not be reproduced by another permitted arithmetic evaluation. Do not infer required native outcomes from K's success count or from a first GPU run. Any additional guaranteed negative fixture requires a prospective literal input and independent proof before execution; no observed row may be replaced or removed to obtain a pass.

The first probe's hard gates are faithful packing/capture, complete identity, independent classification, corruption controls and retained evidence. Certification still requires the unchanged position bound AND topology; observational status never means that a failing mesh satisfies product requirements. Full P3 requires its own ordinary-success and raster gates.

## Why K cannot be used as a native bit oracle

The pinned [WGSL 2026-09-21 numeric rules](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-evaluation), sections15.7.2-15.7.5, permit rounding choices, subnormal flushing and reassociation; fusion has an accuracy condition. Division has its own accuracy allowance. Consequently K's binary64-then-binary32 nearest-even sequence does not describe every permitted native evaluation. Intermediate-bit equality to K is not native acceptance. Preserve the exact original-input geometric reference while evaluating actual final clip bits. These rules also prevent using runtime nonfinite behavior as a reliable overflow detector.

The existing P1 probe relocates point primitives into readback cells and passes the calculated clip position through flat varyings. The proposed experiment adopts that technique, so it observes an instrumented program. It does not observe the original triangle rasterization, clipping, subpixel coverage or an uninstrumented production shader. Even identical expression text can compile differently when instrumented; record exact shader source and keep that limitation explicit.

## Existing seams and bounded ownership

| Existing source                              | Reusable technique                                                                 | Boundary                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/playground/src/p1-position-probe.ts`   | Vertex execution, flat varyings, rgba32float targets, staging readback and cleanup | Its four-vertex primitive packet, shader replacement and resource IDs are P1-specific; do not extend its API for meshes |
| `playwright.gpu.config.ts`                   | Serial headed Chrome/Edge and isolated GPU output                                  | New targeted entry must be documented before use; preserve existing P1 tests                                            |
| `apps/playground/vite.config.mjs`            | Separate fixture HTML/TypeScript build entries                                     | A dedicated test page accepts serialized inputs; no public scene/path type or renderer port                             |
| `tests/support/p1-evidence.ts`               | Exclusive artifacts outside Playwright cleanup and source manifests                | Use a distinct P3 schema/root; never overwrite or relabel P1 records                                                    |
| `tests/geometry/mesh-projection/fixtures.ts` | Frozen original158 mesh inputs and K provenance                                    | No fixture reshaping after native output is seen                                                                        |
| `tests/geometry/conforming-mesh/oracle.ts`   | Independent projected-complex verification                                         | Verify the actual readback; do not refine or repair its mesh                                                            |

Primary owns the new contract, shared runner/configuration seams, evidence interpretation and integration. After freeze, one Sol high worker may own the isolated browser probe, and one Sol medium worker may own independent host decoding/audit fixtures only if their interface and file ownership are fixed first. Astra high reviews arithmetic/provenance and final claims. No recursive delegation or backend lifecycle changes are needed.

## Freeze checklist before any runner implementation

| ID  | Required concrete contract                                                                                                                                                 | Evidence method to freeze                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| L01 | Exact input identity/order, original64-to-packed32 arithmetic, byte offsets/alignment/padding, row/vertex index units, counts and checked size arithmetic                  | Independent byte provenance and malformed/overflow controls; no K result used as a native oracle                                      |
| L02 | Literal WGSL, entry points, binding/vertex lookup, w=1 and z convention, shader hash, row/vertex-to-texel mapping, bounded textures/chunks/submissions                     | Raw32 clip words plus identity/completeness sentinels; detect zero, stale, duplicate, swapped or missing captures                     |
| L03 | Exact rational viewport reconstruction from readback, original-input reference, reflection normalization and represented64 guard before the J verifier                     | Exact worst squared error/witness, separate position/topology, explicit nonfinite/nonrepresentable precedence and corruption fixtures |
| L04 | Device/format/limit preflight, detached uploads/readbacks, completion/unmap/destroy rules, terminal disposal and loss behavior                                             | Distinguish capability/device/capture failures from numerical classifications; deterministic ownership/cleanup checks                 |
| L05 | Versioned exclusive artifact schema, first complete record before assertions, partial/interrupted-run status, source-end integrity, browser/adapter/backend/flags metadata | Reproduction from original inputs/raw bits; immutable hashes and independent final review                                             |
| L06 | Actual named runner command, serial browser cases, local/static validation and prospective hardware evidence disposition                                                   | Runner acceptance remains separate from numeric feasibility; unavailable hardware is UNVERIFIED, never a pass                         |

The packed layout is an experimental carrier, not C04 adoption. Freeze actual caps and resource byte totals rather than borrowing unexplained P1 limits. No public export, new dependency, alternate renderer, mesh-cache policy or production rejection envelope follows from this note. A need for those changes returns to Primary and the existing user decision policy.

## L01-L06 written contract

This section gives a concrete answer for every row of the freeze checklist. If an implementation differs from any literal below, that is a contract change. It goes back to Primary and independent review before any GPU dispatch, and observed output never decides it. The contract identity in evidence is the `main` squash-merge commit that integrates the FROZEN status, and the lowercase SHA256 of this note's file bytes at that commit (`git show <commit>:docs/plans/p3-native-projection-readiness.md`), plus its git blob ID. The runner records both and requires that commit to be an ancestor of `baseCommit`.

### L01 input identity, packing and byte layout

**Corpus.** The native corpus is exactly the 158 mesh rows of `fixedProjectionFixtures()`, in their existing order. The legacy counter is excluded because it is not a mesh.

- `rowIndex` is the zero-based array position (0..157).
- `vertexIndex` is the zero-based position in that row's original `mesh.vertices`.
- Every vertex is projected, including any unreferenced vertex.
- Indices keep their original triangle order and are never uploaded.
- K's `disposition` is copied into the record only as `kDispositionHistorical`. Every native row is `OBSERVE`.

**Input identity.**

- Each row is identified by its `id` and the canonical input object in the archived K format: `{id, mesh: {vertices, indices}, affine, camera, origin, zoom, dpr, width, height}`.
  - Every binary64 input is written as 16 lowercase hexadecimal digits.
  - width, height and indices are JSON integers.
- `inputSha256` is the lowercase SHA256 of `JSON.stringify` of that object.
- Before packing, an independent identity check decodes `docs/evidence/p3.1k-projection/observations-20261005T073041.json`. It requires identical ids, order and input bits for all 158 mesh rows.
- From K's archive, only inputs and CPU-stage lanes are compared. K's `physical`, `ndc`, `recovered` and `audit` fields are never native expectations.

**CPU packing (original binary64 to packed binary32).**

- A new test-only packer evaluates only K's frozen CPU stages, using JavaScript binary64 and `Math.fround` in K's expression order:
  1. midpoint;
  2. local offsets;
  3. linear lanes;
  4. anchor;
  5. frame offset;
  6. scale;
  7. size.
- The packer does not call `simulateMeshProjection`. That function stops at JavaScript vertex-stage failures, which do not apply to native evaluation.
- Stage precedence is INPUT, MIDPOINT, LOCAL_OFFSET, LINEAR, ANCHOR, FRAME_OFFSET, SCALE, SIZE. A nonfinite lane, or a positive zoom or DPR that rounds to zero, yields `PACK_UNRESOLVED:<stage>`.
- No frozen corpus row is expected to reach that state. If any corpus row does, it is `provenance:pack:<stage>` and stops the run before the first dispatch. `PACK_UNRESOLVED` is reachable only in host controls.
- width and height must be integers in 1..16384, so their binary32 lanes are exact.

**Independent byte provenance.**

- A separate byte auditor decodes the packed bytes with little-endian `DataView` reads.
- It recomputes every float lane from the original input bits, using the exact rational rounders and the declared binary64-then-binary32 sequence.
- It compares numeric values exactly, with zeros compared geometrically.
- Every packed float lane must also equal the CPU lane recorded in the archived K row bit-for-bit, including the sign of zero, because the GPU consumes the exact bits. The packed f32 word is compared with the f32 word of the archived binary64 value, and that value must itself be exactly representable in f32.
- Integer, poison and padding words are checked bit-for-bit.
- A mismatch is `provenance:pack:<field>` and stops the run before dispatch. It is never a numeric classification.

**Uniform record `RowRecord`.** Exactly 64 bytes, WGSL uniform layout, little-endian.

| Byte offset | Type      | Field         | Value                                                                                               |
| ----------- | --------- | ------------- | --------------------------------------------------------------------------------------------------- |
| 0           | vec4<f32> | `linear`      | f32 lanes a, b, c, d                                                                                |
| 16          | vec2<f32> | `anchor`      | f32 anchor x, y                                                                                     |
| 24          | vec2<f32> | `frameOffset` | f32(fl64(Ox-cameraX)), f32(fl64(Oy-cameraY))                                                        |
| 32          | vec2<f32> | `scale`       | f32 zoom, f32 DPR                                                                                   |
| 40          | vec2<f32> | `size`        | f32 width, f32 height                                                                               |
| 48          | u32       | `rowIndex`    | rowIndex                                                                                            |
| 52          | u32       | `captureTag`  | Corpus: 0x70000000 + rowIndex, so the sequence equals rowIndex. The native control uses 0x7F000000. |
| 56          | u32       | `reserved0`   | 0                                                                                                   |
| 60          | u32       | `reserved1`   | 0                                                                                                   |

**Vertex array `array<VertexRecord, 256>`.** Exactly 4096 bytes with stride 16.

- Slot `v` occupies bytes 16v..16v+15:
  - `local: vec2<f32>` at +0 holds the f32 local offset x, y;
  - `rowIndex: u32` at +8;
  - `vertexIndex: u32` at +12.
- Slots `v < vertexCount` hold that vertex.
- Slots `vertexCount..255` hold the poison record. Its local lanes are 0x7FC00000 and both integer words are 0xFFFFFFFE. All poison words are written with `setUint32`, never with float stores.
- Every submission uploads the complete 64-byte uniform and the complete 4096-byte vertex array: 4160 bytes per row and 657,280 bytes for 158 rows.

**Counts and checked arithmetic.**

- `vertexCount` must be a safe integer in 1..256.
- `indices.length` must be a positive multiple of 3, with at most 256 triangles.
- These are K's frozen bounds, not runtime limits.
- The frozen corpus has 1,531 vertices, at most 14 per row, and 1,179 triangles.
- Every byte offset is computed as `16 * slot + fieldOffset` with safe-integer checks. Produced lengths must be exactly 64 and 4096 bytes. The L02 texel and readback offsets use the same checked arithmetic.

**L01 host controls (before any GPU code).** Each control must fail with its intended reason:

- zero vertices;
- 257 vertices;
- a non-integer or out-of-range index;
- an index count that is not a multiple of 3;
- a nonfinite coordinate;
- an affine lane that overflows binary32 (`PACK_UNRESOLVED:LINEAR`);
- a positive zoom that underflows binary32 (`PACK_UNRESOLVED:SCALE`);
- a size above 16384;
- a truncated or extended blob;
- a nonzero reserved word;
- a changed poison word;
- one flipped bit in each lane class;
- a byte-swapped lane;
- a sign-flipped zero lane.

A mutated input id, input bit or row order must fail the archived-input identity check.

### L02 literal shader, mapping and submissions

**Shader identity.**

- The WGSL below is the complete shader module. It is exported verbatim as `P3_NATIVE_PROJECTION_WGSL` from the side-effect-free module `apps/playground/src/p3-native-projection-shader.ts`. That module has no imports and no references to `window`, `navigator` or `document`.
- The host imports the same constant and computes `shaderSha256` over its UTF-8 bytes.
- The page returns the SHA256 of the string it compiled, and the two must match.
- Changes to whitespace or comments are contract changes, because they change the hash.
- No host-side WGSL validator exists. A `getCompilationInfo` error or a pipeline-creation failure is therefore a contract defect that returns to review. It is not an observation.

```wgsl
struct RowRecord {
  linear: vec4<f32>,
  anchor: vec2<f32>,
  frameOffset: vec2<f32>,
  scale: vec2<f32>,
  size: vec2<f32>,
  rowIndex: u32,
  captureTag: u32,
  reserved0: u32,
  reserved1: u32,
};

struct VertexRecord {
  local: vec2<f32>,
  rowIndex: u32,
  vertexIndex: u32,
};

@group(0) @binding(0) var<uniform> row: RowRecord;
@group(0) @binding(1) var<storage, read> vertices: array<VertexRecord, 256>;

struct ProbeVarying {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) xyWords: vec4<u32>,
  @location(1) @interpolate(flat) zwWords: vec4<u32>,
};

struct ProbeTargets {
  @location(0) xyWords: vec4<u32>,
  @location(1) zwWords: vec4<u32>,
};

fn projectVertex(u: vec2<f32>) -> vec4<f32> {
  let sx = ((row.linear.x * u.x) + (row.linear.z * u.y)) + row.anchor.x;
  let sy = ((row.linear.y * u.x) + (row.linear.w * u.y)) + row.anchor.y;
  let rx = sx + row.frameOffset.x;
  let ry = sy + row.frameOffset.y;
  let px = (rx * row.scale.x) * row.scale.y;
  let py = (ry * row.scale.x) * row.scale.y;
  let nx = ((px * 2.0) / row.size.x) - 1.0;
  let ny = 1.0 - ((py * 2.0) / row.size.y);
  return vec4<f32>(nx, ny, 0.0, 1.0);
}

@vertex
fn nativeProjectionVertex(@builtin(vertex_index) slot: u32) -> ProbeVarying {
  let record = vertices[slot];
  let clip = bitcast<vec4<u32>>(projectVertex(record.local));
  let column = slot % 16u;
  let line = slot / 16u;
  var output: ProbeVarying;
  output.position = vec4<f32>(
    ((f32(column) + 0.5) * 0.125) - 1.0,
    1.0 - ((f32(line) + 0.5) * 0.125),
    0.0,
    1.0,
  );
  output.xyWords = vec4<u32>(clip.x, clip.y, record.vertexIndex, row.captureTag);
  output.zwWords = vec4<u32>(clip.z, clip.w, record.rowIndex, row.rowIndex);
  return output;
}

@fragment
fn nativeProjectionFragment(input: ProbeVarying) -> ProbeTargets {
  var targets: ProbeTargets;
  targets.xyWords = input.xyWords;
  targets.zwWords = input.zwWords;
  return targets;
}
```

**Instrumented arithmetic.**

- `projectVertex` writes K's expression structure in source order. The pinned WGSL rules still allow the implementation to reassociate, fuse, flush, use the division accuracy allowance or produce indeterminate values on overflow. The record therefore treats only the captured words as native output.
- z is the literal +0 (word 0x00000000) and w is the literal 1 (word 0x3F800000).
- The clip vector is bitcast before the inter-stage interface. Neither floating-point varyings nor float render targets ever carry it, so neither can canonicalize it.
- Both texels carry submission identity, so stale data in either texture is detected. XY also carries the slot, so shifted or swapped XY data is detected. ZW carries no slot, but its data words are slot-invariant constants, and a shifted sentinel is reported as `missing`.

**Relocated point position.**

- It uses small integers, +0.5, multiplication by 0.125 and ±1.
- Each result is exactly representable, and these correctly rounded operations make it exact.
- Even a deviation of a few ULP would stay inside the same 1x1 point footprint. Slot `v` therefore rasterizes in texel (v mod 16, floor(v / 16)).

**Pipeline.**

- An explicit `createBindGroupLayout` has exactly:
  - binding 0: `{buffer: {type: 'uniform'}, visibility: VERTEX}`;
  - binding 1: `{buffer: {type: 'read-only-storage'}, visibility: VERTEX}`.
- An explicit `createPipelineLayout` with that single layout is used, never `layout: 'auto'`.
- `createRenderPipelineAsync` sets:
  - vertex entry `nativeProjectionVertex`;
  - fragment entry `nativeProjectionFragment`;
  - no vertex buffers;
  - topology `point-list`;
  - two `rgba32uint` color targets with no blend;
  - no depth/stencil and no multisampling.

**Per submission.**

1. The page writes the uniform and the complete vertex array with `queue.writeBuffer`.
2. It encodes one render pass on two 16x16 `rgba32uint` textures. Each is cleared to the sentinel (4294967040, 4294967040, 4294967040, 4294967040). That is word 0xFFFFFF00, which is exactly representable as a float clear value.
3. It calls `draw(drawCount, 1, 0, 0)`.
4. It copies the `xyWords` texture to readback offset 0 and the `zwWords` texture to offset 4096, with `bytesPerRow` 256 and `rowsPerImage` 16.
5. It submits once and maps the full 8192-byte readback.

Texel (column, line) of a texture starts at `textureOffset + 256 * line + 16 * column`, and slot = 16 \* line + column.

- Corpus submissions use `drawCount = vertexCount`.
- Exactly one row goes in each command buffer.
- The next submission starts only after the previous readback has been copied and unmapped.
- A complete corpus case makes exactly 158 submissions.

**Capture decoding.**

- The decoder's inputs are the readback bytes and the host-expected `(rowIndex, expectedCount = vertexCount, captureTag)`. It never uses the page-side `drawCount`.
- For each slot `v` in 0..255, it reads XY = the four words at offset 0 and ZW = the four words at offset 4096.
- It reports the first failure in slot order. Within a slot it applies the rules below in order.

For `v < expectedCount`:

1. If either texel is all sentinel words: `capture:missing:<v>`.
2. If either texel is all zero: `capture:zero:<v>`.
3. If XY[2] or ZW[2] is 0xFFFFFFFE: `capture:poison:<v>`.
4. If XY[3] differs from captureTag, or ZW[2] or ZW[3] differs from rowIndex: `capture:stale:<v>`.
5. If XY[2] is in [0, expectedCount) but differs from v: `capture:swapped:<v>`.
6. Any other XY[2] mismatch: `capture:identity:<v>`.
7. If (ZW[0], ZW[1]) is not (0x00000000, 0x3F800000): `capture:clip-zw:<v>`.

For `v >= expectedCount`, any word that is not the sentinel gives `capture:extra:<v>`.

A duplicated capture appears as `swapped` or `stale` at one of its slots. Clip x/y words (XY[0], XY[1]) are never altered or reinterpreted during decoding.

**Corruption evidence.**

Host unit controls construct 8192-byte readbacks from known words and require each named failure, including:

- the first-matching rule when several apply;
- one swapped pair;
- one zeroed slot;
- one sentinel slot in either texture;
- a stale captureTag;
- a stale rowIndex in only the ZW texture;
- a poison identity;
- a value beyond expectedCount;
- a changed z or w word.

The runner also has one native control per browser:

- It runs in its own page and device: corpus row 0, `drawCount = vertexCount - 1`, captureTag 0x7F000000.
- It is decoded with `expectedCount = vertexCount`.
- It must yield exactly `capture:missing:<vertexCount - 1>`, with every earlier slot otherwise valid.
- Its clip words are recorded but never classified.

### L03 classification

**Imports.**

- Classification is a pure host-side function of (original input, captured words).
- The classifier and the L01 byte auditor may import only these symbols, which a static import test enforces:
  - `roundExact32` and `roundExact64` from `tests/geometry/mesh-projection/audit.ts`;
  - `fixedProjectionFixtures` from `tests/geometry/mesh-projection/fixtures.ts`;
  - `verifyConformingRefinement` from `tests/geometry/conforming-mesh/oracle.ts`;
  - the rational helpers of `tests/geometry/rounded-fill/exact.ts`.
- The type-only import `import type { ProjectionInput }` from `tests/geometry/mesh-projection/model.ts` is also permitted. The static test permits it only as `import type`.
- Nothing else from `mesh-projection/` may be imported, including `simulateMeshProjection` and `auditMeshProjection`.

**Steps.**

1. **Unclassified rows.** Rows without a valid capture are not classified. They keep their status: `CAPTURE_INVALID:<reason>`, `NOT_RUN` or `ABORTED`.
2. **Input validation.** The input must have:
   - between 1 and 256 vertices, each a pair of finite numbers;
   - a positive index count that is a multiple of 3, with at most 256 triangles, and every index a safe integer in [0, vertexCount);
   - six finite affine lanes;
   - finite camera and origin pairs;
   - finite positive zoom and DPR;
   - integer width and height in 1..16384.

   It must then pass `verifyConformingRefinement(mesh, {...mesh, parentTriangle: [0..triangleCount-1]})`. Any failure throws `input:<reason>`, which is retained as a row error, not a numeric result.

3. **Nonfinite words.** For vertexIndex 0..vertexCount-1 in array order, including unreferenced vertices, x then y: a clip word with exponent 0xFF (infinity or NaN) gives `NUMERIC_UNRESOLVED` with reason `nonfinite-clip:<vertex>:<axis>`. Any other word, including subnormals and signed zero, decodes exactly as a binary32 rational. This loop finishes before step 4 begins.
4. **Viewport reconstruction.** Using the original integer `W` and `H`, compute rx = (nx + 1) \* W / 2 and ry = (1 - ny) \* H / 2 as exact rationals. Use the same vertex and axis order, again including unreferenced vertices. Represented64 guard: if `roundExact64` of either value differs from the exact rational, the result is `NUMERIC_UNRESOLVED` with reason `viewport-not-exact:<vertex>:<axis>`. The verifier receives only binary64 numbers equal to the exact recovered rationals. Native overflow may produce finite indeterminate words instead of infinity. Such rows are classified by these rules, and steps 3 and 4 make no claim to detect overflow.
5. **Singular affine.** If the exact original affine determinant is zero, the result is `NUMERIC_UNRESOLVED` with reason `singular-affine`.
6. **Position.**
   - The reference is K's exact original-input value: ((a*x + c*y + e - cameraX) * zoom \* DPR, (b*x + d*y + f - cameraY) * zoom \* DPR).
   - For every referenced vertex, compute the exact squared Euclidean displacement.
   - `positionPass` holds if and only if the maximum is at most 1/256, the unchanged 1/16 physical-pixel share.
   - Ties for the worst vertex go to the lowest referenced index.
7. **Topology.**
   - Each raw recovered triangle (i, j, k) must have the strict sign of the exact original determinant. Otherwise `topologyPass` is false with reason `topology:orientation:<triangle>`, where <triangle> is the first failing triangle in index order.
   - Then, when det < 0, every triangle (i, j, k) becomes (i, k, j); when det > 0, triangles are unchanged.
   - The normalized indices go through `verifyConformingRefinement` as a self-parent bridge, with recovered vertices and unchanged incidence.
   - A J verifier failure sets `topologyPass` to false, with reason `topology:<verifier message>`.
   - No clipping, welding or refinement repair is allowed.
8. **Status.** Precedence is TOPOLOGY_REJECTED, then POSITION_LIMIT, then CERTIFIED. Both booleans are always preserved. For NUMERIC_UNRESOLVED, `positionPass`, `topologyPass`, `maxSquared` and `worstVertex` are null. `maxSquared` is a reduced decimal-string `{n, d}`. CERTIFIED has a null reason, and POSITION_LIMIT has reason `position-limit`.

**Result shape.** `{status, positionPass, topologyPass, maxSquared, worstVertex, reason}`, with status one of `CERTIFIED | TOPOLOGY_REJECTED | POSITION_LIMIT | NUMERIC_UNRESOLVED`. A native CERTIFIED is a per-row observation on that browser and adapter. It is neither a product guarantee nor a K disposition.

**L03 host controls (required before GPU execution).**

- **Replay control.** Encode K's archived f32 NDC words for all 158 rows, plus the literal z/w and identity words, as synthetic captures. Decoding and classifying them must reproduce exactly K's archived status, positionPass, topologyPass, maxSquared, worstVertex and reason. This validates the decoder and classifier against independently audited arithmetic. It is not a native expectation.
- **Synthetic controls:**
  - infinity and NaN clip words (`nonfinite-clip`);
  - the K out-of-corpus nx = 2^60 control, which must report `viewport-not-exact` before topology;
  - an exactly singular affine;
  - a one-ulp change on an ordinary rectangle row that changes `maxSquared`;
  - a vertex displaced by more than 1/16 pixel with topology intact (`POSITION_LIMIT`);
  - K's thin-control words (`TOPOLOGY_REJECTED`);
  - a reflected row with a flipped raw orientation;
  - positive and negative zero, and subnormal words, which must decode exactly.
- **Nonfinite precedence.** An infinity in a later vertex plus an inexact recovery in an earlier vertex must report the nonfinite reason.

### L04 device, resources and lifecycle

**Page ownership.** The page is a test-only fixture. It calls `navigator.gpu` directly and owns its own adapter and device. It does not use the renderer backend, the renderer-core packet path or the P1 probe. Shared lifecycle stays unchanged.

**Preflight.** Checks run in order, and the first failure gives `CAPABILITY_UNAVAILABLE:<reason>`. That status is UNVERIFIED evidence, never a numeric outcome.

1. A secure context with `navigator.gpu` present.
2. `requestAdapter()` with no options returns a non-null adapter.
3. Fallback detection:
   - the adapter is a fallback (`fallback`) if `adapter.info.isFallbackAdapter === true` or the legacy `adapter.isFallbackAdapter === true`;
   - if neither field exists, the result is `fallback-unknown`, which is also a preflight failure;
   - the result is `software` if vendor, architecture or description contains `swiftshader`, `basic render` or `llvmpipe` (case-insensitive); the matched text is recorded.
4. `requestDevice()` with no required features or limits.
5. Device limits must be at least:
   - `maxBindGroups` 1;
   - `maxColorAttachments` 2;
   - `maxColorAttachmentBytesPerSample` 32;
   - `maxStorageBuffersPerShaderStage` 1;
   - `maxStorageBuffersInVertexStage` 1, where exposed;
   - `maxStorageBufferBindingSize` 4096;
   - `maxUniformBufferBindingSize` 64;
   - `maxTextureDimension2D` 16;
   - `maxInterStageShaderVariables` 2.

Adapter vendor, architecture, device and description are always recorded.

**Resources.** Created once per page device, inside error scopes pushed in the order `validation`, `out-of-memory`, `internal` and popped in reverse order:

| Resource      | Size / usage                                        |
| ------------- | --------------------------------------------------- |
| Uniform       | 64-byte buffer, `UNIFORM \| COPY_DST`               |
| Vertex array  | 4096-byte buffer, `STORAGE \| COPY_DST`             |
| Two textures  | 16x16 `rgba32uint`, `RENDER_ATTACHMENT \| COPY_SRC` |
| Readback      | 8192-byte buffer, `MAP_READ \| COPY_DST`            |
| Shader module | The literal string above                            |
| Pipeline      | Created as specified in L02                         |

Fixed device allocation is 20,544 bytes plus the pipeline and bind group. A compilation error or a rejected pipeline promise gives `RUNNER_ERROR:contract-shader`, which returns to review. A non-null popped scope gives `DEVICE_ERROR:setup`.

**Per submission.**

- The same three scopes wrap each submission and are popped after `mapAsync` settles.
- The page copies the mapped range with `slice(0)` into a detached `ArrayBuffer`, then unmaps.
- It returns base64 together with the SHA256 of the uniform and vertex bytes it actually uploaded. The host compares these with the bytes it sent.
- Upload sources are fresh `Uint8Array` copies, so later host mutation cannot change an earlier submission.

**Failure states.**

- A popped error, an `uncapturederror` event or a rejected `mapAsync` gives `DEVICE_ERROR:<rowIndex>`.
- `device.lost` gives `DEVICE_LOST:<reason>`.
- Either one is terminal for the case:
  - remaining rows are `NOT_RUN`;
  - the device is never recreated within a case;
  - rows are never retried.
- In the corpus case, a `CAPTURE_INVALID` row is not terminal. Dispatch continues, and the case becomes `PARTIAL` with reason `capture-invalid`.
- In the control case, the expected `capture:missing:<vertexCount - 1>` is the required result. Any other capture status makes the control case `PARTIAL` with reason `control-mismatch`.
- A `device.lost` resolution with reason `destroyed` after `dispose()` is the expected terminal signal, not a loss.

**Page API.** `window.__vectorStudioP3Projection` is created by `apps/playground/src/p3-native-projection.ts`.

| Member             | Contract                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init()`           | Returns `{status: 'READY' \| 'CAPABILITY_UNAVAILABLE' \| 'DEVICE_ERROR' \| 'RUNNER_ERROR', reason, adapter, limits, shaderSha256, compilationMessages}`                                                                             |
| `capture(request)` | Request: `{rowIndex, captureTag, drawCount, uniformBase64, verticesBase64}`. Resolves `{status: 'CAPTURED', readbackBase64, uploadSha256: {uniform, vertices}}` or `{status: 'DEVICE_ERROR' \| 'DEVICE_LOST' \| 'ABORTED', reason}` |
| `snapshot()`       | Returns `{state: 'IDLE' \| 'READY' \| 'BUSY' \| 'FAILED' \| 'DISPOSED', buffersCreated, buffersDestroyed, texturesCreated, texturesDestroyed, deviceDestroyed, readbackMapState, lostReason}`                                       |
| `dispose()`        | Accepted in every state, including BUSY. Unmaps a mapped readback, destroys every buffer and texture and calls `device.destroy()`. A pending `capture` settles as `ABORTED`, which is recorded and never classified.                |

- An overlapping `capture` rejects with `busy`.
- `dispose()` is idempotent, and every later call rejects with `disposed`.

**Host bounds.**

- Call timeouts:
  - `init`: 15,000 ms;
  - each `capture`: 3,000 ms;
  - `dispose`: 5,000 ms;
  - the whole case: 540,000 ms, below the 600,000 ms test timeout.
- A timeout marks the case `INTERRUPTED` and stops dispatch.
- `finally` calls `dispose()` and then `snapshot()`. Cleanup PASS requires DISPOSED, buffers 3/3 destroyed, textures 2/2 destroyed, the device destroyed and a readback that is not mapped.
- If either call times out or throws, cleanup is recorded as `UNAVAILABLE`. That is a runner failure, but the record is still written.
- A cleanup mismatch is a runner failure even when every capture is valid.

### L05 evidence records

**Root.**

- The root is chosen once per command, in the Playwright config module. The config reads `P3_NATIVE_PROJECTION_OUTPUT_DIR`, or else sets it to `artifacts/p3.1l/<ISO-timestamp-with-colons-and-dots-replaced>-<pid>` resolved against the repository root (the config directory), before workers start. A worker restart therefore keeps the same root.
- The root must not lie inside `test-results`. It must also be either outside the repository or under a path in `.gitignore`. The implementation adds `artifacts/p3.1l/` to `.gitignore`.
- Each case writes `<root>/<project>/<sanitized-test-title>/`. Parents are created recursively. The final case directory uses a non-recursive `mkdir`, which fails if it already exists.
- Each file is assembled fully in memory, written to `<name>.tmp` with flag `wx`, then renamed to the absent final name.
- P1 roots, helpers and schemas are never reused or relabeled.

**`capture.json`** (schema `p3-native-projection-capture-v1`) is written before any assertion. That includes failed, partial, interrupted and cleanup-unavailable cases. It contains:

- **Contract:** the contract-identity commit, this note's path, file SHA256 and blob ID at that commit, the working-tree SHA256 of this note, `shaderSha256` and the literal WGSL.
- **Run:** ISO start/end timestamps; project name; Playwright `browser.version()`; user agent; launch arguments.
- **Adapter:** vendor, architecture, device, description and fallback fields as exposed. `backend` is a browser-exposed backend string, or the literal `UNEXPOSED`.
- **Device:** the L04 limits.
- **Case:** status `COMPLETE`, `PARTIAL`, `INTERRUPTED`, `CAPABILITY_UNAVAILABLE`, `DEVICE_ERROR`, `DEVICE_LOST` or `RUNNER_ERROR`, with a reason.
- **Source:** start and end source manifests, made with the P1 manifest method (base commit, `git status --short`, per-file SHA256, manifest SHA256). Each manifest is extended with the SHA256 of this note and of the archived K observation file.
- **Cleanup:** the snapshot, or `UNAVAILABLE`.
- **Rows:** one record per corpus row in rowIndex order, with `NOT_RUN` for rows never dispatched. Each row has `id`, `rowIndex`, `kDispositionHistorical`, the input encoding, `inputSha256`, pack status, uniform and vertex base64 with SHA256, `captureTag`, the upload-digest echo, readback base64 with SHA256, and capture status.
- **Control:** the control test writes its single row in the same shape.

**COMPLETE.** Each case is COMPLETE only when the start and end manifests are identical (including `git status --short`) and cleanup passes. In addition:

- A corpus case also needs all 158 rows validly captured.
- A control case also needs exactly the `capture:missing:<vertexCount - 1>` result with every earlier slot valid.

A changed manifest makes the case `PARTIAL` with reason `source-changed`, and that record cannot support any claim. `source-changed` takes precedence over `capture-invalid` and `control-mismatch` as the primary reason, and every applicable reason is listed.

**`classification.json`** (schema `p3-native-projection-classification-v1`, corpus case only) is written next. It contains no timestamps. It holds:

- the SHA256 of `capture.json` and the classifier source SHA256 values;
- for each row: the classification result, `{error}` for a thrown input error, or the unclassified capture status.

A thrown row error does not suppress later rows. Classification is reproducible offline from `capture.json` alone. Primary reruns it from the archived capture and requires a byte-identical `classification.json`.

**Format, logging and archive.**

- Both files use two-space JSON indentation and a final newline, and the log prints their paths and SHA256.
- The first complete record for each browser, and every earlier failed or partial record, is archived under `docs/evidence/p3.1l-native-projection/` with commands and hashes. Archived records are never replaced.
- A later same-machine rerun is compared row by row. Inputs must be identical. Differing captured words are reported as a nondeterminism finding and are never resolved by choosing one run.

### L06 runner and evidence disposition

**Command.** `pnpm test:gpu:p3-projection` is defined as `playwright test --config playwright.p3-native-projection.config.ts`. The config mirrors `playwright.gpu.config.ts`: headed `chrome` and `msedge` projects, `--enable-unsafe-webgpu`, `workers: 1`, `fullyParallel: false` and `retries: 0`. It differs only in:

| Setting      | Value                               |
| ------------ | ----------------------------------- |
| `testDir`    | `./tests/gpu-p3-projection`         |
| `outputDir`  | `./test-results/gpu-p3-projection`  |
| Port         | 4177 (4173-4176 and 4178 are taken) |
| Test timeout | 600,000 ms                          |
| Root         | Resolved as in L05                  |

The page entry `p3-native-projection.html` is added to the playground Vite inputs. The existing `pnpm test:gpu` and P1 files keep their behaviour.

**Test order.** Each browser project runs `native capture control` and then `native projection corpus`, each with a fresh page and device. The corpus test runs even if the control fails, so that its evidence is retained. Runner acceptance still needs both. After writing its records, each test asserts only the runner hard gates:

- the case is COMPLETE;
- the upload digests and `shaderSha256` match;
- packing and archived-input provenance pass;
- every corpus row is classified without a thrown error;
- cleanup passes;
- source integrity holds.

No native numeric status, success count or K agreement is asserted, and all 158 rows remain OBSERVE.

**Interfaces fixed for implementation.**

| File                                                                                       | Owner | Exports                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/playground/src/p3-native-projection-shader.ts`                                       | L08   | `P3_NATIVE_PROJECTION_WGSL: string`                                                                                                                                                                    |
| `apps/playground/p3-native-projection.html`, `apps/playground/src/p3-native-projection.ts` | L08   | The page API above, plus the type `P3ProjectionPageApi`                                                                                                                                                |
| `tests/geometry/native-projection/pack.ts`                                                 | L07   | `packNativeProjectionRow(input: ProjectionInput, rowIndex: number, captureTag: number): {status: 'PACKED', uniform: Uint8Array, vertices: Uint8Array} \| {status: 'PACK_UNRESOLVED', stage}`           |
| `tests/geometry/native-projection/byte-audit.ts`                                           | L09   | `auditPackedRow(input, rowIndex, captureTag, uniform, vertices, archivedCandidate): void`, throwing `provenance:pack:<field>`; `checkArchivedInputs(fixtures, archive): void`                          |
| `tests/geometry/native-projection/decode.ts`                                               | L09   | `decodeCapture(readback: Uint8Array, expected: {rowIndex, expectedCount, captureTag}): {status: 'CAPTURED', clipWords: readonly (readonly [number, number])[]} \| {status: 'CAPTURE_INVALID', reason}` |
| `tests/geometry/native-projection/classify.ts`                                             | L09   | `classifyNativeProjection(input: ProjectionInput, clipWords): NativeProjectionClassification`, with the L03 shape                                                                                      |
| `tests/support/p3-native-projection-evidence.ts`                                           | L07   | Root resolution, exclusive writer, manifests                                                                                                                                                           |
| `tests/gpu-p3-projection/native-projection.spec.ts`                                        | L07   | Both tests                                                                                                                                                                                             |

`ProjectionInput` is imported only as a type. Clip words are unsigned 32-bit integers. `pack.ts` and `byte-audit.ts` have different owners and share no module except the allowlisted rounders. Astra high reviews the auditor against the packer for independence.

**Validation for the implementation PR.**

- `pnpm check`: format, lint, typecheck and boundaries cover the new files.
- `pnpm test:geometry`: runs the L01-L03 host controls under `tests/geometry/native-projection/`, locally and in required CI.
- `pnpm build`.
- `pnpm test:gpu`, unchanged, as a P1 regression on hardware.
- Explicit Markdown, link and diff checks.
- L07 adds the `pnpm test:gpu:p3-projection` row to the `docs/validation.md` command table.
- GitHub CI cannot run headed hardware WebGPU. The PR therefore lists `pnpm test:gpu:p3-projection` with its local hardware result, or `NOT RUN` and the reason.

**Prospective disposition per browser.**

| Outcome                                                                                       | Disposition                                     |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| COMPLETE control and corpus on an adapter that is not fallback or software; every gate passes | Runner acceptance PASS for that browser/adapter |
| `CAPABILITY_UNAVAILABLE`                                                                      | UNVERIFIED                                      |
| Any other status or failed gate                                                               | Runner FAIL, with every record retained         |

Runner acceptance is not numeric feasibility. A separate evidence review reports:

- each browser's per-row native status distribution;
- Chrome/Edge word equality;
- the exact worst error.

That review may report differences from K only as observations. No row is removed, replaced or reinterpreted after output is seen.

**Work units after freeze.** There is no recursive delegation. L08 and L09 depend only on the literals and interfaces above and run in parallel. L07 integrates their files after both pass their host controls.

| Unit | Owner      | Scope                                                                                             |
| ---- | ---------- | ------------------------------------------------------------------------------------------------- |
| L07  | Primary    | Config, script, Vite input, `.gitignore`, the validation.md row, packer, evidence writer and spec |
| L08  | Sol high   | Page and shader module                                                                            |
| L09  | Sol medium | Byte auditor, decoder, classifier and all L01-L03 host controls                                   |

After that come:

1. Primary/Astra high stable-source review.
2. Serial native observations.
3. Archive.
4. Independent Astra high evidence review.

## Dependency order and readiness acceptance

`K integrated -> L00 readiness -> complete L01-L06 written freeze -> isolated runner/audit implementation -> stable-source review -> serial native observations -> independent evidence review -> separate production/raster decisions`.

L00 passes only when Primary and independent reviewers agree on source seams, evidence limits, the concrete missing freeze items and this dependency order; changed Markdown formatting, local links/anchors, whitespace and scope checks must pass. No new product test, GPU run or benchmark is needed for L00. Required protected PR CI still applies. L00 completion authorizes the next contract work; it does not authorize a GPU dispatch with unresolved L01-L06 details.

Production mesh operation/layout, CPU/GPU cache generations, completion-safe allocator retirement, public path composition and actual raster coverage/fringe/MSAA remain separate. Deferred stroke remains deferred. The finite K corpus and this future probe cannot establish ordinary1,000-path capacity or universal precision.
