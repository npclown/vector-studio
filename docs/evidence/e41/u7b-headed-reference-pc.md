# E41 U7b: the oracle and identity checks on the reference PC

Contract: [d9-e41-boolean-effects-contract.md](../../plans/d9-e41-boolean-effects-contract.md), E41-A05 and the capture part of E41-A06. The spec and fixtures are the same as in [u7b-swiftshader.md](u7b-swiftshader.md). This run is the headed run on the reference PC, which is the evidence for A05.

## Run

- Commit 93b2128 (main after #562). Reference PC with an NVIDIA Turing GPU (`nvidia/turing`), headed Chrome.
- `pnpm build`, then `pnpm test:gpu -g E41`. The build passed without cleaning first, which confirms the U7b `export-image.ts` typecheck fix.
- Run directory on the PC: `artifacts/e41-effects/2026-11-10T03-45-32-549Z-23960` (`a05-1x.json`, `a05-4x.json`, `a06.json`).
- Result: 3 of 3 tests passed. No error diagnostics. No pixel over 3/255 in any fixture (`over3` = 0 everywhere).

## A05: the effect passes against the CPU oracle

Each value is the worst channel difference, in 1/255.

| Fixture | Tolerance | Worst at 1x | Worst at 4x |
| --- | --- | --- | --- |
| leaf shadow | 3 | 0.98 | 0.98 |
| translucent leaf, two shadows, fractional offsets | 3 | 1.94 | 1.94 |
| container shadow and layer blur | 3 | 1.40 | 1.40 |
| downsampled shadow and blur | 6 | 1.92 | 1.92 |
| sharp shadow | 3 | 0.86 | 0.86 |
| caster past the left edge | 3 | 0.98 | 0.98 |
| container past the top, nested isolated, layer blur | 3 | 1.69 | 1.69 |
| F6 shadow past a clipping frame | 3 | 0.94 | 0.94 |
| F11 shadowed child of a mask group | 3 | 0.84 | 0.84 |
| F12 mask group in a shadowed group in a clipping frame | 3 | 0.91 | 0.91 |
| F2 rectangle rotated 30 degrees | 3 | 0.79 | 0.79 |
| F7 shadow on text | 3 | 1.12 | 1.12 |
| mesh path past the right edge, shifted pass | 3 | 1.49 | 1.42 |
| joint draw, gradient and inner clip, shifted pass | 3 | 0.95 | 0.95 |
| stencil-pass clip composite | 3 | 0.91 | 1.00 |
| F9 zoom 8, sigma 160 px | 6 | 0.81 | 0.81 |

## A06: scenes without effects draw identically

Each of the 16 fixtures was drawn with its effects removed, once with `effects=v0` and once without. Both renders were byte-identical at 1 and 4 samples, in all 32 cases, with `effectPasses` = 0.

## Verdict

E41-A05 passes on the reference PC. The capture part of E41-A06 passes on the reference PC. The bench part of A06 (no regression in earlier bench baselines) is U7c's.
