# E41 U5b: effect layers past the target on a software GPU

Contract: [d9-e41-boolean-effects-contract.md](../../plans/d9-e41-boolean-effects-contract.md), sections 5.2 (K2, K2c) and 12, "U5b amendments". Same method and command as [u5a-swiftshader.md](u5a-swiftshader.md), with two fixtures added for an off-target caster (F10).

## Method

- The same spec: [tests/gpu/e41-effects.spec.ts](../../../tests/gpu/e41-effects.spec.ts), headless Chromium on SwiftShader, at 1x and 4x.
- Two fixtures whose content reaches past the 512 × 320 target:
  - `caster past the left edge`: a rectangle from x −70 to 10, with a shadow offset by 90 px (σ 6). Most of the shadow on the target comes from the part of the caster past it.
  - `container past the top edge`: a container from y −60 to 16, holding a rectangle and an isolated group at opacity 0.5 (an E25 layer inside the effect root), with a shadow offset by 46 px (σ 8) and a layer blur σ 4.
- The oracle needs `L` past the target too. The content page renders each fixture with a camera that moves the scene by a whole number of pixels (120 px right, or 120 px down), so all of `L` is on that capture, and places it back at its own pixels. Rendering is translation invariant for whole-pixel moves at DPR 1, so this is `L` as the effect frame draws it.
- The capture's white backdrop now reaches 200 px past the target on every side, so its edges stay off every capture at either camera.

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

The worst value is over black and over white together. 1x and 4x give the same figures. The packet's layers for the two new fixtures start at x −72 and y −62, and the nested group's layer at y −52, so they are drawn past the target.

With the backend flag turned off (the source then clamps the bounds as in U4b), the left-edge fixture fails with a worst difference of 127.5/255: the shadow of the caster's off-target part is missing. So the fixture detects the clamp.

**E41-A06 capture part.** All seven scenes, with their effects removed, are byte-identical under `effects: 'v0'` and without it, at 1x and 4x: 14 frames, 0 mismatches.

## Unit coverage

- `tests/unit/e41-u5b-shifted-variants.test.ts`:
  - each shifted module maps vertices through the tile and shifts every fragment position read;
  - with the vertex rewrite undone, the analytic clip and mesh variants equal E25's layer variants character for character;
  - the rewrite refuses a module it cannot shift;
  - the keys differ from E25's.
- `tests/unit/e41-u5-effect-scene.test.ts`:
  - the shifted set's modules and pipelines with every path (11 and 47), its failure, the tile viewport, the shifted plain analytic pipeline and the pass record of a root past the target;
  - `R` inside the target in the main pass;
  - a layer past the target outside any effect root, or without the effect pipeline, is refused.
- `tests/unit/e41-u4b-effect-plan.test.ts`: with `offTargetEffectLayers`, the root's bound is its source bound and a nested E25 layer is bounded by it, past the target; a layer outside every effect root, and a root holding a mask group, stay inside it.
- `tests/unit/e41-u5-effect-passes.test.ts`: the CPU twin of the passes matches the oracle at 1e-9 with `L` and `R` past the target's top-left corner, at one and two downsample levels.
