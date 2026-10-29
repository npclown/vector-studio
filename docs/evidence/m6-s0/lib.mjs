/* global window, document, URL */
// M6-S0 shared helpers: serve the playground, launch the browser, collect run metadata and write
// a JSON report. See README.md in this folder. Uses only the repo's pinned Playwright and Vite.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../package.json', import.meta.url));
export const { chromium } = require('@playwright/test');

export const env = (name, fallback) => process.env[name] ?? fallback;
export const list = (name, fallback) =>
  env(name, fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
export const numbers = (name, fallback) => list(name, fallback).map(Number);

/** Default families are the main PC's (Windows); the container overrides them. */
export const families = () => list('FAMILIES', 'Arial,Malgun Gothic,Segoe UI');
export const latinFamily = () => env('LATIN_FAMILY', 'Arial');
export const koreanFamily = () => env('KO_FAMILY', 'Malgun Gothic');

/** Uses BASE when set; otherwise starts the playground's Vite dev server on a free port. */
export async function serve() {
  if (process.env.BASE) return { base: process.env.BASE.replace(/\/$/, ''), close: async () => {} };
  const vite = await import(pathToFileURL(require.resolve('vite')).href);
  const root = path.join(repoRoot, 'apps/playground');
  const server = await vite.createServer({
    root,
    configFile: path.join(root, 'vite.config.mjs'),
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  return { base: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

/**
 * Main PC: headed branded Chrome (`CHANNEL=chrome`, the default) or Edge (`CHANNEL=msedge`) on the
 * hardware GPU. Container smoke run: `M6S0_CHROMIUM=<executable>` launches it headless; its numbers
 * are not M6-S0 evidence.
 */
export async function launch() {
  const executablePath = process.env.M6S0_CHROMIUM;
  const options = executablePath
    ? { executablePath, headless: true }
    : { channel: env('CHANNEL', 'chrome'), headless: env('HEADLESS', '0') === '1' };
  const browser = await chromium.launch(options);
  return {
    browser,
    launch: {
      options,
      channel: options.channel ?? null,
      executablePath: executablePath ?? null,
      headless: options.headless,
      label: executablePath ? 'chromium-container' : options.channel,
      evidence: !executablePath && !options.headless,
    },
  };
}

export async function openPage(browser, base, { dpr = 1, query = '' } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: dpr,
    locale: 'ko-KR',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${base}/m6-s0-text-layout.html${query}`);
  await page.waitForFunction(() => window.__vectorStudioM6S0 !== undefined);
  await page.evaluate(() => window.__vectorStudioM6S0.ready);
  return { context, page, errors };
}

function git(args, trim = true) {
  try {
    const out = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return trim ? out.trim() : out;
  } catch {
    return null;
  }
}

/**
 * Clean or dirty state of tracked files, captured before the report is written. Untracked files
 * (the reports in OUT_DIR among them) do not count. A dirty run records the SHA-256 of
 * `git diff HEAD` and the changed paths, so its source delta can be identified
 * (docs/benchmarks/README.md).
 */
export function sourceState() {
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  const dirty = status !== null && status !== '';
  const diff = dirty ? git(['diff', 'HEAD'], false) : null;
  return {
    commit: git(['rev-parse', 'HEAD']),
    dirty,
    diffSha256: diff === null ? null : createHash('sha256').update(diff).digest('hex'),
    diffFiles: dirty ? (git(['diff', 'HEAD', '--name-only'])?.split('\n') ?? []) : [],
  };
}

/** Metadata that needs no page (docs/benchmarks/README.md, "Required metadata"). */
export function hostMetadata() {
  return {
    machineLabel: env('MACHINE_LABEL', 'main-pc'),
    os: {
      platform: os.platform(),
      release: os.release(),
      version: os.version(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? null,
      logicalCores: os.availableParallelism?.() ?? os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    power: process.env.POWER
      ? { value: process.env.POWER, source: 'operator-supplied POWER env' }
      : { value: null, unavailableReason: 'POWER not set' },
    node: process.version,
    automation:
      'Playwright drives the browser over the Chrome DevTools Protocol, which stays attached for the whole run',
  };
}

/** Browser, OS, GPU string, DPR and font information for the report header. */
export async function metadata(browser, launchInfo, page) {
  const pageEnvironment = await page.evaluate(() => window.__vectorStudioM6S0.environment());
  const viewport = page.viewportSize();
  const gpu = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info
      ? {
          vendor: gl.getParameter(info.UNMASKED_VENDOR_WEBGL),
          renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
        }
      : { renderer: gl.getParameter(gl.RENDERER) };
  });
  return {
    spike: 'M6-S0',
    plan: 'docs/plans/mvp-m6-text-plan.md',
    createdAt: new Date().toISOString(),
    ...sourceState(),
    evidence: launchInfo.evidence,
    launch: launchInfo,
    browserVersion: browser.version(),
    ...hostMetadata(),
    viewport: {
      css: viewport,
      physical: viewport && {
        width: Math.round(viewport.width * pageEnvironment.devicePixelRatio),
        height: Math.round(viewport.height * pageEnvironment.devicePixelRatio),
      },
      devicePixelRatio: pageEnvironment.devicePixelRatio,
    },
    gpu,
    page: pageEnvironment,
    env: Object.fromEntries(
      [
        'CHANNEL',
        'HEADLESS',
        'MACHINE_LABEL',
        'POWER',
        'FAMILIES',
        'LATIN_FAMILY',
        'KO_FAMILY',
        'COUNT',
        'SEED',
        'PASSES',
        'DPRS',
        'THRESHOLDS',
        'SIZES',
        'WARMUP',
        'TEXTS',
        'PROBE_MODES',
      ]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    ),
  };
}

export function writeReport(name, launchInfo, data) {
  const directory = path.resolve(env('OUT_DIR', path.join(repoRoot, 'docs/evidence/m6-s0/runs')));
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(directory, `${name}-${launchInfo.label}-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${file}`);
  return file;
}

export const round = (value, digits = 4) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? value
    : Math.round(value * 10 ** digits) / 10 ** digits;
