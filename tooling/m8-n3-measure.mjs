// MVP M8 contract, M8-N3 (M8-U6): the layout budget measurement of the next-host page. For every
// next-host Playwright config of a checkout (`playwright.*next-host*.config.ts`, plus the
// `m6c-u0-zoom`, `m6c-observe` and `e26` configs, which load the same page) and each of its
// projects, headed and smoke, it loads the page that config's specs load at that project's
// viewport and device scale factor and records, in CSS px:
//
// - `origin`: the canvas content box's origin (`getBoundingClientRect` plus `clientLeft/Top`);
// - `canvasRow`: the width (right edge of its last child) and height of the canvas row;
// - `aside`: the computed width of the Appearance aside, `appearance-panel`;
// - `rightColumn`: width and height of the right column (`right-column`), absent before M8-U6;
// - `row1Width`, `row2Width`: the right edge of each toolbar row's last child, from the row's left;
// - `row2Height`, and `row2RenameHeight` with a page rename textbox open (null when double-click
//   opens none, as at 17a2b0a);
// - `scroll`: the document element's `scrollWidth`, `scrollHeight`, `clientWidth`, `clientHeight`.
//
// It runs against any checkout that has been built (`pnpm install`, `pnpm build`), so the same
// script measures 17a2b0a through a separate git worktree:
//
//   node tooling/m8-n3-measure.mjs --root <checkout> [--port 4299] [--json out.json]
//     [--executable /path/to/chromium] [--headed] [--channel chrome|msedge]
//
// Headless Chromium draws no scrollbars, so the widths it reports are those of a window with
// overlay scrollbars; a headed run on a machine with classic scrollbars (`--headed --channel`)
// shows the narrower layout the contract measures (M8-N3). The script only observes; it asserts
// nothing and changes no file of the checkout.
/* global fetch, setTimeout, window */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
// Shared with the specs' helper (tests/support/m8-n3-budget.ts); Node strips its types.
import { readLayout } from '../tests/support/m8-n3-read.ts';
import { nextHostConfigs, projectsOf } from './m8-n3-configs.mjs';

function parseArguments(argv) {
  const options = { root: process.cwd(), port: 4299, headed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${name} needs a value`);
      return argv[index];
    };
    if (name === '--root') options.root = path.resolve(value());
    else if (name === '--port') options.port = Number(value());
    else if (name === '--json') options.json = path.resolve(value());
    else if (name === '--executable') options.executable = value();
    else if (name === '--channel') options.channel = value();
    else if (name === '--headed') options.headed = true;
    else throw new Error(`unknown argument ${name}`);
  }
  return options;
}

async function startServer(root, port) {
  // A server already on the port would be measured instead of this checkout's.
  const answered = await fetch(`http://127.0.0.1:${port}`).then(
    () => true,
    () => false,
  );
  if (answered) throw new Error(`port ${port} is in use; pass --port`);
  const child = spawn(
    'pnpm',
    [
      '--filter',
      '@vector-studio/next-host',
      'exec',
      'next',
      'start',
      '-H',
      '127.0.0.1',
      '-p',
      `${port}`,
    ],
    // Its own process group, so stopping it also stops the server pnpm starts.
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`next start exited:\n${output}`);
    try {
      const response = await fetch(base);
      if (response.ok) return { base, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stop();
  throw new Error(`next start did not answer on ${base}:\n${output}`);
}

async function measure(browser, base, row) {
  const context = await browser.newContext({
    viewport: row.viewport,
    deviceScaleFactor: row.deviceScaleFactor,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/${row.bench ? '?bench=1' : '?test=1'}`);
    await page.locator('canvas').waitFor();
    if (!row.bench) {
      await page.waitForFunction(() => window.__p5Host !== undefined, null, { timeout: 30_000 });
      await page
        .locator('[data-testid="status"]:not([data-renderer="pending"])')
        .waitFor({ timeout: 30_000 });
    }
    const layout = await page.evaluate(readLayout);
    // A page rename textbox, where double-click opens one (M8-L2; not at 17a2b0a).
    let row2RenameHeight = null;
    const first = page.locator('[data-testid="pages"] button').first();
    if ((await first.count()) === 1) {
      await first.dblclick();
      const textbox = page.locator('[data-testid="pages"] input');
      if ((await textbox.count()) === 1) {
        row2RenameHeight = (await page.evaluate(readLayout)).row2Height;
        await textbox.press('Escape');
      }
    }
    return { ...row, ...layout, row2RenameHeight };
  } finally {
    await context.close();
  }
}

const round = (value) => (value === null ? '–' : `${Math.round(value * 100) / 100}`);

function table(rows) {
  const lines = [
    '| Config | Project | Viewport | Origin | Canvas row W × H | Aside W | Right column W × H | Row 1 W | Row 2 W | Row 2 H (rename) | scrollW / clientW | scrollH / clientH |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const column =
      row.rightColumn === null
        ? '–'
        : `${round(row.rightColumn.width)} × ${round(row.rightColumn.height)}`;
    lines.push(
      `| ${row.config.replace(/^playwright\.|\.config\.ts$/gu, '')} | ${row.project} | ` +
        `${row.viewport.width} × ${row.viewport.height} @${row.deviceScaleFactor} | ` +
        `${round(row.origin.x)}, ${round(row.origin.y)} | ` +
        `${round(row.canvasRow.width)} × ${round(row.canvasRow.height)} | ${round(row.aside)} | ` +
        `${column} | ${round(row.row1Width)} | ${round(row.row2Width)} | ` +
        `${round(row.row2Height)} (${round(row.row2RenameHeight)}) | ` +
        `${row.scroll.scrollWidth} / ${row.scroll.clientWidth} | ` +
        `${row.scroll.scrollHeight} / ${row.scroll.clientHeight} |`,
    );
  }
  return lines.join('\n');
}

const options = parseArguments(process.argv.slice(2));
// The checkout's own Playwright, which its configs import too (it refuses a second copy).
const { chromium } = createRequire(path.join(options.root, 'package.json'))('@playwright/test');
const rows = [];
for (const file of await nextHostConfigs(options.root))
  rows.push(...(await projectsOf(options.root, file)));
const server = await startServer(options.root, options.port);
const browser = await chromium.launch({
  headless: !options.headed,
  ...(options.channel === undefined ? {} : { channel: options.channel }),
  ...(options.executable === undefined ? {} : { executablePath: options.executable }),
  args: [
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--use-webgpu-adapter=swiftshader',
  ],
});
const results = [];
try {
  for (const row of rows) results.push(await measure(browser, server.base, row));
} finally {
  await browser.close();
  server.stop();
}
const record = {
  root: options.root,
  headed: options.headed,
  channel: options.channel ?? null,
  browser: browser.version(),
  results,
};
if (options.json !== undefined)
  await writeFile(options.json, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${table(results)}\n`);
