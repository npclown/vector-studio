# P1.0b private contract and fixture freeze

Status: Primary-owned contract freeze for implementation of approved D1/D2. No product implementation or runtime acceptance is claimed here.

This companion to the [P1 plan](p1-instanced-primitives.md) owns private packet layouts, fixture literals and precision/rebase rules. Public scene types and rejection semantics remain in that plan's D1; visual behavior remains D2 and the [graphics architecture](../graphics-engine-architecture.md). [Approved D4](p1-instanced-primitives.md#d4-approved-entryexit-separation) permits this checkpoint while P1.0m remains unresolved. No new package, dependency, public result variant or scheduler is introduced.

## Ownership and implementation handoff

- P1.1 owns `contracts/src/scene.ts`, its package exports, and core-local `scene-*` mirror/validation files and tests. It implements the exact D1 shape, detached ownership, atomic publication and camera state. Candidate validation includes finite world-transform/stroke-bound arithmetic using a shared core-local numeric helper; P1.2 reuses that helper for derived caches rather than adding a second geometry convention. Traverse deep graphs iteratively; no undocumented container-depth rejection. P1.1 also materializes the exact private packet type declarations below and their renderer-core export, without packet preparation/consumption logic. This type foundation must integrate before parallel P1.2/P1.3, so neither worker depends on an unfinished file owned by the other. P1.1 does not integrate the backend or create GPU packets yet. A private invalidation callback can connect to the existing scheduler in P1.4; tests use a spy.
- P1.2 owns core-local derived transforms, conservative bounds, culling, stable slots, packet preparation and numeric fixtures. The private packet definitions established by P1.1 live in `renderer-core/src/primitive-packet.ts` and stay frozen; renderer-webgpu imports through the renderer-core package entry. A package export needed by the inward renderer dependency is an internal engine seam, not an addition to the editor-facing contracts package. No DOM/GPU types appear in it.
- P1.3 owns new webgpu-local unit geometry, packing consumer and analytic primitive shader files/tests. It follows this byte layout and D2. It does not edit `webgpu-backend.ts`, `webgpu-platform.ts` or shared lifecycle exports concurrently with another task.
- P1.4 has one owner for service composition, backend/platform seams, logical-to-native allocation bindings, submission serials, recovery and export wiring. Existing foundation behavior remains a regression target. Reuse `SharedBufferAllocator`, `PipelineCache`, `ResourceAccounting` and the backend RAF; do not create parallel lifetime/accounting systems.
- P1.5 supplies headed independent visual evidence. Numeric or scalar arithmetic checks in this document are prospective oracles, not proof of native shader output. P1.6/P1.7 remain gated by the separate measurement contract.

## Packet v1 envelope

The private CPU packet is synchronous and contains the following exact semantic fields. All IDs/revisions are CPU values, not truncated GPU integers. Private scene-epoch, packet, backing-incarnation and record-version tokens are fresh symbols compared by identity; they never wrap or collide and are not serialized. Public scene/camera revisions and backend generation retain their existing numeric contracts. A readonly TypeScript object does not make a typed array immutable: backend consumption must finish or copy the referenced bytes before returning.

| Field                                                 | Value and invariant                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layoutVersion`                                       | Literal `1`; reject a mismatched layout before any write                                                                                                |
| `scene`                                               | D1 document/page identity and accepted scene revision                                                                                                   |
| `sceneEpoch`                                          | Private identity token, replaced on accepted replacing snapshots (not identical replay); disambiguates identity switches back to an old revision domain |
| `cameraRevision`, `surfaceRevision`, `originRevision` | Separate revisions, recorded with every packet; origin revision is a private identity token                                                             |
| `generation`, `packetId`                              | Current numeric backend device generation and fresh private packet identity token; never reuse an old completion identity                               |
| `mode`                                                | `reconstruct` or `incremental`; first packet for a generation, scene epoch or replaced backing incarnation is reconstruct                               |
| `resources`                                           | Complete ordered logical resource descriptors: ID (also the kind), incarnation and capacity bytes; no native handles                                    |
| `writes`                                              | Ordered entries: resource ID/incarnation, destination byte offset, owned `Uint8Array` view, and record-version receipts covered by the write            |
| `draws`                                               | Adjacent ordered ranges: first order-index, count, and pipeline variant; count zero emits no draw                                                       |
| `frame`                                               | Physical surface width/height, sample count 1 or 4, target-format identity; uniform bytes use the frame write below                                     |

Resource kinds/IDs are `transforms`, `geometry`, `styles`, `order`, `frame`. Each backing incarnation is a fresh private identity token; grow/replacement invalidates old bindings. Arrays have one stable primitive slot per live primitive, separate from visible paint order. Containers consume no GPU slot. Initial scene/snapshot slot assignment uses authoritative depth-first order including hidden primitives, independently of snapshot node-array enumeration. Generation recovery and arena growth preserve the current logical slots. Snapshot replacement can rebuild slots; incremental removal does not compact or renumber unrelated nodes. Insertions processed in ordinal node-ID order reuse the lowest free logical slot or append. Native reuse is governed separately by queue lifetime below. New/reused slots initialize all three records before appearing in `order`.

`order` is a compact visible stream of u32 stable-slot indices in depth-first authoritative child order after visibility/culling. Changed membership may write order; unchanged membership/order does not. Compatibility applies to adjacency in this visible stream; never cross an incompatible visible draw or reorder visible primitives. Reorder, removal or culling may update this index stream without moving transform/style/geometry records. No style sort is allowed. One common D2 analytic variant can branch on the geometry kind; sample count/attachment format are backend pipeline variants. Adjacent compatible ranges may combine; incompatible ranges stay ordered.

Transform/geometry/style capacities share the smallest power-of-two primitive slot count covering occupied slot high-water demand (minimum 16); order has its own power-of-two visible-index capacity (minimum 16); frame is exactly 32 bytes. No automatic shrinking occurs in P1. All byte arithmetic is checked against adapter limits; empty scenes have an empty draw list. Allocation failure preserves CPU truth and dirty data and reports existing `allocation.failed`; no per-node GPU-buffer fallback. CPU buffers and pending replacement storage count at their actual capacities, not live item count. Use four read-only storage bindings (transforms, geometry, styles, order) and one uniform binding (frame). One generation-owned arena GPUBuffer with STORAGE | UNIFORM | COPY_DST usage holds five allocator-managed regions, one per resource kind, in the resource order. Use one existing SharedBufferAllocator per arena, alignment max(4, minStorageBufferOffsetAlignment, minUniformBufferOffsetAlignment). Arena capacity is the smallest power of two covering the sum of aligned region capacities. Bind each region at its aligned byte offset with its logical capacity; add that base to packet-relative write offsets. Any capacity growth replaces the arena, changes all binding incarnations and reconstructs occupied data. Retire the old arena after its last submitted use completes. Shared quad vertex/index buffers are separate static resources. ResourceAccounting tracks each arena backing once, including padding; it does not add the five subranges again. Check maxStorageBufferBindingSize, maxUniformBufferBindingSize, maxBufferSize, binding count and offset alignment before writes. Binding offsets use the device's required storage/uniform alignment; write offsets/lengths are multiples of four. Growth is exceptional reconstruction work with old/new overlap recorded. A warmed single-node transform edit must not grow capacity or rewrite unrelated records.

## Byte layouts

Packet `resources` always uses `transforms,geometry,styles,order,frame` order; writes use that order then ascending destination offset, with no overlapping writes in one resource. Draws use visible painter order. Record receipts are ordered by record index. Resource IDs are exactly these five literals, qualified by the backing incarnation token. A descriptor alone never acknowledges its resource contents; only covered record-version receipts do.

All lanes are little-endian 32-bit words. Float lanes are f32; indices/tags are u32. Offsets and strides below are bytes. Storage layouts use scalar or four-lane groups rather than implicit three-lane padding. Padding lanes are zero. No source IDs, safe-integer revisions, DOM/GPU references or object pointers are encoded as f32.

| Resource   | Stride | Offsets and meaning                                                                                                                                                        |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transforms | 32     | 0,4,8,12: `a,b,c,d`; 16,20: `e-originX,f-originY`; 24,28: zero                                                                                                             |
| geometry   | 48     | 0: u32 kind (rectangle 0, ellipse 1, line 2); 4: zero; 8,12: width,height; 16,20,24,28: normalized TL,TR,BR,BL radii; 32,36,40,44: line start x,y and end x,y              |
| styles     | 48     | 0..12: straight fill RGBA; 16..28: straight stroke RGBA; 32: local stroke width; 36: primitive opacity; 40: u32 flags (bit 0 fill present, bit 1 stroke present); 44: zero |
| order      | 4      | u32 primitive slot                                                                                                                                                         |
| frame      | 32     | 0,4: `originX-cameraX,originY-cameraY`; 8: zoom; 12: effective DPR; 16,20: f32 physical width,height; 24,28: zero                                                          |

Rectangle/ellipse unused line lanes are zero. Ellipse radius lanes are zero. Line width/height/radii lanes are zero. Null styles have zero RGBA/width and an unset corresponding bit; zero alpha remains a present style with no visible contribution. Geometry stores D2 radius normalization derived in Float64, never writes normalized values back to caller scene data. Zero area, singular transforms and zero-length lines are omitted from draw order. Width-zero strokes have zero stroke coverage. Fill/stroke composition and opacity are exactly D2; instance packing does not premultiply the straight source colors twice.

Unit geometry is one shared quad with local unit coordinates `(0,0),(1,0),(0,1),(1,1)` and indices `[0,1,2,2,1,3]`. Shader positioning expands it to the primitive's local stroke-inclusive conservative rectangle; interpolated local coordinates drive analytic coverage. A line uses endpoint bounds expanded by half stroke width; its analytic butt-cap test removes the conservative excess. The backend expands raster coverage by the two-physical-pixel guard in physical space; the geometry cache remains unchanged on camera/style edits. Shared vertices/indices are not rebuilt to widen a stroke. Style-width changes update style and derived bounds/culling only. Position construction must include the numeric budget below.

Pipeline cache uses existing key fields: shaderKey `p1-analytic-v1`, layoutKey `p1-packet-v1`, vertexLayoutKey `unit-quad-v1`, actual non-sRGB unorm targetFormat, renderStateKey `premultiplied-source-over/no-depth/no-cull/triangle-list-v1`, actual sampleCount 1 or 4. Changing layout/shader/render state must change its corresponding key. Generation remains owned by the existing cache, not embedded as a guessed string variant. Resize alone does not create a new pipeline when format/sample count are unchanged.

## Dirty data, acknowledgment and lifetime

### Private callable seam

This private TypeScript shape is the P1.2/P1.4 boundary, not an addition to `contracts/src/scene.ts`. `SceneVersion` is approved D1. The composition owner attaches one source to the existing backend RAF. Each ready frame supplies its target to `prepare`, consumes a non-null packet synchronously, then calls `acknowledge` only for a submitted receipt. Null means no scene/work to submit. The owner catches preparation exceptions, emits `render.submission-failed`, and preserves dirtiness. There is no second RAF or async source callback.

```typescript
type PrimitiveResourceId = 'transforms' | 'geometry' | 'styles' | 'order' | 'frame';
type PrimitiveTarget = Readonly<{
  generation: number;
  surfaceRevision: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  sampleCount: 1 | 4;
  targetFormat: 'bgra8unorm' | 'rgba8unorm';
}>;
type PrimitiveRecordVersion = Readonly<{ index: number; version: symbol }>;
type PrimitiveResource = Readonly<{
  id: PrimitiveResourceId;
  incarnation: symbol;
  capacityBytes: number;
}>;
type PrimitiveWrite = Readonly<{
  resourceId: PrimitiveResourceId;
  incarnation: symbol;
  byteOffset: number;
  bytes: Uint8Array;
  records: readonly PrimitiveRecordVersion[];
}>;
type PrimitiveDraw = Readonly<{
  first: number;
  count: number;
  variant: 'analytic-v1';
}>;
type PrimitivePacket = Readonly<{
  layoutVersion: 1;
  scene: SceneVersion;
  sceneEpoch: symbol;
  cameraRevision: number;
  surfaceRevision: number;
  originRevision: symbol;
  generation: number;
  packetId: symbol;
  mode: 'reconstruct' | 'incremental';
  resources: readonly PrimitiveResource[];
  writes: readonly PrimitiveWrite[];
  draws: readonly PrimitiveDraw[];
  frame: PrimitiveTarget;
}>;
type PrimitiveReceipt = Readonly<{
  scene: SceneVersion;
  sceneEpoch: symbol;
  cameraRevision: number;
  surfaceRevision: number;
  originRevision: symbol;
  generation: number;
  packetId: symbol;
  submissionSerial: number;
  resources: readonly Readonly<{
    resourceId: PrimitiveResourceId;
    incarnation: symbol;
    records: readonly PrimitiveRecordVersion[];
  }>[];
}>;
type PrimitiveSubmitResult =
  | Readonly<{ status: 'submitted'; receipt: PrimitiveReceipt }>
  | Readonly<{ status: 'not-ready' | 'stale-generation' }>
  | Readonly<{
      status: 'failed';
      reason: 'invalid-packet' | 'allocation-failed' | 'submission-failed';
    }>;
interface PrimitivePacketConsumer {
  submitPrimitivePacket(packet: PrimitivePacket): PrimitiveSubmitResult;
}
interface PrimitiveFrameSource {
  prepare(target: PrimitiveTarget): PrimitivePacket | null;
  acknowledge(receipt: PrimitiveReceipt): void;
}
```

`frame` is target metadata; uniform bytes are a write to resource `frame` (single record index 0). Duplicated generation/surface revision must agree with the current backend; metadata never overrides native configuration. Core owns logical capacity/incarnation tokens and changes all five together on logical arena growth; backend owns native resolution. New generation/scene epoch or any backing replacement/growth requires a complete reconstruct packet before an incremental packet can be accepted. `order` receipt indices are u32 element offsets; other receipt indices are primitive slots. Unknown layouts, byte bounds, indices, overlapping writes, incarnation mismatches and inconsistent metadata fail preflight before writes.

Ordinary consumer failures return results rather than throw: not-ready acknowledges nothing and waits for normal readiness; stale-generation emits `render.stale-generation-skipped`; allocation-failed emits `allocation.failed`; invalid-packet/submission-failed emit `render.submission-failed` with the private reason. Every non-submitted result acknowledges nothing. Receipts contain detached metadata and no upload-byte views; consumer retains no core mutable views after return. Loss notifications follow existing recovery independently.

### Dirty receipts and native retirement

Each occupied slot has independent transform/geometry/style identity-version tokens; equality, not numeric ordering, determines acknowledgment. `order` and `frame` have separate versions. CPU comparison of accepted values drives dirtiness; an increased scene revision alone does not dirty unchanged records. Derived descendants of an edited ancestor are affected records; an isolated leaf edit has no such exception for unrelated slots. Coalesce only adjacent dirty records of the same resource; do not bridge a clean record to reduce write-call count. A single transform edit uploads exactly its 32-byte record, plus genuinely changed order/frame data if any, and zero geometry/style records. Report order/frame bytes separately so they cannot conceal instance writes.

A submission receipt carries generation, scene epoch, packet ID, backing incarnation and exact record versions. Acknowledge only after all required writes, encode and synchronous queue submission succeed for the current identity. Clear a dirty record only if its current version equals that receipt; a later accepted edit remains dirty. A failed partial write is not acknowledged; retry all unacknowledged ranges before a later draw. Preparation/upload failures do not advance submitted scene/frame markers. Device loss invalidates that generation's GPU caches and forces reconstruction. An uncaptured validation error retains the existing diagnostic behavior; it does not itself change device generation or retroactively acknowledge/clear any dirty receipt. Such an error prevents runtime acceptance and requires investigation; a submission receipt is not a completion or presentation claim.

The backend alone assigns monotonic submission serials and marks every used allocation, including unchanged buffers referenced by a draw. Existing allocator retirement and `waitForSubmittedWork` completion govern physical reuse. Logical slot reuse in the same buffer is safe only through ordered writes/submissions on the same queue: old draws precede the overwrite and new draw. Do not treat logical deletion as permission to free/reallocate a still-in-flight native range. Growth/replacement retires old backing until its last use completes; track old and new capacity simultaneously. GPU binding offsets/incarnations are backend data, never scene data.

On loss, invalidate pipeline/allocation bindings for the old generation; stale async creation/completion/receipts cannot publish or free anything in the new generation. Every reconstruct packet writes all occupied transform/geometry/style slots, including hidden primitives, and the complete current compact order plus frame, before its first draw. Rebuild from the latest accepted CPU state; hidden-slot deferral applies only to subsequent incremental updates. Edits during recovery continue to publish CPU state. Dispose is terminal and idempotent, releases CPU arrays/maps and native ownership exactly once, detaches callbacks and prevents late resurrection. Existing resource accounting tracks backing buffers/textures once, not each logical record again; CPU inventory separately tracks real arrays/candidate/mirror storage. This is attribution, not an A09 peak proof.

## Precision and rebase contract

World affine composition, bounds, radius normalization and camera subtraction use Float64. The quality corpus is the active plan's existing envelope, not a new public rejection range. Do not clamp camera zoom/coordinates or scene data to this corpus. Nonfinite candidate world transforms or bounds reject atomically with existing `invalid-value`. Finite but unrepresentable GPU packets preserve the accepted CPU scene, retain dirty work, report existing `render.submission-failed` with a numeric-preparation reason and do not submit corrupt bytes; outside-corpus precision is not claimed. No new public rejection/result variant is needed.

Origin is a Float64 document point shared by a packet, initialized as `256 * floor(cameraAxis / 256)` on both axes. Keep it while each camera-axis displacement is at most 512 document units and the packing budget for the visible corpus is met. Crossing 512 (strictly greater, either axis) snaps both axes by the same formula and replaces the origin revision token. This creates at least 256 document units of hysteresis; do not rebase at every grid boundary. Before casting translations, subtract this origin in Float64; add the small origin-minus-camera uniform before zoom/DPR in the shader. Never cast absolute world/camera coordinates to f32 first.

A zoom/DPR change or newly visible primitive requires rechecking the position budget, but the budget recheck alone does not dirty geometry or a matching-origin transform. A newly visible slot with a stale origin/version must upload its current transform before entering order. If the retained anchor fails the budget, try the snapped current-camera anchor once. Each packet must carry a single consistent origin token. An actual changed anchor can repack transform records only; at most `32 * occupiedPrimitiveSlots` bytes (320,000 bytes for 10k live slots), no geometry/style repack. Holes need no upload. All initialized slots must carry the current origin before use; hidden dirty slots may defer upload until visible, but may not reuse stale-origin bytes. No global rebase is triggered by the fixed-camera benchmark's isolated transform trajectory. Initial/recovery/growth/rebase uploads have distinct counters and cannot be hidden inside steady single-node edit evidence.

Position error for every tested visible point in the viewport plus two physical pixels must be <=0.25 physical pixel against independent Float64 evaluation. P1.2 must test f32 storage and arithmetic, not just Float64 matrix multiplication; P1.5 verifies real shader positions. Divide the budget into <=0.125 physical pixel for stored-value quantization and <=0.125 for shader arithmetic/projection. Evaluate both including local position construction, stroke expansion, zoom/DPR and NDC round trip. Use a conservative operation error bound or directed interval evaluation across each fixture contour segment; checking only a center point is insufficient. Camera-only motion inside hysteresis must pass without transform writes.

If this budget cannot be satisfied for the frozen corpus even after the allowed rebase, P1.2/P1.3 must escalate to Primary before changing representation or narrowing coverage. The tuple layout is not permission to ship failed precision. A Float32 split representation would require a reviewed successor private layout and its fixtures; it cannot be independently improvised by a worker. P1.0b freezes this measurable obligation, not a claim that a future shader has passed it.

## Literal correctness corpus

All fixtures use document/page `fixture-doc`/`fixture-page`, scene revision 0, camera `(0,0)` zoom 1, identity affine `[1,0,0,1,0,0]`, visible true and opacity 1 unless overridden. Colors are RGBA, arrays TL/TR/BR/BL. Dimensions are local units. Numeric visual surfaces are 640x360 CSS, DPR separately 1,1.5,2, samples separately 1 and 4, opaque black clear unless stated. Separate variants are not pooled. These fixtures supplement, not replace, the four frozen benchmark workloads.

| ID  | Literal input and expected result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Owner          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| V01 | Rectangle at `(20,20)`, 100x60, radii `[80,40,20,0]`, white fill, null stroke. Common factor 0.75; normalized radii `[60,30,15,0]`                                                                                                                                                                                                                                                                                                                                                                                                                                              | P1.2/P1.3/P1.5 |
| V02 | Rectangle at `(20.25,20.5)`, 40x30, radii zero, blue fill `(0,0,1,1)`, red stroke `(1,0,0,1)` width 4, node opacity 0.5, transparent clear. Interior expected `(0,0,0.5,0.5)`, fully covered stroke-over-fill expected `(0.5,0,0,0.5)` in premultiplied framebuffer units                                                                                                                                                                                                                                                                                                       | P1.3/P1.5      |
| V03 | Two 80x80 rectangles at `(30,30)` and `(50,50)`, red/blue fill alpha 0.5. At overlap on transparent clear, red then blue = `(0.25,0,0.5,0.75)`; reversed = `(0.5,0,0.25,0.75)`                                                                                                                                                                                                                                                                                                                                                                                                  | P1.2/P1.3/P1.5 |
| V04 | Ellipse at `(200.25,80.5)`, 80x40, green fill, white stroke width 0.5; variants rotations 0,15,45,90 degrees, reflection `[-1,0,0,1,300,0]`, nonuniform `[2,0,0,0.5,0,0]`, shear `[1,0,0.25,1,0,0]`, composed on the left of placement                                                                                                                                                                                                                                                                                                                                          | P1.2/P1.3/P1.5 |
| V05 | Line `(0,0)` to `(40,0)`, at `(40.25,140.5)`, fill null, white stroke width 3. Butt contour local x `[0,40]`, y `[-1.5,1.5]`; test the same affine variants as V04                                                                                                                                                                                                                                                                                                                                                                                                              | P1.2/P1.3/P1.5 |
| V06 | Separate rectangle width 0, ellipse height 0, line coincident `(3,4)` endpoints, primitive affine `[1,0,2,0,0,0]`: each omitted including stroke. Hidden container suppresses visible child. Container opacity 0.5 rejects entire candidate as unsupported-feature                                                                                                                                                                                                                                                                                                              | P1.1/P1.2/P1.5 |
| V07 | White no-stroke rectangles 8x8 with translations `(-8,20)`, `(640,20)`, `(20,-8)`, `(20,360)`: conservative guarded visibility includes touching boundaries; moving farther outside than the two-physical-pixel guard excludes them. Compare brute-force inclusive bounds, never infer culling from node count alone                                                                                                                                                                                                                                                            | P1.2/P1.5      |
| N01 | Parent `[2,0,0,3,10,20]`, child `[1,0,0.25,1,4,5]`, point `(2,3)` -> world `(23.5,44)`. Camera `(10,20)`, zoom 2, DPR 1.5 -> CSS `(27,48)`, physical `(40.5,72)`; inverse returns source point                                                                                                                                                                                                                                                                                                                                                                                  | P1.1/P1.2      |
| N02 | White filled rectangles, with null stroke and separate white-stroke width 4 variants. Origin `(1e9,-1e9)` and its negation, shape translation origin plus `(0.25,0.5)`, dimensions 16x8, 16x16 and 4096x4096; camera at origin and separately origin plus the transformed local center, zoom 0.01,1,64 and DPR 1,1.5,2; V04 affine linear variants applied locally before placement. Sample visible clipped contour intervals plus guard, fractional points and independent reference corners. Centered-camera variants exercise large partly visible geometry and cancellation | P1.2/P1.3/P1.5 |
| N03 | Camera x sequence `0,255.75,256,511.75,512,512.25,511.75`, y 0: origin x `0,0,0,0,0,512,512`. Negative sequence `0,-0.25,-256,-512,-512.25`: origin x `0,0,0,0,-768`. Freeze zoom 1, DPR 1; test forward/backward precision, origin token changes and exact transform-write counts                                                                                                                                                                                                                                                                                              | P1.2/P1.4      |
| N04 | Fixed benchmark S4 camera/trajectory: 10k nodes, one changed target, no rebase, zero geometry/style writes, one 32-byte transform write per actual changed target; order buffer unchanged if visible order is unchanged                                                                                                                                                                                                                                                                                                                                                         | P1.2/P1.4      |
| L01 | Prepare revision 4, accept revision 5 before acknowledgment of 4: only equal record versions may clear; then loss/recovery with an edit to revision 6, old completion ignored and first rebuilt submission uses 6                                                                                                                                                                                                                                                                                                                                                               | P1.4           |
| L02 | Draw A, remove A, reuse its logical slot for B while A's submission is unfinished: queue-ordered overwrite is safe, retired native allocation remains unavailable until its last serial completes. Grow, fail partway through upload, retry, dispose during creation and double-dispose variants release all owned resources once                                                                                                                                                                                                                                               | P1.4           |

V02/V03 expected values are premultiplied render-target values; an unpremultiplying PNG/readback path must explicitly convert before comparison. Interior/exterior samples are at least two physical pixels from contours, tolerance 2/255 per channel. Edges are separately compared against analytic contours within one physical pixel as already required; preserve full images. Oracle formulas and constants must not import implementation shader/packing helpers.

## Atomic protocol fixtures and validation order

Packet fixture B01 uses root primitives `a,b` (white 10x10 rectangles at identity and translation `(20,0)`), root order `[a,b]`, camera/origin zero. Slots are `a=0,b=1` even if snapshot nodes are `[b,a]`. Primitive capacity 16 gives transform/geometry/style capacities 512/768/768 bytes, order capacity 64 bytes and frame 32 bytes. Reconstruct writes offsets 0,32 for transforms; 0,48 for geometry/styles; order u32 `[0,1]` at offset 0; frame at offset 0. Adjacent dirty records may form one contiguous write. Root-order replacement `[b,a]` produces only order u32 `[1,0]` at offset 0 (8 bytes), with all payload slots unchanged. A subsequent translation of a to `(0.5,0)` writes transform slot 0 at offset 0 (32 bytes), f32 lane 16 equal to 0.5; no style/geometry/order write. Compare identity tokens for continuity/change, never invented numeric values. P1.2 tests this packet, P1.4 tests logical-to-arena offsets independently.

P1.1 freezes a base scene: container `g` at root with children `a,b`, primitive `a` a 10x10 white rectangle, primitive `b` a 10x10 red ellipse, all other fields the defaults above. Snapshot nodes may be enumerated in any order; authoritative `rootOrder=['g']`, `g.children=['a','b']`. Rejection fixtures are independent mutations of this base, never chained after a rejection unless explicitly testing resync state.

| ID  | Operation                                                                                                                                                                                              | Expected outcome                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| S01 | Initialize, caller mutates nested arrays/colors, query/result caller mutation, equal-revision snapshot with nodes enumerated `[b,g,a]`                                                                 | Accepted state detached; identical logical snapshot replayed without invalidation                            |
| S02 | Same-identity lower snapshot revision; same revision changed node; higher snapshot revision; different identity revision 0                                                                             | stale-snapshot; revision-conflict; applied replacement; applied new domain                                   |
| S03 | Incremental before snapshot, mismatched base, further valid-looking delta while resync required, invalid full snapshot, then valid identical snapshot                                                  | resync-required persists through invalid input; only valid snapshot resynchronizes                           |
| S04 | Duplicate node ID; ID in inserted and removed; duplicate orders; full container update plus order for that container                                                                                   | duplicate-id; conflicting-operation for remaining cases                                                      |
| S05 | Unknown update/removal/order parent; missing parent; parent is primitive; cycle `g -> h -> g`; omitted/duplicate/wrong-parent child in authoritative order                                             | unknown-node; invalid-parent; invalid-parent; cycle; invalid-order respectively                              |
| S06 | Remove g and replace root order with empty, leaving a,b parented to g; remove g and reparent a,b to root with explicit root order; insert h and reparent a to h with both old/new orders in same delta | invalid-parent; applied; applied                                                                             |
| S07 | NaN/infinity, missing/extra fields, fractional revision, empty ID, negative size/stroke/radius, channel/opacity outside [0,1], arithmetic world-bound overflow                                         | invalid-value without publication                                                                            |
| S08 | Line with fill; non-unit container opacity; unknown kind                                                                                                                                               | unsupported-feature for first two; invalid-value for unknown discriminant outside declared type              |
| S09 | Camera unchanged; changed; invalid; revision overflow; camera before scene; identity switch after camera; dispose twice, then operations/queries                                                       | D1 exact camera result/revision rules; no scene dirtiness, terminal disposed results and null current/camera |

Stable validation traversal is: declared top-level fields in D1 declaration order; node values by ordinal UTF-16 code-unit ID comparison (no locale comparison), with fields `id,parentId,transform,visible,opacity,kind,geometry,style,children`; tuples/arrays in index order; geometry/style fields in D1 declaration order. Invalid/missing IDs use input index until sorting is possible; duplicate IDs tie by input index. Declared fields are checked first; unknown extra property names follow in ordinal order within that object's shape validation. Error categories follow D1 precedence even if a later traversal finds an earlier-priority category. Cycle checking examines parent links independently of order consistency. While resync is already required, incremental calls return resync-required before shape validation; disposal always wins. Multiple-error fixtures pair shape+base mismatch, conflict+unknown reference, parent+cycle and cycle+bad order to prove precedence. No new public diagnostic reason is added.

P1.1 acceptance requires the private declaration/export foundation, S01-S09, detached state/dirty/invalidation spies on every rejection, no partial publication, and root `pnpm check` plus `pnpm build`. Include camera revision-overflow through a controlled internal fixture, not billions of calls or a new public setter. P1.2/P1.3 implement the numeric/layout fixtures with independent oracles; P1.4 implements receipts/native lifetime fixtures and existing lifecycle regression tests. All later work retains the parent plan's acceptance mapping and validation commands. A failing frozen fixture is a defect or an explicit Primary escalation, not permission to rewrite its expected meaning.
