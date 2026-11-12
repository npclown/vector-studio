# V-36 U2: inner shadows on SwiftShader

Contract: [V-36](../../plans/viz-v36-inner-shadow-background-blur-contract.md), V36-A04 (inner-shadow half: G1 to G4, G8) and V36-A05 (E41's fixtures byte-identical under `effects: 'v0'` and `'v1'`).

- Date: 2026-11-12. Environment: cloud container, Chromium at `/opt/pw-browsers/chromium`, SwiftShader (adapter `google/swiftshader`), flags of `playwright.e41-swiftshader.config.ts`. Geometry WASM built from `packages/geometry-wasm/kernel` with `cargo build --release --target wasm32-unknown-unknown`.
- Command: `pnpm build`, then `E41_CHROMIUM=/opt/pw-browsers/chromium VECTOR_STUDIO_GEOMETRY_WASM=<wasm> pnpm test:e41-swiftshader` — 7/7 passed (4.1 min).

## E41-A05 oracle, on `effects: 'v1'` pages (worst channel difference, /255)

| Fixture | 1x | 4x | Tolerance |
| --- | --- | --- | --- |
| G1 inner shadow on a rectangle | 1.06 | 1.06 | 3 |
| G2 inner shadow on a rectangle rotated 30° | 1.71 | 1.71 | 3 |
| G3 two inner shadows and a drop shadow on a 50 % fill, leaf at opacity 0.7 | 1.78 | 1.78 | 3 |
| G4 inner shadow on text | 1.68 | 1.68 | 3 |
| G8 inner-shadowed group with a mask group, cut at the target edge (K1b) | 0.89 | 0.89 | 3 |

E41's sixteen fixtures (F1 to F12 and U5b-U7b's) on the same `'v1'` pages: worst 2.00/255 (downsampled, tolerance 6), every other at most 1.63/255, as in [u7b-swiftshader.md](../e41/u7b-swiftshader.md).

## V36-A05 identity

E41's sixteen fixtures with their effects, captured under `'v0'` and `'v1'` at 1x and 4x: 32/32 byte-identical. E41-A06 (scenes without effects under `'none'` and `'v0'`) and E41-A07 to A09 pass unchanged.

## Notes

- G8 first failed (20.7/255) because its content also crossed the capture's bottom edge (the frame is 320 px tall), which cut the oracle's `L` there while the renderer clamped it (K1b); the GPU result was the correct one. The fixture moved up so only the left edge is cut.
- Headed reference-PC runs (V36-A04) belong to U4.
