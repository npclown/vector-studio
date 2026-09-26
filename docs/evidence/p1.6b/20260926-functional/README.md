# P1.6b implementation and functional review — 2026-09-26

Status: B01-B04 local acceptance C01-C07 PASS under the [frozen contract](../../../plans/p1-observed-runner.md). Required remote CI and protected integration are separate gates. B05/C08 reference hardware observations are NOT RUN; A05/A08 acceptance and P1/A09/A10 remain UNVERIFIED.

## Scope and provenance

The implementation observes actual CPU `packGeometry` calls separately from successful backing-record writes and native GPU uploads. It adds the guarded reference-duration host and immutable repetition aggregation without changing public scene contracts, packet v1, workload formulas, thresholds, backend lifecycle ownership, dependencies or shader behavior.

Measured base: `07db0a88d1fed41bb305ae4c8e127821b4fc8329` plus the explicitly dirty source manifest. Each of the 16 native records contains 120 source files. Manifest SHA-256: `6e53f610ecd0881e7ab147702905a9e6f8c92785fa17c83f36ef697044925bd2`. Primary compared every recorded source hash with the final implementation bytes: 1,920 comparisons PASS. Documentation and archived evidence are outside that implementation manifest.

The [raw archive](raw/) preserves all 52 JSON files from this checkpoint: eight development captures, eight production captures, each capture's end-source and validation records, and the production invocation/start/end/aggregate records. No runtime attempt was discarded. The [production aggregate](raw/20260926-final-functional/aggregate.json) has eight compatible functional groups and zero findings; its A05/A08 and overall acceptance fields remain UNVERIFIED.

## Validation

| Command / check                                                                                 | Result                                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm check`                                                                                    | PASS: format, ESLint, TypeScript, 250 unit tests in 33 files, package boundaries                 |
| `pnpm build`                                                                                    | PASS: all packages; playground 43 modules                                                        |
| `pnpm test:browser`                                                                             | PASS: 20 serial Chrome/Edge tests, including eight CPU/native observations                       |
| `pnpm benchmark:p1 --profile functional --output-dir artifacts/p1.6b/20260926-final-functional` | PASS: fresh production build, eight native cases, exclusive output, source markers and aggregate |
| Explicit changed-Markdown Prettier, local links/anchors and `git diff --check`                  | PASS; source-of-truth and scope review complete                                                  |
| Headed reference, A09 memory, A10 physical presentation                                         | NOT RUN: this checkpoint proves implementation and functional instrumentation only               |

The first full check found an ESLint unsafe matcher assignment in a new profile fixture. Primary replaced it with the concrete frozen configuration; the complete check above then passed. No runtime failure was hidden by that correction.

Environment: Windows 11 Pro `10.0.26200`; Ryzen 7 3700X, 16 logical cores; Chrome `153.0.8010.53`; Edge `154.0.4258.37`; actual WebGPU adapter reports NVIDIA/Turing, native 4x samples. Both validation profiles here were headless functional runs at 1280×720 CSS/physical pixels and DPR 1. Complete adapter limits, browser identity, command, time origin, timer increments, window dimensions and instrumentation are in each record. No refresh/power/background-load assertion is inferred from these functional runs.

## Acceptance mapping

| Contract | Evidence and Primary conclusion                                                                                                                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01      | `primitive-preparation-statistics.test.ts`: initial two-node exact counts; unchanged preparation; normalized-equal radii still count one geometry build and zero geometry writes                                                                                                             |
| C02      | The same suite distinguishes exact CPU deltas/cumulative counts for camera, separate color/opacity, transform, rebase, growth, snapshot and generation reconstruction. Existing packet/native/lifecycle suites remain passing                                                                |
| C03      | Frozen detached snapshots, independent sources, failed numeric preparation, lifetime and disposal fixtures; service forwarding preserves ownership                                                                                                                                           |
| C04      | Metrics/profile suites preserve exact half-open boundaries, failed/long intervals and final boundary sample; reject invalid counters, disconnected observers, missing submissions, hidden state and generation changes                                                                       |
| C05      | All 16 native records have eight callbacks, initial 1,000/10,000 geometry builds, zero measured geometry builds, correct 1,000/10,000/1,032 visible populations, one RAF owner and zero tracked live resources/pending callbacks after disposal                                              |
| C06      | CLI guards reject incomplete metadata before output reservation/build. Record and aggregate fixtures reject missing/duplicate repetitions, source/config/environment drift, false claims, modified metrics and malformed evidence. Honest failures and rejected raw artifacts remain durable |
| C07      | Repository checks, production build, 20 browser regressions and eight production cases above PASS; remote CI remains the protected PR gate                                                                                                                                                   |
| C08      | UNVERIFIED: needs a separate current operator environment and 40 headed reference repetitions after integration                                                                                                                                                                              |

## Primary review and delegation

Sol medium implemented core counters and their fixtures. Terra medium implemented pure profiles/metrics and the initial CLI/browser/record changes. Primary retained host integration, shared data contracts, record integration, evidence and acceptance. Aggregation was escalated to Sol medium when Primary found that the draft trusted stored metrics, could miss whole groups and could promote functional observations. No worker delegated further.

Primary required independent CPU-versus-upload assertions, preserved preparation deltas in `finally`, prevented terminal callbacks from doing unobserved renderer work, retained asynchronous errors outside a frame and bounded post-window queue draining. Primary removed a fabricated fallback command, string-prefix-based integrity control and duplicated environment/window definitions. Sol's revised aggregation uses exact repetition IDs, recomputes raw percentiles, validates complete source boundaries and keeps A05 geometry disposition independent of a valid A08 numeric failure. Missing provenance or malformed input cannot produce a candidate. Tests and native runs cover the resulting structure; synthetic reference tests are not hardware evidence.

## Remaining work

Run B05 only with fresh reference metadata and unobscured headed browsers. Publish immutable criterion-specific results and review each unchanged threshold before accepting A05/A08. A09/A10 methodology and full P1 acceptance remain open. Independently planned P2 may proceed under D6 after its own contract/validation freeze and any required tool-acquisition decision.
