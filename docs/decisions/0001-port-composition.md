# ADR 0001: Compose concrete adapters outside domain packages

Status: Accepted

Date: 2026-09-05

## Context

The system architecture says consumers depend on abstract ports, but its original package diagram showed `renderer-core -> geometry-wasm -> geometry-reference`. This would make a concrete WASM adapter and a test reference transitive production dependencies. The graphics document also put semantic scene changes on an interface called `RenderBackend`, despite assigning draw packets to that boundary.

## Decision

The host/playground composition root selects concrete adapters and supplies them through contracts. `renderer-core` consumes the geometry port; `geometry-wasm` implements it. `geometry-reference` is an independent test-only implementation of the same port. Editor-to-renderer scene synchronization and graphics-to-backend draw submission are separate boundaries.

The dependency table in [the system architecture](../../ARCHITECTURE.md#dependency-direction) is authoritative. [The graphics architecture](../graphics-engine-architecture.md#backend-contract) describes the two render boundaries.

## Alternatives

- Import WASM directly from renderer-core: simpler initial wiring, but ties a domain-independent service to one runtime and makes replacement tests less useful.
- Implement the TypeScript reference through the WASM adapter: reduces duplicate logic, but destroys its independence as a differential oracle.

## Consequences

Composition requires explicit adapter injection and shared contract tests. Geometry adapters must agree on ownership, tolerances, failure results, and revisions without sharing their algorithm implementation.

## Migration impact

No runtime change or dependency addition is required in P0.4: geometry and editor packages do not yet exist. P1/P2 plans must extend boundary enforcement when those packages are introduced. The current P0 backend remains a foundation harness, not the finished retained-scene API.
