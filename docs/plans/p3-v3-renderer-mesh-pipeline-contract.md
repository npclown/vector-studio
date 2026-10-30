# P3 V3 renderer mesh pipeline contract: fill only, untiled carrier K4

**Direction.** `renderer-core` consumes the `FillMeshPort` v0 that [V1](p3-v1-path-scene-port-proposal.md) fixed and [V2](p3-v2-fill-mesh-transport-contract.md) implements. It owns a CPU mesh cache and a separate failure memo, derives an A5 coverage fringe for each mesh, and adds an optional mesh part to the unchanged P1 packet, whose mesh draws interleave with P1 analytic draws in paint order. `renderer-webgpu` draws each path mesh with one non-indexed, vertex-pulling draw that evaluates the [O02 coverage rule](p3-o02-a5-coverage-contract.md#coverage-rule-q2-q3) per pixel. Nothing here changes the port, the package boundaries or the [ADR 0002](../decisions/0002-path-scene-and-fill-mesh-port.md) direction.

Status: APPROVED by the user on 2026-10-12, in chat, after independent review rounds 1-3 (round 3 READY); see the [review record](#review-record). It is D8 checkpoint V3 ([D8](p3-d8-parallel-tracks.md)), full tier, fill only, on the untiled carrier K4. It is full tier because it lands the path node in the public scene contract, adds a public diagnostic code and fixes the draw contract. It is documentation only. The user answered the three choices in section [n](#n-decisions-for-the-user) with the recommended option each; everything else is a Primary technical decision, stated with its reason. It is one frozen contract implemented in three ordered units (section [o](#o-implementation-units)).

**Evidence label.** Every V3 result is functional evidence. Until checkpoint B4 has A04 evidence, every V3 report, PR description, test title for a headed check and screenshot states that precision is **UNVERIFIED** against the 0.25 physical-pixel target, as D8 [requires](p3-d8-parallel-tracks.md#rules). V3 also claims no Q4 coverage threshold: the O02 PASS applies to O02's host-built screen-space realization, not to this one. V3 closes no A01-A08 criterion.

## Scope

V3 covers the nine items V1 [section f](p3-v1-path-scene-port-proposal.md#f-items-v2-and-v3-inherit) assigns to it, plus the two items V2 [section l](p3-v2-fill-mesh-transport-contract.md#l-c04-items-1-6-what-v0-fixes-and-leaves-open) passes on:

| Inherited item                                                     | Section here                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| V1 1. Path node, validation table, replay equality, port input     | [a](#a-path-node-landing-and-scene-validation)               |
| V1 2. Geometry revision and cache key                              | [b](#b-port-consumption-geometry-revision-and-cache-key)     |
| V1 3. Cache accounting, eviction, failure handling                 | [d](#d-mesh-cache-failure-memo-and-their-bounds)             |
| V1 4. Exponent guards and reuse rule                               | [c](#c-tolerance-and-fringe-buckets)                         |
| V1 5. Packet layout, mesh origin (U3), Float32 conversion          | [f](#f-the-mesh-packet-part-and-the-mesh-draw)               |
| V1 6. A5 coverage on K4 and the O02 adoption decision              | [e](#e-a5-coverage-on-k4) and [n](#n-decisions-for-the-user) |
| V1 7. Paint order interleaved with primitives                      | [g](#g-paint-order-and-composition)                          |
| V1 8. D8-interim failure outcome (V1-Q4)                           | [h](#h-d8-interim-failure-outcome)                           |
| V1 9. Device-loss rebuild from CPU meshes                          | [i](#i-device-loss-generation-and-lifetime)                  |
| V2 l. Isolate a path that makes the kernel return `INTERNAL_ERROR` | [b](#b-port-consumption-geometry-revision-and-cache-key)     |
| V2 l. Account for the fill instance's `linearMemoryBytes()`        | [d](#d-mesh-cache-failure-memo-and-their-bounds)             |

**Out of scope.** Stroke (B2). The K1 carrier and E1-E3 (R2). The C04 layout, which stays open; section [j](#j-c04-items-for-v3) lists what V3's functional packet fixes. Any position or clearance certificate (M01-M06). Coincident edges between separate meshes (O02 Q6). The playground path page (V4). Kernel internals, the fill-mesh export and the adapter (V2).

## Inputs this contract does not change

- **V1, as approved.** The path node shape, the port shape and rules 1-9, host injection, the consumption point, the cache key fields and the V1-Q4 outcome. Where V1 delegated a choice to V3, or where V3 reads a V1 sentence in a specific way, V3-C1 records it.
- **V2, as frozen.** The tolerance range, status mapping, conforming boundary edges, owned results and the non-disposing `internal-error`.
- **Requirements, thresholds and user decisions.** U1-U4, Q3-Q5, A5, Q12, K1, E1-E3, V1-Q1 to V1-Q4 and the [visible semantics](p3-visible-semantics-proposal.md). This contract's own decisions are numbered V3-Q1 to V3-Q3.
- **P1 contracts.** [D1](p1-instanced-primitives.md#d1--approved-scene-and-packet-contract) public shape and validation precedence, [D2](p1-instanced-primitives.md#d2--approved-p1-visual-behavior) composition, and the [P1.0b](p1-private-contract.md) packet v1 envelope, byte layouts, allocator, generation, receipt and origin rules. The P1 packet keeps `layoutVersion: 1` and every field; V3 adds one optional field that is absent for primitive-only scenes.
- **P2 ABI v1.**

## Source facts

| Fact                                                                                                                                         | Source                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The scene union has only `primitive` and `container` kinds                                                                                   | `packages/contracts/src/scene.ts:33-37`                                                                                                            |
| `RetainedSceneMirror` takes only `onInvalidate`                                                                                              | `packages/renderer-core/src/scene-mirror.ts:65-67`                                                                                                 |
| An unknown `kind` fails `copyNode` and becomes `invalid-value`; `unsupported` flags are reported last, after graph checks                    | `scene-validation.ts:166-174`, `:141`, `:206`, `:226`                                                                                              |
| Replay equality compares fields with `===` (so `-0` equals `+0`)                                                                             | `scene-validation.ts:438-453`, `:499-500`                                                                                                          |
| The service builds its own mirror and takes only an invalidation target                                                                      | `primitive-renderer-service.ts:31-35`                                                                                                              |
| The packet has `layoutVersion: 1`, five resource ids and one draw variant `analytic-v1`                                                      | `primitive-packet.ts:3`, `:26-45`                                                                                                                  |
| Receipts must list exactly the five resources; matching compares packet identity fields                                                      | `primitive-scene-source.ts:868-917`                                                                                                                |
| Preparation emits one analytic draw over the whole visible order stream                                                                      | `primitive-scene-source.ts:189-193`                                                                                                                |
| The primitive origin is `256·floor(camera/256)` with a 512-unit window and a 0.125 + 0.125 px budget check                                   | `primitive-scene-source.ts:313-353`, `:799-804`                                                                                                    |
| The backend binds one pipeline, then calls `drawIndexed(6, count, 0, 0, first)` per draw; analytic draws must be adjacent order ranges       | `native-primitive-scene.ts:313-319`, `:539-553`                                                                                                    |
| Device limits checked: four storage buffers per stage, one uniform, five bindings                                                            | `native-primitive-scene.ts:593-600`                                                                                                                |
| A throwing `prepare` is reported as `render.submission-failed`; submission failures map to `allocation.failed` or `render.submission-failed` | `webgpu-backend.ts:948-961`, `:1093-1099`                                                                                                          |
| The diagnostic channel lives in the backend; renderer-core has no emitter                                                                    | `webgpu-backend.ts:1183-1190`, `diagnostic-channel.ts`                                                                                             |
| Public diagnostic codes are a frozen object in contracts                                                                                     | `packages/contracts/src/diagnostics.ts:1-25`                                                                                                       |
| Vertex projection: `(A·local + t) + originMinusCamera`, times zoom and DPR, then NDC with y flipped                                          | `primitive-analytic-shader.ts:94-105`                                                                                                              |
| Blend is premultiplied `one / one-minus-src-alpha`; pipeline key fields                                                                      | `primitive-pipeline.ts:5-23`, `:46-58`                                                                                                             |
| P2's adapter takes `Math.log2` of a rounded `0.25/sigma`, then corrects with float comparisons of that rounded value                         | `packages/geometry-wasm/src/adapter.ts:886-954`                                                                                                    |
| O02's exact partition check is exported and takes BigInt points                                                                              | `tests/geometry/coverage-oracle/exterior.ts:29`, `:60`, `:779`                                                                                     |
| The graphics architecture says MSAA-only output is not sufficient for the final path renderer                                                | `docs/graphics-engine-architecture.md:219`                                                                                                         |
| V2: accepted exponents `-1021..=1023`; `internal-error` does not dispose; caller may split batches; `linearMemoryBytes()` outside the port   | V2 sections [d](p3-v2-fill-mesh-transport-contract.md#d-tolerance), [h](p3-v2-fill-mesh-transport-contract.md#h-typescript-adapter), a             |
| V2: `boundaryEdges` come from a conforming refinement; `bounds` are exact vertex bounds                                                      | V2 sections [f](p3-v2-fill-mesh-transport-contract.md#f-boundary-edges), [g](p3-v2-fill-mesh-transport-contract.md#g-positions-bounds-and-indices) |

Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md), at the V2 `boundaryEdges` row above: for fast-rung meshes, `boundaryEdges` are the edges used once in an unrefined conforming mesh (that contract's section 3.5); they are exactly the region-boundary edges, as before.

## a) Path node landing and scene validation

`packages/contracts/src/scene.ts` gains `ScenePathVerb`, `SceneFillRule`, `ScenePathGeometry`, `PathStyle` and the `path` member of `RenderNodeSnapshot`, exactly as V1 [section a](p3-v1-path-scene-port-proposal.md#a-path-node-in-the-scene-contract) sketches them.

**Port-presence input.** The mirror gains an options argument. The existing call `new RetainedSceneMirror()` keeps its meaning.

```ts
export type RetainedSceneMirrorOptions = Readonly<{ pathNodes: 'supported' | 'unsupported' }>;
// constructor(onInvalidate?: () => void, options?: RetainedSceneMirrorOptions)
// default: { pathNodes: 'unsupported' }
```

The value is fixed at construction, so replay equality and validation stay stable for the mirror's life. `PrimitiveRendererService` gains a second constructor argument:

```ts
export type PrimitiveRendererServiceOptions = Readonly<{
  fillMesh?: FillMeshPort;
  /** Host-supplied accounting hook, for example a V2 adapter's linearMemoryBytes. Not part of the port. */
  fillMeshMemoryBytes?: () => number;
}>;
```

It passes `pathNodes: 'supported'` exactly when a port is given. The service name stays; renaming it is churn outside V3.

**Port shape check.** At construction the service requires `portVersion === 0`, a nonempty string `operationId` and a callable `buildFillMeshes`, and throws `TypeError` otherwise. A malformed port is a host programming error, not scene input.

**Validation rows.** These refine V1's table. Path content is validated by `copyNode`, so it precedes graph checks; `unsupported-feature` stays last, as D1 precedence requires.

| Input                                                                                                                       | Result                      |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Fields other than exactly `id, parentId, transform, visible, opacity, kind, geometry, style`                                | `invalid-value`             |
| `geometry` fields other than exactly `kind, verbs, points, fillRule`; `kind !== 'path'`                                     | `invalid-value`             |
| A verb outside the four; grammar violation; `points.length` unequal to the verbs' sum; a nonfinite or non-number coordinate | `invalid-value`             |
| Missing or unknown `fillRule`                                                                                               | `invalid-value`             |
| `style` fields other than exactly `fill`; `fill` not `null` or a valid `SceneColor`                                         | `invalid-value`             |
| Nonfinite world transform, or nonfinite world bounds of the point box of a nonempty path                                    | `invalid-value` (P1's rule) |
| A path node while the mirror is `unsupported`                                                                               | `unsupported-feature`       |
| An empty path (no verbs, no points)                                                                                         | Accepted; draws nothing     |
| A path within the grammar that the kernel cannot mesh                                                                       | Accepted; section h         |

The world-bounds row is P1's arithmetic rule applied to the box of the path's points, which contains every cubic by the convex-hull property. It adds no kernel cap. An empty path has no points and so no bounds: it is exempt from the bounds row and from culling, and is never drawable.

**Owned copies.** Accepted `verbs` and `points` are copied into frozen arrays.

**Replay equality.** `nodeEquals` compares path nodes field by field with the existing `===` rule: `fillRule`, `verbs` and `points` elementwise, and `style.fill`. An identical replay at the same revision is `replayed`; a path difference at the same revision is `revision-conflict`.

Amended 2026-10-21 by [ST-U6](p3-fill-stroke-meshes.md#b2-st-u6-renderer-stroke) under the [B2 stroke contract section 5](p3-b2-stroke-contract.md#5-scene-field-and-validation) and its ST-A0 amendments (S3, S4), style rows:

- **`style` is exactly `fill, stroke`.** `PathStyle.stroke: PathStroke | null` is required and explicitly `null` when absent, so the row "`style` fields other than exactly `fill`" above now reads "other than exactly `fill, stroke`" (`invalid-value`). The stroke rows of B2 section 5 (shape, color, width, cap, join, miter limit, nonfinite world bounds of the stroke bounds box) refine this table in the same precedence.
- **Port presence.** `RetainedSceneMirrorOptions` gains `pathStrokes` (default `'unsupported'`) and `pathFills`, which takes the value of `pathNodes` when omitted, so `new RetainedSceneMirror(cb, { pathNodes: 'supported' })` keeps its meaning. The service passes `pathNodes: 'supported'` when a fill port, a stroke port or both are given (widening "exactly when a port is given" above to either port), `pathFills: 'supported'` exactly when a fill port is given, and `pathStrokes: 'supported'` exactly when a stroke port is given. A path with `fill !== null` while `pathFills` is `'unsupported'`, or with a stroke of `width > 0` while `pathStrokes` is `'unsupported'`, is `unsupported-feature` in the last slot. `pathFills` is the new mirror option that ST-A0 S4 asked this note to record.
- **Bounds.** The world-bounds row also applies to the stroke bounds box (B2 section 9.7, with `k = min(L, 2^24)` for miter joins), for a nonempty path with `width > 0`.
- **Replay equality** also compares every stroke field with `===`, color channels included. The geometry revision still covers `verbs` and `points` only.

## b) Port consumption, geometry revision and cache key

**Geometry revision.** The mirror owns a counter that starts at 1 and only increases. On every publication (`applyChanges`, `replaceSnapshot`, including an identity switch), each published path node gets:

- the resident node's revision, when a resident node with the same id is a path with `verbs` and `points` equal under the replay rule;
- otherwise the next counter value. This covers a new node, a node reinserted after removal, a kind change and any path-data change.

`fillRule` is not part of the revision; it is its own key field. `renderer-core` reads the revision through `RetainedSceneView.getGeometryRevision(id): number | undefined`; the scene contract never carries it.

**Overflow.** If publishing would need a value above `Number.MAX_SAFE_INTEGER`, the call returns `{ status: 'invalid-scene', reason: 'invalid-value', current }` with the previous version, and publishes nothing. No new public result variant is added. At one new revision per microsecond this needs about 285 years.

Because equality uses `===`, a `-0` to `+0` edit keeps the revision. The served mesh differs from a fresh one at most in signed zeros, which no later stage distinguishes.

**Cache key.** Exactly V1's: `(portVersion, operationId, nodeId, geometryRevision, fillRule, toleranceExponent)`. The service reads `portVersion` and `operationId` from the port at the start of every `prepare`. A changed `operationId` makes every key miss. A `portVersion` other than 0 at that point is the renderer state failure `port-version` (section h): the port is not called and no older-key mesh is served.

**Consumption order inside `prepare`.** Normative:

1. Read the scene, camera and target. Reconcile primitive slots and path slots.
2. Derive world transforms, visibility and conservative world bounds for primitives and paths.
3. A path is **drawable** when it is not hidden, `fill !== null`, it has at least one verb, its world linear map is nonsingular by the exact determinant (section c), and its world bounds meet the viewport plus P1's two-physical-pixel guard.
4. For each drawable path, compute the buckets `e` and `f` (section c), apply the state checks of section h, then look up the mesh (section c reuse rule), then the failure memo (section d).
5. Collect every remaining drawable path into **one** `buildFillMeshes` call, with `requestId` equal to the request's batch index. No call is made when nothing is missing.
6. If the call returns `batch-failed` with `internal-error` or `resource-limit`, isolate it (below).
7. Validate each response (section h), publish `ok` and `empty` results to the mesh cache and failures to the memo, before any packing. A later packing error therefore never repeats a port call.
8. Build or reuse each drawn mesh's fringe (section e), then pack, choose the mesh origin and emit the packet (section f).
9. Evict (section d).

Opacity, fill alpha and color never decide whether a path is drawable, so changing them never calls the port. A `fill` change from `null` to a color, a visibility change or entering the viewport calls the port only when no entry exists for the key.

**Batch-failure isolation (V2 section l).** V2's kernel `INTERNAL_ERROR` fails the whole batch without disposing the adapter, and the same input fails again. To keep one defective path from hiding the others, a failed batch of more than one request with `internal-error` or `resource-limit` is split at path boundaries, as V2 section a allows. The other codes are not split: `disposed` latches, and `invalid-request` means a renderer defect, so every key in that batch is memoized.

Splitting is normative:

- **Order.** Depth-first, left-first. A failed range `[i, j)` with more than one request splits at `i + ⌊(j − i)/2⌋`. The left half is called first and fully resolved before the right half. Each sub-call renumbers `requestId` from 0.
- **Settling.** A sub-call that returns `ok` settles its keys at once (cache or memo, as usual). A single-request leaf that fails records its batch-scope memo entry (section d) as soon as it fails, before the next call.
- **Bound.** At most 32 port calls per `prepare`, the first call included.
- **Batch size.** One call carries at most 2^31 requests. A `prepare` with more missing drawable paths sends the first 2^31 in paint order, and the rest stay missing for the next `prepare`. This bound is the renderer's own; it does not rely on V2's transport caps.
- **Progress.** With n ≤ 2^31 the split depth is `d = ⌈log2 n⌉ ≤ 31`. Along the left-first descent each call either succeeds, settling at least one key, or fails and descends. Within `d + 1 ≤ 32` calls a key is therefore settled, so every `prepare` that calls the port settles at least one key.
- **Resume.** The isolation state is the DFS stack of untried ranges. When the bound is hit, the next `prepare` resumes from that stack, top first, and never re-calls a range already known to fail. Its known-failing ranges are only ever split. Before resuming, requests whose node was removed, is no longer drawable, or whose key changed are dropped from every stacked range, and an emptied range is discarded. New keys wait until the stack is empty. Requests not yet reached keep no memo entry and no notice.
- **Cost.** One defective path in n requests costs at most `2·⌈log2 n⌉` extra calls. If every path is defective, all n are settled after at most `2n − 1` calls in total, spread over prepares of at most 32 calls.

**Request buffers.** The service builds fresh `Uint8Array` verbs with `PATH_VERB_CODES` and a fresh `Float64Array` of points per request. It never mutates request or result buffers.

Amended 2026-10-21 by [ST-U6](p3-fill-stroke-meshes.md#b2-st-u6-renderer-stroke) under [B2 stroke contract sections 9.3 and 9.4](p3-b2-stroke-contract.md#93-cache-keys-memo-and-reuse):

- **Keys.** The cache key above gains the tag `'fill'`. A stroke key is `('stroke', portVersion, operationId, nodeId, geometryRevision, width, cap, join, miterLimit, toleranceExponent)`, read from the stroke port at every `prepare` and compared with `===`. A stroke color, node opacity or fill change builds no stroke mesh.
- **Second port call.** After the fill call of step 5, every missing drawable stroke key goes into one `buildStrokeMeshes` call, with this section's isolation, settling, resume and memo rules applied to the stroke port independently, its own bound of 32 calls per `prepare` and its own `disposed` latch. Its responses are validated as in section h before packing; the stroke port also answers the per-path code `invalid-stroke`.
- **Stroke drawability and tolerance.** A stroke is drawable when the path is not hidden, `stroke !== null`, `width > 0`, it has a verb, its world linear map is nonsingular, and its stroke world bounds meet the viewport; a path is culled only when neither paint's bounds meet it. The stroke uses the node's `e` and `f`; `e < -1020` is the state failure `tolerance-range` for the stroke paint, and `e > 1023` requests 1023.

## c) Tolerance and fringe buckets

Both buckets are decided by exact predicates on the Float64 inputs. No rounded `log2` or rounded quotient decides a boundary.

**Exact singular-value predicates.** Let L be the node's Float64 world linear map and `S = DPR · zoom · L`, formed exactly: every Float64 is a dyadic rational, so S is evaluated with BigInt numerators over a common power of two. Let `F = ‖S‖²_F` (sum of squared entries) and `D = det S`. The eigenvalues of `SᵀS` are the roots of `q(t) = t² − F·t + D²`. For a dyadic `t > 0`:

- `sigmaMax(S)² ≤ t` exactly when `2t ≥ F` and `q(t) ≥ 0`;
- `sigmaMin(S)² ≥ t` exactly when `2t ≤ F` and `q(t) ≥ 0`.

**Tolerance bucket.** `e` is the largest integer with `2^e · sigmaMax(S) ≤ 0.125`, that is, `sigmaMax(S)² ≤ 2^(−6−2e)`. This is the private contract's [fill rule](p3-private-contract.md#numeric-compatibility-decision) `e = floor(log2(0.125 / sigmaMax(S)))`, with V1 d's 0.125 share and no new allocation.

**Fringe bucket.** `f` is the smallest integer with `2^f · sigmaMin(S) ≥ 2`, that is, `sigmaMin(S)² ≥ 2^(2−2f)`. The local distance `ρ = 2^f` then maps to at least 2 physical px in every direction (section e).

**Start values and termination.** Starts come from BigInt bit lengths, never from a Float64 quotient that could overflow. `F/2 ≤ sigmaMax² ≤ F`, and `sigmaMin² = D² / sigmaMax²` lies in `[D²/F, 2D²/F]`, so starts taken from `bitLength(F)` and from `bitLength(D²) − bitLength(F)` (adjusted for the common scale) are within two steps of the answer. Each start is clamped into `[E_MIN − 1, E_MAX + 1]` for `e` and `[F_MIN − 1, F_MAX + 1]` for `f`. The predicate is monotone, so the search moves at most a few steps and stops at the clamp bounds.

**Ranges.** `renderer-core` defines internal constants `E_MIN = −1021` and `E_MAX = 1023`, equal to V2's accepted range ([V2 section d](p3-v2-fill-mesh-transport-contract.md#d-tolerance)). They are not exported and not part of the port. `F_MIN = −1074` and `F_MAX = 1023` bound `ρ = 2^f` to positive finite Float64 values.

**Guards.**

| Case                                                                                            | Rule                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `D = 0` exactly (singular, including zero L)                                                    | Not drawable: no port call, no draw, no diagnostic. This is P1 D2's singular-transform rule; a filled region of zero area draws nothing |
| Exact `D ≠ 0`, but the f32 lanes' determinant, evaluated exactly, is 0 or has the opposite sign | Renderer state failure `packing-range` (section h): the shader's orientation would disagree with the exact one                          |
| Underflow, overflow                                                                             | Cannot occur in the predicates, which are exact. Zoom and DPR are already finite and positive; L is finite by validation                |
| `e > E_MAX`                                                                                     | Request `E_MAX`. A finer tolerance is always within the budget                                                                          |
| `e < E_MIN`                                                                                     | No port call. Renderer state failure `tolerance-range`. A coarser tolerance would break the 0.125 share, so V3 never sends one          |
| `f` outside `[F_MIN, F_MAX]`                                                                    | Renderer state failure `fringe-range`                                                                                                   |
| A port answers `invalid-tolerance`                                                              | Authoritative: recorded like any per-path failure (sections d and h). A port other than V2's may accept a narrower range                |

**Caching the buckets.** `(e, f)` per node is recomputed only when the node's world linear lanes, the zoom or the DPR change. A pan never recomputes them.

**Reuse rule: a finer mesh may serve a coarser request.** V1 d made a change of `e` a miss on the exact key and left this rule to V3 (see V3-C1). Lookup for a drawable path at bucket `e`:

1. the entry at exactly `e`, if resident;
2. otherwise the resident `ok` or `empty` entry with the largest `e′` in `[e − 2, e − 1]`;
3. otherwise a miss.

A coarser entry (`e′ > e`) never serves. A finer flattening is always inside the curve share, the window gives hysteresis against zoom jitter at a bucket edge, and two levels bound the extra vertex count: flattening segment counts grow roughly as `2^(Δ/2)`, so about 2x at Δ = 2. The served entry's `e′`, not `e`, is what the packet uses.

## d) Mesh cache, failure memo and their bounds

**Failures are classified by what they depend on.**

| Class                      | Codes (section h)                                                             | Depends on                      | Stored                                          | Port call                                | Notice                               |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| Port and response          | per-path port codes; isolated batch codes; `invalid-response`, `invalid-mesh` | The key                         | Failure memo, by key                            | Not repeated for that key (expiry below) | Once, when the memo entry is created |
| Fringe build               | `fringe-unsupported`                                                          | The mesh and the fringe bucket  | A mark on the cache entry's `(key, f′)` variant | None: the mesh stays cached              | Once, when the variant is marked     |
| Transform and camera state | `tolerance-range`, `fringe-range`, `packing-range`, `port-version`            | Transform, camera, target, port | Nothing; re-evaluated in every `prepare`        | None while the state holds               | On a `(node, code)` state transition |

A fringe or state failure therefore keeps any cached mesh, which serves again as soon as the condition clears. A path in a state failure is not drawn and is not counted as a miss.

**Entries.** One mesh-cache entry per key holds the owned `FillMesh` from the port (or an `empty` marker), the geometry-owned packed offsets of section f, and up to two fringe variants (section e). An `empty` result is a success: it is cached, draws nothing and never calls the port again.

**Byte accounting.** An entry's bytes are the exact sum of `byteLength` over every typed array it owns: the port's `positions`, `indices` and `boundaryEdges`; the packed Float32 offsets of the port vertices; and, per fringe variant, its four corner offsets, triangle records, lists and features. Statistics report `entries`, `bytes`, `peakBytes`, `evictions` and `overBudgetFrames`. When the host gives `fillMeshMemoryBytes`, statistics also report its value as `portLinearMemoryBytes`, read once per `prepare`, and a `pathMeshMemoryBytes` total of cache bytes plus that value. The port's linear memory is reported, not evicted: V2's output arena never shrinks, up to 256 MiB. These are CPU attributions toward the [prototype memory ceiling](../prototype-plan.md), not a memory-peak proof.

**Bounded eviction.**

| Rule                        | Number                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Unreachable entries         | Dropped at once: node removed, geometry revision changed, `fillRule` changed, `operationId` changed                                         |
| Tolerance variants per node | At most 3; drop the one farthest from the current `e` first, then the larger `e′`                                                           |
| Fringe variants per entry   | At most 2; drop the one farthest from the current `f`                                                                                       |
| Byte budget                 | 64 MiB (67,108,864 bytes). After a frame, evict least-recently-drawn entries outside the working set until within budget; ties by key order |
| Working set                 | Entries served in the current packet are never evicted. A working set above budget is kept and counted in `overBudgetFrames`                |

The budget is a functional bound, not a performance claim; B0 measures real sizes. Evicting an entry or a fringe variant frees its GPU ranges (section f).

**Failure memo.** Failed port and response results never enter the mesh cache (C04 item 5). The memo records them:

| Field        | Rule                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Key          | The cache key. For `invalid-path`, the key without `toleranceExponent`, because V2 decides it before the tolerance stage                                                                                                                                     |
| Value        | Failure scope and code (section h)                                                                                                                                                                                                                           |
| Invalidation | The mesh cache's unreachable rules, applied independently                                                                                                                                                                                                    |
| Capacity     | 4,096 entries; least recently consulted entries outside the working set are evicted first. If more than 4,096 entries are consulted in one `prepare`, all are kept and `memoOverCapFrames` counts it                                                         |
| No expiry    | Per-path port codes (V1 rule 6 makes them deterministic), an isolated one-request `internal-error` (V2 section h: the same input fails the same way), `invalid-request`, `invalid-response` and `invalid-mesh` (deterministic for a given port and renderer) |
| Expiry       | An isolated one-request `resource-limit` expires after 256 `prepare` calls, allowing one retry, because host allocation can recover                                                                                                                          |
| Latch        | After `batch-failed` with `disposed`, the service stops calling the port; every later new key fails as batch `disposed`                                                                                                                                      |

**No per-frame calls for a failing key.** A drawable path whose key, and every finer serving key, is not resident and whose key is in the memo is skipped without a port call. Its key reaches the port again only after the key changes, its memo entry is evicted while not consulted, or a `resource-limit` entry expires. All three are bounded, so a visible failing path never calls the port every frame.

Amended 2026-10-21 by [ST-U6](p3-fill-stroke-meshes.md#b2-st-u6-renderer-stroke) under [B2 stroke contract section 9.3](p3-b2-stroke-contract.md#93-cache-keys-memo-and-reuse): one mesh cache and one failure memo hold both paints, with paint-tagged entries. The byte budget, memo capacity and working-set rules apply to the total; the tolerance-variant cap and the reuse rule apply per node and paint; a change of any stroke key field makes that paint's entries unreachable. Ties in the budget eviction order compare the tag first (`'fill'` before `'stroke'`), so a fill-only scene evicts as before. Statistics add `strokePortCalls` and `strokePortLinearMemoryBytes`, and `pathMeshMemoryBytes` includes the latter.

Amended 2026-10-21 by the [ST-U6 pending-paint churn follow-up](p3-fill-stroke-meshes.md#b2-st-u6-pending-paint-churn-review-follow-up): the Working set row also covers the cached entries of a path that passed this frame's drawability, node-state, paint-state and memo checks and was not drawn only because a sibling paint's entry is missing. Those entries are not evicted that frame and are not stamped as drawn; they still count toward the byte budget and the over-budget statistics. At most one entry per node and paint is protected. The frozen row text above is unchanged.

Amended 2026-10-21 by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md): overlay variants are cache data of their fill entry; their bytes count in the budget; at most two per node; evicting either parent variant evicts them; a failed overlay is a mark like a failed fringe variant. An overlay is reachable only when both parent entries are resident, so the pending-sibling working-set amendment above needs no overlay rule.

Amended 2026-10-30 by E26-U5a under the [E26 contract, section 4.4.1](d9-e26-pointer-priority-contract.md#441-u5-amendment-2026-10-30): a mesh write's `records` and a submitted mesh receipt resource's `records` are `MeshRecordRange` entries, `{ index, count, version }`, each a run of consecutive records written with one version, in place of one `PrimitiveRecordVersion` per record. A write's ranges cover its byte range in order, without gaps or overlap, and the backend rejects any other write as `invalid-packet`. "Exactly the expected record versions" (Receipts, above) means exactly the packet's ranges, in any order. Bytes, draws and the records each write covers are unchanged; P1's records are unchanged.

## e) A5 coverage on K4

**What is reused from O02, unchanged.** The coverage rule at the pixel center (`s`, `w`, `c = clamp(0.5 − s/w, 0, 1)`), EDGE and VERTEX features with multi-sector pinch vertices and the reflex bit, global feature order and strict-`<` updates, the 1.5 px list reach, the 1.0 px far-field clamp to the role constant, `@builtin(position)` as the pixel center, no `sample` interpolation or alpha-to-coverage, one pipeline per sample count, and a complement-triangulation fringe with an exact partition check. The [O02 contract](p3-o02-a5-coverage-contract.md#features-and-reach) owns their meaning; this section states only what differs on K4.

**What differs, and why.** O02 built frames, features and lists on the host in physical pixels, per row. On K4 with transform-only reuse that would rebuild fringe data on every pan. V3 makes the fringe geometry-owned, in node-local coordinates, and moves the screen mapping into the shader:

| Item                 | O02 (test-only)                                                                     | V3 on K4                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame                | Physical bbox + 2 px, rounded outward to integer px, mapped back to local           | Local bbox of the mesh `bounds` expanded by `ρ = 2^f` per side, on the binary32 offset grid from `m`, rounded away from the mesh (below)              |
| Frame corner storage | Part of the row's soup                                                              | Four vertices appended after the port vertices in the variant's own position range (section f)                                                        |
| EDGE record          | Unit outward normal `n`, offset `c`, endpoint parameters `ta`, `tb`, in physical px | Endpoints `a`, `b` as binary32 offsets from `m`; the shader maps them to physical px and derives the normal and parameters there                      |
| VERTEX record        | Position and unit sector directions in physical px                                  | Position offset and unnormalized local sector directions; the shader maps them with the linear lanes                                                  |
| List reach           | 1.5 px, exact, in physical px                                                       | Every feature within local distance `ρ` of the closed triangle, exact; `ρ` maps to at least 2 px ≥ 1.5 px in every direction                          |
| Exterior triangles   | Dropped when their list is empty                                                    | Same; each is then more than `ρ` local, hence 2 px, from the boundary, where `c = 0`                                                                  |
| Orientation          | y-down physical px                                                                  | Node-local, as port rule 5 orients `boundaryEdges`; the shader multiplies every side and sector test by `σ = sign(det L)`, from the exact determinant |
| Cache identity       | None (per row)                                                                      | Per mesh entry and fringe bucket `f`; a variant built for `f′` serves `f ≤ f′ ≤ f + 1`                                                                |

**Frame corners.** For each axis, the corner offset is the binary32 value `k` farthest toward the mesh such that, in exact arithmetic, `m + k` lies at least `ρ` outside the bbox: `k ≤ minX − ρ − m` on the low side and `k ≥ maxX + ρ − m` on the high side. It is found by rounding the Float64 difference to binary32 and stepping one binary32 ulp outward until the exact check holds. If `k` is not a finite binary32 value, the variant cannot be built: renderer state failure `fringe-range`. The triangulator and the partition check use the exact values `m + k`, so no Float64 rounding of the corners occurs.

The local frame is a parallelogram in screen space. Every boundary point is at least `sigmaMin(S) · ρ ≥ 2` px inside it, which meets O02's 1.5 px containment. A larger `f′` only enlarges the frame and the lists, which costs overdraw but keeps the rule correct, so one level of slack avoids rebuilds on small zoom changes.

**Fringe builder.** The algorithm is O02's, unchanged in its rules:

- boundary loops from `boundaryEdges`, which V2's conforming refinement makes exactly the region boundary, with sectors by exact angle and sector pairing at pinch vertices;

  Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md): for fast-rung meshes, `boundaryEdges` are the edges used once in an unrefined conforming mesh (that contract's section 3.5); they are exactly the region-boundary edges, as before.

- loop nesting by exact midpoint point-in-polygon;
- faces triangulated by bridging and ear clipping, including the three triangulator choices O02's review ruled within its contract;
- no Steiner points: exterior triangles reuse the mesh's boundary vertex indices plus the four frame corners;
- an exact partition check over region and exterior triangles before publication.

A vertex with more than 3 sectors, duplicate coordinates, a failed pairing, no ear or a failed partition check is `fringe-unsupported` for that `(key, f′)` variant. Region triangles are the port's, unchanged. **Where this builder runs is decision [V3-Q3](#n-decisions-for-the-user).**

**Interpretation.** O02's G1-G3 PASS does not transfer: features are evaluated in f32 from local lanes in the shader, not rounded once from host float64 physical values, and K4 carries no position certificate. Section [k](#k-a08-visual-contract) fixes the visual contract that later evidence uses; V3 claims none of it.

Amended 2026-10-21 by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md): in joint draws only, the port's fill triangles are re-split by the overlay builder:

- the faces are the exact arrangement of each crossed triangle with the clipped stroke `boundaryEdges`;
- the faces are triangulated by this section's triangulator;
- Steiner points are rounded once to Float64, except on axis-aligned frame edges, where the exact frame coordinate is kept.

Each overlay triangle keeps its parent's fill list and role and carries a stroke list of every stroke feature within the stroke variant's `ρ′`, decided exactly, and a stroke role from exact membership. The overlay passes this section's exact partition check over the domain's boundary edge multiset. The sentence "Region triangles are the port's, unchanged" (above) still holds for every fill and stroke draw. The joint draw's overlay triangles are an exception under the D8-interim exception recorded in `docs/graphics-engine-architecture.md` by ST-U7a.

## f) The mesh packet part and the mesh draw

**Envelope.** The P1 packet is unchanged: `layoutVersion: 1`, the five resources, their writes, the `analytic-v1` draws and every other field keep their P1.0b meaning. V3 adds one optional field. It is absent whenever the service has no port, and also when a port is injected but the scene has no path slot and no pending notice. A primitive-only packet is therefore byte- and shape-identical to today's.

```ts
export type MeshResourceId =
  | 'meshPositions'
  | 'meshTriangles'
  | 'meshFeatureLists'
  | 'meshFeatures'
  | 'meshInstances'
  | 'meshFrame';
export type MeshFillDraw = Readonly<{
  /** Number of analytic draws that precede this draw in paint order; equal values keep array order. */
  position: number;
  instance: number; // path slot; selects the meshInstances record
  firstTriangle: number; // absolute record index in meshTriangles
  triangleCount: number; // region and exterior triangles of this variant, > 0
}>;
export type MeshPacketPart = Readonly<{
  layoutVersion: 0;
  originRevision: symbol;
  resources: readonly Readonly<{
    id: MeshResourceId;
    incarnation: symbol;
    capacityBytes: number;
  }>[]; // fixed order above
  writes: readonly Readonly<{
    resourceId: MeshResourceId;
    incarnation: symbol;
    byteOffset: number;
    bytes: Uint8Array;
    records: readonly PrimitiveRecordVersion[];
  }>[];
  draws: readonly MeshFillDraw[];
  notices: readonly PathMeshNotice[]; // section h
}>;
// PrimitivePacket gains: readonly mesh?: MeshPacketPart
// PrimitiveReceipt gains: readonly mesh?:
//   | Readonly<{ status: 'submitted'; originRevision: symbol; resources: /* six entries, same shape as P1's */ }>
//   | Readonly<{ status: 'skipped' }> // mesh path unavailable for this generation (section f)
```

**Receipts.** `receiptMatchesPacket` keeps every P1 comparison and adds one rule: the receipt has a `mesh` part exactly when the packet has one. A `submitted` mesh part must carry the packet's `originRevision`. A `skipped` part acknowledges only the P1 part and leaves every mesh record dirty. Submitted mesh receipt resources are validated like P1's: six entries in the fixed order, current incarnations, and exactly the expected record versions. P1's five-resource receipt check is unchanged. Otherwise a packet with a mesh part is acknowledged only when both parts validate; acknowledgment clears records only when their versions match, as in P1.

**Position carrier (K4, U3).** The untiled midpoint carrier of the [C04 readiness note](p3-c04-position-readiness.md#candidate-under-consideration), as T01 defines K4:

- **Geometry-owned:** a Float64 midpoint `m` per mesh from V2's exact `bounds` (`minX/2 + maxX/2` per axis, which cannot overflow), and one offset `u = fround(v − m)` per port vertex, the difference taken in Float64. Feature points use the same offsets. Frame corners use the outward rule of section e.
- **Transform-owned:** f32 lanes `a, b, c, d` of L, and the anchor `B = fround(W(m) − O_m)` with `W(m)` in Float64.
- **Frame-owned:** `fround(O_m − camera)`, zoom, DPR and physical size.
- **Vertex stage:** `p = ((A·u + B) + (O_m − camera)) · zoom · DPR`, then NDC exactly as the P1 shader does.

**Mesh origin (U3).** `O_m` is a per-view origin shared by all meshes in a packet and separate from the primitive origin, as U3 requires. V3 uses the [R3](p3-r3-origin-window-contract.md) policy O-PX(T) with T = 128, the target R3 [selected](../evidence/p3.1m-r3-origin-window/review-2026-10-06.md), with R3's inputs:

- `z = q(fround(zoom))` and `q = q(fround(dpr))`, the exact rationals of the binary32-rounded zoom and DPR, as R3's `originPXTarget` uses;
- `g = 2^k` document units, the largest with `g · z · q ≤ 128`, decided exactly;
- `O_m = g · floor(camera / g)` per axis;
- keep `O_m` while each camera axis stays within `2g` of it and `g` is unchanged; otherwise re-snap and replace `originRevision`.

R3's selection is a planning input, not adopted runtime behavior. V3 uses it as the functional interim inside the [C04 carve-out](p3-private-contract.md#private-transport-and-lifetime-requirements); C04 still owns the final lanes. A rebase rewrites only `meshInstances` anchors and `meshFrame`: at most 64 bytes per occupied path slot plus 32, counted separately, as P1 counts rebases.

**Float32 conversion.** Every f32 lane is one `Math.fround` of a Float64 value.

- A nonfinite geometry-owned offset or instance lane for one path is the state failure `packing-range` for that path; it never fails the whole packet.
- `meshFrame` is shared. If one of its lanes is nonfinite, every drawable path in that `prepare` gets `packing-range`, the mesh part carries no draws, and primitives draw as usual. Zoom, DPR and size are the P1 frame's own lanes, which P1 already checks, so only `O_m − camera` can fail here, at a zoom times DPR below about 7.5·10^-37.
- V3 evaluates no mesh precision budget: no a priori certificate exists (M01), which is why the evidence label is UNVERIFIED.

**Byte layouts.** Little-endian 32-bit words; f32 unless marked u32; padding zero.

| Resource           | Stride | Words                                                                                                                                                                                                                                                                                             |
| ------------------ | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meshPositions`    |      8 | `u.x, u.y`. A variant's range holds the N port vertices in port order, then its 4 frame corners (indices N to N+3)                                                                                                                                                                                |
| `meshTriangles`    |     32 | u32 `i0, i1, i2` (variant-relative vertex indices, counterclockwise in node-local); u32 `listOffset`, u32 `listCount` (variant-relative); u32 `role` (0 region, 1 exterior); 2 zero                                                                                                               |
| `meshFeatureLists` |      4 | u32 variant-relative feature index; each list sorted by `(kind, global id)` as O02                                                                                                                                                                                                                |
| `meshFeatures`     |     64 | EDGE: u32 `kind = 0`; `a.x, a.y, b.x, b.y` (offsets from `m`, region on the left in node-local); 11 zero. VERTEX: u32 `kind = 1`; u32 `k` in bits 0-7 and reflex bit `8 + i` per sector; `x, y`; then per sector `r_out.x, r_out.y, r_in.x, r_in.y` as unnormalized local directions; unused zero |
| `meshInstances`    |     64 | `a, b, c, d`; `B.x, B.y`; `σ` (±1); node opacity; straight fill `r, g, b, a`; u32 `vertexBase`, u32 `listBase`, u32 `featureBase` of the served variant; 1 zero                                                                                                                                   |
| `meshFrame`        |     32 | `O_m.x − camera.x`, `O_m.y − camera.y`; zoom; DPR; physical width, height; 2 zero (P1's frame layout with the mesh origin)                                                                                                                                                                        |

Region triangles come first in a variant's triangle range, then exterior triangles. Index width is u32. The cull mode is none, so winding never discards a triangle. Each fringe variant has its own ranges in all four geometry regions, so `vertexBase`, `listBase` and `featureBase` name the served variant. The port vertices are packed once per entry on the CPU and copied into each variant's range.

**Draw method.** One non-indexed draw per mesh, bound to the layouts above by vertex pulling:

```text
draw(vertexCount = 3·triangleCount, instanceCount = 1,
     firstVertex = 3·firstTriangle, firstInstance = instance)
vertex:   t = vertex_index / 3; corner = vertex_index % 3
          v = meshInstances[instance].vertexBase + meshTriangles[t].i[corner]
          position from meshPositions[v]; flat outputs t and instance
fragment: c from meshTriangles[t]'s list and role (O02 rule, section e)
          out = c · opacity · (r·a, g·a, b·a, a)
```

Every vertex of a triangle computes the same flat `t`, so no provoking-vertex convention matters, and shared vertices compute identical positions from the same `u`. No vertex or index buffer is bound.

**Pipeline and limits.** A second pipeline, keyed `shaderKey: 'p3-mesh-fill-v0'`, `layoutKey: 'p3-mesh-packet-v0'`, `vertexLayoutKey: 'vertex-pulling-v0'`, the P1 render-state key and the actual format and sample count. Its bind group has five read-only storage bindings and one uniform, visible to vertex and fragment stages.

- `PrimitiveFrameSource` gains an optional `readonly requiresMeshPipeline?: boolean`, default `false`. The service sets it to true exactly when it has a port, so existing sources are unchanged. The backend reads it when the source is attached. Attaching after initialization stays an error, as today (`webgpu-backend.ts:182-185`), so the flag is always known before the first device is created.
- When it is true, the backend creates the mesh shader module, layout and pipeline during initialization and during each recovery, next to the P1 pipeline, never on the frame path.
- The backend checks `maxStorageBuffersPerShaderStage ≥ 5` and `maxBindingsPerBindGroup ≥ 6`. Both are within WebGPU's default limits (8 and 1000).
- If either check fails anyway, or mesh pipeline creation fails, the mesh path is unavailable for that generation. It is a state failure, not a packet failure. The backend still submits the P1 part of every packet and skips its mesh draws and mesh writes. The receipt then carries `mesh: { status: 'skipped' }`: the source acknowledges the P1 records and keeps the mesh records dirty. On its first `skipped` receipt in a generation the source stops producing the mesh part (draws and writes) for the rest of that generation; queued notices still travel in a mesh part holding notices only. A new generation tries again. Once per generation the backend emits the interim code with scope `renderer`, code `mesh-pipeline-unavailable` and `nodeId: null`. Primitives draw as usual.

**Mesh arena and range management.** The P1 arena keeps its five regions unchanged. Mesh resources live in a second generation-owned arena with P1's rules: one `GPUBuffer`, one `SharedBufferAllocator`, aligned regions in resource order, power-of-two capacity, growth replaces the arena and its incarnations and reconstructs mesh data, and the old arena retires after its last submitted use. Then:

- `renderer-core` places each served variant's element ranges in the first four regions by first fit over a free list that merges adjacent free ranges.
- If no free range fits but the region's free total would, that is fragmentation. The arena is replaced at the same or the next capacity, and every resident variant is repacked contiguously, as a growth.
- When a slot's served variant changes (a new `e′` or `f′`), or a variant or entry is evicted, its ranges return to the free list after the packet that stops referencing them. Reusing a range in the same arena relies on queue order, as in P1.
- Each submission marks every allocation of each arena it uses, the P1 arena always and the mesh arena when the packet has a mesh part with resources, in both arenas' allocators.
- During growth, resource accounting tracks the old and new mesh arenas at once, until the old one retires.
- `meshInstances` has one record per path slot and grows by power of two like P1's slot arrays; `meshFrame` is exactly 32 bytes.

Amended 2026-10-21 by [ST-U6](p3-fill-stroke-meshes.md#b2-st-u6-renderer-stroke) under [B2 stroke contract section 9.5](p3-b2-stroke-contract.md#95-draws-and-records): a drawn stroked path emits its fill draw (when the fill is drawable) and then its stroke draw, both `MeshFillDraw` entries with the same `position`, consecutive in `draws`. The stroke draw has its own `meshInstances` record from a second path slot, allocated by this section's slot allocator for each node whose stroke has `width > 0` and released when it no longer has one. The record layout is the 64-byte layout above, with the stroke color in the straight color lanes and the served stroke variant's bases. The stroke mesh uses section e's fringe builder and work cap, this coverage rule, pipeline and shader unchanged, and device loss rebuilds stroke data from the CPU entries without a port call (section i). A fill-only scene packs byte-identically to V3.

Amended 2026-10-21 by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md): the joint triangle record (eight u32 words: three indices with bit 31 selecting the stroke variant's positions, fill list, stroke list, roles in bits 0 and 1); word 15 of the fill slot's record, which is stroke slot + 1 under the joint condition and 0 otherwise, recomputed every `prepare`; `MeshFillDraw.composite?: 'joint-fill'`; the pipeline `'p3-mesh-joint-v0'`, created beside the fill pipeline from the same module. `layoutVersion` stays 0; packets without joint draws are unchanged in bytes and shape.

## g) Paint order and composition

**Order.** Preparation walks the authoritative depth-first order once. Visible primitives append their slot to `order` as today. A path that emits a mesh draw closes the current analytic run and records its draw with `position` equal to the number of analytic draws so far. A path that emits no draw (hidden, culled, empty, singular, `fill: null` or failed) does not split a run, because nothing paints between its neighbours. Analytic draws therefore still partition `[0, visibleCount)` into adjacent increasing ranges, which the backend keeps validating unchanged. A scene with no drawn path emits exactly one analytic draw, as today. The backend encodes draws in merged order and switches pipeline and bind group only at a variant change.

**Composition.** A fill-only path has `L = F` in D2's terms, so its output is `P = F · opacity`, source-over the destination with P1's blend. Node opacity must reach each sample exactly once. That holds because a variant's region and exterior triangles partition its frame (section e's exact check) and the rasterizer's shared-edge rule covers each sample by at most one of them. This is O02's G3 assumption, which WebGPU does not state normatively; V3 inherits it as a stated limit. No offscreen isolation, stencil or extra pass is used. Overlap between separate nodes is ordinary source-over in paint order, as for primitives. Container opacity stays 1, as P1 requires.

Amended 2026-10-21 by [ST-U6](p3-fill-stroke-meshes.md#b2-st-u6-renderer-stroke) under [B2 stroke contract section 9.6](p3-b2-stroke-contract.md#96-composition-and-the-opacity-staging-b2-q6): two source-over draws in fill-then-stroke order are exact at node opacity 1 for any paint alphas, and a single-paint path is exact at any opacity. Both paints at `0 < opacity < 1` would apply opacity twice in the overlap; that case is the interim state failure `composition-unsupported` of section h until ST-U7.

Amended 2026-10-21 by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md): both paints at `0 < opacity < 1` are drawn by the joint fill draw and the stroke draw, exact by the addendum's section 3.2; each draw still covers each sample at most once. No offscreen isolation, stencil or extra pass is used.

Amended 2026-10-25 by [E17](d9-e17-mesh-write-once-coverage-contract.md#3-the-rule): the rasterizer's subpixel snap can invert sliver triangles, so the shared-edge rule alone no longer gives at most one cover per sample (V-4's pre-freeze A08 run, count 3). Each mesh draw now writes a sample at most once through a `stencil8` attachment with a per-draw reference (E17-K1, E17-K2); composition and the shader are otherwise unchanged. The sentence "No offscreen isolation, stencil or extra pass is used" above is superseded for stencil only.

## h) D8-interim failure outcome

Amended 2026-10-20 by [V4](p3-fill-stroke-meshes.md#v4-playground-path-page), the builder work cap: a path whose mesh has more than `fringeBoundaryVertexCap` (128) distinct boundary vertices is drawn region-only (no coverage fringe) instead of not drawn, and queues one `render.path-mesh-interim-failure` notice with code `fringe-work-cap` per cache entry. This is V3-Q2 option (c) scoped to that one cause; every other failure keeps this section's rule. It is removed with the TypeScript builder at the R2/K1 placement decision, or when B0's E3 result replaces it.

E11-U4 pointer (V4 amendment), 2026-10-24: `fringe-work-cap` is product outcome O2 while the TypeScript builder ships; the notice code is now `render.path-mesh-failure` ([E11-U4 addendum](d9-e11-u4-failure-behavior-addendum.md)).

**Code.** `packages/contracts/src/diagnostics.ts` gains:

```ts
PATH_MESH_INTERIM_FAILURE: 'render.path-mesh-interim-failure',
```

It is emitted with severity `warning`, the message prefix `D8-interim:`, the current generation, and this context:

| Context key         | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `interim`           | `'d8'`                                                             |
| `nodeId`            | The path node id; `null` only for `mesh-pipeline-unavailable`      |
| `failureScope`      | `'path'`, `'batch'` or `'renderer'`                                |
| `failureCode`       | One code from the table below                                      |
| `toleranceExponent` | The requested `e`, or `null` when the failure is independent of it |

**Failures that reach it.**

| Scope      | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Approval                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `path`     | Every `FillMeshFailureCode`: `invalid-path`, `invalid-tolerance`, `numeric-range`, `work-limit`, `unsupported-geometry`                                                                                                                                                                                                                                                                                                                                                                                          | V1-Q4                                   |
| `batch`    | `internal-error` isolated to one path                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | V1-Q4: the kernel cannot mesh that path |
| `batch`    | `resource-limit` isolated to one path; `invalid-request`; `disposed`. One notice per affected node                                                                                                                                                                                                                                                                                                                                                                                                               | [V3-Q2](#n-decisions-for-the-user)      |
| `renderer` | `tolerance-range`, `fringe-range`, `port-version`, `invalid-response` (thrown port, wrong length, order, `requestId` or exponent echo), `invalid-mesh` (nonfinite position, index out of range, index count not a multiple of 3, odd `boundaryEdges`, bounds unequal to the positions' exact bounds), `fringe-unsupported`, `packing-range`, and `mesh-pipeline-unavailable` (backend, once per generation, section f). A `port-version` state failure emits one notice per drawable path node on its transition | [V3-Q2](#n-decisions-for-the-user)      |

**Outcome.** The scene stays accepted, the failing path is not drawn, and every other node draws in order. A port or response failure leaves nothing in the mesh cache for that key. A fringe or state failure keeps the cached mesh, which serves again once the condition clears (section d).

**Transport.** Notices are created only as section d's class table says: once per memo entry, once per marked fringe variant, and on each `(node, code)` state transition for state failures, so a `port-version` change notifies every drawable path once. `renderer-core` queues them and attaches at most 32 per packet in `mesh.notices`, oldest first. The backend emits each as a diagnostic right after a non-null `prepare`, before generation and submission checks, because a notice describes CPU state. Notices left in the queue when `prepare` throws stay for the next packet. The queue holds at most 4,096 notices; overflow drops the newest and counts them in `noticesDropped`. The backend's own `mesh-pipeline-unavailable` diagnostic is emitted directly by the backend, outside this queue and its caps.

**Label and removal.** The code is D8-interim, scoped to V2-V4 as V1-Q4 approved. It does not answer U2 or U4 and does not reuse `render.submission-failed`. It is removed or replaced when the production failure behavior is decided, before P3 acceptance, with requirements text naming the meshes that can reach that behavior. Removal deletes the code, the `notices` field and their tests in one change.

Amended 2026-10-21 by [ST-U6](p3-fill-stroke-meshes.md#b2-st-u6-renderer-stroke) under [B2 stroke contract sections 9.6 and 9.8](p3-b2-stroke-contract.md#98-notices), with the ST-A0 S5 note:

- **Context key `paint`.** The notice context gains `paint: 'fill' | 'stroke' | null`: the paint for path and batch scopes and for renderer failures of one paint (`tolerance-range`, `fringe-range`, `packing-range`, `invalid-response`, `invalid-mesh`, `fringe-unsupported`, `fringe-work-cap`), and `null` for `composition-unsupported`, `port-version` (of either port) and `mesh-pipeline-unavailable`. State failures transition per node and paint; `composition-unsupported` per node.
- **Codes.** The table gains `invalid-stroke` (scope `path`) and `composition-unsupported` (scope `renderer`): a path with `fill !== null`, a stroke of `width > 0` and `0 < opacity < 1` draws neither paint, calls no port for it and keeps its cached meshes; it clears when either condition clears.
- **Outcome.** If either drawable paint of a path fails (any port, response, fringe or state failure), the whole path is not drawn and every other node draws; the other paint's cached mesh stays. This extends V1-Q4 to stroke failures as the ST-A0 S5 note states. `fringe-work-cap` still draws its paint region-only, as amended above.

Amended 2026-10-21 by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md): the table loses `composition-unsupported` and gains `overlay-unsupported` (renderer scope, `paint: null`), D8-interim, removed with the TypeScript builder.

E11-U4 pointer (section h), 2026-10-24: replaced by E11-U4: the code is `render.path-mesh-failure`, the context has no `interim` key, the message has no `D8-interim:` prefix; outcomes, transport and the `notices` field are unchanged ([E11-U4 addendum](d9-e11-u4-failure-behavior-addendum.md)).

## i) Device loss, generation and lifetime

- **No port call on recovery.** Meshes, fringe variants and packed bytes are CPU caches keyed without the generation. A new generation forces a reconstruct packet whose mesh part writes every occupied path slot's instance record, every served variant's ranges and `meshFrame` from the CPU entries, byte for byte as before the loss. The port is not called while keys match.
- **Generation ownership.** The mesh pipeline, bind group and arena belong to one generation, like the P1 arena. Stale receipts and completions cannot acknowledge or free anything in a new generation.
- **Residency.** A path slot keeps its served variant's ranges while the node lives and the entry is cached, including while hidden or culled, as hidden primitive slots keep their records.
- **Edits during recovery** publish CPU state as today; the first recoverable frame uses the latest accepted scene.
- **Dispose** is terminal and idempotent. It clears the mesh cache, memo, notice queue and slot maps. It does not dispose the port, which the host owns (V1 c).
- **Port outages.** The `disposed` latch persists across generations; it is service state, not GPU state.

Amended 2026-10-21 by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md): overlay variants are reconstructed from CPU entries byte for byte, with no port call and no rebuild.

## j) C04 items for V3

The [carve-out](p3-private-contract.md#private-transport-and-lifetime-requirements) requires the functional renderer packet to say what it fixes. Nothing here is the C04 layout.

| C04 item                         | V3 fixes, functionally                                                                                                                      | Left open                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1. Identity, headers, offsets    | Mesh part version 0, resource order, strides and word offsets in section f; P1 packet unchanged                                             | Final layout and version negotiation                                 |
| 2. Positions, coverage, indices  | K4 midpoint carrier, per-view O-PX(128) origin, u32 vertex pulling, no cull, region/exterior role, local features, frame corners, fill only | M01-M06 certificate, K1 with E1 shared records, fill/stroke ordering |
| 3. Echoes and failure precedence | Renderer-side response validation, per-path versus batch handling and batch isolation (sections b, d, h)                                    | Kernel limits (V2, B1)                                               |
| 4. Arenas and views              | V3 holds only owned port results and reports the adapter's linear memory                                                                    | Kernel arena sharing (V2)                                            |
| 5. Cache identity and eviction   | Key, byte accounting, budget, variant caps, failure classes, memo outside the cache, fringe variants with their own `f` invalidation        | Final budgets after B0; per-cell identity under E2                   |
| 6. Upload and lifetime           | Mesh arena under P1's allocator, generation and receipt meanings; range management; latest-scene reconstruction without port calls          | Tile caches and epoch builds (E2)                                    |

Amended 2026-10-21 by [ST-U6](p3-fill-stroke-meshes.md#b2-st-u6-renderer-stroke) under [B2 stroke contract section 10](p3-b2-stroke-contract.md#10-c04-items-for-the-stroke-transport-and-draw): item 2's "fill/stroke ordering" is now fixed functionally (fill then stroke at one paint position, separate instance records and the opacity staging rule); joint fill and stroke coverage stays open for ST-U7 and the C04 layout.

Amended 2026-10-21 by [ST-U7](p3-fill-stroke-meshes.md#b2-st-u7-joint-coverage) under the [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md): item 2: joint fill and stroke coverage is fixed functionally by ST-U7; the C04 layout stays open.

## k) A08 visual contract

The [execution plan](p3-fill-stroke-meshes.md) defers A08's visual contract to V3. For fill, it is:

- **Rule.** A5 as realized by section e: O02's coverage rule, screen-space distance (Q3) and P1's encoded-sRGB premultiplied blending (Q12).
- **Thresholds.** Q4: interior and exterior within 2/255, edge location within 1 px, at DPR 1, 1.5 and 2, with DPR 3 observed only; and at most one covered sample per variant, as O02's G3.
- **Fringe versus MSAA comparison.** The same scenes render (i) with the fringe at 1x and at 4x and (ii) MSAA-only at 4x: region triangles with `c = 1` and no exterior triangles. Q4 gates apply to (i) only. (ii) is a reported baseline, never accepted output, consistent with `graphics-engine-architecture.md:219` ("MSAA-only output is not considered sufficient for the final path renderer"). This reading of A08's comparison is a full-tier decision made by this contract and is part of its review.

Evidence counts only after C03-C05 on the frozen layout and carrier, as the carve-out says. V4 supplies the harness; V3 supplies only the functional smoke check in V3-A14.

## l) Acceptance criteria and validation

**For this contract.**

| ID    | Criterion                                                                                                                            | Method                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| V3-C1 | Covers V1 f items 1-9 and V2 l without changing anything V1 or V2 fixed. The interpretations below are stated and accepted by review | Independent `reviewer` review, READY                                                                                     |
| V3-C2 | V3-Q1 to V3-Q3 answered by the user; interpretation 3 below reported to the user with them. **Satisfied 2026-10-12**                 | Chat record, transcribed in the [review record](#review-record)                                                          |
| V3-C3 | No requirement, threshold or earlier decision changed; interim items labelled                                                        | Review of the diff                                                                                                       |
| V3-C4 | Documentation checks                                                                                                                 | `pnpm exec prettier --check` with an empty ignore path, local link and anchor check, `git diff --check`, protected PR CI |

**Interpretations recorded under V3-C1.**

1. **V1 P-S2, "an `operationId` or `portVersion` change rebuilds that node only".** "That node only" binds geometry and `fillRule` changes. An `operationId` change makes every key miss, so every drawn path rebuilds once. A `portVersion` other than 0 cannot belong to a v0 port: it is refused at construction, and a change afterwards is the `port-version` state failure, which calls nothing and serves nothing. Either way no old mesh is served, which is P-S2's purpose.
2. **V1 d, "A change of `e` is a cache miss".** It holds for the exact key. The finer-variant fallback of section c is the reuse rule V1 d delegated to V3; it never serves a coarser mesh.
3. **V1 rule 3, one call per frame and "no per-path port call".** It holds for normal preparation. Bisection after `internal-error` or `resource-limit` is the bounded recovery that V2 section l assigns to V3 and that V2 section a permits; its single-request leaves are per-path calls made only to isolate a failure. Because this reads an approved V1 rule narrowly, it is **reported to the user**: the V3-C2 chat record and every V3 PR description state it explicitly. It is not a separate decision; if the user objects, the contract returns to review.
4. **V1 d, "never enters the mesh cache".** It governs `failed` and `batch-failed` port results. Fringe and state failures concern derived or per-frame data; they keep a successful port result cached and are not drawn.
5. **Erratum to V3-A16, recorded at the V3a review.** Adding the section a union member forces type narrowing edits; P1 tests change only by those two type-only edits (`tests/support/p1-visual-oracle.ts` guard, `tests/unit/primitive-native-integration.test.ts` cast); runtime and primitive packet bytes are identical, proven by the golden SHA test reproduced on main 4e6e40d by the reviewer.

**For the implementation.** Unit fixtures use test doubles of `FillMeshPort`: a **counting** double that records every batch and returns meshes from a fixed table, a **failing** double configurable per request and per batch (including a batch `internal-error` triggered by one marked path, as V2's kernel behaves), and a **range** double that answers `invalid-tolerance` outside a configured range. `geometry-reference` may back a double in tests only. Section o assigns each criterion to a unit.

| ID     | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Method                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V3-A1  | P-S1: every row of section a, including the empty-path bounds exemption; D1 precedence (`invalid-value` before graph reasons before `unsupported-feature`); no-port `unsupported-feature`; replay and `revision-conflict` on path data; owned copies; the port shape check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/unit` fixtures on `RetainedSceneMirror` and the service, in `pnpm test:unit`                                                                                                         |
| V3-A2  | Geometry revision: equal republish keeps it; changed points or verbs, reinsertion and kind change take a new value; an identity switch with equal data keeps it; overflow returns `invalid-value` with the previous version and no mutation (counter injected near the limit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Unit fixtures                                                                                                                                                                               |
| V3-A3  | P-S2: color, opacity, order, translation and an `e`-preserving transform make zero port calls; a geometry or `fillRule` change calls once with exactly that node; an `operationId` change rebuilds every drawn path once; a `portVersion` change calls nothing and serves nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Counting double                                                                                                                                                                             |
| V3-A4  | One batch per `prepare`, `requestId` equal to batch index, no call when nothing is missing; hidden, `fill: null`, empty, singular and culled paths call nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Counting double                                                                                                                                                                             |
| V3-A5  | Exact buckets: `e` and `f` equal an independent BigInt brute-force oracle on boundary matrices (scaled identities, 90° rotations, shears, reflections, near-singular, entries near the Float64 extremes), including cases where `Math.log2` of a rounded quotient picks the wrong bucket; the `E_MAX` clamp; `E_MIN` and `f` range state failures with no call; an exact-nonzero determinant whose f32 lanes give zero or the opposite sign                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Unit fixtures; the oracle is test-only code independent of the implementation                                                                                                               |
| V3-A6  | Reuse rule: after a build at `e`, buckets `e + 1` and `e + 2` serve it with no call; `e + 3` and `e − 1` call; a coarser entry never serves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Counting double                                                                                                                                                                             |
| V3-A7  | Accounting equals the sum of owned `byteLength`s, per entry and per variant (corners included); `portLinearMemoryBytes` reports the injected hook; unreachable entries drop at once; variant caps; budget eviction with a working-set exemption under a lowered test budget; `overBudgetFrames`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Unit fixtures with injected budget and hook                                                                                                                                                 |
| V3-A8  | P-S3 and failure classes: a port-failed path is not drawn and not cached, other nodes draw in order, one notice per memo entry, 100 further frames make no call for that key, a key change calls once; one `internal-error` path in a batch of 16 is isolated within `2·⌈log2 16⌉` extra calls, in depth-first left-first order, and the other 15 draw; a failing leaf is memoized before the next call; **all paths defective, n = 1000**: every `prepare` makes at most 32 calls and settles at least one new key, no key is memoized twice, the next `prepare` resumes from the DFS stack without re-calling a known-failing range, drops requests whose node vanished or whose key changed, and calls no new key until the stack is empty, and all 1000 keys are memoized after at most 1999 calls in total; notice caps: at most 32 notices per packet, the queue capped at 4,096 with `noticesDropped` counting overflow, and queued notices kept across a throwing `prepare`; `resource-limit` expiry after 256 calls; the `disposed` latch; memo cap, eviction and `memoOverCapFrames`; a `fringe-unsupported` variant keeps the mesh cached and a different `f′` retries; `packing-range` and `tolerance-range` keep the mesh, make no call, and notify only on state transitions | Failing double                                                                                                                                                                              |
| V3-A9  | Response validation: every `invalid-response` and `invalid-mesh` case gives the renderer-scope notice and no draw; a throwing port is `invalid-response`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Failing double with malformed results                                                                                                                                                       |
| V3-A10 | Mesh part bytes: section f strides and offsets; `u = fround(v − m)` with `m` from bounds; corners on the outward binary32 grid with the exact margin; anchors and `σ`; mesh frame; O-PX(128) with R3's inputs, including its rebase counts on R3's TR-PAN trajectory at zoom 1, DPR 1; receipts with and without a mesh part; a receipt with a mismatched mesh part acknowledges nothing; the shared-`meshFrame` failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Golden fixtures in `tests/unit`                                                                                                                                                             |
| V3-A11 | Fringe: exact partition of region plus exterior on F01-F11, a bowtie pinch, an even-odd star and a zero-closure case, checked by O02's independent `checkPartition`; lists contain every feature within `ρ` (brute force); frame margin at least `ρ`; `fringe-unsupported` on degree > 6; `fringe-range` on a non-finite corner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Unit tests importing `tests/geometry/coverage-oracle/exterior.ts` as the oracle                                                                                                             |
| V3-A12 | Paint order: `[rect, path, rect, path, rect]` gives analytic, mesh, analytic, mesh, analytic with adjacent analytic ranges; a hidden, culled or failed path between two rectangles leaves one merged analytic draw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Unit fixtures                                                                                                                                                                               |
| V3-A13 | Backend: accepts packets with and without a mesh part; rejects a bad `position`, mesh ranges beyond capacity and a zero `triangleCount` as `invalid-packet`; creates the mesh pipeline at initialization and recovery only when `requiresMeshPipeline` is true, never in a frame, and never for a source that omits the flag; checks both limits, and with a limit below 5 or 6 (or a failed pipeline creation) submits the P1 part, skips mesh draws and writes, returns a `skipped` mesh receipt and emits `mesh-pipeline-unavailable` once per generation; emits each notice once with the section h context even for a stale generation, up to the 32 a packet carries; first-fit placement, fragmentation repacking, range release after the last referencing packet, `markSubmitted` on both arenas, and old and new arena accounting during growth                                                                                                                                                                                                                                                                                                                                                                                                                                  | `renderer-webgpu` unit tests with the existing fake device seams; `webgpu-backend.test.ts`                                                                                                  |
| V3-A14 | Headed functional smoke, labelled UNVERIFIED (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A new spec in the existing `pnpm test:gpu` configuration, headed Chrome and Edge; GitHub CI cannot run it                                                                                   |
| V3-A15 | Device loss in unit form: a generation change yields a reconstruct packet whose mesh writes equal the pre-loss bytes, with zero new port calls (CPU part in V3a, packet part in V3b)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Counting double                                                                                                                                                                             |
| V3-A16 | Primitive-only packets are byte- and shape-identical to `main` before V3, and every P1 unit test, GPU spec, position probe and runner case passes unchanged; `renderer-core` imports only `contracts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Golden comparison against the pre-V3 source; `pnpm check`, `pnpm build`, `pnpm test:geometry`, existing `pnpm test:gpu` P1 specs, `git diff` showing no edits to P1 tests, probes or runner |
| V3-A17 | Evidence label: the PR, plan entry and every headed artifact carry the UNVERIFIED statement and claim no Q4 threshold                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Review of the PR and artifacts                                                                                                                                                              |
| V3-A18 | No host injects a port before V3c: `apps/playground` constructs no service with `fillMesh` until V4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Reviewer diff check in V3a and V3b                                                                                                                                                          |

**V3-A14 details.** A fixture page under `apps/playground` uses a static test-double port, no WASM, and draws:

- F02 under both fill rules;
- a path between two rectangles;
- a half-opacity path over an opaque primitive;
- the same scene under a 30° rotation, a reflection (`a = −1`), and a nonuniform scale of 3 by 0.5;
- at 1x and 4x, at DPR 1 and 2.

The checks:

- Pixel centers at least 3 physical px from every boundary must be within 2/255 of the analytic interior or exterior color.
- The overlap pixel must be within 2/255 of the single-opacity value `P + dst·(1 − P.a)`, and must differ from the double-opacity value by more than 20/255.
- After injected device loss, the probed pixels must equal the pre-loss capture exactly, with zero new port calls.

Edge pixels are captured, not gated. If headed hardware is unavailable, V3-A14 is marked UNVERIFIED in the plan, not weakened.

## m) Risks

- **Class A on K4.** Far-offscreen vertices and feature endpoints enter f32 at large magnitude, and GPU clipping is implementation-defined, as D8 states. Visible artifacts there are expected, not defects of V3.
- **No certificate.** Without M01-M04, f32 rounding can invert thin exterior or region triangles and break the partition (double coverage or holes). The CPU partition check is exact only on the preimage.
- **O02 PASS does not transfer.** Shader-side f32 feature mapping differs from O02's host-rounded features.
- **CPU cost.** BigInt predicates and ear clipping cost roughly quadratically per path. B0's E3 and E4 measure them after V3. V3 makes no performance claim.
- **Fragment cost.** Each fringe fragment maps every listed feature. Anisotropic transforms enlarge `ρ` in screen space, and so the lists and the overdraw.
- **Memory.** The 64 MiB cache budget, a working set above it, and the adapter's linear memory of up to 256 MiB, which never shrinks, together may exceed the prototype ceiling. A one-path `resource-limit` is retried every 256 prepares, which costs one bisection each time. V3 reports these totals; B0 sizes them.
- **Split cost.** Bisection re-sends successful requests in sub-batches, so a frame that isolates a failure can spend about `log2(n)` times the tessellation work of the original batch, up to the 32-call bound. That frame can be visibly slow. B0's E3 should observe it; no performance claim is made.
- **Resumption delay.** While a DFS stack is being resumed, new keys wait. In the all-defective case with n = 1000, settling needs at most 1999 calls, so new paths can wait about 63 frames (1999 / 32) before their first port call.
- **P1 hot path.** The optional mesh part touches primitive preparation and submission. V3-A16 and the P1 specs guard bytes and visuals. P1 A09 and A10 stay UNVERIFIED, and no P1 performance claim is made.
- **Rework.** The mesh part, the carrier and the fringe builder are disposable under the carve-out; K1 and C04 may replace them.
- **Public debt.** The interim diagnostic code must be removed before P3 acceptance.

E11-U4 pointer (section m), 2026-10-24: settled: no interim diagnostic code remains (E11-U4-A1).

## n) Decisions for the user

Each lists the recommended option first. Technical choices inside approved directions (exact buckets, the reuse window, failure classes, cache budgets, the mesh part, vertex pulling, the per-view R3 origin) are Primary decisions, stated above.

**V3-Q1. Does the O02 complement-triangulation fringe become the production realization of A5?**

| Option                                    | What it means and its consequences                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: conditional adoption** | Adopt it as the production direction, first realized on K4 in V3c. Adoption stands only if three follow-up results support it: V3-A14 shows no double coverage and the expected interior, exterior and overlap values; B0's E4 draw cost after V3 is within its feasibility rule; and the R2 contract keeps a per-tile complement partition for K1. If any of them fails, the decision returns to the user. It is the only realization with G1-G3 evidence |
| (b) Interim only                          | Use it for V3 and V4 and leave production open for R2 and C04. V3 is unchanged, but K1 must reopen the A5 realization, and V3's fringe code is more likely to be discarded                                                                                                                                                                                                                                                                                 |
| (c) No fringe in V3                       | Region triangles with MSAA only. Edges are aliased, unlike the approved A5, so V4 screenshots would not show the intended quality. It needs its own interim exception, and V3c shrinks to nothing                                                                                                                                                                                                                                                          |
| (d) Per-edge quads (O01)                  | Corner overlaps double-cover samples, so node opacity is applied twice there, against D2 and Q9. Not viable                                                                                                                                                                                                                                                                                                                                                |

**V3-Q2. Which failures beyond V1-Q4 may use the D8-interim outcome?** V1-Q4 approved it for paths the kernel cannot mesh: per-path port failures, and a one-path `internal-error` after isolation. This question covers the rest: batch codes `resource-limit` (isolated to one path), `invalid-request` and `disposed`, and the renderer codes of section h.

| Option                                                                       | What changes                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Recommended: all of them**                                             | Each hides only the affected paths and emits the same D8-interim code with scope `batch` or `renderer`, under the same removal condition. Every notice names the node, except `mesh-pipeline-unavailable`, which concerns the whole mesh path and has `nodeId: null`. Section h stands as written |
| (b) P1's rule for renderer and batch codes                                   | They fail the whole packet with `render.submission-failed`, so primitives also stop drawing for that frame. Sections d and h lose the state class; U4 allows that code only as a last resort, so this needs that U4 exception too                                                                 |
| (c) As (a), but `fringe-unsupported` draws region triangles without a fringe | The path stays visible with aliased edges and opacity applied once. It adds a second interim visual behavior, a `c = 1` region-only draw mode in V3b's shader, and a separate removal item                                                                                                        |
| (d) Skip silently                                                            | No notice for these codes; hosts see paths vanish. Rejected already for V1-Q4                                                                                                                                                                                                                     |

**V3-Q3. Where is the exterior fringe triangulation computed?** The port v0 result carries only the region mesh, and `renderer-core` cannot import the kernel. In every option the TypeScript builder, if used, is the exact BigInt builder of section e: it adds no fill region, moves no vertex, adds no Steiner point, and every result passes the exact partition check.

**Scope of the question.** V3-Q3 asks about **production** placement, so it applies only if V3-Q1 is (a). Under V3-Q1 (b), V3 and V4 use the TypeScript builder as a D8 interim, exactly as in option (c) below, and production placement goes to R2/K1 with the realization itself. Under V3-Q1 (c) or (d), there is no builder and V3-Q3 is moot.

| Option                                                                | What it means and its consequences                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(c) Recommended: TypeScript builder as a D8 interim only**          | V3 and V4 run the builder in `renderer-core`, labelled D8-interim and disposable under the carve-out, like the K4 carrier. This is a time-bounded D8-interim exception to `ARCHITECTURE.md:52-54` (the Rust/WASM kernel implements the geometry contract, including tessellation) and to the private contract's line 8 ("Keep Rust as the production geometry owner"), in the same pattern as V1-Q4's interim exception. The exception is recorded in the `graphics-engine-architecture.md` update. It ends when the R2/K1 contract decides production placement; that contract owns the per-tile exterior partition anyway. Neither text is amended, and no port change or ADR is needed now. V3c can start after the user's answer. Consequences: the production question stays open until R2/K1; the interim builder may be thrown away; CPU cost in JavaScript BigInt in the meantime |
| (a) TypeScript builder in `renderer-core` as the production placement | Framed as derived coverage attributes and recorded by a new ADR 0003 and a `graphics-engine-architecture.md` update. Choosing it **amends** `ARCHITECTURE.md:52-54` ("Owns renderer-independent requests and results for bounds, flattening, tessellation, … The Rust/WASM kernel implements this contract") and the [private contract](p3-private-contract.md)'s line 8 ("Keep Rust as the production geometry owner"), so both join the update table. No port or V1 change. Consequences: a second exact-geometry code base in production; correlated-bug risk with O02's test-only triangulator, mitigated because the independent partition check, not the triangulator, is the oracle                                                                                                                                                                                                |
| (b) The Rust kernel produces the exterior                             | Delivered through a later port version, which needs a V1 port amendment and a V2-like kernel contract. It keeps Rust as the production geometry owner and changes no architecture text. Consequences: V3c waits for that amendment and its kernel work. The frame depends on `f`, so either `f` joins the request and zoom changes call the port (an amendment to P-S2), or the kernel uses a fixed generous margin with more overdraw. Kernel caps then also limit fringe size                                                                                                                                                                                                                                                                                                                                                                                                           |

**Why (c).** It leaves both approved texts unamended, needing only a time-bounded interim exception with a fixed removal point, and it still unblocks V3c now. (a) amends two approved texts permanently on the strength of a K4 interim, before K1 knows whether a per-tile fringe even fits in TypeScript. (b) keeps the architecture but stalls V3c behind a port amendment. (c) defers the production choice to R2/K1, the contract that has to design the tiled exterior partition anyway. The user decides; if production placement is wanted now, (a) is the faster of the two production options and (b) the more conservative.

## o) Implementation units

One frozen contract, three ordered units. Each is its own PR with its listed criteria.

| Unit    | Content                                                                                                                                                                                                  | Criteria                                               | Needs from the user              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------- |
| **V3a** | No GPU: scene node, mirror options, validation, geometry revision, service options and port consumption, batch isolation, buckets, cache, failure classes and memo, diagnostic code and notices queue    | V3-A1 to V3-A9, the CPU part of V3-A15, V3-A16, V3-A18 | V3-Q2 (codes beyond V1-Q4)       |
| **V3b** | The optional mesh part and receipts, the mesh arena, range management, the mesh pipeline created at initialization and recovery, region-triangle draws with `c = 1`, paint-order interleave, device loss | V3-A10, V3-A12, V3-A13, V3-A15, V3-A16, V3-A18         | V3-Q2                            |
| **V3c** | The fringe builder at the placement V3-Q3 selects, exterior triangles, features and lists, and the coverage shader; the headed smoke                                                                     | V3-A11, V3-A14, V3-A17                                 | V3-Q1, and V3-Q3 if V3-Q1 is (a) |

No host can reach region-only drawing before V3c. The only host, the playground, gains the port in V4, which needs V3c (V3-A18), and V3b's region-only mode is reachable only from tests. V3a and V3b therefore add no visible behavior beyond V3-Q2.

**Owning-document updates delivered with V3.**

| Document                                  | Update                                                                                                                                                                                                                                                                                                                                                                      | Unit      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `docs/graphics-engine-architecture.md`    | Anti-aliasing: the A5 realization per V3-Q1, the fringe placement per V3-Q3, and under V3-Q3 (c) or V3-Q1 (b) the time-bounded D8-interim exception to `ARCHITECTURE.md:52-54` and the private contract's line 8, with its removal at the R2/K1 placement decision, fringe cache identity (`f`, the variant rule); Primitive rendering: the mesh draw beside analytic draws | V3c       |
| `docs/decisions/0003-*.md`                | Only if V3-Q3 is (a): the fringe-builder placement ADR                                                                                                                                                                                                                                                                                                                      | V3c       |
| `ARCHITECTURE.md`                         | Only if V3-Q3 is (a): amend the Geometry contract paragraph (lines 52-54) to name the renderer-side coverage-attribute builder                                                                                                                                                                                                                                              | V3c       |
| `docs/plans/p3-private-contract.md`       | Only if V3-Q3 is (a): amend line 8 ("Keep Rust as the production geometry owner") with the same exception                                                                                                                                                                                                                                                                   | V3c       |
| `docs/plans/p1-private-contract.md`       | One pointer sentence in "Packet v1 envelope": the optional `mesh` packet field, the optional `mesh` receipt part (`submitted` or `skipped`) and the optional `requiresMeshPipeline` source flag (default `false`) are owned by this contract; v1 fields unchanged                                                                                                           | V3b       |
| `docs/plans/p3-fill-stroke-meshes.md`     | V3 status rows; the A08 row points to section k                                                                                                                                                                                                                                                                                                                             | each unit |
| `docs/validation.md`                      | The `pnpm test:gpu` row names the V3 mesh smoke spec                                                                                                                                                                                                                                                                                                                        | V3c       |
| `packages/contracts` (scene, diagnostics) | Section a and section h code                                                                                                                                                                                                                                                                                                                                                | V3a       |

## V2 dependencies

All are now settled by the [frozen V2 contract](p3-v2-fill-mesh-transport-contract.md):

- **Exponent range.** `-1021..=1023` (V2 d), mirrored by `renderer-core`'s internal `E_MIN` and `E_MAX`. A port's `invalid-tolerance` stays authoritative.
- **Port types.** V2 lands them in `packages/contracts/src/geometry.ts`; V3a starts after that merge.
- **`boundaryEdges`.** V2 f's conforming refinement makes them exactly the region-boundary edges, as the fringe builder requires.

  Amended 2026-10-20 by the [Alt-A1 production contract](p3-alt-a1-fill-ladder-contract.md): for fast-rung meshes, `boundaryEdges` are the edges used once in an unrefined conforming mesh (that contract's section 3.5); they are exactly the region-boundary edges, as before.

- **`internal-error`** does not dispose the adapter, and V3 isolates the path (section b).
- **Linear memory** is reported through the host hook (section d).
- **Determinism** (V2 c) supports the memo's no-expiry rules.
- **MOVE-only subpaths in curved paths** are `unsupported-geometry` in v0 (V2 e) and reach the interim outcome under V1-Q4.

## Ownership

Primary owns this contract, the packet and draw design, the fringe builder's exact arithmetic and the integration. An `implementer` may take bounded files per unit after freeze. A fresh-context `reviewer` reviews this draft, each unit's stable source and the evidence.

## Review record

- **Independent review, round 1.** A fresh-context `reviewer` returned NOT READY with five blocking items, all addressed in revision 2:
  - B1, the exponent range belonged to V2: now internal constants equal to V2 d, with no contracts export;
  - B2, failures were cached or memoized regardless of what they depend on: now three failure classes, with V2's `internal-error` isolated by bisection;
  - B3, fringe placement in `renderer-core` needed an architecture decision: now user decision V3-Q3, with the ADR and architecture update as deliverables;
  - B4, bumping the P1 packet to version 2 touched P1 tests and probes: now an optional mesh part with P1 v1 unchanged;
  - B5, the frame corners were undefined: now stored per variant, after the port vertices, on an outward binary32 grid, with `fringe-range`.
- **SHOULD-FIX S1-S15 applied:** the V3-C1 interpretations; the overflow result; the f32 determinant disagreement; pipeline creation at initialization; the bindings limit; R3's inputs; numeric tolerances and transforms in V3-A14; the added tests; the owning-document list and the MSAA comparison decision; GPU range management; receipts; bit-length starts; V3-Q2 and V3-Q1 wording; the empty-path exemption; run merging across undrawn paths.
- **Minor items applied:** the EDGE record row in "What differs", the `fringe-range` name, memo behavior beyond 4,096, and the memory and retry risk. The implementation is split into units V3a-V3c.
- **Independent re-review, round 2.** NOT READY with two blocking items, both addressed in revision 3:
  - R1, V3-Q3 did not say what option (a) amends: it now names `ARCHITECTURE.md:52-54` and the private contract's line 8 (both join the update table if (a) is chosen), adds option (c), a D8-interim builder with production placement deferred to R2/K1, now recommended because it alone keeps the approved architecture while unblocking V3c, and makes V3-Q3 conditional on V3-Q1 (a);
  - R2, batch splitting had no progress guarantee: splitting is now normative depth-first, left-first, failing leaves are memoized at once, every `prepare` that calls the port settles at least one key (`d + 1 ≤ 27 ≤ 32` within V2's input cap), unreached ranges resume next `prepare`, and V3-A8 adds the all-defective n = 1000 case.
- **SHOULD-FIX SF-1 to SF-5 applied:**
  - `requiresMeshPipeline` is optional and defaults to `false`; attaching after initialization stays an error; the flag is in the P1.0b pointer;
  - interpretation 3 is reported to the user under V3-C2 and in every V3 PR;
  - notice-cap tests are in V3-A8 and V3-A13;
  - a split-cost risk entry is added;
  - a binding limit below 6 now drops only mesh draws, as a state failure with a `skipped` mesh receipt, and primitives still draw.
- **Minor item applied:** a `port-version` state failure emits one notice per drawable node.
- **Independent re-review, round 3.** READY. Its pre-freeze fixes are applied:
  - SF-A: V3-Q3 (c) is now described as a time-bounded D8-interim exception to `ARCHITECTURE.md:52-54` and the private contract's line 8, recorded in the graphics-architecture update and removed when R2/K1 decides placement, rather than as keeping every statement as written;
  - SF-B: the progress guarantee rests on a renderer-side bound of 2^31 requests per call (`d + 1 ≤ 32`), not on V2's caps;
  - SF-C: resumption works from the DFS stack of untried ranges, never re-calls a known-failing range, drops vanished nodes and changed keys, and a risk line covers the wait for new keys (about 63 frames when all 1000 paths are defective).
  - Minor items: a source stops producing mesh draws and writes after its first `skipped` receipt in a generation; V3-Q2 (a) notes that `mesh-pipeline-unavailable` alone has no node; the backend's diagnostic is outside the notice caps.
- **User decisions, 2026-10-12, in chat.** The user chose the recommended option for each:
  - V3-Q1 (a): conditional adoption of the O02 complement-triangulation fringe as the production direction for A5;
  - V3-Q2 (a): all listed batch and renderer failures use the D8-interim outcome;
  - V3-Q3 (c): the TypeScript builder runs as a D8 interim only, under a time-bounded exception to `ARCHITECTURE.md:52-54` and the private contract's line 8, and production placement is decided in R2/K1.

  Interpretation 3 under V3-C1 (batch bisection read against V1 rule 3) was reported to the user in the same message.

- **User decision, 2026-10-20, in chat (note on V3-Q2).** 2026-10-20 user decision: V3-Q2 (c) for `fringe-work-cap` — ratified after the V4 post-merge review. A path above `fringeBoundaryVertexCap` (128) boundary vertices draws region-only, with the one `fringe-work-cap` notice per cache entry (section h's amendment). The 2026-10-12 V3-Q2 (a) decision above stays as written for every other code.

- **V3a review notes.** Section c's guard row "`e > E_MAX`: request `E_MAX`" is dead in practice: `e > E_MAX` needs `sigmaMax(S) < 2^-1026`, so `sigmaMin ≤ sigmaMax` gives `f ≥ 1028 > F_MAX`, and the `fringe-range` state applies first. The row stays as written; no contract change. The V3-A16 erratum is interpretation 5 under V3-C1.
- **What approval does not do.** It closes no A01-A08 criterion and no C03-C05 item. V3-Q1's adoption stays conditional on its three follow-up results: V3-A14, B0's E4 draw cost and the R2 per-tile partition.
