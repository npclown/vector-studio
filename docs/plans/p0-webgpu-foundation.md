# P0 execution plan: WebGPU foundation

Status: Pre-implementation; bootstrap verification PR in progress

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

```text
idle -> initializing -> ready
  |          |           |
  |          v           v
  +------ unsupported    lost -> recovering -> ready
                         |
                         v
                      failed

Any non-disposed state -> disposed
```

Required invariants:

- Concurrent `initialize` calls share one initialization attempt.
- `initialize` is idempotent while ready.
- `dispose` is idempotent and terminal.
- A stale adapter/device promise cannot change state after disposal or a newer generation.
- Device loss advances a generation, invalidates all GPU resources, and attempts one controlled recovery.
- Recovery rebuilds resources from CPU-owned descriptors, not old GPU handles.

Exact public names may change during implementation; the state behavior may not change without updating this plan.

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
- [ ] Verify the complete workflow with a documentation-only feature branch and pull request if needed.

Gate: no P0.0 product/toolchain implementation begins until `origin/main` exists, GitHub authentication works, and the pull-request workflow is usable. Evidence includes sanitized `git remote -v`, `git branch -vv`, `gh auth status`, the baseline commit ID, and the repository/default-branch protection URL or settings record.

### P0.0 Repository foundation

- [ ] Create the minimal workspace and package boundaries described by `ARCHITECTURE.md`.
- [ ] Pin the Node/package-manager/toolchain versions used by the repository.
- [ ] Establish root commands for build, static checks, unit tests, browser tests, GPU validation, and P0 benchmarks.
- [ ] Add dependency-boundary enforcement or an equivalent test.
- [ ] Keep the repository buildable without Rust until P2.

Evidence: static validation command, package graph output, clean production build.

### P0.1 Contracts and diagnostics

- [ ] Define renderer lifecycle, pixel-size, invalidation, statistics, capability-result, and diagnostic contracts without WebGPU types.
- [ ] Define stable diagnostic codes for capability, initialization, validation, device loss, recovery, allocation, render, and disposal events.
- [ ] Implement subscription disposal and deterministic timestamps for tests.
- [ ] Define resource-accounting categories and byte-estimation rules.

Evidence: unit tests and an architecture-boundary test.

### P0.2 WebGPU initialization and surface

- [ ] Detect secure context, `navigator.gpu`, adapter availability, and canvas-context availability separately.
- [ ] Request and record adapter/device information and limits.
- [ ] Configure the canvas using the preferred presentation format.
- [ ] Convert CSS size and DPR to bounded physical dimensions using device limits.
- [ ] Suspend presentation for zero-area surfaces while retaining valid lifecycle state.
- [ ] Handle resize without recreating size-independent resources.

Evidence: unit tests with injected capabilities plus Chrome/Edge browser integration tests.

### P0.3 Render scheduling and foundation scene

- [ ] Coalesce multiple invalidations into at most one submitted frame per animation frame.
- [ ] Submit no frames while idle and unchanged.
- [ ] Support an explicit continuous mode for benchmark and future animation use.
- [ ] Create shader modules and pipelines outside the steady-state frame path.
- [ ] Render a deterministic clear color and triangle through a multisampled target when four-sample MSAA is supported.
- [ ] Fall back from four-sample to one-sample only as an explicit recorded capability decision, not to another renderer.

Evidence: scheduler tests, pipeline/resource counters, browser screenshot, and P0 steady/idle benchmark results.

### P0.4 Resource lifecycle and recovery

- [ ] Track owned buffers, textures, shader modules, pipelines, and size-dependent attachments.
- [ ] Replace and release size-dependent attachments on resize.
- [ ] Capture uncaptured GPU validation and out-of-memory errors as structured diagnostics.
- [ ] Observe device loss and prevent work submission to the lost generation.
- [ ] Simulate loss by deliberately destroying the device in a test-only control.
- [ ] Attempt one recovery and rebuild the foundation scene from CPU descriptors.
- [ ] Release all tracked resources and listeners on dispose.

Evidence: lifecycle contract suite, resource-counter assertions, ordered loss/recovery diagnostics, and headed hardware recovery run.

### P0.5 Playground and measurement harness

- [ ] Display backend state, adapter identity, surface size, sample count, frame counters, timing summaries, and recent diagnostics.
- [ ] Provide controls for invalidation, continuous rendering, resize storm, device-loss simulation, and disposal/reinitialize checks.
- [ ] Use stable scenario IDs, versions, and seeds.
- [ ] Export raw benchmark data and environment metadata as JSON.
- [ ] Generate or support generation of the committed Markdown result format.
- [ ] Ensure measurement mode runs a production build without DevTools or tracing overhead.

Evidence: browser integration tests, manual smoke artifact, and schema-valid result files.

### P0.6 Final validation and gate review

- [ ] Run the complete static/unit/contract/browser validation surface.
- [ ] Run headed Chrome and Edge GPU validation on the reference machine.
- [ ] Execute five repetitions of every P0 benchmark scenario.
- [ ] Commit raw JSON and Markdown summaries.
- [ ] Evaluate every acceptance criterion below as PASS, FAIL, or UNVERIFIED.
- [ ] Record residual risks and decide whether P1 may begin.

Evidence: completed acceptance matrix and linked result files.

## Acceptance criteria

| ID | Criterion | Required validation |
| --- | --- | --- |
| P0-A01 | Insecure context, missing WebGPU API, missing adapter, missing canvas context, and device-request failure produce distinct stable diagnostic codes. | Unit + browser |
| P0-A02 | Initialization is concurrency-safe and idempotent; disposal is idempotent and terminal; stale async completion cannot revive disposed state. | Unit + contract |
| P0-A03 | Surface sizing applies DPR, clamps to adapter limits, handles zero area without presenting, and recreates only size-dependent resources. | Unit + browser + resource counters |
| P0-A04 | The foundation scene presents the expected clear color and triangle in stable Chrome and Edge. | Headed browser + visual artifact |
| P0-A05 | Multiple invalidations before the next animation frame produce at most one submission; an unchanged idle backend submits none. | Unit + benchmark |
| P0-A06 | Shader module and pipeline creation counts remain constant throughout steady-state measured frames. | Resource counters + benchmark |
| P0-A07 | Uncaptured validation/out-of-memory errors and device loss are surfaced as structured diagnostics with backend generation and context. | Contract + headed hardware |
| P0-A08 | Deliberate device destruction invalidates old resources, performs one controlled recovery, rebuilds the foundation scene, and presents again. | Headed Chrome + Edge |
| P0-A09 | After each dispose, engine-owned live-resource counters return to zero; 25 lifecycle cycles show no accumulating tracked resources or listeners. | Contract + benchmark |
| P0-A10 | Benchmark output includes all metadata required by `docs/benchmarks/README.md` and can reproduce the scenario from ID, version, seed, and configuration. | Schema/contract test |
| P0-A11 | The production build passes the full planned root validation commands and contains no runtime renderer/scene/tessellation dependency. | Static + dependency audit |
| P0-A12 | Renderer contracts and editor-facing code contain no exported WebGPU types; only the concrete backend imports WebGPU bindings. | Type/API boundary test |

P0 passes only when all P0-A criteria are PASS. A criterion cannot be waived by a good benchmark number.

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

Planned repository commands must cover:

```text
check          -> P0-A01, A02, A03, A05, A06, A09, A10, A11, A12 deterministic evidence
test:browser   -> P0-A01, A03, A04 automated browser evidence
test:gpu       -> P0-A04, A07, A08 headed Chrome/Edge evidence
benchmark:p0   -> P0-A05, A06, A09, A10 and all p0/* scenarios
build          -> P0-A11 production artifacts
```

The implementation may choose concrete tools, but these root responsibilities and evidence outputs are required.

## Risks and mitigations

| Risk | Mitigation / gate |
| --- | --- |
| Headless browser uses a software or incompatible adapter | Do not use it for hardware acceptance; require headed Chrome/Edge evidence |
| Browser does not expose physical GPU allocation | Use engine-owned byte accounting and label browser metrics advisory |
| Device-loss behavior varies by driver | Test stable diagnostic/state invariants and retain environment metadata |
| Pipeline compilation creates first-frame jank | Measure startup separately and assert no creation in steady state |
| DPR creates unexpectedly large MSAA targets | Clamp to device limits, record physical size, and test native-DPR visual smoke separately |
| Early abstraction mirrors WebGPU and blocks WebGL2 later | Keep the common boundary at render intent/draw packets as defined by `ARCHITECTURE.md` |

## Explicit non-goals

- Retained document scene synchronization
- Primitive instancing and 1,000/10,000-node scenes
- Path representation, flattening, or tessellation
- Rust/WASM toolchain
- Hit testing and spatial index
- Text, editor tools, React bindings, persistence, and export
- WebGL2 fallback

## Progress log

| Date | Update | Evidence / decision |
| --- | --- | --- |
| 2026-08-27 | Documentation gate established; no implementation started. | `AGENTS.md`, `ARCHITECTURE.md`, this plan, validation and benchmark policies |
| 2026-08-27 | Git/GitHub workflow audited. Repository has no commits, remote, upstream, or available `gh` CLI; P0 is gated on bootstrap. | Local Git and CLI status checks; `AGENTS.md` workflow |
| 2026-08-27 | Public `origin` registered, unborn branch renamed to `main`, and GitHub CLI authenticated as `npclown`. | `gh auth status`, `gh repo view`, `git remote -v`, `git status --branch` |
| 2026-08-27 | Documentation-only baseline `21afc22` pushed to `origin/main`; squash-only merge and protected `main` configured. | GitHub repository and branch-protection API verification |

## Gate outcome

Current outcome: **AWAITING BOOTSTRAP VERIFICATION PR**. Repository bootstrap, authentication, and `main` protection are complete. The first feature-branch pull request must merge successfully before P0.0 begins. Product implementation has not started.
