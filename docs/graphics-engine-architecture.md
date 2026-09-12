# Graphics engine architecture v0.1

Status: Accepted for prototype

This document is the source of truth for graphics-engine internals. Top-level ownership and dependency direction are defined by `ARCHITECTURE.md`; P0 execution details are defined by `docs/plans/p0-webgpu-foundation.md`.

## Decision

Vector Studio will own its vector rendering engine. It will not use PixiJS, CanvasKit/Skia, Konva, Fabric.js, Three.js, Paper.js, or another library's scene graph or vector renderer.

The prototype is GPU-first:

- WebGPU is the first rendering backend.
- Rust compiled to WebAssembly is the geometry kernel.
- TypeScript owns browser integration, GPU orchestration, the editor API, and extension boundaries.
- WebGL2 is a future backend, not a prototype requirement.

The renderer is downstream of the document model. GPU resources and WASM objects are caches and can always be rebuilt from document data.

## Dependency policy

Allowed dependencies are build/test tools, generated Web API bindings, `wasm-bindgen`-class interoperability support, and small general-purpose utilities accepted through an explicit review.

Runtime drawing engines, retained scene graphs, path renderers, and third-party tessellation engines are not permitted by default. A future exception requires an architecture decision record explaining ownership, format compatibility, performance, licensing, and replacement cost.

## Major boundaries

```text
Editor core
  -> RenderChangeSet
    -> Retained render scene
      -> Visibility and draw-list builder
        -> WebGPU backend

Path records
  -> Geometry batch request
    -> Rust/WASM geometry kernel
      -> Mesh and bounds views
        -> GPU resource cache
```

### Editor-to-renderer contract

The editor sends incremental semantic changes, not framework objects or GPU commands.

The user-approved [P1 D1 contract](plans/p1-instanced-primitives.md#d1--approved-scene-and-packet-contract) replaces the earlier reserved example. It defines full snapshot initialization, document/page identity, atomic base/result-revision changes, deterministic graph validation, replay/resynchronization and CPU-copy ownership. The approved camera operation has a separate transient revision; surface/DPR ownership stays with the concrete backend. P1.1 implements the CPU scene synchronization exports and retained mirror; [its review](evidence/p1.1-scene-review-2026-09-12.md) bounds the evidence. P1.4 composes the core-owned service/packet source with the existing backend's native consumption and lifecycle; [its review](evidence/p1.4-integration-review-2026-09-12.md) proves unit-level integration only. The [P1.5 review](evidence/p1.5-visual-review-2026-09-12.md) now supplies headed primitive/overlap/precision and latest-scene recovery output. This correctness evidence does not change architecture or establish the pending P1 performance/measurement gates.

The renderer maintains a mirror keyed by node ID and updates affected transforms, styles, geometry, ordering and bounds. Device recovery rebuilds the latest accepted CPU state without replaying document commands. Private draw-packet layouts and precision/rebase budgets are fixed in the [P1.0b contract](plans/p1-private-contract.md) before implementation.

### Backend contract

The common boundary is a render scene and draw packets, not a lowest-common-denominator wrapper around WebGPU/WebGL calls.

| Boundary                             | Input and responsibility                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Editor -> renderer service           | Scene snapshots/change sets, viewport, invalidation, lifecycle, diagnostics     |
| Renderer core -> backend             | Ordered draw packets and resource descriptors prepared from the retained mirror |
| Composition root -> concrete backend | Browser surface acquisition and concrete adapter construction                   |

`applyChanges(RenderChangeSet)` belongs to the renderer service, not the low-level GPU backend. GPU resource types stay private to `renderer-webgpu`; concrete surface acquisition must not introduce DOM types into editor-facing contracts. The [P1.0b contract](plans/p1-private-contract.md) fixes the private packet envelope and byte layouts before implementation. The P1.4 composition attaches one core packet source before backend initialization. `WebGpuBackend` retains its single scheduler/device lifetime and selects the primitive path when attached; its existing foundation path remains available for P0 regression. The host owns the service and backend lifetimes. This internal composition seam does not replace the D1 scene port. See [ADR 0001](decisions/0001-port-composition.md).

## Coordinate and numeric policy

- Document and geometry-kernel calculations use 64-bit floating point.
- GPU vertex, instance, and uniform data use 32-bit floating point unless precision testing requires another representation.
- Nodes store a 2D affine transform plus geometry-specific dimensions.
- Derived world matrices and bounds are runtime caches.
- Rendering uses camera-relative coordinates when large world coordinates begin to lose 32-bit GPU precision.
- All document-to-screen and screen-to-document conversions are centralized and testable.

## Path representation

The persistent path model contains subpaths made from four canonical verbs:

- `moveTo(x, y)`
- `lineTo(x, y)`
- `cubicTo(c1x, c1y, c2x, c2y, x, y)`
- `close()`

Quadratic curves and arcs from future importers are normalized into cubic segments. A path also declares `nonzero` or `evenodd` fill behavior.

The runtime packed form uses separate typed buffers:

```ts
interface PackedPathBatch {
  verbs: Uint8Array;
  points: Float64Array;
  pathOffsets: Uint32Array;
  pointOffsets: Uint32Array;
}
```

Document JSON never stores WASM pointers or the packed runtime representation.

## WASM boundary

The boundary is coarse-grained. JavaScript must not call WASM once per node, segment, or frame when a batch can be processed in one call.

Initial kernel responsibilities:

- Tight local bounds for primitives and paths
- Cubic evaluation and extrema
- Adaptive curve flattening
- Fill tessellation with holes and both fill rules
- Stroke tessellation for required joins and caps
- Geometry hit testing
- Snap geometry extraction

Inputs are copied or written into preallocated WASM linear memory in batches. Outputs are exposed as typed-array views over stable allocations. Memory growth invalidates existing views, so the host refreshes views after growth and the kernel offers an explicit reserve operation.

```ts
interface GeometryBatchResult {
  vertices: Float32Array;
  indices: Uint32Array;
  drawRanges: Uint32Array;
  bounds: Float64Array;
}
```

The cache key includes node geometry revision, stroke-style hash, fill rule, and a quantized tolerance/zoom bucket.

Before P2 implementation, its plan must define ABI versioning, offset units and terminal offsets, bounds checks, allocation ownership/release, and typed-view lifetimes after reserve, growth, or another batch. Results carry source revisions so stale work cannot replace newer geometry. A transform-only cache hit is valid only while the required screen-space tolerance remains in the cached bucket; scale, shear, or DPR changes may require a finer mesh. Numeric fixtures must include those transitions and non-finite input rejection.

## Retained render scene

The render scene stores only data needed for output:

- Node ID and render kind
- Local/world transform revisions
- Local/world bounds
- Visibility and opacity
- Clip ancestry
- Style handle
- Geometry-cache handle
- Document paint order

Selection, tools, commands, and document semantics remain outside it.

The display list preserves painter's order. Batching only combines adjacent compatible work or uses instance/style indexing that preserves visible order. Transparent nodes must never be reordered merely to reduce draw calls.

## Primitive rendering

Rectangles, rounded rectangles, ellipses, and simple lines use shared unit geometry with per-instance transforms and style data. Analytic shader distance is preferred for primitive edges and independent corner radii.

Arbitrary path fills and strokes use WASM-produced meshes. A geometry-only change rebuilds the mesh; a transform-only change updates instance data without retessellation while the cached tolerance remains sufficient.

Style data is stored separately from geometry so color and opacity changes do not rebuild vertices.

## GPU resource strategy

- Persistent buffers use suballocation rather than one GPU buffer per node.
- CPU-side records track allocation ranges and revisions.
- Uploads are coalesced once per animation frame.
- Static geometry is reused until its cache key changes.
- Pipeline creation is cached and never performed in the hot interaction path.
- Render only on invalidation while idle; use `requestAnimationFrame` continuously during interaction or future animation playback.
- Device loss invalidates GPU caches and reconstructs them from the retained render scene.

## Culling and hit testing

A CPU spatial index is maintained from world bounds. It supports viewport queries, marquee selection, coarse pointer candidates, and snapping candidates.

Precise hit testing is performed by the geometry kernel. GPU color picking is not the initial source of truth because editor semantics require tolerances, stroke-aware selection, locked/hidden filtering, and overlap cycling.

## Anti-aliasing

The initial quality strategy is:

- Four-sample MSAA where supported
- Analytic edge coverage for primitive shaders
- Screen-space coverage fringe for arbitrary path meshes
- Zoom-aware flattening tolerance targeting no more than 0.25 screen pixel of geometric error

MSAA-only output is not considered sufficient for the final path renderer. Quality is tested at fractional positions, rotations, thin strokes, extreme zoom, and high device-pixel ratio.

## Clipping

- Axis-aligned screen-space frame clips may use scissor rectangles.
- Transformed rectangular clips and arbitrary masks use stencil operations.
- Nested clip behavior must preserve document paint order.
- The prototype supports a documented maximum clip nesting depth of 32.
- Offscreen textures are reserved for future filters, blend isolation, and cases stencil cannot represent.

## Text reservation

Text is not part of the first graphics-kernel milestone. The architecture reserves separate font, shaping, layout, glyph-atlas, and text-input services.

Committed text will eventually render through GPU glyph atlases, while active editing uses a DOM overlay. No DOM or browser font object enters persistent document data.

## Approved P1 visual behavior

On 2026-09-09 the user approved [P1 D2](plans/p1-instanced-primitives.md#d2--approved-p1-visual-behavior): straight-alpha sRGB input, encoded-sRGB premultiplied source-over on a non-sRGB unorm target/view, and primitive opacity applied once after local fill/stroke composition. The linked contract fixes canvas configuration, blend factors, coverage and compositing formulas, local-space stroke transforms, radius normalization and degenerate-input behavior.

P1 structural containers support transform/visibility and require opacity 1. Non-unit container opacity rejects the transaction; descendant alpha multiplication is not a substitute. Future non-unit container opacity requires isolated composition and its own implementation plan. This does not remove the MVP appearance requirement or add offscreen composition to P1.

## Design gates before later implementation

The remaining decisions below must be resolved with acceptance fixtures in the owning milestone plan. P1 D1/D2 are approved above; their private layouts and precision/rebase budget are frozen in the [P1.0b contract](plans/p1-private-contract.md) before implementation. Under user-approved [D4](plans/p1-instanced-primitives.md#d4-approved-entryexit-separation), executable measurement methods remain prerequisites for measurement implementation and final acceptance, rather than renderer implementation entry. They are not implemented features or permission to choose silent fallback behavior.

| Owner             | Decision required before implementation                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1                | Coordinate conventions, supported coordinate/zoom ranges, inverse-transform failure behavior, and camera-relative precision fixtures                                                                 |
| P2/P3             | Convert the 0.25-screen-pixel error target to a defined CSS or physical pixel unit, account for world transform and DPR, and bound flattening/tessellation work on degenerate and adversarial inputs |
| P3                | Dash units/phase, miter limit, zero-length segments, coincident edges, self-intersections, and independent reference fixtures for both fill rules                                                    |
| P4                | Mask coverage semantics, stencil push/pop and sibling restoration, attachment format, antialiasing of mask edges, and interaction with container opacity; validate depths 0, 1, 32, and rejected 33  |
| Post-P5 text plan | Font loading/fallback and shaping ownership, matching DOM/GPU layout, Korean IME composition transactions, and selection/caret fixtures                                                              |

## Failure and capability behavior

The prototype requires a secure context and a usable WebGPU adapter. Unsupported devices receive an explicit capability error rather than a silent Canvas fallback.

Initialization records adapter limits and selected features. Validation errors, uncaptured GPU errors, out-of-memory conditions, and device loss are surfaced through structured engine diagnostics.
