# V-36 U4 on the reference PC (headed)

Contract: [V-36](../../plans/viz-v36-inner-shadow-background-blur-contract.md), rows V36-A04 to A07 and A09 on a real GPU, in Chrome and Edge.

**Sitting**

- Date: 2026-11-12, on the reference PC (`nvidia/turing`, GTX 1660 SUPER).
- Browsers: headed Chrome 157.0.8103.51 and Edge 157.0.4341.46.
- Tree: branch `claude/viz-v36-u4-exit` at `366d34e`, the same product code as #598's merge (`c863fa6`). The browser versions and commit are as relayed by the coordinator (the GPU-spec records carry neither); the Chrome and Edge records are byte-identical. `pnpm install` and `pnpm build` passed.
- The coordinator relayed the run from the PC.

**Commands and results**

- `$env:VS_GPU_EDGE='1'; pnpm test:gpu tests/gpu/e41-effects.spec.ts`: 28 of 28 passed (14 per browser), 17.0 min.
  - The run directories are committed as [u4-gpu-366d34e/chrome/](u4-gpu-366d34e/chrome/) and [u4-gpu-366d34e/edge/](u4-gpu-366d34e/edge/).
  - On the PC they were `artifacts/e41-effects/2026-11-12T21-08-27-785Z-35884` and `artifacts/e41-effects/2026-11-12T21-16-44-437Z-25720`.
- `pnpm test:e41-next-host tests/e41-next-host/v36-effects.spec.ts`: 6 of 6 passed (3 tests each in Chrome and Edge), 36.9 s.
  - This is V36-A09.
  - The run wrote only a timing file on the PC, `artifacts/headed-timing/2026-11-12T21-00-10-587Z-e41-studio.json`. The probe values are asserted in the spec, so no record of them is committed.

## V36-A04 against the CPU oracle

Each value is the worst channel difference, out of 255. Chrome and Edge gave identical results, and 1x and 4x gave identical results. No pixel is over 3/255.

| Fixture | Worst | Tolerance |
| --- | --- | --- |
| G1 inner shadow on a rectangle | 1.06 | 3 |
| G2 G1 rotated 30° | 1.83 | 3 |
| G3 two inner shadows and a drop shadow on a 50 %-alpha fill | 2.07 | 3 |
| G4 inner shadow on text | 1.87 | 3 |
| G8 inner-shadowed group holding a mask group across the target edge | 0.89 | 3 |
| G5 background blur radius 20 of a 30 % fill over stripes | 0.81 | 3 |
| G6 G5 inside a clipping frame | 0.81 | 3 |
| G7 G5 at the target edge, radius 40 (downsampled, clamp) | 0.91 | 6 |
| G9 background blur with a drop shadow on a leaf at opacity 0.5 | 1.22 | 3 |
| G10 background blur radius 20 on a `multiply` leaf, 50 % amber fill | 0.93 | 3 |
| G10b background blur radius 16 on a `screen` leaf at opacity 0.6 with a drop shadow | 1.12 | 3 |

On each G10 fixture:

- 1 split per frame, and the blend composite was drawn every frame;
- `backgroundBlurSkipped` was 0;
- more than 17,000 pixels changed both against the `normal` render and against the render without blur.

E41's own fixtures on the same pages: at most 1.94/255.

## V36-A05 to A07

- **E41-A06 and V36-A05.** All 32 identity rows are identical under `'v0'` and `'v1'`, and E41-A06's `'none'`, `'v0'` and `'v1'` rows are identical, in both browsers.
  - The digest report `v36-a05-digests.json` is this device's own.
  - The before-and-after-re-pin comparison therefore stays the SwiftShader one, 64 of 64 ([u2-swiftshader.md](u2-swiftshader.md)).
- **V36-A06.** The nested background blur drew without its blur: 2 skipped, 0 splits, bytes identical to the drawing without it.
- **V36-A07, both halves.**
  - Every inner-shadow and background-blur edit cost 0 port calls, 0 stroke port calls and 0 geometry builds.
  - Live textures after the background-blur edits matched the baseline: 3 textures, 3,276,801 bytes.
  - E41-A09's accounting passed.

## V36-A09 (next-host, from the panel)

These steps ran in both browsers:

- **Inner shadow.** Added with its defaults, edited to opaque blue at offset (0, 20) and radius 0, hidden, shown again, and removed. Probes: blue in the band under the top edge, red at the centre, and red again once the shadow was hidden and once it was removed.
- **Background blur.** Added to a white 20 % rectangle over 10 px black and white stripes, widened to radius 20, hidden, shown again, and removed.
  - The probes over a black stripe and over a white stripe read the sharp values, 51 and 255, when the blur was off or gone.
  - They read about 153 within 24 when the blur was on.
- **Nested note.** A background blur inside a group at 50 % opacity shows `effect-0-nested-note`, and the note goes away when the group is back at opacity 1.

The add steps are checked through the panel and the model state. Pixel probes start at the edit step, as recorded at the U4 review.
