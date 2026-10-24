# E10-A7 headed run of the renderer test hooks (2026-10-24)

Contract: [d9-e10-renderer-test-hooks-contract.md](../../plans/d9-e10-renderer-test-hooks-contract.md), criterion E10-A7, unit E10-U3. This is functional evidence only. Precision stays UNVERIFIED against the 0.25 physical-pixel target, and no Q4 threshold is claimed.

## Run

- **Code:** PR #228 head `1be1945` (`origin/claude/project-thread-uhlsgk`). It ran in a separate, detached worktree on the user's PC, with no source or spec change.
- **Setup:** `pnpm install --frozen-lockfile`, then `tsc --build` for contracts, renderer-core, renderer-webgpu and geometry-wasm. The playground imports package `dist`, and the config serves it with the Vite dev server on port 4175.
- **Command:** `pnpm exec playwright test -c playwright.gpu.config.ts tests/gpu/e10-test-hooks.spec.ts`
- **Result:** `12 passed (1.3m)`, with no failures and no retries.

## Environment

| Item     | Value                                                                 |
| -------- | --------------------------------------------------------------------- |
| OS       | Windows 11 Pro 10.0.26200                                             |
| GPU      | NVIDIA GeForce GTX 1660 SUPER, driver 32.0.16.1088                    |
| Adapter  | vendor `nvidia`, architecture `turing`, description empty (both runs) |
| Chrome   | 155.0.8059.85, headed, `--enable-unsafe-webgpu`                       |
| Edge     | 156.0.4314.42, headed, `--enable-unsafe-webgpu`                       |
| Viewport | 96 x 48 physical pixels; DPR is the backend input (`dprSource`)       |

## Outcomes

Each project ran forced 1x and 4x, at DPR 1, 1.5 and 2, each with the fringe on and with it off. The 12 test results are in `chrome/` and `edge/`, one record per sample count and DPR. In every record, every control's failure list is empty.

| Control                          | Keys                                                | Result                         |
| -------------------------------- | --------------------------------------------------- | ------------------------------ |
| (a) axis-aligned rectangle       | `a-rect`                                            | PASS, all 24 runs              |
| (b) fringe-off and analytic      | `b-no-exterior`, `b-msaa-steps`, `b-analytic`       | PASS                           |
| (c) zero counts are black        | `c-rect`, `c-triangle`, `c-doubled`                 | PASS                           |
| (d) doubled rectangle counts 2   | `d-doubled`                                         | PASS                           |
| (e) empty scene opaque black     | `e-empty`                                           | PASS                           |
| (f) forced sample count reported | `f-sample-count`                                    | PASS                           |
| (g) R matches covered samples    | `g-sample-match`                                    | PASS, 4x with the fringe off   |
| (h) one frame, one prepare       | `h-matching-{empty,rect,triangle,doubled}`          | PASS                           |
| Page errors                      | `page-errors`                                       | none                           |

The spec wrote the raw records to `.tools/e10-test-hooks/2026-10-24T04-44-31-750Z-15868/chrome/` and `.tools/e10-test-hooks/2026-10-24T04-45-06-440Z-4312/edge/` on the user's PC. The JSON files here were transcribed from them with the same content, pretty-printed.

## Limits

- Only one adapter was tested: NVIDIA Turing on Windows. No other vendor or OS was run.
- The scenes are the spec's fixed rectangle and triangle, drawn with the static convex-fan fill double. The product geometry kernel was not used.
