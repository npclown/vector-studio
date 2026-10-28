import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// M2-U6 (MVP M2 contract, section 6 and M2-Q4): a headed probe, not an acceptance test. It
// focuses each candidate clipboard target in turn, presses Ctrl+C, Ctrl+X and Ctrl+V (Meta on
// macOS) and records which DOM `copy`, `cut` and `paste` events reach the document while that
// target has focus, the event target, and the text the paste read back through the system
// clipboard (so a line feed rewritten to CR LF shows). The candidates are a focused,
// non-editable `<canvas tabindex=0>` (the design if the events fire there), the visually hidden
// read-only `<textarea>` sink of the fallback design, empty and with its text selected, and an
// editable `<textarea>` control. Only the control is asserted, so a broken harness fails while
// either answer for the canvas passes; the observations are the record (`probe.json` in the
// test output, attached to the report, and one console line per target).

const ORIGIN = 'https://m2-clipboard-probe.test';
/** A payload with the fragment's line feed, so a CR LF rewrite on the way back is visible. */
const PAYLOAD = 'vector-studio/fragment\n{"probe":';
const TARGETS = ['canvas', 'sink-empty', 'sink-selected', 'control'] as const;
type Target = (typeof TARGETS)[number];

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>M2 clipboard probe</title>
<style>
  .hidden { position: fixed; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; }
</style></head>
<body>
<canvas id="canvas" tabindex="0" width="300" height="150" style="border: 1px solid"></canvas>
<textarea id="sink-empty" class="hidden" readonly aria-hidden="true"></textarea>
<textarea id="sink-selected" class="hidden" readonly aria-hidden="true"> </textarea>
<textarea id="control">control text</textarea>
<script>
  window.probe = [];
  for (const type of ['copy', 'cut', 'paste']) {
    document.addEventListener(type, (event) => {
      const record = {
        type,
        target: event.target.id || event.target.nodeName,
        active: document.activeElement ? document.activeElement.id || document.activeElement.nodeName : null,
        text: null,
      };
      if (type === 'paste') {
        record.text = event.clipboardData ? event.clipboardData.getData('text/plain') : null;
      } else if (event.clipboardData) {
        event.clipboardData.setData('text/plain', ${JSON.stringify(PAYLOAD)} + JSON.stringify(type) + '}');
      }
      event.preventDefault();
      window.probe.push(record);
    }, true);
  }
</script>
</body></html>`;

type Observation = Readonly<{
  type: 'copy' | 'cut' | 'paste';
  target: string;
  active: string | null;
  text: string | null;
}>;

async function focus(page: Page, target: Target) {
  await page.evaluate((id) => {
    const element = document.getElementById(id)!;
    element.focus();
    if (element instanceof HTMLTextAreaElement) element.select();
  }, target);
}

test('clipboard events on a focused canvas, the textarea sink and a control', async ({
  page,
  context,
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }),
  );
  await page.goto(`${ORIGIN}/`);

  const results: Record<string, unknown> = {
    project: testInfo.project.name,
    userAgent: await page.evaluate(() => navigator.userAgent),
    platform: process.platform,
  };
  for (const target of TARGETS) {
    // A known seed, so the paste shows which earlier event reached the system clipboard.
    const seed = `seed-${target}`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), seed);
    await page.evaluate(() => {
      (window as unknown as { probe: Observation[] }).probe = [];
    });
    await focus(page, target);
    const focused = await page.evaluate(() => document.activeElement?.id ?? null);
    for (const key of ['KeyC', 'KeyX', 'KeyV']) await page.keyboard.press(`ControlOrMeta+${key}`);
    // The clipboard events are dispatched synchronously with the key, but give them a frame.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const events = await page.evaluate(() => (window as unknown as { probe: Observation[] }).probe);
    const fired = (type: Observation['type']) => events.some((event) => event.type === type);
    const pasted = events.find((event) => event.type === 'paste')?.text ?? null;
    const system = await page.evaluate(() => navigator.clipboard.readText());
    results[target] = {
      focused,
      copy: fired('copy'),
      cut: fired('cut'),
      paste: fired('paste'),
      events,
      seed,
      pasted,
      /** True when the paste read back the cut or copy payload with its line feed intact. */
      lineFeedKept: pasted === null ? null : pasted.startsWith(PAYLOAD),
      systemClipboard: system,
    };
    console.log(
      `[${testInfo.project.name}] ${target}: copy=${fired('copy')} cut=${fired('cut')} ` +
        `paste=${fired('paste')} pasted=${JSON.stringify(pasted)}`,
    );
  }
  const json = `${JSON.stringify(results, null, 2)}\n`;
  writeFileSync(testInfo.outputPath('probe.json'), json);
  await testInfo.attach('probe.json', { body: json, contentType: 'application/json' });

  // The harness check: an editable, focused textarea gets all three events.
  const control = results.control as { copy: boolean; cut: boolean; paste: boolean };
  expect(control).toMatchObject({ copy: true, cut: true, paste: true });
});
