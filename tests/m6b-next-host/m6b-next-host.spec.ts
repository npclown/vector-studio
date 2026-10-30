import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TextLayoutResult } from '@vector-studio/contracts';
import type {
  Command,
  Editor,
  EditorEvent,
  TextEditOverlay,
  TextEditState,
} from '@vector-studio/editor-core';
import { expect, test, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import type {
  FocusName,
  TextEditLogEntry,
  TextEditTestHook,
} from '../../apps/next-host/src/m6b-text-edit';
import {
  Reference,
  toLocal,
  toPage,
  type Affinity,
  type Placement,
  type Point,
} from './m6b-geometry';

// M6b-U9 (MVP M6b contract, sections 4 to 7, 9 and 16, appendix A): M6b-A12 and M6b-A13 on the
// next-host page with `?fixture=text-edit` (tests/fixtures/m6-text/edit-host.v6.json, the
// committed test font registered as `Noto Sans KR`, zoom 2), in headed Chrome and Edge.
// - A12: the caret segment of every stop and the selection rectangles of the `textEditOverlay`
//   query against the clusters the real port measured (tests/m6b-next-host/m6b-geometry.ts, an
//   independent reading of section 4.3), the DOM caret the page draws from it, click placement
//   and the double-click word, Up and Down with the goal x, on a page-root, a wrapped and a
//   rotated node.
// - A13: real keys sent by Playwright for rules 1 to 6 of section 5.1 and Tab focus (rule 1's
//   `Process` keydown with `keyCode` 229 through CDP `Input.dispatchKeyEvent`), Ctrl+C, X and V
//   through the DOM clipboard events, a DOM paste of `text/plain` with `text/html` in and outside
//   edit mode, and the synthetic traces of appendix A replayed through CDP
//   `Input.dispatchKeyEvent`, `Input.imeSetComposition` and `Input.insertText` (cases 5, 7 and
//   10 are unit-only by appendix A's CDP limits; a trace's press and blur are made by a real
//   click at this page's geometry).
// - The M6b-U7 notes' headed checks: whether a prevented `pointerdown` (with the canvas
//   `mousedown` fallback) keeps focus on the textarea, for a press inside, an entering text tool
//   press, a middle-button press and a press during a composition, and where the textarea (the
//   IME window's anchor, M6b-H1) sits against the caret. The IME candidate window itself is not
//   visible to Playwright; it is M6c's manual run.
// Each test writes its readings to `m6b-*.json` in its output directory (test-results/
// m6b-next-host/) and attaches it. The `chromium-smoke` project (M6B_NEXT_HOST_CHROMIUM,
// playwright.m6b-next-host.config.ts) runs headless with SwiftShader; it is a spec check, not
// A12 or A13 evidence. Window blur (case 10) has no headed evidence until M6c (A13).

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
  }
}

/** The hook's M6b member, declared apart as the M5 and M6a specs do for theirs. */
type TextEditHolder = Readonly<{ textEdit: TextEditTestHook }>;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRACE_DIR = path.join(root, 'tests/fixtures/m6-text/ime');
/** Overlay values are computed from the same layout in binary64; allow rounding only. */
const EPSILON = 1e-6;
/** Textarea placement in CSS px against the caret (subpixel layout of the textarea box). */
const PLACEMENT_TOLERANCE = 0.5;
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
/** An empty page point of the fixture at its camera (no node within 20 page units). */
const EMPTY: Point = { x: 380, y: 270 };

function report(testInfo: TestInfo, name: string, value: unknown) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(testInfo.outputPath(name), json);
  return testInfo.attach(name, { body: json, contentType: 'application/json' });
}

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&fixture=text-edit');
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
  await expect(status).toHaveAttribute('data-text-font', 'loaded');
  return { errors };
}

/** Runs a command through the hook (as JSON: `Command` is too deep for Playwright's types). */
async function ok(page: Page, command: Command) {
  const result = await page.evaluate((script: string) => {
    const value = window.__p5Host!.editor.execute(JSON.parse(script) as Command);
    return value.ok ? 'ok' : `${value.code} ${value.path ?? ''}`.trimEnd();
  }, JSON.stringify(command));
  expect(result, JSON.stringify(command)).toBe('ok');
}

type State = Readonly<{
  textEdit: TextEditState | null;
  texts: Readonly<Record<string, string>>;
  children: readonly string[];
  selection: readonly string[];
  tool: string;
  undoDepth: number;
  focused: FocusName;
  textarea: string;
  camera: Readonly<{ position: Point; zoom: number }>;
}>;

function state(page: Page): Promise<State> {
  return page.evaluate(() => {
    const host = window.__p5Host!;
    const snapshot = host.editor.getSnapshot();
    const texts: Record<string, string> = {};
    for (const node of Object.values(snapshot.document.nodes)) {
      if (node.type === 'text') texts[node.id] = node.runs.map((r) => r.text).join('');
    }
    const page = snapshot.document.pages.find((p) => p.id === snapshot.activePage)!;
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Text input"]',
    );
    return {
      textEdit: snapshot.textEdit,
      texts,
      children: page.children,
      selection: snapshot.selection,
      tool: snapshot.tool,
      undoDepth: snapshot.history.undoDepth,
      focused: (host as unknown as TextEditHolder).textEdit.focused(),
      textarea: textarea?.value ?? '<none>',
      camera: { position: snapshot.viewport.position, zoom: snapshot.viewport.zoom },
    };
  });
}

function log(page: Page): Promise<readonly TextEditLogEntry[]> {
  return page.evaluate(() => [...(window.__p5Host as unknown as TextEditHolder).textEdit.log]);
}

function clearLog(page: Page) {
  return page.evaluate(() => (window.__p5Host as unknown as TextEditHolder).textEdit.clearLog());
}

/** Two macrotasks, so the M6b-H4 `MessageChannel` reset and React's commit have run. */
function settle(page: Page) {
  return page.evaluate(
    () => new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 20)),
  );
}

type Node = Readonly<{
  placement: Placement;
  text: string;
  layout: TextLayoutResult;
  reference: Reference;
}>;

async function nodeOf(page: Page, id: string): Promise<Node> {
  const value = await page.evaluate((nodeId) => {
    const editor = window.__p5Host!.editor;
    const node = editor.getSnapshot().document.nodes[nodeId]!;
    if (node.type !== 'text') throw new Error(`${nodeId} is not a text node`);
    return {
      frame: node.frame,
      rotation: node.rotation,
      text: node.runs.map((r) => r.text).join(''),
      sizing: node.sizing,
      size: node.runs[0]!.size,
      layout: editor.query({ type: 'textLayout', id: nodeId })!,
    };
  }, id);
  return {
    placement: { frame: value.frame, rotation: value.rotation },
    text: value.text,
    layout: value.layout,
    reference: new Reference(
      value.text,
      value.layout,
      value.sizing === 'autoWidth' ? null : value.layout.width,
      value.size,
    ),
  };
}

/** The canvas box in client px: its content box origin (inside the border). */
async function canvasOrigin(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="canvas-host"] canvas')!;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop };
  });
}

type View = Readonly<{ origin: Point; position: Point; zoom: number }>;

async function view(page: Page): Promise<View> {
  const origin = await canvasOrigin(page);
  const { camera } = await state(page);
  return { origin, position: camera.position, zoom: camera.zoom };
}

const toClient = (v: View, p: Point): Point => ({
  x: v.origin.x + (p.x - v.position.x) * v.zoom,
  y: v.origin.y + (p.y - v.position.y) * v.zoom,
});
const fromClient = (v: View, p: Point): Point => ({
  x: v.position.x + (p.x - v.origin.x) / v.zoom,
  y: v.position.y + (p.y - v.origin.y) / v.zoom,
});

function overlay(page: Page): Promise<TextEditOverlay | null> {
  return page.evaluate(() => window.__p5Host!.editor.query({ type: 'textEditOverlay' }));
}

const close = (a: number, b: number, tolerance = EPSILON) => Math.abs(a - b) <= tolerance;
const closePoint = (a: Point, b: Point) => close(a.x, b.x) && close(a.y, b.y);
const fmt = (p: Point) => `(${p.x.toFixed(4)}, ${p.y.toFixed(4)})`;

/** The stops of a node: every cluster boundary, 0 and the length. */
function stops(node: Node): number[] {
  const set = new Set<number>([0, node.text.length]);
  for (const cluster of node.layout.clusters) set.add(cluster.start).add(cluster.end);
  for (const line of node.layout.lines) set.add(line.start).add(line.end);
  return [...set].sort((a, b) => a - b);
}

async function enter(page: Page, id: string, anchor: number, focus = anchor) {
  await ok(page, { type: 'enterTextEdit', id, anchor, focus });
  await settle(page);
  expect((await state(page)).focused).toBe('textarea');
}

// ---------------------------------------------------------------------------------------------
// M6b-A12
// ---------------------------------------------------------------------------------------------

test('M6b-A12: caret segments and selection rectangles match the measured clusters', async ({
  page,
}, testInfo) => {
  const { errors } = await open(page);
  const problems: string[] = [];
  const readings: Record<string, unknown> = {};
  for (const id of ['t', 'w', 'r']) {
    const node = await nodeOf(page, id);
    readings[id] = {
      lines: node.layout.lines.map((l) => [l.start, l.end, l.top, l.height, l.left]),
      clusters: node.layout.clusters.length,
      fallbacks: await page.evaluate(
        () =>
          (window.__p5Host as unknown as { text: { port: { fallbacks: number } } }).text.port
            .fallbacks,
      ),
    };
    for (const offset of stops(node)) {
      const affinities: Affinity[] = ['downstream'];
      const line = node.layout.lines.findIndex((l) => l.end === offset);
      if (line !== -1 && node.reference.softWrapAfter(line)) affinities.push('upstream');
      for (const affinity of affinities) {
        await ok(page, { type: 'enterTextEdit', id, anchor: offset, focus: offset });
        await ok(page, { type: 'setTextSelection', anchor: offset, focus: offset, affinity });
        const value = (await overlay(page))!;
        const want = node.reference.caret(offset, affinity).map((p) => toPage(node.placement, p));
        if (
          value.caret === null ||
          !closePoint(value.caret[0], want[0]!) ||
          !closePoint(value.caret[1], want[1]!)
        ) {
          problems.push(
            `${id} caret ${offset} ${affinity}: ${value.caret?.map(fmt).join(' ')} against ${want.map(fmt).join(' ')}`,
          );
        }
      }
    }
    // Selection: everything up to the first LF, a range over a soft wrap when there is one, and
    // for `w` the whole text, whose selected LFs widen their lines (section 4.3, M6b-Q11 (a)).
    const lf = node.text.indexOf('\n');
    const ranges: [number, number][] = [[0, lf === -1 ? node.text.length : lf]];
    if (id === 'w') ranges.push([0, node.text.length]);
    const wrap = node.layout.lines.findIndex((_, index) => node.reference.softWrapAfter(index));
    if (wrap !== -1) {
      const at = node.layout.lines[wrap]!.end;
      ranges.push([Math.max(0, at - 2), Math.min(lf === -1 ? node.text.length : lf, at + 2)]);
    }
    for (const [min, max] of ranges) {
      await ok(page, { type: 'enterTextEdit', id, anchor: min, focus: max });
      const value = (await overlay(page))!;
      const want = node.reference.selection(min, max).map((r) =>
        [
          { x: r.x, y: r.y },
          { x: r.x + r.width, y: r.y },
          { x: r.x + r.width, y: r.y + r.height },
          { x: r.x, y: r.y + r.height },
        ].map((p) => toPage(node.placement, p)),
      );
      const same =
        value.caret === null &&
        value.selection.length === want.length &&
        value.selection.every((quad, q) => quad.every((p, i) => closePoint(p, want[q]![i]!)));
      if (!same) {
        problems.push(
          `${id} selection [${min}, ${max}): ${JSON.stringify(value.selection)} against ${JSON.stringify(want)}`,
        );
      }
      // The page draws one polygon per quad, at the quad's CSS px.
      const v = await view(page);
      const drawn = await page
        .getByTestId('text-selection')
        .evaluateAll((elements) =>
          elements.map((e) => JSON.parse(e.getAttribute('data-points')!) as [number, number][]),
        );
      const expected = value.selection.map((quad) =>
        quad.map((p) => [(p.x - v.position.x) * v.zoom, (p.y - v.position.y) * v.zoom]),
      );
      if (JSON.stringify(drawn) !== JSON.stringify(expected)) {
        problems.push(
          `${id} drawn selection ${JSON.stringify(drawn)} against ${JSON.stringify(expected)}`,
        );
      }
    }
  }
  // The drawn caret follows the overlay at the camera.
  await enter(page, 't', 2);
  const v = await view(page);
  const caret = (await overlay(page))!.caret!;
  const line = page.getByTestId('text-caret');
  await expect(line).toHaveCount(1);
  const drawn = await line.evaluate((e) =>
    ['x1', 'y1', 'x2', 'y2'].map((k) => Number(e.getAttribute(`data-${k}`))),
  );
  const expected = caret.flatMap((p) => [
    (p.x - v.position.x) * v.zoom,
    (p.y - v.position.y) * v.zoom,
  ]);
  if (!drawn.every((value, i) => close(value, expected[i]!))) {
    problems.push(`drawn caret ${JSON.stringify(drawn)} against ${JSON.stringify(expected)}`);
  }
  await report(testInfo, 'm6b-a12-geometry.json', { readings, problems });
  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
});

test('M6b-A12: a click places the caret, a double-click selects the word, focus stays', async ({
  page,
}, testInfo) => {
  const { errors } = await open(page);
  const problems: string[] = [];
  const presses: unknown[] = [];
  // Double-click entry with the select tool (section 3.2): the word at the point.
  const v = await view(page);
  const t = await nodeOf(page, 't');
  const first = t.layout.clusters[0]!;
  const middle = t.layout.lines[0]!.top + t.layout.lines[0]!.height / 2;
  const word = toClient(v, toPage(t.placement, { x: first.x + first.advance * 0.3, y: middle }));
  await page.mouse.dblclick(word.x, word.y);
  await settle(page);
  const entered = await state(page);
  expect(entered.textEdit).toMatchObject({ id: 't', anchor: 0, focus: 2 });
  expect(entered.focused).toBe('textarea');
  for (const id of ['t', 'w', 'r']) {
    const node = await nodeOf(page, id);
    await enter(page, id, 0);
    for (const cluster of node.layout.clusters) {
      if (node.text[cluster.start] === '\n' || cluster.advance <= 0) continue;
      const line = node.layout.lines[cluster.line]!;
      for (const fraction of [0.3, 0.7]) {
        const local = { x: cluster.x + cluster.advance * fraction, y: line.top + line.height / 2 };
        // A hanging space past the box is outside it: a press there leaves edit mode (3.3).
        const { frame } = node.placement;
        if (local.x >= frame.width || local.y >= frame.height) continue;
        const client = toClient(v, toPage(node.placement, local));
        await clearLog(page);
        await page.mouse.click(client.x, client.y);
        await settle(page);
        const entries = await log(page);
        const down = entries.find((e) => e.type === 'pointerdown');
        const mouse = entries.find((e) => e.type === 'mousedown');
        // The expectation from the point the page received (pointer coordinates may round).
        const received =
          down?.clientX === undefined ? client : { x: down.clientX, y: down.clientY! };
        const want = node.reference.pointToOffset(toLocal(node.placement, fromClient(v, received)));
        const after = await state(page);
        const got = after.textEdit;
        if (
          got === null ||
          got.id !== id ||
          got.anchor !== want.offset ||
          got.focus !== want.offset ||
          got.affinity !== want.affinity
        ) {
          problems.push(
            `${id} click at ${fmt(local)}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`,
          );
        }
        if (after.focused !== 'textarea') problems.push(`${id} click: focus ${after.focused}`);
        if (down?.prevented !== true) problems.push(`${id} click: pointerdown not prevented`);
        presses.push({
          id,
          offset: want.offset,
          pointerdownPrevented: down?.prevented ?? null,
          mousedownPrevented: mouse?.prevented ?? null,
          focused: after.focused,
          focusMoves: entries.filter((e) => e.type === 'focusin' || e.type === 'focusout').length,
        });
      }
    }
  }
  await report(testInfo, 'm6b-a12-clicks.json', { presses, problems });
  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
});

test('M6b-A12: Up and Down move by lines at the goal x', async ({ page }, testInfo) => {
  const { errors } = await open(page);
  const problems: string[] = [];
  const node = await nodeOf(page, 'w');
  const { reference } = node;
  const last = node.layout.lines.length - 1;
  expect(last).toBeGreaterThanOrEqual(2);
  const length = node.text.length;
  const starts = stops(node).filter((o) => reference.lineOf(o, 'downstream') === 0);
  const walks: unknown[] = [];
  for (const start of starts) {
    await enter(page, 'w', start);
    const goal = reference.caretX(start, 0);
    let current: { offset: number; affinity: Affinity } = { offset: start, affinity: 'downstream' };
    const steps: number[] = [];
    const keys = [
      ...Array<string>(last + 1).fill('ArrowDown'),
      ...Array<string>(last + 1).fill('ArrowUp'),
    ];
    for (const key of keys) {
      await page.keyboard.press(key);
      // Section 4.2: the line below or above at the goal x; below the last line to the length,
      // above the first to 0.
      const index = reference.lineOf(current.offset, current.affinity);
      if (key === 'ArrowDown') {
        current =
          index === last
            ? { offset: length, affinity: 'downstream' }
            : reference.nearestOnLine(index + 1, goal);
      } else {
        current =
          index === 0
            ? { offset: 0, affinity: 'downstream' }
            : reference.nearestOnLine(index - 1, goal);
      }
      const got = (await state(page)).textEdit!;
      steps.push(got.focus);
      if (
        got.focus !== current.offset ||
        got.anchor !== current.offset ||
        got.affinity !== current.affinity
      ) {
        problems.push(
          `w from ${start}, ${key} #${steps.length}: ${got.focus} ${got.affinity} against ${current.offset} ${current.affinity}`,
        );
        break;
      }
    }
    walks.push({ start, goal, steps });
  }
  await report(testInfo, 'm6b-a12-vertical.json', {
    lines: node.layout.lines.map((l) => [l.start, l.end]),
    walks,
    problems,
  });
  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// M6b-A13
// ---------------------------------------------------------------------------------------------

/** A `Process` keydown with `keyCode` 229, as an IME sends it (rule 1), through CDP. */
function processKey(cdp: CDPSession, code: string, type: 'rawKeyDown' | 'keyUp' = 'rawKeyDown') {
  return cdp.send('Input.dispatchKeyEvent', {
    type,
    key: 'Process',
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  });
}

test('M6b-A13: real keys follow rules 1 to 6, Tab keeps focus, the clipboard chords run', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
  const { errors } = await open(page);
  const cdp = await context.newCDPSession(page);
  const steps: Record<string, unknown>[] = [];
  const text = async () => (await state(page)).texts.t;
  /** Presses `key`, returns the keydown's log entry and the state after it. */
  const press = async (key: string) => {
    await clearLog(page);
    await page.keyboard.press(key);
    await settle(page);
    const entries = await log(page);
    // The chord's own keydown, after those of its modifiers.
    const down = entries.filter((e) => e.type === 'keydown' && !MODIFIERS.has(e.key ?? '')).at(-1);
    const input = entries.find((e) => e.type === 'beforeinput');
    const after = await state(page);
    steps.push({
      key,
      keydownPrevented: down?.prevented ?? null,
      beforeinput:
        input === undefined
          ? null
          : `${input.inputType} ${JSON.stringify(input.data)} prevented=${input.prevented}`,
      text: after.texts.t,
      textEdit: after.textEdit === null ? null : [after.textEdit.anchor, after.textEdit.focus],
      focused: after.focused,
    });
    return { down, input, after };
  };
  await enter(page, 't', 5);
  const { camera } = await state(page);
  const children = (await state(page)).children;

  // Rule 2: characters pass through to `beforeinput` `insertText`, which the host prevents and
  // maps; `r` (bound to the rectangle tool) and Space (navigation) type too.
  for (const key of ['x', 'y', 'r', 'Space']) {
    const { down, input, after } = await press(key);
    expect(down?.prevented, key).toBe(false);
    expect(input).toMatchObject({ inputType: 'insertText', prevented: true });
    expect(after.tool).toBe('select');
  }
  expect(await text()).toBe('ab cdxyr ');
  expect((await state(page)).camera).toEqual(camera);
  // Rule 3: edit actions, consumed.
  expect((await press('Enter')).down?.prevented).toBe(true);
  expect(await text()).toBe('ab cdxyr \n');
  expect((await press('Backspace')).down?.prevented).toBe(true);
  expect(await text()).toBe('ab cdxyr ');
  expect((await press('Delete')).down?.prevented).toBe(true);
  expect(await text()).toBe('ab cdxyr ');
  expect((await press('Control+Backspace')).down?.prevented).toBe(true);
  expect(await text()).toBe('ab ');
  // Rule 4: movement, Mod+A, undo, redo, Escape.
  expect((await press('ArrowLeft')).after.textEdit).toMatchObject({ anchor: 2, focus: 2 });
  expect((await press('Shift+ArrowLeft')).after.textEdit).toMatchObject({ anchor: 2, focus: 1 });
  expect((await press('ControlOrMeta+A')).after.textEdit).toMatchObject({ anchor: 0, focus: 3 });
  await press('ControlOrMeta+Z');
  expect(await text()).toBe('ab cdxyr ');
  await press('ControlOrMeta+Y');
  expect(await text()).toBe('ab ');
  // Rule 5: Tab and Shift+Tab are consumed no-ops; focus stays on the textarea.
  for (const key of ['Tab', 'Shift+Tab']) {
    const { down, after } = await press(key);
    expect(down?.prevented, key).toBe(true);
    expect(after.focused, key).toBe('textarea');
    expect(after.texts.t).toBe('ab ');
  }
  // Rule 6: a bound chord is a consumed no-op; an unbound key is left alone.
  for (const key of ['ControlOrMeta+D', 'ControlOrMeta+G']) {
    const { down, after } = await press(key);
    expect(down?.prevented, key).toBe(true);
    expect(after.children, key).toEqual(children);
    expect(after.textEdit, key).not.toBeNull();
  }
  expect((await press('F2')).down?.prevented).toBe(false);
  // Rule 1: a `Process` keydown (keyCode 229) passes through, not prevented, changing nothing.
  await clearLog(page);
  await processKey(cdp, 'KeyG');
  await processKey(cdp, 'KeyG', 'keyUp');
  await settle(page);
  const process = (await log(page)).find((e) => e.type === 'keydown');
  expect(process).toMatchObject({ key: 'Process', keyCode: 229, prevented: false });
  expect(await text()).toBe('ab ');
  steps.push({ key: 'Process (CDP)', keydownPrevented: process?.prevented ?? null });
  // Ctrl+C, X and V: not prevented as keys, the DOM clipboard events carry plain text.
  await ok(page, { type: 'setTextSelection', anchor: 0, focus: 2 });
  await clearLog(page);
  await page.keyboard.press('ControlOrMeta+C');
  await settle(page);
  const copy = await log(page);
  expect(copy.find((e) => e.type === 'keydown')?.prevented).toBe(false);
  expect(copy.find((e) => e.type === 'copy')).toMatchObject({
    target: 'textarea',
    prevented: true,
  });
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ab');
  await page.keyboard.press('ControlOrMeta+X');
  await settle(page);
  expect(await text()).toBe(' ');
  await page.keyboard.press('ControlOrMeta+V');
  await settle(page);
  expect(await text()).toBe('ab ');
  // Escape exits with the node selected and focus back on the canvas.
  const escape = await press('Escape');
  expect(escape.down?.prevented).toBe(true);
  expect(escape.after.textEdit).toBeNull();
  expect(escape.after.selection).toEqual(['t']);
  expect(escape.after.focused).toBe('canvas');
  await report(testInfo, 'm6b-a13-keys.json', { steps });
  expect(errors).toEqual([]);
});

test('M6b-A13: a DOM paste of text/plain with HTML reads the plain text, in and outside edit mode', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
  const { errors } = await open(page);
  const plain = 'one\r\ntwo\tthree';
  const write = () =>
    page.evaluate(async (text) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob(['<b>html</b> <i>only</i>'], { type: 'text/html' }),
        }),
      ]);
    }, plain);
  await write();
  await enter(page, 't', 5);
  await clearLog(page);
  await page.keyboard.press('ControlOrMeta+V');
  await settle(page);
  const inside = (await log(page)).find((e) => e.type === 'paste');
  const edited = await state(page);
  // Section 9.1: CR LF becomes LF and a tab one space; the HTML is never read.
  expect(edited.texts.t).toBe('ab cdone\ntwo three');
  expect(edited.textEdit).toMatchObject({ id: 't', anchor: 18, focus: 18 });
  expect(inside).toMatchObject({ target: 'textarea', prevented: true });
  expect(inside?.types).toEqual(expect.arrayContaining(['text/plain', 'text/html']));
  // Outside edit mode: a new text node centred on the pointer over the canvas (section 9.3).
  await page.keyboard.press('Escape');
  await settle(page);
  expect((await state(page)).focused).toBe('canvas');
  const v = await view(page);
  const hover = toClient(v, EMPTY);
  await page.mouse.move(hover.x, hover.y);
  await write();
  const before = (await state(page)).children;
  await clearLog(page);
  await page.keyboard.press('ControlOrMeta+V');
  await settle(page);
  const outside = (await log(page)).find((e) => e.type === 'paste');
  const after = await state(page);
  expect(outside).toMatchObject({ target: 'canvas', prevented: true });
  expect(after.children.slice(0, -1)).toEqual(before);
  const created = after.children.at(-1)!;
  expect(after.texts[created]).toBe('one\ntwo three');
  expect(after.selection).toEqual([created]);
  expect(after.textEdit).toBeNull();
  const frame = await page.evaluate(
    (id) => window.__p5Host!.editor.getSnapshot().document.nodes[id]!.frame,
    created,
  );
  // The pointer the page mapped is the received client point, so allow a CSS px of rounding.
  const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  expect(Math.abs(centre.x - EMPTY.x)).toBeLessThanOrEqual(1 / v.zoom);
  expect(Math.abs(centre.y - EMPTY.y)).toBeLessThanOrEqual(1 / v.zoom);
  await report(testInfo, 'm6b-a13-paste.json', { inside, outside, frame, centre });
  expect(errors).toEqual([]);
});

test('M6b-A13: presses in edit mode keep focus on the textarea, which sits at the caret', async ({
  page,
  context,
}, testInfo) => {
  const { errors } = await open(page);
  const cdp = await context.newCDPSession(page);
  const readings: Record<string, unknown> = {};
  /** Presses with `button` at the page point and reads prevention and focus. */
  const pressAt = async (name: string, point: Point, button: 'left' | 'middle' = 'left') => {
    const v = await view(page);
    const client = toClient(v, point);
    await clearLog(page);
    await page.mouse.move(client.x, client.y);
    await page.mouse.down({ button });
    await page.mouse.up({ button });
    await settle(page);
    const entries = await log(page);
    const after = await state(page);
    const reading = {
      pointerdownPrevented: entries.find((e) => e.type === 'pointerdown')?.prevented ?? null,
      mousedownPrevented: entries.find((e) => e.type === 'mousedown')?.prevented ?? null,
      focused: after.focused,
      textEdit: after.textEdit !== null,
      composition: entries
        .filter((e) => e.type.startsWith('composition'))
        .map((e) => `${e.type} ${JSON.stringify(e.data)}`),
      focusMoves: entries
        .filter((e) => e.type === 'focusin' || e.type === 'focusout')
        .map((e) => `${e.type} ${e.target}->${e.related}`),
    };
    readings[name] = reading;
    return { reading, after };
  };
  /** The textarea's box against the caret's client segment (M6b-H1). */
  const placement = async (name: string) => {
    const v = await view(page);
    const value = (await overlay(page))!;
    const box = await page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Text input"]',
      )!;
      const rect = textarea.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        height: rect.height,
        fontSize: getComputedStyle(textarea).fontSize,
      };
    });
    const at = toClient(v, { x: value.inputRect.x, y: value.inputRect.y });
    const reading = { inputRect: value.inputRect, caretClient: at, textarea: box };
    readings[`placement ${name}`] = reading;
    return { at, box, height: value.inputRect.height * v.zoom };
  };
  const t = await nodeOf(page, 't');
  const inside = toPage(t.placement, {
    x: t.layout.clusters[1]!.x + 1,
    y: t.layout.lines[0]!.top + 5,
  });

  await enter(page, 't', 5);
  for (const name of ['t']) {
    const { at, box, height } = await placement(name);
    expect(Math.abs(box.left - at.x)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
    expect(Math.abs(box.top - at.y)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
    expect(Math.abs(box.height - Math.max(height, 1))).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
  }
  // The rotated node: the textarea at the top-left of the caret's axis-aligned box.
  await enter(page, 'r', 3);
  {
    const { at, box, height } = await placement('r');
    expect(Math.abs(box.left - at.x)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
    expect(Math.abs(box.top - at.y)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
    expect(Math.abs(box.height - Math.max(height, 1))).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
  }
  await enter(page, 't', 5);
  // A press inside: prevented, focus stays on the textarea (section 7.2, M6b-U7 note 4).
  {
    const { reading } = await pressAt('inside', inside);
    expect(reading).toMatchObject({
      pointerdownPrevented: true,
      focused: 'textarea',
      textEdit: true,
    });
  }
  // A middle-button press (navigation) in edit mode: prevented, focus kept.
  {
    const { reading } = await pressAt('middle', EMPTY, 'middle');
    expect(reading).toMatchObject({
      pointerdownPrevented: true,
      focused: 'textarea',
      textEdit: true,
    });
  }
  // A press inside during a composition: the forced end commits, focus stays, M6b-H5 drops a
  // late `compositionend`.
  await enter(page, 't', 5);
  await processKey(cdp, 'KeyG');
  await cdp.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 });
  await settle(page);
  expect((await state(page)).textEdit?.composition).not.toBeNull();
  {
    const { reading, after } = await pressAt('inside while composing', inside);
    expect(reading).toMatchObject({
      pointerdownPrevented: true,
      focused: 'textarea',
      textEdit: true,
    });
    expect(after.texts.t).toBe('ab cd하');
    expect(after.textEdit?.composition).toBeNull();
    expect(after.undoDepth).toBe(1);
    expect(after.textarea).toBe('');
  }
  // Typing after it goes in once, at the caret the press placed.
  {
    const { textEdit } = await state(page);
    await page.keyboard.press('x');
    await settle(page);
    const at = textEdit!.focus;
    expect((await state(page)).texts.t).toBe(`${'ab cd하'.slice(0, at)}x${'ab cd하'.slice(at)}`);
  }
  // A press outside: not prevented, edit mode ends, focus moves to the canvas.
  {
    const { reading } = await pressAt('outside', EMPTY);
    expect(reading).toMatchObject({
      pointerdownPrevented: false,
      focused: 'canvas',
      textEdit: false,
    });
  }
  // The text tool on a text node enters at the press (section 3.2): prevented, focus moves to
  // the textarea.
  await page.getByTestId('tool-text').click();
  expect((await state(page)).tool).toBe('text');
  {
    const { reading, after } = await pressAt('text tool on a node', inside);
    expect(reading).toMatchObject({
      pointerdownPrevented: true,
      focused: 'textarea',
      textEdit: true,
    });
    expect(after.textEdit?.id).toBe('t');
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // The text tool on empty canvas: the pending node starts at the release (M6b-U3 note 3), so
  // the `pointerdown` is not prevented (edit mode is not set after it); focus moves to the
  // textarea when edit mode starts.
  await page.getByTestId('tool-text').click();
  {
    const { reading, after } = await pressAt('text tool on empty canvas', EMPTY);
    expect(reading).toMatchObject({
      pointerdownPrevented: false,
      focused: 'textarea',
      textEdit: true,
    });
    expect(after.tool).toBe('select');
    expect(after.textEdit?.pending).not.toBeNull();
    const { at, box, height } = await placement('pending');
    expect(Math.abs(box.left - at.x)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
    expect(Math.abs(box.top - at.y)).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
    expect(Math.abs(box.height - Math.max(height, 1))).toBeLessThanOrEqual(PLACEMENT_TOLERANCE);
  }
  await report(testInfo, 'm6b-a13-presses.json', readings);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// M6b-A13: the synthetic traces through CDP
// ---------------------------------------------------------------------------------------------

type TraceEvent = Readonly<{
  seq: number;
  beforeMessage: number;
  type: string;
  target: string;
  key?: string;
  code?: string;
  keyCode?: number;
  mods?: Readonly<{ alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }>;
  inputType?: string;
  data?: string | null;
  relatedTarget?: string;
  during?: 'host-blur';
}>;

type Trace = Readonly<{
  appendixCase: number;
  title: string;
  replay: Readonly<{
    /**
     * Where a trace's press lands at this page's geometry (the trace's client points are the
     * unit test's); without it, inside when the trace ends in edit mode, else outside.
     * Recorded traces (M6b-U10) set it.
     */
    press?: 'inside' | 'outside';
    start: Readonly<{ edit: string; anchor: number; focus: number }> | Readonly<{ pending: Point }>;
    expect: Readonly<{
      node: string;
      text?: string;
      anchor?: number;
      focus?: number;
      undoDepth: number;
      textEdit: boolean;
      focused: string;
      textarea: string;
    }>;
  }>;
  events: readonly TraceEvent[];
}>;

/** Appendix A: cases 5, 7 and 10 cannot be made through CDP; they are unit-only (A10). */
const UNIT_ONLY_CASES = new Set([5, 7, 10]);
const TRACES = readdirSync(TRACE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map(
    (name) =>
      [name, JSON.parse(readFileSync(path.join(TRACE_DIR, name), 'utf8')) as Trace] as const,
  )
  .filter(([, trace]) => !UNIT_ONLY_CASES.has(trace.appendixCase));

/** Playwright key names for the trace keys a real keyboard sends without an IME. */
const KEY_NAMES: Readonly<Record<string, string>> = { ' ': 'Space' };
const modifierBits = (mods: TraceEvent['mods']) =>
  mods === undefined
    ? 0
    : (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);

/**
 * Replays a trace's events through CDP and real input. A keydown with `keyCode` 229 is a CDP
 * `Process` keydown; any other keydown and keyup is Playwright's keyboard, whose own
 * `beforeinput` stands for the trace's next one; a composition update is
 * `Input.imeSetComposition`, a non-empty end `Input.insertText`, an empty end an empty
 * composition; a `beforeinput` `insertText` that no real key made is `Input.insertText`, an
 * `insertLineBreak` a CDP `char` event of CR (no keydown). A press is a real click inside or
 * outside the edited node (the trace's client points are the unit test's), a blur to `#panel`
 * focus moved to the appearance panel's first input; the browser makes the `compositionend` that
 * follows either. Recorder-only types, starts (CDP starts a composition with its first update),
 * the `during: "host-blur"` events and pointer releases are skipped.
 */
async function replayTrace(
  page: Page,
  cdp: CDPSession,
  trace: Trace,
  points: Readonly<{ inside: Point; outside: Point }>,
) {
  const held = new Set<string>();
  let group: number | null = null;
  let realKeyInGroup = false;
  let browserEnds = false;
  const v = await view(page);
  for (const event of trace.events) {
    if (event.during === 'host-blur') continue;
    if (group !== null && event.beforeMessage !== group) {
      await settle(page);
      realKeyInGroup = false;
    }
    group = event.beforeMessage;
    switch (event.type) {
      case 'keydown': {
        if (event.keyCode === 229) {
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: 'Process',
            code: event.code ?? '',
            windowsVirtualKeyCode: 229,
            nativeVirtualKeyCode: 229,
            modifiers: modifierBits(event.mods),
          });
          realKeyInGroup = false;
        } else {
          const name = KEY_NAMES[event.key ?? ''] ?? event.key ?? '';
          if (held.has(name)) await page.keyboard.up(name);
          if (event.mods?.shift === true) await page.keyboard.down('Shift');
          await page.keyboard.down(name);
          if (event.mods?.shift === true) await page.keyboard.up('Shift');
          held.add(name);
          realKeyInGroup = true;
        }
        break;
      }
      case 'keyup': {
        const name = KEY_NAMES[event.key ?? ''] ?? event.key ?? '';
        if (held.has(name)) {
          await page.keyboard.up(name);
          held.delete(name);
        } else {
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: event.key ?? '',
            code: event.code ?? '',
            windowsVirtualKeyCode: event.keyCode ?? 0,
            nativeVirtualKeyCode: event.keyCode ?? 0,
          });
        }
        break;
      }
      case 'compositionupdate':
        if ((event.data ?? '') !== '') {
          const text = event.data!;
          await cdp.send('Input.imeSetComposition', {
            text,
            selectionStart: text.length,
            selectionEnd: text.length,
          });
        }
        break;
      case 'compositionend':
        if (browserEnds) break;
        if ((event.data ?? '') === '') {
          await cdp.send('Input.imeSetComposition', {
            text: '',
            selectionStart: 0,
            selectionEnd: 0,
          });
        } else {
          await cdp.send('Input.insertText', { text: event.data! });
        }
        break;
      case 'beforeinput':
        if (realKeyInGroup) break;
        if (event.inputType === 'insertText') {
          await cdp.send('Input.insertText', { text: event.data ?? '' });
        } else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'char',
            text: '\r',
            unmodifiedText: '\r',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
          });
        }
        break;
      case 'pointerdown': {
        const side = trace.replay.press ?? (trace.replay.expect.textEdit ? 'inside' : 'outside');
        const target = toClient(v, side === 'inside' ? points.inside : points.outside);
        await page.mouse.click(target.x, target.y);
        browserEnds = true;
        break;
      }
      case 'blur':
        if (event.relatedTarget === '#panel') {
          // Focus, not a click: a click on the panel's range input would also set the opacity.
          await page.getByTestId('appearance-panel').locator('input').first().focus();
          browserEnds = true;
        }
        break;
      default:
        break;
    }
  }
  for (const name of held) await page.keyboard.up(name);
  await settle(page);
}

for (const [name, trace] of TRACES) {
  test(`M6b-A13: trace ${name} replays through CDP (${trace.title})`, async ({
    page,
    context,
  }, testInfo) => {
    const { errors } = await open(page);
    const cdp = await context.newCDPSession(page);
    const t = await nodeOf(page, 't');
    // Inside: offset 1 of `t` (the unit traces' "page x 15"), clear of the cluster's middle.
    const c1 = t.layout.clusters[1]!;
    const inside = toPage(t.placement, {
      x: c1.x + c1.advance * 0.2,
      y: t.layout.lines[0]!.top + t.layout.lines[0]!.height / 2,
    });
    const start = trace.replay.start;
    if ('edit' in start) {
      await ok(page, {
        type: 'enterTextEdit',
        id: start.edit,
        anchor: start.anchor,
        focus: start.focus,
      });
    } else {
      await page.getByTestId('tool-text').click();
      const client = toClient(await view(page), start.pending);
      await page.mouse.click(client.x, client.y);
    }
    await settle(page);
    const before = await state(page);
    expect(before.focused).toBe('textarea');
    await clearLog(page);
    await replayTrace(page, cdp, trace, { inside, outside: EMPTY });
    const after = await state(page);
    const entries = await log(page);
    const want = trace.replay.expect;
    const reading = {
      trace: name,
      expect: want,
      got: {
        text:
          want.node === 'created' ? after.texts[after.children.at(-1)!] : after.texts[want.node],
        textEdit: after.textEdit,
        undoDepth: after.undoDepth,
        focused: after.focused,
        textarea: after.textarea,
      },
      events: entries
        .filter((e) => !['pointerup', 'keyup'].includes(e.type))
        .map((e) =>
          [
            e.type,
            e.key ?? '',
            e.keyCode ?? '',
            e.inputType ?? '',
            e.data === undefined ? '' : JSON.stringify(e.data),
            e.prevented ? 'prevented' : '',
            `focus=${e.focused}`,
          ]
            .filter((part) => part !== '')
            .join(' '),
        ),
    };
    await report(testInfo, `m6b-a13-trace-${name}`, reading);
    if (want.node === 'pending') {
      expect(after.textEdit?.pending).not.toBeNull();
      expect(after.children).toEqual(before.children);
    } else if (want.node === 'created') {
      expect(after.children.slice(0, -1)).toEqual(before.children);
      expect(after.texts[after.children.at(-1)!]).toBe(want.text);
      expect(after.textEdit?.id ?? after.children.at(-1)).toBe(after.children.at(-1));
    } else {
      expect(after.children).toEqual(before.children);
      expect(after.texts[want.node]).toBe(want.text);
    }
    expect(after.textEdit !== null).toBe(want.textEdit);
    if (want.anchor !== undefined) {
      expect({ anchor: after.textEdit?.anchor, focus: after.textEdit?.focus }).toEqual({
        anchor: want.anchor,
        focus: want.focus,
      });
    }
    expect(after.textEdit?.composition ?? null).toBeNull();
    expect(after.undoDepth).toBe(want.undoDepth);
    expect(after.focused).toBe(want.focused);
    expect(after.textarea).toBe(want.textarea);
    // Rule 1: no keydown with keyCode 229 was prevented.
    expect(entries.filter((e) => e.type === 'keydown' && e.keyCode === 229 && e.prevented)).toEqual(
      [],
    );
    expect(errors).toEqual([]);
  });
}
