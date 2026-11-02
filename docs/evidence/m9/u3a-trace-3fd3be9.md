# M9-U3a diagnostic traces at `3fd3be9` (2026-11-02)

**Diagnostic only, not evidence.** Tracing slows the page, so no number here is a measurement of a section 2 row. The traces show where the main thread's time goes in the v2 misses of the [U2 record](u2-89393f1.md), for the backlog items that gate G1 (a) files (V-20 and V-21 in the [visualization track](../../plans/d9-visualization-track.md#status-index)).

## Run

- **Machine.** The main PC, headed Chrome 156, one repetition per scenario. Input idle 6 minutes before the start, and no Chrome or Edge window open.
- **Commit.** `3fd3be9`, which is `65c6f79` plus the opt-in trace switch `E26_TRACE` in `tests/e26/e26-harness.spec.ts` and `tooling/m9-trace-summary.mjs`. Before the run: `pnpm install`, `pnpm test:geometry` (1,217 passed) and the root build, with a clean tree.
- **Runs.**
  - `chrome-dpr1-v2`: typical view, stress, pointer-busy busy and plain, typing. 5 passed.
  - `chrome-dpr1` controls: v1 typical view, v1 stress. 2 passed.
- **Traces.** 7 traces of 10.6 to 22.8 MB, kept on the PC and not committed. Categories: timeline, V8 execute, V8 CPU samples, user timing.
- **Summary.** Each trace was summarized by `node tooling/m9-trace-summary.mjs`.
  - Frame runs: over the 10 s window between the `e26-window-start` and `e26-window-end` marks.
  - Latency and typing runs: over the whole trace, because those runs set no window marks. Their totals include the page load and are left out below.

## Main-thread time in the 10 s window (ms, inclusive)

| Event | stress v1 | stress v2 | typical v1 | typical v2 |
| --- | --- | --- | --- | --- |
| Animation-frame callbacks (`FireAnimationFrame`) | 7,445 (600) | 7,627 (144) | 9,299 (525) | 8,964 (330) |
| Microtasks (`RunMicrotasks`) | 309 | **6,042** | 478 | **1,518** |
| Layout | 94 | **560** | 104 | 174 |
| Pre-paint | 42 | **1,313** | 63 | 278 |
| Paint | 107 | **577** | 250 | 440 |
| Minor GC | 73 | 312 | 122 | 147 |

The number of frames is in brackets. The times are inclusive and overlap: microtasks run inside the animation-frame callbacks, so the rows do not add up to the window.

## Findings

- **Stress v2.**
  - Microtasks take about 60 % of the window (6.0 s of 10 s), against 3 % in v1. Pre-paint, layout and paint take another 2.4 s, against 0.24 s in v1.
  - The top self-time functions are in a bundle chunk that v1 barely touches (`06cn7386l0tmd.js`, about 4 s of samples). By its function shapes it is likely the React DOM chunk; the build is minified with no source maps, so this is not confirmed.
  - This is consistent with the right column re-rendering and re-laying out its 10,000 layer rows on every camera step. The pan and zoom path changes no document, so the column's re-render on a camera step is itself the defect to look at first.
- **Typical view v2.**
  - Microtasks rise from 0.48 s to 1.5 s, and pre-paint and paint by about 0.4 s.
  - Functions that v1 does not show come up in another chunk (`page`, `node`, `e9` and `tl` in `1m-1klbguzh2u.js`; which package it holds is not confirmed). This is consistent with `layerRows` walking the page on each document change (the contract's "panel cost" risk) and with the property panel re-rendering on every drag step.
- **Pointer-busy and typing (whole trace).** The top self time is in the renderer and text chunks (`tx`, `tN`, `#ea` in `26b1wd8l7qoqh.js`, `measure` in `3ucm9ajpbmmke.js`). This fits the text projection and layout under the font-load change, but the trace has no window, so the load is mixed in. A follow-up trace needs marks around the press.

## Next

None in M9. The user chose G1 (a) on 2026-11-02, so the remedy is deferred. The backlog items carry these traces as their starting point. A remedy would:

- build with source maps first, to name the functions;
- measure v2 without `ui=1`, to separate the column from the other v2 changes;
- then try the levers: no column re-render on a camera-only change, a virtualized layer list, and coalesced panel updates during a drag; and for the text, one re-projection per font-load settle.
