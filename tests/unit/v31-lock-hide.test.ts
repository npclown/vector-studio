import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type Modifiers,
  type PagePoint,
} from '../../packages/editor-core/src/index.js';
import { parseDocument, serializeDocument, validateNode } from '../../packages/model/src/index.js';
import { layerRows, lockCommand, visibilityCommand } from '../../packages/ui/src/layer-model.js';
import { EditorProvider, LayerTree } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import { contextMenuItems } from '../../packages/ui/src/context-menu-model.js';

// V-31 contract (docs/plans/viz-v31-lock-hide-contract.md): layer lock and hide.

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const shift: Modifiers = { ...none, shift: true };
const alt: Modifiers = { ...none, alt: true };
const ctrlShift: Modifiers = { ...none, ctrl: true, shift: true };
const RED = { r: 1, g: 0, b: 0, a: 1 };

function editor(adoptIntoFrames = false): Editor {
  const target = createEditor({
    ids: createCounterIdSource('n'),
    platform: 'other',
    adoptIntoFrames,
    textLayout: createFakeTextLayout(),
  });
  ok(target, { type: 'setViewportSize', width: 1200, height: 800 });
  ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
  modifiers: Modifiers = none,
) {
  ok(target, { type: 'input', event: { kind, point, modifiers } });
}

function click(target: Editor, point: PagePoint, modifiers: Modifiers = none): void {
  pointer(target, 'pointerdown', point, modifiers);
  pointer(target, 'pointerup', point, modifiers);
}

function drag(target: Editor, from: PagePoint, to: PagePoint, modifiers: Modifiers = none) {
  pointer(target, 'pointerdown', from, modifiers);
  pointer(target, 'pointermove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, modifiers);
  pointer(target, 'pointermove', to, modifiers);
  pointer(target, 'pointerup', to, modifiers);
}

function doubleClick(target: Editor, point: PagePoint): void {
  click(target, point);
  ok(target, { type: 'input', event: { kind: 'doubleclick', point, modifiers: none } });
}

function press(target: Editor, key: string, modifiers: Modifiers = none): CommandResult {
  return target.execute({ type: 'input', event: { kind: 'keydown', key, modifiers } });
}

function rect(target: Editor, x: number, y: number, size = 40, parent?: string): string {
  return ok(target, {
    type: 'createRectangle',
    frame: { x, y, width: size, height: size },
    fill: RED,
    ...(parent === undefined ? {} : { parent }),
  })[0]!;
}

const node = (target: Editor, id: string) => target.getSnapshot().document.nodes[id]!;
const selectionOf = (target: Editor) => target.getSnapshot().selection;
const depth = (target: Editor) => target.getSnapshot().history.undoDepth;
const lock = (target: Editor, ids: readonly string[], locked = true) =>
  ok(target, { type: 'setLayerState', ids, locked });

/** `under` at (0, 0) 100×100, `top` over it at (20, 20) 40×40, `side` at (200, 0). */
function stack(target: Editor) {
  const under = rect(target, 0, 0, 100);
  const top = rect(target, 20, 20);
  const side = rect(target, 200, 0);
  ok(target, { type: 'setSelection', ids: [] });
  return { under, top, side };
}

describe('V31-A01 schema: the optional `locked` key', () => {
  const doc = (extra: Record<string, unknown>, version = 8) =>
    JSON.stringify({
      schemaVersion: version,
      id: 'd',
      pages: [{ id: 'p', name: 'P', children: ['a'] }],
      nodes: {
        a: {
          id: 'a',
          name: 'A',
          parent: 'p',
          frame: { x: 0, y: 0, width: 10, height: 10 },
          rotation: 0,
          constraints: { horizontal: 'start', vertical: 'start' },
          opacity: 1,
          visible: true,
          type: 'ellipse',
          fill: null,
          stroke: null,
          effects: [],
          ...extra,
        },
      },
    });

  it('reads absent and false as unlocked with no key, true as locked', () => {
    for (const extra of [{}, { locked: false }]) {
      const result = parseDocument(doc(extra));
      expect(result.ok).toBe(true);
      if (result.ok) expect(Object.hasOwn(result.document.nodes.a!, 'locked')).toBe(false);
    }
    const locked = parseDocument(doc({ locked: true }));
    expect(locked.ok && locked.document.nodes.a!.locked).toBe(true);
  });

  it('writes `locked: true` last and nothing for an unlocked node; round trips', () => {
    const plain = parseDocument(doc({}));
    const locked = parseDocument(doc({ locked: true }));
    if (!plain.ok || !locked.ok) throw new Error('parse');
    const plainText = serializeDocument(plain.document);
    expect(plainText).not.toContain('locked');
    const lockedText = serializeDocument(locked.document);
    expect(lockedText).toMatch(/"effects": \[\],\n {6}"locked": true\n {4}\}/u);
    const again = parseDocument(lockedText);
    expect(again.ok && serializeDocument(again.document)).toBe(lockedText);
  });

  it('a v7 input reads unlocked and refuses the v8-only key', () => {
    const v7 = parseDocument(doc({}, 7));
    expect(v7.ok && Object.hasOwn(v7.document.nodes.a!, 'locked')).toBe(false);
    expect(parseDocument(doc({ locked: true }, 7))).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/a/locked',
    });
  });

  it('fails a non-boolean at its path', () => {
    for (const value of [1, 'true', null]) {
      expect(parseDocument(doc({ locked: value }))).toEqual({
        ok: false,
        code: 'document.invalid-field',
        path: '/nodes/a/locked',
      });
    }
    const result = parseDocument(doc({}));
    if (!result.ok) throw new Error('parse');
    expect(validateNode({ ...result.document.nodes.a!, locked: 0 })).toMatchObject({
      ok: false,
      path: '/locked',
    });
  });
});

describe('V31-A02 hit test skips locked nodes', () => {
  it('a click on a locked node selects what is under it', () => {
    const target = editor();
    const { under, top } = stack(target);
    lock(target, [top]);
    click(target, { x: 40, y: 40 });
    expect(selectionOf(target)).toEqual([under]);
  });

  it('a click on a child of a locked group selects what is under it, and none of the group', () => {
    const target = editor();
    const { under, top } = stack(target);
    const [group] = ok(target, { type: 'groupNodes', ids: [top], kind: 'group' });
    lock(target, [group!]);
    click(target, { x: 40, y: 40 });
    expect(selectionOf(target)).toEqual([under]);
    // A double-click on it does not enter the locked group.
    ok(target, { type: 'setSelection', ids: [] });
    doubleClick(target, { x: 40, y: 40 });
    expect(target.getSnapshot().scope).toBeNull();
    expect(selectionOf(target)).toEqual([under]);
    // Unlocked, the same double-click enters the group (the control case).
    lock(target, [group!], false);
    ok(target, { type: 'setSelection', ids: [] });
    doubleClick(target, { x: 40, y: 40 });
    expect(target.getSnapshot().scope).toBe(group);
  });

  it('a double-click on a locked path or text node starts no edit mode', () => {
    const target = editor();
    const [path] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 40, 0, 40, 40],
      fill: RED,
    });
    const [text] = ok(target, {
      type: 'createText',
      frame: { x: 100, y: 0, width: 80, height: 20 },
      runs: [{ text: 'locked', family: 'Test', size: 12, color: RED }],
    });
    lock(target, [path!, text!]);
    ok(target, { type: 'setSelection', ids: [] });
    doubleClick(target, { x: 35, y: 10 });
    doubleClick(target, { x: 110, y: 8 });
    expect(target.getSnapshot().pathEdit).toBeNull();
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(selectionOf(target)).toEqual([]);
    // Unlocked, the same double-clicks start path and text editing (the control case).
    lock(target, [path!, text!], false);
    ok(target, { type: 'setSelection', ids: [] });
    doubleClick(target, { x: 35, y: 10 });
    expect(target.getSnapshot().pathEdit?.id).toBe(path);
    press(target, 'Escape');
    ok(target, { type: 'setSelection', ids: [] });
    doubleClick(target, { x: 110, y: 8 });
    expect(target.query({ type: 'textEdit' })?.id).toBe(text);
  });

  it("a locked child of a symbol is still hit through each instance (only the instance's lock counts)", () => {
    const target = editor();
    const child = rect(target, 0, 0);
    const [symbol] = ok(target, { type: 'createSymbol', ids: [child] });
    lock(target, [child]);
    const [instance] = ok(target, {
      type: 'createInstance',
      symbol: symbol!,
      frame: { x: 300, y: 0, width: 40, height: 40 },
    });
    ok(target, { type: 'setSelection', ids: [] });
    click(target, { x: 320, y: 20 });
    expect(selectionOf(target)).toEqual([instance]);
    lock(target, [instance!]);
    ok(target, { type: 'setSelection', ids: [] });
    click(target, { x: 320, y: 20 });
    expect(selectionOf(target)).toEqual([]);
  });

  it('a marquee skips locked nodes; hidden ones stay skipped', () => {
    const target = editor();
    const { under, top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setLayerState', ids: [side], visible: false });
    drag(target, { x: -10, y: -10 }, { x: 300, y: 300 });
    expect(selectionOf(target)).toEqual([under]);
  });
});

describe('V31-A03 a locked selection is not transformed on the canvas', () => {
  it('shows the outline without handles', () => {
    const target = editor();
    const { top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setSelection', ids: [top] });
    const handles = target.query({ type: 'handles' })!;
    expect(handles.handles).toEqual([]);
    expect(handles.corners).toHaveLength(4);
    ok(target, { type: 'setSelection', ids: [side] });
    expect(target.query({ type: 'handles' })!.handles.length).toBeGreaterThan(0);
  });

  it('handle presses, drags inside the box and Alt-drags never move or copy it', () => {
    const target = editor();
    const { top } = stack(target);
    lock(target, [top]);
    const before = target.getSnapshot().document;
    for (const modifiers of [none, alt]) {
      ok(target, { type: 'setSelection', ids: [top] });
      // The bottom-right handle, then the middle of the box (over `under`, which then moves).
      drag(target, { x: 60, y: 60 }, { x: 90, y: 90 }, modifiers);
      expect(node(target, top).frame).toEqual(before.nodes[top]!.frame);
    }
    expect(Object.keys(target.getSnapshot().document.nodes).length).toBe(
      Object.keys(before.nodes).length + 1,
    );
  });

  it('with a mixed selection a press on the unlocked node moves only that node', () => {
    const target = editor();
    const { top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setSelection', ids: [top, side] });
    drag(target, { x: 220, y: 20 }, { x: 230, y: 40 });
    expect(selectionOf(target)).toEqual([side]);
    expect(node(target, side).frame).toMatchObject({ x: 210, y: 20 });
    expect(node(target, top).frame).toMatchObject({ x: 20, y: 20 });
  });

  it('a press on a container background inside a locked selection acts as on an empty selection', () => {
    const target = editor();
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 300, height: 300 },
      fill: RED,
    });
    const inner = rect(target, 100, 100, 40, frame);
    lock(target, [inner]);
    ok(target, { type: 'setSelection', ids: [inner] });
    // Inside the locked node's box, over the frame's background (the artboard background).
    drag(target, { x: 110, y: 110 }, { x: 150, y: 150 });
    // The press selects and drags the artboard itself (the locked child rides along, V31-Q4);
    // the locked node is never moved on its own inside its parent.
    expect(selectionOf(target)).toEqual([frame]);
    expect(node(target, frame!).frame).toMatchObject({ x: 40, y: 40 });
    expect(node(target, inner).frame).toMatchObject({ x: 100, y: 100 });
  });

  it('an Alt-drag on the unlocked node of a mixed selection duplicates only that node', () => {
    const target = editor();
    const { top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setSelection', ids: [top, side] });
    const count = Object.keys(target.getSnapshot().document.nodes).length;
    drag(target, { x: 220, y: 20 }, { x: 220, y: 120 }, alt);
    expect(Object.keys(target.getSnapshot().document.nodes).length).toBe(count + 1);
    expect(node(target, side).frame).toMatchObject({ x: 200, y: 0 });
    expect(node(target, top).frame).toMatchObject({ x: 20, y: 20 });
    const [copy] = selectionOf(target);
    expect(node(target, copy!).frame).toMatchObject({ x: 200, y: 100 });
  });

  it('Shift-click toggles in the held selection', () => {
    const target = editor();
    const { top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setSelection', ids: [top] });
    click(target, { x: 220, y: 20 }, shift);
    expect(selectionOf(target)).toEqual([top, side]);
  });

  it('nudges skip locked nodes; Enter does nothing; property edits apply', () => {
    const target = editor();
    const { top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setSelection', ids: [top, side] });
    expect(press(target, 'ArrowRight')).toMatchObject({ ok: true, consumed: true });
    expect(node(target, top).frame.x).toBe(20);
    expect(node(target, side).frame.x).toBe(201);
    ok(target, { type: 'setSelection', ids: [top] });
    const steps = depth(target);
    expect(press(target, 'ArrowRight')).toMatchObject({ ok: true, consumed: true });
    expect(depth(target)).toBe(steps);
    const [group] = ok(target, { type: 'groupNodes', ids: [top], kind: 'group' });
    lock(target, [group!]);
    ok(target, { type: 'setSelection', ids: [group!] });
    press(target, 'Enter');
    expect(target.getSnapshot().scope).toBeNull();
    ok(target, { type: 'setNodeProps', id: top, props: { opacity: 0.5 } });
    expect(node(target, top).opacity).toBe(0.5);
  });

  it('locking the path in edit mode ends edit mode and keeps the selection', () => {
    const target = editor();
    const [path] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 40, 0, 40, 40],
    });
    ok(target, { type: 'setSelection', ids: [path!] });
    ok(target, { type: 'enterPathEdit', id: path! });
    expect(target.getSnapshot().pathEdit).not.toBeNull();
    ok(target, { type: 'setNodeProps', id: path!, props: { locked: true } });
    expect(target.getSnapshot().pathEdit).toBeNull();
    expect(selectionOf(target)).toEqual([path]);
  });

  it('locking the text node in text edit mode ends it and keeps the selection', () => {
    const target = editor();
    const [text] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 80, height: 20 },
      runs: [{ text: 'edit me', family: 'Test', size: 12, color: RED }],
    });
    ok(target, { type: 'setSelection', ids: [text!] });
    ok(target, { type: 'enterTextEdit', id: text! });
    expect(target.query({ type: 'textEdit' })).not.toBeNull();
    lock(target, [text!]);
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(selectionOf(target)).toEqual([text]);
  });
});

describe('V31-A04 commands, actions and select all', () => {
  it('setLayerState sets both flags in one step; false removes the key; no change no step', () => {
    const target = editor();
    const { top, side } = stack(target);
    const steps = depth(target);
    ok(target, { type: 'setLayerState', ids: [top, side], locked: true, visible: false });
    expect(depth(target)).toBe(steps + 1);
    expect([node(target, top), node(target, side)]).toMatchObject([
      { locked: true, visible: false },
      { locked: true, visible: false },
    ]);
    ok(target, { type: 'setLayerState', ids: [top, side], locked: true });
    expect(depth(target)).toBe(steps + 1);
    ok(target, { type: 'setLayerState', ids: [top], locked: false });
    expect(Object.hasOwn(node(target, top), 'locked')).toBe(false);
    ok(target, { type: 'undo' });
    expect(node(target, top).locked).toBe(true);
    ok(target, { type: 'setNodeProps', id: side, props: { locked: false } });
    expect(Object.hasOwn(node(target, side), 'locked')).toBe(false);
  });

  it('setLayerState refuses unknown IDs, other pages and an empty change', () => {
    const target = editor();
    const { top } = stack(target);
    expect(target.execute({ type: 'setLayerState', ids: ['nope'], locked: true })).toMatchObject({
      ok: false,
      code: 'editor.unknown-node',
    });
    expect(target.execute({ type: 'setLayerState', ids: [top] })).toMatchObject({
      ok: false,
      code: 'editor.invalid-command',
    });
    const [page] = ok(target, { type: 'addPage', name: 'Two' });
    ok(target, { type: 'setActivePage', id: page! });
    expect(target.execute({ type: 'setLayerState', ids: [top], locked: true })).toMatchObject({
      ok: false,
      code: 'editor.unknown-node',
    });
  });

  it('Mod+Shift+L and Mod+Shift+H toggle the selection in one step each', () => {
    const target = editor();
    const { top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setSelection', ids: [top, side] });
    const steps = depth(target);
    // One unlocked: lock all.
    expect(press(target, 'L', ctrlShift)).toMatchObject({ ok: true, consumed: true });
    expect([node(target, top).locked, node(target, side).locked]).toEqual([true, true]);
    expect(press(target, 'L', ctrlShift)).toMatchObject({ ok: true, consumed: true });
    expect([node(target, top).locked, node(target, side).locked]).toEqual([undefined, undefined]);
    expect(press(target, 'H', ctrlShift)).toMatchObject({ ok: true, consumed: true });
    expect([node(target, top).visible, node(target, side).visible]).toEqual([false, false]);
    expect(selectionOf(target)).toEqual([top, side]);
    expect(press(target, 'H', ctrlShift)).toMatchObject({ ok: true, consumed: true });
    expect(node(target, top).visible).toBe(true);
    expect(depth(target)).toBe(steps + 4);
    ok(target, { type: 'setSelection', ids: [] });
    expect(press(target, 'L', ctrlShift)).toMatchObject({ ok: true, consumed: true });
    expect(depth(target)).toBe(steps + 4);
  });

  it('select all skips locked and hidden nodes', () => {
    const target = editor();
    const { under, top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setLayerState', ids: [side], visible: false });
    press(target, 'a', { ...none, ctrl: true });
    expect(selectionOf(target)).toEqual([under]);
  });

  it('nothing is adopted into a locked frame, drawn or moved', () => {
    const target = editor(true);
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 300, height: 300 },
    });
    lock(target, [frame!]);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    drag(target, { x: 20, y: 20 }, { x: 60, y: 60 });
    const [drawn] = selectionOf(target);
    expect(node(target, drawn!).parent).toBe(target.getSnapshot().activePage);
    const outside = rect(target, 400, 0);
    ok(target, { type: 'setTool', tool: 'select' });
    ok(target, { type: 'setSelection', ids: [outside] });
    drag(target, { x: 420, y: 20 }, { x: 120, y: 120 });
    expect(node(target, outside).parent).toBe(target.getSnapshot().activePage);
    drag(target, { x: 120, y: 120 }, { x: 150, y: 150 }, alt);
    const copies = selectionOf(target);
    expect(copies).not.toContain(outside);
    expect(node(target, copies[0]!).parent).toBe(target.getSnapshot().activePage);
  });

  it('detach keeps the lock of the instance', () => {
    const target = editor();
    const child = rect(target, 0, 0);
    const [symbol] = ok(target, { type: 'createSymbol', ids: [child] });
    const [instance] = ok(target, { type: 'createInstance', symbol: symbol! });
    lock(target, [instance!]);
    const [frame] = ok(target, { type: 'detachInstances', ids: [instance!] });
    expect(node(target, frame ?? instance!)).toMatchObject({ type: 'frame', locked: true });
  });

  it('duplicate and paste keep the lock', () => {
    const target = editor();
    const { top } = stack(target);
    lock(target, [top]);
    const [copy] = ok(target, { type: 'duplicateNodes', ids: [top] });
    expect(node(target, copy!).locked).toBe(true);
    ok(target, { type: 'copy', ids: [top] });
    const [pasted] = ok(target, { type: 'paste' });
    expect(node(target, pasted!).locked).toBe(true);
  });
});

describe('V31-A05 layer rows and the context menu', () => {
  it('rows carry their own lock and the inherited state of their ancestors', () => {
    const target = editor();
    const { top, side } = stack(target);
    const [group] = ok(target, { type: 'groupNodes', ids: [top], kind: 'group' });
    lock(target, [group!]);
    ok(target, { type: 'setLayerState', ids: [side], visible: false });
    const { document, activePage } = target.getSnapshot();
    const rows = layerRows(document, activePage, new Set([group!]), []);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(group!)).toMatchObject({ locked: true, inherited: null });
    expect(byId.get(top)).toMatchObject({ locked: false, inherited: 'locked' });
    expect(byId.get(side)).toMatchObject({ visible: false, inherited: null });
  });

  it('the row buttons send setNodeProps and show their state', () => {
    const target = editor();
    const { top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setLayerState', ids: [side], visible: false });
    const { document, activePage } = target.getSnapshot();
    const rows = new Map(layerRows(document, activePage, new Set(), []).map((r) => [r.id, r]));
    expect(lockCommand(rows.get(top)!)).toEqual({
      type: 'setNodeProps',
      id: top,
      props: { locked: false },
    });
    expect(lockCommand(rows.get(side)!)).toEqual({
      type: 'setNodeProps',
      id: side,
      props: { locked: true },
    });
    expect(visibilityCommand(rows.get(side)!)).toEqual({
      type: 'setNodeProps',
      id: side,
      props: { visible: true },
    });
    const html = renderToString(
      createElement(EditorProvider, { editor: target }, createElement(LayerTree)),
    );
    const tag = (testId: string) =>
      html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, 'u'))![0];
    expect(tag(`layer-lock-${top}`)).toContain('data-active="true"');
    expect(tag(`layer-lock-${top}`)).toContain('aria-pressed="true"');
    expect(tag(`layer-lock-${top}`)).toContain('aria-label="unlock"');
    expect(tag(`layer-lock-${side}`)).toContain('aria-label="lock"');
    expect(tag(`layer-lock-${side}`)).toContain('data-active="false"');
    expect(tag(`layer-visible-${side}`)).toContain('data-active="true"');
    expect(tag(`layer-visible-${top}`)).toContain('data-active="false"');
  });

  it('the lock and show entries run one setLayerState with their rules', () => {
    const target = editor();
    const { top, side } = stack(target);
    lock(target, [top]);
    ok(target, { type: 'setSelection', ids: [top, side] });
    const items = new Map(
      contextMenuItems({ snapshot: target.getSnapshot(), point: { x: 0, y: 0 } })
        .flat()
        .map((entry) => [entry.testId, entry]),
    );
    const lockItem = items.get('context-lock')!;
    expect(lockItem.label).toBe('Lock');
    const steps = depth(target);
    lockItem.run!((command) => target.execute(command));
    expect(node(target, side).locked).toBe(true);
    expect(depth(target)).toBe(steps + 1);
    const again = new Map(
      contextMenuItems({ snapshot: target.getSnapshot(), point: { x: 0, y: 0 } })
        .flat()
        .map((entry) => [entry.testId, entry]),
    );
    expect(again.get('context-lock')!.label).toBe('Unlock');
    expect(again.get('context-visibility')!.label).toBe('Hide');
  });
});
