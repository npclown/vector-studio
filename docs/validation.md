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

| Evidence type | Required content                                        |
| ------------- | ------------------------------------------------------- |
| Static        | Exact command and zero exit status                      |
| Unit/contract | Test identifier, command, pass count                    |
| Browser       | Browser channel/version, test identifier, artifact link |
| Manual GPU    | Hardware/browser metadata, steps, observed diagnostics  |
| Visual        | Fixture ID, image artifact, comparison result           |
| Benchmark     | Result file conforming to benchmark schema              |

Terminal output pasted without its command, environment, or revision is incomplete evidence.

## Feature-branch and pull-request gate

Git workflow is owned by `AGENTS.md`. Validation participates in that workflow as follows:

- Run the active plan's applicable static, unit, contract, browser, GPU, and benchmark checks on the feature branch before creating a commit intended for review.
- Record exact commands and results in the active plan or generated evidence artifact before push.
- A commit made after successful validation must not include additional unvalidated product changes.
- Remote CI validates the committed revision again; local success does not replace required GitHub checks.
- A CI failure returns the plan item to in-progress. Apply the correction on the same feature branch, rerun affected local validation, update evidence, and commit again.
- A pull request cannot claim an acceptance criterion proven by results from another revision unless the result is explicitly revision-independent.

Documentation-only changes, including bootstrap, require local link/path and heading-anchor checks, formatting/whitespace checks, a source-of-truth responsibility review, and confirmation that no product source, dependency, historical result, or machine-local artifact was unintentionally changed. Compare implementation claims with source and distinguish historical evidence from new validation.

Markdown is excluded by the current `.prettierignore`. Consequently `pnpm check` alone does not verify Markdown formatting. Check changed Markdown explicitly with `pnpm exec prettier --check --ignore-path <empty-ignore-file> <changed-markdown-files>`; do not reformat unrelated historical results. Repository static/unit/build commands still provide the PR's required CI surface. A documentation-only change needs no new GPU or performance run unless it makes a new claim requiring one.

## Current command surface

The toolchain exists as of P0.4. `package.json` owns exact commands and pinned versions; the responsibilities and current limitations are:

| Command                  | Current responsibility / limitation                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`             | Formatting (Markdown excluded), ESLint, TypeScript, unit/contract tests, package boundaries                                                                      |
| `pnpm test:unit`         | Deterministic Vitest tests without a physical GPU                                                                                                                |
| `pnpm test:browser`      | Chrome/Edge browser integration; headless by default, not hardware acceptance                                                                                    |
| `pnpm test:gpu`          | Headed Chrome/Edge validation error and device-loss recovery; not native OOM evidence                                                                            |
| `pnpm benchmark:p0:p0-3` | Legacy production steady/idle runner; fixed historical output filenames must be corrected before reuse in the tracked checkout                                   |
| `pnpm benchmark:p0`      | P0.5 five-scenario production headed runner; defaults to acceptance and requires `--display-refresh-hz`, with an explicit non-accepting `--profile smoke` option |
| `pnpm build`             | Workspace package declarations/JavaScript and playground production build                                                                                        |

Agents must use repository commands once they exist rather than bypassing them with ad hoc package-local commands when claiming repository-wide validation.

## Evidence limits and gate status

- A submission counter proves a submission-path event, not display presentation. Use the [benchmark measurement policy](benchmarks/README.md#measurement-semantics) for timing claims, and pair rendering assertions with defined visual fixtures.
- A counter initialized to zero without observing the relevant event is not proof that the event was prevented. Lifecycle tests must inspect old/new device calls and exercise delayed completions and disposal races.
- Distinguish injected error mapping from native hardware error delivery. Current GPU tests do not reproduce native OOM; leave any criterion requiring that evidence UNVERIFIED until an appropriate controlled method or a prospective criterion revision is accepted.
- Historical artifacts are immutable observations. Corrections to their interpretation belong in the active plan or a new review record; source changes require new affected evidence.
- PASS means the complete declared criterion has valid evidence; FAIL means observed behavior violates it; UNVERIFIED means required evidence is missing or unsuitable. An integrated checkpoint does not automatically make the whole milestone PASS.

## Failure handling

- Flaky tests are failures until their nondeterminism is explained and removed.
- Hardware-only failures include the captured adapter, limits, browser version, and diagnostics.
- If a criterion cannot be executed, mark it `UNVERIFIED` in the active plan.
- Do not lower a threshold to make an implementation pass. Threshold changes require updating the owning plan or requirement with rationale before rerunning.
