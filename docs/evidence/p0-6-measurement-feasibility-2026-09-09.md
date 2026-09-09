# P0.6 measurement feasibility: 2026-09-09

Status: Investigation complete; current presentation and native-OOM criteria remain UNVERIFIED. The decision proposals below are not approved requirements or permission to run a hazardous experiment.

## Scope and provenance

Base: clean `cae039268bab2fe446ea87aafe91b82548d17178`, equal to fetched `origin/main`; branch `codex/p0-6-measurement-feasibility`. This follows the [readiness review](p0-6-readiness-2026-09-09.md). Primary researched presentation methods and reviewed a Sol `medium` native-OOM investigation and a Terra `medium` read-only Windows environment audit. No additional delegation, product edits, GPU stress, benchmark, tool installation, browser trace or external capture occurred.

The sources below were inspected on 2026-09-09. Upstream source behavior is evidence about possible implementations, not proof that either installed browser took that code path. Recommendations and candidate procedures are explicitly engineering judgments, not measured results.

## Presentation candidates and limits

| Candidate                            | Verified meaning                                                | Disposition under the current physical-presentation criterion                                                        |
| ------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GPUQueue.onSubmittedWorkDone()`     | Completion of previously submitted queue work                   | Does not observe the display endpoint; retain its existing separate name                                             |
| Canvas PNG / CDP screencast          | Captured surface pixels; CDP exposes frame-swap metadata        | Useful visual evidence, insufficient physical-display timing                                                         |
| Chromium presentation feedback       | Flags distinguish VSYNC, hardware clock and hardware completion | Inspect the actual path/flags and correlate the exact frame; the name alone is insufficient                          |
| PresentMon / Windows graphics events | Process/swap-chain frame metrics and display-related events     | Candidate for an external proof of concept; not currently validated for this canvas or clock domain                  |
| Optical observation                  | Could measure visible light at the chosen screen region         | Requires a separately designed/calibrated instrument and start-event correlation; no such setup was established here |

The [GPUWeb queue reference](https://gpuweb.github.io/types/interfaces/GPUQueue.html#onsubmittedworkdone) describes queue completion. The [canvas interface](https://gpuweb.github.io/types/interfaces/GPUCanvasContext) provides configuration and current-texture access, not a per-frame physical-display timestamp. The [CDP Page specification](https://chromedevtools.github.io/devtools-protocol/tot/Page/#type-ScreencastFrameMetadata) describes the screencast timestamp as a frame-swap event. These APIs cannot silently replace the endpoint owned by the [measurement policy](../benchmarks/README.md#measurement-semantics).

[Chromium's feedback contract](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/gfx/presentation_feedback.h) distinguishes `kHWClock` and `kHWCompletion` from `kVSync`. The inspected [Windows DComp implementation](https://chromium.googlesource.com/chromium/src/+/lkgr/ui/gl/dcomp_presenter.cc), blob `bdfa486db3cabc3081dc9745fab1b4914a2f1119`, emits a feedback value using the last VSYNC and only `kVSync`; its fallback can use a user-space current timestamp. Therefore an event named presentation, or a generic next-VSYNC marker, is not sufficient evidence of hardware presentation. No claim is made that this upstream path is the one used by the installed Chrome/Edge builds.

[PresentMon's console documentation](https://github.com/GameTechDev/PresentMon/blob/main/README-ConsoleApplication.md) identifies frames by process and swap chain and provides QPC-based CPU-start and display-latency observations. `DisplayedTime` is a duration, not the presentation timestamp. A browser process/swap chain may contain composition work unrelated to a particular canvas generation; mapping those observations to this fixture is an unresolved step, not an automatic guarantee. Raw QPC values, browser `performance.now()` and epoch time must not be subtracted without demonstrated clock correlation; see [Microsoft's QPC guidance](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps). [CDP clock-sync markers](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/#method-recordClockSyncMarker) are a candidate ingredient, not proof that a cross-tool mapping already exists.

### Bounded external-instrumentation proposal, if authorized

1. Use an official, version-pinned PresentMon console binary as a test-only external tool after approval; record its source, version and hash. Do not add it to runtime packages, change browser/GPU drivers, or stop other trace sessions.
2. Choose and record one physical monitor, its active mode/refresh and browser-window placement. Limit capture to one freshly launched benchmark browser process tree, one fixture window, and a maximum 30-second observation per browser with a unique session/output identity. Keep raw dropped/failed events.
3. Record initialization/loss/generation markers and establish a clock mapping with an explicit uncertainty bound. Prove which output frame contains the fixture's first/rebuilt content using independent frame/content correlation. Ambiguous swap chains, display paths, missing hardware evidence, clock drift or capture loss produce UNVERIFIED.
4. Treat the result only as a feasibility observation. A successful proof of concept must yield a reproducible event/clock/overhead contract and a prospective successor scenario before acceptance runs. Tracing/capture overhead must be recorded and evaluated; existing uninstrumented benchmark thresholds are not automatically validated by this run.

This proposal may fail to establish physical presentation, and it does not solve native OOM. It is not selected or executed by this research checkpoint.

## Native OOM feasibility

The public API separates descriptor validation from fallible allocation. Exceeding `maxBufferSize` is not a reliable way to generate an allocation OOM: it violates buffer-creation validation. A valid allocation can fail, but this investigation found no portable public API that sets a deterministic small allocation budget in stock Chrome/Edge. A fixed small allocation cap therefore cannot guarantee hardware OOM, and increasing allocations until failure is not a bounded safe proof on this development machine. See [WebGPU buffer creation](https://gpuweb.github.io/gpuweb/#dom-gpudevice-createbuffer) and the [fallible-allocation/error-scope explainer](https://gpuweb.github.io/gpuweb/explainer/).

An OOM error scope captures that error instead of delivering it through the uncaptured-error path. Manually constructed/dispatched errors demonstrate injection, not hardware delivery. Native device loss is also a different event. The existing [backend fixture](../../tests/unit/webgpu-backend.test.ts) and [headed recovery suite](../../tests/gpu/webgpu-recovery.spec.ts) retain their narrower, already documented meanings.

[Dawn's native implementation](https://dawn.googlesource.com/dawn/+/9d1921280f9f858777a4bd7195539494bc975833/src/dawn/native/Device.cpp) supports `DawnFakeBufferOOMForTesting` and returns an injected allocation error when its flag is set. The [Dawn end-to-end test](https://dawn.googlesource.com/dawn.git/+/a562d1dac31ed93cf562215c4edde2fb277dd0c3/src/dawn/tests/end2end/BufferTests.cpp#962) simulates these failures with a four-byte buffer rather than relying on natural exhaustion. That native descriptor extension is not part of the [public browser buffer descriptor](https://gpuweb.github.io/types/interfaces/GPUBufferDescriptor.html). A custom native-stack fault-injection environment could test more of the delivery chain, but still must be called injection; it would not prove physical hardware exhaustion under the existing criterion. No browser build, native dependency or fault injection was introduced.

**Primary conclusion:** no guaranteed bounded native-hardware-OOM reproduction method was identified through the stock browser's public API. This is a scoped feasibility conclusion, not a claim that native OOM can never occur. Keep that part of P0-A07 UNVERIFIED. Any real-pressure experiment needs a separately approved isolated environment, explicit resource/time limits and a failure/cleanup procedure; no safe numeric budget has been established here.

## Reference environment: observed versus unresolved

Terra gathered the following facts; Primary independently repeated the controller, active-monitor and power-scheme reads:

| Read-only command                                                            | Observation                                                                            | Limit                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `Get-CimInstance Win32_VideoController` with selected mode/driver properties | NVIDIA GeForce GTX 1660 SUPER; driver `32.0.15.9186`; controller mode 1920x1080, 60 Hz | Does not associate the future benchmark window with a display         |
| `Get-CimInstance -Namespace root\wmi WmiMonitorConnectionParams`             | Two active monitor entries                                                             | Does not establish each active mode/refresh or window placement       |
| `powercfg /getactivescheme`                                                  | Balanced, GUID `381b4222-f694-41f0-9685-ff5bb260df2e`                                  | Not proof of power source, all power-mode settings or background load |
| `Get-CimInstance Win32_Battery`                                              | No instances returned                                                                  | Does not prove AC power                                               |
| `Get-Command PresentMon*,wpr,wpa,nvidia-smi -ErrorAction SilentlyContinue`   | No PATH entries returned in this session                                               | Does not prove tools are absent from disk                             |

Do not pass `--display-refresh-hz 60` solely from the controller observation. Before a run, verify the selected monitor and actual window placement, active mode/refresh, power source/mode and unavoidable background work. The current [runner](../../tests/benchmark/p0-foundation.spec.ts) records a supplied refresh value and leaves power mode/background audit incomplete. These are environment-preparation tasks, not renderer changes or permission to invent metadata. No display/power setting was changed here.

## Decision for the next execution batch

The default remains the approved criteria. To cross the current evidence gap, the user must choose an instrumentation investment or approve a prospective change of acceptance semantics. Merely repeating the existing benchmark cannot resolve it.

| Direction                                                                                      | Concrete next work                                                                                                            | Consequence                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Preserve current physical-presentation/native-OOM gate                                         | Authorize external presentation instrumentation feasibility work and separately specify a suitable OOM validation environment | P0 remains open; neither method is guaranteed to succeed; native-stack injection alone still does not satisfy hardware exhaustion |
| Revise P0 verification to observable SDK boundaries (Primary recommendation; **not approved**) | Apply the exact prospective changes below, then verify environment and run the complete unchanged-duration benchmark matrix   | Changes acceptance meaning; makes no claim that physical presentation or hardware exhaustion was measured                         |

Proposed changes, only if explicitly approved:

- `p0/startup/v2`: retain ready timing and the 1,000 ms ready ceiling; replace the unobservable first-present endpoint with initialization-start to completion of the first submitted GPU work, p95 at most 1,200 ms. Continue separate headed visual output checks. Preserve all v1 observations and their UNVERIFIED presentation field.
- `p0/lifecycle-recovery/v2`: retain 25 cycles per repetition, ownership/listener and one-recovery invariants; require recovery ready and rebuilt-work queue completion within 3,000 ms of loss detection, with separate headed visual reconstruction evidence. Do not label queue completion as presentation.
- P0-A07: require deterministic injected OOM diagnostic mapping plus native headed validation-error and device-loss delivery; retain actual native hardware OOM as an explicitly UNVERIFIED residual verification item outside the revised P0 exit gate. Product behavior must still surface OOM diagnostics; no handling implementation is removed.
- Update the owning active plan and validation evidence policy before implementation or runs, and version the changed startup/lifecycle scenarios. Other scenario identities, five repetitions, durations, numeric ceilings and architecture remain unchanged. P0/P1 progression still requires every revised P0 criterion and scenario to pass; approval of this proposal alone does not pass P0.

The recommendation is based on separating reproducible SDK behavior from browser/driver/physical-display instrumentation. It is an explicit reduction in required hardware evidence for the P0 exit gate, not an equivalent proof of the original criteria. No part of this proposal has been applied to the authoritative acceptance criteria.

## Validation of this research checkpoint

Only this new investigation record and the active-plan status/link change. Source-of-truth review and Primary source verification are complete. Sol's final read-only review found no actionable ambiguity in the OOM conclusion or the explicitly unapproved acceptance reduction.

- `pnpm exec prettier --check --ignore-path .gitignore docs/plans/p0-webgpu-foundation.md docs/evidence/p0-6-measurement-feasibility-2026-09-09.md` - PASS.
- Repository local-link/anchor checker from `docs/evidence/docs-review-2026-09-05.md` - PASS: 95 links/anchors across 32 Markdown files.
- `git diff --check` and scoped source-of-truth review - PASS; no authoritative acceptance criterion, product source, dependency or historical observation changed.
- Build/unit/browser/GPU/benchmark commands - NOT RUN for this research-only checkpoint. No new runtime or performance result is claimed; required remote static/unit/build CI remains an integration gate.
