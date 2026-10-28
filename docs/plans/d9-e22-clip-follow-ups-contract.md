# E22 contract: P4 clip and mask follow-ups

Status: APPROVED 2026-10-28 (section 7, recommended options auto-adopted), Full tier (a new diagnostic code in `packages/contracts`, the mask budget's accounting rule, renderer resource behavior). Rendering-track item [E22](d9-rendering-track.md#status-index). The user moved E22 out of the backlog on 2026-10-28, to run beside the MVP editor plan; frame clipping in the MVP editor depends on the mask budget.

Owners: this file owns E22's units, acceptance criteria and evidence. The [P4 contract](p4-clip-mask.md) keeps the clip and mask semantics (P4-K1 to K5, P4-S1 to S3) and its accepted evidence; E22 changes only what section 2 names. The [P4 exit record](../evidence/p4/README.md#disclosed-limitations-accepted-for-the-exit-backlog) lists the limitations this item answers.

## 1. Scope

| P4 exit limitation                                                                                   | E22 answer                       |
| ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1. Silent clip loss when the clip variants are unavailable                                           | E22-K4 diagnostic (U2)           |
| 2. An analytic clip variant stays cached, untracked, when a later variant fails                      | E22-K5 eviction (U2)             |
| 4. Every re-rendered mask pass holds its own transient attachments until submission; a resized level holds its old and new textures | E22-K1 to K3 (U1) |
| 5. A full-screen mask at 3840 × 2160 and 4x exceeds the 64 MiB budget                                 | E22-K1, K2 tiled pass (U1)       |

Out of scope: limitation 3 (unused mask sources still mesh; accepted cost, no change). The 64 MiB budget value (P4-Q5), the over-budget behavior (paint-order suffix, `render.clip-resource-limit`), the mask cache keys, and the mask texture format and size stay as P4 section 4 fixes them.

## 2. Rules

**E22-K1 (one tile set per frame).** Every mask pass of a frame renders through one shared set of transient attachments, the *tile set*, of size `tw × th` with `tw = min(T, max width)` and `th = min(T, max height)` over all mask levels of the frame's clip part (the same levels the plan counts), `T = 1024` (`P4_MASK_TILE_SIZE`). The set holds:

- a colour tile, `r8unorm`, at the scene's sample count;
- at 4x, a resolve tile, `r8unorm`, 1 sample;
- a `stencil8` tile at the scene's sample count, only when a re-rendered level has a mesh source.

The set is created once, before the first mask pass, only when a level is re-rendered, and released after the frame's submission or a failed one, as P4 section 4 already requires for transients. The 1-sample tile (colour at 1x, resolve at 4x) adds `COPY_SRC`; mask textures add `COPY_DST`.

**E22-K2 (tiled mask pass).** A level's texture is covered by tiles at offsets `(i·tw, j·th)` from its device rect's origin. Each tile is one render pass over the tile set (clear, draw the source as P4 section 4, the same viewport rule offset by the tile's origin), followed by `copyTextureToTexture` from the 1-sample tile (the colour tile at 1x, the resolve tile at 4x) into the level's texture at the tile's offset, clipped to the texture.

- **Per-tile pass records.** `@builtin(position)` is relative to the attachment, so each tile has its own pass record: `pixelShift = device + offset` and, under a parent level, `maskOffset = device + offset − parent.device`. The scene derives these records from the packet's levels (they are not packet records), at state indices after `maxIndex`, in level and then tile order; the clip buffer holds `maxIndex` plus the tiles of all the part's levels (re-rendered or not, so the indices are stable). P4-A06's count of written content records is unchanged.
- **Content.** Tile offsets are multiples of `tw` and `th`, which are even or cover the level in one tile, so the 2 × 2 quads keep their parity and each texel is shaded at the same target pixel as untiled. The viewport origin moves by whole pixels; byte identity is checked on SwiftShader (E22-A4), and on hardware the seams are probed (E22-A5), since WebGPU does not guarantee identical rasterization under a moved viewport.

**E22-K3 (budget).** `MaskPlan` admits a level when

`resident(admitted levels and this level) + tileBytes(admitted levels and this level) ≤ 64 MiB`,

where `resident` is the sum of `width × height` and `tileBytes = tw × th × (sampleCount = 4 ? 9 : 2)` (colour, resolve and stencil tiles at 4x; colour and stencil at 1x; the stencil counted whether or not a source is a mesh, so the plan is an upper bound). The renderer holds at most this many mask bytes at any point of a frame:

- a cached entry whose level the frame does not use, or whose size changes, is released and leaves the cache after the whole clip part (levels and state records) has been validated and before the frame creates any mask texture (its content would be replaced anyway; a failed packet then re-renders the level next frame, and an invalid packet releases nothing);
- only the tile set is transient.

Figures at `T = 1024`: a 3840 × 2160 full-screen level is 8,294,400 resident bytes; the tile set is 9,437,184 bytes at 4x and 2,097,152 at 1x. Six such levels fit at 4x (59,203,584) and the seventh is reported; seven fit at 1x (60,157,952) and the eighth is reported (P4 also fitted seven at 1x).

**E22-K4 (diagnostic without clip variants).** When a primitive frame source requires the clip pipeline (`clips` other than `'none'`) and the primitive scene comes up without the clip variants, the backend emits `render.clip-unavailable` (severity `warning`, new code) once per generation, when the scene becomes ready. Under a backend test hook the generation still fails as P4 U3 fixes. The fail-closed rule (clipped draws not drawn) is unchanged.

**E22-K5 (no cached variant on failure).** If any clip or mask variant fails to build, the clip variants this attempt put into the pipeline cache are evicted before the scene is created without variants: the analytic variant when the mask analytic pipeline, the default mask texture or a mesh variant fails, the mesh variants when the mesh mask pipeline fails. `PipelineCache` gains `evict(key)`, which removes an entry (and calls the cache's `release` for a ready value when one is configured; the scene's cache has none, and its tracked ids are already released).

## 3. Acceptance criteria

| ID      | Criterion                                                                                                                                                                                                                       | Method                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| E22-A1  | A frame that re-renders N mask levels creates exactly one tile set (or none when N = 0), sized per E22-K1; its textures are released after the submission and after a failed submission                                       | Unit, fake device (`p4-native-fixture.ts`)       |
| E22-A2  | During a frame, live mask texture bytes (resident plus transient, from resource accounting at every texture creation) never exceed the plan's bytes for that frame, including a frame where every level changes size, one where a level is replaced by another, and the frame after a failed submission (no destroyed texture is bound) | Unit, fake device                                |
| E22-A3  | The plan figures of E22-K3 at 3840 × 2160: six full-screen 4x levels drawn and the seventh reported; seven at 1x and the eighth reported; levels smaller than a tile give `tileBytes` from their own size                         | Unit (`MaskPlan`)                                |
| E22-A4  | Tiled mask textures are byte-identical to untiled ones: a level larger than one tile in both axes, analytic and mesh sources, nested under a parent mask, at 1x and 4x, rendered as white content under the mask, captured from the presented frame and compared with the same scene at `9ef77b5` (mask textures there have no `COPY_SRC`) | SwiftShader in the cloud container, recorded in the U1 PR |
| E22-A5  | A 3840 × 2160 surface at 4x with one full-screen mask, and a nested mask with a mesh source whose texture spans tile seams, draws with no `render.clip-resource-limit`; interior and edge probes match the P4 oracle as P4-A02 and A03 require, and every pixel on the seam lines (`x` or `y` a multiple of 1024 from the level's origin, inside the level) matches the oracle within the interior tolerance | Headed GPU spec on the reference PC, Chrome and Edge |
| E22-A6  | The P4 headed spec (`tests/gpu/p4-clip-mask.spec.ts`) passes unchanged in both browsers, and the full `pnpm test:gpu` passes on the reference PC. The P4 unit expectations that pin transient ids, pass sequences and over-budget sizes (`p4-u4b-mask-passes`, `p4-u4-mask-plan`) change with K1 to K3, each change named in the U1 PR | Headed, reference PC                             |
| E22-A7  | `render.clip-unavailable` is emitted once per generation when clips are required and the variants are unavailable, and not when they are available or not required; a test-hook backend still fails the generation            | Unit                                             |
| E22-A8  | A failure at each variant step (analytic, mask analytic, default mask, mesh, mesh joint, mesh mask) leaves no clip variant in the pipeline cache (`snapshot().readyEntries` back to the count without clips) and no clip accounting entry | Unit                                             |

## 4. Units

| Unit | Content                                                                                                         | Criteria          |
| ---- | --------------------------------------------------------------------------------------------------------------- | ----------------- |
| U1   | Tile set and tiled mask pass in `native-primitive-scene.ts` (the fake device in `tests/support/p4-native-fixture.ts` gains `copyTextureToTexture` and records texture size and usage); the E22-K3 budget in `MaskPlan`; early release of replaced entries | E22-A1 to A4      |
| U2   | `render.clip-unavailable` (contracts, backend), `PipelineCache.evict` and the variant rollback                   | E22-A7, A8        |
| U3   | Headed 4K 4x mask case in the P4 spec; headed run on the reference PC; evidence under `docs/evidence/e22/`      | E22-A5, A6        |

U1 goes first: the MVP editor's frame clipping needs the budget. U2 is independent of U1.

**Unit records.** U1 (2026-10-28): `maskTileSet` and the K3 budget in `MaskPlan`; per-tile pass records, one tile set per rendering frame and early release in `native-primitive-scene.ts`; `tests/unit/e22-u1-tiled-mask.test.ts` (A1 to A3, with the failure paths). Changed P4 unit expectations (A6): `p4-u4b-mask-passes` now sees the tile set ids (`mask-tiles-n/color`, `/resolve`, `/stencil`) in the passes and the destroyed list, and a `copyTextureToTexture` after each pass; `p4-u4-mask-plan` uses an 8192² surface and 9000-unit sources for its over-budget cases (notice bytes `8192² + 1024² × 9`), since a 4096² level now fits at 4x. E22-A4 on SwiftShader (Chrome for Testing 153.0.8010.12, headless, container build of the WASM kernel): a 2100 × 1300 surface at DPR 2 with an analytic-source mask holding a nested mesh-source mask, and an even-odd mesh-source mask under a rotated rect clip, all levels larger than one tile; the presented frames at 1x and 4x are byte-identical to the same scene at `9ef77b5` (SHA-256 `c6137718…` for all four), 3 mask passes, no diagnostics. U1 merged 2026-10-28 (#295, `937ce6d`).

U2 (2026-10-28): `DIAGNOSTIC_CODES.CLIP_UNAVAILABLE` (`render.clip-unavailable`, warning) emitted by `WebGpuBackend` once per generation after the scene comes up without the clip variants it was asked for; `PipelineCache.evict` (a pending creation is invalidated, a late value released); the clip creation catch evicts the analytic and mesh clip variants. `tests/unit/e22-u2-clip-unavailable.test.ts` (A7, A8): five of the six failure steps fail without the eviction (checked by removing it); the analytic step holds either way, since nothing is cached before it.

U3 (2026-10-28): test `E22 U3 tiled mask passes at 3840 x 2160 (E22-A5), 4x, DPR 2` in `tests/gpu/p4-clip-mask.spec.ts` (a full-screen mask; a nested mask whose mesh source spans 2 × 2 tiles of its level); every pixel is checked at the interior tolerance 2/255, stricter than A5, kept on purpose. Reference PC ([evidence](../evidence/e22/README.md)): A5 PASS in Chrome 156 and Edge 156 (interior max 0, edge max 1/255, no diagnostics); A6 full `pnpm test:gpu` 134 passed at `f27919b`.

## 5. Risks

- **E22-R1 viewport range.** Tiles move the negative viewport origin to `-(device.x + tile offset)`, still no further than `-target.width`, which P4 U5 already reached in both browsers. E22-A5 checks it at 4K.
- **E22-R2 more passes.** A level of `w × h` takes `⌈w/tw⌉ × ⌈h/th⌉` passes, each drawing the whole source (12 at 4K). The source draw is one instanced quad or one mesh draw; `maskPasses` keeps counting levels, not tiles, so P4-A06 is unchanged.
- **E22-R3 lost cache on a failed packet.** Releasing replaced entries before creation means a failed packet loses them. They are re-rendered on the next frame, which their changed key or size requires anyway.

## 6. Questions (each with a recommended option)

- **E22-Q1 tile size.** (a) `T = 1024`. (b) `T = 2048` (37.7 MB tile set at 4x; at most three 4K 4x full-screen masks). (c) Tile only at 4x. Recommended (a): six 4K 4x masks fit, and one rule at both sample counts fixes limitation 4 at 1x too.
- **E22-Q2 when the diagnostic fires.** (a) Once per generation when the scene becomes ready without the variants it was asked for. (b) Once per generation at the first packet with a clipped draw. Recommended (a): it names the cause at the moment it is known, needs no new submission result, and a source that asked for clips expects to draw them.

## 7. Decisions

- 2026-10-28, recommended options auto-adopted under the user's standing instruction of 2026-10-24: E22-Q1 (a), E22-Q2 (a).
- 2026-10-28, independent review r1: NOT READY (B1: per-tile pass records missing from K2); B1 and S1 to S6 applied (per-tile records, seam probes in A5, A4 readback through the presented frame, usage flags, release after validation, named unit changes, eviction per step).
- 2026-10-28, independent review r2: READY WITH FOLLOW-UPS; SF1 to SF4 applied (fixture additions named, tiles over all levels, release after the whole clip part is validated, every variant step in A8).
