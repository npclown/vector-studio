# V-35 A05 to A07: the blend pixels on the reference PC

Contract: [viz-v35-fills-blend-contract.md](../../plans/viz-v35-fills-blend-contract.md), V35-A05 (as amended in U6), the capture part of A06, A07 and K4. The spec is `tests/gpu/v35-blend.spec.ts`, and the CPU oracle is `tests/support/v35-blend-oracle.ts`. Both are the ones U4 ran on SwiftShader.

## Runs

The runs used the reference PC with a GTX 1660 SUPER (`nvidia/turing`), headed Chrome and Edge (`pnpm test:gpu tests/gpu/v35-blend.spec.ts`, then the same with `VS_GPU_EDGE=1 --project edge`), after `pnpm build`.

| Run | Commit | Chrome | Edge | Records |
| --- | --- | --- | --- | --- |
| 1 | `d8fd617` | 13 of 15 (with `e41-effects`; both A05 tests failed) | 13 of 15 (same) | [a05-d8fd617/](a05-d8fd617/) |
| 2 | `53f438a` (#595, the A05 amendment) | 7 of 7 | 7 of 7 | [a05-53f438a/](a05-53f438a/) |

## Run 1: the colorBurn miss

Both browsers failed at 1x and at 4x with the same pixels. Only three cases missed, all in **colorBurn**, by 3/255 against a tolerance of 2:

| Case | Pixel | GPU | Oracle |
| --- | --- | --- | --- |
| main target | [208, 16] | 183, 16, 10 | 186, 16, 10 |
| clip | [206, 30] | 183, 16, 10 | 186, 16, 10 |
| R3 and R4 | [90, 280] | 27, 73, 54 | 27, 76, 53 |

The over-tolerance pixels fill uniform regions: 664 on the main target, 280 under the clip, and 1056 in R3/R4. Every other case was within 2/255: normal control, E25 layer, effect root, effect root past the target, and mask. A06, the A07 edits, K4 and E41-A05 to A09 passed in both browsers.

The cause is the stored 8-bit backdrop, not the blend composite:

- On the main target and the clip, the band colour 0.9 is a rounding tie (229.5). The oracle and SwiftShader store 230. The oracle with a stored 229 gives the GPU's 183 exactly, so the reference PC stored 229. That is inferred: the backdrop was not read back.
- In R3/R4, colorBurn sits over a normal composite (yellow at α 0.6 over the band) whose green is 175.75 or 176.15, depending on how the band's own tie (76.5) rounds. Both round to 176. The GPU's 73 matches a stored 175, so the reference PC stored this non-tie value one step low. That is also inferred. The cause is unverified; blend precision is suspected.
- colorBurn's slope multiplies one backdrop step by about 2.3 to 2.8 here, which turns one step into 3/255.

## The amendment (U6, #595, 추천안 자동 채택 2026-11-12)

The oracle now records `slack` for each blend composite: the largest change of its result when the stored backdrop moves one step, carried through later composites by their (1 − αs). A pixel passes within `2 + max(0, slack − 1)`/255. Over the A05 fixtures, this is what each mode gets:

- multiply, screen, darken, lighten, hardLight, difference, exclusion, saturation and luminosity keep 2/255.
- softLight, color, overlay and hue get up to about 0.3 to 1.3/255 more.
- colorBurn gets about 1.8 more, and colorDodge about 4 more.

Two reviews checked the model: round 1 READY WITH FOLLOW-UPS, which led to backdrop-only slack and kept K4 strict; round 2 READY. The model is first order and errs strict where it simplifies. On SwiftShader the amended spec passes 7 of 7, with worst values unchanged (2/255 at most).

## Run 2: results

Every A05 case passes in both browsers at 1x and 4x, with `failures` empty. Each value below is the worst channel difference in 1/255, and the slack at that pixel is in parentheses. Chrome and Edge are identical.

| Case | 1x | 4x |
| --- | --- | --- |
| normal control | 1 | 1 |
| main target (capture, tile 64, production usage) | 3 (2.76) | 3 (2.76) |
| E25 layer | 2 (0.57) | 2 (0.57) |
| effect root | 1 | 1 |
| effect root past the target | 1 | 1 |
| clip | 3 (2.76) | 3 (2.76) |
| mask | 1 | 1 |
| R3 and R4 (capture, tile 64, production usage) | 3 (2.27) | 3 (2.27) |

The tightest pixel is R3/R4 [90, 280]: it is allowed 3.27 and differs by 3, a margin of about 0.27/255.

- **A06.** The bytes are identical without a blend root, with no split, at 1x and 4x.
- **A07.** Eight mode, opacity and paint edits cost 0 port calls and 0 geometry builds. Splits per frame equal the packet's tile passes.
- **K4 stencil.** Across a split, the worst difference is 0 away from the root and 1 under it. That is 1 split per frame in the main pass, and 12 in 64 px tiles at 4x.
