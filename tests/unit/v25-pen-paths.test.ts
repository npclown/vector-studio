import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorOptions,
  type Modifiers,
  type PagePoint,
  type PathAnchor,
} from '@vector-studio/editor-core';
import { SelectionOverlay } from '../../apps/next-host/src/overlay.js';
import { penPreview } from '../../apps/next-host/src/v25-pen-preview.js';
import { readableStrokeColor } from '../../apps/next-host/src/v25-text-colour-default.js';

// V-25 slice 8 (pen paths and curves): a new line or path takes its stroke colour from the host
// (white on the black canvas, black on a light artboard), the pen previews its pending path as
// the curves it makes with the next segment to the pointer, and Alt-drag breaks the handles.

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const alt: Modifiers = { ...none, alt: true };
const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };

function editor(options: EditorOptions = {}): Editor {
  return createEditor({ ids: createCounterIdSource('n'), ...options });
}

function ok(target: Editor, command: Command): string {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids[0]!;
}

function press(target: Editor, point: PagePoint, drag?: PagePoint, modifiers = none) {
  target.execute({ type: 'input', event: { kind: 'pointerdown', point, modifiers } });
  if (drag !== undefined) {
    target.execute({ type: 'input', event: { kind: 'pointermove', point: drag, modifiers } });
  }
  target.execute({ type: 'input', event: { kind: 'pointerup', point: drag ?? point, modifiers } });
}

function enter(target: Editor) {
  target.execute({
    type: 'input',
    event: { kind: 'keydown', key: 'Enter', repeat: false, composing: false, modifiers: none },
  });
}

/** The single node of the page that is not a frame. */
function drawn(target: Editor) {
  const document = target.getSnapshot().document;
  return Object.values(document.nodes).find(
    (node) => node.type === 'path' || node.type === 'line',
  )!;
}

describe('V-25 pen stroke colour', () => {
  it('strokes a path in the host colour for its first anchor', () => {
    const target = editor({ drawStrokeColor: readableStrokeColor });
    ok(target, { type: 'setTool', tool: 'path' });
    press(target, { x: 10, y: 10 });
    press(target, { x: 60, y: 40 });
    enter(target);
    const node = drawn(target);
    expect(node.type).toBe('path');
    expect('stroke' in node && node.stroke?.color).toEqual(white);
    expect('stroke' in node && node.stroke?.width).toBe(1);
  });

  it('strokes black on a white artboard, and a line too', () => {
    const target = editor({ drawStrokeColor: readableStrokeColor });
    ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 200, height: 200 },
      fill: white,
    });
    ok(target, { type: 'setTool', tool: 'line' });
    press(target, { x: 10, y: 10 }, { x: 50, y: 50 });
    const node = drawn(target);
    expect(node.type).toBe('line');
    expect('stroke' in node && node.stroke?.color).toEqual(black);
  });

  it('keeps the black default without a host colour, or when the host fails', () => {
    for (const options of [
      {},
      { drawStrokeColor: () => null },
      { drawStrokeColor: () => ({ r: 2, g: 0, b: 0, a: 1 }) },
      {
        drawStrokeColor: () => {
          throw new Error('host');
        },
      },
    ] satisfies EditorOptions[]) {
      const target = editor(options);
      ok(target, { type: 'setTool', tool: 'path' });
      press(target, { x: 10, y: 10 });
      press(target, { x: 60, y: 40 });
      enter(target);
      const node = drawn(target);
      expect('stroke' in node && node.stroke?.color).toEqual(black);
    }
  });
});

describe('V-25 pen curves', () => {
  it('makes symmetric handles on a drag and breaks them with Alt', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'path' });
    press(target, { x: 0, y: 0 });
    press(target, { x: 100, y: 0 }, { x: 120, y: 20 });
    let overlay = target.getSnapshot().overlay;
    expect(overlay?.kind === 'path' && overlay.anchors[1]).toEqual({
      point: { x: 100, y: 0 },
      in: { x: 80, y: -20 },
      out: { x: 120, y: 20 },
    });
    target.execute({
      type: 'input',
      event: { kind: 'pointerdown', point: { x: 200, y: 0 }, modifiers: none },
    });
    target.execute({
      type: 'input',
      event: { kind: 'pointermove', point: { x: 220, y: 20 }, modifiers: none },
    });
    target.execute({
      type: 'input',
      event: { kind: 'pointermove', point: { x: 200, y: 40 }, modifiers: alt },
    });
    target.execute({
      type: 'input',
      event: { kind: 'pointerup', point: { x: 200, y: 40 }, modifiers: alt },
    });
    overlay = target.getSnapshot().overlay;
    // The in handle stays where the plain drag left it; only the out handle follows.
    expect(overlay?.kind === 'path' && overlay.anchors[2]).toEqual({
      point: { x: 200, y: 0 },
      in: { x: 180, y: -20 },
      out: { x: 200, y: 40 },
    });
    enter(target);
    const node = drawn(target);
    expect(node.type === 'path' && node.path.verbs).toEqual(['move', 'cubic', 'cubic']);
  });
});

describe('V-25 pen preview', () => {
  const id = (x: number, y: number): [number, number] => [x, y];
  const anchor = (x: number, y: number, out: PagePoint | null = null): PathAnchor => ({
    point: { x, y },
    in: out === null ? null : { x: 2 * x - out.x, y: 2 * y - out.y },
    out,
  });

  it('draws lines and curves as the tool creates them', () => {
    const preview = penPreview(
      [anchor(0, 0), anchor(10, 0), anchor(20, 0, { x: 25, y: 5 })],
      null,
      id,
    )!;
    expect(preview.path).toBe('M 0 0 L 10 0 C 10 0 15 -5 20 0');
    expect(preview.next).toBeNull();
    expect(preview.handles).toEqual([
      { from: [20, 0], to: [15, -5] },
      { from: [20, 0], to: [25, 5] },
    ]);
    expect(preview.anchors).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
  });

  it('runs the next segment to the pointer, curving out of a handle', () => {
    expect(penPreview([anchor(0, 0)], { x: 30, y: 40 }, id)!.next).toBe('M 0 0 L 30 40');
    const curved = penPreview([anchor(0, 0, { x: 10, y: 0 })], { x: 30, y: 40 }, id)!;
    expect(curved.next).toBe('M 0 0 C 10 0 30 40 30 40');
  });

  it('shows the close over the first anchor of two or more', () => {
    const anchors = [anchor(0, 0), anchor(50, 0)];
    const closing = penPreview(anchors, { x: 2, y: 2 }, id)!;
    expect(closing.closing).toBe(true);
    expect(closing.next).toBe('M 50 0 L 0 0');
    expect(penPreview(anchors, { x: 5, y: 5 }, id)!.closing).toBe(false);
    expect(penPreview([anchor(0, 0)], { x: 0, y: 0 }, id)!.closing).toBe(false);
    expect(penPreview([], null, id)).toBeNull();
  });

  it('is drawn by the overlay at the camera', () => {
    const target = editor();
    ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 2 } });
    ok(target, { type: 'setTool', tool: 'path' });
    press(target, { x: 10, y: 10 });
    press(target, { x: 20, y: 10 }, { x: 25, y: 15 });
    const snapshot = target.getSnapshot();
    const props = { snapshot, handles: null, width: 600, height: 400 };
    const html = renderToString(
      createElement(SelectionOverlay, { ...props, penCursor: { x: 40, y: 30 } }),
    );
    expect(html).toContain('d="M 20 20 C 20 20 30 10 40 20"');
    expect(html).toContain('data-testid="pen-next" d="M 40 20 C 50 30 80 60 80 60"');
    expect(html.match(/data-testid="pen-handle"/g)).toHaveLength(2);
    const plain = renderToString(createElement(SelectionOverlay, props));
    expect(plain).not.toContain('pen-next');
  });
});
