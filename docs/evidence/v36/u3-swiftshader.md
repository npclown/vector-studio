# V-36 U3 background blur on SwiftShader

Contract: [V-36](../../plans/viz-v36-inner-shadow-background-blur-contract.md), V36-A02 to A04 (background half: G5, G6, G7, G9), A06 and A07 (background half).

- Date: 2026-11-12. Environment and geometry WASM as in [u2-swiftshader.md](u2-swiftshader.md); tree: branch `claude/viz-v36-u3-background-blur` on main 6f94aa2 (V-35 U4/U5 with the backdrop snapshot).
- Command: `pnpm build`, then `E41_CHROMIUM=/opt/pw-browsers/chromium VECTOR_STUDIO_GEOMETRY_WASM=<wasm> pnpm test:e41-swiftshader`: 12/12 passed (8.4 min, and again 8.8 min on the committed tree, with the same 64 V36-A05 digests). V-35's spec (`playwright.v35-swiftshader.config.ts`, with `V35_CHROMIUM` set): 7/7 passed.

## V36-A04, background half (worst channel difference, /255, 1x and 4x)

The oracle (`backgroundBlurOracle` in `tests/support/e41-effect-oracle.ts`) reads `D` from a capture of the scene without the root, blurs it with clamp at the target edges, multiplies by `h` from the exact `L` read back and by `o`, draws it over `D`, then `R` over that. As the contract allows for the headed run, texels with `0 < α(L) < 2/255` are left out here too.

| Fixture | Worst | Tolerance |
| --- | --- | --- |
| G5 background blur radius 20 of a 30 % fill over stripes | 0.85 | 3 |
| G6 G5 inside a clipping frame | 0.77 | 3 |
| G7 G5 at the target edge, radius 40 (downsampled, clamp) | 0.97 | 6 |
| G9 background blur with a drop shadow on a leaf at opacity 0.5 | 1.15 | 3 |

Each fixture drew its blur (`backgroundBlurSkipped` 0) and differs from the same frame at σ 0 in more than 7,700 pixels. E41's fixtures and G1 to G4, G8 keep their U2 results (worst 2.00/255, downsampled, tolerance 6).

## V36-A05 and A06

- The V36-A05 digest test wrote the same 64 digests as [u2-a05-digests-main.json](u2-a05-digests-main.json) (main before the module re-pin); E41-A06 on `'none'`, `'v0'` and `'v1'`: identical.
- A nested background blur (inside a group at opacity 0.5) draws without its blur: `backgroundBlurSkipped` 2 over two frames, 0 splits, bytes identical to the same scene at σ 1e-4. Without the snapshot pipeline (unit, fake device) the root is drawn without its blur and counted.

## V36-A07, background half

A σ edit, adding a drop shadow, removing and re-adding the background blur each cost 0 port calls and 0 geometry builds; live textures return to the baseline (3 textures, 3,276,801 bytes) after the frame. `D` and `B` are frame transients released as E41's layer textures are, so device loss and dispose rely on E41-A09's shared transient mechanism; no test loses the device or disposes with them in flight (the U3 unit test checks release after submission).

## Notes

- Under `effects: 'v1'` the backend creates V-35's snapshot and blend-composite pipelines and sets `TEXTURE_BINDING` on the canvas (contract 5.2 as amended), so pipeline and resource counts of `'v1'` pages are higher than on `'v0'`; pixels of scenes without a background blur are unchanged (A05, A06).
- Headed reference-PC runs (V36-A04, A09) and the `v36-glass` bench are U4.
