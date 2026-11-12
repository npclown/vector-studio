# V-36 U3 on the reference PC (headed)

Contract: [V-36](../../plans/viz-v36-inner-shadow-background-blur-contract.md), V36-A04 (both halves), A05 to A07 on a real GPU, ahead of U4's formal headed record.

- Date: 2026-11-12. Reference PC, NVIDIA Turing (`nvidia/turing`), headed Chrome 157.0.8103.51 (GPU spec) and Chrome 157.0.8103.51 / Edge 157.0.4341.46 (studio specs). Tree: branch `claude/viz-v36-u3-background-blur` at 8d33040 (main 6f94aa2 plus U3); `pnpm install`, `pnpm build` passed.
- `pnpm test:gpu -g "E41|V36"`: 12/12 passed (7.3 min). Run directory on the PC `artifacts/e41-effects/2026-11-12T20-09-34-837Z-18228` (in the project Library as `v36-u3-gpu.zip`).
- `pnpm test:e41-next-host`: 6/6. `pnpm test:v35-next-host`: 6/6.

## Background blur against the CPU oracle (worst channel difference, /255, 1x and 4x alike; no pixel over 3)

| Fixture | Worst | Tolerance | Changed pixels vs σ 0 |
| --- | --- | --- | --- |
| G5 | 0.81 | 3 | 21,601 |
| G6 | 0.81 | 3 | 7,701 |
| G7 (downsampled, clamp) | 0.91 | 6 | |
| G9 | 1.22 | 3 | |

`backgroundBlurSkipped` 0 on every fixture.

## Inner shadow and E41 on the same pages

G1 1.06, G2 1.83, G3 2.07, G4 1.87, G8 0.89 (tolerance 3); E41's sixteen fixtures at most 1.94/255 (tolerance 3, downsampled 6), at 1x and 4x.

## A05 to A07

- E41-A06 (`'none'`, `'v0'`, `'v1'`) and V36-A05 (`'v0'` against `'v1'`): identical. The digest test ran and wrote its report; its digests are this device's, so the before-and-after-re-pin comparison stays the SwiftShader one ([u2-swiftshader.md](u2-swiftshader.md)).
- V36-A06: the nested background blur drew without its blur and was counted.
- E41-A07 and V36-A07 (inner-shadow and background-blur edits): 0 port calls and 0 geometry builds.
