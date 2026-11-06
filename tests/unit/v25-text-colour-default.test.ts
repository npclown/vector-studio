import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type TextStyle,
} from '@vector-studio/editor-core';
import { describe, expect, it } from 'vitest';
import {
  CANVAS_BACKDROP,
  backdropColor,
  canvasTextStyle,
  caretColour,
  luminance,
  readableTextStyle,
} from '../../apps/next-host/src/v25-text-colour-default.js';

// V-25 slice 7 (readable default text colour): a text tool press in the studio switches the
// tool between black and white from what lies under it, so new text reads against it.

const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };
const style: TextStyle = { family: 'Arial', size: 16, color: black };

function editor(): Editor {
  return createEditor({
    document: {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p1', name: 'Page 1', children: [] }],
      nodes: {},
    },
    ids: createCounterIdSource('n'),
  });
}

function ok(target: Editor, command: Command): string {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code}`);
  return result.ids[0]!;
}

const at = (target: Editor, x: number, y: number) =>
  backdropColor(target.getSnapshot().document, 'p1', { x, y });

describe('V-25 readable default text colour', () => {
  it('reads the empty canvas as the renderer clear colour (black)', () => {
    expect(at(editor(), 10, 10)).toEqual(CANVAS_BACKDROP);
    expect(readableTextStyle(editor().getSnapshot().document, 'p1', { x: 0, y: 0 }, style)).toEqual(
      { ...style, color: white },
    );
  });

  it('reads a white artboard, and a frame child in front of it', () => {
    const target = editor();
    const frame = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 200, height: 100 },
      fill: white,
    });
    ok(target, {
      type: 'createRectangle',
      frame: { x: 10, y: 10, width: 50, height: 50 },
      fill: { r: 0.1, g: 0.1, b: 0.3, a: 1 },
      parent: frame,
    });
    expect(at(target, 100, 80)).toEqual(white);
    expect(at(target, 20, 20)).toEqual({ r: 0.1, g: 0.1, b: 0.3, a: 1 });
    expect(at(target, 300, 80)).toEqual(CANVAS_BACKDROP);
    const document = target.getSnapshot().document;
    const onWhite = readableTextStyle(
      document,
      'p1',
      { x: 100, y: 80 },
      { ...style, color: white },
    );
    expect(onWhite?.color).toEqual(black);
    expect(readableTextStyle(document, 'p1', { x: 100, y: 80 }, style)).toBeNull();
    expect(readableTextStyle(document, 'p1', { x: 20, y: 20 }, style)?.color).toEqual(white);
  });

  it('skips hidden, unfilled and mostly transparent nodes, and tests ellipses by shape', () => {
    const target = editor();
    const ellipse = ok(target, {
      type: 'createEllipse',
      frame: { x: 0, y: 0, width: 100, height: 100 },
      fill: white,
    });
    expect(at(target, 50, 50)).toEqual(white);
    expect(at(target, 3, 3)).toEqual(CANVAS_BACKDROP);
    ok(target, { type: 'setNodeProps', id: ellipse, props: { fill: { ...white, a: 0.3 } } });
    expect(at(target, 50, 50)).toEqual(CANVAS_BACKDROP);
    ok(target, { type: 'setNodeProps', id: ellipse, props: { fill: white, visible: false } });
    expect(at(target, 50, 50)).toEqual(CANVAS_BACKDROP);
  });

  it("counts a group's or frame's opacity into its children's fills", () => {
    const target = editor();
    const frame = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 100, height: 100 },
    });
    ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 100, height: 100 },
      fill: white,
      parent: frame,
    });
    expect(at(target, 50, 50)).toEqual(white);
    ok(target, { type: 'setNodeProps', id: frame, props: { opacity: 0.1 } });
    expect(at(target, 50, 50)).toEqual(CANVAS_BACKDROP);
  });

  it('starts the studio text tool white and picks the caret colour', () => {
    expect(canvasTextStyle(style)?.color).toEqual(white);
    expect(canvasTextStyle({ ...style, color: white })).toBeNull();
    expect(canvasTextStyle({ ...style, color: { r: 1, g: 0, b: 0, a: 1 } })).toBeNull();
    const target = editor();
    ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 100, height: 100 },
      fill: white,
    });
    const document = target.getSnapshot().document;
    expect(caretColour(document, 'p1', { x: 50, y: 50 })).toBe('#000000');
    expect(caretColour(document, 'p1', { x: 150, y: 50 })).toBe('#ffffff');
  });

  it('keeps a colour the user chose', () => {
    const red = { ...style, color: { r: 1, g: 0, b: 0, a: 1 } };
    expect(
      readableTextStyle(editor().getSnapshot().document, 'p1', { x: 0, y: 0 }, red),
    ).toBeNull();
  });

  it('measures luminance', () => {
    expect(luminance(black)).toBe(0);
    expect(luminance(white)).toBeCloseTo(1);
  });
});
