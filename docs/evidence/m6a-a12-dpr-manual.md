# M6a-A12 manual DPR record (browser zoom and monitor scale)

**Status: FILLED 2026-10-30, result FAIL. Re-run 2026-10-31 at `9ea2c34`, automated (last section): PASS on the 1/64 px position bound; bump rule unresolved; hand-run rows NOT RUN.** The user ran it on the main PC; zoom 125 % (DPR 1.25 and 1.875) exceeds the 1/64 px bound, DPR 1.5 passes, line breaks and fallbacks are unchanged everywhere. The M6a exit was accepted with this result disclosed ([exit record](m6a-exit-2026-10-30.md)).

[M6a-A12](../plans/mvp-m6a-text-model-contract.md#10-acceptance-criteria) asks for identical line breaks and positions within 1/64 px across DPR 1, 1.25, 1.5 and 2. It also asks for the same across browser zoom 100 % and 125 % and across monitor scale 100 % and 150 %, plus a generation bump on each DPR change. The headed spec `tests/m6a-next-host/m6a-next-host.spec.ts` covers DPR 1 to 2 by CDP emulation and size linearity (`pnpm test:m6a-next-host`). This record covers the two cases emulation cannot reach (section 3.2, handed over from M6-S0). M6-Q3 is already (b) (U4c, #388); a failure here needs a fix or a contract amendment before M6c.

## Setup

1. From the repo root: `pnpm build`, then `pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4186`.
2. Open `http://127.0.0.1:4186/?fixture=text&test=1` in the browser under test. Wait until the status line's `data-fixture` is `loaded` and its `data-text-font` is `loaded`.
3. Open DevTools (F12), then the Console. Paste the snippet below once per page load. It installs `m6aA12()`. The first time, Chrome and Edge refuse the paste and ask you to type `allow pasting` and press Enter; do that, then paste again.
4. Start at browser zoom 100 % (Ctrl+0) on the monitor you set to 100 % scale. Run `m6aA12('reset')`. This stores the reference layouts in this origin's `localStorage`. Do this in each browser, since Chrome and Edge keep separate storage.
5. For each row of the table: change the zoom (Ctrl and +/-), or move the window to the other monitor (with a single monitor, change the Windows display scale instead and say so in the row), without reloading, and run `m6aA12()`. Then reload the page, paste the snippet again and run `m6aA12()` again. Copy the printed line into the table.

The snippet lays out a fixed set of requests through the page's text-dom port. It compares each layout with the stored reference: the same lines and clusters, and every position within 1/64 px. A run also fails when the port counts a new fallback (`fallbacks` must stay unchanged). It also prints how many generation bumps the port raised since the snippet was pasted, so a zoom or monitor change without a reload should show at least 1.

```js
(() => {
  const port = window.__p5Host.text.port;
  const F = 'Noto Sans KR';
  const run = (text, size = 20, family = F) => ({ text, family, size });
  const req = (runs, extra = {}) => ({ runs, width: null, align: 'left', letterSpacing: 0, lineHeight: 1.2, ...extra });
  const requests = [
    req([run('Hello world')]),
    req([run('Hello wonderful world of text layout')], { width: 120 }),
    req([run('한글 편집기 벡터 안녕하세요')], { width: 90 }),
    req([run('Ab', 24), run('한글', 40), run('xy', 16)]),
    req([run('ab\n')]),
    req([run('a\n\nb')]),
    req([run('line one two three four')], { width: 60, lineHeight: 0.5 }),
    req([run('「한글」、가。a가（나）')]),
    req([run('abc אבג def')]),
    req([run('ab cd ef')], { width: 50, align: 'right' }),
    req([run('abc')], { letterSpacing: -0.8 }),
    req([run('aaaa bbbb ', 10), run('CCCC', 40)], { width: 60 }),
    req([run('CC ', 40), run('aaaaaaaa', 10)], { width: 70 }),
    req([run('Title\n', 40), run('body text here wraps around', 12)], { width: 80 }),
    req([run('aaaa bbbb cccc dddd')], { width: 50, lineHeight: 0.3 }),
  ];
  let bumps = 0;
  port.subscribe(() => { bumps += 1; });
  const shape = (r) => JSON.stringify([r.lines.map((l) => [l.start, l.end]), r.clusters.map((c) => [c.start, c.end, c.line])]);
  const numbers = (r) => [r.width, r.height, ...r.lines.flatMap((l) => [l.top, l.height, l.baseline, l.left, l.width]), ...r.clusters.flatMap((c) => [c.x, c.y, c.advance])];
  window.m6aA12 = (mode) => {
    const before = port.fallbacks;
    const results = requests.map((r) => port.layout(r));
    const fallbacks = port.fallbacks - before;
    const label = `zoom/DPR ${devicePixelRatio}, generation ${port.generation}, bumps since paste ${bumps}, new fallbacks ${fallbacks}`;
    if (mode === 'reset') {
      localStorage.setItem('m6a-a12', JSON.stringify(results));
      console.log(`${fallbacks === 0 ? 'reference stored' : 'FAIL: fallbacks while storing the reference'} at ${label}`);
      return;
    }
    const reference = JSON.parse(localStorage.getItem('m6a-a12') ?? 'null');
    if (reference === null) return console.log('no reference: run m6aA12("reset") at 100 % first');
    let breaks = 0;
    let worst = 0;
    results.forEach((r, i) => {
      if (shape(r) !== shape(reference[i])) breaks += 1;
      else numbers(r).forEach((v, k) => { worst = Math.max(worst, Math.abs(v - numbers(reference[i])[k])); });
    });
    const pass = breaks === 0 && worst <= 1 / 64 && fallbacks === 0;
    console.log(`${pass ? 'PASS' : 'FAIL'}: ${label}, requests with other breaks ${breaks}, max position delta ${worst}`);
  };
  console.log('m6aA12 installed');
})();
```

## Record

Commit (`git rev-parse --short HEAD`): `e66ae55` Date: 2026-10-30 Monitors (resolution and Windows scale): one monitor (resolution not recorded); the 150 % rows change the Windows display scale from 100 % to 150 % (the single-monitor alternative of step 5)

| Browser | Case | Reload | Printed line |
| --- | --- | --- | --- |
| Chrome | reset: zoom 100 %, monitor 100 % | - | reference stored at zoom/DPR 1, generation 5, bumps since paste 2, new fallbacks 0 |
| Chrome | zoom 125 %, monitor 100 % | no | FAIL: zoom/DPR 1.25, generation 7, bumps since paste 4, new fallbacks 0, requests with other breaks 0, max position delta 0.03125 (a second attempt, a fresh reset then zoom 125 % without a reload, printed the same FAIL line with bumps since paste 2) |
| Chrome | zoom 125 %, monitor 100 % | yes | FAIL: zoom/DPR 1.25, generation 3, bumps since paste 0, new fallbacks 0, requests with other breaks 0, max position delta 0.03125 (same line on a second reload) |
| Chrome | zoom 100 %, monitor 150 % (Windows scale) | no | not captured (no printed line recorded) |
| Chrome | zoom 100 %, monitor 150 % (Windows scale) | yes | PASS: zoom/DPR 1.5, generation 5, bumps since paste 0, new fallbacks 0, requests with other breaks 0, max position delta 0.0104217529296875 |
| Chrome | zoom 125 %, monitor 150 % | no (zoomed after the paste; the reload row was not run) | FAIL: zoom/DPR 1.875, generation 5, bumps since paste 2, new fallbacks 0, requests with other breaks 0, max position delta 0.02728271484375 |
| Chrome | extra: zoom 150 %, monitor 100 % | no | PASS: zoom/DPR 1.5, generation 10, bumps since paste 7, new fallbacks 0, requests with other breaks 0, max position delta 0.0104217529296875 |
| Chrome | extra: zoom 150 %, monitor 100 % | yes | PASS: zoom/DPR 1.5, generation 3, bumps since paste 0, new fallbacks 0, requests with other breaks 0, max position delta 0.0104217529296875 |
| Edge | reset: zoom 100 %, monitor 100 % | - | reference stored at zoom/DPR 1, generation 3, bumps since paste 0, new fallbacks 0 |
| Edge | zoom 125 %, monitor 100 % | no | FAIL: zoom/DPR 1.25, generation 5, bumps since paste 2, new fallbacks 0, requests with other breaks 0, max position delta 0.03125 |
| Edge | zoom 125 %, monitor 100 % | yes | FAIL: zoom/DPR 1.25, generation 3, bumps since paste 0, new fallbacks 0, requests with other breaks 0, max position delta 0.03125 |
| Edge | zoom 100 %, monitor 150 % (Windows scale) | no | PASS: zoom/DPR 1.5, generation 6, bumps since paste 3, new fallbacks 0, requests with other breaks 0, max position delta 0.0104217529296875 |
| Edge | zoom 100 %, monitor 150 % (Windows scale) | yes | PASS: zoom/DPR 1.5, generation 3, bumps since paste 0, new fallbacks 0, requests with other breaks 0, max position delta 0.0104217529296875 |
| Edge | zoom 125 %, monitor 150 % | yes | FAIL: zoom/DPR 1.875, generation 3, bumps since paste 0, new fallbacks 0, requests with other breaks 0, max position delta 0.02728271484375 |

Browser versions (from the executables): Chrome 156.0.8078.74, Edge 156.0.4314.50

Result: **FAIL** (pass rule: each reset line prints "reference stored", every other line prints PASS with new fallbacks 0, and every "no reload" row shows at least 1 bump). Every row with browser zoom 125 % fails in both browsers: max position delta 1/32 px (0.03125) at DPR 1.25 and 0.0273 px at DPR 1.875, against the 1/64 px bound, with or without a reload. DPR 1.5, by monitor scale or by browser zoom 150 %, passes at 0.0104 px. In every row the line breaks and clusters match the reference, new fallbacks are 0, and every "no reload" row with a printed line bumped the generation (the Chrome monitor-150 % no-reload line was not captured). The headed spec's CDP emulation at DPR 1.25 passed at `045fcf9` (exit record, M6a-A12; its own request set, same 1/64 px bound), and browser zoom 150 % passes here, so the difference appears with browser zoom 125 % (DPR 1.25 and 1.875), not with the device pixel ratio alone. Root cause not yet analysed; per the contract this failure needs a fix or a contract amendment before M6c.

## Re-run 2026-10-31 (M6c-U0, commit 9ea2c34)

**Method: AUTOMATED, not by hand.** The re-run that [M6c contract section 3](../plans/mvp-m6c-gpu-text-contract.md#3-zoom-125--investigation-u0-first) asks for ran on the main PC at `9ea2c34` (the M6c-U0 text-dom fix, [U0 evidence](m6c-u0/README.md)). It used [`docs/evidence/m6c-u0/probe.mjs`](m6c-u0/probe.mjs) against `next start` on 127.0.0.1:4186.

The probe runs [`m6c-u0-snippet.mjs`](m6c-u0/m6c-u0-snippet.mjs): the snippet above, with the same fifteen requests, reference key and position bound, plus a per-request printout. It runs the snippet on `?fixture=text&test=1` under three kinds of condition, against a reference stored at layout zoom 1:

- **Real browser zoom**, set through `chrome.tabs.setZoom` by a throwaway extension, without and with a reload.
- **A real device scale**, set by `--force-device-scale-factor`.
- **CDP `deviceScaleFactor` emulation.**

Versions: Node 24.22.1, pnpm 11.1.2, Playwright 1.62.1. Browsers: Playwright Chromium 151.0.7922.34, Chrome 156.0.8078.74 and Edge 156.0.4314.50, all headless. GPU adapter as reported by `navigator.gpu`: "nvidia | turing".

Which row of the record each condition stands in for:

| Condition | Stands in for |
| --- | --- |
| Browser zoom 1.25 | zoom 125 %, monitor 100 % |
| Browser zoom 1.5 | the extra zoom 150 % rows |
| Browser zoom 1.875 | the zoom part of zoom 125 % at monitor 150 % (DPR 1.875) |
| `--force-device-scale-factor` 1.5 | zoom 100 %, monitor 150 % (a real device scale, as the Windows display scale gives) |
| `--force-device-scale-factor` 1.25 and 1.875 | real device scales at the record's other two DPRs |

Browser zoom 2 and the emulation rows have no row in the record.

| Browser | Condition | Max position delta (px) | Generation, bumps since paste, new fallbacks | Result |
| --- | --- | --- | --- | --- |
| Playwright Chromium 151 | zoom 1, same page | 0 | 3, 0, 0 | PASS |
| Playwright Chromium 151 | browser zoom 1.25, no reload and reload | 1.1444e-5 (request 7, s 64, `width`) | 3, 0, 0 (as reported) | PASS on position |
| Playwright Chromium 151 | browser zoom 1.5, both | 7.629e-6 (request 1, s 64, cluster 27 `x`) | as above | PASS on position |
| Playwright Chromium 151 | browser zoom 1.875, both | 1.6212e-5 (request 7, s 64, `width`) | as above | PASS on position |
| Playwright Chromium 151 | browser zoom 2, both | 0 | as above | PASS on position |
| Playwright Chromium 151 | `--force-device-scale-factor` 1.25 / 1.5 / 1.875 / 2 | 1.1444e-5 / 7.629e-6 / 1.6212e-5 / 0 | 3, 0, 0 | PASS |
| Playwright Chromium 151 | CDP emulation 1.25 / 1.5 / 1.875 / 2 | 0 | 3, 0, 0 | PASS |
| Edge 156 | every condition above, original script | identical to Playwright Chromium | as reported, see the bump note | PASS on position (17 of 17 lines) |
| Chrome 156 | browser zoom | not runnable: branded Chrome ignores `--load-extension`, and the probe timed out waiting for the extension's service worker | - | NOT RUN |
| Chrome 156 | `--force-device-scale-factor` 1.25 / 1.5 / 1.875 / 2 (a copy of the probe with the browser-zoom part commented out) | 1.1444e-5 / 7.629e-6 / 1.6212e-5 / 0 | 3, 0, 0 | PASS |
| Chrome 156 | CDP emulation 1.25 to 2 | 0 | 3, 0, 0 | PASS (8 of 8 lines) |

In every row, lines and clusters match the reference and new fallbacks are 0.

Also on the main PC at `9ea2c34`:

- `pnpm test:m6a-next-host`, headed Chrome and Edge: **22 of 22 PASS**. This is M6a-A11, and A12 by emulation, including "a DPR change raises the generation" under emulation.
- `pnpm test:geometry`: PASS (1217 passed, 6 skipped).

**NOT RUN:**

- The hand-run rows: browser zoom by Ctrl +/- and a real change of the Windows display scale. The automated browser zoom and real device scale stand in for them, as the table says.
- The combined row, a real device scale of 1.5 with browser zoom 125 % (DPR 1.875 by monitor scale and zoom). Only browser zoom 1.875 and a forced device scale of 1.875 ran, each on its own.
- Browser zoom in branded Chrome.

**Bump rule: unresolved on the main PC, a finding, not a PASS.** The record's pass rule asks each no-reload row for at least one generation bump.

How the probe orders a no-reload row at `9ea2c34`:

1. Open the page and paste the snippet, which subscribes its counter at paste.
2. Inject the stored reference and read at zoom 1.
3. Call `chrome.tabs.setZoom`, then wait until `devicePixelRatio` reads the new value.
4. Read immediately with `m6aA12()`.

So a bump from text-dom's `(resolution: Ndppx)` listener can be counted. The method does not rule it out, and the rule applies.

In the container (Chromium 153, headless, extension zoom), the bump has always arrived by the time `devicePixelRatio` reads the new value:

- every no-reload row of `probe.mjs` printed generation 4 and 1 bump since paste;
- a separate check of zoom 1 to 1.25, 1.5, 1.875 and 2 counted 1 bump when the new ratio was first read, after two animation frames and after 200 ms, 8 of 8 times.

On the main PC the no-reload rows are reported with 0 bumps since paste. Once, a first, truncated Edge run showed generation 4 and 1 bump on "zoom 1.25, no reload" (delta 1.1444e-5, PASS); the full run did not repeat it.

So on that machine the `change` event either reached the page after the probe's read, a race the container does not show, or did not fire. Which one is not known. It cannot be read off the reported lines, since the summary gives one generation and bump figure per browser.

Since the commit that records this re-run (after `3a293c6`), `probe.mjs` waits up to 5 s for a bump after each zoom change, before reading, and prints `bump after the zoom change: yes` or `NO (5 s)`. That resolves it on the next main-PC run. The emulated DPR changes of the headed spec do bump, as its 22 of 22 shows.

**Result: PASS on the position bound (1/64 px) for every condition that ran.** Lines, clusters and fallbacks are unchanged. The maximum is 1.62e-5 px, against 0.03125 px before the fix.

The bump half of the pass rule is **unresolved** for the browser-zoom no-reload rows: reported 0 bumps, against 1 in the container and once on the main PC. The manual rows and the combined DPR 1.875 row are NOT RUN.

The run predates `3a293c6`, the M6c-U0 review r1 follow-ups: detection cached on a `devicePixelRatio` change, a check that the zoom took, and `pnpm test:m6c-u0-zoom`; the probe's bump wait came after them. Those changes leave positions unchanged: the container's `probe.mjs` gives the same deltas before and after. They are verified in the container only.
