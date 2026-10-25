import {
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
} from '@vector-studio/editor-core';
import type { DocumentV1 } from '@vector-studio/model';
import { expect, test, type Page } from '@playwright/test';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// P5-U6 (P5 editor-slice plan, section 7): P5-A12, the next-host page edits a document through
// EditorCanvas in headed Chrome and Edge, and the headed half of P5-A09, the same command script
// gives identical documents, history and events with the WebGPU host and the recording renderer.
// Functional evidence only: rendering precision stays UNVERIFIED until P3 A04 evidence exists.

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
  }
}

// The host page's default ID source gives the document node-1 and its page node-2.
const SCRIPT: readonly Command[] = [
  { type: 'createRectangle', frame: { x: 40, y: 40, width: 200, height: 120 } },
  {
    type: 'createPath',
    verbs: ['move', 'cubic', 'line', 'close'],
    points: [300, 300, 340, 220, 420, 220, 460, 300, 380, 360],
    fill: { r: 0.2, g: 0.5, b: 0.9, a: 1 },
  },
  {
    type: 'runCommand',
    id: 'ext.star.create',
    args: { frame: { x: 560, y: 80, width: 160, height: 160 }, points: 7 },
  },
  {
    type: 'setFrames',
    frames: [{ id: 'node-3', frame: { x: 60, y: 60, width: 220, height: 80 } }],
  },
  {
    type: 'setNodeProps',
    id: 'node-5',
    props: { opacity: 0.5, data: { points: 9, innerRatio: 0.4 } },
  },
  { type: 'undo' },
  { type: 'redo' },
  { type: 'deleteNodes', ids: ['node-4'] },
  { type: 'undo' },
  { type: 'setViewport', camera: { position: { x: -20, y: -10 }, zoom: 1.25 } },
];

async function readDocument(page: Page): Promise<DocumentV1> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'document' })),
  );
  return JSON.parse(text) as DocumentV1;
}

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1');
  await page.waitForFunction(() => window.__p5Host !== undefined);
  // The renderer attaches in the canvas effect after WebGPU initializes; nothing runs before.
  await expect(page.getByTestId('status')).toHaveAttribute('data-renderer', 'ready', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('error')).toHaveCount(0);
  return errors;
}

function recorded() {
  const editor = createEditor({ extensions: [starExtension] });
  const events: EditorEvent[] = [];
  editor.subscribe((event) => events.push(event));
  editor.attachRenderer(new RecordingRenderer());
  const results = SCRIPT.map((command) => editor.execute(command));
  return {
    results,
    document: editor.query({ type: 'document' }),
    history: editor.query({ type: 'history' }),
    events,
  };
}

test('P5-A09: the WebGPU host and the recording renderer agree on a command script', async ({
  page,
}) => {
  const errors = await open(page);
  // Values cross the page boundary as JSON text.
  const text = await page.evaluate((script: string) => {
    const { editor, events } = window.__p5Host!;
    const start = events.length;
    const results = (JSON.parse(script) as Command[]).map((command) => editor.execute(command));
    return JSON.stringify({
      results,
      document: editor.query({ type: 'document' }),
      history: editor.query({ type: 'history' }),
      events: events.slice(start),
    });
  }, JSON.stringify(SCRIPT));
  const host = JSON.parse(text) as ReturnType<typeof recorded>;
  const expected = recorded();
  // Same results, document and history, and no renderer diagnostic on either side.
  expect(host).toEqual(JSON.parse(JSON.stringify(expected)));
  expect(host.events.filter((event) => event.type === 'diagnostic')).toEqual([]);
  await expect(page.getByTestId('error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('P5-A12: the page creates, selects, moves, undoes and draws through EditorCanvas', async ({
  page,
}) => {
  const errors = await open(page);
  const canvas = page.locator('canvas');
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + x, y: box.y + y });
  const status = page.getByTestId('status');

  await page.getByTestId('tool-rectangle').click();
  await page.mouse.move(at(100, 100).x, at(100, 100).y);
  await page.mouse.down();
  await page.mouse.move(at(200, 160).x, at(200, 160).y, { steps: 5 });
  await page.mouse.move(at(260, 220).x, at(260, 220).y, { steps: 5 });
  await page.mouse.up();
  await expect(status).toHaveAttribute('data-nodes', '1');
  await expect(status).toHaveAttribute('data-selected', '1');

  // Move it with the select tool, then undo the move.
  await page.getByTestId('tool-select').click();
  const before = await readDocument(page);
  await page.mouse.move(at(180, 160).x, at(180, 160).y);
  await page.mouse.down();
  await page.mouse.move(at(230, 200).x, at(230, 200).y, { steps: 10 });
  await page.mouse.up();
  const moved = await readDocument(page);
  const id = before.pages[0].children[0]!;
  expect(moved.nodes[id]!.frame.x).toBe(before.nodes[id]!.frame.x + 50);
  await page.getByTestId('undo').click();
  const undone = await readDocument(page);
  expect(undone).toEqual(before);

  // A star from the extension command, then a marquee that selects both.
  await page.getByTestId('star').click();
  await expect(status).toHaveAttribute('data-nodes', '2');
  await page.mouse.move(at(20, 20).x, at(20, 20).y);
  await page.mouse.down();
  await page.mouse.move(at(600, 500).x, at(600, 500).y, { steps: 10 });
  await expect(page.getByTestId('marquee')).toHaveCount(1);
  await page.mouse.up();
  await expect(status).toHaveAttribute('data-selected', '2');
  await expect(page.getByTestId('selection')).toHaveCount(1);

  const diagnostics = await page.evaluate(
    () => window.__p5Host!.events.filter((event) => event.type === 'diagnostic').length,
  );
  expect(diagnostics).toBe(0);
  await expect(page.getByTestId('error')).toHaveCount(0);
  expect(errors).toEqual([]);
  await canvas.screenshot({ path: test.info().outputPath('p5-next-host.png') });
});
