# Vector Studio system architecture

Status: Accepted direction for the prototype

This document is the source of truth for top-level system boundaries, ownership, and dependency direction. Detailed graphics algorithms belong in `docs/graphics-engine-architecture.md`; product behavior belongs in `docs/requirements.md`.

## Architectural goals

- Keep the canonical editor model independent from UI frameworks and rendering technology.
- Make the custom graphics engine replaceable from the editor core through a narrow port.
- Keep React as an adapter, not the owner of editor state.
- Use Rust/WASM for coarse-grained geometry computation without moving browser or product semantics into WASM.
- Allow future persistence, import/export, animation, and collaboration adapters without changing the canonical document format by accident.
- Preserve a path from trusted build-time extensions to a future isolated plugin model.

## System map

```text
Host application / playground
             |
      UI and framework adapters
             |
        Editor public API
             |
      Editor core and document
        /         |          \
 Renderer port  Geometry port  Persistence port
      |              |               |
 Graphics engine  Rust/WASM      IndexedDB/host
      |
 WebGPU backend
```

Arrows point from a consumer to a dependency. Concrete adapters depend inward on contracts; domain layers do not import concrete adapters.

## Boundary ownership

### Document model

Owns versioned, JSON-serializable persistent data: documents, pages, nodes, styles, text runs, symbols, and stable identifiers.

It must not contain DOM nodes, React values, browser events, GPU handles, WASM pointers, renderer cache keys, or persistence handles.

### Editor core

Owns commands, transactions, history, selection semantics, tool state machines, queries, extension registration, and coordination between document and ports.

It depends on document types and abstract ports. It does not depend on React, a concrete renderer, WebGPU, IndexedDB, or a concrete collaboration engine.

### Geometry contract

Owns renderer-independent requests and results for bounds, flattening, tessellation, hit testing, and snapping. Inputs and outputs are deterministic plain data or typed numeric buffers.

The Rust/WASM kernel implements this contract. The editor and renderer must cross the WASM boundary in batches rather than with per-node hot-loop calls.

### Renderer contract

Owns incremental `RenderChangeSet`-style input, viewport state, lifecycle, diagnostics, and renderer statistics. It expresses render intent, not WebGPU commands.

The editor core may depend on this contract. It must not import the concrete WebGPU backend.

### Graphics engine

Owns the retained render mirror, visibility, paint-order-preserving draw-list construction, GPU resource caches, batching, invalidation, and structured diagnostics.

It consumes renderer and geometry contracts. It does not own document semantics, selection behavior, command history, or extension UI.

### WebGPU backend

Owns browser capability checks, adapter/device/context lifecycle, pipelines, buffers, textures, render passes, submission, device-loss recovery, and GPU diagnostics.

It depends on graphics-engine draw packets. Nothing outside the graphics engine may depend on its WebGPU objects.

### Framework adapters

React bindings expose providers, selectors, hooks, and headless primitives over the external editor store. They subscribe to stable snapshots and dispatch editor commands.

Framework adapters do not mutate documents, execute geometry algorithms, or issue renderer commands directly.

### UI packages

UI packages compose framework bindings into optional controls and panels. The minimal prototype UI must use the same public contracts available to a host application.

### Persistence adapters

Persistence adapters serialize committed document snapshots and schema versions. They never persist GPU/WASM caches or transient selection and viewport state unless a requirement explicitly adds such behavior.

## Dependency direction

The intended package-level direction is:

Every arrow below means **consumer imports dependency**, including type-only imports:

```text
contracts        -> model
editor-core      -> model, contracts
renderer-core    -> contracts
renderer-webgpu  -> renderer-core, contracts
geometry-wasm    -> contracts
geometry-reference (test-only) -> contracts
react            -> editor-core, contracts
ui               -> react
persistence adapters -> model, contracts
playground / host composition -> public API and selected concrete adapters
```

The host composition root constructs the concrete renderer, geometry, and persistence adapters and injects them through contracts. Neither `editor-core` nor `renderer-core` imports `geometry-wasm`. The TypeScript geometry reference is an independent test oracle, not a production dependency of the WASM adapter. See [ADR 0001](docs/decisions/0001-port-composition.md) for the correction to the earlier package diagram.

This diagram reserves boundaries; it does not require every box to become a package immediately. A package is created only when a boundary needs independent compilation, dependency isolation, testing, or distribution.

At P0.4, only `contracts`, `renderer-core`, `renderer-webgpu`, and `playground` exist. The current boundary checker covers those four packages; future packages must extend the checker and contract tests before use. The reserved dependency graph is not evidence that the editor, model, or geometry services have been implemented.

Forbidden dependency examples:

- `model -> renderer-webgpu`
- `editor-core -> React`
- `react -> renderer-webgpu`
- `geometry-wasm -> editor-core`
- `renderer-webgpu -> UI`
- `persistence adapter -> GPU resource cache`

## State classification

| State                               | Owner                            | Durable                                  |
| ----------------------------------- | -------------------------------- | ---------------------------------------- |
| Document nodes and styles           | Document model                   | Yes                                      |
| Commands and undo entries           | Editor core                      | Session/history policy                   |
| Selection, hover and active tool    | Editor core session              | No                                       |
| Viewport and camera                 | Editor session/renderer contract | No by default                            |
| Last open page ID                   | Host/persistence envelope        | Yes; separate from document edit history |
| World bounds and spatial index      | Derived services                 | Rebuildable                              |
| Flattened paths and meshes          | Geometry/graphics cache          | Rebuildable                              |
| GPU buffers, textures and pipelines | WebGPU backend                   | Rebuildable                              |
| React component state               | Framework/UI adapters            | No                                       |

## Extension boundary

Trusted prototype extensions register declarative node definitions, tools, commands, shortcuts, and UI contributions. They use public command, query, event, geometry, and render-contribution contracts.

Extensions cannot receive mutable store internals, arbitrary WebGPU handles, WASM pointers, or unrestricted global access through the SDK. This constraint keeps a future message-based sandbox possible.

Trusted build-time extensions execute in the host's JavaScript environment. Restricting SDK handles is an API boundary, not a security sandbox; isolation remains deferred by the requirements.

## Cross-cutting policies

- All persistent mutations occur inside transactions.
- Diagnostics cross boundaries as structured records with stable codes.
- Derived caches carry source revisions and are invalidated explicitly.
- Browser and GPU capability failures are surfaced; there is no silent renderer fallback in the prototype.
- Performance optimization cannot change paint order, selection semantics, fill rules, or document serialization.
- Public contracts use opaque identifiers and do not leak concrete dependency types.

## Decision changes

A change to a top-level boundary or dependency direction requires updating this document and adding a focused decision record under `docs/decisions/`. Subsystem algorithm changes update their subsystem architecture document instead.
