# M6-S0 text spike: pages, scripts and how to run them

Tooling for the [M6 text plan](../../plans/mvp-m6-text-plan.md)'s spike M6-S0 (section 8, light tier). It measures the four layout and rendering hypotheses and records Korean IME traces. It is playground and evidence tooling only. No package imports it, and it adds no dependency: it uses the repo's pinned Playwright (`@playwright/test` 1.62.1) and Vite.

| Part | Plan reference | File |
| --- | --- | --- |
| Measurement page | 4.1 | `apps/playground/m6-s0-text-layout.html`, `apps/playground/src/m6-s0-text-layout.ts` |
| (a) DOM layout throughput, 1,000 nodes | 8 (M6-S0 row) | `layout-throughput.mjs` |
| (b) DPR hypothesis, DPR 1, 1.25, 1.5 and 2 | 4.1 | `dpr-layout.mjs` |
| (c) Fallback hypothesis, DOM vs canvas, `document.fonts` vs `self.fonts` | M6-F2 | `fallback.mjs` |
| (d) Canvas vs DOM ink boxes per cluster | M6-G2, M6-G3 | `ink-boxes.mjs` |
| Korean IME recorder | 9 (recorder cases) | `apps/playground/m6-s0-ime-recorder.html`, `apps/playground/src/m6-s0-ime-recorder.ts` |
| Recorder smoke check (synthetic CDP, not a trace) | none | `recorder-smoke.mjs` |
| All of (a) to (d) for one browser | none | `run-all.mjs` |

The page lays text out the way the planned `text-dom` service would. It uses a hidden element in its own shadow root with `all: initial` and `lang="ko"`. The element sets `white-space: pre-wrap`, `font-variant-ligatures: none`, `word-break: keep-all` and `overflow-wrap: anywhere` (M6-Q13 (a)), with one span per run and the M6-F2 font list `"<family>", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`. It reads each grapheme cluster (`Intl.Segmenter`) with `Range.getClientRects`. Positions are CSS px relative to the block. A new line starts after an LF or when the pen moves left. The generated nodes are seeded and deterministic: 3 to 25 Latin and Hangul words, 1 to 3 runs, sizes 9 to 32, 60 % with a fixed wrap width, and some LFs.

## Running on the main PC

Requirements: Windows 11, Chrome and Edge installed (the branded channels), hardware GPU. Do not set `M6S0_CHROMIUM` or `SWIFTSHADER`. Run from the repo root in PowerShell:

```powershell
pnpm install --frozen-lockfile
# Power source as observed (docs/benchmarks/README.md); the machine label is yours to choose
$env:POWER = 'AC, Windows power mode Best performance'; $env:MACHINE_LABEL = 'main-pc'
# Chrome (default channel), headed
node docs/evidence/m6-s0/run-all.mjs
# Edge
$env:CHANNEL = 'msedge'; node docs/evidence/m6-s0/run-all.mjs; Remove-Item Env:CHANNEL
```

No `pnpm build` is needed. Each script starts the playground's Vite dev server on a free port, unless `BASE` names a running one. It then launches the browser headed and writes one JSON report to `docs/evidence/m6-s0/runs/<name>-<channel>-<timestamp>.json`. Every report holds the [benchmark metadata](../../benchmarks/README.md) the spike can collect:

- the commit, and the dirty state of tracked files (untracked files such as the reports do not count). A dirty run also records `diffSha256`, the SHA-256 of `git diff HEAD`, and `diffFiles`;
- `MACHINE_LABEL` (default `main-pc`; the hostname is never written, because the repo is public);
- OS release, CPU, logical cores, total memory, timezone and UTC offset;
- `POWER` as you supply it (or an unavailable reason);
- browser version, user agent and `userAgentData` (`platformVersion` 13 or above is Windows 11);
- the launch options, the CSS and physical viewport, and the DPR;
- the WebGL renderer string (check that it names the real GPU, not SwiftShader);
- the `document.fonts` state, the font list and a minimum-font-size probe (`page.minimumFontSize`: the width of a 9 px run against half the 18 px width; `clampSuspected` is true above 1.02);
- a note that Playwright stays attached over CDP for the whole run.

Read the timing figures with the CDP attachment in mind. Prettier skips these JSON files, so commit them unchanged.

Run one script alone the same way, for example `node docs/evidence/m6-s0/ink-boxes.mjs`. Variables:

| Variable | Default | Used by |
| --- | --- | --- |
| `CHANNEL` | `chrome` | all (`msedge` for Edge) |
| `HEADLESS` | `0` | all (`1` runs the branded browser headless; not evidence) |
| `FAMILIES` | `Arial,Malgun Gothic,Segoe UI` | (a), (b) |
| `LATIN_FAMILY` | `Arial` | (c), (d) (the Latin-only family that gets Hangul) |
| `KO_FAMILY` | `Malgun Gothic` | (d) |
| `MACHINE_LABEL` | `main-pc` | all (written instead of the hostname) |
| `POWER` | none (recorded as unavailable) | all (the observed power source and mode) |
| `COUNT`, `SEED`, `PASSES`, `WARMUP`, `SIZES` | `1000`, `1`, `3`, `50`, `9,12,13,16,24,32` | (a), (b) (`SIZES` also (c), default `12,16,24`) |
| `DPRS` | `1,1.25,1.5,2` for (b), `1,2` for (d) | (b), (d) (integers only for (d): its clips must map to whole device pixels) |
| `THRESHOLDS` | `16,128` (coverage out of 255) | (d) |
| `PROBE_MODES` | `spans,highlight` | (d) |
| `TEXTS` | seven Latin, Hangul, Han and mixed strings | (c) |
| `OUT_DIR` | `docs/evidence/m6-s0/runs` | all |
| `BASE` | none (start Vite) | all |
| `M6S0_CHROMIUM` | none | container only: a Chromium executable, run headless (not evidence) |

### What each report answers

- **(a) `layout-throughput`.** `summary` gives, per pass, total ms, wall ms, mean, p95 and max ms per node, and µs per cluster. `passes` splits building the spans, segmenting, and the forced layout plus the cluster reads. Pass 0 includes the first use of each font after the warm-up. Timer resolution is the page's `performance.now` without cross-origin isolation, about 0.1 ms. So per-node values are only meaningful as means.
- **(b) `dpr-layout`.** Each DPR runs in a fresh context with that `deviceScaleFactor`, and the results are compared against the first DPR. The report gives `hypothesisHolds`, then per DPR: `lineBreaksIdentical`, `positionsIdentical`, `maxDeltaCssPx` (cluster x, y, w and h, and node width and height), counts of values over 0, 0.01, 0.1 and 0.5 px, and up to 20 example nodes. `deviceScaleFactor` is emulation. It does not move the window to another monitor and it does not apply browser zoom. For those, open `/m6-s0-text-layout.html` in the browser. At each setting (monitor scale 100 % and 150 %, browser zoom 100 % and 125 %), type a label such as `monitor-150` or `zoom-125` and press the button. That downloads `m6-s0-manual-layout-<label>-dpr<N>.json`, which holds the label, the viewport and the page environment. Compare two downloads with `$env:COMPARE = 'a.json,b.json'; node docs/evidence/m6-s0/dpr-layout.mjs; Remove-Item Env:COMPARE`. That writes a `dpr-manual-compare` report to `OUT_DIR`.
- **(c) `fallback`.** For each text and size in `LATIN_FAMILY`, the report compares DOM cluster advances and the run width with OffscreenCanvas `measureText` on the main thread (with `ctx.lang = 'ko'` and without it) and in a dedicated worker. `platformFonts` lists the faces the DOM used (CDP `CSS.getPlatformFontsForNode`, family and glyph count). `worker.selfFonts` and `documentFontsSize` show the two font sets. `aliasProbe` registers a `FontFace` (a `local()` alias of `LATIN_FAMILY`) in `document.fonts` only, then measures it as `"alias", monospace`. If the worker width equals `monospaceReference`, the worker could not see the face. Per-cluster canvas widths of a kerned pair (for example `AV`) differ by design, because a lone cluster has no kerning; compare whole-run widths for those. The default texts include Han and CJK punctuation (`漢字 한자「한글」。`), whose fallback depends on `lang`. Each run uses a fresh canvas context, so a `lang` set for one case never carries into the no-lang case.

  **Decision rule.** The fallback hypothesis (M6-F2) holds on a browser when all three of these are true:

  1. `platformFonts` names the expected face for each text: the Latin family for Latin, Malgun Gothic for Hangul and Han.
  2. Whole-run widths agree with the main-thread and worker canvas within 1/64 px (`totalWithin1_64` in `summary`), except for the document-only alias rows, which test the worker on purpose.
  3. In (d), spans mode, the `hangul-in-latin` and `han-in-latin` fixtures fall within the same offset and size bounds as the Korean-family `hangul` fixture, for both the integer boxes and the subpixel measures.
- **(d) `ink-boxes`.** There are seven single-line fixtures: Latin kerning, Hangul, Hangul in the Latin family, Han and CJK punctuation in the Latin family (the same text as in (c)), mixed sizes, 12 px and 9 px. They run at DPR 1 and 2. For each cluster the DOM side is a screenshot of the visible measurement element with only that cluster painted. The canvas side is `fillText` of the cluster at the DOM x and the measured baseline, with the same font list, `lang`, DPR and clip. Coverage is `255 - min(R, G, B)` over white, so ClearType colour fringes count. Ink boxes at each threshold are compared in CSS px: `offset` is the larger of the left and top edge shifts, and `sizeDiff` is the larger of the width and height differences (M6-G2 proposes ≤ 0.5 and ≤ 1 px). At DPR 1, integer pixel boxes move in whole pixels and cannot decide a 0.5 px tolerance. So each cluster also has `subpixel` measures, and each run has `subpixelMaxima`; the table columns are `subOffset`, `subSizeDiff` and `centroid`. These measures are coverage-weighted edges (an edge column or row with coverage c puts the edge c inside its far side), the coverage centroid (first moment), and the coverage mass ratio. They ignore coverage of 2/255 or less, and they are the figures to set the M6c tolerance from. The `spans` mode isolates a cluster by giving it its own span and toggling its colour. `layoutDelta` is the largest change that this causes in the cluster rects against unsplit text. The `highlight` mode uses a CSS custom highlight and makes no DOM change, but Chrome clips highlight painting to the range box. In the container this cut the ink of overhanging kerned glyphs (size difference up to 3 px), so treat the `spans` rows as the measurement and the `highlight` rows as a method check. `allShownVsPlainPx` counts the pixels that differ between all clusters shown through the mode and ordinary black text.

## Korean IME recorder

Playwright cannot drive an OS IME, so the recorder is used by hand on the main PC:

1. In the repo root, run `pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4176 --strictPort`. Then open `http://127.0.0.1:4176/m6-s0-ime-recorder.html` in Chrome, and again in Edge.
2. Fill in the metadata: the Microsoft IME version, the IME mode, the Windows version (`winver`) and notes. The mode is either current or "Use previous version of Microsoft IME", found under Settings › Time & language › Language & region › Korean › Language options › Microsoft IME › Keyboard options › Compatibility (the path varies by build).
3. Pick a case. The page shows its steps, with keys for the 2-set layout. The cases are a final consonant moving into the next syllable, Backspace in an empty textarea after a commit, a click during composition that keeps focus (the `pointerdown`-prevented button, and a `mousedown`-prevented button for comparison), a click during composition that moves focus, arrows during composition, Escape during composition, and a host force-end. Click the dashed box to focus the hidden textarea and follow the steps. The box mirrors the textarea value and selection. The log shows every event live.
4. Press **Download JSON** (or **Copy JSON**). Export warns if the IME version is empty. Each event records its sequence, `timeStamp`, `performance.now`, two group ids, a frame counter, the case, `type`, target, `key`, `code`, `keyCode`, `isComposing`, `data`, `inputType`, the textarea value and selection, and the active element. The two group ids are `beforeMessage` (events seen before a posted `MessageChannel` message runs) and `beforeTimeout` (the same with `setTimeout(0)`). Neither is a true task id, because an input task queued before the message shares it. M6-E4's "compositionend then compositionstart in the same task" ordering is read as the same `beforeMessage` id.
5. Record every case in Chrome and Edge, once in each IME mode. Record the final-consonant case twice in each, once with **Clear textarea after each commit** on and once with it off. Use **Clear log** between files (it also resets the trace's start time), and put the traces in `docs/evidence/m6-s0/traces/`.

**Clear textarea after each commit** copies the planned product reset. The textarea is emptied when the posted message runs after a `compositionend`, unless a `compositionstart` came first, and also after a non-composition insertion. M6b must define its reset by this same posted-message mechanism, or record the one it uses instead, because the traces only show what this mechanism sees. The final-consonant and Backspace cases turn it on.

**Host force-end** (its own case) copies M6-E4's interrupt. During a composition it blurs the textarea, clears it and focuses it again, logging an `m6s0-force-end` entry after each step. Its `pointerdown` and `mousedown` are prevented, so the click does not move focus. The trace shows whether a late `compositionend` arrives after the reset, which the host must then drop.

`node docs/evidence/m6-s0/recorder-smoke.mjs` drives the recorder with CDP `Input.imeSetComposition` and `Input.insertText`. It checks that every event type is logged and that the download and the clipboard copy hold the same trace. It proves the page works; it is not an IME trace.

## Container runs are not evidence

The cloud container has headless Chromium only, with no branded browsers, no hardware GPU, no Windows fonts and no OS IME (plan section 9). The scripts were run there with `M6S0_CHROMIUM=/opt/pw-browsers/chromium`, `FAMILIES='Liberation Sans,WenQuanYi Zen Hei,DejaVu Sans'`, `LATIN_FAMILY='Liberation Sans'` and `KO_FAMILY='WenQuanYi Zen Hei'`. Those runs only show that the scripts work. Their reports set `evidence: false` and are not committed. M6-S0 evidence comes from the main PC.
