# ADR 0002: Path scene node and contracts-owned fill-mesh port

Status: Accepted. The user approved the [P3 V1 proposal](../plans/p3-v1-path-scene-port-proposal.md) on 2026-10-08; the `ARCHITECTURE.md` change below is applied with that approval. Code lands in D8 checkpoints V2 and V3.

Date: 2026-10-08

## Context

Under [D8](../plans/p3-d8-parallel-tracks.md), Track A must draw paths. Today the scene contract accepts only primitives and containers, `renderer-core` imports only `contracts`, and `geometry-wasm` exposes a private P2 session that no renderer uses. [ADR 0001](0001-port-composition.md) already decided that the host composes concrete adapters and that `renderer-core` consumes a geometry port that `geometry-wasm` implements. No such port exists yet, and no package may yet depend on `geometry-wasm` in production.

## Decision

- `packages/contracts` gains a path node kind in the scene contract and a `FillMeshPort` interface with plain-data, typed-buffer requests and results. The V1 proposal fixes their names and meaning. The port is a functional v0 and does not bind the C04 mesh layout.
- `packages/geometry-wasm` implements `FillMeshPort` with an adapter over its own kernel, beside the unchanged P2 ABI v1.
- The host composition root (`apps/playground` today) obtains the adapter from a `geometry-wasm` factory and injects it into the `renderer-core` renderer service. Among current packages, only the playground, as host composition, gains a `geometry-wasm` dependency.
- `renderer-core` consumes the port once per frame in a batch, owns the CPU mesh cache, and derives geometry revisions itself. The cache key includes the port's operation and budget identity.
- The port is fill only. Stroke gets its own port or port version after D8 checkpoint B2.
- For D8's V2-V4 slice only, a path the kernel cannot mesh is not drawn and is reported by a D8-interim warning diagnostic. This is not the production failure behavior, which stays with the private contract's U2 and U4 decisions.

This follows ADR 0001; it does not reverse it. It adds the first concrete geometry port and one new allowed edge, `playground -> geometry-wasm`.

## Alternatives

- **`renderer-core` imports `geometry-wasm`.** Simpler wiring. Rejected for the reasons in ADR 0001: it ties `renderer-core` to one runtime and weakens replacement tests.
- **A port in `renderer-core` that `geometry-wasm` implements.** It would make `geometry-wasm` depend on `renderer-core`, which the dependency table forbids, and would put a geometry contract inside a renderer package.
- **One broad `GeometryPort` now** (bounds, hit testing, snapping, fill, stroke). It would freeze editor-facing operations that no milestone has specified. The narrow fill port is the first member of that family.

## Consequences

- The boundary policy and checker add `apps/playground -> @vector-studio/geometry-wasm` and a check that `packages/contracts/src` exposes no WASM or WebGPU types (D8 checkpoint V2).
- Adapters share one port conformance suite. Ownership, tolerance identity and failure results must agree without sharing algorithm code, as ADR 0001 requires.
- A path that the kernel cannot mesh is a renderer outcome, not a scene validation failure, so kernel caps stay internal.
- The D8-interim diagnostic code is a public contract addition that must be removed or replaced when the production failure behavior is decided, before P3 acceptance.
- Results from V2-V4 are functional and labeled UNVERIFIED against the 0.25-pixel target until B4 supplies A04 evidence.

## Migration impact

No code changes with this record. V2 lands the port types, the adapter and the checker change. V3 lands the scene node and the renderer consumption. P2 ABI v1, its exports and its tests are unchanged. Existing primitive scenes behave exactly as before; a renderer without an injected port rejects path nodes with `unsupported-feature`.

## Affected source-of-truth documents

- **`ARCHITECTURE.md`** gains the paragraph below at the end of the "Dependency direction" narrative, after the P2.3 paragraph. Its dependency table line `playground / host composition -> public API and selected concrete adapters` already covers the new edge; the boundary policy lists it explicitly.

  > P3 V1 (ADR 0002) adds the first concrete geometry port. `contracts` defines a fill-mesh port with plain-data requests and results; `geometry-wasm` implements it beside its P2 private session; the host composition root obtains that adapter from a `geometry-wasm` factory and injects it into `renderer-core`. Among current packages, only the playground, as host composition, may depend on `geometry-wasm`. The scene contract gains a path node whose fill rule is part of its geometry. The port is fill only until stroke has its own approved contract.

- **P1 D1** ([`p1-instanced-primitives.md`](../plans/p1-instanced-primitives.md#d1--approved-scene-and-packet-contract)) owns the exported scene shape and requires a new decision for meaningful changes to it. The V1 proposal, with this record, is that decision for the path node. D1's text is unchanged; its validation precedence applies to the new node.
- **Graphics architecture** ([`graphics-engine-architecture.md`](../graphics-engine-architecture.md#wasm-boundary)). Its `GeometryBatchResult` example (Float32 vertices, draw ranges, borrowed views) describes the kernel-side transport, which C04 still owns. At the port level, `FillMeshPort` returns owned Float64 copies instead. The example stays as written until C04 freezes the transport layout.
