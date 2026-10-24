# E10 contract: renderer test hooks for A08 (forced sample count, fringe-off, frame capture, count pass)

Status: APPROVED 2026-10-24 by the user in chat, with E10-Q1 to E10-Q3 as recommended (option (a) each; independent review round 2 READY, sections 12 and 13). E10-U1 may start.

Track: rendering. Item: E10 of the [D9 rendering track plan](d9-rendering-track.md#status-index), phase R1 of [D10](d10-roadmap-reset.md). Tier: full, because E10 adds published members to `renderer-core` and `renderer-webgpu`, which are part of the [D9 shared surface](d9-post-mvp1-tracks-proposal.md#boundary). Both tracks review it.

Source of the item: needs VZ4-D2 and VZ4-D3 of the approved [V-4 contract](viz-v4-a08-corpus-contract.md#2-dependencies-and-shared-surface), and its answer to VZ4-Q5 (a): the hooks belong to the rendering track so that A08 is evidenced on the product path, not on a rebuilt pipeline. The visual contract they serve is [V3 section k](p3-v3-renderer-mesh-pipeline-contract.md#k-a08-visual-contract).

This contract owns the hook surface, its semantics, its acceptance criteria and its validation. It changes no requirement, threshold, acceptance criterion, milestone order, port, ABI, operation identity or `packages/contracts` export, and no product behavior: with no hook option set, the renderer issues the same GPU work as today (E10-A1). It makes no performance and no precision claim. Criteria are E10-A1 to E10-A9 and questions E10-Q1 to E10-Q3.

## 1. Scope

### 1.1 In scope

1. **Fringe-off (VZ4-D2).** A `renderer-core` option that draws every path paint region-only: region triangles with `c = 1`, no exterior triangles, and no fringe builder call.
2. **Forced sample count (VZ4-D2).** A `renderer-webgpu` option that fixes the sample count at 1 or 4. A forced 4 fails initialization when 4x is unavailable; it never falls back.
3. **Frame capture (VZ4-D3).** An exact physical-pixel copy of the texture that the frame presents, taken in the frame's own command buffer.
4. **Count pass (VZ4-D3).** O02's count pass on the product mesh draws of the captured frame: the same vertex code, buffers, bind group, instances and draw ranges. It gives a 1x center count or four per-sample counts per pixel.
5. **Draw record.** For each mesh draw of the captured frame: its node, paint, fringe state, and region and exterior triangle counts. VZ4-A5 needs it.
6. A minimal headed check page and spec with positive and negative controls (section 6), and fake-platform unit tests.

### 1.2 Out of scope

- The V-4 page, corpus, metrics and gates. They stay in the V-4 contract.
- Any change to shaders, blending, the clear color, the fringe builder or the kernel. The product clear is opaque black `(0, 0, 0, 1)` (`native-primitive-scene.ts`). V-4 section 4.3 says "transparent black". The coverage still reads exactly from R, because white over opaque black gives `R = c`. E10 keeps the clear and reports this wording to V-4 (section 8).
- Migrating the existing test pages (`p3-v3-mesh`, `e3-a04-readback`) to these hooks. That would be a backlog item.
- Stroke or joint gates. The hooks apply to every paint, and gating stays V-4's decision (VZ4-Q4).

## 2. Why the published surface is not enough today

- `PrimitiveRendererService` always installs `buildPathFringe` (`packages/renderer-core/src/primitive-renderer-service.ts`). The region-only seam exists inside `PathMeshPipeline`: with no builder, a variant has role-0 region triangles and empty lists (`path-mesh-packet.ts`). That pipeline is not exported. Only unit tests reach the seam.
- `createPrimitiveScene` tries 4x and falls back to 1x with `capability.msaa-fallback` (`native-primitive-scene.ts`). The `p3-v3-mesh` page forces 1x by rejecting 4x pipeline creation through a platform proxy. That path emits the fallback warning, and it cannot force 4x.
- The canvas is configured without `COPY_SRC`. The `p3-v3-mesh` page adds `COPY_SRC` and copies the canvas texture through a device proxy, in a second submission. V-3 used a compositor screenshot, which cannot carry a 2/255 gate.
- The mesh bind group, arena buffers and draw list live inside `NativePrimitiveScene`. A page cannot issue a count pass on the same buffers without rebuilding them from packet writes. Packet formats are not shared surface (D9 Boundary).

## 3. Hook surface

All names end in `ForTesting`, as `destroyDeviceForTesting()` and `getOverlayBuildCountForTesting()` already do. The platform port members of section 3.2 (`usage`, `configuredUsage`, `sampleCount`, `countPass`) are exempt from the naming rule but carry the same comment. The naming follows that precedent; the `@internal Tests only` comment follows `getOverlayBuildCountForTesting()` only, and every E10 member carries it. No product app or SDK page may set them. Review checks this: `apps/playground` pages may use them only in test-only pages listed in `docs/validation.md`.

### 3.1 `renderer-core`

| Member | Semantics |
| --- | --- |
| `PrimitiveRendererServiceOptions.fringeForTesting?: 'on' \| 'off'` | Default `'on'`, as today. `'off'` constructs `PathMeshPipeline` without a fringe builder, for fills and strokes. Every served variant is then region-only (role 0, list count 0, so the shader returns `c = 1`). Exterior triangles are absent. `fringe-work-cap` and `fringe-unsupported` are never queued. Joint fill draws follow the existing region-only overlay seam (ST7-F7, F8, F14). Other notices and failures are unchanged |
| `PrimitiveRendererService.getLastDrawRecordForTesting(): PathDrawRecordForTesting \| null` | The record of the last non-null `prepare`. It holds `prepareSerial` (a count of non-null prepares, from 1) and one entry per mesh draw in packet order: `nodeId`, `paint`, `composite` (`'plain'` or `'joint-fill'`), `fringe` (`'built'`, `'region-only-cap'` or `'region-only-off'`), `regionTriangles` and `exteriorTriangles`, the last two summing to the draw's `triangleCount`. For a `joint-fill` draw the two counts are `null`: its records carry two role bits (fill and stroke), so the split is not defined, and V-4's gated fills have no joint draws. It is `null` before the first prepare and without a port |

### 3.2 `renderer-webgpu`

| Member | Semantics |
| --- | --- |
| `WebGpuBackendOptions.sampleCountForTesting?: 1 \| 4` | Absent: today's behavior (try 4x, fall back). `1`: pipelines and attachments are created at 1x only, and no `msaa-fallback` is emitted. `4`: if any 4x pipeline creation fails, initialization fails with `initialization.foundation-scene-failed` and context `{ forcedSampleCount: 4 }`, and no 1x pipeline is created. It applies to every generation, recovery included. The foundation (P0) scene ignores it. With any `WebGpuBackendOptions` hook option set, a generation that requires the mesh pipeline (`requiresMeshPipeline`) and whose mesh pipeline (or, with `countPassForTesting`, count pipeline) is unavailable fails initialization with `initialization.foundation-scene-failed` and context `{ meshPipeline: 'unavailable' }` (or `countPipeline`), instead of drawing primitives only (`native-primitive-scene.ts`, the `mesh = null` paths). An all-black frame can therefore never pass as a capture. When both contexts apply (forced 4x and a rejected 4x mesh pipeline), `{ forcedSampleCount: 4 }` wins |
| `WebGpuBackendOptions.frameCaptureForTesting?: boolean` | `true` adds `COPY_SRC` to the canvas configuration, which is the only configuration change, and enables `captureFrameForTesting`. The count pass is enabled only when it is also requested |
| `WebGpuBackendOptions.countPassForTesting?: boolean` | `true` (only with frame capture) creates the count pipelines next to the mesh pipelines, at initialization and recovery, never on the frame path (section 5) |
| `WebGpuBackend.captureFrameForTesting(options?: { counts?: boolean; timeoutMs?: number }): Promise<WebGpuFrameCaptureForTesting>` | Arms one capture and invalidates. The next primitive submission encodes the copy (and, if requested, the count pass) into its own command encoder after the main pass, and resolves after `mapAsync` (section 4) |

**Platform port members.** `webgpu-platform.ts` is a root export, so its interfaces are shared surface too. E10 changes them as follows, each member marked `@internal Tests only`:

| Port | Change |
| --- | --- |
| `WebGpuCanvasConfiguration` | Optional `usage?: number`. The browser platform passes it to `configure` only when present; when absent the `configure` call is exactly today's, with no `usage` key |
| `WebGpuCanvasContextPort` | Optional read-only `configuredUsage?: number`, the usage actually applied. A platform that drops `usage` leaves it absent |
| `WebGpuDevicePort.createPrimitiveScene` options | Optional `sampleCount?: 1 \| 4` (forced) and `countPass?: boolean`, next to the existing `meshPipeline` |
| `WebGpuPrimitiveScenePort` | Optional `captureNextSubmissionForTesting?(request): void`, which the native scene implements. It arms the copy and count pass for the next `submitPrimitivePacket` and settles the request from the scene |

With `frameCaptureForTesting`, initialization fails with `initialization.surface-configuration-failed` and context `{ captureUsage: 'missing' }` if `configuredUsage` lacks `COPY_SRC`, and the capture rejects with `capture-unsupported` if the scene port has no `captureNextSubmissionForTesting`. A custom platform such as `p3-v3-mesh`'s is therefore refused, never silently copied from.

`WebGpuFrameCaptureForTesting` holds:

- `generation`, `surfaceRevision`, `cameraRevision`, `framesSubmitted` (the statistic after this frame);
- `width` and `height` (physical pixels of the presented texture), `devicePixelRatio`, `sampleCount` and `targetFormat`;
- `rgba`: a `Uint8Array` of `width × height × 4` bytes, in R, G, B, A order, rows top first, tightly packed, swizzled from `bgra8unorm` when that is the format;
- `meshDraws`: the packet's mesh draws (`instance`, `firstTriangle`, `triangleCount`, `composite`);
- `counts` (when requested): `{ samples: 1 | 4, data: Uint16Array }`, with `samples` values per pixel, in sample index order 0 to 3 at 4x.

The page matches a capture to the draw record by checking that `framesSubmitted` and `prepareSerial` each advanced by exactly one since the capture was armed, and that the triangle totals agree. V-4's page asserts this.

## 4. Frame capture

- **Source.** The capture copies `getCurrentTexture()` of the frame that the main pass rendered. At 1x that texture is the render target. At 4x it is the `resolveTarget`, so the capture holds the resolved, presented pixels. The multisampled attachment is never read: its `storeOp` stays `discard`, and V-4's risk "readback path" is closed by this statement.
- **Same submission.** `copyTextureToBuffer` is encoded in the frame's command encoder after `pass.end()`. It goes into the one `queue.submit`, before the canvas texture expires at the end of the task. No second submission and no `requestAnimationFrame` gap separate the pixels from the copy.
- **Exactness.** The copy is of 8-bit unorm texels with no format conversion; the canvas format is not an sRGB view format. The bytes are the bytes the compositor receives.
- **Failure.** The promise rejects with an `Error` whose message starts with one of these codes:
  - `capture-disabled`: the option is not set, or `counts` was requested without `countPassForTesting`;
  - `capture-pending`: a capture is already armed;
  - `not-ready`: the backend is not ready;
  - `no-submission`: the next render prepared no packet or its submission did not succeed;
  - `device-lost`: the generation changed before mapping completed;
  - `disposed`: the backend was disposed while the capture was armed or mapping;
  - `foundation-mode`: the backend runs the P0 foundation scene, not primitives;
  - `capture-unsupported`: the scene port cannot capture (section 3.2);
  - `count-overflow`: a count read back as 2048 or more (section 5);
  - `timeout`: no render encoded the capture within `timeoutMs` (option, default 5,000 ms) of arming. The timer stops once the copy is encoded; after that the capture settles by `mapAsync`, `device-lost` or `disposed`, and a buffer whose map fails is still destroyed. This covers a suspended or zero-size surface and a hidden tab where rAF does not fire.

  Every `#render` call after arming settles the capture: it either submits with the copy or rejects with `no-submission`, including the early return for a suspended surface. A rejected capture leaves no buffer allocated.
- **Accounting.** Staging buffers and count textures are created per capture, tracked in `ResourceAccounting` under `test/` ids and released before the promise settles. Default statistics are unchanged because no such resource exists without the option.

## 5. Count pass

- **Module.** The count shader module is the string `MESH_FILL_SHADER + MESH_COUNT_SHADER_SUFFIX`. The suffix adds one fragment entry point, `meshCountFragmentMain`, which returns `vec4f(1, 0, 0, 1)` and has no discard. `MESH_FILL_SHADER` itself is unchanged, so its SHA-256 (`d306137c…`, recorded by E3-U4) and E3's GPU model check stay valid (E10-Q2).
- **Vertex stage.** The count pipelines use `meshVertexMain` for plain draws and `meshJointVertexMain` for joint fill draws, from that module, with the mesh pipeline layout. Both entry points compute positions through `meshPositionNdc` with an `@invariant` position output. WGSL guarantees that an invariant position is the same across programs when its data and control flow are the same. The count pass therefore rasterizes the triangles that the main pass rasterized. E10-A7 (g) checks this sample by sample on hardware.
- **Same draws.** In the same encoder, after the main pass and before the copy, one render pass replays the frame's mesh draws in packet order. It uses the frame's mesh bind group, `pass.draw(3 · triangleCount, 1, 3 · firstTriangle, instance)` and the same pipeline switches. The analytic P1 draws are not replayed, because the counts are of mesh triangles. Region and exterior triangles are both counted, as in O02's G3.
- **Target.** An `rgba16float` target at the scene's sample count, cleared to 0, with additive blending (`one`, `one`), as O02's count pass. At 4x a readout pass reads the four samples with `textureLoad` into R, G, B, A of a 1x `rgba16float` target (O02's `P3_O02_READOUT_WGSL` logic). The count and readout targets have the presented texture's width and height and use the default viewport. Both copies use `bytesPerRow` padded to 256 bytes and are unpadded row by row, as O02 does. Counts are converted to integers; `rgba16float` is exact only up to 2048, so a count of 2048 or more is reported as overflow (capture rejects with `count-overflow`), never rounded.
- **Pipelines.** With the option set, the generation creates one count module and, at 4x only, one readout module (a 1x pipeline). `pipelinesCreated` grows by two count pipelines (plain and joint) plus the readout pipeline at 4x, and `shaderModulesCreated` by one at 1x or two at 4x. Without the option, both are unchanged.

## 6. Acceptance criteria

| ID | Criterion | Method |
| --- | --- | --- |
| E10-A1 | **Default invariance.** With no hook option, a fixed scene (rectangle fill, cubic fill, stroke, joint pair, an analytic primitive) on the fake platform produces the same ordered GPU call log as at the base commit: configuration, textures, shader sources, pipeline descriptors, pass descriptors, draws, writes, submits. `MESH_FILL_SHADER`'s SHA-256 equals E3-U4's | Unit test with a golden log recorded before the change |
| E10-A2 | **Fringe-off.** For the scene of A1, every draw record entry is `region-only-off` with `exteriorTriangles = 0`. Every packed triangle of a plain draw has role 0 and list count 0; joint draws are checked against the existing region-only overlay fixtures (ST7-F7, F8, F14). A spy builder is called 0 times. No `fringe-*` notice is queued. `'on'` equals the default | Unit test (Node) |
| E10-A3 | **Forced sample count.** On the fake platform: `1` creates no 4x pipeline or attachment and emits no `msaa-fallback`; `4` with 4x rejected fails initialization with the code and context of section 3.2 and creates no 1x pipeline; `4` with 4x available reports `sampleCount` 4. The same holds after a device-loss recovery. With a hook option, an unavailable mesh or count pipeline fails initialization with the context of section 3.2, and forced 4x with a rejected 4x mesh pipeline reports `{ forcedSampleCount: 4 }`. A forced-1x backend without a mesh port initializes | Unit test |
| E10-A4 | **Capture encoding.** The copy is encoded in the frame's encoder after the main pass and before `finish`, from the texture returned by that frame's `getCurrentTexture()`, and the frame has exactly one submit. `COPY_SRC` is in the configuration only with the option. A custom platform that drops `usage` fails initialization as section 3.2 says. Each rejection code of section 4 is reachable, including `disposed`, `timeout` and `count-overflow` (a fake readout value of 2048), and none leaves a tracked `test/` resource | Unit test |
| E10-A5 | **Count pass encoding.** The count module source starts with `MESH_FILL_SHADER` verbatim. The count draws equal the main mesh draws (instance, first, count, order, joint entry for joint draws). The bind group is the frame's mesh bind group. No analytic draw is replayed | Unit test |
| E10-A6 | **Draw record.** `regionTriangles + exteriorTriangles = triangleCount` for each plain entry; both are `null` for a `joint-fill` entry. `region-only-cap` appears on the frame that first serves an entry above the cap, where `fringe-work-cap` is queued once per entry, and on every later frame that serves it (V4 cap fixture). `prepareSerial` advances once per non-null prepare | Unit test |
| E10-A7 | **Headed controls**, Chrome and Edge, forced 1x and forced 4x, DPR 1, 1.5 and 2, on the page of section 7: (a) an axis-aligned rectangle on integer physical bounds, fringe on, gives R = 255 at every inside pixel and 0 at every outside pixel, and counts that equal 1 inside and are at most 1 everywhere; (b) the same rectangle, fringe-off at 4x, has `exteriorTriangles = 0`, and a rotated triangle there has every R in `{0, 64, 128, 191, 255}` ± 1 (MSAA steps), while fringe on gives at least one value outside that set; (c) every pixel whose counts are all 0 has R = G = B = 0; (d) negative control: two identical overlapping rectangles give a count of 2 inside; (e) an empty scene captures all `(0, 0, 0, 255)`; (f) the capture's `sampleCount` equals the forced value; (g) sample-level match, fringe-off at 4x on the rotated triangle: per pixel, `round(R · 4 / 255)` equals the number of samples with a count of at least 1; (h) for every capture, `framesSubmitted` and `prepareSerial` each advanced by exactly one since arming, and the triangle totals agree | GPU spec on the user's PC |
| E10-A8 | `pnpm check`, `pnpm build` and `pnpm test:geometry` pass in CI | CI |
| E10-A9 | Independent `reviewer` review of this contract READY. A visualization-track check that sections 3 to 5 meet VZ4-D2 and VZ4-D3 as written. Independent evidence review ACCEPTED | Review records |

## 7. Units and files

| Unit | Content | Files |
| --- | --- | --- |
| E10-U1 | Fringe option and draw record | `packages/renderer-core/src/primitive-renderer-service.ts`, `path-mesh-pipeline.ts`, `primitive-scene-source.ts` and `path-mesh-packet.ts` (record only: draw placement and triangle roles), `index.ts` (type export), `tests/unit/e10-fringe-off.test.ts` |
| E10-U2 | Sample count, capture and count pass | `packages/renderer-webgpu/src/webgpu-backend.ts`, `native-primitive-scene.ts`, `webgpu-platform.ts`, new `mesh-count-shader.ts`, `tests/unit/e10-capture.test.ts`, `tests/unit/e10-default-invariance.test.ts` and its golden log |
| E10-U3 | Check page, headed spec, evidence | `apps/playground/e10-test-hooks.html`, `src/e10-test-hooks.ts`, the rollup input, `tests/gpu/e10-test-hooks.spec.ts`, a `docs/validation.md` row, an evidence section in the rendering track plan |

The order is E10-U1, then E10-U2, then E10-U3. U1 and U2 are separate pull requests under this contract. U3 needs the user's PC. VZ4-U1 may start against the published hooks once U2 is merged, and its VZ4-A1 refusal check runs against them.

## 8. Validation commands

| Command | Where | Covers |
| --- | --- | --- |
| `pnpm check` | Cloud and CI | E10-A1 to E10-A6 |
| `pnpm build`, `pnpm test:geometry` | CI (Windows) | E10-A8 |
| `pnpm test:gpu -- e10-test-hooks` (a project in `playwright.gpu.config.ts`) | User PC, headed Chrome and Edge | E10-A7 |

Headed GPU runs are not possible in the cloud container. They run on the user's PC through Remote Control or are reported NOT RUN.

**Note to V-4 (not a V-4 change).** The product clear is opaque black. When VZ4-U1 is written, the wording of V-4 section 4.3 should read "opaque black". `obs` still reads from R and no gate changes.

## 9. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| E10-Q1 | Where do the hooks live? (a) Published `…ForTesting` members in both packages, as section 3. (b) Fringe-off and the count pass in the packages; forced sample count and capture by a platform proxy, as `p3-v3-mesh` does | (a): the capture shares the frame's submission and the count pass needs the scene's bind group, so the scene has to see them; a forced 4x cannot be built from a proxy; and a proxy over internal ports would be copied into a visualization page |
| E10-Q2 | The count fragment entry point: (a) in a separate module `MESH_FILL_SHADER + suffix`; (b) inside `MESH_FILL_SHADER` | (a): the product module and its E3-recorded SHA-256 stay unchanged; (b) would change the shader hash and require E3-U4 to run again |
| E10-Q3 | Does fringe-off apply to strokes and joint draws as well as fills? | (a) yes, every paint: section k says "the same scenes", and V-4 reports strokes; fills alone would make the stroke report incomparable |

## 10. Risks

- **Test members in a published package.** A host could set them. Mitigation: `ForTesting` names, `@internal` docs, and review. A later path-touch check (D9 follow-up) could enforce it.
- **Invariance across modules.** If a driver breaks WGSL's `@invariant` guarantee across modules, the counts would not describe the main pass. E10-A7 (g) compares the two passes sample by sample on hardware, at every tested DPR; a mismatch on V-4's corpus outside those controls would surface as a G3 failure next to a passing G1 and G2, and is reported then.
- **Readback on a suspended surface or a hidden tab.** The early return of `#render` rejects with `no-submission`, and a render that never runs ends in `timeout` (section 4), so the spec never hangs.
- **Golden log churn.** E10-A1's golden log changes whenever the default path changes. A change to the log needs a stated reason in its PR, which is the point of the check.

## 11. Gate

Satisfies nothing yet. After approval, E10 is complete when E10-A1 to E10-A9 have evidence. V-4 code (VZ4-U1) may then use the hooks. A08 still needs the E3 freeze and C03-C05, as V-4 section 9 says (E3-U3 merged in #220).

## 12. Review round 1 (2026-10-24)

Independent `reviewer` review: NOT READY, one blocking, six should-fix and four nit items, all applied in revision 2.

- B1: the platform port members that the hooks need are listed as shared surface (section 3.2), and a custom platform that drops `usage` or cannot capture is refused.
- S2 to S7: an unavailable mesh or count pipeline fails initialization under a hook option; the capture always settles (`no-submission`, `disposed`, `timeout`, `foundation-mode`); the `region-only-cap` rule follows the once-per-entry notice; overflow at 2048; a sample-level count-versus-main control (A7 (g)) and the matching rule in the spec (A7 (h)); DPR 1.5 in A7.
- N8 to N11: target size, viewport and row padding; module and pipeline counts; U1 file list; joint draws in the record; the `@internal` precedent.

## 13. Review round 2 (2026-10-24)

READY, two should-fix and five nit items, all applied in revision 3: `count-overflow` joins the section 4 list and A4; A6's sum rule is for plain entries, with `null` for joint entries; the port members are exempt from the naming rule; the mesh-unavailable rule applies to backend options on generations that require the mesh pipeline, and `forcedSampleCount` wins over `meshPipeline`; an absent `usage` leaves the `configure` call as today's; the timeout covers arming to encoding only.
