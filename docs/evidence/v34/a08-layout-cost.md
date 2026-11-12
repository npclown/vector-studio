# V34-A08 layout cost (2026-11-12)

Contract: [viz-v34-auto-layout-contract.md](../../plans/viz-v34-auto-layout-contract.md), V34-A08.

**Result: PASS.** Both medians are inside their bounds on every run.

| Run | 1,000 participants (100 fill), `layoutFrame` median of 5 | 10-deep hug nest, one `setFrames` command median of 5 |
| --- | ---: | ---: |
| 1 | 1.146 ms | 0.506 ms |
| 2 | 1.036 ms | 0.454 ms |
| 3 | 1.049 ms | 0.445 ms |
| Bound | ≤ 5 ms | ≤ 1 ms |

- Command: `npx vitest run tests/unit/v34-u2-auto-layout.test.ts -t A08 --reporter=verbose`, three runs, nothing else running.
- Machine: the cloud container (x86_64, 4 cores, Node 22.23.4). Source: the commit on `claude/viz-v34-u2-auto-layout` that adds this record (U2 and U3 on the v8 scaffold, after the review fixes).
- The test asserts the bounds only outside CI (`process.env.CI` unset), so this container record is the A08 evidence. The Windows CI runners only log the numbers, so a slow shared runner cannot fail an unrelated change.
- Under a parallel full suite on the same container, an earlier draft measured a median of 5.8 ms. Building the box from the frame at rotation 0 (instead of `rotatedBounds`), a `Set` for the fill participants and one reduce for the maximum brought it to the numbers above, and the full suite no longer exceeds the bound.
