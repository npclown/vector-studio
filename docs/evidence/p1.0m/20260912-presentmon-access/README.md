# P1.0m PresentMon acquisition attempt: 2026-09-12

Status: **BLOCKED by Windows ETW privilege; physical presentation remains UNVERIFIED.**

This records one bounded attempt under the [P1 measurement contract](../../../plans/p1-measurement-contract.md#physical-presentation-feasibility-proposal). The user replied `다음` on 2026-09-12 after the concrete portable-tool proposal; Primary proceeded only within that proposed feasibility scope. No permission to auto-elevate, modify group membership, change thresholds or implement P1 was inferred.

## Source and procedure

- Base: clean, fetched `main` at `2dcc08be40e0a7bad524b2f906920a1804e3f175`; feature branch `codex/p1-0m-presentation-feasibility`.
- The execution used the uncommitted test-only files recorded in [source.json](source.json). The exact [runner source](p1-presentmon-feasibility.mjs.txt) and [preflight source](p1-presentmon-preflight.ps1.txt) are archived alongside the observations. [manifest.json](manifest.json) hashes all seven original artifacts/inputs. This is reproducible dirty-source feasibility evidence, not a clean-source performance baseline.
- Official portable `PresentMon-2.5.1-x64.exe`, 956768 bytes, SHA-256 `9bec3083069f58f911e6a512f4806db51a27bd096103087bc1d05ef54c80a191`, matched the pinned contract before execution. It remains in ignored `test-results/p1-tools/presentmon-2.5.1/`; no installer, service, runtime dependency or driver change was used. `--help` identified version 2.5.1 and returned exit 1; this help invocation was not a capture.
- Command: `node tooling/p1-presentmon-feasibility.mjs test-results/p1-presentmon-20260912-01`. The shell tool reported nonzero exit 1; the direct PresentMon child result was exit 6. The script marks acquisition failure and requests nonzero termination. Neither wrapper status nor child error is a successful measurement.
- The isolated test-only WebGPU page writes frame/input IDs into a black/white marker. It is not the P1 renderer, the P0 acceptance scene, or a latency oracle. The requested PresentMon duration was 25 seconds with a 30-second process timeout, inside the proposed 30-second upper bound. No existing trace was stopped and no dropped rows were excluded.

## Observations

[chrome-acquisition.json](chrome-acquisition.json) records the command, PID ownership, window, monitor, exact stderr and unsuccessful acquisition. PresentMon attempted to start at `2026-09-12T03:32:33.998Z` and had exited by `03:32:34.136Z` with:

```text
error: failed to start trace session: access denied.
PresentMon requires either administrative privileges or to be run by a user in the
"Performance Log Users" user group.
```

The [preflight](preflight.json) independently shows that this token is neither an elevated administrator nor a Performance Log Users token. This was a Windows tracing permission failure, not an automatic tool-approval rejection. No CSV was created. Edge was **NOT RUN** because the acquisition prerequisite failed; no elevated retry occurred.

| Observed item             | Result / limit                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome                    | 152.0.7977.83, isolated launch; browser PID 17596 and direct-child GPU PID 25832                                                                                                         |
| Window/display            | Outer bounds `(10,10,900,650)`, normal state, contained within primary DISPLAY1; active 1920x1080 at 60 Hz                                                                               |
| Other display             | DISPLAY2 also 1920x1080 at 60 Hz; not the test window's display                                                                                                                          |
| GPU / power               | GTX 1660 SUPER, driver 32.0.15.9186, Online/AC; power scheme GUID `381b4222-f694-41f0-9685-ff5bb260df2e`                                                                                 |
| Background load           | Not operator-confirmed on this attempt; no timing/performance acceptance claim                                                                                                           |
| QPC                       | Frequency 10000000 observed; no browser/QPC mapping was established                                                                                                                      |
| Fixture log               | [42 submitted RAF records and one synthetic input](chrome-markers.json), ready and visible, zero recorded page/GPU errors                                                                |
| Visible marker            | [Screenshot](chrome-fixture.png): Primary inspected input marker 1 and frame marker 42; image observation is not a display timestamp                                                     |
| Trace/display correlation | No acquired trace/CSV, no compositor-token/content link, no latency samples or p95                                                                                                       |
| Cleanup                   | Exact browser/GPU PIDs were gone after the command. Independent review found no PresentMon process or remaining user-visible trace session. Unrelated Chrome processes were left intact. |

The raw adapter object is empty because the original fixture spread non-enumerable adapter-info properties; the raw localized power-scheme label has encoding loss. Preserve those observations unchanged. The separately observed GPU driver/adapter controller and scheme GUID are available; these narrow metadata limits do not explain away or change the explicit access-denied result.

## Primary review and validation

Primary owns the probe and all edits. One Sol `medium` worker independently reviewed the plan, acquisition controls and actual artifacts. Review caught two defects before the attempt: a failed child could leave a successful wrapper exit, and child exit 0 alone could be mistaken for acquired data. The runner now propagates failure and requires CSV columns, target-PID rows and displayed rows. It retains dropped/NA observations and never claims that a valid CSV proves content correlation.

After archiving the exact executed sources, Primary prepared three metadata corrections for a future authorized retry: explicit adapter fields, preflight source hashing, and UTF-8/GUID-based power metadata. These affect the current tooling files, not the immutable failed-run inputs. The new metadata path has static/read-only validation; no second browser/capture run is implied. Positive CSV acquisition and full clock/content correlation remain unverified.

- `node --check tooling/p1-presentmon-feasibility.mjs` and `pnpm exec eslint tooling/p1-presentmon-feasibility.mjs` — PASS after the metadata correction.
- `powershell.exe -NoProfile -File tooling/p1-presentmon-preflight.ps1` — PASS after correction: privilege booleans, per-display mode, QPC frequency, AC state and scheme GUID are readable; no capture.
- `pnpm check` — PASS: 13 unit/contract files, 109 tests, TypeScript, ESLint, formatting and package boundaries. Luna `low` performed the commands; Primary interprets this as repository regression validation, not test coverage of a successful PresentMon path.
- `pnpm build` — PASS: contracts/core/WebGPU package builds and playground production build, 21 Vite modules. Product source did not change.
- Probe command above — **BLOCKED**, child exit 6; no CSV and Edge skipped. No headed acceptance suite, P1 benchmark, OOM experiment or performance gate judgment was performed.
- Final `pnpm check` after metadata corrections and evidence additions — PASS again: 13 files / 109 tests plus formatting, lint, TypeScript and boundaries. Product build output remains covered by the preceding build because no product source changed.
- Local Markdown link/anchor checker from `docs/evidence/docs-review-2026-09-05.md` — PASS: 212 links/anchors across 57 Markdown files.
- `pnpm exec prettier --check --ignore-path .gitignore docs/evidence/p1.0m/20260912-presentmon-access/README.md docs/plans/p1-measurement-contract.md docs/plans/p1-instanced-primitives.md` and `git diff --check` — PASS.
- Node SHA-256/byte-comparison audit — PASS: all seven manifest hashes match, the archived runner matches `source.json`, and all five raw artifacts are byte-identical to the ignored original output. No raw evidence or archived source was rewritten.

## Required next decision

The same bounded experiment now needs **one-time elevated PresentMon execution** to try ETW acquisition. Prefer that to permanently changing Performance Log Users membership. Use a new output/session identity, a fresh isolated browser and the same PID filter and time limits. Keep the browser, host runner and ordinary tests unprivileged; only the exact PresentMon child should request elevation. The current helper does not auto-elevate.

Approval of that retry would not guarantee observable content/display correlation, authorize additional captures beyond the bounded pair, pass A10, resolve A09 memory coverage, or start P1 implementation. The already acquired failure remains immutable regardless of a later outcome.
