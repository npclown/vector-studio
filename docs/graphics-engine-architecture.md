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

P2 concretizes these obligations in the [private geometry contract](plans/p2-private-contract.md) and [execution plan](plans/p2-geometry-kernel.md). Its results are local Float64 flattened paths, bounds and validation provenance; the mesh example above remains a later tessellation boundary. P2 introduces no public GeometryPort or renderer dependency. The kernel owns one explicitly reserved arena; host-retained results and caches own copies, and every mutating kernel call invalidates borrowed views.

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

Amended 2026-10-21: for the joint draw of a path with fill and stroke at node opacity below 1, the extended D8-interim exception in the anti-aliasing section ([P3 joint fill and stroke coverage](#anti-aliasing)) departs from this sentence.

Under the [V3 contract](plans/p3-v3-renderer-mesh-pipeline-contract.md) (fill only, D8 interim), each drawn path mesh is one non-indexed, vertex-pulling draw of its region and fringe triangles with a second pipeline. These mesh draws sit beside the analytic primitive draws in paint order: a path draw closes the current analytic run (section [g](plans/p3-v3-renderer-mesh-pipeline-contract.md#g-paint-order-and-composition)). The mesh data travels in an optional packet part, so a primitive-only packet is unchanged.

**P3 fill operation `'geometry-wasm/fill-v0+r2'` (2026-10-20, [Alt-A1 production contract](plans/p3-alt-a1-fill-ladder-contract.md)).** The fill export runs a two-rung ladder per path. The fast rung certifies the flattened polygon against the source curves with an exact clearance and monotone sufficient condition, and then triangulates the polygon by monotone decomposition, with no Steiner points. Every decision is an exact predicate or a proved interval bound. Any case it does not prove, including crossings, touching and coincident contours, falls back to the exact arrangement kernel unchanged, which also serves as the test oracle. One output per path; equal requests take the same rung. No dependency is added and the port is unchanged; the operation identity changes, so cache keys miss once. Update 2026-10-25 (`'geometry-wasm/fill-v0+r3'`, [E14 contract](plans/d9-e14-fill-rung0-edge-cap-contract.md)): the fast rung's flattened polygon may have up to 8,192 edges, while the exact rung keeps its 256-edge cap; a bounded work count adds the fast-rung fallback reason `WORK`.

**P3 stroke operation `'geometry-wasm/stroke-v0'` (2026-10-20, [B2 stroke contract](plans/p3-b2-stroke-contract.md)).** The stroke export outlines each path as positively oriented convex pieces, built from shared sample triples and decided by exact predicates. The pieces are line sweeps, joins, caps and point caps, plus, since ST-U4, cubic pieces. Each cubic's stationary points are classified exactly first. The cubic is then split into guarded de Casteljau leaves, and a cusp disk is added at each interior reversal. It then resolves their union with the existing exact arrangement under nonzero at `τ = 2^(e−2)`, followed by V2's refinement and boundary checks, unchanged. The output has the fill mesh's form. The export is its own `stroke_v0_*` family with its own engine and workspace, and it shares no state with the P2 or fill engines. The Alt-A1 fast rung is not used for strokes. Since 2026-10-21 the operation is revision 2, `'geometry-wasm/stroke-v0+r2'`, under the contract's identity rule: each cusp knot has one sample triple ([plan](plans/p3-fill-stroke-meshes.md#b2-st-u4-cusp-shared-triple-review-follow-up)). Revision 3, `'geometry-wasm/stroke-v0+r3'`, made a disk vertex that coincides with an adjacent triple's offset point that point ([plan](plans/p3-fill-stroke-meshes.md#b2-st-u3c-round-join-shared-vertex-review-follow-up)). It is now revision 4, `'geometry-wasm/stroke-v0+r4'`: the distance within which such a disk vertex becomes the offset point grows with the disk level, and at an exact reversal the outgoing segment starts from the incoming end triple with its outer points swapped ([plan](plans/p3-fill-stroke-meshes.md#b2-st-u3dst-u3e-stroke-sharing-review-follow-up)).

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

**P3 mesh coverage decision (2026-10-07).** The user approved A5 for path meshes. It is a symmetric straddling ramp:

- Boundary-adjacent interior triangles carry flat per-edge distance coefficients.
- An outer screen-space fringe extends to where coverage reaches 0.
- Both sides evaluate the same centered `clamp(0.5 - d / fwidth(d))` ramp as P1's analytic primitives.

The decision rests on the [O01 observations](evidence/p3.1o-coverage/review-2026-10-07.md): mean boundary shift −0.002 px at 1x, and no seams on internal edges. A1 (opaque interior with an outward fringe) and A2 (an inside-only ramp) are not adopted.

On 2026-10-07 the user also accepted a test-only realization of A5. It is recorded in the [private contract](plans/p3-private-contract.md) and specified in the [O02 contract](plans/p3-o02-a5-coverage-contract.md). It uses:

- segment and vertex distance;
- a complement-triangulation fringe;
- an analytic ramp width.

Coverage is computed in screen space from the pixel center. It differs from P1's local-space SDF only in corner isolines under nonuniform scale or shear, and in reflex corners.

Still open:

- the corner, segment and thin-feature rules, now specified by the [O02 contract](plans/p3-o02-a5-coverage-contract.md) and pending its verdict;
- 4x MSAA and 1x fallback consistency;
- fringe cache identity;
- guard clipping.

These remain contract work in the [raster coverage readiness](plans/p3-raster-coverage-readiness.md). The decision does not add a runtime dependency or change the public API. Whether the O02 test-only realization becomes the production fringe is decided at [D8](plans/p3-d8-parallel-tracks.md) checkpoint V3. V3 runs on the untiled carrier as an interim; K1 with the tiling rules below remains the production carrier direction.

**P3 V3 fringe realization (2026-10-12, [V3 contract](plans/p3-v3-renderer-mesh-pipeline-contract.md) sections [e](plans/p3-v3-renderer-mesh-pipeline-contract.md#e-a5-coverage-on-k4) and [f](plans/p3-v3-renderer-mesh-pipeline-contract.md#f-the-mesh-packet-part-and-the-mesh-draw)).** Under user decision V3-Q1 (a), the O02 complement-triangulation fringe is the production direction for A5, conditionally. The adoption stands only while three follow-up results support it: V3-A14 (no double coverage, expected interior, exterior and overlap values), B0's E4 draw cost after V3, and a per-tile complement partition in the R2 contract for K1. If one fails, the decision returns to the user. Its first realization runs on the untiled K4 carrier:

- **Fringe geometry.** It is geometry-owned and node-local. The frame is the local box of the mesh bounds expanded by `ρ = 2^f` per side, where `f` is the smallest integer with `2^f · sigmaMin(S) ≥ 2`, so `ρ` maps to at least 2 physical px in every direction. Its corners lie on the outward binary32 offset grid from the mesh midpoint and are stored per variant after the port vertices. Exterior triangles reuse the region's boundary vertices and the four corners, with no Steiner point. An exact partition check of region plus exterior triangles runs before publication.
- **Write-once draws (2026-10-25, [E17](plans/d9-e17-mesh-write-once-coverage-contract.md)).** The rasterizer's subpixel snap can invert sliver triangles of a drawn partition, which covers samples two or three times. Each mesh draw therefore writes a sample at most once, through a `stencil8` attachment with a per-draw reference; generations without the mesh pipeline keep P1's pass.
- **Features and coverage.** EDGE and VERTEX features are node-local binary32 offsets. Each triangle lists every feature within exact local distance `ρ`. The mesh shader evaluates O02's coverage rule at the pixel center, maps features with the K4 lanes, and multiplies every side and sector test by `σ = sign(det L)`. O02's G1-G3 PASS does not transfer to this realization. The A08 visual contract is the V3 contract's [section k](plans/p3-v3-renderer-mesh-pipeline-contract.md#k-a08-visual-contract).
- **Fringe cache identity.** A fringe variant belongs to one mesh-cache entry and one fringe bucket. A variant built for `f′` serves `f ≤ f′ ≤ f + 1`, and an entry keeps at most two. A failed build marks only that `(key, f′)` variant `fringe-unsupported` under the D8-interim outcome and keeps the mesh cached. A mesh with more than 128 distinct boundary vertices is not given a fringe: it draws region-only (aliased edges) with one `fringe-work-cap` notice per cache entry, a D8-interim work bound on the TypeScript builder that the user ratified as V3-Q2 (c) on 2026-10-20 and that leaves with the builder.

  E11-U4 pointer (fringe cache identity), 2026-10-24: the outcome is the product failure behavior of [requirements](requirements.md#path-rendering-failures); the code is `render.path-mesh-failure`.
- **D8-interim placement exception (user decision V3-Q3 (c)).** The exact BigInt TypeScript builder runs in `renderer-core` (`path-fringe.ts`). This is a time-bounded D8-interim exception to [`ARCHITECTURE.md`](../ARCHITECTURE.md#geometry-contract)'s geometry contract, which says the Rust/WASM kernel implements tessellation. It is also an exception to the [private contract](plans/p3-private-contract.md)'s "Keep Rust as the production geometry owner". Neither text is amended, and no ADR or port change is made. The builder adds no fill region, moves no vertex and adds no Steiner point, and the exact partition check gates every result. It is disposable under the C04 carve-out, like the K4 carrier. The exception ends when the R2/K1 contract decides the production placement of the per-tile exterior partition. At that point the builder is removed or moved, and this item is replaced.

**P3 joint fill and stroke coverage (2026-10-21; ST-U7 addendum, [`plans/p3-b2-st-u7-joint-coverage-addendum.md`](plans/p3-b2-st-u7-joint-coverage-addendum.md)).**

- **The draws.** For a path with fill and stroke at node opacity below 1, the renderer draws a joint-coverage fill draw over a derived overlay, then the stroke draw, so opacity applies once to the stroke-over-fill result.
- **The builder.** The exact TypeScript builders in `renderer-core`, `path-joint-overlay.ts` beside the fringe builder `path-fringe.ts`, re-split the port's fill triangles along the stroke boundary. They add Steiner points, rounded once to Float64, and pass an exact partition check.
- **What the exception covers.** For the joint draw only, this departs from five texts:
  - "Arbitrary path fills and strokes use WASM-produced meshes" (above);
  - the kernel geometry contract, `ARCHITECTURE.md:52-54` ("The Rust/WASM kernel implements this contract", including tessellation);
  - private contract line 8 ("Keep Rust as the production geometry owner");
  - V3's "Region triangles are the port's, unchanged";
  - V3-Q3 (c)'s builder that "adds no Steiner point".
- **Its terms.** It is a time-bounded D8-interim exception in the pattern of V3-Q3 (c), removed at the R2/K1 placement decision. The port meshes stay WASM-produced, and every other draw uses them unchanged.
- **Opacity and vertices.** Overlay vertices are derived cache data, built once per pair of served variants. Color and opacity changes rebuild no port mesh, which is how the "do not rebuild vertices" rule above applies.
- **Requirements.** No requirement text changes.

All V3 results are functional evidence. Precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 threshold is claimed.

**P3 mesh extent decision (2026-10-07).** For meshes whose vertices lie far offscreen (failure class A), the user approved R2 mechanism K1. Region meshes are clipped against a power-of-two grid that is fixed in local space. The level is chosen so that a tile spans at most 256 physical px. Each tile has its own cell-centre carrier, and its Steiner points use exact rational references.

The basis is the offline exact [T01 evidence](evidence/p3.1p-t01/review-2026-10-07.md). The R2 contract still has to settle:

- the U1 successor certificate;
- tile-seam watertightness;
- the tile cache and level hysteresis;
- the exterior partition;
- GPU validation.

No runtime dependency or public API changes.

**P3 tiling rules (2026-10-08, user-confirmed, [R2 contract](plans/p3-r2-tiling-contract.md)).**

- **Shared records.** Each level keeps one vertex record per exact position. Every record names its owner cell's carrier. All tiles share these records, so seams are watertight by construction.
- **Transform-only reuse.** For tiled meshes, a transform-only change builds nothing within an epoch. An epoch spans one origin state, one level, DPR, size and object affine, over a zoom band. An epoch change (rebase, level, DPR, resize, object-affine edit) builds only uncached cells. It does this by clipping the cached tessellation, never by re-tessellating the path.
- **Coverage reference.** On the production carrier, the coverage reference is the exact reference tiling.

MSAA-only output is not considered sufficient for the final path renderer. Quality is tested at fractional positions, rotations, thin strokes, extreme zoom, and high device-pixel ratio.

For P2 flattening, the geometric target is 0.25 **physical display pixel**, accounting for world linear transform, camera zoom and DPR using the largest singular value. The private contract specifies conservative downward tolerance buckets, bounded de Casteljau flattening and an independent continuous-error oracle. This resolves the flattening portion of the P2/P3 design gate; P3 still needs its own tessellation/coverage error budget and adversarial-work contract before implementation. These unresolved gates are tracked in the [P3 execution plan](plans/p3-fill-stroke-meshes.md), opened for planning under [D7](plans/p2-follow-on-entry.md); its entry exception does not supply the missing contracts.

## Clipping

- Axis-aligned screen-space frame clips may use scissor rectangles.
- Transformed rectangular clips and arbitrary masks use stencil operations.
- Nested clip behavior must preserve document paint order.
- The prototype supports a documented maximum clip nesting depth of 32.
- Note 2026-10-25 ([E17-K3](plans/d9-e17-mesh-write-once-coverage-contract.md#4-identity-the-e11-snapshot-and-the-stencil-budget)): mesh draws already use all eight stencil bits for write-once coverage. The P4 clip contract must allocate the bits between clips and write-once, or move write-once to a per-draw depth value.
- Offscreen textures are reserved for future filters, blend isolation, and cases stencil cannot represent.

## Text reservation

Text is not part of the first graphics-kernel milestone. The architecture reserves separate font, shaping, layout, glyph-atlas, and text-input services.

Committed text will eventually render through GPU glyph atlases, while active editing uses a DOM overlay. No DOM or browser font object enters persistent document data.

## Approved P1 visual behavior

On 2026-09-09 the user approved [P1 D2](plans/p1-instanced-primitives.md#d2--approved-p1-visual-behavior): straight-alpha sRGB input, encoded-sRGB premultiplied source-over on a non-sRGB unorm target/view, and primitive opacity applied once after local fill/stroke composition. The linked contract fixes canvas configuration, blend factors, coverage and compositing formulas, local-space stroke transforms, radius normalization and degenerate-input behavior.

P1 structural containers support transform/visibility and require opacity 1. Non-unit container opacity rejects the transaction; descendant alpha multiplication is not a substitute. Future non-unit container opacity requires isolated composition and its own implementation plan. This does not remove the MVP appearance requirement or add offscreen composition to P1.

## Design gates before later implementation

On 2026-09-29 the user approved the [P3 visible path semantics](plans/p3-visible-semantics-proposal.md), including fill-only implicit closure, cap/closed-seam rules, miter fallback and degenerate/reversal cases. Their exact table owns those details. This resolves those visible choices but not the [P3 private mesh](plans/p3-private-contract.md) numeric/coverage/ABI gates. The [test-only line-membership slice](plans/p3-line-oracle-contract.md) may establish independent expected fill regions before the remaining mesh implementation contracts are ready.

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
