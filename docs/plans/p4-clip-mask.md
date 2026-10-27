# P4 contract: clip and mask

Status: APPROVED 2026-10-27 (section 10), Full tier (shared surface: `packages/contracts` scene types, a new diagnostic code, renderer draw state). Rendering-track item [E21](d9-rendering-track.md#status-index). The user approved P4 entry on 2026-10-27, starting with this contract.

Owners: this file owns P4 execution order, acceptance criteria and evidence. [prototype-plan.md](../prototype-plan.md#p4-clip-and-mask) owns the milestone scope and exit gate; [graphics-engine-architecture.md](../graphics-engine-architecture.md#clipping) owns the clipping mechanism; [requirements.md](../requirements.md#containers) owns frame and mask-group behavior.

## 1. Scope

In scope, as prototype-plan P4 lists it:

- Frame clips: a container clips its descendants to a rectangle in its local space.
- Transformed clips: any invertible container affine, camera zoom and DPR.
- Arbitrary path masks: a mask container uses its first child's filled area as the mask of its other children.
- Nested clips up to depth 32; a change set reaching depth 33 is rejected with `unsupported-feature`, the gate's "diagnostic rather than corrupt output".
- Clip-aware culling and batching.

Out of scope (stated so the exit does not imply them):

- Container opacity other than 1. It stays rejected with `unsupported-feature` (P1 rule, [architecture](../graphics-engine-architecture.md#approved-p1-visual-behavior)); isolated group opacity is remaining MVP work ([requirement coverage](../prototype-plan.md#requirement-coverage)). See P4-Q4.
- Luminance masks, soft (feathered) masks, rounded frame corners, frame background and border (the editor draws those as ordinary nodes).
- Document model and editor node types (`group`, `frame`, `mask group` in `packages/model` and `packages/editor-core`), editor hit-testing through clips. These are MVP editor work; P4 tests the renderer through `RenderSceneSnapshot`.
- Precision claims. Clip and mask edges reuse existing coverage rules; A04 stays as recorded at the P3 exit.

## 2. Scene contract (shared surface)

`RenderNodeSnapshot`'s container variant gains one required field:

```ts
export type SceneClip =
  | null
  | Readonly<{ kind: 'rect'; x: number; y: number; width: number; height: number }>
  | Readonly<{ kind: 'mask' }>;

Readonly<{ kind: 'container'; children: readonly string[]; clip: SceneClip }>;
```

- **P4-S1 rect.** `x`, `y` finite; `width`, `height` finite and `>= 0`; `x + width` and `y + height` finite. The clip region is the closed rectangle `[x, x + width] × [y, y + height]` in the container's local space (after its own `transform`, before its children's). A zero-size rectangle clips everything: the subtree draws nothing and reports nothing.
- **P4-S2 mask.** The mask source is `children[0]`. A mask container with no children is valid and draws nothing. A source that is a `container` rejects the change set with `unsupported-feature`, as does a `path` source on a renderer without a fill port (`pathFills` not `'supported'`). The source is never painted. Its mask is the geometric fill area: the path's fill region under its `fillRule`, or the primitive's filled shape (a `line` has an empty fill area, so nothing draws). It is meshed or drawn as a fill whatever its `style.fill` (null included), `opacity` and `visible` flag (P4-Q3); its stroke is never meshed (alpha-of-geometry, like SVG `clip-path`). Its `transform` applies.
- **P4-S3 validation.** A `clip` of any other shape, or a missing `clip`, is an input-value error: `invalid-value`, in `copyNode`. The source-kind rule of P4-S2 and the depth rule below are graph rules: they run in `validateCandidateGraph` after the order check and report `unsupported-feature`, the category's last place today (scene-validation.ts). Inserting, removing or reordering children of a mask container can change its source; it is validated on the resulting order.
- **P4-S4 compatibility.** Every existing producer of containers adds `clip: null`: the playground scenes (`apps/playground/src/*-scene.ts`) and the test fixtures (`tests/support/`). The P5 projector emits no containers and is unchanged. A `clip: null` scene renders exactly as before (P4-A09).

**Clip depth.** The clip depth of a node is the number of its proper ancestors whose `clip` is not null. Depth 0 to 32 is supported. A scene in which any node has depth 33 or more is rejected with `unsupported-feature`, like the other structural limits that validation can compute (non-unit container opacity, line fill), as the architecture's P4 design gate says ("rejected 33"; P4-Q2). The check walks the candidate graph once per change set, O(n) in nodes (10,000 at most), the same cost class as today's cycle and order checks, so a reparent-only change set is checked like any other.

## 3. Rendering semantics

Notation: for a drawn leaf `n` with clipping ancestors `a_1 … a_d` (outermost first), its framebuffer contribution is P1 D2's premultiplied contribution `P_n` (coverage and opacity applied once, unchanged) multiplied by the **clip coverage** `K_n(p) = Π_i k_{a_i}(p)` at pixel centre `p`, then composited source-over in document paint order.

- **P4-K1 rect coverage.** `k_a(p) = analyticCoverage(d)` with `d = roundedRectangleDistance(q, size, 0)`, where `q` is `p` mapped into the clip rectangle's local frame (origin at `(x, y)`) and `size = (width, height)`: P1's signed distance and coverage rule, `clamp(0.5 − d / max(fwidth(d), 1e-6), 0, 1)` ([primitive-analytic-shader.ts](../../packages/renderer-webgpu/src/primitive-analytic-shader.ts)). So a frame clip's edge and corner coverage equals that of a P1 rectangle of the same placement, at any invertible affine, zoom and DPR. Nested levels multiply. A zero-size rect gives `k_a = 0` by P4-S1, not by this formula.
- **P4-K2 mask coverage.** `k_a(p)` is the coverage that the mask source's fill draw would produce at `p` as an opaque white shape over black: for a path, the P3 mesh fill draw with its fringe (O2 and the write-once rule E17-K1 included); for a primitive, P1's analytic fill coverage. A path source that fails to mesh (requirements, "Path rendering failures", O1) gives `k_a = 0`: the subtree is not drawn, and the one `render.path-mesh-failure` diagnostic of the source is the report (fail closed). The stored texture quantizes `k_a` to 8 bits at each level of a mask chain.
- **P4-K2b singular containers.** A container whose world affine is singular draws nothing of its subtree and reports nothing, checked before any clip bound is computed (today's rule for a singular path or primitive transform, applied to the subtree). A `visible: false` container, clipped or not, draws nothing of its subtree, as today.
- **P4-K3 paint order and opacity.** Clipping never reorders draws. Overlapping translucent children of a clipped container composite one by one, exactly as without the clip (non-isolated, since container opacity is 1). This is the prototype-plan gate "Nested masks preserve paint order and opacity".
- **P4-K4 siblings.** A node's clip coverage depends only on its own ancestors, so a sibling drawn after a deeply clipped subtree is unaffected by it ("sibling restoration" in the architecture design gate holds by construction, not by a stencil pop).
- **P4-K5 culling.** Each clipping ancestor has a conservative device-space bound: the rect's mapped parallelogram's bounding box, or the mask source's device bounds, each widened by 1 px for the coverage ramp. A leaf whose device bounds miss the intersection of its ancestors' bounds and the target is not drawn and costs no draw call. A mask whose bound is empty skips its subtree.

## 4. Realization (P4-Q1 (a))

The architecture says transformed and arbitrary clips use stencil, but the E17 write-once rule already uses all eight stencil bits ([E17-K3](d9-e17-mesh-write-once-coverage-contract.md#4-identity-the-e11-snapshot-and-the-stencil-budget)), and a stencil clip at the product's 1x sample count has no antialiased edge, which the architecture design gate requires. Option (a) needs no stencil for clipping:

- **Rect clips in the shader.** Each frame's clip states are records `{ rects[0..r), maskLevel }` in a storage buffer. The clip-state index is per draw (a dynamic uniform offset), never per instance, so the loop bound is uniform and `fwidth` stays in uniform control flow under WGSL's uniformity analysis; batches split at a clip-state change. The fragment shader evaluates P4-K1 per rect (at most 32, a bounded loop) and multiplies the product into the contribution before the blend. Each rect record holds the world-to-clip-local affine (U2), so a camera change rewrites no record; U3 composes it with the camera-rebased frame at draw time, under the P1 precision budget. An implementation may replace `fwidth(d)` by its analytic value from that affine if A02 still holds.
- **Mask coverage textures.** Each mask level that has a drawn descendant owns an `r8unorm` coverage texture over its culled device bound (rounded out to whole pixels, clamped to the target). A mask pass draws the source's fill as in P4-K2 (coverage to the red channel) and multiplies it by the parent mask level's texture and the rect clips between the two levels, so one texture holds the whole mask chain up to that level. A content draw samples only its innermost mask level's texture (`textureLoad` at the pixel; zero outside the texture's rectangle). At a 4x scene the mask pass renders at 4x into a transient multisample `r8unorm` target and resolves into the 1x texture; the content shader reads the resolved value per pixel.
- **Mask cache.** A mask texture is kept across frames under the key (source geometry and fill revision, source and ancestor transforms, the chain's clip records and parent mask key, camera, DPR, target size). A mask pass runs only for a level whose key changed, and the renderer counts mask passes (`maskPasses`). Camera pan and zoom therefore re-render the visible masks; an edit elsewhere in the scene re-renders none.
- **Mask-pass state.** The mask pass has its own `stencil8` attachment at the pass's sample count, cleared at pass start, and draws the source with the E17-K2 write-once state and reference 1 (one source draw per pass, so no reset draw). Its transient attachments count toward the budget below and are tracked by resource accounting.
- **Count pass (E10).** A clip scales colour only and never changes what is rasterized, so the E10 count pass replays clipped mesh draws with today's count pipelines, unchanged. The clip bind group sits at its own group index, so the mesh pipeline layout and E10 section 5 stay as approved. The E10-A1 golden GPU log changes only for scenes with a clip, for the stated reason.
- **Pipelines.** A clipped draw uses a pipeline variant keyed `+clip-v0`, with its own shader modules (the existing WGSL plus a clip block). Unclipped draws keep today's modules, keys and the E3-recorded `MESH_FILL_SHADER` SHA-256 unchanged. The write-once stencil (E17-K2) is unchanged for every mesh draw.
- **Batching.** Draws stay in paint order. Consecutive draws with the same pipeline and clip-state index are batched as today; a clip-state change starts a new batch, never a reorder.
- **Resources (P4-Q5).** Mask textures and clip-state buffers are tracked by `resource-accounting.ts` and released on resize, dispose and device loss. A cached mask entry not used in a frame is released at the end of that frame. If the resident mask textures (cached entries and transient attachments) would exceed `P4_MASK_TEXTURE_BYTES_MAX` = 64 MiB, the mask levels beyond the budget (in paint order) are not drawn and report `render.clip-resource-limit`; earlier subtrees still draw.
- **Architecture amendment (adopted 2026-10-27).** The Clipping section now says: rect clips (axis-aligned or transformed) are evaluated analytically in the clipped draw's shader; path masks render to coverage textures before the main pass; stencil stays reserved for write-once coverage; scissor may be used only as a culling optimization that changes no pixel.

Alternatives: (b) stencil clips as the architecture states, with the bits split (for example 6 for depth 0 to 32 and 2 for write-once, a reset every 3 mesh draws) or a `depth24plus-stencil8` attachment with write-once moved to a per-draw depth value; mask and transformed frame edges are aliased at 1x, so the design gate's edge antialiasing fails unless the scene runs 4x MSAA. (c) Coverage textures for every clip, rect clips included: simplest shader, but one texture per frame level, which costs memory for the common frame case that (a) handles in the shader.

## 5. Diagnostics

- Depth 33: no diagnostic; the change set is rejected with `unsupported-feature` (P4-Q2).
- `render.clip-resource-limit` (new, warning): context `{ nodeId, bytes, limit }`, under the queue limits of `render.path-mesh-failure` (4,096 queued, 32 per frame, overflow counted).
- Mask source mesh failure: the existing `render.path-mesh-failure` only (P4-K2).

## 6. Acceptance criteria

Evidence goes to `docs/evidence/p4/`. Headed runs use the reference PC (DESKTOP-DKVUSAV, Chrome and Edge, DPR 1 and 2), as P3. Image checks compare readback to a CPU oracle of section 3 over probe sets; "interior" probes are at least 2 physical px from every clip and shape edge, "edge" probes are on the ramp.

| ID | Criterion | Evidence |
| --- | --- | --- |
| P4-A01 | Scene validation: P4-S1 to S3 accept and reject as written, with the stated reasons and precedence; depth is computed as defined after reparenting and reordering; cases: empty mask container, source removed, source reordered, source becoming a container, fill-less and hidden path source, path source without a fill port, depth 32 accepted and 33 rejected (also through a change set that only reparents) | Unit tests in `pnpm check` |
| P4-A02 | Rect clips: interior probes equal the oracle within 2/255 per channel; edge and corner probes equal P4-K1 within 4/255; axis-aligned, rotated 15/45°, scaled 0.5/2, sheared 0.25, zoom 0.01 to 64, DPR 1 and 2, a clip on a top-level container, a rect narrower than 1 px | Headed GPU spec, readback |
| P4-A03 | Masks: path sources under both fill rules (with a hole), fill-less and hidden path sources, rectangle, ellipse and line sources, at 1x and at a forced 4x scene; interior probes within 2/255; edge probes within 4/255 of P4-K2 evaluated on the same mesh; the source never paints | Headed GPU spec |
| P4-A04 | Nesting: depths 0, 1, 2 and 32 with alternating rect and mask levels match the oracle (interior within 2/255; edge probes at depth 32 within 4/255 plus 1/255 per mask level above it, for the 8-bit chain); a depth-33 change set is rejected with `unsupported-feature` and the renderer keeps drawing the previous revision | Headed GPU spec plus unit test |
| P4-A05 | Paint order and opacity: overlapping children with opacity 0.5 inside nested masks match the oracle, and differ from a double-opacity or reordered oracle by more than 24/255 on named probes; a sibling after a depth-32 subtree matches its unclipped probe | Headed GPU spec |
| P4-A06 | Invalidation, geometry: editing a rect clip, or translating or rotating a container, costs 0 fill and stroke port calls and 0 geometry builds for descendants drawn both before and after the change (a descendant that newly enters the viewport costs what it costs without clips); scaling a container costs exactly the port calls of the same change without clips (tolerance buckets, path-buckets.ts); editing a mask source's path costs 1 fill port call; only the changed clip-state records are written. Invalidation, GPU work: `maskPasses` counts only the levels whose cache key changed (an edit outside a mask's chain adds 0; a camera pan adds one per visible mask); a DPR change or resize re-renders the visible masks at the new size and matches the oracle | GPU spec counters, as VZ3-A4/A10 |
| P4-A07 | Culling and batching: a leaf outside its clip bound adds no draw call; N consecutive leaves under one clip state add one batch, not N; paint order is preserved across clip-state changes | Draw and batch counters, unit and GPU |
| P4-A08 | Resources: mask textures, transient 4x mask targets, mask-pass stencils and clip buffers appear in resource accounting and return to the unclipped baseline after the clipped nodes are removed, on resize, dispose and device loss; after device loss the recovered frame equals the pre-loss capture; over-budget masks report `render.clip-resource-limit`; after a pan sequence, resident mask bytes are at most the visible masks' bytes | GPU spec, as VZ3-A8/A11 |
| P4-A09 | Identity: a scene with every `clip: null` gives byte-identical frame captures, unchanged shader hashes and pipeline keys against `main` before P4; the existing `pnpm test:gpu` suite passes with only the `clip: null` addition to its fixtures | Headed full `pnpm test:gpu`, hash check |
| P4-A10 | Failure and hidden: a mask source that fails to mesh draws nothing of the subtree and reports its existing path failure only; a singular container affine, and a `visible: false` clip container, draw nothing of the subtree and report nothing | GPU spec |
| P4-A11 | Observation only: frame time of a 10,000-node scene with 100 frames and 20 masks, recorded as FUNCTIONAL observation; no performance claim or threshold | `observations.json` |

## 7. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | `SceneClip` type, validation, depth, `clip: null` in every container producer (playground scenes, fixtures); the new diagnostic code | P4-A01; CI |
| U2 | Rendering | Clip resolution in `renderer-core`: clip-state records, culling bounds, batching keys, invalidation | P4-A06, A07 unit parts |
| U3 | Rendering | Rect-clip pipeline variants and shader block | P4-A02, A09 |
| U4 | Rendering | Mask coverage textures, mask pass, budget, resource lifecycle | P4-A03, A08, A10 |
| U5 | Visualization | Headed playground page and GPU spec for P4-A02 to A08, A10, A11 | Headed run on the reference PC |
| U6 | Rendering | Exit record `docs/evidence/p4/` with the index of P4-A01 to A11 | User acceptance of the exit |

Order: U1, then U2, then U3 and U4 (either order), then U5, then U6. U3 and U4 are independent once U2 lands. WIP limit per track applies.

**Unit records.** U1 merged 2026-10-27 (#285, `b5beb2c`): scene type and validation; the mirror option `clips` stays `'unsupported'` until U3 and U4 draw clips. U2 (2026-10-27): `clip-resolution.ts` builds clip chains in the scene traversal, culls leaves and path paints against each level's bound widened by the 2 px guard (P4-K5), skips mask sources and empty or singular chains, keeps a chain's state index while it stays drawn (a new chain takes the lowest free index, so `writes` counts content changes per index), splits analytic runs at a state change, and adds the optional `clipState` draw field and `clip` packet part (absent on unclipped frames, so P3 packets are unchanged); `getClipStateWrites()` counts changed records; the `clip` part's `maxIndex` sizes U3's table, since indices may have gaps. U2 merged 2026-10-27 (#286, `e689d03`). U3 (2026-10-27): `clip-pipeline.ts` builds the `+clip-v0` variants of the P1 analytic module and the P3 mesh module (fill and joint) by renaming each fragment entry point to a helper and wrapping it with the clip block; the base modules, keys and the `MESH_FILL_SHADER` text are unchanged, and an unclipped draw always uses a base pipeline. The clip block evaluates P4-K1 at the pixel center: the pixel is mapped to the world through the camera rebased to the packet's primitive origin (`world − origin = (camera − origin) + pixel / (zoom · dpr)`), each rect record holds its world-to-local affine with the translation rebased to that origin in binary64 and rounded once, so a camera pan rewrites only the 16-byte frame lanes and an origin change rewrites the records. Realized layout: one uniform buffer per scene holds the frame lanes at offset 0 and state `i` (a 16-byte header and 32 fixed rect slots, 1,040 bytes) at `i × stride` (1,280 at a 256-byte alignment), bound at group 1 with a per-draw dynamic offset, in place of the section 4 storage buffer plus per-draw uniform; the loop bound is the record's uniform rect count. The joint fill variant runs the ST-U7 formula with `o · k`, since its stroke draw carries the same state; plain multiplication by `k` is exact only at 0 and 1. The variants are created at initialization and recovery only for a source that sets `requiresClipPipeline` (the service option `clips: 'rect'`, default `'none'`); without them a clipped draw is not drawn. The mirror support `'rect'` draws rect clips and still rejects a mask container until U4. Software-GPU check (SwiftShader, not the A02 evidence): clipped versus `k ×` unclipped renders within 1.01/255 at 1x and 4x for a 15° rect clip over a primitive and a joint path, zoom 4 and nested clips, byte-identical with the scene and camera at 10^6, and byte-identical unclipped frames with the option on and off (A09 shape). The oracle's `fwidth` must model the GPU's 2×2-quad derivatives (coarse); a per-pixel finite difference misses by up to 25/255 on edges. Owed to U5: the headed A02 and A09 runs on the reference PC.

## 8. Risks

- **Mask memory.** 64 MiB holds about eight full-screen masks at 3840 × 2160. Deep full-screen mask stacks report `render.clip-resource-limit` instead of drawing. An atlas or on-demand re-render is the later remedy if real documents hit it.
- **Shader cost.** A depth-32 rect chain is 128 edge evaluations per fragment. Typical documents have depth 1 to 3; P4-A11 records the cost without a threshold.
- **Mask chain quantization.** Each mask level stores 8 bits, so deep mask chains drift by up to about 1/255 per level at edges; P4-A04 states the allowance. A wider format is the remedy if a fixture needs it.
- **E17 interaction.** Mask passes draw one mesh fill each into their own target with their own write-once stencil; the main pass's E17-K2 references, resets and the unclipped pipelines are unchanged.

## 9. Questions (each with a recommended option)

- **P4-Q1 realization.** (a) Rect clips analytic in the shader, masks as coverage textures, stencil unchanged (section 4). (b) Stencil clips per the current architecture text. (c) Coverage textures for all clips. Recommended (a): it is the only option whose edges antialias at the product's 1x sample count, and it leaves E17 untouched.
- **P4-Q2 depth 33.** (a) Reject the change set with `unsupported-feature`, as the architecture's design gate says ("rejected 33") and as other structural limits that validation can compute are rejected today. (b) Accept the scene, skip the over-deep subtree and report a warning, like the P3 rule for meshing failures. Recommended (a): depth is known at validation, unlike a meshing failure, and (a) needs no architecture change; the editor can enforce the limit before it sends a scene.
- **P4-Q3 hidden mask source.** (a) A mask source with `visible: false` still masks (visibility only controls painting, and the source never paints). (b) It disables the mask: the other children draw unclipped. Recommended (a): the mask stays a pure geometric definition; an editor that wants (b) can send `clip: null`.
- **P4-Q4 container opacity.** (a) Keep non-unit container opacity rejected in P4. (b) Add isolated group opacity to P4 with offscreen composition. Recommended (a): it is outside the P4 gate and is an MVP item with its own plan.
- **P4-Q5 mask budget.** (a) 64 MiB with the stated over-budget behavior. (b) No budget. Recommended (a): the 256 MB working-memory ceiling (prototype-plan constraint 4) needs a bound.

## 10. Decisions

- **2026-10-27, user:** P4 entry approved, contract first (recommended over the E20 A04 remedy and MVP editor planning).
- **2026-10-27, recommended options auto-adopted** under the user's standing instruction of 2026-10-24: P4-Q1 (a), P4-Q2 (a), P4-Q3 (a), P4-Q4 (a), P4-Q5 (a). The architecture's Clipping section is amended accordingly (section 4). The user may reopen any of them before U1 merges.

**Review record.** Independent review (fresh context, reviewer role), 2026-10-27. Round 1: NOT READY, three blocking findings (A06 overclaimed zero port calls on scale and had no mask GPU-work criterion; depth-33 acceptance contradicted the architecture's "rejected 33"; mask sources were not meshable under today's fill gates) and nine further findings (corner coverage, WGSL uniformity, 4x masks, empty mask containers, validation precedence, producers, missing criteria, count pass, singular containers), all applied. Round 2: READY WITH FOLLOW-UPS (count pass replays clipped draws unchanged, mask cache eviction, A06 viewport entry, scope wording, depth-check cost), all applied.
