/* global window, document, localStorage, self */
// M6c-U0 container probe (docs/plans/mvp-m6c-gpu-text-contract.md, section 3; findings in
// README.md next to this file). Runs the extended M6a-A12 snippet (m6c-u0-snippet.mjs) on the
// next-host `?fixture=text&test=1` page in Playwright's Chromium under three conditions:
//
//   zoom      real browser zoom, set through `chrome.tabs.setZoom` by a throwaway extension;
//   force     the `--force-device-scale-factor` command-line switch (a real device scale);
//   emulate   CDP `deviceScaleFactor` emulation (what the M6a headed spec uses).
//
// (CSS `zoom` on an ancestor of the measurement host is left out: the browser then reports
// lengths in zoomed px, so the snippet's comparison is not like for like; README.md, step 1.)
// Each condition compares against a reference stored at layout zoom 1 (`m6aA12('reset')`).
// Usage, from the repository root, with the production build served:
//
//   pnpm build
//   pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4186 &
//   node docs/evidence/m6c-u0/probe.mjs [http://127.0.0.1:4186] [--json out.json]
//
// It needs a full Chromium build (Playwright's `channel: 'chromium'`, or M6C_U0_CHROMIUM), since
// the headless shell loads no extension. It is a diagnostic, not a gate, and not M6a-A12 evidence: that is the
// manual record on the main PC.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt === -1 ? null : args[jsonAt + 1];
const origin =
  args.find((arg, index) => !arg.startsWith('--') && index !== jsonAt + 1) ??
  'http://127.0.0.1:4186';
const url = `${origin}/?fixture=text&test=1`;
const snippet = readFileSync(join(here, 'm6c-u0-snippet.mjs'), 'utf8');
const ZOOMS = [1.25, 1.5, 1.875, 2];
// M6C_U0_CHROMIUM names a full (not headless-shell) Chromium executable, as
// M6A_NEXT_HOST_CHROMIUM does for the M6a spec; without it Playwright's own build is used.
const executablePath = process.env.M6C_U0_CHROMIUM;
const launch = (options = {}) => chromium.launch({ ...options, executablePath });

async function open(page) {
  await page.goto(url);
  await page.waitForFunction(() => window.__p5Host !== undefined, null, { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const status = document.querySelector('[data-testid="status"]');
      return (
        status?.getAttribute('data-fixture') === 'loaded' &&
        status?.getAttribute('data-text-font') === 'loaded'
      );
    },
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(snippet);
}

const run = (page, mode) => page.evaluate((mode) => window.m6aA12(mode), mode);
const results = [];
function record(condition, result) {
  const line = result === null ? 'no result' : result.line;
  console.log(`${condition.padEnd(34)} ${line}`);
  results.push({ condition, ...(result ?? {}) });
}

async function reference() {
  const browser = await launch();
  const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
  await open(page);
  await run(page, 'reset');
  const stored = await page.evaluate(() => localStorage.getItem('m6a-a12'));
  await browser.close();
  return stored;
}

async function withReference(page, stored) {
  await page.evaluate((stored) => localStorage.setItem('m6a-a12', stored), stored);
}

async function browserZoom(stored) {
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
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = context.pages()[0] ?? (await context.newPage());
    const zoom = async (z) => {
      await worker.evaluate((z) => self.setZoom(z), z);
      await page.waitForFunction((z) => Math.abs(window.devicePixelRatio - z) < 1e-6, z);
    };
    await open(page);
    await withReference(page, stored);
    record('zoom 1 (same page)', await run(page));
    for (const z of ZOOMS) {
      await zoom(z);
      record(`browser zoom ${z}, no reload`, await run(page));
      await open(page);
      record(`browser zoom ${z}, reload`, await run(page));
    }
    await zoom(1);
  } finally {
    await context.close();
    rmSync(extension, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}

async function forced(stored) {
  for (const dsf of ZOOMS) {
    const browser = await launch({ args: [`--force-device-scale-factor=${dsf}`] });
    const page = await (await browser.newContext({ viewport: null })).newPage();
    await open(page);
    await withReference(page, stored);
    record(`--force-device-scale-factor ${dsf}`, await run(page));
    await browser.close();
  }
}

async function emulated(stored) {
  const browser = await launch();
  for (const dsf of ZOOMS) {
    const page = await (await browser.newContext({ deviceScaleFactor: dsf })).newPage();
    await open(page);
    await withReference(page, stored);
    record(`CDP deviceScaleFactor ${dsf}`, await run(page));
  }
  await browser.close();
}

const stored = await reference();
const probe = await launch();
console.log(`Chromium ${probe.version()}, ${url}`);
await probe.close();
await browserZoom(stored);
await forced(stored);
await emulated(stored);
if (jsonOut !== null) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
