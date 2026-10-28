# E22 contract: P4 clip and mask follow-ups

Status: DRAFT 2026-10-28, Full tier (a new diagnostic code in `packages/contracts`, the mask budget's accounting rule, renderer resource behavior). Rendering-track item [E22](d9-rendering-track.md#status-index). The user moved E22 out of the backlog on 2026-10-28, to run beside the MVP editor plan; frame clipping in the MVP editor depends on the mask budget.

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

**E22-K1 (one tile set per frame).** Every mask pass of a frame renders through one shared set of transient attachments, the *tile set*, of size `tw × th` with `tw = min(T, max width)` and `th = min(T, max height)` over the frame's re-rendered levels, `T = 1024` (`P4_MASK_TILE_SIZE`). The set holds:

- a colour tile, `r8unorm`, at the scene's sample count;
- at 4x, a resolve tile, `r8unorm`, 1 sample;
- a `stencil8` tile at the scene's sample count, only when a re-rendered level has a mesh source.

The set is created once, before the first mask pass, and released after the frame's submission, as P4 section 4 already requires for transients.

**E22-K2 (tiled mask pass).** A level's texture is covered by tiles at offsets `(i·tw, j·th)` from its device rect's origin. Each tile is one render pass over the tile set (clear, draw the source as P4 section 4, the same viewport rule offset by the tile's origin), followed by `copyTextureToTexture` from the 1-sample tile (the colour tile at 1x, the resolve tile at 4x) into the level's texture at the tile's offset, clipped to the texture. Tile offsets are multiples of `tw` and `th` from the device origin; the fragment position of every texel stays what it is in an untiled pass, so the texture content is unchanged (E22-A4).

**E22-K3 (budget).** `MaskPlan` admits a level when

`resident(admitted levels and this level) + tileBytes(admitted levels and this level) ≤ 64 MiB`,

where `resident` is the sum of `width × height` and `tileBytes = tw × th × (sampleCount = 4 ? 9 : 2)` (colour, resolve and stencil tiles at 4x; colour and stencil at 1x; the stencil counted whether or not a source is a mesh, so the plan is an upper bound). The renderer holds at most this many mask bytes at any point of a frame:

- a cached entry whose level the frame does not use, or whose size changes, is released before the frame creates any mask texture (its content would be replaced anyway; a failed packet then re-renders the level next frame);
- only the tile set is transient.

Figures at `T = 1024`: a 3840 × 2160 full-screen level is 8,294,400 resident bytes; the tile set is 9,437,184 bytes at 4x and 2,097,152 at 1x. Six such levels fit at 4x (59,203,584) and the seventh is reported; seven fit at 1x (60,157,952) and the eighth is reported (P4 also fitted seven at 1x).

**E22-K4 (diagnostic without clip variants).** When a primitive frame source requires the clip pipeline (`clips` other than `'none'`) and the primitive scene comes up without the clip variants, the backend emits `render.clip-unavailable` (severity `warning`, new code) once per generation, when the scene becomes ready. Under a backend test hook the generation still fails as P4 U3 fixes. The fail-closed rule (clipped draws not drawn) is unchanged.

**E22-K5 (no cached variant on failure).** If any clip or mask variant fails to build, the clip variants this attempt put into the pipeline cache are evicted and released before the scene is created without variants. `PipelineCache` gains `evict(key)`, which removes an entry and releases a ready value.

## 3. Acceptance criteria

| ID      | Criterion                                                                                                                                                                                                                       | Method                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| E22-A1  | A frame that re-renders N mask levels creates exactly one tile set (or none when N = 0), sized per E22-K1; its textures are released after the submission and after a failed submission                                       | Unit, fake device (`p4-native-fixture.ts`)       |
| E22-A2  | During a frame, live mask texture bytes (resident plus transient, from resource accounting at every texture creation) never exceed the plan's bytes for that frame, including a frame where every level changes size and one where a level is replaced by another | Unit, fake device                                |
| E22-A3  | The plan figures of E22-K3 at 3840 × 2160: six full-screen 4x levels drawn and the seventh reported; seven at 1x and the eighth reported; levels smaller than a tile give `tileBytes` from their own size                         | Unit (`MaskPlan`)                                |
| E22-A4  | Tiled mask textures are byte-identical to untiled ones: a level larger than one tile in both axes, analytic and mesh sources, nested under a parent mask, at 1x and 4x, read back from the mask texture and compared with the P4 rendering at `9ef77b5` | SwiftShader in the cloud container, recorded in the U1 PR |
| E22-A5  | A 3840 × 2160 surface at 4x with one full-screen mask draws it with no `render.clip-resource-limit`, and its interior and edge probes match the P4 oracle as P4-A02 and A03 require                                              | Headed GPU spec on the reference PC, Chrome and Edge |
| E22-A6  | The P4 headed spec (`tests/gpu/p4-clip-mask.spec.ts`) passes unchanged in both browsers, and the full `pnpm test:gpu` passes on the reference PC                                                                                | Headed, reference PC                             |
| E22-A7  | `render.clip-unavailable` is emitted once per generation when clips are required and the variants are unavailable, and not when they are available or not required; a test-hook backend still fails the generation            | Unit                                             |
| E22-A8  | A mesh clip variant failure leaves no clip variant in the pipeline cache (ready entries back to the count without clips) and released accounting entries                                                                        | Unit                                             |

## 4. Units

| Unit | Content                                                                                                         | Criteria          |
| ---- | --------------------------------------------------------------------------------------------------------------- | ----------------- |
| U1   | Tile set and tiled mask pass in `native-primitive-scene.ts`; the E22-K3 budget in `MaskPlan`; early release of replaced entries | E22-A1 to A4      |
| U2   | `render.clip-unavailable` (contracts, backend), `PipelineCache.evict` and the variant rollback                   | E22-A7, A8        |
| U3   | Headed 4K 4x mask case in the P4 spec; headed run on the reference PC; evidence under `docs/evidence/e22/`      | E22-A5, A6        |

U1 goes first: the MVP editor's frame clipping needs the budget. U2 is independent of U1.

## 5. Risks

- **E22-R1 viewport range.** Tiles move the negative viewport origin further from zero (down to `-(device.x + tile offset)`). WebGPU allows viewports outside the attachment within `±2 × maxTextureDimension2D`; P4 U5 already relied on a negative origin in both browsers. E22-A5 checks it at 4K.
- **E22-R2 more passes.** A level of `w × h` takes `⌈w/tw⌉ × ⌈h/th⌉` passes, each drawing the whole source (12 at 4K). The source draw is one instanced quad or one mesh draw; `maskPasses` keeps counting levels, not tiles, so P4-A06 is unchanged.
- **E22-R3 lost cache on a failed packet.** Releasing replaced entries before creation means a failed packet loses them. They are re-rendered on the next frame, which their changed key or size requires anyway.

## 6. Questions (each with a recommended option)

- **E22-Q1 tile size.** (a) `T = 1024`. (b) `T = 2048` (37.7 MB tile set at 4x; at most three 4K 4x full-screen masks). (c) Tile only at 4x. Recommended (a): six 4K 4x masks fit, and one rule at both sample counts fixes limitation 4 at 1x too.
- **E22-Q2 when the diagnostic fires.** (a) Once per generation when the scene becomes ready without the variants it was asked for. (b) Once per generation at the first packet with a clipped draw. Recommended (a): it names the cause at the moment it is known, needs no new submission result, and a source that asked for clips expects to draw them.

## 7. Decisions

- 2026-10-28, recommended options auto-adopted under the user's standing instruction of 2026-10-24: E22-Q1 (a), E22-Q2 (a).
