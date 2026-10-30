/* global window, document, navigator */
// M6-S0 recorder smoke check: drives the IME recorder page with synthetic CDP composition
// (Input.imeSetComposition and Input.insertText) and keys, then checks the downloaded and copied
// trace. It proves the page records and exports; it is not an IME trace (no OS IME is involved).
import { readFileSync } from 'node:fs';
import { hostMetadata, launch, serve, sourceState, writeReport } from './lib.mjs';

const server = await serve();
const { browser, launch: launchInfo } = await launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${server.base}/m6-s0-ime-recorder.html`);
  await page.waitForFunction(() => window.__vectorStudioM6S0Recorder !== undefined);
  const cdp = await context.newCDPSession(page);
  const compose = (text) =>
    cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });

  await page.click('button.case[data-case="final-consonant-move"]');
  await page.click('#stage');
  for (const step of ['ㄱ', '가', '각']) await compose(step);
  await cdp.send('Input.insertText', { text: '가' });
  for (const step of ['ㄱ', '가']) await compose(step);
  await cdp.send('Input.insertText', { text: '가' });

  await page.click('button.case[data-case="backspace-after-commit"]');
  await page.click('#stage');
  for (const step of ['ㅎ', '하', '한']) await compose(step);
  await cdp.send('Input.insertText', { text: '한' });
  await page.keyboard.press('Space');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');

  await page.click('button.case[data-case="click-keeps-focus"]');
  await page.click('#stage');
  await compose('하');
  await page.click('#btn-prevent-pointer');
  await page.click('#btn-default');

  await page.click('button.case[data-case="arrows-during-composition"]');
  await page.click('#stage');
  await compose('하');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');

  await page.click('button.case[data-case="host-force-end"]');
  await page.click('#stage');
  for (const step of ['ㅎ', '하', '한']) await compose(step);
  await page.click('#btn-force-end');
  await compose('하');
  await cdp.send('Input.insertText', { text: '하' });

  await page.fill('#ime-version', 'smoke (synthetic CDP)');
  const downloadPromise = page.waitForEvent('download');
  await page.click('#btn-download');
  const download = await downloadPromise;
  const downloaded = JSON.parse(readFileSync(await download.path(), 'utf8'));
  await page.click('#btn-copy');
  await page.waitForFunction(() =>
    document.getElementById('export-status').textContent.startsWith('Copied'),
  );
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));

  const counts = {};
  for (const event of downloaded.events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  const required = [
    'keydown',
    'keyup',
    'beforeinput',
    'input',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'focus',
    'blur',
    'selectionchange',
  ];
  const missing = required.filter((type) => !counts[type]);
  const result = {
    spike: 'M6-S0',
    measurement: 'recorder smoke (synthetic CDP composition; not an IME trace)',
    createdAt: new Date().toISOString(),
    ...sourceState(),
    ...hostMetadata(),
    browserVersion: browser.version(),
    launch: launchInfo,
    download: download.suggestedFilename(),
    events: downloaded.events.length,
    copiedEvents: copied.events.length,
    counts,
    missing,
    resets: downloaded.events.filter((e) => e.type === 'm6s0-reset').length,
    endStartSameBeforeMessage: downloaded.events.filter(
      (e, i, all) =>
        e.type === 'compositionstart' &&
        all[i - 1]?.type === 'compositionend' &&
        all[i - 1].beforeMessage === e.beforeMessage,
    ).length,
    finalValue: downloaded.events.at(-1)?.value,
    forceEndTrace: downloaded.events
      .filter(
        (e) => e.case === 'host-force-end' && !['selectionchange', 'm6s0-case'].includes(e.type),
      )
      .map(
        (e) =>
          `${e.type}${e.note ? `(${e.note})` : ''} active=${e.activeElement} value=${JSON.stringify(e.value)}`,
      ),
    clickTrace: downloaded.events
      .filter(
        (e) => e.case === 'click-keeps-focus' && !['selectionchange', 'm6s0-case'].includes(e.type),
      )
      .map(
        (e) =>
          `${e.type}${e.control ? `(${e.control})` : ''} active=${e.activeElement} value=${JSON.stringify(e.value)}`,
      ),
    metadata: downloaded.metadata,
    pageErrors: errors,
    pass:
      missing.length === 0 &&
      errors.length === 0 &&
      copied.events.length === downloaded.events.length,
  };
  console.log(JSON.stringify({ ...result, metadata: undefined }, null, 2));
  writeReport('recorder-smoke', launchInfo, result);
  await context.close();
  if (!result.pass) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
