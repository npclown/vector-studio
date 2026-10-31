/* global window, document, performance, MutationObserver, self */
// M6c-U0 direct probe (docs/evidence/m6c-u0/README.md): the experiments behind the README's
// step 2 and 3 figures, on text-dom alone. A small static server serves the built
// `packages/text-dom/dist` and `packages/contracts/dist` with an import map (no bundler, no
// next-host) and the committed test font. Each experiment lays out the record's fifteen requests
// and compares them with a layout at layout zoom 1 in the same browser.
//
//   fields    per-field maxima under browser zoom 1.25, 1.5 and 1.875 (README step 2)
//   sweep     REFERENCE_SCALE 1, 4, 16, 32, 64 against browser zoom 1.25 to 2 (step 2); the
//             server rewrites `REFERENCE_SCALE = 64` in the served scale.js
//   css       CSS `zoom: 1.25` on <body>, results divided back by 1.25 (step 1)
//   edges     a 0 x 0 inline-block probe after padding-top p at browser zoom 1.25 (step 3)
//   zooms     browser zoom 1.1 and 0.9 (step 4)
//   mixed     a real device scale (--force-device-scale-factor) under CDP emulation (step 4)
//   cost      per-request time of the fifteen layouts at a stable zoom 1 and 1.25, and how many
//             times the measurement host's style changes across them (step 4)
//
// Usage, from the repository root, after `pnpm build` (or `pnpm --filter @vector-studio/text-dom
// build`, which builds contracts too):
//
//   node docs/evidence/m6c-u0/probe-direct.mjs [experiment ...] [--json out.json]
//
// With no experiment named, all run. Browser zoom is set through `chrome.tabs.setZoom` by a
// throwaway extension, so it needs a full Chromium build (Playwright's `channel: 'chromium'`, or
// M6C_U0_CHROMIUM naming the executable). The "before the fix" figures come from the same probe
// with `packages/text-dom/src/measure.ts` as at e8d3489, built. A diagnostic, not a gate.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt === -1 ? null : args[jsonAt + 1];
const ALL = ['fields', 'sweep', 'css', 'edges', 'zooms', 'mixed', 'cost'];
const named = args.filter((arg, index) => ALL.includes(arg) && index !== jsonAt + 1);
const experiments = named.length === 0 ? ALL : named;
const executablePath = process.env.M6C_U0_CHROMIUM;
const FONT = 'tests/fixtures/m6-text/fonts/NotoSansKR-Regular-subset.otf';

// The fifteen requests of docs/evidence/m6a-a12-dpr-manual.md, verbatim.
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
const REQUESTS = [
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
const scaleOf = (r, S = 64) => {
  const largest = Math.max(...r.runs.map((x) => x.size));
  let s = S;
  while (s > 1 && largest * s > 2048) s /= 2;
  return s;
};

// Static server: `/s/<S>/...` serves the repository with REFERENCE_SCALE rewritten to S.
const page = (S) => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"@vector-studio/contracts":"/s/${S}/packages/contracts/dist/index.js"}}</script>
<script type="module">
import { createTextDom } from '/s/${S}/packages/text-dom/dist/index.js';
window.port = createTextDom({ document });
window.ready = window.port.registerFont({ family: ${JSON.stringify(F)}, source: { url: '/${FONT}' } });
</script></head><body style="margin:0"></body></html>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://x');
  const match = /^\/s\/(\d+)(\/.*)$/.exec(url.pathname);
  const S = match === null ? 64 : Number(match[1]);
  const path = match === null ? url.pathname : match[2];
  if (path === '/' || path === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return response.end(page(S));
  }
  const file = normalize(join(root, path));
  if (
    !file.startsWith(root) ||
    !/^\/(packages\/[a-z-]+\/dist|tests\/fixtures\/m6-text)\//.test(path)
  ) {
    response.writeHead(404);
    return response.end();
  }
  try {
    let body = readFileSync(file);
    if (path.endsWith('/text-dom/dist/scale.js') && S !== 64) {
      body = body.toString().replace('REFERENCE_SCALE = 64;', `REFERENCE_SCALE = ${S};`);
    }
    const type = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.otf')
        ? 'font/otf'
        : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function open(p, S = 64) {
  await p.goto(`${origin}/s/${S}/`);
  await p.waitForFunction(() => window.ready !== undefined);
  const status = await p.evaluate(() => window.ready);
  if (status !== 'loaded') throw new Error(`test font ${status}`);
}
const layout = (p) => p.evaluate((rs) => rs.map((r) => window.port.layout(r)), REQUESTS);
const fields = (r) => [
  ['width', r.width],
  ['height', r.height],
  ...r.lines.flatMap((l, i) =>
    ['top', 'height', 'baseline', 'left', 'width'].map((k) => [`line.${k}`, l[k], i]),
  ),
  ...r.clusters.flatMap((c, i) => ['x', 'y', 'advance'].map((k) => [`cluster.${k}`, c[k], i])),
];
const shape = (r) =>
  JSON.stringify([
    r.lines.map((l) => [l.start, l.end]),
    r.clusters.map((c) => [c.start, c.end, c.line]),
  ]);

/** Worst delta overall and per field; `divide` divides measured lengths (not fixed widths). */
function compare(reference, results, S = 64, divide = 1) {
  let worst = { delta: 0 };
  const byField = {};
  let breaks = 0;
  results.forEach((r, i) => {
    if (shape(r) !== shape(reference[i])) {
      breaks += 1;
      return;
    }
    const want = fields(reference[i]);
    fields(r).forEach(([field, value, index], k) => {
      const fixedWidth = field === 'width' && REQUESTS[i].width !== null;
      // Right or centre alignment against a fixed width does not divide back.
      const aligned =
        (field === 'line.left' || field === 'cluster.x') && REQUESTS[i].align !== 'left';
      if (aligned && divide !== 1) return;
      const delta = Math.abs((fixedWidth ? value : value / divide) - want[k][1]);
      const row = {
        delta,
        request: i,
        s: scaleOf(REQUESTS[i], S),
        field,
        index,
        reference: want[k][1],
        now: value,
      };
      if (delta > worst.delta) worst = row;
      if (delta > (byField[field]?.delta ?? -1)) byField[field] = row;
    });
  });
  return { breaks, worst, byField };
}

const out = {};
const log = (label, value) => {
  console.log(`${label}: ${JSON.stringify(value)}`);
  (out[label.split(' ')[0]] ??= []).push({ label, value });
};

async function zoomContext(extraArgs = []) {
  const extension = mkdtempSync(join(tmpdir(), 'm6c-u0-zoom-'));
  writeFileSync(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'm6c-u0-zoom',
      version: '1',
      permissions: ['tabs'],
      background: { service_worker: 'sw.js' },
    }),
  );
  writeFileSync(
    join(extension, 'sw.js'),
    'self.setZoom = async (z) => { for (const t of await chrome.tabs.query({})) await chrome.tabs.setZoom(t.id, z); };',
  );
  const profile = mkdtempSync(join(tmpdir(), 'm6c-u0-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...(executablePath === undefined ? { channel: 'chromium' } : { executablePath }),
    headless: true,
    viewport: null,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      ...extraArgs,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const p = context.pages()[0] ?? (await context.newPage());
  const zoom = async (z) => {
    await worker.evaluate((z) => self.setZoom(z), z);
    await p.waitForFunction((z) => Math.abs(window.devicePixelRatio - z) < 1e-6, z);
  };
  const close = async () => {
    await context.close();
    rmSync(extension, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  };
  return { page: p, zoom, close };
}

const z = await zoomContext();
console.log(`Chromium ${z.page.context().browser()?.version() ?? '(persistent context)'}`);
try {
  if (experiments.includes('fields')) {
    await open(z.page);
    await z.zoom(1);
    const reference = await layout(z.page);
    for (const level of [1.25, 1.5, 1.875]) {
      await z.zoom(level);
      const { breaks, worst, byField } = compare(reference, await layout(z.page));
      log(`fields zoom ${level}`, { breaks, worst, byField });
    }
    await z.zoom(1);
  }
  if (experiments.includes('sweep')) {
    for (const S of [1, 4, 16, 32, 64]) {
      await open(z.page, S);
      await z.zoom(1);
      const reference = await layout(z.page);
      for (const level of [1.25, 1.5, 1.875, 2]) {
        await z.zoom(level);
        const { breaks, worst, byField } = compare(reference, await layout(z.page), S);
        const horizontal = Math.max(
          ...['cluster.x', 'cluster.advance', 'line.left', 'line.width', 'width'].map(
            (f) => byField[f]?.delta ?? 0,
          ),
        );
        log(`sweep S ${S} zoom ${level}`, {
          breaks,
          worst: worst.delta,
          request: worst.request,
          s: worst.s,
          field: worst.field,
          horizontal,
        });
      }
      await z.zoom(1);
    }
  }
  if (experiments.includes('edges')) {
    await open(z.page);
    await z.zoom(1.25);
    const edges = await z.page.evaluate(() =>
      [0.1, 0.3, 0.37, 0.5, 0.61, 0.9, 1.3, 1326.3].map((padding) => {
        const block = document.createElement('div');
        block.style.cssText = `padding-top:${padding}px;font-size:0;position:absolute;top:0;left:0`;
        const probe = document.createElement('span');
        probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:top';
        block.append(probe);
        document.body.append(block);
        const top = probe.getBoundingClientRect().top - block.getBoundingClientRect().top;
        block.remove();
        return { padding, top, layoutUnits: top * 1.25 * 64 };
      }),
    );
    log('edges zoom 1.25', edges);
    await z.zoom(1);
  }
  if (experiments.includes('zooms')) {
    await open(z.page);
    await z.zoom(1);
    const reference = await layout(z.page);
    for (const level of [1.1, 0.9]) {
      await z.zoom(level);
      const { breaks, worst } = compare(reference, await layout(z.page));
      log(`zooms zoom ${level}`, {
        breaks,
        worst: worst.delta,
        request: worst.request,
        field: worst.field,
      });
    }
    await z.zoom(1);
  }
  if (experiments.includes('cost')) {
    for (const level of [1, 1.25]) {
      await open(z.page);
      await z.zoom(level);
      const cost = await z.page.evaluate((rs) => {
        for (const r of rs) window.port.layout(r); // warm up, and the first detection
        const host = document.querySelector('vector-studio-text-measure');
        let mutations = 0;
        const observer = new MutationObserver((records) => (mutations += records.length));
        observer.observe(host, { attributes: true, attributeFilter: ['style'] });
        const rounds = 100;
        const start = performance.now();
        for (let round = 0; round < rounds; round += 1) for (const r of rs) window.port.layout(r);
        const ms = (performance.now() - start) / (rounds * rs.length);
        mutations += observer.takeRecords().length;
        observer.disconnect();
        return { msPerRequest: ms, hostStyleMutations: mutations, requests: rounds * rs.length };
      }, REQUESTS);
      log(`cost zoom ${level}`, cost);
    }
    await z.zoom(1);
  }
} finally {
  await z.close();
}

if (experiments.includes('css')) {
  const browser = await chromium.launch({ executablePath });
  const p = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
  await open(p);
  const reference = await layout(p);
  await p.evaluate(() => (document.body.style.zoom = '1.25'));
  const { breaks, worst, byField } = compare(reference, await layout(p), 64, 1.25);
  log('css zoom 1.25 on body, divided back', {
    breaks,
    worst,
    height: byField.height,
    baseline: byField['line.baseline'],
  });
  await browser.close();
}

if (experiments.includes('mixed')) {
  const browser = await chromium.launch({ executablePath });
  const p = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
  await open(p);
  const reference = await layout(p);
  await browser.close();
  for (const [real, emulated] of [
    [1.25, 1],
    [1.25, 1.5],
    [1.25, 2],
    [1.5, 1.25],
  ]) {
    const b = await chromium.launch({
      executablePath,
      args: [`--force-device-scale-factor=${real}`],
    });
    const q = await (
      await b.newContext({ deviceScaleFactor: emulated, viewport: { width: 800, height: 600 } })
    ).newPage();
    await open(q);
    const { breaks, worst } = compare(reference, await layout(q));
    const ratio = await q.evaluate(() => window.devicePixelRatio);
    log(`mixed real ${real} CDP ${emulated}`, {
      devicePixelRatio: ratio,
      breaks,
      worst: worst.delta,
      request: worst.request,
      field: worst.field,
    });
    await b.close();
  }
}

server.close();
if (jsonOut !== null) writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`);
