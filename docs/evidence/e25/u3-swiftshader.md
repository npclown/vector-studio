# E25 U3: layer passes on a software GPU (E25-A05, A08 capture part)

Contract: [d9-e25-isolated-opacity-contract.md](../../plans/d9-e25-isolated-opacity-contract.md), section 7, U3: E25-A05 and A08 on SwiftShader. The headed reference-PC run is U4's, and U5 indexes both.

## Method

- Commit: branch `claude/eng-e25-u3-layer-passes` on top of `095abeb` (U2).
- Browser: Playwright Chromium (Chrome for Testing 153.0.8010.12) at `/opt/pw-browsers/chromium`, headless, with the SwiftShader flags of [../e23/u3-swiftshader.md](../e23/u3-swiftshader.md). The geometry kernel WASM SHA-256 starts with `6d4e47805b66`.
- Host page: the E23 headed page with a local draft of U4's page options, not committed with U3. The query string sets:
  - `groups=flat|isolated`, the service's `groups` option;
  - `isolate=1`, `isolateUnitOpacityForTesting`;
  - `tile=N`, the backend's `layerTileSizeForTesting`.
  
  The page forwards `requiresLayerPipeline` from the service and exposes `layerPasses()`, from `getLayerPassesForTesting()`.
- Script: [u3-swiftshader-captures.mjs](u3-swiftshader-captures.mjs), run with `SWIFTSHADER=1`. The camera is at home and the CSS surface is 512 × 320. The script runs at sample counts 4 and 1, at DPR 1 and 2, in four configurations:
  - `flat`: `groups: 'flat'`;
  - `isolated`: `groups: 'isolated'`, where no container draws a layer;
  - `layer`: `isolated` with `isolateUnitOpacityForTesting`, so every container draws a layer at opacity 1;
  - `tiled`: `layer` with `layerTileSizeForTesting` 64.
- Scenes. Every container has opacity 1. The backdrop is the page's clear colour (opaque black), and nothing is drawn under or over a layer in its parent, which is A05's setup.
  - `leaves`: one container holding a solid rectangle with a stroke, a rotated linear-gradient rectangle, a joint path with a radial gradient fill and a round-cap stroke, and a path at opacity 0.8. This exercises the plain analytic module, the analytic paint variant, the mesh joint paint variant and the mesh fill variant.
  - `clips`: one container holding a rotated rect-clip container (a gradient rectangle and a joint path) and a mask container (an ellipse source, a gradient path with a stroke, and a solid rectangle). This exercises the clip and paint-clip variants and a mask level under a layer, and gives three layers under `isolate`.
  - `nested`: three nested containers whose leaves do not overlap. The bounds overlap, so the innermost layer composites inside its parent's tile.
  - `wide`: a container spanning the target, with content crossing the 64-px tile seams at odd offsets.
- Two further scenes, `under` and `over`, are not part of A05. They hold content under, or over, nested layers in their parents. The script reports their largest channel difference from `flat` and does not count them as mismatches.
- The frame hashes are in [u3-swiftshader-captures.jsonl](u3-swiftshader-captures.jsonl), one row per frame.

## Results

**E25-A05.** For each A05 scene, sample count and DPR, the four configurations give byte-identical frames: 64 frames, 0 mismatches. Both `layer` and `tiled` draw their layers:

- `leaves` and `wide` draw 1 layer per frame.
- `clips` and `nested` draw 3 layers per frame.
- The `layerPasses` counter rises by 2 frames × that number.

At DPR 2 the `wide` layer spans nearly the whole 1024 × 640 target, so at tile size 64 it takes 16 × 10 tiles. No diagnostic of severity `error` was raised. All 11 layer variants and the composite pipeline compiled and were created on SwiftShader. The scene came up with `layerPipelineAvailable`.

**`under` and `over`.** Both differ from `flat` by at most 1/255 in any channel. `layer` and `tiled` are identical to each other.

- `under` differs at both sample counts. A layer composited over earlier content rounds its premultiplied value once more: E25-K4's one rounding per isolation level.
- `over` is identical at 1x and differs only at 4x. Content drawn over a composite in the same parent pass blends per sample with the layer's resolved pixel, as the contract specifies ("every sample of a pixel receives the pixel's value"). The main pass instead blends per sample before one resolve, so edge pixels where both shapes have partial coverage can differ by one 8-bit step.

Both cases are within section 6's allowance of 1/255 per isolation level. U4's oracle tolerances already include it.

**E25-A08, capture part.**

- With `groups: 'flat'` and with `groups: 'isolated'`, every scene gives byte-identical frames at both sample counts and DPRs: 24 frames compared with `flat`, 0 mismatches.
- Against `main` at U1's merge base, `docs/evidence/e23/a08-solid-capture.mjs` was run unchanged with `SWIFTSHADER=1`. It renders the P4 page's solid scenes, 12 frames, at sample counts 4 and 1 and DPR 1 and 2. It ran against two builds:
  - `0e12283` (#342), the merge base, served from a separate worktree;
  - this unit's working tree.
  
  The two outputs are byte-identical, with SHA-256 `230a28be…284ec9`. That is the same hash E24 U3 recorded at `2d19b64`.
- Hash and key part: `tests/unit/e25-u3-layer-passes.test.ts` pins the SHA-256 of the base, clip and paint modules. `tests/unit/e23-u3-paint-variants.test.ts` pins the mask modules, and `tests/unit/e10-default-invariance.test.ts` holds the E10-A1 golden log. All of them pass unchanged.

**Remaining for the reference PC (U4).**

- A05's seam check against the oracle on hardware.
- The A08 captures on Chrome and Edge.
- The full headed `pnpm test:gpu`.
