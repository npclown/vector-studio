# Graphics prototype plan v0.1

Status: Accepted milestone roadmap

This document is the source of truth for prototype milestone order and milestone-level gates. Detailed work and evidence for the active milestone live under `docs/plans/`; P0 is tracked in `docs/plans/p0-webgpu-foundation.md`.

The prototype validates the custom graphics engine before the full editor. Each milestone has an exit gate; later milestones do not begin when a foundational gate fails without an explicit design revision.

## Current position and plan entry rule

P0.0-P0.4 have integration evidence. P0 remains open: the [active P0 plan](plans/p0-webgpu-foundation.md#current-gate-review-2026-09-05) tracks measurement gaps and missing foundation scope. P1-P5 below are roadmap scope, not execution-ready plans.

Before each milestone starts, create its execution plan with acceptance IDs, deterministic fixtures/seeds, numeric tolerances, error behavior, validation commands, and required evidence. Resolve the relevant [graphics design gates](graphics-engine-architecture.md#design-gates-before-later-implementation). A performance gate must also define its measured event, sample/aggregation method, reference environment, and memory-accounting categories before a run; prose such as “measurably faster” is not an executable threshold.

## Benchmark governance

All milestones use the environment metadata, run protocol, metrics, and result format defined by `docs/benchmarks/README.md`. This roadmap owns only milestone-specific scenes and high-level thresholds until a dedicated execution plan replaces them.

## P0: WebGPU foundation

Detailed execution, acceptance criteria, validation mapping, and P0 benchmark thresholds are owned by `docs/plans/p0-webgpu-foundation.md`.

Scope:

- Capability detection
- Device/context initialization
- Resize and device-pixel-ratio handling
- Camera transform
- Render loop and invalidation
- Buffer suballocation experiment
- Pipeline cache
- Device-loss simulation and recovery path
- Deterministic benchmark harness

Exit gate: every acceptance criterion and benchmark threshold in `docs/plans/p0-webgpu-foundation.md` is PASS with linked evidence.

## P1: Instanced primitives

Scope:

- Rectangle and rounded rectangle
- Ellipse
- Simple line
- Solid fill, stroke, transform, and opacity
- Document paint order
- Viewport culling
- Incremental transform/style uploads

Benchmark scenes:

1. 1,000 mixed primitives, all visible, continuous pan and zoom.
2. 10,000 mixed primitives, all visible, continuous pan and zoom.
3. 10,000 document primitives with approximately 1,000 visible.
4. One selected node moving continuously in a 10,000-node document.

Provisional exit gate:

- Scene 1: p95 frame time at or below 16.7 ms.
- Scene 2: p95 frame time at or below 33.3 ms.
- Scene 3: p95 frame time at or below 16.7 ms.
- Scene 4: no full-scene geometry rebuild or full-buffer upload.
- Pointer-to-present p95 remains below 50 ms.

## P2: Rust/WASM geometry kernel

Scope:

- Packed path input
- Cubic extrema and bounds
- Zoom-aware adaptive flattening
- Batch ABI and memory reservation
- Geometry cache
- TypeScript reference implementation for differential tests

Exit gate:

- Rust and reference results agree within documented numeric tolerances.
- Batch processing is measurably faster than per-path boundary calls.
- Single-path edits do not rebuild unrelated paths.
- Memory growth and typed-view refresh behavior is covered by tests.

P2's execution plan must set the required batch speedup, minimum workload/sample count, and absolute/relative tolerances before benchmarking. Include packing, copying, and output-consumption costs in both variants and keep the TypeScript oracle independent from the Rust implementation.

## P3: Fill and stroke meshes

Scope:

- Multiple subpaths and holes
- Nonzero and even-odd fill rules
- Open and closed paths
- Butt, square, and round caps
- Miter, bevel, and round joins
- Thin strokes and extreme miter cases
- Coverage fringe and MSAA quality comparison

Path stress scenes:

- 1,000 paths with 32 cubic segments each
- Nested contours with alternating winding
- Self-intersection corpus
- Fractional transforms and rotations
- Zoom range from 1% to 6400%

Exit gate:

- No crashes, invalid indices, NaN vertices, or out-of-range writes on the corpus.
- Fill-rule and winding fixtures match expected reference images.
- Geometry error remains within the 0.25-screen-pixel target.
- Stable paths reuse cached meshes while transforms stay within the validated tolerance bucket; zoom/DPR changes crossing a bucket rebuild only affected geometry.

## P4: Clip and mask

Scope:

- Frame clip content
- Transformed clips
- Arbitrary path masks
- Nested clips up to depth 32
- Clip-aware batching and culling

Exit gate:

- Nested masks preserve paint order and opacity.
- Clip changes invalidate only affected subtrees and GPU work.
- Exceeding the supported depth returns a diagnostic rather than corrupt output.

## P5: Editor integration slice

Only after the graphics gates pass, connect a minimal editor slice:

- One page and viewport
- Rectangle and path creation
- Click selection and marquee selection
- Move and resize
- Command transaction and undo/redo
- JSON round trip
- One custom node registered through the extension boundary

This slice proves that the graphics engine is a replaceable downstream service rather than the owner of document semantics.

Exit gate to make concrete in the P5 execution plan:

- Creation, selection, move, and resize run through the public command/query API; a continuous drag creates one undo step and redo restores the same durable content.
- JSON round trip preserves stable IDs, geometry, paint order, and schema version while excluding renderer caches and transient selection/viewport state; malformed and unsupported-version inputs fail explicitly.
- A test renderer can replace WebGPU without changing document/history behavior.
- The custom node registers and edits through public extension contracts without mutable store or GPU access.
- The slice works through React client bindings in a Next.js client-component host; no browser access occurs during server module import. SSR canvas rendering remains out of scope.

## Requirement coverage

This table maps [the product baseline](requirements.md) to validation scope; it does not add product deferrals.

| Requirement area           | Graphics-prototype coverage                               | Remaining editor/MVP work                                                                                           |
| -------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| React/Next.js and host API | P5 minimal client integration and replaceable renderer    | Complete headless API, selectors, hooks, configurable shortcuts and minimal UI                                      |
| Document and persistence   | P5 one-page schema/JSON round trip and history slice      | Multiple pages, migration policy, host save/load and last-open-page envelope, optional IndexedDB autosave           |
| Shapes and appearance      | P1 primitive fills/strokes/opacity; P3 paths; P4 clipping | Arrow semantics, gradients, dash editing, and full appearance controls                                              |
| Path editing               | P2/P3 geometry and fill/stroke output                     | Anchor/handle editing, insertion/removal and editor transactions                                                    |
| Containers and symbols     | P4 render clipping/masks                                  | Group/frame editing, constraints, isolated opacity decisions, symbols/instances and detach                          |
| Interaction                | P5 click/marquee, move/resize, undo/redo                  | Rotate, snapping, align/distribute, clipboard, layer ordering, duplication/nudging and overlap/frame-entry behavior |
| Text                       | Architecture reservation only                             | Styled runs, font services, layout, caret/selection and Korean IME                                                  |
| Performance                | P1 fixed primitive workloads; P2/P3 geometry workloads    | Representative mixed editor workloads and lower-tier hardware before alpha                                          |

P5 completion authorizes planning the remaining editor work; it does not establish MVP completion. Features absent from the first column's prototype coverage need a later execution plan, not an implicit implementation inside P0-P5.

## Deferred from the graphics prototype

- Rich text and Korean IME
- Symbols and instances
- Full layers/properties UI
- IndexedDB autosave
- Import/export
- Images and filters
- Animation
- Collaboration
- WebGL2 backend
- General plugin sandbox

## Accepted implementation constraints

1. Production runtime code does not depend on third-party rendering, scene-graph, or tessellation engines. Comparison libraries are test-only.
2. The current development PC is the first reference machine; every result records hardware and browser metadata. A lower-tier GPU gate is added before alpha distribution.
3. The prototype is WebGPU-only and reports a structured capability error on unsupported systems.
4. The 10,000-node stress scene has an initial 256 MB combined working-memory ceiling.

For that ceiling, the P1 plan must define simultaneous live document/scene data, CPU geometry/upload buffers, WASM linear memory when present, and engine-accounted GPU allocations, counting copied storage separately and shared storage once. Distinguish MB (decimal) from MiB (binary), state exclusions, and report unavailable CPU accounting as unverified rather than claiming the combined ceiling from GPU counters alone. P0's 32 MiB GPU gate does not prove this later combined-memory gate.
