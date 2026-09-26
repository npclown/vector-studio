# P2.4 independent native/browser differential — 2026-09-26

Disposition: local P2.4 PASS, pending required CI and protected PR integration. Validated sources are the checkpoint worktree on `codex/p2-4-differential`, based on P2.3 integration `cb7ac56`; this directory and the subsequently committed checkpoint identify the implementation. This is CPU/WASM correctness evidence, not a benchmark, GPU result or full P2/P1 gate.

## Targets and observations

Each target verified all 10,034 cases independently against the unchanged TypeScript oracle: 10,000 seeded corpus cases, 12 named cubics, 10 packed cases, three metamorphic cases, one subdivision case and eight edge cases. Ordinary corpus cases all succeeded. Expected invalid envelope/path/numeric failures were checked explicitly; they were not counted as successful geometry. All 12 verifier positive controls were rejected in every target.

| Target                                              | Observation                                 | Record                     |
| --------------------------------------------------- | ------------------------------------------- | -------------------------- |
| Native Rust 1.94.1, x86_64-pc-windows-msvc, release | 10,034 cases; one exact-size capacity retry | [native.json](native.json) |
| Installed Google Chrome 153.0.8010.53, headless     | 10,034 cases; 26 exact-size retries         | [chrome.json](chrome.json) |
| Installed Microsoft Edge 154.0.4258.37, headless    | 10,034 cases; 26 exact-size retries         | [edge.json](edge.json)     |

The release WASM SHA-256 is `861762ca8d5e48d6cc5c602e82ef98652b9d7fa326068a0756d4e301497d25cc`, unchanged from P2.2/P2.3. Two independent output-directory builds matched; each browser checked the actual fetched bytes against that hash before instantiation. Node 24.15.0, pnpm 11.1.2, Windows x64 and the previously approved pinned Rust toolchain were used. Native test builds use the actual Engine with the same crate release profile; the bridge is compiled only under cfg(test).

The native transport starts with 256 KiB output capacity; browser transport starts at zero. Their different retry counts are expected transport coverage, not a performance comparison. Neither identical subdivision counts nor identical timing is an acceptance condition. Both browser observations emitted 5,235,781 LINE commands across successful paths; the independent bounds and continuous-error predicates determined correctness.

## Commands and reproducibility

- `pnpm check` — PASS: formatting, ESLint, TypeScript, 284 unit tests in 38 files, dependency boundaries.
- `pnpm build` — PASS: five TypeScript libraries and playground (43 modules).
- `pnpm test:geometry` — PASS: rustfmt, Clippy, 25 native unit tests, two identical WASM release builds and 24 integration tests in three files. The file-driven bridge is marked ignored in ordinary cargo test and then explicitly invoked with exact test selection by the native differential test; missing input/toolchain/output or zero verified cases fails.
- `pnpm test:geometry:browser` — PASS on final sources: repeats the complete geometry validation above, then runs two serial installed-browser tests. Each browser independently validates all 10,034 cases and 12 positive controls. No test skips or retries were used.
- Explicit changed-Markdown Prettier, local link/anchor checks and `git diff --check` — required before the checkpoint PR; exact final results are recorded there.

The root browser command rebuilds from current sources instead of reusing an unchecked artifact. Native inputs/outputs and logs remain in fresh ignored `.tools/geometry-native-*` directories; the committed native summary is from `.tools/geometry-native-NRMwLa`. Browser summaries are copied without changing their observations from Playwright output. The fixture page is a separate test composition served by Vite, using the release WASM artifact; it is not a production benchmark page. Browser failures write structured records including fixture details and retain traces. Reproduce from the checkpoint with the approved toolchain installed and stable Chrome/Edge available.

## Review and boundaries

One GPT-5.6 Sol medium worker owned shared differential composition and browser fixtures/configuration. Primary owned the native bridge, root command wiring, validation policy/plan updates and final review. No recursive delegation. The production adapter, numerical kernel, independent oracle, raw ABI, public contracts and external dependencies are unchanged. The only existing Rust source edit includes a cfg(test)-only bridge module.

Primary review corrected the following before final verification:

- Validate the entire MOVE/LINE/CLOSE stream, source association, copied endpoints and consumed point ranges, rather than only filtering cubic lines.
- Check bounds containment and tightness with the frozen allowances; use each successful path's coordinate scale so invalid/nonfinite neighbors cannot alter it.
- Derive zero/rank-one/zoom-boundary tolerances from the existing independent screen-tolerance contract.
- Establish a valid analytic baseline before injecting verifier corruptions; retain malformed intervals, provenance and bounds positive controls.
- Separate Vite and Playwright configuration, verify pointer/capacity stability across process, dispose after setup failures and retain detailed failure artifacts.
- Exercise exact output retry above 256 KiB using two copies of the frozen maximum-leaf corpus case. Native framing rejects missing/empty/truncated/over-cap files and preserves preexisting output.

No remaining P2.4 blocker was found. Continuous verification retains the private contract's conservative Float64 bound and finite verifier budget; it is not a formal IEEE interval proof. A02/A03/A07 now have native and browser differential evidence in addition to earlier unit/kernel evidence. A08 still requires P2.5/P2.6 production benchmark work and valid reference environment observations. P1 A09/A10, full P1 acceptance and P3-P5 authorization remain unchanged.
