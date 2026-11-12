# V-36 U2: inner shadows on SwiftShader

Contract: [V-36](../../plans/viz-v36-inner-shadow-background-blur-contract.md), V36-A04 (inner-shadow half: G1 to G4, G8) and V36-A05 (E41's fixtures byte-identical under `effects: 'v0'` and `'v1'`).

- Date: 2026-11-12. Environment: cloud container, Chromium at `/opt/pw-browsers/chromium`, SwiftShader (adapter `google/swiftshader`), flags of `playwright.e41-swiftshader.config.ts`. Geometry WASM built from `packages/geometry-wasm/kernel` with `cargo build --release --target wasm32-unknown-unknown`.
- Command: `pnpm build`, then `E41_CHROMIUM=/opt/pw-browsers/chromium VECTOR_STUDIO_GEOMETRY_WASM=<wasm> pnpm test:e41-swiftshader` — 8/8 passed (4.8 min) on the U2 tree rebased on the v8 scaffold (73d6b68).

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

- Under `'v0'` and `'v1'` on this tree: E41's sixteen fixtures with their effects, at 1x and 4x, 32/32 byte-identical.
- Before and after the module re-pin: the test `V36-A05 capture digests of the E41 fixtures` writes the SHA-256 of each of those 32 captures (on a `'v0'` page) and of the same scenes without effects (on a `'none'` page). The identical test, added temporarily to a worktree of origin/main 73d6b68 (module `e41-effect`) and run there with the same command and browser, wrote the same 64 digests as this tree (module `e41-effect-v1`): 64/64 equal.
- E41-A06 now also runs a `'v1'` page: scenes without effects draw byte-identically under `'none'`, `'v0'` and `'v1'` at 1x and 4x (64/64 rows identical, 0 effect passes).

## V36-A07, inner-shadow half

E41-A07's edit costs now run on a `'v1'` page with four inner-shadow edits added (an inner shadow added, its offset and σ edited, a second one, removed). Each cost 0 port calls, 0 stroke port calls and 0 geometry builds, as E41's drop-shadow and layer-blur edits do on the same page. Pan, zoom and the per-frame effect-pass count pass unchanged.

`backgroundBlurSkipped` follows E41's `effectPasses`: a counter of the generation's drawn roots per frame on the native scene, read through a tests-only backend hook. U3 decides whether it joins a host-visible statistic.

## Notes

- G8 first failed (20.7/255) because its content also crossed the capture's bottom edge (the frame is 320 px tall), which cut the oracle's `L` there while the renderer clamped it (K1b); the GPU result was the correct one. The fixture moved up so only the left edge is cut.
- Headed reference-PC runs (V36-A04) belong to U4.
