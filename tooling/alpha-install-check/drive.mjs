/* global window, document */
// AR-U4 install check driver (alpha release plan): opens one installed host page, waits for the
// renderer, draws a red rectangle by command, moves it by one more command (the edit), and reads
// the document, the history, the layer tree and, on a real GPU, the presented pixels.

const RED = { r: 1, g: 0, b: 0, a: 1 };
const NAME = 'Install check rectangle';
const FRAME = { x: 100, y: 100, width: 200, height: 150 };
const MOVE = { dx: 150, dy: 50 };

/** Counts the red pixels of the next presented frame and their bounding box (device pixels). */
async function redPixels(page) {
  return page.evaluate(async () => {
    if (window.__alphaCapture === undefined) return { capture: 'no capture hook' };
    let frame;
    try {
      frame = await window.__alphaCapture();
    } catch (error) {
      return { capture: String(error) };
    }
    const data = frame.rgba;
    let count = 0;
    let box = [Infinity, Infinity, -1, -1];
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const i = (y * frame.width + x) * 4;
        if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) {
          count += 1;
          box = [
            Math.min(box[0], x),
            Math.min(box[1], y),
            Math.max(box[2], x),
            Math.max(box[3], y),
          ];
        }
      }
    }
    return { count, box: count > 0 ? box : null, size: [frame.width, frame.height] };
  });
}

/**
 * Runs the check on `url` in `browser` and returns its observations and a list of failures.
 * `pixels` says whether presented pixels are required (a real GPU) or only reported.
 */
export async function drive(browser, url, { pixels, screenshot }) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  const responses = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.url().endsWith('.wasm') || response.status() >= 400) {
      responses.push({ status: response.status(), url: response.url() });
    }
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__alphaEditor !== undefined, null, { timeout: 60_000 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid=status]')?.getAttribute('data-renderer') !== 'pending',
    null,
    { timeout: 60_000 },
  );
  const renderer = await page.getByTestId('status').getAttribute('data-renderer');

  const created = await page.evaluate(
    ({ frame, fill, name }) => {
      const editor = window.__alphaEditor;
      const result = editor.execute({ type: 'createRectangle', frame, fill, name });
      editor.execute({ type: 'setSelection', ids: [] });
      return { result, history: editor.getSnapshot().history };
    },
    { frame: FRAME, fill: RED, name: NAME },
  );
  const before = await redPixels(page);
  if (screenshot) await page.screenshot({ path: `${screenshot}-before.png` });

  const edited = await page.evaluate(
    ({ id, move }) => {
      const editor = window.__alphaEditor;
      const result = editor.execute({ type: 'nudgeNodes', ids: [id], ...move });
      const node = editor.query({ type: 'document' }).nodes[id];
      return { result, frame: node.frame, history: editor.getSnapshot().history };
    },
    { id: created.result.ids[0], move: MOVE },
  );
  const after = await redPixels(page);
  if (screenshot) await page.screenshot({ path: `${screenshot}-after.png` });
  const layerRows = await page.getByText(NAME).count();
  const diagnostics = await page.evaluate(() => window.__alphaDiagnostics ?? []);
  await page.close();

  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  expect(renderer === 'ready', `renderer is ${renderer}`);
  expect(created.result.ok, 'createRectangle was refused');
  expect(edited.result.ok, 'nudgeNodes was refused');
  expect(
    JSON.stringify(edited.frame) ===
      JSON.stringify({ ...FRAME, x: FRAME.x + MOVE.dx, y: FRAME.y + MOVE.dy }),
    `the moved frame is ${JSON.stringify(edited.frame)}`,
  );
  expect(
    edited.history.undoDepth === created.history.undoDepth + 1,
    'the edit is not exactly one undo step',
  );
  expect(layerRows === 1, `the layer tree shows the rectangle ${layerRows} times`);
  expect(
    responses.some((response) => response.url.endsWith('.wasm') && response.status === 200),
    'the kernel WASM was not served',
  );
  expect(
    responses.every((response) => response.status < 400),
    `failed requests: ${JSON.stringify(responses)}`,
  );
  expect(errors.length === 0, `page errors: ${JSON.stringify(errors)}`);
  if (pixels) {
    expect(before.count > 0, `no red pixels before the edit (${JSON.stringify(before)})`);
    expect(after.count > 0, `no red pixels after the edit (${JSON.stringify(after)})`);
    if (before.box !== null && after.box !== null) {
      // The move is (150, 50) page units: in device pixels the box moves right and down by 3:1.
      const dx = after.box[0] - before.box[0];
      const dy = after.box[1] - before.box[1];
      expect(dx > 0 && Math.abs(dx - 3 * dy) <= 3, `the red box moved by (${dx}, ${dy})`);
      expect(
        Math.abs(after.count - before.count) <= before.count * 0.02,
        `the red area changed from ${before.count} to ${after.count}`,
      );
    }
  }
  return {
    url,
    renderer,
    created,
    edited,
    layerRows,
    responses,
    errors,
    pixels: pixels ? 'required' : 'not checked (no GPU)',
    before,
    after,
    diagnostics,
    failures,
  };
}
