# M6c-U5: the manual real-IME run and the observations (2026-11-01)

Unit M6c-U5 of the [M6c contract](../../plans/mvp-m6c-gpu-text-contract.md#11-units), for M6c-A09 and M6c-A10 (light tier, evidence). M6b is not amended: no run contradicted it.

## M6c-A09: NOT RUN (user decision M6c-Q8 (c), 2026-10-31)

The user chose not to make the manual real-IME run of contract section 8. M6-A07's manual half is therefore NOT RUN, and the M6 exit record discloses it, as the M6b exit disclosed M6b-A14.

- **Not built.** The checklist page and the section 8 hook log (key, `beforeinput`, composition, focus, blur and pointer events with times, the posted M6b-H4 reset, the editor's text, caret and depth, the IME version header) served only that run. With no run, they are not built, and M6c-Q9's `docs/evidence/m6c-ime-manual-<date>/` folder is not created.
- **The IME evidence that exists.** The 18 synthetic traces and their unit replay through the host mapping (M6b-A10). The 13 CDP-replayable traces in the headed M6b spec, which passed in Chrome 156 and Edge 156 on the main PC (M6b-A13). The user's own hands-on check of Korean typing on the main PC on 2026-10-30, which found that it works normally (an observation, not a recording; [M6b exit record](../m6b-exit-2026-10-30.md), M6b-A14). M6c-A08's headed spec types a word and a CDP composition (`Input.imeSetComposition`) through next-host with visible text. It is a CDP composition, not a real IME; it passed headed on the main PC at `d5a0fea` (#433, contract section 16, U4).
- **Untested on a real IME.** Everything section 8's checklist would have shown: the M6b-H4 and M6-E4 ordering (whether a final consonant's `compositionend` and the next `compositionstart` fall before the posted reset), Enter and arrows during a composition, the late `compositionend` after a press or a blur, a press outside and the focus move onto the panel, Alt+Tab (case 10), Backspace after a commit, the candidate window position (also on the rotated node), Edge text prediction and Microsoft Editor injections, and the previous-version Microsoft IME.

## M6c-A10: the observations (recorded on the main PC)

Contract section 9 names two observations for U5's main-PC sitting. They are recorded, not judged. U5 adds one headed run that makes both:

```sh
pnpm build
pnpm test:geometry
pnpm test:m6c-observe
```

`pnpm test:geometry` is needed only if the geometry kernel WASM is not built yet (or set `VECTOR_STUDIO_GEOMETRY_WASM`). It is the slow step, because it builds the Rust kernel. `pnpm test:m6c-observe` itself takes a few minutes. It prints the summary tables at the end and saves them, with the raw reports, under `artifacts/m6c-u5-observe/<time>/`, which is not committed: `summary.md`, `typing/<project>.json`, and `e28/<run>/<project>/handoff-dpr-<n>/report.json`. Each run makes a new folder. If you set `M6C_OBSERVE_DIR` by hand to an older run's folder, the teardown also reads that run's reports and merges them into the summary. `E28_OUTPUT_DIR` is always set to the run's `e28/` folder.

- **Typing (M6b-Q15 (a)).** `tests/m6c-next-host/m6c-observe.spec.ts` runs in projects `typing-chrome` and `typing-edge` (headed, DPR 1). On `?fixture=text-edit` at camera zoom 1 over a white backdrop, it creates an `autoHeight` node of 16,354 units in the committed test font (14 px, 1200 px wide), and types 30 keys at offset 0 with Playwright's keyboard, so the node ends at 16,384 units. For each keystroke it records:
  - every animation-frame interval from the frame before the keydown up to the first quiet frame;
  - the text-dom port's `layout` calls, timed by a wrapper on the hook's port;
  - the host service's glyph raster calls, timed by `glyphRasterLog`, and the number of frames they fall in;
  - when the last call ended after the keydown;
  - `long-animation-frame` entries, where the browser reports them.

  A keystroke ends at the first of 10 frames with no new call and unchanged raster counters. The spec's own per-frame settle check runs inside the measured window: it reads the editor snapshot and joins the node's runs (16,384 units) each frame. So its cost is included in the frame figures, though not in the layout or raster figures. The spec fails only when the typing did not reach the document or the leaf, or when the keydown count is not 30.
- **Raster frame (E28, M6c-Q10 (a)).** Projects `raster-chrome` and `raster-edge` run the existing E28 spec's "per-cluster readback and raster cost" tests at DPR 1 and 2. They time one frame of `E28_RASTER_PER_FRAME` (64) distinct calls. The figures go to [`docs/evidence/e28/`](../e28/README.md) as a dated addition. They were run on the main PC (record below).

**Container smoke run** (not evidence; headless Chromium 1243 on Linux, `M6C_NEXT_HOST_CHROMIUM`, no renderer): the typing spec passed: 30 keystrokes, node 16,384 units and 100 lines, one `layout` call per keystroke. The raster figures are empty without a renderer. The E28 projects were not run in the container, because the playground page needs the geometry WASM, and the pinned Rust toolchain that builds it is not installed here.

## M6c-A10 main-PC record (2026-11-01)

Run on 2026-11-01, about 07:49 to 08:05 UTC, at head `bd99196`, based on main `5c17b46`.

- **Machine.** The main PC: NVIDIA GeForce GTX 1660 SUPER (driver 32.0.16.1088), headed Chrome 156.0.8078.74 and Edge 156.0.4314.50, Node 24.22.1, pnpm 11.1.2.
- **Steps.** `pnpm install` and `pnpm build` PASS. `pnpm test:geometry` was not re-run: no geometry change since U4, and the WASM was built at the U4 run.
- **`pnpm test:m6c-observe`** (headed): **6 of 6 passed** in 1.2 min: `typing-chrome`, `typing-edge`, `raster-chrome` (DPR 1 and 2) and `raster-edge` (DPR 1 and 2).
- **`pnpm test:m6c-next-host`** (headed) at `bd99196`: **108 of 108 passed**, 0 failed, in 14.7 min.

**Idle caveat (disclosed).** The machine was not idle. The user's own Chrome (23 processes) and Edge (9 processes) were open during the run, and the CPU load, measured once before the run, was about 27 %. The figures are recorded, not judged (section 9: no gate, no claim).

### Typing: 30 keystrokes at offset 0 of a node growing to 16,384 units

Figures in ms as mean / median / p95 / max, per keystroke unless named. DPR 1, renderer started, 100 lines in both browsers.

| Project | Browser | Create | Frame (every interval) | Max frame | Layout | Layout calls | Raster | Raster calls | Raster frames | Last work | Quiet from | Long frames |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| typing-chrome | 156.0.8078.74 | 421.5 | 103.486 / 16.7 / 366.5 / 366.7 | 335.013 / 350 / 366.7 / 366.7 | 331.497 / 331.4 / 346.4 / 353.7 | 1 / 1 / 1 / 1 | 0.073 / 0 / 0.4 / 0.6 | 0.233 / 0 / 1 / 1 | 0.233 / 0 / 1 / 1 | 341.577 / 339.5 / 372.4 / 377.6 | 387.62 / 391 / 413.9 / 414.5 | 30 |
| typing-edge | 156.0.4314.50 | 414.9 | 108.697 / 16.7 / 383.3 / 400 | 369.46 / 366.7 / 383.5 / 400 | 353.473 / 352.8 / 369.9 / 378.8 | 1 / 1 / 1 / 1 | 0.067 / 0 / 0.4 / 0.4 | 0.233 / 0 / 1 / 1 | 0.233 / 0 / 1 / 1 | 363.247 / 355.5 / 388.5 / 407.4 | 412.35 / 413.6 / 430.9 / 447.4 | 30 |

"Long frames" is the number of `long-animation-frame` entries over all 30 keystrokes.

### Raster frame: one E28 budget-sized frame of distinct calls (E28 spec)

| Project | DPR | Calls | Distinct | Frame ms | Within 16.7 ms | Cold mean ms | Warm mean ms | Spec failures |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| raster-chrome | 1 | 64 | 64 | 6.5 | yes | 0.125 | 0.02 | 0 |
| raster-chrome | 2 | 64 | 64 | 8 | yes | 0.159 | 0.025 | 0 |
| raster-edge | 1 | 64 | 64 | 5.7 | yes | 0.136 | 0.021 | 0 |
| raster-edge | 2 | 64 | 64 | 7.1 | yes | 0.137 | 0.03 | 0 |

These figures are also recorded in [the E28 evidence](../e28/README.md#m6c-u5-addition-2026-11-01-64-call-raster-frame-on-the-main-pc) as a dated addition.

### Plain reading

- **Typing.** At 16,384 units, each keystroke makes one text-dom `layout` call, with a median of about 330 ms (Chrome) to 350 ms (Edge). The longest frame of a keystroke has a median of 350 to 367 ms, so typing at this size runs at roughly 3 frames per second. There are 30 `long-animation-frame` entries for the 30 keystrokes in each browser. The median frame interval of 16.7 ms is the quiet frames around each keystroke.
- **Raster while typing.** The raster work per keystroke is negligible: 0.233 calls on average (at most 1), at most 0.6 ms.
- **Raster frame.** The E28 frame of 64 distinct calls takes 5.7 to 8 ms, inside 16.7 ms, in both browsers at DPR 1 and 2. It agrees with the extrapolated figure of about 7 ms.
- **What follows.** Section 9 makes no gate and no claim, and M6b-Q15 (a) asks only for the observation in the exit record. So the typing figures go to the M6 exit record (U6). Section 12's risk stands: the main-thread cost of layout while typing is observed, not bounded, until M9, which owns the performance targets. This record adds no criterion.

### Raw reports

The raw reports were saved under `artifacts/m6c-u5-observe/2026-11-01T07-49-22-811Z/`. They are kept on the main PC and not committed, as in the earlier records. SHA-256:

```text
34292297f9a1453ddf2d405e0e058487ea3ff485c541cd6e05c034d7a0179e0e  e28/2026-11-01T07-50-13-454Z-28988/raster-chrome/handoff-dpr-1/report.json
9182799f82d6d0d8493b7e4cc75be3c320174c7fcc352764b0d8e1b9dc3cd6a4  e28/2026-11-01T07-50-13-454Z-28988/raster-chrome/handoff-dpr-2/report.json
4aba96082ff1c50db1d8b8e4f90e9fff35ca4fd6f25dedf2e6c338b54b2f22b7  e28/2026-11-01T07-50-22-632Z-34140/raster-edge/handoff-dpr-1/report.json
42c7d8066bd335db9c033ffb3faf229e787a5451838463796edf50e2ee270773  e28/2026-11-01T07-50-22-632Z-34140/raster-edge/handoff-dpr-2/report.json
ba50b54db867e7324fb4cd1da44d0384b0e27fde5aaf2e9539a8d5da7244f4f3  typing/typing-chrome.json
b5d1d0a8f24a6decfe318e7eddfb4f68dd0b8edaa762c920462571383812c590  typing/typing-edge.json
3d5a12ca236a1eddce03401e124100a07a14485d12c8e902278c92b76a665b89  summary.md
```

The run summary, also kept off the repository on the main PC, has SHA-256 `0d328eeba2b6b5f3907d721bf2ad8fb8af5b43ec85336ed228fb33d7e330c692`.
