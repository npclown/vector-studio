# M6a-A12 manual DPR record (browser zoom and monitor scale)

**Status: FILLED 2026-10-30, result FAIL.** The user ran it on the main PC; zoom 125 % (DPR 1.25 and 1.875) exceeds the 1/64 px bound, DPR 1.5 passes, line breaks and fallbacks are unchanged everywhere. The M6a exit was accepted with this result disclosed ([exit record](m6a-exit-2026-10-30.md)).

[M6a-A12](../plans/mvp-m6a-text-model-contract.md#10-acceptance-criteria) asks for identical line breaks and positions within 1/64 px across DPR 1, 1.25, 1.5 and 2. It also asks for the same across browser zoom 100 % and 125 % and across monitor scale 100 % and 150 %, plus a generation bump on each DPR change. The headed spec `tests/m6a-next-host/m6a-next-host.spec.ts` covers DPR 1 to 2 by CDP emulation and size linearity (`pnpm test:m6a-next-host`). This record covers the two cases emulation cannot reach (section 3.2, handed over from M6-S0). M6-Q3 is already (b) (U4c, #388); a failure here needs a contract amendment before M6c.

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

Commit (`git rev-parse --short HEAD`): `e66ae55` Date: 2026-10-30 Monitors (resolution and Windows scale): one monitor; the 150 % rows change the Windows display scale from 100 % to 150 % (the single-monitor alternative of step 5)

| Browser | Case | Reload | Printed line |
| --- | --- | --- | --- |
| Chrome | reset: zoom 100 %, monitor 100 % | - | reference stored at zoom/DPR 1, generation 5, bumps since paste 2, new fallbacks 0 |
| Chrome | zoom 125 %, monitor 100 % | no | FAIL: zoom/DPR 1.25, generation 7, bumps since paste 4, new fallbacks 0, requests with other breaks 0, max position delta 0.03125 |
| Chrome | zoom 125 %, monitor 100 % | yes | FAIL: zoom/DPR 1.25, generation 3, bumps since paste 0, new fallbacks 0, requests with other breaks 0, max position delta 0.03125 (same line on a second reload) |
| Chrome | zoom 100 %, monitor 150 % (Windows scale) | no | NOT RUN |
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

Result: **FAIL** (pass rule: each reset line prints "reference stored", every other line prints PASS with new fallbacks 0, and every "no reload" row shows at least 1 bump). Every row with browser zoom 125 % fails in both browsers: max position delta 1/32 px (0.03125) at DPR 1.25 and 0.0273 px at DPR 1.875, against the 1/64 px bound, with or without a reload. DPR 1.5, by monitor scale or by browser zoom 150 %, passes at 0.0104 px. In every row the line breaks and clusters match the reference, new fallbacks are 0, and every "no reload" row bumped the generation. The CDP emulation at DPR 1.25 in the headed spec passes, so the difference is specific to browser zoom (which also changes the CSS layout scale), not to the device pixel ratio alone. Root cause not yet analysed; per the contract this failure needs a fix or a contract amendment before M6c.
