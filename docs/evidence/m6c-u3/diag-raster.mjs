/* global window */
// M6c-U3 raster diagnosis (README.md next to this file): does the placed DOM cluster against
// E28's canvas glyph raster alone reproduce the M6c-A06 raster-term failures seen on the main PC
// at DPR 1, and does a setting on the raster port (preferred) or on the reference make them
// agree? No next-host, no GPU: the script serves its own page (diag-raster-page.mjs) with the
// built packages, the committed test font and the `?fixture=text-gpu` document, and opens it in
// each browser at each DPR. Usage, from the repository root, after `pnpm build`:
//
//   node docs/evidence/m6c-u3/diag-raster.mjs [--channels chrome,msedge] [--dprs 1,2]
//     [--ids hangul,mixed-sizes,...] [--json out.json] [--headless]
//
// `--chromium <path>` uses that executable instead of the channels (container check). Headed by
// default, as the M6c-A06 spec runs. A diagnostic, not a gate and not evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const list = (value) => value.split(',').filter((item) => item.length > 0);
const executablePath = option('chromium', null);
const channels = executablePath === null ? list(option('channels', 'chrome,msedge')) : ['custom'];
const dprs = list(option('dprs', '1,2')).map(Number);
const ids = list(
  option(
    'ids',
    'kerning,hangul,mixed-sizes,hangul-in-latin,two-families,spacing-tight,spacing-wide,small-12,small-9,wrapped,align-center,align-right',
  ),
);
const jsonOut = option('json', join(here, 'diag-raster-result.json'));
const headless = args.includes('--headless');

/** The placed DOM cluster: the spec's (composited layer), then one change each. */
const DOM_VARIANTS = {
  spec: { layer: true },
  noLayer: { layer: false },
  'tr-geometricPrecision': { layer: true, textRendering: 'geometricPrecision' },
  'tr-optimizeSpeed': { layer: true, textRendering: 'optimizeSpeed' },
  'tr-optimizeLegibility': { layer: true, textRendering: 'optimizeLegibility' },
};
/** The canvas raster: the real port, its copy (`mirror`), then one change each. */
const CANVAS_VARIANTS = {
  port: {},
  mirror: { willReadFrequently: true },
  'wrf-false': { willReadFrequently: false },
  'element-canvas': { willReadFrequently: true, element: true },
  'fill-black': { willReadFrequently: true, fill: '#000000' },
  'opaque-black-on-white': { willReadFrequently: true, opaque: true },
  'ctx-tr-geometricPrecision': { willReadFrequently: true, textRendering: 'geometricPrecision' },
  'ctx-tr-optimizeSpeed': { willReadFrequently: true, textRendering: 'optimizeSpeed' },
  'ctx-tr-optimizeLegibility': { willReadFrequently: true, textRendering: 'optimizeLegibility' },
  'kerning-none': { willReadFrequently: true, fontKerning: 'none' },
  'kerning-normal': { willReadFrequently: true, fontKerning: 'normal' },
};
const BOUNDS = { horizontal: 0.5, vertical: 0.25, size: 1 };

const ORIGIN = 'http://diag.invalid';
const IMPORTS = {
  '@vector-studio/contracts': '/pkg/contracts/index.js',
  '@vector-studio/text-dom': '/pkg/text-dom/index.js',
  '@vector-studio/renderer-core': '/pkg/renderer-core/index.js',
  '@vector-studio/renderer-webgpu': '/pkg/renderer-webgpu/index.js',
};
const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html, body { margin: 0; background: #ffffff; }</style>
<script type="importmap">${JSON.stringify({ imports: IMPORTS })}</script>
<script type="module">import '/page.js'; window.diagReady = true;</script></head><body></body></html>`;
const agree = ts.transpileModule(
  readFileSync(join(root, 'tests/m6c-next-host/m6c-agreement.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText;

async function serve(route) {
  const { pathname } = new URL(route.request().url());
  const js = (body) => route.fulfill({ body, contentType: 'text/javascript' });
  if (pathname === '/') return route.fulfill({ body: HTML, contentType: 'text/html' });
  if (pathname === '/page.js') return js(readFileSync(join(here, 'diag-raster-page.mjs')));
  if (pathname === '/agree.js') return js(agree);
  if (pathname === '/font.otf') {
    return route.fulfill({
      body: readFileSync(join(root, 'tests/fixtures/m6-text/fonts/NotoSansKR-Regular-subset.otf')),
      contentType: 'font/otf',
    });
  }
  if (pathname === '/fixture.json') {
    return route.fulfill({
      body: readFileSync(join(root, 'tests/fixtures/m6-text/gpu/text-gpu.v6.json')),
      contentType: 'application/json',
    });
  }
  const pkg = /^\/pkg\/([a-z-]+)\/(.+\.js)$/u.exec(pathname);
  if (pkg !== null) return js(readFileSync(join(root, 'packages', pkg[1], 'dist', pkg[2])));
  return route.fulfill({ status: 404, body: 'not found' });
}

const r3 = (value) => (value === null || value === undefined ? '-' : value.toFixed(3));

async function runOne(browser, channel, dpr) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: dpr,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.route(`${ORIGIN}/**`, serve);
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.diagReady === true || window.diag !== undefined, null, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.diag !== undefined, null, { timeout: 30_000 });
  const info = await page.evaluate(
    (ids) => window.diag.init({ fixtureUrl: '/fixture.json', fontUrl: '/font.otf', ids }),
    ids,
  );
  const rows = [];
  for (const node of info.nodes) {
    for (const index of node.inked) {
      const residuals = {};
      for (const [name, variant] of Object.entries(DOM_VARIANTS)) {
        const placed = await page.evaluate(
          ([id, i, v]) => window.diag.placeDom(id, i, v),
          [node.id, index, variant],
        );
        residuals[name] = placed.residual;
        const png = await page.screenshot({ clip: placed.clip, scale: 'device' });
        await page.evaluate(
          ([key, clip, b64]) => window.diag.storeDom(key, clip, b64),
          [`${node.id}/${index}/${name}`, placed.clip, png.toString('base64')],
        );
      }
      const row = await page.evaluate(
        ([id, i, canvases, doms]) => window.diag.compare(id, i, canvases, doms),
        [node.id, index, CANVAS_VARIANTS, Object.keys(DOM_VARIANTS)],
      );
      row.residuals = residuals;
      rows.push(row);
    }
  }
  await context.close();
  return { channel, dpr, browserVersion: browser.version(), info, pageErrors, rows };
}

/** Per pair: max |h|, max |v|, max size, max |centroid y|, failures against section 6.3. */
function summarize(rows) {
  const pairs = {};
  for (const row of rows) {
    for (const [pair, term] of Object.entries(row.terms)) {
      const entry = (pairs[pair] ??= { h: 0, v: 0, size: 0, cy: 0, fails: 0, compared: 0 });
      if (term === null) continue;
      entry.compared += 1;
      entry.h = Math.max(entry.h, term.h);
      entry.v = Math.max(entry.v, Math.abs(term.v));
      entry.size = Math.max(entry.size, term.size);
      entry.cy = Math.max(entry.cy, Math.abs(term.cy));
      if (
        term.h > BOUNDS.horizontal ||
        Math.abs(term.v) > BOUNDS.vertical ||
        term.size > BOUNDS.size
      ) {
        entry.fails += 1;
      }
    }
  }
  return pairs;
}

function print(result, pairs) {
  console.log(
    `\n== ${result.channel} ${result.browserVersion} DPR ${result.dpr}: ${result.rows.length} clusters; ` +
      `ctx.lang ${result.info.contextLang}, ctx.textRendering ${result.info.contextTextRendering}` +
      (result.pageErrors.length ? `; page errors: ${result.pageErrors.join(' | ')}` : ''),
  );
  console.log('canvas variant | DOM variant'.padEnd(52) + 'max h   max|v|  maxsize max|cy|  fails');
  for (const [pair, s] of Object.entries(pairs)) {
    const [canvas, dom] = pair.split('|');
    if (canvas !== 'port' && dom !== 'spec') continue;
    console.log(
      `${canvas.padEnd(26)} ${dom.padEnd(24)} ${r3(s.h)}   ${r3(s.v)}   ${r3(s.size)}   ${r3(s.cy)}   ${s.fails}/${s.compared}`,
    );
  }
  const failing = result.rows.filter((row) => {
    const t = row.terms['port|spec'];
    return (
      t && (t.h > BOUNDS.horizontal || Math.abs(t.v) > BOUNDS.vertical || t.size > BOUNDS.size)
    );
  });
  if (failing.length > 0) {
    console.log('clusters failing port|spec (v per canvas variant against DOM spec):');
    for (const row of failing) {
      const cells = Object.keys(CANVAS_VARIANTS)
        .map((name) => `${name} ${r3(row.terms[`${name}|spec`]?.v)}`)
        .join(', ');
      console.log(
        `  ${row.id} ${row.index} ${JSON.stringify(row.text)} P ${row.corner} ph ${row.phaseX}: ${cells}`,
      );
    }
  }
  const differing = Object.entries(result.rows[0]?.sameAsPort ?? {}).filter(
    ([name]) => name === 'mirror',
  );
  if (differing.length > 0 && result.rows.some((row) => row.sameAsPort.mirror === false)) {
    console.log(
      'note: the mirror copy differs from the real port on some cluster (check the copy)',
    );
  }
}

const results = [];
for (const channel of channels) {
  const browser = await chromium.launch(
    executablePath === null ? { channel, headless } : { executablePath, headless },
  );
  try {
    for (const dpr of dprs) {
      const result = await runOne(browser, channel, dpr);
      result.summary = summarize(result.rows);
      print(result, result.summary);
      results.push(result);
    }
  } finally {
    await browser.close();
  }
}
writeFileSync(
  jsonOut,
  JSON.stringify({ date: new Date().toISOString(), bounds: BOUNDS, ids, results }, null, 2),
);
console.log(`\nJSON: ${jsonOut}`);
