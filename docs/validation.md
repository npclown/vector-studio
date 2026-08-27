# Validation policy

Status: Accepted for prototype development

This document is the source of truth for test layers, validation evidence, and the rules for claiming that a change works. Milestone-specific acceptance criteria live in the active execution plan. Benchmark methodology and recorded measurements live under `docs/benchmarks/`.

## Principles

- Validate at the lowest deterministic layer that can prove the behavior.
- Use real Chrome and Edge with hardware WebGPU for claims about browser integration, GPU behavior, or performance.
- Keep correctness tests deterministic and separate from performance measurements.
- A test double can prove state transitions and error handling, but cannot prove browser capability or GPU output.
- A screenshot can support visual evidence, but cannot replace numeric or structural assertions.
- Development-mode numbers are diagnostic only; accepted benchmark results use a production build.

## Validation layers

### Static validation

Applies to every implementation change:

- Type checking for all affected TypeScript packages
- Formatting and lint checks once the toolchain is established
- Rust formatting and Clippy for Rust/WASM work beginning in P2
- Package-boundary checks that enforce `ARCHITECTURE.md`
- Build output verification for every affected distributable package and playground

### Unit tests

Use unit tests for deterministic, environment-independent behavior:

- State machines and lifecycle transitions
- Capability-result mapping from injected inputs
- Invalidation coalescing
- Numeric conversions and size clamping
- Resource-accounting invariants
- Diagnostic code and payload construction
- Geometry algorithms and differential fixtures beginning in P2

Unit tests must not require a physical GPU.

### Contract tests

Each port and adapter boundary receives shared contract tests where practical:

- Renderer lifecycle: initialize, resize, invalidate, continuous mode, dispose
- Diagnostics subscription and stable codes
- Geometry batch ownership and typed-buffer validity
- Persistence snapshot round trip

A concrete adapter passes the same contract suite as any test implementation.

### Browser integration tests

Run against stable Google Chrome and Microsoft Edge channels:

- Secure-context capability detection
- Real canvas `webgpu` context creation
- Resize and device-pixel-ratio behavior
- Rendering and presentation of the foundation scene
- Structured handling of unavailable adapters
- Page teardown and repeated navigation

Automated browser tests may run a deterministic fake adapter for error paths. A headed hardware run is still required for the P0 GPU acceptance gate because headless or virtual adapters are not equivalent evidence.

### GPU lifecycle validation

P0 adds explicit resource counters and diagnostic events so validation does not depend only on opaque browser memory reports.

Required checks:

- Pipeline creation count is unchanged during steady-state frames.
- Live tracked resource counts return to their pre-initialize baseline after dispose.
- Resize replaces size-dependent attachments without accumulating live attachments.
- Deliberate device destruction emits loss and recovery diagnostics in order.
- Recovered rendering uses a new device generation and rebuilt resources.
- Stale async initialization results cannot revive a disposed backend.

### Visual validation

Visual fixtures are rendered at defined viewport, device-pixel ratio, clear color, and scene seed. P0 uses a simple foundation scene to detect blank output, incorrect resize, and MSAA target problems. Pixel-difference thresholds become authoritative only when P1 defines stable primitive output.

### Performance validation

Performance runs follow `docs/benchmarks/README.md`. They are isolated from functional test runs and recorded as result files. CI may detect large regressions on a fixed runner, but reference-machine acceptance remains a deliberate hardware run.

## Evidence matrix

Every execution-plan acceptance criterion declares one or more evidence types:

| Evidence type | Required content |
| --- | --- |
| Static | Exact command and zero exit status |
| Unit/contract | Test identifier, command, pass count |
| Browser | Browser channel/version, test identifier, artifact link |
| Manual GPU | Hardware/browser metadata, steps, observed diagnostics |
| Visual | Fixture ID, image artifact, comparison result |
| Benchmark | Result file conforming to benchmark schema |

Terminal output pasted without its command, environment, or revision is incomplete evidence.

## Feature-branch and pull-request gate

Git workflow is owned by `AGENTS.md`. Validation participates in that workflow as follows:

- Run the active plan's applicable static, unit, contract, browser, GPU, and benchmark checks on the feature branch before creating a commit intended for review.
- Record exact commands and results in the active plan or generated evidence artifact before push.
- A commit made after successful validation must not include additional unvalidated product changes.
- Remote CI validates the committed revision again; local success does not replace required GitHub checks.
- A CI failure returns the plan item to in-progress. Apply the correction on the same feature branch, rerun affected local validation, update evidence, and commit again.
- A pull request cannot claim an acceptance criterion proven by results from another revision unless the result is explicitly revision-independent.

Documentation-only bootstrap validation consists of link/path checks, formatting/whitespace checks, a source-of-truth responsibility review, and confirmation that no product source or machine-local artifact is included.

## Planned command surface

The toolchain does not exist yet. P0 implementation should establish a stable root command surface with these responsibilities; exact tools are an implementation detail recorded in the execution plan:

```text
check          static checks and all deterministic tests
test:unit      unit and contract tests without a browser
test:browser   automated Chrome/Edge integration tests
test:gpu       headed reference-machine GPU validation
benchmark:p0   production-build P0 benchmark runner
build          all affected packages and playground
```

Agents must use repository commands once they exist rather than bypassing them with ad hoc package-local commands when claiming repository-wide validation.

## Failure handling

- Flaky tests are failures until their nondeterminism is explained and removed.
- Hardware-only failures include the captured adapter, limits, browser version, and diagnostics.
- If a criterion cannot be executed, mark it `UNVERIFIED` in the active plan.
- Do not lower a threshold to make an implementation pass. Threshold changes require updating the owning plan or requirement with rationale before rerunning.
