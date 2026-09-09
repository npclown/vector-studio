# P0.6 approved observable-boundary implementation and review

Status: Implementation validated; clean-source acceptance capture pending; P0 gate open

## Approval and scope

On 2026-09-09 the user explicitly approved the observable-boundary alternative from the [feasibility investigation](p0-6-measurement-feasibility-2026-09-09.md). The [active contract](../plans/p0-webgpu-foundation.md#approved-observable-boundary-contract-2026-09-09) owns the revised acceptance: startup v2 queue completion at 1,200 ms p95, navigation-ready at 1,000 ms p95, lifecycle v2 recovery-ready and queue completion each within 3,000 ms, and injected OOM mapping plus native validation-error/device-loss delivery. Physical-presentation timing and genuine hardware OOM remain UNVERIFIED residual items outside the revised P0 exit gate. The approval does not authorize P1, external instrumentation or uncontrolled allocation pressure.

The other three scenarios retain v1 and their existing windows, repetitions and ceilings. Historical observations are unchanged. Primary found and corrected a pre-existing metadata mismatch: startup and lifecycle declared 1280 x 720 while initializing 640 x 360. The internal `?surface=p0-reference-v1` fixture now selects the already-required size before initialization; v2 records and browser fixtures must prove actual dimensions through reinitialization and recovery.

## Ownership and review

- Primary owns the acceptance contract, CLI observation inputs, integration review and gate interpretation.
- Sol `medium` owns the benchmark spec: v2 identity/hash, distinct timing endpoints, actual surface observations and preflight metadata. Request timing instrumentation remains in the benchmark page context.
- Terra `medium` owns the async artifact writer and its unit coverage, then the independent playground reference-size fixture and browser regression. Terra also performs a read-only cross-check.
- No worker delegates further. No renderer package, public contract, runtime dependency or shared device lifecycle is changed.

Both JSON and generated Markdown are formatted before exclusive creation. Existing records are never rewritten. Benchmark results remain generated Exploratory observations until a separate Primary review accepts valid evidence.

## Reference environment preflight

The user initially reported YouTube playback, then reported that YouTube and other GPU work had been closed and instructed the run to proceed. This is operator-reported background preparation, not a process-wide absence-of-load measurement.

Primary read-only Windows observations:

| Procedure                                                                                                         | Observation                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `System.Windows.Forms.Screen.AllScreens` plus per-device `EnumDisplaySettings(deviceName, ENUM_CURRENT_SETTINGS)` | `DISPLAY1`, primary, bounds `(0,0,1920,1080)`, 1920 x 1080 at 60 Hz; `DISPLAY2`, bounds `(1920,0,1920,1080)`, 1920 x 1080 at 60 Hz |
| `System.Windows.Forms.SystemInformation.PowerStatus.PowerLineStatus`                                              | `1`, Online/AC                                                                                                                     |
| `powercfg /getactivescheme`                                                                                       | Balanced, GUID `381b4222-f694-41f0-9685-ff5bb260df2e`                                                                              |
| Prior repeated `Get-CimInstance Win32_VideoController` audit                                                      | NVIDIA GeForce GTX 1660 SUPER, driver `32.0.15.9186`                                                                               |

Per-device mode enumeration resolves the ambiguity in the earlier controller-only reading. Actual browser window/Screen bounds and visibility are recorded by the runner and must be checked against this preflight. The runner disables its own DevTools, trace and video capture; this does not inspect every host application. Browser Battery API data remains separate from the Windows power observation.

## Validation and source checkpoint

Local source validation before the measured checkpoint:

- `pnpm check` - PASS: formatting, lint, TypeScript, 13 unit/contract files with 109 tests, package boundaries.
- `pnpm exec playwright test --config playwright.config.ts tests/browser/webgpu-initialization.spec.ts` - PASS: 12 Chrome/Edge cases, including first-initialize/reinitialize reference dimensions (12.0 s).
- `pnpm test:gpu` - PASS: 10 headed Chrome/Edge cases (15.5 s). This routine dirty-source run precedes the immutable capture.
- `pnpm benchmark:p0 -- --profile smoke --output-dir playwright-report/p0-v2-smoke-20260909-1316 --display-refresh-hz 60 --power-source AC --power-mode Balanced --background-load "User reports YouTube and other GPU work closed; Codex remains active" --gpu-driver 32.0.15.9186` - PASS: production build, 2 browser tests (10.4 s), 10 JSON/Markdown pairs. Shortened smoke is not performance acceptance.
- CLI negative checks for missing power-source text, missing acceptance refresh, and refresh `0` each returned the expected exit code 2.

Primary reviewed the final diff, exported smoke facts, fixture tests and writer collision semantics. Both startup records have native adapter/device subspans and actual 1280 x 720/DPR 1. Both browser windows report CDP bounds `(10,10,1296,808)` in normal state, wholly within the audited primary monitor. Playwright-emulated 1280 x 720 Screen values are separately labeled and were not used as physical display metadata. A potential instrumentation-installation exception was isolated so it cannot convert native adapter success into failure. Worker review's suspected missing `unavailable` argument was rejected after Primary checked the four-argument helper signature and passing type checks.

Clean-source capture and final criterion review follow separately. No performance result or final P0 criterion is marked PASS by the local smoke run.

## Remaining evidence

- Full five-repetition matrix in headed Chrome and Edge on the clean measured source.
- Current-source headed visual/recovery/foundation fixtures.
- Per-criterion P0-A01 through A15 review, per-scenario numeric review, source/artifact links and residual risks.
- Required protected-branch CI and pull-request integration.
