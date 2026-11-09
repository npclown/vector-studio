# E41 U5a: effect passes on a software GPU

Contract: [d9-e41-boolean-effects-contract.md](../../plans/d9-e41-boolean-effects-contract.md), sections 5.1 and 5.2 (K4, K5) and section 12, "U5a amendments". This is the software check of E41-A05 and the capture part of E41-A06. The headed reference-PC run is U7's.

## Method

- Browser: Playwright Chromium at `/opt/pw-browsers/chromium`, headless, with the SwiftShader flags of [../e23/u3-swiftshader.md](../e23/u3-swiftshader.md). With `--use-webgpu-adapter=swiftshader` alone, this container's Chromium lost the device on the first frame, on `main` as well. Adapter `{ vendor: google, architecture: swiftshader }`.
- Geometry kernel WASM built with `cargo build --release --target wasm32-unknown-unknown`, served through `VECTOR_STUDIO_GEOMETRY_WASM`.
- Command: `E41_CHROMIUM=/opt/pw-browsers/chromium VECTOR_STUDIO_GEOMETRY_WASM=<wasm> pnpm test:e41-swiftshader`, which runs [tests/gpu/e41-effects.spec.ts](../../../tests/gpu/e41-effects.spec.ts) through `playwright.e41-swiftshader.config.ts`.
- Page: the E23 check page with `groups=isolated&effects=v0`, DPR 1, at 1x and 4x. The oracle reads `L` back on a second page with `effectcontent=1` (the backend's `effectContentForTesting`), over the page's opaque black and over a white backdrop, which gives `L`'s alpha. [tests/support/e41-effect-oracle.ts](../../../tests/support/e41-effect-oracle.ts) applies section 5.1 with K4 to `L` in binary64. Each effect frame is compared over black and over white.
- Fixtures:
  - `leaf shadow`: one shadow, σ 6.
  - `translucent leaf`: an ellipse at opacity 0.6 with two shadows, one at a fractional offset.
  - `container`: two overlapping leaves with a shadow and a layer blur σ 3.
  - `downsampled`: a shadow with σ 30 (two levels) and a layer blur with σ 14 (one level).
  - `sharp shadow`: σ 0 at a fractional offset.

## Results

| Fixture | Tolerance | Worst over black | Worst over white | Pixels changed by the effects |
| --- | --- | --- | --- | --- |
| leaf shadow | 3 | 0 | 0.90 | 2,398 |
| translucent leaf, two shadows | 3 | 1.11 | 1.46 | 3,254 |
| container, shadow and layer blur | 3 | 0.88 | 1.40 | 7,911 |
| downsampled shadow and blur | 6 | 1.31 | 2.00 | 20,167 |
| sharp shadow | 3 | 0.68 | 0.86 | 569 |

The values are the largest channel difference in 1/255, over every pixel of the 512 × 320 frame. 1x and 4x give the same figures: every fixture edge is either pixel-aligned or drawn with analytic coverage. "Pixels changed" counts pixels over white that differ from `L` alone by more than 8/255, so a frame without its effects fails the test. `effectPasses` rose by one per effect frame, and stayed 0 under the hook. No diagnostic of severity `error` was raised.

**E41-A06 capture part.** The same five scenes, with their effects removed, are byte-identical under `effects: 'v0'` and without it, at 1x and 4x: 10 frames, 0 mismatches, `effectPasses` 0.

## Unit coverage

- `tests/unit/e41-u5-effect-passes.test.ts` runs the pass plan through a CPU twin of the module's fragment stages and compares it with the oracle. The tolerance is 1e-9, including content wider than `R`, fractional offsets, leaf content opacity and one or two downsample levels. Each of four tried mutations that shrinks a planned region by one texel fails it.
- `tests/unit/e41-u5-effect-scene.test.ts` covers the fake-device seams:
  - pipeline creation and its failure;
  - the passes between the layer pass and the composite, with their records;
  - `R` bound at the composite;
  - transient textures released after submission (A09 unit part);
  - the hook and the unavailable pipeline;
  - an empty output;
  - invalid records;
  - the service and target wiring.
