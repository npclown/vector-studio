# ADR 0004: A packaged WebGPU host composition (`@vector-studio/webgpu-host`)

Status: Accepted 2026-11-05 under the standing rule of 2026-10-24 (추천안 자동 채택), as unit AR-U1 of the [alpha release plan](../plans/alpha-release-plan.md); the user chose the alpha form (private packages) on 2026-11-05.

Date: 2026-11-05

## Context

A host draws the editor by passing a renderer factory to `EditorCanvas` ([host API](../host-api.md#the-provider-and-the-canvas)). Until now the only editor factory was `createWebGpuRenderer` in `apps/next-host/src/webgpu-renderer.ts`: it loads the geometry kernel WASM, creates the fill and stroke mesh ports from `geometry-wasm`, builds `renderer-core`'s `PrimitiveRendererService` on the `renderer-webgpu` backend with the editor's service options, and mixes in next-host's `?test=1` and `?bench=1` hooks. A host that installs the packages therefore cannot draw the canvas (alpha plan, blocker B2).

The composition cannot move into `renderer-webgpu`: [ARCHITECTURE.md](../../ARCHITECTURE.md#dependency-direction) says renderer packages do not import `geometry-wasm` and only host composition roots inject its ports ([ADR 0001](0001-port-composition.md), [ADR 0002](0002-path-scene-and-fill-mesh-port.md)); the boundary checker and `tests/unit/fill-port-boundaries.test.ts` enforce it. It should not depend on `@vector-studio/react` either, since a renderer-side package naming a UI package runs against the forbidden `renderer-webgpu -> UI` example.

## Decision

- A new package `@vector-studio/webgpu-host` is a **host composition root shipped as a package**. It may depend on `contracts`, `geometry-wasm`, `renderer-core` and `renderer-webgpu`, and on no UI package (`react`, `react-dom`, `next`). Renderer and core packages still never import `geometry-wasm`, and nothing but host composition roots (playground, next-host) may depend on `webgpu-host`.
- Its entry exports `createWebGpuRendererFactory(options)`, which returns a function of the shape of `@vector-studio/react`'s `RendererFactory` (structural typing; no import). Options: the WASM source (`wasm`: URL, bytes or a loader), backend options, a glyph raster wrapper and two stage hooks (`beforeInitialize`, `afterInitialize`) through which a host adds its own wrappers and releases. It also exports `editorRendererOptions` (the editor's service options) and two error classes: `GeometryWasmUnavailableError`, and `WebGpuUnavailableError`, whose message names the cause and, for an insecure context or a missing API, what to do.
- Renderer modules are still loaded by dynamic `import()` inside the factory, so importing the package evaluates no browser code during server rendering.
- next-host's `createWebGpuRenderer` becomes this factory plus its test and bench stages, in the order they ran before.

## Alternatives

- **Put it in `renderer-webgpu`.** Rejected: breaks the recorded boundary and its tests.
- **Put it in `@vector-studio/react`.** Rejected: `react -> renderer-webgpu` is a forbidden example, and React hosts that bring their own renderer would carry WebGPU and WASM code.
- **Leave it to each host (document the 150 lines).** Rejected for the alpha: every host would copy the editor's service options and the kernel port wiring.

## Consequences

- One more package to publish in the alpha set (alpha plan, AR-Q2).
- The playground keeps its own per-page compositions; it may move to this factory later, which needs no new edge.
- A host still supplies the WASM bytes or URL until AR-U2 ships the kernel in `geometry-wasm`.

## Affected documents

[ARCHITECTURE.md](../../ARCHITECTURE.md) (dependency direction and pointer), [host-api.md](../host-api.md) (the provider and the canvas), [alpha release plan](../plans/alpha-release-plan.md).
