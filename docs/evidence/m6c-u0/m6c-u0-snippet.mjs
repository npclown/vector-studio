/* global window, localStorage, devicePixelRatio */
// M6c-U0 (docs/plans/mvp-m6c-gpu-text-contract.md, section 3): the M6a-A12 manual snippet of
// docs/evidence/m6a-a12-dpr-manual.md, extended to print, for each request, its measurement
// scale `s` and the field with the largest delta against the stored reference. Same fifteen
// requests, same reference key (`m6a-a12`), same pass rule (identical lines and clusters, every
// position within 1/64 px, no new fallback). Paste it into the DevTools console of
// `/?fixture=text&test=1` once per page load; it installs `m6aA12()`.
(() => {
  const port = window.__p5Host.text.port;
  const F = 'Noto Sans KR';
  const run = (text, size = 20, family = F) => ({ text, family, size });
  const req = (runs, extra = {}) => ({
    runs,
    width: null,
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1.2,
    ...extra,
  });
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
  // text-dom's `measurementScale` (packages/text-dom/src/scale.ts).
  const scaleOf = (r) => {
    const largest = Math.max(...r.runs.map((x) => x.size));
    const units = r.runs.reduce((sum, x) => sum + x.text.length, 0) + 1;
    const extent = largest * units * Math.max(r.lineHeight, 2 + Math.max(0, r.letterSpacing));
    let s = 64;
    while (s > 1 && (largest * s > 2048 || extent * s > 2 ** 24)) s /= 2;
    return s;
  };
  let bumps = 0;
  port.subscribe(() => {
    bumps += 1;
  });
  const shape = (r) =>
    JSON.stringify([
      r.lines.map((l) => [l.start, l.end]),
      r.clusters.map((c) => [c.start, c.end, c.line]),
    ]);
  const fields = (r) => [
    ['width', r.width],
    ['height', r.height],
    ...r.lines.flatMap((l, i) =>
      ['top', 'height', 'baseline', 'left', 'width'].map((k) => [`line ${i} ${k}`, l[k]]),
    ),
    ...r.clusters.flatMap((c, i) => ['x', 'y', 'advance'].map((k) => [`cluster ${i} ${k}`, c[k]])),
  ];
  window.m6aA12 = (mode) => {
    const before = port.fallbacks;
    const results = requests.map((r) => port.layout(r));
    const fallbacks = port.fallbacks - before;
    const label = `zoom/DPR ${devicePixelRatio}, generation ${port.generation}, bumps since paste ${bumps}, new fallbacks ${fallbacks}`;
    if (mode === 'reset') {
      localStorage.setItem('m6a-a12', JSON.stringify(results));
      console.log(
        `${fallbacks === 0 ? 'reference stored' : 'FAIL: fallbacks while storing the reference'} at ${label}`,
      );
      return null;
    }
    const reference = JSON.parse(localStorage.getItem('m6a-a12') ?? 'null');
    if (reference === null) {
      console.log('no reference: run m6aA12("reset") at 100 % first');
      return null;
    }
    let breaks = 0;
    let worst = 0;
    const rows = results.map((r, i) => {
      const s = scaleOf(requests[i]);
      if (shape(r) !== shape(reference[i])) {
        breaks += 1;
        return { request: i, s, field: 'other breaks', delta: null, reference: null, now: null };
      }
      const want = fields(reference[i]);
      let row = { request: i, s, field: '-', delta: 0, reference: null, now: null };
      fields(r).forEach(([field, value], k) => {
        const delta = Math.abs(value - want[k][1]);
        if (delta > row.delta)
          row = { request: i, s, field, delta, reference: want[k][1], now: value };
      });
      worst = Math.max(worst, row.delta);
      return row;
    });
    const pass = breaks === 0 && worst <= 1 / 64 && fallbacks === 0;
    console.table(rows);
    const top = rows.reduce((a, b) => ((b.delta ?? Infinity) > (a.delta ?? Infinity) ? b : a));
    const line = `${pass ? 'PASS' : 'FAIL'}: ${label}, requests with other breaks ${breaks}, max position delta ${worst} (request ${top.request}, s ${top.s}, ${top.field})`;
    console.log(line);
    return { line, rows };
  };
  console.log('m6aA12 installed (M6c-U0 extended)');
})();
