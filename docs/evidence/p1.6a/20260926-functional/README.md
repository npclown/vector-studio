# P1.6a functional runner review

Status: P1.6a local checkpoint complete under approved [D5](../../../plans/p1-instanced-primitives.md#d5-approved-p16a-runner-entry-exception-2026-09-26). **These are functional observations, not P1 performance acceptance. A05/A08/A09/A10 remain unverified by this runner.** Required PR checks and integration are separate gates.

## Scope and source

Started from clean fetched `main` at `941e4487684cc561f9e6eb683fa004c102314d2f` (P1.5 PR #35), branch `codex/p1-6a-workload-runner`. The [runner contract](../../../plans/p1-runner-contract.md) froze acceptance before implementation. Product packages, public APIs, dependencies and benchmark thresholds are unchanged. New code belongs to the playground, tests and tooling.

Final raw records identify the dirty pre-commit source with per-file SHA-256 values and common manifest `cd83ecf6206139615dda73b6885728b93612ac3f6657d8959ecca847809ef240`. The configuration canonical SHA-256 is `7b47f79fb1a68f4d785b1a39ee3b7606b95b13104bd3cfe25a32e618fb0d673a`. Source equality is checked before/after each capture. Subsequent documentation, ignore rules and evidence packaging do not alter measured application/test/configuration files.

## Validation

- `pnpm check` — PASS: format, ESLint, TypeScript, 221 tests in 30 files, package boundaries. The 38 new tests cover workload literals and independent visibility bounds, interval/window/error invariants, CLI guards and evidence integrity.
- `pnpm test:browser` — PASS: 20 tests, final single-worker configuration, Chrome and Edge. Includes the existing 12 P0 regressions plus eight P1.6a cases.
- `pnpm benchmark:p1 --profile functional --output-dir artifacts/p1.6a/20260926-final-functional` — PASS: production build (all libraries, 42 playground modules) and eight serial headless native cases. Each case preserves three warm-up and five observed callbacks, yielding four diagnostic intervals.
- CLI fixtures reject missing/reference/acceptance/unknown profiles, duplicate arguments and unsafe/existing output directories. A subprocess sentinel proves rejection occurs before build launch. Record fixtures reject source drift, mutated summaries, false acceptance promotion and overwrite; failed observations remain `FUNCTIONAL_FAIL`.
- Final integrity review — PASS: eight byte-exact record copies, 904 recorded source-file hash comparisons, 77 local links/anchors across seven changed Markdown files, explicit Markdown formatting and `git diff --check`. The existing detached P1.3 checkout is still clean.
- P1.5 headed corpus, reference benchmark and A09/A10 acquisition — NOT RUN: outside D5. Product/oracle code is unchanged; this checkpoint makes no new visual or performance acceptance claim.

## Native observations

Environment: Windows 11 Pro `10.0.26200`, AMD Ryzen 7 3700X (16 logical cores), 34,291,060,736 installed bytes; adapter reports NVIDIA / Turing (empty description). Browser versions: Chrome `153.0.8010.53`, Edge `154.0.4258.37`. Both launch headless with `--enable-unsafe-webgpu`; surface 1280x720, DPR 1, native 4x. Full exposed limits are in every record. Refresh, power, background activity and driver are explicitly unobserved for this functional scope.

| Scenario                | Chrome record                                 | Edge record                                 | Observed instances per callback |
| ----------------------- | --------------------------------------------- | ------------------------------------------- | ------------------------------- |
| S1 pan/zoom 1k          | [raw](chrome-p1-pan-zoom-1k-v1.json)          | [raw](edge-p1-pan-zoom-1k-v1.json)          | 1000                            |
| S2 pan/zoom 10k         | [raw](chrome-p1-pan-zoom-10k-v1.json)         | [raw](edge-p1-pan-zoom-10k-v1.json)         | 10000                           |
| S3 cull 10k             | [raw](chrome-p1-cull-10k-v1.json)             | [raw](edge-p1-cull-10k-v1.json)             | 1032                            |
| S4 single transform 10k | [raw](chrome-p1-single-transform-10k-v1.json) | [raw](edge-p1-single-transform-10k-v1.json) | 1032                            |

All eight cases have one packet and one native submission per measured callback, no hidden/error callbacks, zero warmed native pipeline/shader creation calls and maximum one outstanding RAF request. Disposal leaves zero tracked resources/bytes, device/diagnostic listeners and pending callbacks. S3 has no warmed native writes. S4 writes only the target transform at resource offset 0, 32 bytes; S1/S2 update only camera frame/transform resources. This does not observe CPU geometry rebuilds or prove physical display presentation. Descriptor accounting is not a simultaneous CPU/GPU memory measurement.

## Primary review and attempts

Terra medium implemented the pure workload and independent bounds/CLI fixtures. Sol medium implemented the numeric summary and record mutation fixtures, then reviewed the host read-only. Primary owned the single RAF/native observation integration, record writer, command and final review. No recursive delegation.

Primary review corrected an initially tautological visibility test with an independent guarded-bounds calculation across six phases. It also replaced backend installation counters with interception of actual native pipeline/shader creation calls, and replaced an in-callback pending count with request/fire/cancel tracking. Native device/context proxy forwarding and browser `window` shadowing were fixed before the first functional run.

The first exploratory run preserved two failed records (Chrome/Edge S1; six cases did not run): the host called the wrong queue-wait method and the page requested a missing favicon. Both causes were corrected; errors were not filtered. A subsequent scoped dev run passed eight cases. An initial production run passed eight; an initial full browser run passed 20 with the repository's old four-worker setting. The final configuration serializes browser hardware work and was revalidated with 20 browser tests and eight production functional cases. All local records, including failures and intermediate runs, are preserved in [all-attempts.zip](all-attempts.zip), SHA-256 `61da7e6b474b88524add1754c17d253674b208b2c9c76eb3aa28050a0801b0ba`.

Early development records used the then-default `pnpm test:browser` command label even for the scoped invocation `pnpm exec playwright test --config playwright.config.ts tests/browser/p1-runner.spec.ts --workers 1`; these intermediate records are not final evidence. Final records preserve the exact CLI invocation. The old detached P1.3 checkout and P1.5 artifacts were not used as output or cleanup destinations.

## Remaining gate

P1.6a proves functional workload/observation/record plumbing only. Full P1.6 requires prospective A09 simultaneous-memory and A10 input/content/physical-presentation methods. P1.7 and P2 remain blocked. Next work is P1.0m method resolution; any external acquisition or acceptance-semantic change needs its own concrete decision.
