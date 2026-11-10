# E41 U5c: effect roots under clips and masks on a software GPU

Contract: [d9-e41-boolean-effects-contract.md](../../plans/d9-e41-boolean-effects-contract.md), sections 5.1 (step 4), 5.2 (K2b, K5) and 12, "U5c amendments". Same method and command as [u5b-swiftshader.md](u5b-swiftshader.md), with three fixtures for roots under an ancestor clip or mask (F6, F11, F12).

## Method

- The same spec: [tests/gpu/e41-effects.spec.ts](../../../tests/gpu/e41-effects.spec.ts), headless Chromium on SwiftShader, at 1x and 4x.
- Three fixtures:
  - `F6 shadow past a clipping frame`: a rectangle in a frame clipped to [40, 150, 200, 100], shadow offset (40, 20), σ 5. The shadow reaches past the frame's right and bottom edges.
  - `F11 shadowed child of a mask group`: an ellipse in a mask group whose source is the rectangle [260, 40, 180, 140], shadow offset (30, 25), σ 6.
  - `F12 mask group in a shadowed group in a clipping frame`: a frame clipped to [20, 20, 260, 130] holding a group with a shadow (25, 30), σ 4, which holds a mask group (source [60, 40, 150, 90], content an ellipse past it).
- The oracle builds `R` from the root's unclipped `L` and applies the ancestors' clip once. The content page captures `L` from the same scene without that clip (for F11, the root without its mask group; for F12, the mask group stays, since it is inside the root). The clip edges lie on whole pixels, so its coverage is 0 or 1 and the expected frame is `R` zeroed outside the rect.

## Results

| Fixture | Tolerance | Worst (1/255) | Pixels changed by the effects |
| --- | --- | --- | --- |
| leaf shadow | 3 | 0.90 | 2,398 |
| translucent leaf, two shadows | 3 | 1.46 | 3,254 |
| container, shadow and layer blur | 3 | 1.40 | 7,911 |
| downsampled shadow and blur | 6 | 2.00 | 20,167 |
| sharp shadow | 3 | 0.86 | 569 |
| caster past the left edge | 3 | 1.00 | 9,240 |
| container past the top edge, nested layer, layer blur | 3 | 1.63 | 15,304 |
| F6 shadow past a clipping frame | 3 | 0.96 | 4,306 |
| F11 shadowed child of a mask group | 3 | 0.83 | 4,603 |
| F12 mask group in a shadowed group in a clipping frame | 3 | 0.87 | 6,038 |

The worst value is over black and over white together. 1x and 4x give the same figures.

With rebasing turned off in the source (draws keep their full chains and composites are unclipped, as before U5c), F6 fails at pixel (240, 184), just past the frame's right edge, where the shadow of the clipped content is drawn unclipped. So the fixture detects a missing composite clip.

**E41-A06 capture part.** All ten scenes, with their effects removed, are byte-identical under `effects: 'v0'` and without it, at 1x and 4x: 20 frames, 0 mismatches.

## Unit coverage

- `tests/unit/e41-u5c-clip-chains.test.ts`:
  - `rebaseClipChain` drops the root's ancestor levels, renames the mask levels left, keeps one object per chain and root, returns the chain under an unclipped root and null for the root's own chain, and refuses a chain that does not extend the root's;
  - in the packet: F6, a container root's own clip kept in `L`, F11, F12 (the rebased mask level, with no parent and no rect above the root), a root inside a root, an E25 layer inside a root bounded past the root's ancestor clip, a root under an over-budget mask level (no content, an unclipped composite, every state naming a planned level), the mask plan kept across frames, unclipped E25 composites, and draws outside every root keeping their chains.
- `tests/unit/e41-u5-effect-scene.test.ts`:
  - the clip variants' modules and pipelines (13 modules and 49 pipelines with every path);
  - a root inside a root under two clipping frames: the inner composite uses the shifted clip variant, the outer one the main-pass clip variant, each with its state's clip group offset;
  - a clip state on an E25 layer's composite, or a missing state, is refused.
