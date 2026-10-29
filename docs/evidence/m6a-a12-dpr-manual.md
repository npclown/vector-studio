# M6a-A12 manual DPR record (browser zoom and monitor scale)

**Status: TEMPLATE, not filled.** The user fills it on the main PC. Until then, the manual half of M6a-A12 is NOT RUN.

[M6a-A12](../plans/mvp-m6a-text-model-contract.md#10-acceptance-criteria) asks for identical line breaks and positions within 1/64 px across DPR 1, 1.25, 1.5 and 2. It also asks for the same across browser zoom 100 % and 125 % and across monitor scale 100 % and 150 %, plus a generation bump on each DPR change. The headed spec `tests/m6a-next-host/m6a-next-host.spec.ts` covers DPR 1 to 2 by CDP emulation and size linearity (`pnpm test:m6a-next-host`). This record covers the two cases emulation cannot reach (section 3.2, handed over from M6-S0). If any case below fails, contract section 3.2 applies: M6-Q3 switches to (b), a fixed reference scale, by an amendment before M6c.

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

Commit (`git rev-parse --short HEAD`): \_\_\_ Date: \_\_\_ Monitors (resolution and Windows scale): \_\_\_

| Browser | Case | Reload | Printed line |
| --- | --- | --- | --- |
| Chrome | reset: zoom 100 %, monitor 100 % | - | |
| Chrome | zoom 125 %, monitor 100 % | no | |
| Chrome | zoom 125 %, monitor 100 % | yes | |
| Chrome | zoom 100 %, monitor 150 % (window moved) | no | |
| Chrome | zoom 100 %, monitor 150 % (window moved) | yes | |
| Chrome | zoom 125 %, monitor 150 % | yes | |
| Edge | reset: zoom 100 %, monitor 100 % | - | |
| Edge | zoom 125 %, monitor 100 % | no | |
| Edge | zoom 125 %, monitor 100 % | yes | |
| Edge | zoom 100 %, monitor 150 % (window moved) | no | |
| Edge | zoom 100 %, monitor 150 % (window moved) | yes | |
| Edge | zoom 125 %, monitor 150 % | yes | |

Browser versions (`chrome://version`, `edge://version`): \_\_\_

Result: \_\_\_ (A12 manual half PASS when each reset line prints "reference stored", every other line prints PASS with new fallbacks 0, and every "no reload" row shows at least 1 bump.)
