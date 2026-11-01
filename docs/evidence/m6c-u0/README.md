# M6c-U0: the zoom-125 % position difference (cause and text-dom fix)

**Date: 2026-10-31 (review r1 follow-ups applied the same day). Status: cause found, rule (a) fix in text-dom, container checks PASS; main-PC re-runs (automated) at `9ea2c34` and `83822bf` PASS on the position bound and the bump rule; hand-run rows NOT RUN; final review r2 commit container-verified only, its main-PC run owed before M6c-U3; since M6c-U3 changed text-dom's measurement (span `lang`, no override for Common-only nodes, 2026-10-31), that run is owed at or after the final M6c-U3 commit.**

This note follows [the M6c contract, section 3](../../plans/mvp-m6c-gpu-text-contract.md#3-zoom-125--investigation-u0-first) (M6c-A01, unit M6c-U0). It explains the FAIL in [m6a-a12-dpr-manual.md](../m6a-a12-dpr-manual.md): at browser zoom 125 % every row was off by up to 1/32 px.

Files:

- [`m6c-u0-snippet.mjs`](m6c-u0-snippet.mjs): the record's snippet, with the same fifteen requests, reference key and pass rule. It also prints, for each request, its `s` and the field with the largest delta (`console.table`). The final line names the request, the `s` and the field behind the maximum.
- [`probe.mjs`](probe.mjs): a container probe. It runs the snippet on the next-host `?fixture=text&test=1` page in Playwright's Chromium under real browser zoom (`chrome.tabs.setZoom` from a throwaway extension, without and with a reload), `--force-device-scale-factor` and CDP `deviceScaleFactor` emulation. The reference is stored at layout zoom 1.
- [`probe-direct.mjs`](probe-direct.mjs): the experiments behind steps 2 to 4, on text-dom alone (built `dist` served with an import map, no next-host): per-field maxima, the `REFERENCE_SCALE` sweep, CSS zoom divided back, the probe-edge test, browser zoom 1.1 and 0.9, a real device scale under CDP emulation, and the per-request cost. The "before the fix" figures come from the same probe with `packages/text-dom/src/measure.ts` as at `e8d3489`, built (review r1 follow-up 5; they were first taken with uncommitted scratch scripts and re-taken with this probe, with the same numbers).
- The text-dom change: `packages/text-dom/src/measure.ts`. It is tested by `tests/unit/m6c-u0-text-dom-zoom.test.ts` (against a mock host) and by `pnpm test:m6c-u0-zoom` (`tests/m6c-u0-zoom/`, headless Chromium under `--force-device-scale-factor` 1.25 and 1.875, the port against its own DPR 1 layouts within 1/64 px; needs `pnpm build`, not the geometry WASM, and is not in CI).

Environment: the container's headless Chromium 153.0.8010.12 (Playwright's full build, not the headless shell), Linux, the committed Noto Sans KR subset. The main PC record is Chrome 156 and Edge 156 on Windows.

## Step 1: reproduction. It reproduces.

Before the fix (base `e8d3489`), `probe.mjs` on the production next-host build printed:

| Condition | Max delta (px) | Request, `s`, field | Record (main PC) |
| --- | --- | --- | --- |
| Browser zoom 1.25, no reload and reload | 0.03125 | 6, 64, `height` (= last line's baseline) | 0.03125, both browsers |
| Browser zoom 1.5, both | 0.0104217529296875 | 13, 32, line 2 `baseline` | 0.0104217529296875, both browsers |
| Browser zoom 1.875, both | 0.027191162109375 | 13, 32, line 3 `baseline` | 0.02728271484375 |
| Browser zoom 2, both | 0.015625 (passes at ≤ 1/64) | 11, 32, line 0 `baseline` | not recorded |
| `--force-device-scale-factor` 1.25 / 1.5 / 1.875 / 2 | 0.03125 / 0.0104217529296875 / 0.027191162109375 / 0.015625 | same as browser zoom | DPR 1.5 by Windows scale: 0.0104217529296875 |
| CDP `deviceScaleFactor` 1.25 / 1.5 / 1.875 / 2 | 0 | - | M6a spec: PASS |

Lines, clusters and fallbacks matched the reference in every row. Each "no reload" row bumped the generation once. The 1.25 and 1.5 values equal the record bit for bit. At 1.875 the value differs from the record by 9.2e-5 px, which is plausibly the Chromium 153 against 156 gap.

CSS `zoom: 1.25` on `<body>`, an ancestor of the measurement host, also reproduces the pattern (`probe-direct.mjs css`, before the fix): divided back by 1.25, the worst is request 6's `height` and last baseline, off by 0.03125, as under browser zoom. It is not a like-for-like comparison, though: the browser then reports lengths in zoomed px, so the raw results differ by up to 55.8 px, and fixed widths and right or centre alignment do not divide back (the probe skips those fields). It was left out of `probe.mjs`.

**Correction to section 3's finding.** The difference does not follow browser zoom rather than DPR. It follows the **layout zoom**: browser zoom × the *real* device scale factor. A real device scale of 1.25 (`--force-device-scale-factor`) fails exactly as zoom 125 % does. Only CDP emulation passes, because it reports `devicePixelRatio` without laying out at it. The record's monitor-150 % rows are real DSF 1.5, and they match zoom 150 %.

## Step 2: which request, `s` and field, and the pattern

Before the fix, browser zoom, the maximum per field across the fifteen requests:

| Field | Zoom 1.25 | Zoom 1.5 | Zoom 1.875 |
| --- | --- | --- | --- |
| result `height` | 0.03125 (req 6, s 64) | 0.00032 (req 13, s 32) | 0.01041 (req 6, s 64) |
| line `baseline` (and cluster `y`) | 0.03125 (req 6 line 4, s 64) | 0.01042 (req 13 line 2, s 32) | 0.02719 (req 13 line 3, s 32) |
| line `top` | 0.02500 (req 6 line 4) | 0.00016 | 0.00833 (req 6 line 4) |
| line `height` | 0.00625 (req 6) | 0.00016 | 0.00208 (req 6) |
| cluster `x` | 0.00039 (req 11, s 32) | 0.00033 | 0.00045 |
| cluster `advance` | 0.00078 (req 12, s 32) | 0.00065 | 0.00065 |
| line `left`, `width`, result `width` | ≤ 0.00049 | ≤ 0.00049 | ≤ 0.00048 |

Every maximum is vertical. Measured in zoomed px at the measured size, each step is half a px or a whole one, for example:

- Request 0 (s 64, size 1280 measured): the baseline is 1326 CSS px at zoom 1 and 1325.6 at zoom 1.25, that is 1657.5 → 1657 zoomed px.
- Request 6 (s 64, line height 0.5): every line box is 878 CSS px at zoom 1 and 877.6 at 1.25, that is 1097.5 → 1097 zoomed px. Over five lines that adds up to 2.5 zoomed px = 2 measured CSS px, and 2 / 64 = **1/32 page px**.
- Zoom 1.5, request 13 line 2 (s 32): 0.5 zoomed px = 1/3 measured CSS px, and (1/3) / 32 = 0.0104 page px. So the contract's unverified clue (an s 64 request, one device px) is wrong. The 1.5 maximum is half a device px on an **s 32** request.

The per-field table is `probe-direct.mjs fields` before the fix. The pattern against `s` is `probe-direct.mjs sweep` (the probe's server rewrites `REFERENCE_SCALE` in the served `scale.js`). Only browser zoom was varied: the max delta in page px, before the fix.

| `REFERENCE_SCALE` | zoom 1.25 | 1.5 | 1.875 | 2 | max horizontal (all zooms) |
| --- | --- | --- | --- | --- | --- |
| 1 | 3 | 1.667 | 2.933 | 2.5 | 0.026 |
| 4 | 0.75 | 0.417 | 0.152 | 0.125 | 0.0062 |
| 16 | 0.0625 | 0.104 | 0.0625 | 0.156 | 0.0019 |
| 32 | 0.03125 | 0.0521 | 0.0272 | 0.0156 | 0.00078 |
| 64 (as built) | 0.03125 | 0.0104 | 0.0272 | 0.0156 | 0.00078 |

The vertical error is a whole number of half or whole zoomed px over `s × zoom`. So it falls roughly as 1/`s`, but not monotonically: it depends on where each metric's fraction falls at each size. It also grows with the line count. No `s` that text-dom can choose takes it under 1/64 at every zoom. The horizontal error is the layout unit, about 1/(64 · `s` · zoom) per edge. By size, the size-40 requests (s 32) carry the 1.5, 1.875 and 2 maxima, and the size-20 request 6 (s 64, five lines) carries the 1.25 maximum.

## Step 3: candidate causes

| Candidate | Status | Evidence |
| --- | --- | --- |
| Chromium's layout unit, 1/64 of a zoomed px | **Ruled out** as the cause of the 1/32 (it contributes ≤ 0.00078 px) | It moves only the horizontal fields, by ≤ 0.00078 px at s 64 (≤ 0.031 zoomed px at the measured size, a few units), well under 1/64. The vertical steps are 0.5 or 1 zoomed px, 32 to 64 units, which a unit rounding cannot make. |
| Line metrics rounded to whole zoomed px at the measured size | **Kept: the cause** | The baseline 1326 → 1325.6 and the line box 878 → 877.6 CSS px are 1657.5 → 1657 and 1097.5 → 1097 zoomed px. The error scales with lines/(`s` × zoom). Cancelling the zoom on the measurement host removes it (step 4). |
| The 10,000 px `font-size` clamp and the 2^25 px extent | **Ruled out** | The largest measured size × zoom is 2048 × 1.875 = 3840 < 10,000, and the largest measured extent is about 4390 × 1.875 ≈ 8231 px ≪ 2^25. At `REFERENCE_SCALE` 1 (sizes of 10 to 80 zoomed px) the error is still there, and larger (3 px). |
| `inline-block` probe edges snapped to device px | **Ruled out** | `probe-direct.mjs edges`: at zoom 1.25 a 0 × 0 `inline-block` probe after `padding-top` p reads p snapped only to the layout unit: 0.1 → 0.1 (0.125 zoomed px), 0.37 → 0.3625 (29 units), 0.61 → 0.6. Device px are 0.8 CSS px, and no reading is snapped to them. |

## Step 4: the rule (a) fix

text-dom now lays out its measurement block at layout zoom 1 whatever the page's zoom, in `packages/text-dom/src/measure.ts`:

- `layoutZoom` reads the page's layout zoom `E` from the layout unit. A host `width` of `w` CSS px is laid out as `floor(64 E w)` units. The smallest `w = 2^k / 64` that reads back non-zero is one unit, so `E = 1 / (64 × reading)`.
- `cancelLayoutZoom` sets `zoom: 1/E` on the host and checks that it took: host widths of 1.5 and 1000.5 units must floor to 1 and 1000 of the host's own units (a host still at `E` floors them to `floor(1.5 E)` and `floor(1000.5 E)`). Otherwise it sets `zoom: 1` and uses `E = 1`, which keeps the pre-fix error rather than adding another. The detection assumes Chromium (its 1/64 px layout unit, floored widths and the metric rounding it cancels) and no CSS `zoom` on the host's ancestors; the check is what guards both (review r1 follow-up 3).
- Detection runs again only when `devicePixelRatio` differs from the last detection's (and for a new host). Browser zoom, a real device scale change and CDP emulation all change the ratio. A real device scale change under unchanged CDP emulation keeps it and is not seen until the next ratio change (test setups only). At `E` in [1, 2) a detection costs about seven host layouts (two reads, the zoom change, two check reads and the width reset); a request at a stable ratio costs none (review r1 follow-up 2).
- `devicePixelRatio` is not used to find `E`: under CDP emulation on a real-DSF screen it reports the emulated ratio while layout stays at the real one. A result within 1e-6 of `devicePixelRatio` or of 1 snaps to it. A zoom outside [1/64, 32) is treated as 1, with no cancelling.
- The host gets `zoom: 1/E`, and every length read back (`getClientRects` and `getBoundingClientRect` differences, ascents, probe metrics, the block height) is multiplied by `E`.
- The port's interface, `measurementScale` and the assembly are unchanged.

After the fix, `probe.mjs` on the production next-host build gave:

| Condition | Max delta (px) |
| --- | --- |
| Browser zoom 1.25, no reload and reload | 7.6e-6 |
| Browser zoom 1.5, both | 7.6e-6 |
| Browser zoom 1.875, both | 1.7e-5 |
| Browser zoom 2, both | 0 |
| `--force-device-scale-factor` 1.25 / 1.5 / 1.875 / 2 | 7.6e-6 / 7.6e-6 / 1.7e-5 / 0 |
| CDP `deviceScaleFactor` 1.25 / 1.5 / 1.875 / 2 | 0 |

`probe-direct.mjs` (`zooms`, `mixed`, `sweep`) on text-dom alone added these:

- browser zoom 1.1 and 0.9: 1.3e-5 and 1.1e-5;
- real DSF 1.25 under CDP emulation 1, 1.5 and 2, and real DSF 1.5 under emulation 1.25: 7.4e-6, 7.4e-6, 7.4e-6 and 7.1e-6;
- the `REFERENCE_SCALE` sweep above at every zoom: at most 1.7e-5.

The residual is the browser's float32 rect values times `E`, far under 1/64. Lines, clusters and fallbacks are unchanged everywhere. The figures above are from the review r1 version (detection on every request); the r1 follow-ups re-ran `probe.mjs` and `probe-direct.mjs` and gave the same numbers.

`pnpm test:m6c-u0-zoom` (the 46 A12 cases in the test font alone): max delta 1.2e-5 px at real DSF 1.25 and 1.3e-5 at 1.875 (`(b) runs and LF at width 0`), with the host at `zoom: 1/E` and no host style change across a second pass at the stable ratio. On the unfixed `measure.ts` (e8d3489) the same spec fails: 117 lengths beyond 1/64 px (first `lineHeight 0.5`: height 68.5625 against 68.59375), and no host zoom.

Per-request cost, `probe-direct.mjs cost`: the fifteen requests × 100 rounds at a stable zoom, three runs each, in ms per request, and host style changes over the 1500 requests:

| Build | Zoom 1 | Zoom 1.25 | Host style changes (zoom 1 / 1.25) |
| --- | --- | --- | --- |
| e8d3489 (before U0) | 1.04 to 1.18 | 0.99 to 1.07 | 0 / 0 |
| 9ea2c34 (detection on every request) | 1.40 to 1.56 | 1.38 to 1.51 | 4500 / 7500 |
| r1 follow-ups (detection on a ratio change) | 1.06 to 1.15 | 1.03 to 1.07 | 0 / 0 |

Checks:

- `npx vitest run tests/unit/m6c-u0-text-dom-zoom.test.ts tests/unit/m6a-u4-text-dom.test.ts`: 63 passed (r1 follow-ups; 56 before).
- `pnpm test:m6c-u0-zoom` with `M6C_U0_ZOOM_CHROMIUM`: 1 passed.
- `pnpm run test:unit`: 4735 passed, 1 failed (r1 follow-ups; 4723 before). The failure is `tests/unit/p3-b0r-identity.test.ts`, which fails the same way on the base `e8d3489` without this change: it is unrelated to text-dom and plausibly the container's Node 22 against the pinned 24.
- `pnpm run format:check`, `pnpm run lint` (with `NODE_OPTIONS=--max-old-space-size=10240`, since `eslint .` ran out of the default heap here), `pnpm run typecheck` and `pnpm run check:boundaries`: all PASS.
- `pnpm test:m6a-next-host` as the headless smoke (`M6A_NEXT_HOST_CHROMIUM`, CDP DSF 1 as in the headed projects): 10 of 11 passed, including every A11 fixture against the unprobed reference blocks, **A12 by emulation at DPR 1, 1.25, 1.5 and 2**, and **size linearity**. The failure is carry list (h), the atlas renderer case on the playground page. It needs the geometry kernel WASM, which the container cannot build (pinned Rust missing), so it is NOT RUN here and unrelated to measurement.
- The headed M6a-A11 and A12 runs in Chrome and Edge on the main PC: NOT RUN.

**Disclosed effect.** The port's positions now equal its zoom-1 layout, while the browser's own flowed layout keeps the zoomed rounding. The M6a spec was run once under `--force-device-scale-factor` 1.25 and 1.875, a condition outside M6a-A11, which emulates DSF 1. That run used an uncommitted copy of `playwright.m6a-next-host.config.ts` whose smoke project adds `--force-device-scale-factor=<scale>` to its launch arguments; it is not reproducible from the repository as committed. There, "every fixture agrees with an unprobed reference block" fails by up to 1/32 px (the 0.5-line-height and title cases), because the reference block lies in the page at the page's zoom. At 1.5 it passed. That is the expected price of rule (a): the port no longer follows the page's zoom. It matters for M6c-U3 only as the recorded layout term (section 1.2), since placed DOM clusters sit at the port's positions. The same run on the unfixed build is NOT RUN, but by construction the reference block and the port then round alike.

Per section 3's rule this is (a), light tier: no interface change. M6a-A12's bound stays at 1/64 px if the main-PC re-run of the manual rows passes.

## Main-PC re-run (M6c-A01), 2026-10-31

The re-run is recorded as a dated section of [m6a-a12-dpr-manual.md](../m6a-a12-dpr-manual.md#re-run-2026-10-31-m6c-u0-commit-9ea2c34).

It ran at `9ea2c34`, **automated** with `probe.mjs`:

- real browser zoom in Edge 156 and Playwright Chromium 151;
- a real device scale (`--force-device-scale-factor`) and CDP emulation in those two and in Chrome 156.

Branded Chrome ignores `--load-extension`, so it has no browser-zoom rows.

Results:

- Every condition PASSes the 1/64 px position bound. The maximum is 1.62e-5 px, and lines, clusters and fallbacks are unchanged.
- `pnpm test:m6a-next-host` headed Chrome and Edge: 22 of 22 PASS (M6a-A11, and A12 by emulation).
- `pnpm test:geometry`: PASS.

The first run left the record's bump rule unresolved: the no-reload zoom rows were reported with 0 bumps since paste, though one truncated Edge run showed 1.

A follow-up run at `83822bf` closed it. `probe.mjs` now waits up to 5 s for the bump. The run used Playwright Chromium 151 and Edge 156:

- 17 of 17 PASS each, identical line for line.
- Every zoom row printed `bump after the zoom change: yes`. The no-reload rows show generation 4 and 1 bump; the reload rows show generation 3 and 0.
- The deltas are unchanged, at most 1.6212e-5.
- `pnpm test:m6c-u0-zoom` passed, 1 of 1.

The first run's 0 bumps were the read racing the `resolution` listener.

Still NOT RUN:

- the hand-run rows (Ctrl +/- and a real Windows display-scale change);
- the combined DPR 1.875 row (a real device scale of 1.5 with browser zoom 125 %; only browser zoom 1.875 and a forced device scale of 1.875 ran, each on its own);
- browser zoom in branded Chrome.

The main-PC run predates `3a293c6`, the review r1 follow-ups: detection cached on a ratio change, the zoom check and `pnpm test:m6c-u0-zoom`. Those leave positions unchanged, as the container's `probe.mjs` shows with the same deltas before and after. The probe's bump wait and `test:m6c-u0-zoom` then ran on the main PC at `83822bf`.

**Review r2 fix: a zoom read while hidden is not kept.** When a request runs while the host has no layout box, the layout unit reads 0. That happens when `<body>` or an ancestor is `display: none`. At `83822bf`, `layoutZoom` then returned 1, and that 1 was cached for the ratio, so every later layout carried the pre-fix error until the ratio changed.

`layoutZoom` and `cancelLayoutZoom` now return null when the host has no layout box or no unit reads back. The measurer then uses zoom 1 for that request and keeps nothing, so the next request detects again.

It is gated in two places:

- a unit test;
- a second test in `tests/m6c-u0-zoom/`: hide `<body>`, change the ratio by CDP emulation (the layout zoom stays the real scale), lay out one request, show the page, and lay out the 46 cases.

Results:

- **Fixed build:** max delta 1.2e-5 at 1.25 and 1.3e-5 at 1.875, with the host at zoom 1/E.
- **`83822bf`'s `measure.ts`:** the same test fails, with the host left at zoom 1 and 119 lengths beyond 1/64 px (max 0.03125 at 1.25 and 0.0272 at 1.875).

Unit tests: 65 passed. `pnpm test:m6c-u0-zoom`: 2 passed.

**Owed.** This commit is container-verified only. A main-PC run at the final code is owed before M6c-U3 and the M6c exit, not before U0 merges: `probe.mjs` in Edge, `pnpm test:m6c-u0-zoom` and headed `pnpm test:m6a-next-host`. **Amended 2026-10-31 (M6c-U3 review r1):** M6c-U3 changed text-dom's measured layout (M6a section 4, M6c-U3 amendments), so this run is owed at or after the final M6c-U3 commit, not before it.
