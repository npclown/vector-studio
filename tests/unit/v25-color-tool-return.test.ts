import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type PagePoint,
} from '@vector-studio/editor-core';
import { EditorProvider, PropertyPanel } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PANEL_SWATCHES, solidFromHex } from '../../packages/ui/src/appearance-model.js';

// V-25 slice 3 (colour picking, return to Select): with `returnToSelect` the drawing tools hand
// over to `select` after each shape in one undo step, without it they stay active as at M2; the
// swatches and the colour picker in the property panel, and the solid paint they write.

const none = { shift: false, alt: false, meta: false, ctrl: false };

function editor(returnToSelect?: boolean): Editor {
  const target = createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
    ...(returnToSelect === undefined ? {} : { returnToSelect }),
  });
  ok(target, { type: 'setViewportSize', width: 800, height: 600 });
  ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids;
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
) {
  ok(target, { type: 'input', event: { kind, point, modifiers: none } });
}

function drag(target: Editor, from: PagePoint, to: PagePoint): void {
  pointer(target, 'pointerdown', from);
  pointer(target, 'pointermove', to);
  pointer(target, 'pointerup', to);
}

function click(target: Editor, point: PagePoint): void {
  pointer(target, 'pointerdown', point);
  pointer(target, 'pointerup', point);
}

const created = (target: Editor) => Object.keys(target.getSnapshot().document.nodes);

describe('V-25 return to Select after a shape', () => {
  for (const tool of ['rectangle', 'ellipse', 'frame', 'line'] as const) {
    it(`${tool}: a drag creates the shape, selects it and sets the tool to select`, () => {
      const target = editor(true);
      ok(target, { type: 'setTool', tool });
      drag(target, { x: 10, y: 10 }, { x: 110, y: 60 });
      const snapshot = target.getSnapshot();
      expect(created(target)).toHaveLength(1);
      expect(snapshot.selection).toEqual(created(target));
      expect(snapshot.tool).toBe('select');
      expect(snapshot.history.undoDepth).toBe(1);
      ok(target, { type: 'undo' });
      expect(created(target)).toEqual([]);
    });
  }

  it('path: finishing with Enter selects the path and sets the tool to select', () => {
    const target = editor(true);
    ok(target, { type: 'setTool', tool: 'path' });
    click(target, { x: 10, y: 10 });
    click(target, { x: 100, y: 10 });
    expect(target.getSnapshot().tool).toBe('path');
    ok(target, { type: 'input', event: { kind: 'keydown', key: 'Enter', modifiers: none } });
    const snapshot = target.getSnapshot();
    expect(created(target)).toHaveLength(1);
    expect(snapshot.selection).toEqual(created(target));
    expect(snapshot.tool).toBe('select');
    expect(snapshot.history.undoDepth).toBe(1);
  });

  it('path: a press on the first anchor closes it, then the release and undo act on Select', () => {
    const target = editor(true);
    ok(target, { type: 'setTool', tool: 'path' });
    click(target, { x: 10, y: 10 });
    click(target, { x: 100, y: 10 });
    click(target, { x: 100, y: 100 });
    click(target, { x: 10, y: 10 });
    const snapshot = target.getSnapshot();
    expect(created(target)).toHaveLength(1);
    expect(snapshot.selection).toEqual(created(target));
    expect(snapshot.tool).toBe('select');
    expect(snapshot.history.undoDepth).toBe(1);
    ok(target, { type: 'undo' });
    expect(created(target)).toEqual([]);
    expect(target.getSnapshot().tool).toBe('select');
  });

  it('a click without movement creates nothing and keeps the tool', () => {
    const target = editor(true);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    click(target, { x: 10, y: 10 });
    expect(created(target)).toEqual([]);
    expect(target.getSnapshot().tool).toBe('rectangle');
  });

  it('Escape during a drag cancels it and keeps the tool', () => {
    const target = editor(true);
    ok(target, { type: 'setTool', tool: 'ellipse' });
    pointer(target, 'pointerdown', { x: 10, y: 10 });
    pointer(target, 'pointermove', { x: 50, y: 50 });
    ok(target, { type: 'input', event: { kind: 'keydown', key: 'Escape', modifiers: none } });
    expect(created(target)).toEqual([]);
    expect(target.getSnapshot().tool).toBe('ellipse');
  });

  for (const option of [undefined, false] as const) {
    it(`returnToSelect ${String(option)}: the tool stays active (M2 behaviour)`, () => {
      const target = editor(option);
      ok(target, { type: 'setTool', tool: 'rectangle' });
      drag(target, { x: 10, y: 10 }, { x: 110, y: 60 });
      drag(target, { x: 200, y: 10 }, { x: 300, y: 60 });
      const snapshot = target.getSnapshot();
      expect(created(target)).toHaveLength(2);
      expect(snapshot.tool).toBe('rectangle');
      expect(snapshot.selection).toEqual([created(target)[1]]);
    });
  }
});

describe('V-25 colour picking', () => {
  it('writes a swatch with the alpha of the first solid paint, opaque from none', () => {
    const half = { r: 1, g: 0, b: 0, a: 0.5 };
    expect(solidFromHex('#0d99ff', [null, half])).toEqual({
      r: 13 / 255,
      g: 153 / 255,
      b: 1,
      a: 0.5,
    });
    expect(solidFromHex('#000000', [null])).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(solidFromHex('blue', [null])).toBeNull();
    expect(PANEL_SWATCHES.every((hex) => /^#[0-9a-f]{6}$/u.test(hex))).toBe(true);
    expect(new Set(PANEL_SWATCHES).size).toBe(PANEL_SWATCHES.length);
  });

  function panel(fill: (Command & { type: 'setStyle' }) | null): string {
    const target = editor();
    const [id] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    if (fill !== null) ok(target, { ...fill, ids: [id!] });
    ok(target, { type: 'setSelection', ids: [id!] });
    return renderToString(
      createElement(EditorProvider, { editor: target }, createElement(PropertyPanel)),
    );
  }

  it('shows the picker and the swatches for a solid fill, the current one pressed', () => {
    const html = panel({
      type: 'setStyle',
      ids: [],
      style: { fill: { r: 13 / 255, g: 153 / 255, b: 1, a: 1 } },
    });
    expect(html).toContain('aria-label="Fill colour picker"');
    expect(html).toMatch(/type="color"[^>]*value="#0d99ff"/u);
    expect(html).toContain('aria-label="Fill swatches"');
    expect(html).toMatch(/aria-label="Fill swatch #0d99ff" aria-pressed="true"/u);
    expect(html).toMatch(/aria-label="Fill swatch #000000" aria-pressed="false"/u);
  });

  it('shows the swatches without a picker for no fill, and neither for a gradient', () => {
    const empty = panel({ type: 'setStyle', ids: [], style: { fill: null } });
    expect(empty).toContain('aria-label="Fill swatches"');
    expect(empty).not.toContain('Fill colour picker');
    const gradient = panel({
      type: 'setStyle',
      ids: [],
      style: {
        fill: {
          kind: 'linear',
          transform: [1, 0, 0, 1, 0, 0],
          stops: [
            { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
            { offset: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
          ],
          spread: 'pad',
        },
      },
    });
    expect(gradient).not.toContain('Fill swatches');
    expect(gradient).not.toContain('Fill colour picker');
  });

  it('shows Mixed, with no swatches, when the selected fills differ and one is a gradient', () => {
    const target = editor();
    const frame = { x: 0, y: 0, width: 10, height: 10 };
    const [a] = ok(target, { type: 'createRectangle', frame });
    const [b] = ok(target, { type: 'createRectangle', frame });
    ok(target, {
      type: 'setStyle',
      ids: [b!],
      style: {
        fill: {
          kind: 'radial',
          transform: [1, 0, 0, 1, 0, 0],
          stops: [
            { offset: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
            { offset: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
          ],
          spread: 'pad',
        },
      },
    });
    ok(target, { type: 'setSelection', ids: [a!, b!] });
    const html = renderToString(
      createElement(EditorProvider, { editor: target }, createElement(PropertyPanel)),
    );
    // V35-C2: fills that differ show "Mixed" (with `+` to replace them), not a paint editor.
    expect(html).toContain('data-testid="fill-mixed"');
    expect(html).not.toContain('Fill swatches');
  });
});
