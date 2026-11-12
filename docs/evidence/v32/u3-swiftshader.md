# V-32 U3: software-GPU run of the image paint spec

Contract: [viz-v32-image-contract.md](../../plans/viz-v32-image-contract.md), section 8, U3 (V32-A05, A06, A09). This is the software preview of V32-A06 before the headed reference-PC run, which the U5 evidence record indexes.

## Method

- Code: commit `e5491738` (PR #578 after review r1), after `pnpm build` and `pnpm build:kernel` (geometry kernel `packages/geometry-wasm/dist/kernel.wasm` SHA-256 `1d7cd698…2fa2788`).
- Browser: Chrome for Testing 153.0.8010.12, headless, with the SwiftShader flags of [E23 U3](../e23/u3-swiftshader.md) (`pnpm test:v32-swiftshader`, `V32_CHROMIUM` naming the binary).
- Page: the E23 check page with `paints=image&groups=isolated&effects=v0&samples=4`, whose scripted image port the spec fills ([v32-image-paint.spec.ts](../../../tests/gpu/v32-image-paint.spec.ts)).
- Interior probes: every third physical pixel at least 2 px inside the shape and 2 texels from any colour change of the image, compared with the premultiplied quadrant colour over the page's opaque black, within 3 per channel. Edge bands: the pixels within 1.5 px of a shape edge, compared with the same scene drawn with a solid fill of the edge's colour, within 4.

## Results (6/6 passed, 1.3 min)

| Fixture | DPR 1 probes (worst) | DPR 2 probes (worst) | Edge band DPR 1 / 2 (worst) |
| --- | --- | --- | --- |
| Stretch, rotated rectangle | 1703 (0) | 7048 (0) | 91 / 181 (0) |
| Fill, rotated ellipse | 1150 (0) | 4775 (0) | — |
| Fit, path with a hole (even-odd), letterboxed on y | 1391 (0), 130 transparent | 5912 (0), 528 transparent | 124 / 248 (0) |
| Tile at 0.5 in a clipped frame (and nothing drawn past the clip) | 1368 (0) | 5684 (0) | — |
| Under a mask, at opacity 0.5, with a drop shadow | 2910 (0.5) | 12251 (0.5) | — |

- Minified 1 px checker at zoom 0.25 (level 2 at DPR 1, level 1 at DPR 2): 900 and 3600 probes, worst 0.5 from the box-filtered 127.5.
- Pending, then ready: once ready but not yet notified, a frame neither asked the port again nor drew the image (one request per state change, A05). The port's notification submitted a frame, the key was asked once more, and the next frame drew it. A failed key raised one `render.image-unavailable` over two frames. Device loss: the recovered generation requested the image again and its frame was byte-identical.
- No other `render.image-*` diagnostic in the fixture runs.

## Regression (V32-A09, software part)

- `tests/gpu/e23-gradient-paint.spec.ts` on the same SwiftShader setup: 11/11 passed. A03 and A04 now run under `paints: 'gradient'` and `'image'`, and a byte-identity check renders every G fixture in both modes with no difference.
- `pnpm test:e41-swiftshader`: 6/6 passed on the commit before review r1 (`7d356bd5`); r1 changed the image store, its notice limit, the residency `fits` check and tests, none of which an E41 scene without image paints reaches.
- The first run found that the E23 page's frame-source wrapper did not pass the service's `imageSource` to the backend; the page now forwards it (the hosts attach the service itself, which carries it).
