# P1 execution plan: Instanced primitives

Status: **D1/D2 APPROVED on 2026-09-09; D4 entry/exit separation APPROVED on 2026-09-12. P1.0b through P1.3 integrated; P1.4 COMPLETE locally; P1.5 follows protected integration; A09/A10 remain UNVERIFIED exit gates.**

This document owns P1 task order, approved D1/D2 contract details, acceptance and evidence. The user approved the D1 scene/camera API and D2 visual behavior on 2026-09-09 in response to the explicit approval question for PR #26 source `49c3bfd`. That 2026-09-09 approval did not change D3, measurement thresholds or the milestone entry rule. The later D4 approval below changes implementation entry only. The [roadmap](../prototype-plan.md#p1-instanced-primitives), [system boundaries](../../ARCHITECTURE.md), [graphics design gates](../graphics-engine-architecture.md#design-gates-before-later-implementation), [validation policy](../validation.md) and [benchmark policy](../benchmarks/README.md) retain their responsibilities.

## Entry state and scope

Reviewed base: `28181b7dbc1af586430d05458cdf91f363efa8f6`, clean and equal to fetched `origin/main` on 2026-09-09. [PR #25](https://github.com/npclown/vector-studio/pull/25) integrated P0; its [final evidence](../evidence/p0.6/20260909-final/README.md) remains tied to measured source `b524927`. P0 timing concessions apply only to P0.

P1 covers rectangles with independent corner radii, ellipses, simple lines, solid fill/stroke, affine transforms, primitive opacity, painter order, viewport culling and incremental uploads. It does not implement document editing, selection semantics, paths/tessellation, gradients, masks, text, symbols, WASM or new packages/dependencies. A benchmark's selected node is a fixture ID, not an editor implementation.

No P1 implementation or performance acceptance is claimed by this planning checkpoint.

| Existing source                                                                                      | Reusable behavior                                                     | P1 gap                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/renderer.ts`                                                                 | Lifecycle, invalidation, diagnostics/statistics boundary              | No scene snapshot/change protocol or draw-packet contract                                                                        |
| `packages/renderer-core/src/camera.ts`                                                               | Float64 affine composition, inverse, document/CSS/physical conversion | No retained hierarchy, bounds, camera-relative instance packing or culling                                                       |
| `packages/renderer-core/src/frame-scheduler.ts`                                                      | Coalesced invalidation and continuous/on-demand scheduling            | Must share one scheduling owner with the new service/backend path                                                                |
| `packages/renderer-webgpu/src/shared-buffer-allocator.ts` and `pipeline-cache.ts`                    | Allocation lifetimes and device-generation cache reuse                | Private, fixed-capacity utilities only; primitive backing storage, dirty ranges and ordered draw consumption remain to implement |
| `packages/renderer-webgpu/src/webgpu-backend.ts`, `webgpu-platform.ts`, `native-foundation-scene.ts` | Tested lifecycle and native foundation rendering                      | Foundation-specific creation/render seam; no general retained renderer service                                                   |
| `tests/benchmark/p0-foundation.spec.ts`                                                              | Production runner, metadata and raw observation patterns              | P1 workloads, upload/geometry counters, CPU memory and input/frame correlation                                                   |

## Decisions and approval boundary

Primary owns the shared contracts. Workers may implement only a frozen checkpoint and must escalate incompatibilities. No worker may independently invent a scene port, draw packet, color convention or lifecycle.

### Existing decisions retained

- Keep the package/import direction and composition root in [ADR 0001](../decisions/0001-port-composition.md). No dependency addition or top-level architecture revision is proposed.
- Scene synchronization belongs to a renderer service in renderer-core. The WebGPU backend consumes ordered draw data and owns native handles. The backend keeps device generation and RAF ownership; the service requests work through it. Submission serials currently live in the foundation experiment/allocator. P1.4 must make their primitive submission/acknowledgment coordination a single backend-owned responsibility.
- Keep P0 column-vector affine tuples `[a,b,c,d,e,f]`: `x' = ax + cy + e`, `y' = bx + dy + f`; `left * right` applies right first. World transform is parent world times local. Camera position denotes the document point at CSS origin; CSS = `(document - position) * zoom`, physical = CSS times DPR. Y increases downward; NDC conversion remains backend-local.
- Keep existing finite-input validation, strictly positive zoom/DPR and explicit inverse failure. Do not narrow the existing numeric camera API to a P1 quality fixture range. GPU Float32 data are derived caches; CPU scene data use JavaScript numbers/Float64.
- Keep stable painter order and only adjacent compatible batching. GPU recovery reconstructs the latest accepted CPU state. No document-command replay, GPU-owned truth, or duplicate allocator/accounting system.

### D1 — approved scene and packet contract

**Approved by the user on 2026-09-09:** the scene-facing API semantics and exported TypeScript shape below are fixed for P1. The approval itself was a design decision; P1.1 now implements the CPU synchronization surface with evidence below. Internal packet byte layouts remain Primary-owned implementation decisions; meaningful changes to this public shape require a new decision.

1. A renderer service accepts one active document/page snapshot at a time. Identity contains opaque nonempty `documentId` and `pageId`; revision is a nonnegative safe integer. A full snapshot supplies all nodes and an explicit ordered root-child list. A valid full snapshot is the only initialization/resynchronization operation and may switch identity. Callers serialize snapshot delivery; revisions are comparable only within one document/page identity. For the same active identity, a lower revision rejects as `stale-snapshot`; an equal revision succeeds as an idempotent replay only if all node values and authoritative child orders match (node-array enumeration order is irrelevant), otherwise it rejects as `revision-conflict`. A higher revision replaces the entire scene. An identical replay can complete resynchronization. A different identity starts a new scene revision domain.
2. A node snapshot contains opaque ID, parent ID or root membership, local affine transform, visibility, primitive geometry and style, or an ordered structural container. Geometry is a discriminated rectangle/ellipse/line payload. Structural containers carry ordered child IDs, explicit opacity and transform/visibility; they do not create editor/group commands. Authoritative order is explicit child lists, not insertion order in a map or a globally sorted style list.
3. A change set contains identity, `baseRevision`, resulting `revision`, inserted full nodes, updated full replacements, removed IDs and replacement child lists for affected parents/root. Require `baseRevision` to equal the accepted revision and `revision > baseRevision`; monotonic revisions need not be consecutive. IDs occur at most once across insert/update/remove operations; each parent order is replaced at most once.
4. Validate the complete candidate graph before publishing anything. Every node occurs exactly once in its parent's/root's order, parents and children agree, references exist and the graph is acyclic. Duplicate IDs, unknown updates/removals, conflicting operations, unsupported kinds, invalid numbers and malformed orders reject the entire transaction. Removing a parent requires removing or reparenting all surviving children explicitly; there is no implicit recursive deletion. Reparenting and parent insertion in one transaction are allowed when the final graph is valid.
5. A rejected transaction changes neither accepted data/revision nor dirty sets or GPU work. An identity/base mismatch returns a typed `resync-required` result with current identity/revision, preserves the last valid frame and places incremental application in a resynchronization-required state until a valid full snapshot arrives. Malformed content returns a typed `invalid-scene` result and preserves the prior synchronization state. While resynchronization is required, every incremental call returns `resync-required` without candidate application; invalid snapshots leave that state unchanged. Before initialization, incremental calls likewise require a snapshot. Duplicate/replayed change sets are never silently reapplied. Results do not throw for ordinary invalid scene input; disposed-service operations return a terminal `disposed` result.
6. Accepted input is copied into renderer-owned CPU storage. Later caller mutation cannot alter it. Render submission can lag accepted revisions, and multiple accepted updates before one RAF coalesce. Track accepted scene revision separately from submitted scene/frame revision and device generation; do not advance a submitted marker when encode/submit fails.
7. The core-to-backend packet proposal is synchronous CPU-owned frame data: scene identity/revision, camera/surface revision, ordered adjacent draw ranges, logical resource IDs/revisions and typed byte ranges for instance/style updates. Packets contain no DOM, GPU handles, editor commands or mutable document references. The backend consumes/copies required bytes before returning; subsequent core mutation must not affect queued native work. Only the backend resolves logical resources to generation-owned allocations. Old-generation work cannot acknowledge new-generation uploads.
8. The backend receives a complete reconstruction description on a new generation; later packets can be incremental. Dirty revisions are acknowledged only after successful current-generation upload/submission. Concurrent accepted edits during recovery are retained and the first recoverable frame uses the latest accepted state; stale callbacks cannot clear their dirty markers. Disposal releases service CPU caches and backend ownership once.

#### Approved exported scene synchronization surface

P1.1 implements these exact types in `packages/contracts/src/scene.ts`. These plain readonly types describe renderer input, not a durable document schema. `SceneAffine` is structurally compatible with the existing camera tuple without importing renderer-core into contracts. Unexpected fields and runtime values outside the declared types reject as `invalid-value`; runtime validation is required even for typed callers. No browser/GPU surface or renderer lifecycle replacement is added here. Host composition supplies the scene service separately from the existing concrete backend lifecycle.

```typescript
export type SceneAffine = readonly [number, number, number, number, number, number];
export type ScenePoint = Readonly<{ x: number; y: number }>;
export type SceneColor = Readonly<{ r: number; g: number; b: number; a: number }>;
export type SceneIdentity = Readonly<{ documentId: string; pageId: string }>;
export type SceneVersion = Readonly<{ identity: SceneIdentity; revision: number }>;
export type RenderCamera = Readonly<{ position: ScenePoint; zoom: number }>;
export type RenderCameraState = Readonly<{ camera: RenderCamera; revision: number }>;
export type CameraApplyResult =
  | Readonly<{ status: 'applied' | 'unchanged'; current: RenderCameraState }>
  | Readonly<{ status: 'invalid-camera'; reason: 'invalid-value' | 'revision-overflow' }>
  | Readonly<{ status: 'disposed' }>;
export type SceneStroke = Readonly<{ color: SceneColor; width: number }>;
export type PrimitiveStyle = Readonly<{
  fill: SceneColor | null;
  stroke: SceneStroke | null;
}>;
export type PrimitiveGeometry =
  | Readonly<{
      kind: 'rectangle';
      width: number;
      height: number;
      cornerRadii: readonly [number, number, number, number];
    }>
  | Readonly<{ kind: 'ellipse'; width: number; height: number }>
  | Readonly<{ kind: 'line'; start: ScenePoint; end: ScenePoint }>;
export type SceneNodeBase = Readonly<{
  id: string;
  parentId: string | null;
  transform: SceneAffine;
  visible: boolean;
  opacity: number;
}>;
export type RenderNodeSnapshot = SceneNodeBase &
  (
    | Readonly<{ kind: 'primitive'; geometry: PrimitiveGeometry; style: PrimitiveStyle }>
    | Readonly<{ kind: 'container'; children: readonly string[] }>
  );
export type RenderSceneSnapshot = SceneVersion &
  Readonly<{ nodes: readonly RenderNodeSnapshot[]; rootOrder: readonly string[] }>;
export type RenderChildOrder = Readonly<{
  parentId: string | null;
  children: readonly string[];
}>;
export type RenderChangeSet = SceneVersion &
  Readonly<{
    baseRevision: number;
    inserted: readonly RenderNodeSnapshot[];
    updated: readonly RenderNodeSnapshot[];
    removed: readonly string[];
    orders: readonly RenderChildOrder[];
  }>;
export type SceneSynchronizationState = Readonly<{
  status: 'awaiting-snapshot' | 'synchronized' | 'resync-required' | 'disposed';
  current: SceneVersion | null;
}>;
export type SceneRejectionReason =
  | 'invalid-value'
  | 'duplicate-id'
  | 'unknown-node'
  | 'invalid-parent'
  | 'cycle'
  | 'invalid-order'
  | 'conflicting-operation'
  | 'unsupported-feature'
  | 'stale-snapshot'
  | 'revision-conflict';
export type SceneApplyResult =
  | Readonly<{ status: 'applied' | 'replayed'; current: SceneVersion }>
  | Readonly<{
      status: 'invalid-scene';
      reason: SceneRejectionReason;
      current: SceneVersion | null;
    }>
  | Readonly<{ status: 'resync-required'; current: SceneVersion | null }>
  | Readonly<{ status: 'disposed' }>;
export interface RendererSceneSynchronization {
  replaceSnapshot(snapshot: RenderSceneSnapshot): SceneApplyResult;
  applyChanges(changes: RenderChangeSet): SceneApplyResult;
  getSynchronizationState(): SceneSynchronizationState;
  setCamera(camera: RenderCamera): CameraApplyResult;
  getCameraState(): RenderCameraState | null;
  dispose(): void;
}
```

All methods are synchronous CPU operations; success means accepted mirror publication, not GPU completion/presentation. Root membership is `parentId: null`. Rectangle/ellipse local bounds start at `(0,0)`; translation belongs to the affine transform. Lines require `style.fill: null`; other fill input rejects as `unsupported-feature`. Missing fill/stroke is explicitly `null`. Container opacity is present in the input and must be exactly 1 in P1. Arrays and nested objects returned by queries/results are detached immutable values. Disposed query state has `current: null`; repeated disposal is harmless.

Camera state starts at document position `(0,0)`, zoom 1, camera revision 0. `setCamera` accepts only finite position and finite strictly positive zoom with exactly the declared fields; validation failure preserves state and pending work. Equal numeric values return `unchanged` with no revision/invalidation; a changed camera increments its own safe-integer revision once, or rejects `revision-overflow` without mutation. It is valid before a scene snapshot and requests coalesced viewport invalidation, which must not submit until the backend and scene are ready. It never changes scene identity/revision or marks geometry dirty. A precision rebase can mark transform ranges only under the separately frozen A02/A05 budget. Snapshot replacement, including document/page switches, preserves transient camera state until the host explicitly changes it. `getCameraState` returns an immutable detached snapshot or `null` after disposal; `setCamera` after disposal returns `disposed`.

CSS surface size and DPR remain inputs to the existing concrete backend resize/lifecycle path, not duplicated fields in `RenderCamera`. The single composition owner supplies validated surface state/revision to the core's private packet preparation seam. Camera revision, surface revision, accepted scene revision and submitted frame/device generation are distinct; a frame records which values it consumes. DOM event coordinates are normalized by the host to canvas-local CSS coordinates, then converted using the existing numeric camera convention. This API adds pan/zoom input without introducing DOM types or claiming hardware pointer-event timing.

Apply node operations to a candidate first, then order replacements. A container insert/update already carries its full child order; an `orders` entry for the same container in that transaction is a `conflicting-operation`, even if equal. A root order replacement uses `parentId: null`; absent orders preserve existing order. Removing/reparenting nodes requires explicit affected orders unless the parent's full replacement supplies them. All final graph consistency checks still apply.

Validation precedence is deterministic: terminal disposal; input shape/numeric validity (except incremental calls already requiring resync); identity/base synchronization; duplicate/conflicting operations; unknown node references; parent validity; cycles; order consistency; supported visual behavior. Within a category report the first field/node in a documented stable field order and lexicographic node-ID order. Exact failure fixtures are frozen in the P1.0b companion; they must not add new public result variants without review.

### D2 — approved P1 visual behavior

**Approved by the user on 2026-09-09:** these visible color/opacity semantics are recorded in the owning graphics architecture. This approval does not add isolated container composition to P1.

- Use normalized straight-alpha sRGB input colors. Configure canvas `colorSpace: 'srgb'`, `alphaMode: 'premultiplied'`, and the preferred non-sRGB `bgra8unorm` or `rgba8unorm` target/view; do not use an `*-srgb` render attachment/view. The shader outputs encoded-sRGB premultiplied values, with blend factors `one` / `one-minus-src-alpha` for color and alpha. Document this choice explicitly rather than accidentally claiming linear-light compositing. For each local contribution, analytic edge coverage multiplies both premultiplied RGB and alpha before local composition. A future linear-light policy would be a visible behavior change, not a shader optimization.
- Primitive opacity applies once to the combined fill/stroke result. Let F and S be coverage-adjusted premultiplied fill and stroke RGBA. Compose stroke over fill as L = S + F * (1 - S.a), then multiply all four components by node opacity to produce P. Framebuffer source-over is P + destination * (1 - P.a). A line has F = 0. Coverage and color alpha enter F/S; node opacity enters only P. The backend may use analytic local composition but must not simulate this by blending fill and stroke separately with node opacity. Solid style colors have their own alpha. Stroke width is nonnegative local geometry units: construct the local-space stroke outline, then transform that entire outline by the node affine matrix. Nonuniform scale/shear therefore changes its screen-space width; this is not a constant-screen-width stroke.
- For P1, structural containers must have opacity 1; non-unit container opacity is rejected atomically as unsupported, never approximated by multiplying descendant alpha. The proposed eventual behavior is isolated group composition, requiring a later owning design/plan before support. This is a P1 validation boundary, not removal of the MVP opacity requirement. Supporting isolated container opacity in P1 would require a new user-approved scope and work-breakdown revision.
- Rectangles use nonnegative width/height and four nonnegative circular corner radii in top-left, top-right, bottom-right, bottom-left order. Apply one common radius scale `min(1, width/(tl+tr), width/(bl+br), height/(tl+bl), height/(tr+br))`, ignoring zero denominators. Ellipses use nonnegative width/height. Zero-area shapes produce no fragments. A simple line uses two local endpoints, centered solid stroke and butt caps; coincident endpoints produce no fragments. Other cap/join/dash/arrow behavior remains in the roadmap's later coverage, not an inferred P1 implementation.
- Singular local/world transforms are valid scene data and skip the entire primitive, including its stroke; inverse-dependent queries report failure. Nonfinite inputs are rejected before acceptance. No silent clamping of opacity/color channels outside `[0,1]`, negative dimensions/radii/stroke width, or unrepresentable transformed bounds.

### D3 — measurement gate retained, not revised

The roadmap still requires **pointer-to-present p95 < 50 ms**. No current fixture proves that endpoint. The [existing feasibility investigation](../evidence/p0-6-measurement-feasibility-2026-09-09.md#presentation-candidates-and-limits) is evidence of an unresolved method, not a new measurement on P1.

Retain this gate as **UNVERIFIED**. The user-approved [D4 entry/exit separation](#d4-approved-entryexit-separation) permits P1.0b and then P1.1-P1.5 while measurement methods remain unresolved. P1.6 still requires executable, prospectively accepted methods. P1 cannot pass or authorize P2 until the actual required evidence exists or the user explicitly approves a prospective acceptance revision. No external tool installation or timing substitution is authorized by D4. In particular, `framesPresented`, RAF callbacks, screenshots and queue completion do not satisfy it.

At P1.0m, prepare either a separately approved bounded instrumentation proof of concept with content/frame and clock correlation, or an explicit change to the owning roadmap before a successor timing scenario. Keep any pointer-dispatch-to-submission/queue-completion measurements separately named and diagnostic. Synthetic input also does not prove hardware input latency. There is no need to choose or fund instrumentation to review D1/D2 now.

## Numeric and visual fixture contract

The [P1.0b private contract](p1-private-contract.md) freezes literal fixture data, CPU-to-GPU byte layouts, ownership/receipt rules and the precision/rebase budget before workers start. The following bounds are **P1 acceptance coverage**, not global product limits or a change to the P0 camera API.

- Quality envelope: document/camera translation through ±1e9, primitive dimensions 0 through 4096, zoom 0.01 through 64 and DPR 1, 1.5, 2. Include positive/negative large origins, fractional translations, rotations 0/15/45/90 degrees, nonuniform scale 0.5/2 and shear 0.25. Arithmetic that becomes nonfinite rejects the candidate explicitly. Finite scenes outside tested quality coverage receive no P1 precision claim.
- Compute world composition in Float64 and subtract the camera origin before Float32 conversion; never cast large world translations to Float32 and subtract afterward. Camera-only changes update camera/projection state, not primitive geometry. A precision rebase may repack transform fields when necessary; record that as transform upload and preserve the one-node steady-drag invariant. The P1.0b companion freezes the anchor, trigger/hysteresis, error budget and maximum per-rebase transform upload range for A02/A05 before code; naive per-pan full instance repacking is not an accepted substitute.
- Unit coordinate comparisons use independently calculated Float64 expected points, absolute error ≤ `1e-5` CSS px within the fixture corpus. GPU packing reconstruction error for visible points within the viewport plus a two-physical-pixel guard band must be ≤ 0.25 physical pixel, tested independently of the implementation's matrix helpers. This defines P1 instance-position precision only; it does not redefine P2/P3 path flattening tolerance.
- Visual fixtures use a fixed 640x360 CSS surface, defined clear colors, literal shape data and DPR 1/1.5/2. Compare interior/exterior sample RGBA values to an independent scalar analytic source-over oracle, tolerance 2 per 8-bit channel at points at least two physical pixels from any edge. Geometry edge location must be within one physical pixel of the analytic contour. Preserve full PNGs and numeric sampled positions; Primary inspects edge artifacts separately. Do not use implementation-generated golden images as the sole oracle.
- Fixtures include asymmetric corner radii, radius normalization, narrow strokes, fill/stroke overlap at opacity 0.5, transparent red over blue and reversed order, hidden ancestors, touching viewport edges, negative/reflected transforms and degenerate geometry. Unsupported container opacity must be an explicit rejection fixture. Add 1x and 4x sampling evidence separately; no claim that one proves the other.

## Acceptance and evidence map

P1-A01 is PASS at the CPU scene-synchronization boundary with the P1.1 evidence below. P1-A09 and P1-A10 remain **UNVERIFIED — measurement methods unresolved**; P1-A02/A04 have P1.2 CPU evidence; A03/A05/A06/A07 are PARTIAL and A08 remains TODO. [P1.4 native-call and lifecycle evidence](../evidence/p1.4-integration-review-2026-09-12.md) extends A05-A07 at the unit boundary; it does not establish native GPU rendering, recovery images or performance acceptance.

| ID     | Required result                                                                                                                                                                                                                                                    | Evidence / owning task                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| P1-A01 | D1 atomic initialization/change/resync rules, identity/revisions, ownership and terminal disposal hold. Malformed graph fixtures never publish partial state.                                                                                                      | PASS: [P1.1 CPU corpus/review](../evidence/p1.1-scene-review-2026-09-12.md)                                    |
| P1-A02 | Hierarchical world transforms, conservative stroke-aware bounds, hidden ancestry and stable paint order match an independent CPU oracle; supported precision fixtures pass.                                                                                        | PASS at CPU boundary: [P1.2 review](../evidence/p1.2-packet-review-2026-09-12.md)                              |
| P1-A03 | Rectangles, independent radii, ellipses and simple lines satisfy D2, overlap order and declared numeric/visual tolerances in Chrome and Edge.                                                                                                                      | PARTIAL: [P1.3 component review](../evidence/p1.3-analytic-review-2026-09-12.md); headed P1.5 evidence pending |
| P1-A04 | Culling omits only conservatively outside nodes and preserves relative order of all visible nodes. Reparent/transform/style/removal update only affected derived state.                                                                                            | PASS at CPU boundary: [P1.2 review](../evidence/p1.2-packet-review-2026-09-12.md)                              |
| P1-A05 | Shared unit geometry is reused; color/opacity edits rebuild zero geometry. A warmed isolated transform edit rebuilds zero geometry, uploads no unrelated instance/style records and never uploads a full scene buffer. Camera-only geometry rebuild count is zero. | Actual write ranges and rebuild spies, headed counters and scene 4 raw records; P1.2/P1.4/P1.7                 |
| P1-A06 | Ordered adjacent batching preserves D2 overlap output. No new shader/pipeline during warmed unchanged frames. Exactly one scheduler/device lifetime owner exists.                                                                                                  | Packet contract, backend calls, headed overlap evidence; P1.4/P1.5                                             |
| P1-A07 | Loss rebuilds latest accepted mirror; edits while recovering survive; no stale submission/acknowledgment or premature allocation reuse. Partial failures and dispose release owned resources.                                                                      | Delayed native doubles + headed recovery snapshots/images/counters; P1.4/P1.5                                  |
| P1-A08 | All three timed workloads meet unchanged roadmap ceilings in every accepted repetition, with complete clean-source metadata/raw samples.                                                                                                                           | Immutable production records and Primary review; P1.7                                                          |
| P1-A09 | Peak simultaneous combined working memory for 10k scenes ≤ 256,000,000 bytes, with the categories below present and overlap demonstrated.                                                                                                                          | CPU inventory/heap method plus actual GPU accounting, per-phase snapshots; P1.6/P1.7                           |
| P1-A10 | Pointer-to-present p95 < 50 ms with a validated event/clock/content-correlation method.                                                                                                                                                                            | Method approval if needed, raw correlated observations; P1.6/P1.7; currently UNVERIFIED                        |

Run `pnpm check` and `pnpm build` for every implementation checkpoint; use root `pnpm test:unit` for scoped deterministic iterations. `pnpm test:browser` remains the integration regression command. P1.5 must add explicitly scoped P1 headed coverage behind the existing root `pnpm test:gpu` command without overwriting P0 records. P1.6 implements the prospectively frozen new root `pnpm benchmark:p1` command; **it does not exist yet** and cannot be listed as executed validation. GPU/performance evidence must identify actual test names, browser versions, measured source, artifact paths and command flags.

## Benchmark specification and remaining freeze work

The [P1 measurement readiness contract](p1-measurement-contract.md) owns the exact four workload formulas, scene identities, fixed 1032-visible population, reference sampling and frozen frame-interval definition, memory accounting investigation and bounded presentation-instrumentation proposal. It preserves the roadmap's numeric thresholds. P1.0m is PARTIAL: workload arithmetic and the A08 endpoint are fixed, while A09/A10 evidence methods remain unresolved. Under approved D4, all methods must be executable before P1.6 starts; they no longer block P1.0b or P1.1-P1.5.

## Task graph, ownership and routing

Each row is an independently reviewable checkpoint unless marked as a subtask of the shared integration checkpoint. No worker starts behind an unmet predecessor. All estimates are relative engineering judgments, not promises of duration.

| Task  | Purpose / expected change scope                                                                                                                            | Predecessors                                  | Parallelism                                                                             | Difficulty / risk | Model / effort and reason                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| P1.0a | This design proposal, source comparison and review; docs only                                                                                              | Integrated P0                                 | Two independent read-only audits                                                        | High / medium     | Primary Astra high: cross-module meaning and approval boundaries           |
| P1.0m | Read-only measurement feasibility and exact workload/memory/event contract; separately approved experiments only if needed                                 | P1.0a                                         | Independent method analysis may overlap D1/D2 review; no product implementation         | High / high       | Primary Astra high: acceptance meaning and evidence feasibility            |
| P1.0b | Record approved D1/D2 in owning graphics design; freeze private packets, primitive literals and precision/rebase budget                                    | User D1/D2 and D4 approval                    | Single owner                                                                            | High / high       | Primary Astra high: public contract and project consistency                |
| P1.1  | Scene protocol/types, frozen private packet declarations and atomic retained mirror; `contracts/src/scene.ts`, `renderer-core/src/scene-*`, contract tests | P1.0b                                         | Sequential contract foundation                                                          | High / high       | Sol medium: candidate-graph validation, revisions and ownership            |
| P1.2  | Derived transforms/bounds/order/culling and dirty instance/style plan; core-local files/tests                                                              | P1.1                                          | Can overlap P1.3 with frozen packet layout                                              | High / medium     | Sol medium: precision, hierarchy and incremental invariants                |
| P1.3  | Unit geometry, analytic primitive shader/style packing and pipeline variants; new webgpu-local files/tests                                                 | P1.1                                          | Can overlap P1.2; no shared backend lifecycle edits                                     | High / high       | Sol medium: analytic edge/stroke/compositing correctness                   |
| P1.4  | Renderer service composition and native packet integration, upload/recovery/acknowledgment and accounting; shared backend/platform/export files            | P1.2, P1.3                                    | Single owner; serial integration                                                        | High / high       | Sol high with Primary review: async lifetime and broad regression exposure |
| P1.5  | Headed deterministic primitive/overlap/precision/recovery fixtures and independent oracles; tests/gpu and playground fixture                               | P1.4                                          | GPU runs serial across browsers; fixture implementation may use Terra under frozen spec | Medium / medium   | Terra medium: bounded fixture work; Primary visual/acceptance review       |
| P1.6  | Implement the frozen P1.0m workload/memory/event contract; benchmark runner/schema/fixtures                                                                | P1.0m, P1.4                                   | Can overlap P1.5 only with distinct playground/fixture ownership; hardware runs serial  | High / medium     | Sol medium: approved measurement implementation; Primary reviews semantics |
| P1.7  | Production reference runs, raw artifact capture, complete A01-A10 review and PR evidence                                                                   | P1.5, P1.6, all measurement blockers resolved | Serial hardware runs                                                                    | Medium / high     | Luna low: commands/collection; Primary Astra high: interpretation and gate |

```text
P0 integrated -> P1.0a
P1.0a -> user D1/D2 approval -> P1.0b
P1.0a -> P1.0m measurement resolution
P1.0b -> P1.1 -> { P1.2, P1.3 } -> P1.4
P1.4 -> P1.5
{ P1.0m, P1.4 } -> P1.6
{ P1.5, P1.6, all A01-A10 evidence } -> P1.7 -> P2 entry
```

Minimum topology: one Primary supervisor, one implementation worker by default, two implementation workers only during independent P1.2/P1.3. Use a Luna command worker only when it frees the Primary for useful independent review. No fixed extra architecture/test agents, recursive delegation or concurrent GPU runs. Shared exports, scene/packet contracts and lifecycle files have one named owner per batch.

## Next batch and implementation entry

1. D1/D2 and D4 approval are recorded. Continue P1.0m measurement/configuration readiness independently; external tools or a change to acceptance semantics require a separate concrete user decision. Missing measurement evidence continues to block P1.6/P1.7 and P2 entry. Report unresolved methods instead of rerunning P0 proxies.
2. P1.0b private contract freeze and P1.1 CPU mirror/type foundation are integrated. [PR #31](https://github.com/npclown/vector-studio/pull/31) merged P1.1 as `355d03f`; required CI passed and its integrated tree matched the reviewed source.
3. P1.2 integrated through [PR #32](https://github.com/npclown/vector-studio/pull/32); P1.3 integrated through [PR #33](https://github.com/npclown/vector-studio/pull/33) as `8682663`. Primary retains shared exports and contract ownership.
4. P1.4 is complete locally with [unit-level integration evidence](../evidence/p1.4-integration-review-2026-09-12.md). After protected PR integration, P1.5 is the next executable checkpoint: headed deterministic primitive, overlap, precision and recovery fixtures. P1.6 remains blocked on executable P1.0m methods.

D4 changes execution order only. D1/D2 alone did not authorize this entry change; the separate 2026-09-12 user approval does. A09/A10 and the complete P1 exit gate are unchanged.

## Checkpoint evidence and status

P1.0a draft created on `codex/p1-0-execution-plan`. The Primary selected this checkpoint from the accepted roadmap after verifying clean, current P0 integration. Actual review delegation: existing Terra medium worker for code seams/gaps and existing Sol medium worker for contract and measurement risks; read-only, no additional delegation. Primary owns all document edits and approval proposals.

Primary source review corrected the draft's claim that the existing backend already owns submission serials, clarified local-space affine strokes and the task DAG, and added the exact proposed public synchronization and camera surface, including independent camera revisions and coalesced viewport invalidation. Critical review moved unresolved measurement contracts ahead of all implementation, closed same-identity snapshot replay/rollback and container-opacity validation gaps, and fixed the encoded-sRGB target and local fill/stroke/opacity formula. At that initial review, no proposal was promoted to an accepted architecture decision; the later user approval is recorded below.

Local validation on 2026-09-09:

- `pnpm exec prettier --check --ignore-path .gitignore docs/plans/p1-instanced-primitives.md docs/plans/p0-webgpu-foundation.md docs/prototype-plan.md` — PASS for all three changed Markdown files.
- Repository local-link/anchor script from `docs/evidence/docs-review-2026-09-05.md`, executed with `node --input-type=module` — PASS: 192 local links/anchors across 55 Markdown files.
- `git diff --check`, changed/untracked path inventory and source-of-truth review — PASS: only the three scoped plan/roadmap Markdown files; no product, dependency, historical observation or machine-local artifact changes.
- `git diff --quiet 7fe629af285cb30034914942ed516ad95f52c27a 28181b7dbc1af586430d05458cdf91f363efa8f6` and `gh pr view 25 --json number,state,mergedAt,mergeCommit,statusCheckRollup` — PASS: P0 reviewed/squashed trees match and its required CI/integration succeeded. This is provenance verification, not a new runtime test.
- Local unit/build/browser/GPU/benchmark commands — NOT RUN: this is a documentation-only proposal with no new runtime/performance claim. Required remote static/unit/build CI applies to the draft PR; do not infer its result before it completes.

The initial draft above was reviewed before approval. On 2026-09-09 the user explicitly approved D1/D2. P1.0a contract review is complete; P1.0m measurement preparation follows in the [measurement readiness contract](p1-measurement-contract.md). P1.0b and every implementation task remain unstarted. The approved design checkpoint does not imply that P1 is implementation-ready or its exit gate passes.

## P1.0m acquisition checkpoint: 2026-09-12

The [bounded PresentMon attempt](../evidence/p1.0m/20260912-presentmon-access/README.md) was blocked by Windows ETW privileges before CSV acquisition. No Edge attempt, automatic elevation, performance acceptance or product implementation followed. The prepared test-only fixture and original failed evidence cross this investigation checkpoint; the next external action requires one-time elevated PresentMon authorization. A09 memory and A10 display correlation remain unresolved; P1.0b and P1.1 remain unstarted.

The user subsequently approved the PresentMon-only elevation. The [elevated retry review](../evidence/p1.0m/20260912-presentmon-elevated/README.md) establishes one bounded Chrome acquisition under its actual default CSV schema; Edge UAC was canceled before process creation. Both outcomes and a preceding prelaunch tooling failure are preserved. A09/A10 remain UNVERIFIED; no P1 implementation entry or performance acceptance follows. Continue P1.0m method analysis; a new Edge consent request requires a new user instruction.

<a id="d4-proposed-entryexit-separation-pending-user-decision"></a>

## D4: approved entry/exit separation

Status: **APPROVED by the user on 2026-09-12 in response to the explicit D4 approval question following PR #29.**

The [2026-09-12 method assessment](../evidence/p1.0m-method-assessment-2026-09-12.md) identifies conditional memory bounds, two missing presentation-identity joins and unresolved endpoint provenance. The user approved separating implementation entry from measurement-method completion to allow implementation of the approved D1/D2 design while accepting possible rework. Approval changes execution policy, not measurement semantics.

The approved decision is:

1. Keep approved D1/D2 and all P1-A01 through A10 behavior, thresholds and required evidence unchanged. A09 remains simultaneous combined peak <= 256,000,000 bytes; A10 remains pointer-to-present p95 < 50 ms. Neither proxies nor missing evidence can pass these gates.
2. Allow P1.0b private packet, literals, precision/rebase and validation-contract freeze to proceed while P1.0m is unresolved. P1.0b still must complete before P1.1; implementation workers cannot invent shared contracts.
3. Permit P1.1 through P1.5 in their existing order and scope after that freeze. P1.2/P1.3 can overlap only with independent files; P1.4 remains a single-owner integration task. Every checkpoint retains its local correctness/review/PR gates and is labeled partial P1 progress.
4. Continue P1.0m independently. P1.6 still requires P1.4 and executable, prospectively accepted measurement methods. P1.7 still requires P1.5, P1.6 and all acceptance evidence. P1 completion and P2 entry remain blocked until the full P1 gate passes or a separate explicit prospective decision changes it.
5. Do not authorize further UAC/captures, a browser fork, new dependencies, optical hardware or a change to public API/product scope. Those require their own concrete decisions where applicable.

Approved dependency delta: remove only `P1.0m -> P1.0b`; preserve `P1.0m -> P1.6 -> P1.7` and every implementation/exit dependency. This plan's D3/entry text, the measurement contract's entry status and the roadmap's current-position statement are updated together. Requirements and benchmark semantics are unchanged.

The alternative of retaining the implementation entry block was not selected. New measurement experiments retain their separate authorization boundaries.

## P1.0b checkpoint: 2026-09-12

The user approved D4 after PR #29. Primary completed the [private packet and fixture freeze](p1-private-contract.md): stable slots/order indirection, byte layouts and callable seam, shared arena ownership, identity-token receipts, origin/hysteresis/upload budget, numeric/visual literals and S01-S09 atomic failure precedence. Approved public D1/D2 types/behavior are unchanged. [Review and reproducible scalar checks](../evidence/p1.0b-contract-review-2026-09-12.md) record limitations and Primary dispositions. One Sol medium agent performed independent read-only review; no further delegation.

Local validation:

- `pnpm exec prettier --check --ignore-path .gitignore docs/graphics-engine-architecture.md docs/prototype-plan.md docs/plans/p1-instanced-primitives.md docs/plans/p1-measurement-contract.md docs/plans/p1-private-contract.md docs/evidence/p1.0b-contract-review-2026-09-12.md` — PASS: six scoped Markdown files.
- `node --input-type=module` with the review record's scalar script — PASS: 62,360 coordinate components; max simulated error 0.03998337851953693 physical pixel, quantization 0.022342012031003833, arithmetic/projection 0.028309672139585018. This is numeric feasibility only, not shader/continuous-contour acceptance.
- `node --input-type=module` with the documented heading/HTML-anchor link check — PASS: 248 local links/anchors across 61 Markdown files, including the preserved historical D4 proposal anchor.
- `git diff --check` and scoped path/ownership review — PASS: six Markdown files only; no product, dependency, historical result or machine-local artifact edits.
- Local product unit/build/browser/GPU/benchmark commands — NOT RUN: documentation-only freeze; required remote static/unit/build CI is tracked on the checkpoint PR.

P1.0b is complete as a design checkpoint, with runtime validation obligations assigned to P1.1-P1.5. Next task is P1.1 with one Sol medium implementation worker and Primary review, after this scoped PR integrates. P1.0m remains PARTIAL; A09/A10 remain UNVERIFIED, and no P1 exit or P2 entry is claimed.

## P1.1 checkpoint: 2026-09-12

P1.1 is complete locally: exact D1 scene exports, atomic retained mirror, deterministic candidate validation, immutable copy ownership, independent camera state, shared Float64 numeric validation and private packet declarations. [Review, source mapping and validation evidence](../evidence/p1.1-scene-review-2026-09-12.md) cover S01-S09 and independent numeric/transaction fixtures. Primary corrected overflow-sentinel and global rejection-precedence issues, reviewed Map/callback ownership, and verified the frozen type shapes.

Actual delegation: Sol medium for implementation/protocol tests, Luna low for sequential root validation, Primary for packet declarations, independent tests, integration and review. No additional delegation.

- `pnpm check` — PASS: formatting, lint, TypeScript, 126 tests across 16 files, package boundaries.
- `pnpm build` — PASS: three library packages and playground production build (25 modules).
- Explicit Markdown Prettier check — PASS for all five changed Markdown files; exact command in the review.
- `node --input-type=module` with the documented link check — PASS: 255 local links/anchors across 62 Markdown files.
- `git diff --check` — PASS; scoped source/dependency/artifact review complete.
- Browser/GPU/benchmark commands — NOT RUN: CPU/type-only P1.1; no backend integration or performance claim.

P1-A01 passes at its CPU boundary. P1.2/P1.3 can start after this PR integrates; P1.4 remains the single-owner integration task. P1.0m and A09/A10 remain unresolved under unchanged D4 exit policy.

## P1.2 checkpoint: 2026-09-12

P1.2 implements cached hierarchy/bounds, guarded culling and stable paint order, slot/record packing, bounded receipt ownership and reconstruction. [Primary review and evidence](../evidence/p1.2-packet-review-2026-09-12.md) explain the fixed-vertex continuous precision model and independent tests. Public D1 and packet v1 types are unchanged. Sol medium implemented core-local behavior; Primary owned epoch/export wiring, final numeric proof/model and independent regressions; Luna low ran root validation. No recursive delegation.

P1-A02/A04 have CPU evidence. N04/S4 uses 10,000 nodes, asserts 1,032 visible and exactly one 32-byte transform write after warming, with zero geometry/style/order writes. This is structural unit evidence, not a native upload or performance result. A05 remains PARTIAL until P1.4/P1.7. P1.3 is developed on an isolated branch; P1.4 requires both checkpoint integrations. A09/A10 remain UNVERIFIED.

- `pnpm check` — PASS: formatting, lint, TypeScript, 144 tests across 20 files and package boundaries.
- `pnpm build` — PASS: all three libraries and playground production build (27 modules).
- Browser/GPU/benchmark commands — NOT RUN: CPU packet checkpoint only.
- `pnpm exec prettier --check --ignore-path .gitignore docs/plans/p1-instanced-primitives.md docs/evidence/p1.2-packet-review-2026-09-12.md` — PASS: both changed Markdown files.
- Heading/HTML-anchor link checker from the P1.0b review — PASS: 257 local links/anchors across 63 Markdown files.
- `git diff --check` and scope/type/dependency review — PASS: unchanged public scene and packet v1 declarations; no backend lifecycle, dependency or historical artifact changes.

## P1.3 checkpoint: 2026-09-12

P1.3 is complete locally on its isolated branch: shared unit quad, packet binding descriptors, analytic WGSL and exact existing-cache pipeline variants. [Primary review and component evidence](../evidence/p1.3-analytic-review-2026-09-12.md) distinguish production descriptor tests from independent scalar/f32 references. Sol medium implemented and validated; Primary corrected ellipse/rounded-corner and derivative-control-flow issues and reviewed the numeric handoff. No recursive delegation.

- `pnpm check` — PASS: formatting, lint, TypeScript, 135 tests across 17 files and package boundaries.
- `pnpm build` — PASS: library packages and playground production build.
- `pnpm test:unit tests/unit/primitive-analytic.test.ts` — PASS: 9 component/reference tests.
- `git diff --check` — PASS; no lifecycle, dependency, manifest or lockfile changes.
- Browser/GPU/benchmark commands — NOT RUN: native consumption remains P1.4 and headed shader/visual acceptance remains P1.5.

P1-A03 is PARTIAL, not a native-rendering PASS. P1.4 starts only after both P1.2 and P1.3 integrate. A09/A10 remain UNVERIFIED under D4.

## P1.4 checkpoint: 2026-09-12

Entry: clean `main` at `868266350d36118532ee062e27a303b204508ef0`, equal to fetched `origin/main`. Work branch: `codex/p1-4-native-integration`. This checkpoint implements the existing private contract; it does not change public D1, D2, packet v1, measurement methods or thresholds.

Required local evidence before completion:

- B01 verifies actual logical-to-arena binding/write offsets and capacities, ordered draws and preflight rejection before any write.
- N03/N04 verify native write ranges for rebase and warmed isolated edits, including unchanged shared geometry and cached pipelines.
- L01 verifies later edits survive older receipts, edits during recovery rebuild from the latest mirror, and old-generation completions cannot publish or reclaim new resources.
- L02 verifies queue-ordered logical-slot reuse, retirement after the last submitted use, old/new arena accounting overlap, partial-write retries and terminal disposal during pending creation.
- Renderer service composition uses one existing backend scheduler/device lifetime; existing P0 unit lifecycle and native-double fixtures remain regression tests.
- Root `pnpm check`, `pnpm build`, changed-Markdown formatting/link checks and Primary scope/ownership review must pass. Required remote CI remains a separate protected PR gate.

Headed browser/GPU images and actual recovery output remain P1.5. These native-call doubles do not establish P1-A03/A06/A07 in full or the P1 exit gate. P1.6 still requires executable P1.0m measurement methods.

Local completion evidence: [P1.4 integration review](../evidence/p1.4-integration-review-2026-09-12.md). One Sol high implementation owner and Primary independent review/fixtures completed the service/native integration without changing D1/D2 or packet v1. Luna low ran `pnpm check` — PASS: 172 tests in 24 files, formatting, lint, TypeScript and boundaries — and `pnpm build` — PASS: all libraries and playground. The three new targeted fixture files contain 19 tests. Existing P0 unit/native-double regression tests remain passing. No browser/GPU/benchmark run or P1 exit claim is made; required remote CI is a separate protected PR gate.

P1.3 combined validation after incorporating P1.2 main `c878b54`: Luna low ran `pnpm check` (PASS: 153 tests, 21 files, all static/boundary checks) and `pnpm build` (PASS: all libraries/playground). Primary resolved the plan-only append conflict and preserved both checkpoint records; product sources had no conflict. Final explicit Markdown formatting passed three files; the heading/HTML-anchor checker passed 263 local links/anchors across 64 Markdown files. `git diff --check` and final source/scope review passed. This combined validation supersedes the isolated-base unit count above for PR integration, without adding native GPU or performance claims.
