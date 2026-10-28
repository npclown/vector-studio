# V-4 A08 metrics record (5ddec4e)

Contract: `docs/plans/viz-v4-a08-corpus-contract.md`. Record `viz-v4-metrics/v2`, body SHA-256 `e8df19b25118ecf3ea852a9bbbbc0d83eb62ef85b27c192a97f1723ab109d823`.

- Result: **INCONCLUSIVE** (section 5.3 verdict: INCONCLUSIVE; gated case UNDECIDED)
- VZ4-A3: PASS
- VZ4-A4: PASS
- VZ4-A5: PASS
- VZ4-A6: UNDECIDED
- VZ4-A7: UNDECIDED
- Browsers: chrome, edge
- Failing gated cases: 0; undecided: 372; deviations from the expected list: 0; flagged RENDERER-FAILED or port-empty: 0
- Run: `artifacts/viz-v4-a08/2026-10-26T07-14-20-504Z-21328`; WASM `.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm` (`58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35`); expected list `tests/visual/viz-v4/a08-expected-status.json`

## Replay

`pnpm coverage:viz-v4 --replay <this directory>` re-evaluates the inputs and requires a byte-identical record.json (VZ4-A9).
