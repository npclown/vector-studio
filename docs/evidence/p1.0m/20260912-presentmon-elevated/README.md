# P1.0m elevated acquisition review: 2026-09-12

Status: **PARTIAL. Chrome ETW acquisition observed; Edge UAC canceled. A09/A10 remain UNVERIFIED.**

The user explicitly approved one-time elevation of only PresentMon after the [access-denied checkpoint](../20260912-presentmon-access/README.md). This follows the [authorized retry contract](../../../plans/p1-measurement-contract.md#authorized-elevated-retry-2026-09-12). It is an acquisition experiment, not a P1 renderer benchmark, pointer-latency result or permission to relax a gate.

## Scope and provenance

Started from clean, fetched `main` at `d9dc084643a778a0471979b25bc1bee8c02f4bf1`; branch `codex/p1-0m-elevated-acquisition`. All attempts used explicitly dirty test-only tooling. Each subdirectory contains the original source record and exact runner/preflight/elevation-helper sources. [manifest.json](manifest.json) hashes all 27 copied inputs/observations. All nine source hashes match their corresponding capture metadata. PowerShell-emitted helper records and Edge's source record retain their original bytes under `.json.txt` names to avoid formatting immutable observations; the manifest maps these names to the original `.json` paths.

The pinned portable PresentMon 2.5.1 SHA-256 remains `9bec3083069f58f911e6a512f4806db51a27bd096103087bc1d05ef54c80a191`. Only this executable was passed to `Start-Process -Verb RunAs -WindowStyle Hidden -PassThru`. The Node host, PowerShell launcher and browsers remained unprivileged. No group membership, service, driver, dependency, public API, product source or acceptance threshold changed. The binary remains in ignored local output. No existing trace was stopped.

## Attempts and outcomes

| Attempt           | Exact command                                                                                                         | Observation                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prelaunch failure | `node tooling/p1-presentmon-feasibility.mjs test-results/p1-presentmon-20260912-elevated-01 --elevated`               | Launcher exit 1 before result creation; no start record or CSV. Mandatory hash command failed before RunAs in the reproduced Node-launched PowerShell environment.     |
| Chrome            | `node tooling/p1-presentmon-feasibility.mjs test-results/p1-presentmon-20260912-elevated-02 --elevated`               | One 25-second capture, child/launcher exit 0. Runner stopped with nonzero status because its expected v2 CSV columns were absent. Edge was skipped by this invocation. |
| Edge only         | `node tooling/p1-presentmon-feasibility.mjs test-results/p1-presentmon-20260912-elevated-edge --elevated --edge-only` | UAC returned cancellation; helper PID/child exit are null, launcher exit 2, no CSV. No automatic retry.                                                                |

The [prelaunch acquisition record](prelaunch/chrome-acquisition.json) omitted launcher stderr because the original error path tried reading the missing result first. Preserve that defect and the original source. A [separate read-only reproduction](prelaunch/prelaunch-reproduction.json), executing the original mandatory prefix before RunAs with its script directory substituted, failed at unavailable `Get-FileHash`. It performs no launch/capture. Primary replaced that dependency on command availability with .NET SHA-256, verified the actual helper's `-PreflightOnly` path from Node, and moved stream preservation before result parsing. This prelaunch failure did not create a PresentMon capture; it does not consume an extra successful Chrome measurement.

### Chrome acquisition

[Raw acquisition](chrome/chrome-acquisition.json), [CSV](chrome/chrome.csv), [helper result](chrome/chrome-elevated-result.json.txt) and [markers](chrome/chrome-markers.json) are immutable. Chrome 152.0.7977.83 used isolated browser PID 4928 and GPU PID 24952. Post-consent CDP identity, GPU creation time/direct parent, visibility and window bounds matched. PresentMon PID 29476 started at the helper-observed `03:55:41.8406054Z` and exited at `03:56:07.0002930Z`, approximately 25.160 seconds later, without watchdog termination. UAC was requested at `03:55:28.9646722Z`; that earlier interval is consent wait, not capture duration.

Independent review found 1,494 correctly shaped rows, all for GPU PID 24952 and one swap chain. Of these, 1,446 have numeric `MsUntilDisplayed`; all 48 NA observations remain. Both composed and hardware-composed independent-flip modes occurred. The default/non-v2 schema contains `TimeInQPC`, `MsUntilDisplayed`, `MsBetweenDisplayChange` and additional `CPUStartQPC` fields. It is not strictly the explicit `--v1_metrics` schema. The runner's original `acquisitionValid: false`/missing-columns result remains unchanged; this separate review establishes successful acquisition under the actual schema, not successful v2 validation.

The [versioned CLI documentation](https://github.com/GameTechDev/PresentMon/blob/v2.5.1/README-ConsoleApplication.md) and [CSV implementation](https://github.com/GameTechDev/PresentMon/blob/v2.5.1/PresentMon/CsvOutput.cpp) distinguish these schemas. `MsUntilDisplayed` starts at Present; v2 `DisplayLatency` starts at the CPU frame start. They must not be renamed into equivalent observations. Primary added explicit `--v2_metrics` for the still-unrun Edge half and `--edge-only` to avoid repeating Chrome. Edge did not produce a v2 CSV, so the successful v2 path remains unverified. No measurements are pooled or compared.

Chrome logged 2,347 submitted fixture frames and 211 synthetic pointer moves over its full page lifetime, including consent wait; these counts are not the 25-second captured row count. Page/GPU errors were empty. Primary inspected the [screenshot](chrome/chrome-fixture.png), consistent with final frame 2347/input 211. Synthetic `isTrusted` events and an image are not physical-pointer or display-time evidence.

### Edge cancellation

[Edge acquisition](edge/msedge-acquisition.json) and [helper result](edge/msedge-elevated-result.json.txt) record Edge 153.0.4234.32, isolated browser PID 2916/GPU PID 18108 and the requested explicit v2 command. Windows reported `The operation was canceled by the user`; the record does not establish whether this came from an explicit click or the consent UI expiring. The helper waited from `03:58:01.9246261Z` to `04:00:04.2646735Z`, approximately 122.34 seconds, and never returned a PresentMon PID. That is UAC wait, not an overlong capture. No second UAC request followed.

The [fixture markers](edge/msedge-markers.json) contain 7,400 frames, zero pointer inputs and zero recorded GPU/page errors during that wait. Primary inspected the [screenshot](edge/msedge-fixture.png), consistent with frame 7400/input 0. These observations do not supply any missing ETW rows.

## Environment, cleanup and limitations

The per-attempt preflight records two active 1920x1080 displays at 60 Hz, GTX 1660 SUPER driver 32.0.15.9186, AC/Online power and QPC frequency 10,000,000. The 900x650 outer fixture window was on primary DISPLAY1 at `(10,10)`. GPU adapter fields reported NVIDIA/Turing; browser device/description strings were unavailable. Background load was not operator-confirmed for this experiment. UAC/foreground transitions and instrumentation prevent acceptance use.

Primary's final read-only CIM query found no PresentMon process or any of the exact Chrome/Edge browser/GPU PIDs above. The Chrome helper also records its returned PID absent after cleanup. Unrelated processes and trace sessions were not terminated. RunAs cannot redirect the elevated child's stdout/stderr; empty launcher streams must not be interpreted as an empty native error log.

CSV rows have no fixture frame/input ID, and no bounded browser-performance/QPC mapping was established. Every Chrome `MsAllInputToPhotonLatency` value is NA. A single producing process/swap chain plus an encoded image does not identify the row displaying a particular input's changed content. No pointer-latency percentile is computed. A09 memory coverage is unchanged; P1.0m remains PARTIAL and P1 implementation remains BLOCKED.

## Review and validation

Primary owned every edit and final interpretation. Sol `medium` independently reviewed launch/cleanup controls, official schemas and original artifacts; Luna `low` ran repository validation. Neither delegated further or ran captures. Review corrections required positive post-consent validation, separate consent/launch times, source/PID consistency, cleanup after start-record failure, retained error results and bounded exact-PID residual checks. Local iteration additionally corrected PowerShell command availability and explicit CSV schema selection.

- `pnpm check` — PASS after all tooling/evidence corrections: 13 files / 109 tests, formatting, lint, TypeScript and boundaries. Earlier audit-script format and explicit URL-import failures were corrected before this final full pass.
- `pnpm build` — PASS: all four build targets including playground production output. Product source did not change afterward.
- `node --check tooling/p1-presentmon-feasibility.mjs`, scoped ESLint/Prettier and PowerShell parser check — PASS during preparation; helper `-PreflightOnly` from Node also PASS after the hash correction.
- `node docs/evidence/p1.0m/20260912-presentmon-elevated/review.mjs` — PASS: 27 artifact hashes, nine source hashes, target-PID rows, child/launcher results and Edge cancellation. The audit is offline and does not modify originals or launch processes.
- Local Markdown link/anchor checker from `docs/evidence/docs-review-2026-09-05.md` — PASS: 228 links/anchors across 58 Markdown files. Explicit Prettier checks for the three changed Markdown files and `git diff --check` also PASS.
- Raw-copy and staged-blob audits — PASS: all 27 archived files and staged Git blobs match the original SHA-256 values. The record-local `.gitattributes` preserves captured CRLF/LF bytes and treats captured CRLF as a line ending while retaining the default whitespace checks. No original was normalized to satisfy a formatter.
- Headed P1 acceptance, benchmark repetitions, memory stress and latency gate — NOT RUN: unresolved methods and scope excludes them.

## Next work

Continue P1.0m method analysis: establish a supported content-to-display link and clock uncertainty bound, and resolve A09 simultaneous-memory coverage. Do not repeat Chrome or silently substitute queue completion/RAF for A10. Edge acquisition remains unverified; a new UAC request follows only a new user instruction after this cancellation. No product implementation is unlocked by this checkpoint.
