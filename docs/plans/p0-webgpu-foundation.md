# P0 execution plan: WebGPU foundation

Status: P0.4 integrated; P0.4a recovery regression correction in progress

This is the source of truth for P0 scope, execution order, progress, acceptance criteria, and required evidence. Cross-project validation rules come from `docs/validation.md`; benchmark measurement and result formatting come from `docs/benchmarks/README.md`.

## Objective

Establish a small, recoverable, directly owned WebGPU foundation that can support later retained-scene and primitive-rendering work without leaking WebGPU types into editor or document boundaries.

P0 proves browser/GPU lifecycle and measurement infrastructure. It does not prove 10,000-node performance, path rendering, editor behavior, or public SDK quality.

## Inputs and constraints

- Product scope: `docs/requirements.md`
- Top-level boundaries: `ARCHITECTURE.md`
- Graphics decisions: `docs/graphics-engine-architecture.md`
- Prototype sequencing: `docs/prototype-plan.md`
- Validation policy: `docs/validation.md`
- Benchmark policy: `docs/benchmarks/README.md`

Accepted constraints:

- Latest stable desktop Chrome and Edge on the current Windows development PC
- WebGPU-only prototype with an explicit unsupported-capability result
- Browser WebGPU API used directly; no rendering or scene-graph runtime
- No third-party runtime tessellator
- TypeScript owns WebGPU lifecycle; Rust/WASM begins in P2
- Reference benchmark viewport is 1280 x 720 physical pixels at DPR 1 unless a scenario says otherwise
- The global 256 MB target belongs to later 10,000-node work; P0 has a smaller foundation-scene accounting gate

## Deliverables

1. Repository toolchain and root validation command surface
2. Renderer contracts with no WebGPU types
3. Concrete WebGPU backend with a documented lifecycle state machine
4. Structured diagnostics and engine-owned resource accounting
5. Invalidation-driven render scheduler
6. Foundation scene that clears and draws known geometry
7. Deterministic playground and P0 benchmark runner
8. Automated unit/contract/browser tests
9. Headed Chrome and Edge evidence on the reference machine
10. Accepted benchmark result records for every P0 scenario

## Lifecycle model

The backend implements explicit states:

| From                                              | Event                                    | To                              |
| ------------------------------------------------- | ---------------------------------------- | ------------------------------- |
| idle                                              | initialize                               | initializing                    |
| initializing                                      | usable device and resources              | ready                           |
| initializing                                      | capability unavailable                   | unsupported                     |
| initializing                                      | request/configuration/allocation failure | failed                          |
| unsupported / failed after initial initialization | explicit initialization retry            | initializing                    |
| ready                                             | current-generation device loss           | lost                            |
| lost                                              | one controlled recovery attempt          | recovering                      |
| recovering                                        | rebuild succeeds                         | ready                           |
| recovering                                        | reacquisition or rebuild fails           | failed; terminal until disposal |
| Any non-disposed state                            | dispose                                  | disposed                        |

The terminal restriction after recovery failure is an existing P0.4 requirement. The current implementation does not distinguish it from retryable initial failure; correction and regression evidence are tracked in P0.5b below.

Required invariants:

- Concurrent `initialize` calls share one initialization attempt.
- `initialize` is idempotent while ready.
- `dispose` is idempotent and terminal.
- A stale adapter/device promise cannot change state after disposal or a newer generation.
- Device loss advances a generation, invalidates all GPU resources, and attempts one controlled recovery.
- Recovery rebuilds resources from CPU-owned descriptors, not old GPU handles.

Exact public names may change during implementation; the state behavior may not change without updating this plan.

## Current gate review (2026-09-05)

Reviewed baseline: `2df8848` (P0.4 integrated). Historical checkpoint evidence below remains associated with its original revision and environment. It is not a complete P0 acceptance matrix.

| Finding                                         | Evidence in current source                                                                                                                             | Required follow-up                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Roadmap scope has no execution acceptance       | Camera transform, buffer suballocation experiment, and keyed pipeline cache are absent from current foundation implementation                          | P0.5a and P0-A13 through A15; do not silently move them to P1                                                                            |
| Presentation is inferred from submission        | `WebGpuBackend.#render` increments `framesPresented` beside `framesSubmitted`                                                                          | P0.5 must distinguish measured events; startup/recovery present-time gates remain UNVERIFIED until an accepted measurement method exists |
| Stale submission counter cannot prove exclusion | `staleGenerationSubmissions` is initialized to zero and never updated                                                                                  | P0.4a must assert calls against old/new device spies across loss and delayed completion                                                  |
| Recovery failure can be retried                 | `initialize` can leave `failed`; current failure test stops before another explicit initialize                                                         | P0.4a must enforce and test the existing terminal recovery-failure rule                                                                  |
| Benchmark records can be overwritten            | `tests/benchmark/p0-3-foundation.spec.ts` uses a fixed 2026-08-27 filename, always marks revision dirty, and writes Accepted from numeric checks alone | P0.5 must use unique output identities, actual source provenance, and separate acceptance review                                         |
| Unavailable measurements can appear as success  | The fixed runner treats unsupported long-task observation/empty samples as zero and records only initial diagnostics                                   | P0.5 schema and runner tests must reject false-zero evidence and capture complete measured windows                                       |
| Hardware evidence is narrower than P0-A07       | Headed GPU test triggers validation error and device loss; OOM mapping is injected only in unit tests                                                  | P0-A07 hardware OOM remains UNVERIFIED; do not deliberately exhaust the machine or replace the criterion with unit evidence              |

Avoid rerunning the legacy benchmark in this checkout before its output-path correction: it overwrites immutable historical records. The historical P0.3 records remain observations, not final P0 results for `2df8848` or later revisions. The P0.4 screenshots are `recovered-{chrome,edge}.png`, paired with `recovery-{chrome,edge}.json`.

### Documentation review checkpoint

This documentation-only work unit reconciles requirement coverage, dependency ownership, P0 scope, and evidence policy. Acceptance requires valid local Markdown links, whitespace and formatting checks, source-to-plan review of each finding above, unchanged product/dependency/result files, and a reviewable PR. Validation is recorded in [the review evidence](../evidence/docs-review-2026-09-05.md). It does not complete P0.5 or authorize P1 implementation.

## Work breakdown

### P0.-1 Git/GitHub bootstrap gate

Observed repository state on 2026-08-27:

- [x] Repository is a valid local Git worktree.
- [x] No commit exists yet; `HEAD` is unborn.
- [x] Current unborn branch is named `master`.
- [x] No Git remote or upstream is configured.
- [x] GitHub CLI (`gh`) is not installed or not available on `PATH`; authentication cannot be checked.
- [x] Obtain or create the GitHub repository and its `origin` URL.
- [x] Install GitHub CLI and authenticate the intended GitHub account, or explicitly select another authenticated GitHub workflow.
- [x] Rename the unborn branch to `main`.
- [x] Validate and create the one-time documentation-only baseline commit authorized by `AGENTS.md`.
- [x] Push the baseline and establish `origin/main` as the upstream/default branch.
- [x] Configure the repository to require pull requests for changes to `main`, disallow force pushes, and require available validation checks as CI is introduced.
- [x] Verify the complete workflow with a documentation-only feature branch and pull request if needed.

Gate: no P0.0 product/toolchain implementation begins until `origin/main` exists, GitHub authentication works, and the pull-request workflow is usable. Evidence includes sanitized `git remote -v`, `git branch -vv`, `gh auth status`, the baseline commit ID, and the repository/default-branch protection URL or settings record.

### P0.0 Repository foundation

- [x] Create the minimal workspace and package boundaries described by `ARCHITECTURE.md`.
- [x] Pin the Node/package-manager/toolchain versions used by the repository.
- [x] Establish root commands for build, static checks, unit tests, browser tests, GPU validation, and P0 benchmarks.
- [x] Add dependency-boundary enforcement or an equivalent test.
- [x] Keep the repository buildable without Rust until P2.

Evidence:

- `pnpm check` passes formatting, ESLint, TypeScript project-reference checking, 2 Vitest tests, and the dependency-boundary check.
- `pnpm build` produces all three package outputs and the Vite playground production bundle.
- `pnpm list --recursive --prod --depth Infinity` shows only the four local workspace packages in the runtime graph; no external renderer, scene graph, tessellator, or Rust/WASM dependency exists.
- `pnpm peers check` reports no peer dependency issues with the locked toolchain.
- `pnpm test:browser`, `pnpm test:gpu`, and `pnpm benchmark:p0` are stable root entrypoints that exit 1 with an explicit `NOT IMPLEMENTED` message until P0.2, P0.4, and P0.5 respectively. They cannot be mistaken for validation evidence before their owning checkpoints.

### P0.1 Contracts and diagnostics

- [x] Define renderer lifecycle, pixel-size, invalidation, statistics, capability-result, and diagnostic contracts without WebGPU types.
- [x] Define stable diagnostic codes for capability, initialization, validation, device loss, recovery, allocation, render, and disposal events.
- [x] Implement subscription disposal and deterministic timestamps for tests.
- [x] Define resource-accounting categories and byte-estimation rules.

Evidence:

- `pnpm check` passes formatting, ESLint, TypeScript project-reference checking, 21 tests across 5 Vitest files, and dependency-boundary validation.
- `tests/unit/contracts.test.ts` verifies lifecycle/invalidation/resource constants, plain-data contract shapes, runtime-frozen stable constants, unique diagnostic codes, and every required diagnostic category.
- `tests/unit/contracts-boundary.test.ts` rejects framework, concrete-renderer, browser runtime, and GPU API types or imports from the public contracts package.
- `rg -n 'GPU[A-Z][A-Za-z]+|HTMLCanvasElement|HTMLElement|from ["'']react' packages/contracts/dist` reports no forbidden type or import in the generated public declarations.
- `tests/unit/diagnostic-channel.test.ts` verifies injected deterministic timestamps, monotonic sequence numbers, immutable payloads, independent idempotent subscriptions, teardown, and listener-failure isolation.
- `tests/unit/resource-accounting.test.ts` verifies buffer, layered/multisampled 2D texture, 3D mip, and count-only estimation rules plus live/peak accounting, release, clear, duplicate IDs, invalid descriptors, and safe-integer overflow handling.
- `pnpm build` produces clean declaration/JavaScript outputs for all three packages and the playground production bundle.

### P0.2 WebGPU initialization and surface

- [x] Detect secure context, `navigator.gpu`, adapter availability, and canvas-context availability separately.
- [x] Request and record adapter/device information and limits.
- [x] Configure the canvas using the preferred presentation format.
- [x] Convert CSS size and DPR to bounded physical dimensions using device limits.
- [x] Suspend presentation for zero-area surfaces while retaining valid lifecycle state.
- [x] Handle resize without recreating size-independent resources.

Evidence:

- `pnpm check` passes formatting, ESLint, TypeScript project-reference checking, 33 tests across 7 Vitest files, and dependency-boundary validation.
- `tests/unit/webgpu-backend.test.ts` injects platform, adapter, device, and canvas-context ports to verify distinct capability/initialization diagnostics, recorded adapter/device capabilities, preferred-format configuration, shared concurrent initialization, ready-state idempotence, terminal disposal, and stale-completion rejection.
- `tests/unit/surface-size.test.ts` verifies DPR conversion, rounding, device-limit clamping, zero-area suspension, and invalid-input rejection. Backend tests additionally assert that resize does not request another adapter/device or reconfigure the context.
- `pnpm test:browser` passes the real canvas initialization and resize test in stable Chrome `151.0.7922.174` and Edge `151.0.4129.107` on the Windows reference machine: 2 tests passed in 3.8 seconds. This is headless browser-integration evidence with `--enable-unsafe-webgpu`, not the headed hardware acceptance owned by P0.4.
- The browser test verifies a supported capability result, ready lifecycle, preferred presentation format, positive `maxTextureDimension2D`, exact 640 x 360 physical sizing, DPR resize, zero-area suspension, and zero page errors in both browsers.
- `pnpm build` produces clean outputs for all three packages and the WebGPU-enabled playground production bundle.
- `pnpm list --recursive --prod --depth Infinity` shows no new runtime dependency; Playwright is root test tooling only and TypeScript's pinned DOM library supplies concrete WebGPU bindings.

### P0.3 Render scheduling and foundation scene

- [x] Coalesce multiple invalidations into at most one submitted frame per animation frame.
- [x] Submit no frames while idle and unchanged.
- [x] Support an explicit continuous mode for benchmark and future animation use.
- [x] Create shader modules and pipelines outside the steady-state frame path.
- [x] Render a deterministic clear color and triangle through a multisampled target when four-sample MSAA is supported.
- [x] Fall back from four-sample to one-sample only as an explicit recorded capability decision, not to another renderer.

Evidence: scheduler tests, pipeline/resource counters, browser screenshot, and P0 steady/idle benchmark results.

P0.3 implementation evidence:

- `FrameScheduler` has an injected animation-frame clock and deterministic tests for a 100-invalidation burst, idle behavior, continuous mode, and disposal cancellation. Backend tests assert one render, stable shader/pipeline counters, and the explicit `capability.msaa-fallback` diagnostic.
- The concrete WebGPU backend creates its WGSL shader and render pipeline during initialization. It selects four-sample MSAA when pipeline creation succeeds, records a four-to-one-sample fallback otherwise, owns the size-dependent multisample attachment, and renders a deterministic clear plus gradient triangle.
- `pnpm check` passes formatting, ESLint, TypeScript project-reference checking, 39 tests across 8 Vitest files, and dependency-boundary validation. `pnpm build` produces all package and playground production outputs.
- `pnpm test:browser --headed` passes 6/6 tests in Chrome `151.0.7922.174` and Edge `151.0.4129.107`; committed visual artifacts are `docs/evidence/p0.3/foundation-chrome.png` and `foundation-edge.png`.
- `pnpm benchmark:p0:p0-3` runs a production build with headed browsers, DevTools/tracing/recording disabled, a 1280 x 720 physical surface at DPR 1, 3-second warm-up, 10-second steady window, 5-second idle window, and five repetitions per browser. Browser projects run serially so each headed window remains foreground-visible and avoids background throttling.
- Chrome and Edge both record a worst per-run frame-interval p95 of 16.8 ms, CPU encode-and-submit p95 of 0.2 ms, zero long tasks, zero measured-window shader/pipeline creation, and 14,745,600 peak engine-accounted bytes. Every idle repetition records exactly one burst submission, zero subsequent idle submissions, and zero pending callbacks after disposal. Raw JSON and Markdown results are committed under `docs/benchmarks/results/2026-08-27_p0.3_*`.

### P0.4 Resource lifecycle and recovery

Execution details fixed before implementation:

- A device-generation token is captured by every device listener and render submission. Loss from a stale or disposed generation is ignored and cannot start recovery.
- Current-generation loss pauses animation-frame scheduling before GPU resources are released. Diagnostics are ordered as `device-loss.detected` on the lost generation, `recovery.started` on the next generation, then exactly one of `recovery.succeeded` or `recovery.failed` on that next generation.
- One loss event starts at most one adapter/device recovery attempt. Success reconfigures the existing canvas context, rebuilds the foundation scene from CPU-owned surface descriptors, resumes the prior scheduler mode, and presents a recovery frame. Failure is terminal for that backend instance until disposal.
- Uncaptured validation and out-of-memory errors map to their existing stable diagnostic codes with the current backend generation, normalized error type, and message. Unknown GPU errors use the existing render/allocation failure paths rather than inventing a silent category.
- Resource accounting represents live engine-owned resources. Size-independent shader/pipeline records are released with the lost generation; the multisample attachment is released before resize replacement. Dispose removes device listeners, releases every tracked resource, cancels pending animation callbacks, and clears diagnostic subscriptions.
- Deliberate validation-error and device-destruction controls exist only on the concrete WebGPU backend/playground test surface. They are not added to renderer contracts or durable editor APIs.
- P0.4 implements the headed `test:gpu` command for Chrome and Edge. The generalized 25-cycle benchmark record and all-scenario `benchmark:p0` command remain P0.5/P0.6 work, while deterministic 25-cycle resource/listener assertions are required now.

- [x] Track owned buffers, textures, shader modules, pipelines, and size-dependent attachments.
- [x] Replace and release size-dependent attachments on resize.
- [x] Capture uncaptured GPU validation and out-of-memory errors as structured diagnostics.
- [x] Observe device loss and prevent work submission to the lost generation.
- [x] Simulate loss by deliberately destroying the device in a test-only control.
- [x] Attempt one recovery and rebuild the foundation scene from CPU descriptors.
- [x] Release all tracked resources and listeners on dispose.

Evidence: lifecycle contract suite, resource-counter assertions, ordered loss/recovery diagnostics, and headed hardware recovery run.

Validation method:

- `pnpm check` covers deterministic listener cleanup, validation/out-of-memory mapping, resize replacement, stale-loss rejection, single-attempt recovery success/failure, generation changes, and 25 lifecycle cycles.
- `pnpm test:browser` retains the normal Chrome/Edge initialization and rendering surface.
- `pnpm test:gpu` runs headed Chrome and Edge, triggers one uncaptured validation error, destroys the active device, asserts ordered diagnostics and one generation increment, then waits for a post-recovery presentation.
- `pnpm build` and the dependency-boundary audit verify that concrete WebGPU types and test controls do not escape the backend boundary.

P0.4 implementation evidence:

- `pnpm check` passes formatting, ESLint, TypeScript project-reference checking, 45 tests across 8 Vitest files, and dependency-boundary validation. The lifecycle suite covers validation/out-of-memory/internal error mapping, ordered recovery success and failure, concurrent `initialize` sharing the in-flight recovery, stale loss after disposal, attachment replacement, scheduler pause/resume, and 25 initialize/render/dispose cycles.
- The 25-cycle test records four live foundation resources while ready (vertex buffer, multisample texture, shader module, and render pipeline), then zero live resources, zero bytes, zero diagnostic/device listeners, and zero pending animation callbacks after every disposal.
- `pnpm build` produces all package and playground production outputs. The foundation triangle now uses an owned 60-byte vertex buffer so buffer lifetime participates in real backend accounting without adding a runtime dependency.
- `pnpm test:browser` passes 6/6 normal WebGPU integration tests in Chrome and Edge after the lifecycle changes.
- `pnpm test:gpu` passes 2/2 headed hardware tests on Windows `10.0.26200`, NVIDIA/Turing, Chrome `152.0.7977.76`, and Edge `152.0.4191.62`. Each browser surfaces one deliberately uncaptured native validation error, reports loss/start/success diagnostics for generations 1/2/2, performs one recovery attempt, rebuilds four live resources, and presents from generation 2 with no page errors.
- Machine-readable headed-run records are `docs/evidence/p0.4/recovery-{chrome,edge}.json`; post-recovery screenshots are `recovered-{chrome,edge}.png` in the same directory. The generalized `p0/lifecycle-recovery/v1` benchmark record remains assigned to P0.5/P0.6 as planned.

### P0.4a Recovery regression correction

The review found missing proof of existing lifecycle invariants; this correction runs before P0.5 so the measurement harness does not encode or measure known-invalid recovery behavior. It changes neither the lifecycle contract nor the P0.4 historical evidence.

- [ ] After recovery fails, repeated explicit/concurrent `initialize` calls return the stored terminal result, make no new adapter/device request, and cannot return the instance to ready. Disposal remains idempotent; a new instance may initialize.
- [ ] Hold recovery promises pending while invalidating, changing mode, or disposing. Assert zero render calls on the old device/scene after loss, one controlled attempt, no resurrection after disposal, and rendering only through the rebuilt generation on success.
- [ ] Re-enter lifecycle methods from diagnostic callbacks and verify they cannot trigger duplicate recovery, submit through the lost generation, or revive disposed resources.
- [ ] Treat `staleGenerationSubmissions` as a diagnostic counter only. Acceptance for exclusion requires instrumented old/new render spies and scheduler callback assertions rather than a constant zero value.

Validation method:

- `pnpm check` runs named deterministic regressions for terminal recovery failure, delayed recovery success/disposal, diagnostic-callback re-entry, device request counts, old/new render spies, listener cleanup, and pending animation callbacks.
- `pnpm build` verifies the correction does not alter package boundaries or leak concrete WebGPU types.
- `pnpm test:browser` verifies the normal Chrome/Edge foundation path after the lifecycle correction.
- `pnpm test:gpu` refreshes headed Chrome/Edge recovery evidence with the reviewed revision and retains ordered real-device loss/recovery diagnostics.

Evidence: named regression tests through the commands above and headed Chrome/Edge recovery artifacts with revision metadata. These corrections must pass before P0.5 begins; they do not retroactively rewrite P0.4 run records.

### P0.5 Playground and measurement harness

- [ ] Display backend state, adapter identity, surface size, sample count, frame counters, timing summaries, and recent diagnostics.
- [ ] Provide controls for invalidation, continuous rendering, resize storm, device-loss simulation, and disposal/reinitialize checks.
- [ ] Use stable scenario IDs, versions, and seeds.
- [ ] Export raw benchmark data and environment metadata as JSON.
- [ ] Generate or support generation of the committed Markdown result format.
- [ ] Ensure measurement mode runs a production build without DevTools or tracing overhead.

Evidence: browser integration tests, manual smoke artifact, and schema-valid result files.

Acceptance details fixed by this review before P0.5 implementation:

- Implement all five scenarios below through `pnpm benchmark:p0`; the P0.3 command only covers steady/idle. Version a scenario when the measurement/configuration changes, retain old definitions/results, and bind the successor to these unchanged thresholds before running it.
- Validate JSON with positive sample/repetition counts, finite metrics, explicit unavailable reasons, per-run diagnostics, actual start/end times, full scenario configuration, schema/runner versions, and matching configuration hash. Missing required metrics yield UNVERIFIED, never numeric PASS.
- Report navigation-to-ready, initialization-to-ready, first submission, GPU completion, and observed presentation as separate events when available. Fix time origins and sampling before implementing startup/recovery timing; submission alone cannot satisfy “present.” An unavailable presentation method keeps that criterion UNVERIFIED pending a documented measurement decision.
- Use bounded or explicitly started/stopped measurement storage; normal continuous mode must not accumulate an unbounded array. Tests exercise repeated windows and show no retained samples after reset/disposal.
- Capture diagnostics across warm-up and measurement with generation/scenario identity. Expected deliberate loss events are listed separately from unexpected errors; no blanket filtering by severity.
- Write new run artifacts to unique paths with actual UTC date/run ID and refuse an existing path. Test two same-day exports, accurate clean/dirty provenance, unsupported observers, empty samples, invalid metadata, and JSON/Markdown metric agreement. Preserve all committed historical results.
- The dashboard displays current-generation capability metadata after recovery. Disposal/reinitialize controls create a new backend instance, since disposal is terminal.

### P0.5a Missing foundation experiments

These items restore the existing P0 roadmap scope; the foundation triangle and a single owned vertex buffer do not prove them. Implement as a separately reviewable checkpoint after P0.5 and before P0.6.

- [ ] **P0-A13 camera transform:** centralize document/CSS/physical conversions with inverse mapping; define matrix order and invalid-input handling. Unit fixtures cover translation, zoom, DPR 1/1.5/2, negative positions, and inverse round trips with absolute error at most `1e-8` over the fixture domain (coordinates within +/-10,000 and zoom 0.01 to 64). A headed triangle fixture verifies known transformed screen positions within one physical pixel. This is a fixture domain, not the editor's final coordinate limit.
- [ ] **P0-A14 buffer suballocation experiment:** exercise deterministic allocate/free/reuse over a shared buffer with alignment, non-overlap, exhaustion, and invalid-free assertions; retain CPU allocation descriptors and rebuild on recovery. Record capacity, requested/allocated/live/peak bytes and buffer creation count; a headed draw fixture reads distinct allocation ranges and disposal returns ownership counters to zero. Define safe reuse relative to submitted GPU work before implementing the allocator. No speedup claim is required.
- [ ] **P0-A15 keyed pipeline cache:** define keys for shader/layout, target format, sample count, and relevant render state. Identical requests reuse one entry, incompatible keys do not alias, and loss invalidates the generation's entries. Unit tests plus headed resource counters show no steady-state creation and successful rebuild; a single pipeline created at startup alone is insufficient cache evidence.

Evidence: `pnpm check`, `pnpm build`, headed Chrome/Edge fixture artifacts, and counters linked individually to P0-A13/A14/A15. Record any changed benchmark configuration as a successor scenario before final measurement.

### P0.6 Final validation and gate review

- [ ] Run the complete static/unit/contract/browser validation surface.
- [ ] Run headed Chrome and Edge GPU validation on the reference machine.
- [ ] Execute five repetitions of every P0 benchmark scenario.
- [ ] Commit raw JSON and Markdown summaries.
- [ ] Evaluate every acceptance criterion below as PASS, FAIL, or UNVERIFIED.
- [ ] Record residual risks and decide whether P1 may begin.

Evidence: completed acceptance matrix and linked result files.

## Acceptance criteria

| ID     | Criterion                                                                                                                                                | Required validation                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| P0-A01 | Insecure context, missing WebGPU API, missing adapter, missing canvas context, and device-request failure produce distinct stable diagnostic codes.      | Unit + browser                       |
| P0-A02 | Initialization is concurrency-safe and idempotent; disposal is idempotent and terminal; stale async completion cannot revive disposed state.             | Unit + contract                      |
| P0-A03 | Surface sizing applies DPR, clamps to adapter limits, handles zero area without presenting, and recreates only size-dependent resources.                 | Unit + browser + resource counters   |
| P0-A04 | The foundation scene presents the expected clear color and triangle in stable Chrome and Edge.                                                           | Headed browser + visual artifact     |
| P0-A05 | Multiple invalidations before the next animation frame produce at most one submission; an unchanged idle backend submits none.                           | Unit + benchmark                     |
| P0-A06 | Shader module and pipeline creation counts remain constant throughout steady-state measured frames.                                                      | Resource counters + benchmark        |
| P0-A07 | Uncaptured validation/out-of-memory errors and device loss are surfaced as structured diagnostics with backend generation and context.                   | Contract + headed hardware           |
| P0-A08 | Deliberate device destruction invalidates old resources, performs one controlled recovery, rebuilds the foundation scene, and presents again.            | Headed Chrome + Edge                 |
| P0-A09 | After each dispose, engine-owned live-resource counters return to zero; 25 lifecycle cycles show no accumulating tracked resources or listeners.         | Contract + benchmark                 |
| P0-A10 | Benchmark output includes all metadata required by `docs/benchmarks/README.md` and can reproduce the scenario from ID, version, seed, and configuration. | Schema/contract test                 |
| P0-A11 | The production build passes the full planned root validation commands and contains no runtime renderer/scene/tessellation dependency.                    | Static + dependency audit            |
| P0-A12 | Renderer contracts and editor-facing code contain no exported WebGPU types; only the concrete backend imports WebGPU bindings.                           | Type/API boundary test               |
| P0-A13 | Camera conversions and rendered transforms satisfy P0.5a fixtures.                                                                                       | Unit + headed visual/numeric fixture |
| P0-A14 | Shared-buffer suballocation satisfies alignment, lifetime, recovery, and accounting invariants in P0.5a.                                                 | Unit + headed GPU counters/fixture   |
| P0-A15 | Pipeline cache keys preserve compatibility, reuse, and generation invalidation as defined in P0.5a.                                                      | Unit + headed GPU counters           |

P0 passes only when all P0-A criteria are PASS. A criterion cannot be waived by a good benchmark number.

At this review, P0-A01 through A12 retain partial historical evidence, not a final-current-revision PASS. P0-A07's hardware OOM path, presentation timing, complete benchmark metadata/scenarios, and A13-A15 are explicitly UNVERIFIED. P0.6 must add a per-ID outcome with evidence revision/artifact links for all fifteen criteria and all five scenarios in both browsers. A numeric scenario result and evidence validity are separate evaluations.

## P0 benchmark scenarios and thresholds

All runs follow `docs/benchmarks/README.md`, use the reference 1280 x 720 physical surface at DPR 1, run a production build, warm for 3 seconds where applicable, and contain at least five measured repetitions.

### `p0/startup/v1`

Repeated fresh page loads through backend ready and first present.

- Backend-ready wall time p95: at most 1,000 ms
- First-present wall time p95: at most 1,200 ms
- Error diagnostics: zero

The result records adapter request and device request subspans separately so browser/driver cost is not confused with engine work.

### `p0/steady-foundation/v1`

Continuous presentation of the unchanged foundation scene for 10 measured seconds after warm-up.

- Frame interval p95: at most 18.0 ms on a 60 Hz display
- CPU encode-and-submit p95: at most 2.0 ms
- Long tasks greater than 50 ms: zero
- Pipeline/shader creation during measured window: zero
- Peak engine-accounted GPU bytes: at most 32 MiB

Refresh rates other than 60 Hz require recording and a derived frame-interval threshold approved before the run; CPU and resource thresholds remain unchanged.

### `p0/idle-invalidation/v1`

Issue 100 invalidations synchronously, wait for settlement, then observe for 5 seconds.

- Submissions caused by the burst: exactly one
- Submissions during the subsequent idle window: zero
- Pending animation callbacks after disposal: zero

### `p0/resize-storm/v1`

Apply 120 deterministic size/DPR changes over 2 seconds, followed by the reference size.

- At most one submitted frame per animation frame
- CPU encode-and-submit p95: at most 2.0 ms
- Live size-dependent attachment count after settlement: exactly one color target when MSAA is active, otherwise zero
- Final physical surface size: exactly 1280 x 720
- Validation/error diagnostics: zero

### `p0/lifecycle-recovery/v1`

Run 25 initialize/render/dispose cycles, followed by one deliberate device-loss and recovery cycle.

- Live engine-owned resource count after each dispose: zero
- Retained diagnostic listeners after each dispose: zero
- Recovery reaches ready and presents within 3,000 ms
- Recovery attempts for one loss event: exactly one
- Stale-generation submissions: zero

Browser heap and process GPU memory are recorded when available but are advisory in P0; engine-owned allocation counters are the acceptance source.

## Validation mapping

Repository commands must cover these responsibilities by P0.6:

```text
check          -> P0-A01, A02, A03, A05, A06, A09, A10, A11, A12-A15 deterministic evidence
test:browser   -> P0-A01, A03, A04 automated browser evidence
test:gpu       -> P0-A04, A07, A08, A13-A15 headed Chrome/Edge evidence
benchmark:p0   -> P0-A05, A06, A09, A10 and all p0/* scenarios
build          -> P0-A11 production artifacts
```

The implementation may choose concrete tools, but these root responsibilities and evidence outputs are required.

## Risks and mitigations

| Risk                                                     | Mitigation / gate                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Headless browser uses a software or incompatible adapter | Do not use it for hardware acceptance; require headed Chrome/Edge evidence                |
| Browser does not expose physical GPU allocation          | Use engine-owned byte accounting and label browser metrics advisory                       |
| Device-loss behavior varies by driver                    | Test stable diagnostic/state invariants and retain environment metadata                   |
| Pipeline compilation creates first-frame jank            | Measure startup separately and assert no creation in steady state                         |
| DPR creates unexpectedly large MSAA targets              | Clamp to device limits, record physical size, and test native-DPR visual smoke separately |
| Early abstraction mirrors WebGPU and blocks WebGL2 later | Keep the common boundary at render intent/draw packets as defined by `ARCHITECTURE.md`    |

## Explicit non-goals

- Retained document scene synchronization
- Primitive instancing and 1,000/10,000-node scenes
- Path representation, flattening, or tessellation
- Rust/WASM toolchain
- Hit testing and spatial index
- Text, editor tools, React bindings, persistence, and export
- WebGL2 fallback

## Progress log

| Date       | Update                                                                                                                                | Evidence / decision                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-27 | Documentation gate established; no implementation started.                                                                            | `AGENTS.md`, `ARCHITECTURE.md`, this plan, validation and benchmark policies                                                                          |
| 2026-08-27 | Git/GitHub workflow audited. Repository has no commits, remote, upstream, or available `gh` CLI; P0 is gated on bootstrap.            | Local Git and CLI status checks; `AGENTS.md` workflow                                                                                                 |
| 2026-08-27 | Public `origin` registered, unborn branch renamed to `main`, and GitHub CLI authenticated as `npclown`.                               | `gh auth status`, `gh repo view`, `git remote -v`, `git status --branch`                                                                              |
| 2026-08-27 | Documentation-only baseline `21afc22` pushed to `origin/main`; squash-only merge and protected `main` configured.                     | GitHub repository and branch-protection API verification                                                                                              |
| 2026-08-27 | Feature branch workflow completed through validation, commit, push, PR #1, protected squash merge, and branch cleanup.                | `https://github.com/npclown/vector-studio/pull/1`                                                                                                     |
| 2026-08-27 | P0.0 repository foundation completed locally and submitted through PR #4.                                                             | `pnpm check`, `pnpm build`, `pnpm peers check`, production dependency graph, and explicit future-gate command results                                 |
| 2026-08-27 | P0.0 pull-request validation passed on GitHub's Windows runner.                                                                       | PR #4 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33072953884/job/98519653495`            |
| 2026-08-27 | The P0.0 validation job became a strict required status check on protected `main`.                                                    | GitHub branch-protection API: `Static, unit, boundaries, and build`, strict mode enabled                                                              |
| 2026-08-27 | P0.0 integrated into protected `main` through a squash merge.                                                                         | PR #4: `https://github.com/npclown/vector-studio/pull/4`; merge commit `a3c1219`                                                                      |
| 2026-08-27 | P0.1 contracts, diagnostics, subscriptions, and resource accounting completed locally and submitted through PR #6.                    | `pnpm check`: 21 tests across 5 files; `pnpm build`; public-contract architecture-boundary test                                                       |
| 2026-08-27 | P0.1 pull-request validation passed on GitHub's Windows runner.                                                                       | PR #6 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33074926266/job/98526521203`            |
| 2026-08-27 | P0.1 integrated into protected `main` through a squash merge.                                                                         | PR #6: `https://github.com/npclown/vector-studio/pull/6`; merge commit `607a5f6`                                                                      |
| 2026-08-27 | P0.2 WebGPU initialization and surface handling completed locally and submitted through PR #8.                                        | `pnpm check`: 33 tests across 7 files; `pnpm test:browser`: Chrome and Edge 2/2; `pnpm build`; production dependency audit                            |
| 2026-08-27 | P0.2 pull-request validation passed on GitHub's Windows runner.                                                                       | PR #8 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33076963055/job/98533565510`            |
| 2026-08-27 | P0.2 integrated into protected `main` through a squash merge.                                                                         | PR #8: `https://github.com/npclown/vector-studio/pull/8`; merge commit `3de7801`                                                                      |
| 2026-08-27 | P0.3 render scheduling, foundation scene, headed visual evidence, and fixed-scenario benchmark implementation completed locally.      | `pnpm check`: 39 tests across 8 files; `pnpm build`; headed Chrome/Edge 6/6; production P0.3 benchmark 2/2 with five repetitions per scenario/browser |
| 2026-08-27 | P0.3 pull-request validation passed on GitHub's Windows runner.                                                                       | PR #10 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33081358041/job/98549136759`           |
| 2026-08-27 | P0.3 integrated into protected `main` through a squash merge.                                                                         | PR #10: `https://github.com/npclown/vector-studio/pull/10`; merge commit `b9285b9`                                                                    |
| 2026-09-04 | P0.4 resource lifecycle, structured GPU errors, generation-safe device-loss recovery, and headed hardware evidence completed locally. | `pnpm check`: 45 tests across 8 files; `pnpm build`; browser 6/6; headed GPU Chrome/Edge 2/2; `docs/evidence/p0.4/`                                   |
| 2026-09-04 | P0.4 pull-request validation passed on GitHub's Windows runner.                                                                       | PR #12 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33839256994/job/100918002724`          |
| 2026-09-04 | P0.4 integrated into protected `main` through a squash merge.                                                                         | PR #12: `https://github.com/npclown/vector-studio/pull/12`; merge commit `a15adcb`                                                                    |

Documentation review update, 2026-09-05: reconciled the dependency graph (ADR 0001), mapped graphics/MVP coverage, restored missing P0 foundation acceptance, and recorded lifecycle/measurement follow-ups. Local documentation links/formatting, `git diff --check`, `pnpm check` (45 tests), and `pnpm build` pass; details and reproduction commands are in `docs/evidence/docs-review-2026-09-05.md`. This update adds no implementation or benchmark result.

## Gate outcome

Current outcome: **P0 OPEN; P0.4 INTEGRATED, P0.4A IN PROGRESS**. The historical P0.4 checkpoint and its CI/hardware evidence remain recorded. PR #14 identified a terminal-recovery gap and limits to constant-counter evidence; P0.4a corrects those lifecycle regressions before they become inputs to the measurement harness. Next: P0.4a recovery corrections, P0.5 measurement harness, P0.5a foundation experiments, then P0.6 full gate review. P1 may not begin until the complete P0 gate passes or the owning design is explicitly revised before implementation.
