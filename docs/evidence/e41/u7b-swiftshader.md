# E41 U7b: the remaining oracle fixtures on a software GPU

Contract: [d9-e41-boolean-effects-contract.md](../../plans/d9-e41-boolean-effects-contract.md), sections 5.1, 5.2, 8 and 12, "U7b amendments". It uses the same spec and command as [u5c-swiftshader.md](u5c-swiftshader.md). The fixtures added are the ones U5b and U5c left to U7: rotation (F2), text (F7), a mesh path in a shifted pass, a clipped composite in a stencil pass, and F9's downsampled σ at zoom 8.

## Method

- The spec is [tests/gpu/e41-effects.spec.ts](../../../tests/gpu/e41-effects.spec.ts), run headless in Chromium on SwiftShader, at 1x and 4x. The command is `pnpm test:e41-swiftshader`, with the geometry kernel WASM from `pnpm test:geometry` or `VECTOR_STUDIO_GEOMETRY_WASM`.
- Every page now draws text through the atlas (`text=atlas`, the canvas raster port). The effects page and the content page use the same option.
- The new fixtures:
  - `F2 shadow on a rectangle rotated 30 degrees`: shadow offset (24, 18) and σ 5, both in the node's local units. The oracle maps the offset through the rotation (E41-S4, S9).
  - `F7 shadow on text`: "Shadow" at size 40, offset (4, 5), σ 3.
  - `mesh path past the right edge in a shifted pass, shadow and blur`: a star path of 10 vertices, nonzero, reaching 48 px past the target. Its shadow is (−70, 10) at σ 6, and its layer blur is σ 2. `L` is captured from a camera shifted 150 px.
  - `joint draw, gradient and inner clip in a shifted pass`: a shadowed container root past the bottom edge, shifted 150 px, holds a rect clip, and inside it a star with a gradient fill and a stroke at opacity 0.6 (a joint draw). U5b left these draws to U7.
  - `stencil-pass clip composite`: a clipping frame holds two mesh paths, a plain star below and a shadowed star above. Every pass on this page has the stencil attachment, since the page's geometry ports turn on the mesh pipeline, so F6, F11 and F12 already drew the stencil variant of the clipped composite in U5c. This fixture adds a winding stencil-and-cover draw before the composite in the same pass. The expected frame is `R`, clipped once, over the plain star's own capture. Its "changed" count compares against the same frame drawn without the root's effects.
  - `F9 zoom 8, radius 40 (sigma 160 px)`: a 16 × 12 rectangle at zoom 8 with shadow (2, 2) and σ 20, which is 160 px and 3 levels.
- Clip corners are excluded. P4's rect clip coverage comes from `fwidth` of the distance to the rect, and that depends on how the device computes derivatives. SwiftShader's coarse derivatives give 0.75 to the 2 × 2 pixels inside a corner and 0.25 to the one outside on the diagonal. So the oracle's hard clip holds everywhere except within 1 px of a clip corner, and the spec skips those pixels (centres within 1.5 px of the corner on both axes, a 4 × 4 block per corner).
  - Probe runs found this. With the shadow under the corner of a 260 × 160 clip, 4 pixels missed by 31.5/255. With a 261 × 161 clip, the miss moved to the pixel outside the corner. Along the edges themselves the result was exact.
  - Content drawn under any clip has the same corners, so they are a property of P4, not of the effect passes.

## Results

| Fixture | Tolerance | Worst at 1x (1/255) | Worst at 4x | Pixels changed by the effects |
| --- | --- | --- | --- | --- |
| F2 shadow on a rectangle rotated 30 degrees | 3 | 0.83 | 0.83 | 3,835 |
| F7 shadow on text | 3 | 1.13 | 1.13 | 3,552 |
| mesh path past the right edge in a shifted pass | 3 | 1.38 | 1.44 | 15,091 |
| joint draw, gradient and inner clip in a shifted pass | 3 | 0.93 | 0.97 | 20,046 |
| stencil-pass clip composite | 3 | 0.84 | 0.86 | 2,996 |
| F9 zoom 8, sigma 160 px | 6 | 0.77 | 0.77 | 6,719 |

- The ten U5 fixtures give the same figures as in [u5c-swiftshader.md](u5c-swiftshader.md).
- A06 is unchanged: all 16 fixtures, drawn without their effects, are byte-identical under `effects: 'v0'` and `'none'` at 1x and 4x (32 of 32).
- The adapter is SwiftShader, with no error diagnostics.
- The headed reference-PC run of the same spec (`pnpm test:gpu`) is the A05 evidence. It is recorded in the U8 exit record.
