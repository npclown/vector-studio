# P0 execution plan: WebGPU foundation

Status: P0 final local acceptance PASS on b524927; protected PR integration gate applies; P1 execution planning is next

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

The terminal restriction after recovery failure is an existing P0.4 requirement. P0.4a corrected the former retryable-failure behavior and added deterministic and headed regression evidence before P0.5.

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

- [x] After recovery fails, repeated explicit/concurrent `initialize` calls return the stored terminal result, make no new adapter/device request, and cannot return the instance to ready. Disposal remains idempotent; a new instance may initialize.
- [x] Hold recovery promises pending while invalidating, changing mode, or disposing. Assert zero render calls on the old device/scene after loss, one controlled attempt, no resurrection after disposal, and rendering only through the rebuilt generation on success.
- [x] Re-enter lifecycle methods from diagnostic callbacks and verify they cannot trigger duplicate recovery, submit through the lost generation, or revive disposed resources.
- [x] Treat `staleGenerationSubmissions` as a diagnostic counter only. Acceptance for exclusion requires instrumented old/new render spies and scheduler callback assertions rather than a constant zero value.

Validation method:

- `pnpm check` runs named deterministic regressions for terminal recovery failure, delayed recovery success/disposal, diagnostic-callback re-entry, device request counts, old/new render spies, listener cleanup, and pending animation callbacks.
- `pnpm build` verifies the correction does not alter package boundaries or leak concrete WebGPU types.
- `pnpm test:browser` verifies the normal Chrome/Edge foundation path after the lifecycle correction.
- `pnpm test:gpu` refreshes headed Chrome/Edge recovery evidence with the reviewed revision and retains ordered real-device loss/recovery diagnostics.

Evidence: named regression tests through the commands above and headed Chrome/Edge recovery artifacts with revision metadata. These corrections must pass before P0.5 begins; they do not retroactively rewrite P0.4 run records.

P0.4a implementation evidence:

- `pnpm check` passes formatting, ESLint, TypeScript project-reference checking, 48 tests across 8 Vitest files, and dependency-boundary validation. Named regressions cover terminal recovery failure, delayed success/disposal, diagnostic-callback re-entry, stable adapter request counts, old/new render spies, and scheduler cleanup.
- The backend installs a shared recovery promise before emitting loss diagnostics. A failed recovery stores its terminal result, while disposal invalidates a pending attempt without allowing resource or render resurrection. `FrameScheduler` no longer schedules continuous work while inactive.
- `pnpm build` produces all library outputs and the Vite playground production bundle; no package boundary or dependency changed.
- `pnpm test:browser` passes 6/6 normal WebGPU integration tests in Chrome and Edge.
- `pnpm test:gpu` passes 2/2 headed hardware tests on Windows `10.0.26200`, NVIDIA/Turing, Chrome `152.0.7977.76`, and Edge `152.0.4191.62` against clean source revision `541bf87aead8f4d391fa311c084b75ddd07884c2`. Each browser records one controlled recovery, generations 1 to 2, rebuilt live resources, ordered diagnostics, and no page errors.
- New machine-readable records and screenshots are under `docs/evidence/p0.4a/`. The immutable `docs/evidence/p0.4/` records were not modified.

### P0.5 Playground and measurement harness

Execution order:

- [x] **P0.5.0 measurement contract:** define clocks/events, bounded collection, scenario/result schema, configuration hashing, provenance, validation, and collision-safe artifact writing with deterministic unit tests.
- [x] **P0.5.1 playground controls:** expose the required dashboard and controls through a backend-instance composition root; disposal/reinitialize replaces the terminal backend instance.
- [x] **P0.5.2 five-scenario runner:** replace the pending root command, execute every `p0/*/v1` scenario in the production headed Chrome/Edge configuration, and generate schema-valid raw JSON plus matching Markdown without accepting its own output.
- [x] **P0.5.3 smoke evidence and integration:** run a bounded smoke profile, inspect dashboard/JSON/Markdown artifacts, record limitations, pass required CI, and integrate before P0.5a.

- [x] Display backend state, adapter identity, surface size, sample count, frame counters, timing summaries, and recent diagnostics.
- [x] Provide controls for invalidation, continuous rendering, resize storm, device-loss simulation, and disposal/reinitialize checks.
- [x] Use stable scenario IDs, versions, and seeds.
- [x] Export raw benchmark data and environment metadata as JSON.
- [x] Generate or support generation of the committed Markdown result format.
- [x] Ensure measurement mode runs a production build without DevTools or tracing overhead.

Evidence: browser integration tests, manual smoke artifact, and schema-valid result files.

Acceptance details fixed by this review before P0.5 implementation:

- Implement all five scenarios below through `pnpm benchmark:p0`; the P0.3 command only covers steady/idle. Version a scenario when the measurement/configuration changes, retain old definitions/results, and bind the successor to these unchanged thresholds before running it.
- Validate JSON with positive sample/repetition counts, finite metrics, explicit unavailable reasons, per-run diagnostics, actual start/end times, full scenario configuration, schema/runner versions, and matching configuration hash. Missing required metrics yield UNVERIFIED, never numeric PASS.
- Report navigation-to-ready, initialization-to-ready, first submission, GPU completion, and observed presentation as separate events when available. Fix time origins and sampling before implementing startup/recovery timing; submission alone cannot satisfy “present.” An unavailable presentation method keeps that criterion UNVERIFIED pending a documented measurement decision.
- Use bounded or explicitly started/stopped measurement storage; normal continuous mode must not accumulate an unbounded array. Tests exercise repeated windows and show no retained samples after reset/disposal.
- Capture diagnostics across warm-up and measurement with generation/scenario identity. Expected deliberate loss events are listed separately from unexpected errors; no blanket filtering by severity.
- Write new run artifacts to unique paths with actual UTC date/run ID and refuse an existing path. Test two same-day exports, accurate clean/dirty provenance, unsupported observers, empty samples, invalid metadata, and JSON/Markdown metric agreement. Preserve all committed historical results.
- The dashboard displays current-generation capability metadata after recovery. Disposal/reinitialize controls create a new backend instance, since disposal is terminal.

Measurement and artifact decisions fixed before P0.5 implementation:

- Schema ID is `vector-studio/p0-benchmark-result/v1`; runner ID starts at `vector-studio/p0-runner/v1`. Each record is one browser/scenario run containing all repetitions and raw samples. Generated records start with `Exploratory`; only the execution-plan review may change acceptance status.
- Browser monotonic timings use `performance.now()` with `performance.timeOrigin` recorded for UTC correlation. Navigation-to-ready starts at the navigation time origin; initialization-to-ready starts immediately before `initialize`; first submission and queue completion are elapsed from that same initialization start. Recovery timing starts when the current-generation loss diagnostic is observed.
- Queue completion means the promise returned by `GPUQueue.onSubmittedWorkDone()` after the relevant submission. It is named `gpuCompletion`, not presentation. The browser WebGPU surface exposes no physical-display presentation timestamp, so `observedPresentation` is unavailable with reason `browser-webgpu-no-presentation-timestamp`; first-present thresholds remain UNVERIFIED unless a prospective plan decision adopts a real observation method.
- Frame and diagnostic collection is inactive by default. A measurement window explicitly starts, has a default hard capacity of 4,096 samples per numeric stream, and stops or resets without retaining samples. Overflow records dropped counts and makes any criterion depending on the truncated stream UNVERIFIED.
- Metric values are represented as available finite values with units and observation metadata, or unavailable values with a non-empty stable reason. Empty samples, non-finite/negative durations, unsupported observers, hidden/throttled pages, unexpected diagnostics, and configuration-hash mismatch are validation outcomes, never coerced to zero.
- Scenario configuration hashes use SHA-256 over UTF-8 canonical JSON with recursively sorted object keys and preserved array order. The stored full configuration is hashed again during validation; mismatch rejects export.
- Artifact base names contain UTC timestamp through milliseconds, scenario/version, browser, machine slug, and a random run suffix. JSON and Markdown are written with exclusive-create semantics; if either path exists, export fails without replacing either artifact. Markdown is rendered from the validated in-memory record and metric agreement is tested.
- Source provenance records revision and clean state before execution. Dirty acceptance runs additionally require a source-manifest or patch hash; a smoke run may remain Exploratory with the explicit dirty reason. Browser flags, scenario configuration, measured window boundaries, all repetitions, and per-window diagnostics are retained.
- Acceptance runs use the exact scenario durations and five repetitions defined below. A `smoke` execution profile may reduce repetitions/durations only to validate orchestration; it retains the scenario ID/version, stores the complete changed configuration, and cannot satisfy numeric P0 thresholds.

P0.5.0 implementation evidence:

- `WebGpuBackend` frame collection is inactive by default and exposes explicit start/stop/reset windows with a default 4,096-sample capacity and per-stream dropped counts. Deterministic tests prove bounded collection, repeated reset, stop behavior, invalid capacity rejection, and disposal cleanup.
- `tests/support/p0-benchmark-record.ts` defines schema/runner IDs, canonical JSON SHA-256 hashing, metadata/sample/metric validation, Exploratory Markdown rendering, and exclusive JSON/Markdown pair creation with rollback on collision.
- Record contract tests cover recursively reordered configurations, non-finite input, dirty provenance without a delta, missing environment metadata, false-zero/empty sample counts, unavailable metrics without reasons, hash mismatch, JSON/Markdown agreement, two same-day run IDs, and overwrite refusal.
- `pnpm check` passes formatting, ESLint, TypeScript project-reference checking, 53 tests across 9 Vitest files, and dependency-boundary validation.
- `pnpm build` produces all library outputs and the Vite playground production bundle; `pnpm test:browser` passes 6/6 Chrome/Edge WebGPU integration tests.
- This checkpoint creates no benchmark observation or performance claim. P0.5.2 owns scenario execution and P0.5.3 owns smoke artifacts.

P0.5.1 interaction details fixed before implementation:

- The playground composition root is the only owner of the concrete backend instance. Its public test surface delegates to the current instance so disposal/reinitialize cannot leave stale closures.
- The dashboard uses stable element IDs and displays lifecycle/generation, current adapter, physical surface/DPR, selected sample count, frame/resource/listener counters, bounded timing summaries, and at most the 50 most recent diagnostics.
- Controls cover one and 100 invalidations, on-demand/continuous mode, a deterministic 120-step resize/DPR storm followed by the reference surface, validation error, device loss, measurement start/stop/reset, disposal, and reinitialize with a new backend instance.
- Reinitialize is serialized: concurrent requests share one replacement attempt. It disposes the old terminal instance, creates a fresh diagnostic subscription and backend, restores the reference surface, and publishes readiness only after capability resolution.
- Browser tests exercise controls through their user-facing elements, verify the dashboard matches the public snapshot, prove recovery updates current-generation capability/state, and prove disposal/reinitialize advances to a fresh instance without reusing a disposed backend.
- Dashboard refresh is event/control driven rather than a perpetual timer so the production benchmark page does not add periodic DOM work to measured windows.

P0.5.1 implementation evidence:

- The playground now owns the current `WebGpuBackend` through one mutable composition root. Its frozen test API delegates to that current instance, and the dashboard exposes stable controls and status IDs without introducing a UI/runtime dependency.
- The dashboard shows backend instance, lifecycle/generation, current capability adapter/sample count, physical surface/DPR, submission-path frame counters, resource/listener counts, bounded timing p95 summaries, dropped samples, and the 50 most recent diagnostics.
- User controls cover single/burst invalidation, continuous mode, explicit measurement windows, deterministic 120-step resize storm, native validation error, device loss, disposal, refresh, and serialized fresh-instance reinitialization.
- `pnpm check` passes formatting, ESLint, TypeScript project-reference checking, 53 tests across 9 Vitest files, and dependency-boundary validation. `pnpm build` produces the library packages and production playground bundle.
- `pnpm test:browser` passes 10/10 Chrome/Edge tests. The new tests drive dashboard controls, observe bounded samples, recover to generation 2 with refreshed capability display, dispose/reinitialize to a fresh generation-1 instance, prove two synchronous reinitialize controls create only one replacement, and restore the exact 640 x 360 DPR-1 reference surface after 120 resize steps.
- Routine browser screenshots now use the Playwright per-run output directory instead of overwriting the committed P0.3 historical images. The two historical files remain byte-identical to `main`.
- P0.5.3 still owns the committed manual smoke screenshot; no benchmark result or performance claim is created here.

P0.5.2 implementation evidence:

- `pnpm benchmark:p0` now runs a production build and the serial headed Chrome/Edge `p0-foundation.spec.ts` runner. The default `acceptance` profile requires an explicit positive display refresh rate; `--profile smoke` reduces durations/cycles but retains full configuration and cannot satisfy thresholds.
- The runner exports `p0/startup/v1`, `p0/steady-foundation/v1`, `p0/idle-invalidation/v1`, `p0/resize-storm/v1`, and `p0/lifecycle-recovery/v1`. The legacy P0.3 config is restricted to its historical runner and can no longer accidentally execute the successor suite.
- Startup records navigation-to-ready, initialization-to-ready, first submission, and `GPUQueue.onSubmittedWorkDone()` completion separately. Recovery records ready, first rebuilt submission, queue completion, and unavailable physical presentation separately; no submission/completion value is labeled present.
- Every repetition stores UTC and monotonic measurement-window boundaries, raw timed samples, counts, expected/unexpected diagnostics, dropped-sample counts, complete configuration/hash, environment, browser flags, and clean or manifest-hashed dirty source provenance.
- `pnpm benchmark:p0 -- --profile smoke --output-dir test-results/p0-smoke-final` passes 2/2 headed browser projects in 9.3 seconds after the production build. Immediate validation finds 10 JSON plus 10 matching Markdown artifacts, all schema v1 and Exploratory, with ordered windows, zero unexpected diagnostics, zero dropped samples, and all five scenario IDs in both browsers.
- `pnpm check` passes 53 tests across 9 files plus all static/boundary checks. `pnpm test:browser` passes 10/10 Chrome/Edge tests including monotonic initialization/first-submission/queue-completion ordering.
- Smoke output remains an ignored local test artifact because it measured an uncommitted source manifest. P0.5.3 owns a clean-revision committed smoke record and dashboard screenshot; this checkpoint makes no performance claim.

P0.5.3 evidence-capture rules fixed before implementation:

- Routine `pnpm test:gpu` runs write only to Playwright's ignored per-test output. They must not rewrite the immutable P0.4/P0.4a evidence directories.
- A deliberate evidence run sets `P0_EVIDENCE_OUTPUT_DIR` to a new checkpoint-specific directory. JSON and screenshots use exclusive-create checks and fail rather than replacing an existing artifact.
- The dashboard smoke record includes the exact source revision/clean state, UTC timestamp, headed browser channel/version, adapter metadata, current dashboard snapshot, and screenshot filename. Source cleanliness is evaluated before output and ignores only the selected evidence directory, benchmark-result output, and ignored test output.
- Generate benchmark records and dashboard/GPU evidence from one clean source commit. The following evidence-only commit may add those immutable outputs and the reviewed plan disposition. Keep the measured source revision reachable: preserve commits when repository policy allows it, or create a named annotated evidence tag before squash merging when protected linear history requires squash.
- The smoke profile proves orchestration and artifact validity only. Its reduced repetitions/durations, unavailable display refresh rate, and unavailable physical-presentation timestamp keep all numeric performance gates UNVERIFIED.

P0.5.3 implementation evidence:

- Routine headed evidence now goes to Playwright's ignored per-test output; the historical P0.4/P0.4a files remain unchanged. `P0_EVIDENCE_OUTPUT_DIR` enables a deliberate unique run, and both JSON and screenshot paths refuse replacement.
- Clean source revision `59d103f655ec9b4ee5549ce252c4960bffa94f3b` produced 10 schema-valid JSON plus 10 matching Markdown smoke records for the five scenarios in headed Chrome and Edge. All records are Exploratory, have ordered monotonic windows, and report zero unexpected diagnostics and zero dropped samples.
- The headed dashboard/recovery suite passes 4/4 in 7.5 seconds and produces four clean-provenance JSON records plus four PNGs with zero page errors. Both dashboard screenshots were visually inspected for the rendered scene and all required status/control/diagnostic regions.
- The reviewed artifact index, exact commands, environment, links, observations, and limitations are recorded in [P0.5 smoke evidence](../evidence/p0.5/2026-09-06-smoke-59d103f/README.md).
- Protected `main` requires linear history and the repository permits squash merges only. Measured source `59d103f` remains reachable as annotated tag `evidence/p0.5-smoke-2026-09-06`; PR #20 then used the normal squash merge and deleted the feature branch.
- `pnpm check` passes 53 tests across 9 files plus formatting, ESLint, TypeScript, and boundaries. The smoke benchmark performs the production build; `pnpm test:gpu` passes 4/4 Chrome/Edge tests without modifying historical evidence.
- P0.5 is functionally complete at this checkpoint, but smoke results do not evaluate performance thresholds. P0.5a remains required before the full five-repetition P0.6 acceptance review.

### P0.5a Missing foundation experiments

These items restore the existing P0 roadmap scope; the foundation triangle and a single owned vertex buffer do not prove them. Implement as a separately reviewable checkpoint after P0.5 and before P0.6.

- [x] **P0-A13 camera transform:** centralize document/CSS/physical conversions with inverse mapping; define matrix order and invalid-input handling. Unit fixtures cover translation, zoom, DPR 1/1.5/2, negative positions, and inverse round trips with absolute error at most `1e-8` over the fixture domain (coordinates within +/-10,000 and zoom 0.01 to 64). A headed triangle fixture verifies known transformed screen positions within one physical pixel. This is a fixture domain, not the editor's final coordinate limit.
- [x] **P0-A14 buffer suballocation experiment:** exercise deterministic allocate/free/reuse over a shared buffer with alignment, non-overlap, exhaustion, and invalid-free assertions; retain CPU allocation descriptors and rebuild on recovery. Record capacity, requested/allocated/live/peak bytes and buffer creation count; a headed draw fixture reads distinct allocation ranges and disposal returns ownership counters to zero. Define safe reuse relative to submitted GPU work before implementing the allocator. No speedup claim is required.
- [x] **P0-A15 keyed pipeline cache:** define keys for shader/layout, target format, sample count, and relevant render state. Identical requests reuse one entry, incompatible keys do not alias, and loss invalidates the generation's entries. Unit tests plus headed resource counters show no steady-state creation and successful rebuild; a single pipeline created at startup alone is insufficient cache evidence.

Evidence: `pnpm check`, `pnpm build`, headed Chrome/Edge fixture artifacts, and counters linked individually to P0-A13/A14/A15. Record any changed benchmark configuration as a successor scenario before final measurement.

#### P0.5a unit-module batch contract (T001, 2026-09-09)

This batch implements T003/T004/T005 as internal modules and deterministic fixtures only. It does not implement T006 backend wiring, change package exports or editor-facing contracts, run headed acceptance/benchmarks, or commit. The existing A13/A14/A15 checkboxes remain open until their full evidence exists. These local experiment conventions refine the accepted numeric/cache/resource policies; they do not settle P1's final scene, coordinate-range, or public API design.

Ownership: Camera uses `packages/renderer-core/src/camera.ts` and `tests/unit/camera.test.ts`; allocator uses `packages/renderer-webgpu/src/shared-buffer-allocator.ts` and `tests/unit/shared-buffer-allocator.test.ts`; cache uses `packages/renderer-webgpu/src/pipeline-cache.ts` and `tests/unit/pipeline-cache.test.ts`. Tests import their internal source modules directly. Only the Primary edits this plan. Existing barrels, contracts, backend/platform lifecycle, playground, manifests, dependencies, and historical evidence are unchanged.

**Camera contract (T003).**

- Use JavaScript number (float64), canvas-local coordinates, x right and y down. A six-value affine tuple `[a, b, c, d, e, f]` means the column-vector matrix `[[a,c,e],[b,d,f],[0,0,1]]`; `multiplyAffine(left, right)` applies right first. `transformPoint` maps `{x,y}`; `invertAffine` computes the inverse.
- `createCameraTransform({ position: {x,y}, zoom, devicePixelRatio })` takes the document point located at the canvas CSS origin. Document to CSS is `S(zoom) * T(-position)`; document to physical is `S(DPR) * S(zoom) * T(-position)`. Local node transforms, when supplied later, act before these matrices. No camera rotation, canvas page offset, NDC mapping, clipping, pixel rounding, or CSS surface-size clamping is added in this module.
- Return immutable matrix snapshots named `documentToCss`, `cssToDocument`, `cssToPhysical`, `physicalToCss`, `documentToPhysical`, and `physicalToDocument`. CSS/physical conversions multiply/divide by DPR independently of zoom. Preserve fractional and negative coordinates. Inputs are copied; later caller mutation cannot change snapshots.
- All coordinates, matrix coefficients, and results must be finite. Zoom and DPR must be finite and strictly positive; do not silently clamp or impose the fixture domain as a product limit. Reject invalid numbers, non-finite arithmetic, singular matrices, or inverses that cannot be represented finitely with `RangeError`. Reject a malformed matrix tuple with `TypeError`. Inversion uses no arbitrary near-zero determinant cutoff; normalize arithmetic as needed to avoid unnecessary overflow/underflow, and explicitly reject unrepresentable results.
- Unit evidence: known translation/scale/composition order (including a noncommuting affine fixture), negative/fractional positions, DPR 1/1.5/2, zoom 0.01/1/64, deterministic round trips over coordinates within +/-10,000 with absolute error <= `1e-8`, matrix/inverse agreement, immutable snapshots, invalid/singular/non-finite inputs and overflow behavior. Headed one-physical-pixel validation remains T006 work.

**Shared-buffer allocator contract (T004).**

- `SharedBufferAllocator` owns CPU range metadata for one fixed-capacity backing buffer, never a GPU object. Constructor options are `capacityBytes`, `alignment`, and `generation`; capacity and generation are positive safe integers, alignment is a positive power-of-two safe integer, and capacity is an alignment multiple. Caller chooses alignment from all relevant future buffer-use requirements. Do not use truncating 32-bit bitwise arithmetic for byte offsets.
- `allocate(requestedBytes)` requires a positive safe integer, rounds occupied size up to alignment, and takes the lowest-address first fitting free range. Return a frozen instance-owned allocation descriptor with `id`, `offset`, `requestedBytes`, and `allocatedBytes`. Allocation identity is not a persistent document ID. Exhaustion/fragmentation returns `undefined` without changing state, creating a GPU buffer, growing capacity, or evicting another allocation. Invalid arithmetic throws `RangeError` atomically. Adjacent reclaimed free ranges coalesce.
- `markSubmitted(generation, serial, allocations)` records a successfully submitted use. Serials are positive safe integers strictly increasing for this allocator's current generation (gaps allowed). Validate the whole list and generation before changing anything; duplicate entries in the list are rejected. Only currently live descriptors from this allocator may be submitted. Each descriptor remembers its last-use serial. T006 must register every submitted use before freeing any referenced allocation; an encoded-but-unsubmitted command must keep allocations live until submission is registered or encoding is abandoned.
- `completeThrough(generation, serial)` records cumulative completed work, with non-negative safe serial no greater than the greatest registered submission. Current-generation completion can arrive out of order; an older/already-completed serial is an idempotent no-op. Old-generation completions are ignored, future generations rejected. Only successful queue completion is proof: T006 captures generation/serial when observing queue completion and must not advance completion on rejection or stale callbacks.
- `free(allocation)` immediately removes the allocation from live use. Never-submitted or already-completed allocations are reusable immediately; otherwise retain their occupied range as retired until completion covers last use. Retired descriptors cannot be submitted again. Foreign, forged, freed, or double-freed descriptors throw `Error` without mutation; numeric/generation errors throw `RangeError`. No offset-only free operation is supported.
- `advanceGeneration(nextGeneration)` requires a strictly larger positive safe integer and represents confirmed loss/replacement of the old backing buffer. Keep live logical allocation descriptors and offsets for CPU-driven reconstruction; release retired ranges, clear last-use serials and completion/submission watermarks, and reject submissions for old generations. Descriptors contain no GPU handles or generation-bound binding. T006 must invalidate old GPU bindings, recreate the full-capacity buffer, re-upload live content from its CPU owner, and stamp new bindings with the new generation before use. This allocator does not store vertex payloads.
- `dispose()` is idempotent and terminal, clears live/retired metadata and reusable ranges; live/reserved counters become zero. Snapshots remain readable and repeat disposal is allowed; other operations throw `Error` after disposal. Normal generation invalidation is not disposal.
- An immutable `snapshot()` records generation/disposed, capacity/alignment, live allocation count, live requested/allocated bytes, retired bytes, reserved bytes (`liveAllocatedBytes + retiredBytes`), and peak reserved bytes. Historical peak and configured capacity remain readable after disposal. T006 tracks each real backing buffer once at full capacity in existing `ResourceAccounting`, with its actual creation count and lifecycle; never track subranges as separate GPU allocations or add allocator bytes to capacity a second time. Unit tests demonstrate the arithmetic relation without claiming a GPU buffer was created.
- Unit evidence: deterministic allocate/free/coalescing/fragmentation/exhaustion; padding and non-overlap; forged/foreign/double frees; atomic invalid batches; delayed/out-of-order completion; use across multiple submissions; no premature reuse; generation loss with live and retired allocations; stale completions; terminal disposal; large safe-integer offsets and rejected overflow; immutable snapshots/descriptors. GPU draw/recovery/accounting wiring remains T006.

**Pipeline cache contract (T005).**

- `PipelineCache<T>` is an internal generation-owned async cache. It accepts a positive safe integer generation and an optional release callback for dropping owned entries. No global cache, GPU type, shader compiler, or public renderer API is introduced. Pipelines are generation-bound derived resources; the caller owns CPU recipes for reconstruction.
- A key contains non-empty strings `shaderKey`, `layoutKey`, `vertexLayoutKey`, `targetFormat`, `renderStateKey`, and `sampleCount` equal to 1 or 4. The key covers the currently planned single-color-target experiment. Recipe keys are immutable identities for complete effective state: shader modules/entry points/override constants; pipeline/bind-group layouts; vertex buffer layouts; and primitive topology/front-face/culling, depth/stencil, blend/write-mask and multisample mask/alpha-to-coverage respectively. T006 must not reuse a recipe identity after changing that state. This avoids a speculative general WebGPU-descriptor serializer while keeping compatibility explicit.
- `getOrCreate(key, factory)` snapshots/validates the key and passes the immutable key plus current generation to the factory. Canonical structural identity must be independent of object identity/property order and must not collide on string delimiters. All six fields participate. Compatible requests in one generation share one pending creation or one ready value; any field change is incompatible. No request creates a pipeline in a hot path once its compatible entry exists.
- Cache factories may resolve asynchronously, reject, or throw synchronously. Register an entry before invoking factory code so synchronous re-entry/concurrent requests cannot create duplicates. Failed creation is removed so a later explicit request can retry; never evict a newer replacement from an old completion handler. Recursive factories awaiting their own identical request are invalid caller behavior, not a supported creation strategy.
- `advanceGeneration(nextGeneration)` requires a strictly larger positive safe integer, drops all old ready/pending entries, and permits lazy recreation on the next request. A stale pending success is released and its consumer rejects instead of receiving an old-generation value; a stale failure cannot disturb a current-generation entry. No new factory is invoked for an entry invalidated before its scheduled creation starts. Pending requests settle when their underlying creation settles; invalidation does not cancel GPU promises.
- `dispose()` is idempotent and terminal, removes current entries, and prevents new requests/generation changes. Outstanding creations must never repopulate the cache after loss/disposal. The release callback is invoked once per successfully created entry when ownership ends, including stale successful results; there is no invented GPU pipeline destroy call. Its internal lifecycle callback must not throw. Resource counters in this batch describe cache entries/creations only, not physical GPU memory; T006 owns actual `ResourceAccounting` registration/release.
- Validate malformed/empty keys with `TypeError`, invalid generation/sample-count numbers with `RangeError`; lifecycle/stale results reject with `Error`. An immutable `snapshot()` reports generation, disposed, pending/ready entry counts, and actual successful creation count (including stale creations, since work occurred).
- Unit evidence: every key dimension, structural equality/delimiter safety, key mutation isolation, concurrent pending deduplication and factory re-entry, synchronous/asynchronous failures and retry, loss/disposal before factory start and during creation, old completion vs same-key recreation, once-only release, invalid inputs, terminal disposal, and immutable snapshots. Native pipeline creation/recovery counters remain T006.

Batch validation: run the three named unit files, then the existing root deterministic checks as needed for compilation/lint/boundary regression. No browser, headed GPU, benchmark, or P0 gate claim is allowed. Record exact commands and results here after Primary review; full A13/A14/A15 remain unverified until T006 evidence.

Batch outcome (2026-09-09): **T001/T003/T004/T005 UNIT BATCH COMPLETE LOCALLY; UNCOMMITTED** on `codex/p0-5a-unit-foundation`, based on clean `ebeb50d` equal to fetched `origin/main`. No architecture-level blocker was found: all modules fit existing ownership and remain outside package barrel exports. Primary reviewed all three implementations and their deterministic fixtures; this outcome does not complete P0.5a hardware acceptance or evaluate the P0 gate.

| Task | Local completion evidence                                                                                                                                                          | Remaining full-criterion evidence                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| T001 | The contract above was fixed by Primary before worker implementation; no public contract or dependency change                                                                      | T006 must preserve these ownership/lifetime rules                       |
| T003 | [Camera fixtures](../../tests/unit/camera.test.ts): 17 tests covering all six conversions, DPR/zoom combinations, inverse/composition, input rejection and extreme exponent ranges | A13 headed transformed-triangle fixture                                 |
| T004 | [Allocator fixtures](../../tests/unit/shared-buffer-allocator.test.ts): 15 tests covering range/identity/accounting invariants, serial retirement, generation changes and disposal | A14 real shared-buffer draw, reconstruction and GPU resource accounting |
| T005 | [Cache fixtures](../../tests/unit/pipeline-cache.test.ts): 8 tests covering key dimensions, pending/ready reuse, failures/retry, stale completion, release re-entry and disposal   | A15 native pipeline reuse/recreation and headed counters                |

Validation environment: Windows/PowerShell, Node `v24.15.0`, pnpm `11.1.2`; source is the uncommitted worktree above, not an accepted benchmark revision.

- `pnpm test:unit tests/unit/camera.test.ts` - PASS: 1 file, 17 tests after numeric review.
- `pnpm test:unit tests/unit/shared-buffer-allocator.test.ts` - PASS: 1 file, 15 tests.
- `pnpm test:unit tests/unit/pipeline-cache.test.ts` - PASS: 1 file, 8 tests.
- `pnpm check` - final PASS: formatting, ESLint, TypeScript project compilation, 12 unit/contract files with 93 tests, and all four existing package boundaries. The first full attempt stopped at TypeScript because the cache's optional private callback field conflicted with `exactOptionalPropertyTypes`; changing the field to an explicit union with `undefined` fixed it before the successful rerun.
- `pnpm exec prettier --check --ignore-path .gitignore docs/plans/p0-webgpu-foundation.md` - PASS; `.gitignore` includes no Markdown exclusion, unlike `.prettierignore`.
- Local link/anchor checker from [the documentation review](../evidence/docs-review-2026-09-05.md#reproduce-the-local-markdown-link-check) and `git diff --check` - PASS.
- `pnpm build`, browser tests, headed GPU tests, benchmarks, remote CI, commit/push/PR - NOT RUN in this user-limited unit batch. `pnpm check` includes TypeScript compilation but no production playground build. A13/A14/A15 remain open as written above.

Primary review corrections: replaced lossy row/column inverse normalization with binary-exponent determinant products and explicit unrepresentable-result rejection; removed an unnecessary cache observer/constructor alternative; detached invalidated entries before release callbacks so re-entry cannot delete fresh-generation entries; covered undefined generic values and once-only release; corrected the optional callback field type; aligned allocator encapsulation with existing runtime-private fields and added retirement/accounting fixtures. No per-fixture special cases, external numeric dependency, generic observer framework, public export, or backend integration was added. Float64 arithmetic is retained; the extreme fixtures do not establish arbitrary-precision arithmetic or P1 coordinate-range guarantees.

T006 handoff: consume camera matrices inside the renderer ownership boundary and map physical positions to the concrete surface there; select alignment from actual buffer uses, create/account one full-capacity buffer, and retain CPU payloads with their live allocation descriptors; register every successful submission before freeing referenced ranges and feed only generation-matched successful completion into `completeThrough`; after device loss invalidate old bindings, advance allocator/cache generation, recreate/re-upload the live ranges, and lazily request pipelines using immutable complete recipe identities. The cache release callback must be nonthrowing and must update ownership accounting without inventing a GPU pipeline destroy operation. Package-facing exposure or contract changes are not authorized by this internal batch and require review before any later change. Headed fixtures, real counters, and benchmark scenario impact belong to T006 and later work.

#### T006 backend integration sequence (2026-09-09)

The next executable work follows the completed local T001/T003/T004/T005 dependency chain. Split T006 into T006a (internal runtime and recovery wiring) followed by T006b (playground instrumentation and headed A13/A14/A15 artifacts). This is an execution split, not a change to any acceptance criterion. Keep the existing P0.5a branch and preserve the reviewed unit-module changes. The Primary owns this plan and integration review; one implementation worker owns all shared backend/platform lifecycle changes.

T006a contract and local acceptance, fixed before implementation:

- Consume camera through the private `renderer-core` package root using an additive utility export along the accepted dependency direction. Keep `packages/contracts`, editor-facing lifecycle/statistics semantics, dependencies, and the future P1 scene port unchanged.
- Keep CPU foundation payloads and live allocation descriptors in a backend-owned experiment lifetime that survives device-generation scene release. A recovered scene binds a new full-capacity GPU buffer and reuploads the retained data; it must not reconstruct logical allocations from old GPU handles. Full backend disposal terminates the experiment. Failed/stale initialization must release partial native resources and cannot populate a later attempt's cache or revive a disposed owner.
- Use one fixed-capacity 256-byte GPU vertex buffer, 4-byte allocation alignment, and separate 24-byte position / 36-byte color allocations. Bind both real subranges in the existing triangle draw. Account the backing buffer once at its full capacity; do not count allocation bytes as additional GPU memory. No growth, eviction, or per-node buffer design is introduced.
- Preserve the normal foundation triangle's normalized positions, colors, clear value, draw count, and resize behavior. Derive its document positions for the current surface with a nontrivial experiment camera (position `{-20,-10}`, zoom `1.5`), use the central document-to-physical transform with the surface DPR, then convert physical positions to WebGPU NDC locally. This surface-adaptive reference scene is not a durable document. The subsequent headed fixture must use independently fixed document coordinates and expected screen positions so the reference-scene round trip is not its own oracle.
- Use the keyed cache for complete immutable native pipeline recipes, including split vertex layouts, target format, 1x/4x MSAA, and effective render state. Two compatible initialization requests must share one pending creation; steady rendering creates none. Preserve the existing explicit 4x-to-1x fallback. Release old native bindings before generation advance; invalidate cache entries and rebuild for the replacement device. Do not invent a pipeline destroy operation.
- Preflight a valid next serial before native submission and register each successful submission's allocations before they can be freed. Observe queue completion with captured generation and serial, reclaim only on successful matching completion, and ignore stale/rejected callbacks. Keep at most one outstanding completion observer per scene, cumulatively observing newer submissions after successful completion; rejection does not trigger a retry loop. Encoding/submission failure cannot advance the watermark. Scene release also detaches callbacks so a failed/disposed binding cannot mutate a live replacement in the same logical generation.
- Retain internal immutable snapshots sufficient for T006b to observe physical vertices, allocation descriptors/accounting, backing-buffer creations/live ownership, submission/completion watermarks, and cache reuse/recreation. Do not add instrumentation to `RendererStatistics` or document data. Playground exposure and new headed fixtures belong to T006b.
- Deterministic integration fixtures must inspect native-device doubles: actual buffer sizes/uploads/binding offsets, known transformed coordinates and resize/DPR handling, pending cache deduplication and fallback, steady-state creation counts, successful/rejected/stale queue completion, descriptor preservation and resource replacement after loss, partial initialization failures, delayed creation versus disposal, and terminal cleanup. Retain existing backend state-machine and diagnostic assertions; test doubles do not prove hardware output.
- Local completion requires `pnpm check`, `pnpm build`, `pnpm test:browser`, changed-Markdown formatting/link checks, and Primary diff/lifecycle review. Browser regression remains headless and is not A13/A14/A15 hardware evidence. Do not run benchmarks or judge the P0 gate in T006a. T006b must specify its fixed numeric fixture and evidence capture before implementation, then produce headed Chrome/Edge evidence; A13/A14/A15 remain open until reviewed.

T006a outcome (2026-09-09): **COMPLETE LOCALLY; UNCOMMITTED**. The reviewed unit modules now drive the native foundation scene. Source is `ebeb50dd897d38f72f3d68a92094ba2d5ebd99de` plus the scoped worktree delta on `codex/p0-5a-unit-foundation`; fetched `origin/main` is equal to the base. Environment: Windows, Node `v24.15.0`, pnpm `11.1.2`. The broader P0.5a checkpoint remains open for T006b, so no commit, push, or PR is made in this sub-batch.

Implementation and review evidence:

- The [CPU experiment owner](../../packages/renderer-webgpu/src/foundation-experiment.ts) retains the exact live allocation descriptors across recovery and owns the generation-aware cache. The [native scene](../../packages/renderer-webgpu/src/native-foundation-scene.ts) uploads and binds the two ranges in one 256-byte buffer. The [backend](../../packages/renderer-webgpu/src/webgpu-backend.ts) manages attempt cleanup and exposes an immutable concrete experiment snapshot for T006b. Editor-facing contracts, dependency manifests, and benchmark scenario definitions are unchanged.
- [Native integration fixtures](../../tests/unit/native-foundation-integration.test.ts) pass 12 tests covering buffer capacity and binding offsets, independent numeric expectations, compatible pipeline requests/fallback, bounded queue-completion observation, failed submission/preflight ordering, exact descriptor identity across generations, same-generation retry isolation, partial initialization failures, and full disposal during pending creation.
- [Backend fixtures](../../tests/unit/webgpu-backend.test.ts) pass 23 tests in the final root run. Added cases prove that late abandoned initialization cannot unconfigure a replacement backend's canvas, MSAA-fallback diagnostics cannot revive disposal, and a release-failure diagnostic cannot resume recovery after synchronous disposal. Existing recovery also asserts allocator/cache generation advance and exact descriptor preservation.
- Primary corrected the initial reference-vertex transposition, removed redundant per-frame payload copying and counter clamping, rejected a global snapshot registry, and reviewed submission ordering, cumulative completion, generation ownership, attempt cleanup, and diagnostic reentry. An independent Sol `medium` review identified serial preflight and bounded completion observation; those fixes were adopted after Primary review. Sol `high` owned runtime/backend changes; Sol `medium` then owned only the new native fixture file; Luna `low` ran final root verification. No worker delegated further.
- A disposed backend reports zero live allocation/buffer/pipeline ownership. An already-started native promise is not cancellable: `pendingNativeCreations` remains observable until settlement, and late success is released without repopulating the disposed cache. Historical creation totals remain readable.

| Validation command                                                      | Result                                                                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                            | PASS after one test-matcher lint correction: formatting, ESLint, TypeScript, 13 unit files / 108 tests, and dependency boundaries |
| `pnpm build`                                                            | PASS: contracts, renderer-core, renderer-webgpu, and playground production output                                                 |
| `pnpm test:browser`                                                     | PASS: 10 Chrome/Edge tests in 10.8 seconds, headless                                                                              |
| `pnpm exec vitest run tests/unit/native-foundation-integration.test.ts` | PASS: 12 tests; final root run also passes the same file                                                                          |

Documentation validation: `pnpm exec prettier --check --ignore-path .gitignore docs/plans/p0-webgpu-foundation.md` passes; the existing link-check script from `docs/evidence/docs-review-2026-09-05.md`, executed with `node --input-type=module`, passes 42 local links/anchors across 29 Markdown files; `git diff --check` passes. Scope review confirms no dependency-manifest, `packages/contracts`, historical-evidence, or unrelated user-file changes.

The first root check stopped at `@typescript-eslint/no-unsafe-assignment` in the new backend diagnostic assertion. Primary replaced the nested asymmetric matcher with a separate `toContain` assertion, preserving its meaning; the complete rerun above passed. Primary visually inspected both ignored browser `foundation.png` artifacts: the expected colored triangle is visible with the same normalized positions. These reproducible browser regression artifacts are not headed one-pixel acceptance evidence. No headed GPU test, benchmark, historical result rewrite, or P0 gate judgment occurred.

T006b is now executable: fix the independent document-coordinate headed fixture in the plan before code, expose the concrete experiment snapshot through the playground test surface, and collect/review A13/A14/A15 artifacts in headed Chrome and Edge. Its source/evidence checkpoint must follow the existing Git and immutable-evidence workflow. A13/A14/A15 remain unchecked; physical-presentation and native-OOM evidence gaps still belong to the later P0 gate review.

#### T006b headed foundation evidence contract (2026-09-09)

Status: **COMPLETE WITH CLEAN-SOURCE EVIDENCE; PR INTEGRATION PENDING** after locally reviewed T006a. This batch completes only the remaining P0.5a A13/A14/A15 evidence and its checkpoint workflow. It does not run P0 performance benchmarks, resolve physical-presentation/native-OOM measurement gaps, or authorize P1.

Contracts fixed before implementation:

- Add the concrete backend experiment option `foundationFixture: 'camera-triangle-v1'` and select it only through playground `?fixture=camera-triangle-v1`. Omission keeps the existing surface-adaptive reference triangle and benchmark scenario inputs unchanged. This is private-workspace P0 adapter instrumentation, not an editor viewport API or P1 scene port. No dependency or `packages/contracts` change is required.
- The fixture owns immutable float64 document vertices `[0,0,100,0,0,60]`, retains the existing position `{-20,-10}`, zoom `1.5`, per-vertex colors, clear color, shared-buffer layout, and 4x/1x sampling behavior. Compute physical positions through the central camera, then physical-to-NDC locally. Recovery retains the fixed CPU payload and allocation descriptors. Normal resize changes projection, not fixture document coordinates.
- Use a 640x360 CSS canvas with no border, radius, or CSS transform in fixture mode. Headed Playwright contexts and backend surfaces both use DPR 1, 1.5, and 2. Expected physical vertices are respectively `[30,15,180,15,30,105]`, `[45,22.5,270,22.5,45,157.5]`, and `[60,30,360,30,60,210]`. Assert canvas backing size and screenshot size equal CSS size times DPR. Record emulated browser DPR explicitly; these are framebuffer/screenshot physical pixels, not display-presentation timestamps.
- The headed oracle reads the captured PNG independently of runtime camera matrices and uploaded-position snapshots. Decode that PNG with browser image APIs into a separate 2D canvas used only for test image analysis. A foreground pixel has `max(R,G,B) > 80` against the fixed dark clear color. The right triangle's observed vertices are derived from the foreground bounds `(minX,minY)`, `(maxX+1,minY)`, `(minX,maxY+1)`; each coordinate must differ from the literal expected vertex by at most one physical pixel. Also assert representative interior pixels are foreground and exterior pixels are background, preventing blank/default-scene output from satisfying the bounds check. Preserve measured bounds, image dimensions, sample classifications, and screenshot filenames in JSON. This defines a P0 fixture observation method, not a new global P1 pixel-difference threshold.
- Expose `getFoundationExperimentSnapshot()` on the existing playground test API. Add an actual cumulative `pipelineRequests` counter to the experiment snapshot so two compatible requests and one successful native creation are observable. Assert requested/live/allocated/peak bytes 60, capacity 256, two nonoverlapping ranges at offsets 0 and 24, one live backing buffer, and existing resource accounting charging 256 buffer bytes exactly once. No allocator-byte double counting is allowed.
- For each headed fixture, capture initialization, a steady interval with at least five additional submitted frames, recovery after deliberate device destruction, and disposal. Steady frames must not change buffer/pipeline creation or pipeline request counts. Recovery must advance generation once, preserve allocation IDs/offsets and fixed document vertices, create one replacement backing buffer and successful pipeline, and render the same independently measured positions. Identical initialization requests must exceed successful creations; incompatible-key separation remains covered by the existing T005/native unit fixtures. Reject unexpected diagnostics/page errors; the deliberate loss/recovery events and explicit MSAA fallback are the only expected fixture events.
- Disposal must leave renderer resource counts/bytes and experiment live allocations, reserved bytes, backing buffers, pipelines, and ready/pending cache entries at zero. Observe generation/serial completion directly; submission or queue completion does not establish physical display presentation. Already-started native work may settle after disposal as specified in T001/T006a.
- One Terra `medium` worker owns fixture/runtime/playground wiring plus its unit fixture. One Sol `medium` worker owns the new headed test and screenshot-analysis helper in separate files, using this fixed contract. Primary owns plan, review, source/evidence provenance, and acceptance disposition. Luna `low` may execute static/build/browser/GPU commands sequentially. No worker delegates further.

Validation and evidence sequence: run `pnpm check`, `pnpm build`, `pnpm test:browser`, then the headed `pnpm test:gpu` suite in ignored output to verify fixture functionality. Primary inspects numeric results, both browsers' screenshots, and the final diff. Record local results and commit the scoped P0.5a source on the existing feature branch. From that clean source, rerun `pnpm test:gpu` with `P0_EVIDENCE_OUTPUT_DIR` set to a fresh timestamped directory under `docs/evidence/p0.5a/`; writers must refuse overwrites. Records include source revision/clean state, fixture ID, command, UTC time, OS, browser channel/version, adapter/limits/features, DPR/surface size, sampling mode, stage snapshots, diagnostics, image metrics, and filenames. Primary reviews and indexes those immutable artifacts, records A13/A14/A15 individually, then makes an evidence/plan commit and follows the repository PR workflow. Preserve the measured source with an evidence tag if squash integration would otherwise make it unreachable. If hardware evidence fails or is unavailable, preserve observations and keep the affected criterion unverified; do not weaken the oracle.

T006b local review before the source checkpoint:

- Terra `medium` implemented the fixture option, fixed document payload, pipeline request counter, playground instrumentation, and a native unit fixture. Sol `medium` implemented the independent PNG oracle and six headed cases. Neither worker delegated further. Primary reviewed both scopes and ran the final root validation directly; a Luna validation worker could not be created because the session's agent-thread limit was reached.
- `pnpm check` - final PASS after the following test/layout corrections: 13 unit/contract files, 109 tests, formatting, lint, TypeScript, and package boundaries. `pnpm build` - final PASS. `pnpm test:browser` - PASS: 10 Chrome/Edge tests (11.4 s). Explicit active-plan Prettier formatting, `git diff --check`, and the local-link checker also pass (42 links/anchors across 29 Markdown files).
- The first headed attempt timed out because a completion wait compared against an earlier submission serial while the scheduler retained its final queued RAF after switching to on-demand. The corrected wait requires no pending RAF, completion at least through the captured serial, and completion equal to the current submitted serial. The next attempt exposed fractional locator clipping after dashboard scrollbar growth. Fixture-only layout now anchors the canvas at CSS `(44,84)` using start alignment, no stage border, 24 px padding and a 24 px heading line height; these origins map to integers at all three tested DPRs. Default scene/layout and the exact image-size/one-pixel acceptance oracle are unchanged. Failed traces/screenshots were retained locally under ignored `playwright-report/t006b-*-failure-20260909/`.
- `pnpm test:gpu` - final routine PASS: 10 headed Chrome/Edge tests (16.6 s). All six fixture cases rendered initial/recovered positions with maximum coordinate error 0 px at DPR 1/2 and 0.5 px at DPR 1.5. Initial and recovered creation counts were 1 and 2 respectively for both buffer and pipeline, steady creation/request counts did not increase, and disposed ownership returned to zero. Primary inspected numeric records and representative recovered PNGs in both browsers. Routine artifacts are dirty-source local checks, not the pending immutable clean-source evidence.
- Evidence JSON is formatted with the already pinned development formatter before exclusive creation; existing GPU writers now await it. This avoids rewriting observation files after capture. No dependency, editor-facing contract, or benchmark scenario changed. A13/A14/A15 remain unchecked until the clean-source run is reviewed below.

T006b clean-source outcome (2026-09-09): **COMPLETE**. Source checkpoint `11314b52ddb23f6d43c69d5cce20870caa9fb211` passed the clean-source `pnpm test:gpu` capture (10/10, 17.1 s). All ten JSON records report that revision and a clean source worktree. [Evidence index](../evidence/p0.5a/2026-09-09T061400Z/README.md) links six DPR/browser fixture records, twelve fixture PNGs and the existing recovery/dashboard artifacts. Every initial/recovered fixture PNG pair is byte-identical; maximum coordinate error is 0.5 physical pixel. All six cases show steady reuse, generation reconstruction and zero ownership after disposal. Primary reviewed numeric/image evidence and marks **P0-A13 PASS, P0-A14 PASS and P0-A15 PASS** for this source. The measured source is preserved by `evidence/p0.5a-20260909-061400`; evidence indexing/plan changes are a separate commit. Remote CI and PR review remain integration gates.

### P0.6 Final validation and gate review

P0.5a was integrated through [PR #22](https://github.com/npclown/vector-studio/pull/22) as `1c64eab878dd004891971da86f359814e44daebc`. The [2026-09-09 readiness review](../evidence/p0-6-readiness-2026-09-09.md) verifies squash/source equivalence, audits the five-scenario runner, and records the remaining presentation/native-OOM decisions and reference-environment preparation. Existing A13-A15 evidence retains its measured revision; no new benchmark or final gate result is inferred from the merge. Next, investigate feasible presentation/native-OOM observation procedures under the existing criteria. Read-only investigation needs no new approval; escalate only if a criterion, dependency, architecture or operational-risk change is necessary. That investigation led to the explicitly approved prospective revision below. Numeric ceilings remain unchanged; the named startup/recovery endpoints change only in v2.

The [measurement-feasibility investigation](../evidence/p0-6-measurement-feasibility-2026-09-09.md) is complete. Standard browser APIs and generic presentation feedback do not establish the required physical-display endpoint; no guaranteed bounded native-hardware-OOM method was identified for the stock-browser public API. A read-only machine audit also found two active monitors, so controller-reported 60 Hz is not sufficient to identify the benchmark display. The report contains a bounded external-instrumentation proposal and an explicitly unapproved alternative for revising P0 verification to observable SDK boundaries. The investigation itself authorized neither path. The user subsequently selected the observable-boundary revision recorded below; external tooling remains outside scope.

### Approved observable-boundary contract (2026-09-09)

The user explicitly approved the preceding feasibility report's proposed revision on 2026-09-09. This prospective contract supersedes the pending-decision statements above; historical reports and v1 observations remain unchanged. External instrumentation and hardware-exhaustion experiments are not included.

- Startup advances to `p0/startup/v2`. Navigation-to-backend-ready retains the 1,000 ms p95 ceiling; initialize-call-to-ready is reported separately. Initialization start to completion of the first submitted GPU work replaces physical first-present timing, with the unchanged 1,200 ms p95 ceiling. Headed visual output is verified separately.
- Lifecycle advances to `p0/lifecycle-recovery/v2`. Both recovery-ready and rebuilt-work queue completion must occur within 3,000 ms of current-generation loss detection in every repetition. The 25 cycles, zero disposed ownership/listeners, one recovery attempt and no stale submissions remain required. Headed visual reconstruction is separate evidence.
- P0-A07 requires injected OOM diagnostic mapping plus native headed validation-error and device-loss delivery. Actual native hardware OOM remains **UNVERIFIED**, explicitly outside the revised P0 exit gate. OOM product behavior is unchanged.
- Queue completion is not physical presentation. Physical-display timing remains unavailable/residual; neither screenshots nor submission counters establish its timing. This is an approved reduction of required hardware evidence, not equivalent proof of the original gate.
- Other scenario versions, configurations, durations, five repetitions per browser, numeric ceilings and architecture are unchanged. Every revised criterion and all five scenarios in both browsers must pass before P0 closes. Acceptance-sensitive environment fields must be established before an acceptance run.

Implementation checkpoint: update runner scenario identity and endpoint metadata, preserve collision-safe immutable output, and validate static/unit/build plus headed smoke execution. Primary review found that the previous startup/lifecycle runner declared 1280 x 720 but initialized the playground default 640 x 360. The v2 scenarios must select the internal reference-surface fixture before initialization and assert 1280 x 720 at DPR 1 through reinitialization/recovery. This restores the declared reference surface; v1 observations are not retroactively relabeled. Browser fixture checks and actual surface fields in the new records must prove the correction.

The [implementation review](../evidence/p0-6-observable-boundary-2026-09-09.md) records local static/unit/build, 12 browser cases, 10 headed GPU cases and the final two-browser smoke run. This checkpoint alone does not close P0.6. The user reports YouTube and other GPU work closed. Read-only Windows preflight resolves both active displays to 1920 x 1080 at 60 Hz using per-device `EnumDisplaySettings`, power line status to AC, and the active power scheme to Balanced. CDP window bounds place both smoke browser windows wholly within the primary monitor; emulated Screen values are labeled separately. Final source capture and threshold review remain required.

The first complete matrix on clean source `62ed77af33915fdbce79a95c4a7680f0b62c6254` completed both browsers, but review found omitted deterministic inputs in the configuration hash. Preserve those observations under `docs/benchmarks/results/p0-6-20260909-1319/` as metadata-UNVERIFIED. Before a replacement run, include the existing default triangle identity/counts, actual selected sample count and target format, explicit reference CSS/physical/DPR fields, resize formula constants/DPR sequence and measurement modes/windows in the stored configuration. This repairs existing reproducibility acceptance, with no algorithm, sample-window, threshold or scenario-version change. Validate exported values against actual source/snapshots and rerun from a new clean source; never patch the first observations.

- [x] Run the complete static/unit/contract/browser validation surface.
- [x] Run headed Chrome and Edge GPU validation on the reference machine.
- [x] Execute five repetitions of every P0 benchmark scenario.
- [x] Commit raw JSON and Markdown summaries.
- [x] Evaluate every acceptance criterion below as PASS, FAIL, or UNVERIFIED.
- [x] Record residual risks and decide whether P1 may begin.

Evidence: completed acceptance matrix and linked result files.

## Acceptance criteria

| ID     | Criterion                                                                                                                                                                 | Required validation                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| P0-A01 | Insecure context, missing WebGPU API, missing adapter, missing canvas context, and device-request failure produce distinct stable diagnostic codes.                       | Unit + browser                       |
| P0-A02 | Initialization is concurrency-safe and idempotent; disposal is idempotent and terminal; stale async completion cannot revive disposed state.                              | Unit + contract                      |
| P0-A03 | Surface sizing applies DPR, clamps to adapter limits, handles zero area without presenting, and recreates only size-dependent resources.                                  | Unit + browser + resource counters   |
| P0-A04 | The foundation scene presents the expected clear color and triangle in stable Chrome and Edge.                                                                            | Headed browser + visual artifact     |
| P0-A05 | Multiple invalidations before the next animation frame produce at most one submission; an unchanged idle backend submits none.                                            | Unit + benchmark                     |
| P0-A06 | Shader module and pipeline creation counts remain constant throughout steady-state measured frames.                                                                       | Resource counters + benchmark        |
| P0-A07 | Validation/OOM errors and device loss produce structured diagnostics with generation and context: injected OOM mapping, native validation-error and device-loss delivery. | Contract + headed hardware           |
| P0-A08 | Deliberate device destruction invalidates old resources, performs one controlled recovery, rebuilds the foundation scene, and presents again.                             | Headed Chrome + Edge                 |
| P0-A09 | After each dispose, engine-owned live-resource counters return to zero; 25 lifecycle cycles show no accumulating tracked resources or listeners.                          | Contract + benchmark                 |
| P0-A10 | Benchmark output includes all metadata required by `docs/benchmarks/README.md` and can reproduce the scenario from ID, version, seed, and configuration.                  | Schema/contract test                 |
| P0-A11 | The production build passes the full planned root validation commands and contains no runtime renderer/scene/tessellation dependency.                                     | Static + dependency audit            |
| P0-A12 | Renderer contracts and editor-facing code contain no exported WebGPU types; only the concrete backend imports WebGPU bindings.                                            | Type/API boundary test               |
| P0-A13 | Camera conversions and rendered transforms satisfy P0.5a fixtures.                                                                                                        | Unit + headed visual/numeric fixture |
| P0-A14 | Shared-buffer suballocation satisfies alignment, lifetime, recovery, and accounting invariants in P0.5a.                                                                  | Unit + headed GPU counters/fixture   |
| P0-A15 | Pipeline cache keys preserve compatibility, reuse, and generation invalidation as defined in P0.5a.                                                                       | Unit + headed GPU counters           |

P0 passes only when all P0-A criteria are PASS. A criterion cannot be waived by a good benchmark number.

Final local review on source `b524927f841347051ca2b4f95f8c4c83f5b4c14e`: **P0-A01 through P0-A15 PASS**, and all five scenarios in both browsers PASS. The [final acceptance matrix and artifact index](../evidence/p0.6/20260909-final/README.md) links each criterion to current-source evidence, numeric outcomes and the environment review. The first full matrix remains excluded for metadata omissions. Native hardware OOM and physical-presentation timing remain UNVERIFIED residuals outside the explicitly revised P0 exit gate. Required remote CI and protected PR integration remain repository gates; P1 implementation still requires its own execution plan.

## P0 benchmark scenarios and thresholds

All runs follow `docs/benchmarks/README.md`, use the reference 1280 x 720 physical surface at DPR 1, run a production build, warm for 3 seconds where applicable, and contain at least five measured repetitions.

### `p0/startup/v2`

Repeated fresh page loads through backend ready and completion of first submitted GPU work. This prospectively supersedes v1 physical first-present timing; v1 observations retain their original meaning.

- Navigation-to-backend-ready wall time p95: at most 1,000 ms
- Initialization-start-to-first-work GPU queue completion p95: at most 1,200 ms
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

### `p0/lifecycle-recovery/v2`

Run 25 initialize/render/dispose cycles, followed by one deliberate device-loss and recovery cycle.

- Live engine-owned resource count after each dispose: zero
- Retained diagnostic listeners after each dispose: zero
- Recovery-ready and rebuilt-work GPU queue completion each occur within 3,000 ms of current-generation loss detection in every repetition; headed visual reconstruction is verified separately
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

| Date       | Update                                                                                                                                              | Evidence / decision                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-27 | Documentation gate established; no implementation started.                                                                                          | `AGENTS.md`, `ARCHITECTURE.md`, this plan, validation and benchmark policies                                                                                            |
| 2026-08-27 | Git/GitHub workflow audited. Repository has no commits, remote, upstream, or available `gh` CLI; P0 is gated on bootstrap.                          | Local Git and CLI status checks; `AGENTS.md` workflow                                                                                                                   |
| 2026-08-27 | Public `origin` registered, unborn branch renamed to `main`, and GitHub CLI authenticated as `npclown`.                                             | `gh auth status`, `gh repo view`, `git remote -v`, `git status --branch`                                                                                                |
| 2026-08-27 | Documentation-only baseline `21afc22` pushed to `origin/main`; squash-only merge and protected `main` configured.                                   | GitHub repository and branch-protection API verification                                                                                                                |
| 2026-08-27 | Feature branch workflow completed through validation, commit, push, PR #1, protected squash merge, and branch cleanup.                              | `https://github.com/npclown/vector-studio/pull/1`                                                                                                                       |
| 2026-08-27 | P0.0 repository foundation completed locally and submitted through PR #4.                                                                           | `pnpm check`, `pnpm build`, `pnpm peers check`, production dependency graph, and explicit future-gate command results                                                   |
| 2026-08-27 | P0.0 pull-request validation passed on GitHub's Windows runner.                                                                                     | PR #4 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33072953884/job/98519653495`                              |
| 2026-08-27 | The P0.0 validation job became a strict required status check on protected `main`.                                                                  | GitHub branch-protection API: `Static, unit, boundaries, and build`, strict mode enabled                                                                                |
| 2026-08-27 | P0.0 integrated into protected `main` through a squash merge.                                                                                       | PR #4: `https://github.com/npclown/vector-studio/pull/4`; merge commit `a3c1219`                                                                                        |
| 2026-08-27 | P0.1 contracts, diagnostics, subscriptions, and resource accounting completed locally and submitted through PR #6.                                  | `pnpm check`: 21 tests across 5 files; `pnpm build`; public-contract architecture-boundary test                                                                         |
| 2026-08-27 | P0.1 pull-request validation passed on GitHub's Windows runner.                                                                                     | PR #6 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33074926266/job/98526521203`                              |
| 2026-08-27 | P0.1 integrated into protected `main` through a squash merge.                                                                                       | PR #6: `https://github.com/npclown/vector-studio/pull/6`; merge commit `607a5f6`                                                                                        |
| 2026-08-27 | P0.2 WebGPU initialization and surface handling completed locally and submitted through PR #8.                                                      | `pnpm check`: 33 tests across 7 files; `pnpm test:browser`: Chrome and Edge 2/2; `pnpm build`; production dependency audit                                              |
| 2026-08-27 | P0.2 pull-request validation passed on GitHub's Windows runner.                                                                                     | PR #8 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33076963055/job/98533565510`                              |
| 2026-08-27 | P0.2 integrated into protected `main` through a squash merge.                                                                                       | PR #8: `https://github.com/npclown/vector-studio/pull/8`; merge commit `3de7801`                                                                                        |
| 2026-08-27 | P0.3 render scheduling, foundation scene, headed visual evidence, and fixed-scenario benchmark implementation completed locally.                    | `pnpm check`: 39 tests across 8 files; `pnpm build`; headed Chrome/Edge 6/6; production P0.3 benchmark 2/2 with five repetitions per scenario/browser                   |
| 2026-08-27 | P0.3 pull-request validation passed on GitHub's Windows runner.                                                                                     | PR #10 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33081358041/job/98549136759`                             |
| 2026-08-27 | P0.3 integrated into protected `main` through a squash merge.                                                                                       | PR #10: `https://github.com/npclown/vector-studio/pull/10`; merge commit `b9285b9`                                                                                      |
| 2026-09-04 | P0.4 resource lifecycle, structured GPU errors, generation-safe device-loss recovery, and headed hardware evidence completed locally.               | `pnpm check`: 45 tests across 8 files; `pnpm build`; browser 6/6; headed GPU Chrome/Edge 2/2; `docs/evidence/p0.4/`                                                     |
| 2026-09-04 | P0.4 pull-request validation passed on GitHub's Windows runner.                                                                                     | PR #12 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33839256994/job/100918002724`                            |
| 2026-09-04 | P0.4 integrated into protected `main` through a squash merge.                                                                                       | PR #12: `https://github.com/npclown/vector-studio/pull/12`; merge commit `a15adcb`                                                                                      |
| 2026-09-06 | P0.4a corrected terminal recovery, diagnostic re-entry, inactive continuous scheduling, and stale-generation proof before P0.5.                     | `pnpm check`: 48 tests; `pnpm build`; browser 6/6; headed GPU 2/2; `docs/evidence/p0.4a/`                                                                               |
| 2026-09-06 | P0.4a pull-request validation passed on GitHub's Windows runner.                                                                                    | PR #15 final `Static, unit, boundaries, and build` job: `https://github.com/npclown/vector-studio/actions/runs/33975533285/job/101331443610`                            |
| 2026-09-06 | P0.4a integrated into protected `main` through a squash merge.                                                                                      | PR #15: `https://github.com/npclown/vector-studio/pull/15`; merge commit `07a8a7f`                                                                                      |
| 2026-09-06 | P0.5.0 measurement clocks/events, bounded collection, result validation, hashing, Markdown generation, and collision-safe writes completed locally. | `pnpm check`: 53 tests across 9 files; `pnpm build`; browser 6/6                                                                                                        |
| 2026-09-06 | P0.5.0 pull-request validation passed and the checkpoint integrated into protected `main`.                                                          | PR #17: `https://github.com/npclown/vector-studio/pull/17`; merge commit `50b8254`; required validation job `101337535972`                                              |
| 2026-09-06 | P0.5.1 playground dashboard, complete control surface, current-generation capability display, and serialized backend replacement completed locally. | `pnpm check`: 53 tests; `pnpm build`; Chrome/Edge browser controls 10/10                                                                                                |
| 2026-09-06 | P0.5.1 pull-request validation passed and the checkpoint integrated into protected `main`.                                                          | PR #18: `https://github.com/npclown/vector-studio/pull/18`; merge commit `e873efa`; required validation job `101340186331`                                              |
| 2026-09-06 | P0.5.2 five-scenario production runner, event-separated timing, queue completion, full record provenance, and safe output completed locally.        | `pnpm check`: 53 tests; browser 10/10; headed smoke 2/2 producing 10 JSON + 10 Markdown records                                                                         |
| 2026-09-06 | P0.5.2 pull-request validation passed and the checkpoint integrated into protected `main`.                                                          | PR #19: `https://github.com/npclown/vector-studio/pull/19`; merge commit `b5ad020`; required validation job `101345581612`                                              |
| 2026-09-06 | P0.5.3 immutable evidence capture and clean-revision smoke records completed locally.                                                               | Source `59d103f`; benchmark 2/2 with 10 JSON + 10 Markdown; headed GPU/dashboard 4/4 with 4 JSON + 4 PNG; reviewed evidence index                                       |
| 2026-09-06 | P0.5.3 required validation passed and P0.5 integrated into protected `main`.                                                                        | PR #20: `https://github.com/npclown/vector-studio/pull/20`; merge commit `0a4abd4`; required validation job `101348487429`; source tag `evidence/p0.5-smoke-2026-09-06` |

Documentation review update, 2026-09-05: reconciled the dependency graph (ADR 0001), mapped graphics/MVP coverage, restored missing P0 foundation acceptance, and recorded lifecycle/measurement follow-ups. Local documentation links/formatting, `git diff --check`, `pnpm check` (45 tests), and `pnpm build` pass; details and reproduction commands are in `docs/evidence/docs-review-2026-09-05.md`. This update adds no implementation or benchmark result.

## Gate outcome

**P0 LOCAL PASS** on measured source `b524927f841347051ca2b4f95f8c4c83f5b4c14e`, preserved by `evidence/p0.6-final-20260909`. [Final review](../evidence/p0.6/20260909-final/README.md) records all fifteen revised acceptance criteria and ten browser/scenario outcomes as PASS, with clean-source benchmark and headed evidence. The first matrix on `62ed77a` is preserved but not accepted because of incomplete configuration hashes; the replacement run corrects metadata without changing algorithms or thresholds. Physical-display timing and native hardware OOM remain explicitly UNVERIFIED outside the approved exit gate. After required CI and protected PR integration, begin the P1 execution-plan/design-gate checkpoint; no P1 product code is authorized by this result alone.
