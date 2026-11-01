# M6c-U5: the manual real-IME run and the observations (2026-11-01)

Unit M6c-U5 of the [M6c contract](../../plans/mvp-m6c-gpu-text-contract.md#11-units), for M6c-A09 and M6c-A10 (light tier, evidence). M6b is not amended: no run contradicted it.

## M6c-A09: NOT RUN (user decision M6c-Q8 (c), 2026-10-31)

The user chose not to make the manual real-IME run of contract section 8. M6-A07's manual half is therefore NOT RUN, and the M6 exit record discloses it, as the M6b exit disclosed M6b-A14.

- **Not built.** The checklist page and the section 8 hook log (key, `beforeinput`, composition, focus, blur and pointer events with times, the posted M6b-H4 reset, the editor's text, caret and depth, the IME version header) served only that run. With no run, they are not built, and M6c-Q9's `docs/evidence/m6c-ime-manual-<date>/` folder is not created.
- **The IME evidence that exists.** The 18 synthetic traces and their unit replay through the host mapping (M6b-A10). The 13 CDP-replayable traces in the headed M6b spec, which passed in Chrome 156 and Edge 156 on the main PC (M6b-A13). The user's own hands-on check of Korean typing on the main PC on 2026-10-30, which found that it works normally (an observation, not a recording; [M6b exit record](../m6b-exit-2026-10-30.md), M6b-A14). M6c-A08's headed spec types a word and a CDP composition (`Input.imeSetComposition`) through next-host with visible text. It is a CDP composition, not a real IME, and its headed run is still owed (contract section 16, U4).
- **Untested on a real IME.** Everything section 8's checklist would have shown: the M6b-H4 and M6-E4 ordering (whether a final consonant's `compositionend` and the next `compositionstart` fall before the posted reset), Enter and arrows during a composition, the late `compositionend` after a press or a blur, a press outside and the focus move onto the panel, Alt+Tab (case 10), Backspace after a commit, the candidate window position (also on the rotated node), Edge text prediction and Microsoft Editor injections, and the previous-version Microsoft IME.

## M6c-A10: tooling built, figures owed from the main PC

Contract section 9 names two observations for U5's main-PC sitting. They are recorded, not judged. U5 adds one headed run that makes both:

```sh
pnpm build
pnpm test:geometry
pnpm test:m6c-observe
```

`pnpm test:geometry` is needed only if the geometry kernel WASM is not built yet (or set `VECTOR_STUDIO_GEOMETRY_WASM`). The run takes a few minutes. It prints the summary tables at the end and saves them, with the raw reports, under `artifacts/m6c-u5-observe/<time>/`, which is not committed: `summary.md`, `typing/<project>.json`, and `e28/<run>/<project>/handoff-dpr-<n>/report.json`.

- **Typing (M6b-Q15 (a)).** `tests/m6c-next-host/m6c-observe.spec.ts` runs in projects `typing-chrome` and `typing-edge` (headed, DPR 1). On `?fixture=text-edit` at camera zoom 1 over a white backdrop, it creates an `autoHeight` node of 16,354 units in the committed test font (14 px, 1200 px wide), and types 30 keys at offset 0 with Playwright's keyboard, so the node ends at 16,384 units. For each keystroke it records:
  - every animation-frame interval from the frame before the keydown up to the first quiet frame;
  - the text-dom port's `layout` calls, timed by a wrapper on the hook's port;
  - the host service's glyph raster calls, timed by `glyphRasterLog`, and the number of frames they fall in;
  - when the last call ended after the keydown;
  - `long-animation-frame` entries, where the browser reports them.

  A keystroke ends at the first of 10 frames with no new call and unchanged raster counters. The spec fails only when the typing did not reach the document or the leaf.
- **Raster frame (E28, M6c-Q10 (a)).** Projects `raster-chrome` and `raster-edge` run the existing E28 spec's "per-cluster readback and raster cost" tests at DPR 1 and 2. They time one frame of `E28_RASTER_PER_FRAME` (64) distinct calls. The figures go to [`docs/evidence/e28/`](../e28/README.md) as a dated addition. If they are not run, the timing stays owed to M9.

**Container smoke run** (not evidence; headless Chromium 1243 on Linux, `M6C_NEXT_HOST_CHROMIUM`, no renderer): the typing spec passed: 30 keystrokes, node 16,384 units and 100 lines, one `layout` call per keystroke. The raster figures are empty without a renderer. The E28 projects were not run in the container, because the playground page needs the geometry WASM, and the pinned Rust toolchain that builds it is not installed here.

**Headed run: NOT RUN.** The figures for M6c-A10 come from `pnpm test:m6c-observe` on the main PC. Until then, A10 is NOT RUN.
