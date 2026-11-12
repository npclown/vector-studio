import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type PagePoint,
} from '@vector-studio/editor-core';
import type { Color, DocumentV7, Gradient, NodeV7, TextNodeV7 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { paintColorAt } from '../../packages/editor-core/src/eyedropper.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md): V39-A04 (E6 `sampleColor`)
// and V39-A05 (E7 the eyedropper tool).

const none = { shift: false, alt: false, meta: false, ctrl: false };
const red: Color = { r: 1, g: 0, b: 0, a: 1 };
const green: Color = { r: 0, g: 1, b: 0, a: 1 };
const blue: Color = { r: 0, g: 0, b: 1, a: 1 };

function editor(): Editor {
  const target = createEditor({ ids: createCounterIdSource('n') });
  ok(target, { type: 'setViewportSize', width: 800, height: 600 });
  return target;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

const sample = (target: Editor, point: PagePoint) => target.query({ type: 'sampleColor', point });
const node = (target: Editor, id: string) => target.query({ type: 'node', id }) as NodeV7;

function rect(target: Editor, x: number, y: number, fill: Color | Gradient | null = red): string {
  return ok(target, {
    type: 'createRectangle',
    frame: { x, y, width: 100, height: 100 },
    fill,
    stroke: null,
  })[0]!;
}

function linear(spread: Gradient['spread'], transform = [1, 0, 0, 1, 0, 0]): Gradient {
  return {
    kind: 'linear',
    transform: transform as unknown as Gradient['transform'],
    stops: [
      { offset: 0, color: red },
      { offset: 1, color: blue },
    ],
    spread,
  };
}

function close(actual: Color | null, expected: Color): void {
  expect(actual).not.toBeNull();
  for (const key of ['r', 'g', 'b', 'a'] as const) {
    expect(actual![key]).toBeCloseTo(expected[key], 9);
  }
}

/** A loaded document with one fixed text node `t` holding two runs. */
function withText(): Editor {
  const target = editor();
  const id = rect(target, 0, 0);
  const document = target.query({ type: 'document' });
  const base = document.nodes[id]!;
  const text: TextNodeV7 = {
    id: 't',
    name: 'Text',
    parent: base.parent,
    frame: { x: 200, y: 0, width: 100, height: 40 },
    rotation: 0,
    constraints: base.constraints,
    opacity: 1,
    visible: true,
    type: 'text',
    runs: [
      { text: 'ab', family: 'Inter', size: 16, color: green },
      { text: 'cd', family: 'Inter', size: 16, color: blue },
    ],
    sizing: 'fixed',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1.2,
    effects: [],
  };
  const page = document.pages[0]!;
  const next: DocumentV7 = {
    ...document,
    pages: [{ ...page, children: [...page.children, 't'] }],
    nodes: { ...document.nodes, t: text },
  };
  ok(target, { type: 'loadDocument', document: next });
  return target;
}

describe('V39-A04 sampleColor (E6)', () => {
  it('reads a solid fill, null on empty canvas, the topmost of overlapping nodes', () => {
    const target = editor();
    rect(target, 0, 0, red);
    const top = rect(target, 50, 50, green);
    expect(sample(target, { x: 10, y: 10 })).toEqual(red);
    expect(sample(target, { x: 75, y: 75 })).toEqual(green);
    expect(sample(target, { x: 500, y: 500 })).toBeNull();
    // Opacity is not applied (V39-Q5).
    ok(target, { type: 'setStyle', ids: [top], style: { opacity: 0.5 } });
    expect(sample(target, { x: 75, y: 75 })).toEqual(green);
  });

  it('evaluates linear gradients with each spread, interpolating premultiplied', () => {
    const target = editor();
    // The transform maps gradient space to the unit box, u = 0.5 t: t runs 0 to 2 over the box.
    const pad = rect(target, 0, 0, linear('pad', [0.5, 0, 0, 1, 0, 0]));
    const repeat = rect(target, 0, 200, linear('repeat', [0.5, 0, 0, 1, 0, 0]));
    const reflect = rect(target, 0, 400, linear('reflect', [0.5, 0, 0, 1, 0, 0]));
    close(sample(target, { x: 25, y: 50 }), { r: 0.5, g: 0, b: 0.5, a: 1 });
    close(sample(target, { x: 75, y: 50 }), blue);
    close(sample(target, { x: 75, y: 250 }), { r: 0.5, g: 0, b: 0.5, a: 1 });
    close(sample(target, { x: 62.5, y: 450 }), { r: 0.25, g: 0, b: 0.75, a: 1 });
    expect([pad, repeat, reflect]).toHaveLength(3);
    // Premultiplied: red to transparent green keeps a pure red hue with falling alpha.
    const fade: Gradient = {
      kind: 'linear',
      transform: [1, 0, 0, 1, 0, 0],
      stops: [
        { offset: 0, color: red },
        { offset: 1, color: { r: 0, g: 1, b: 0, a: 0 } },
      ],
      spread: 'pad',
    };
    close(paintColorAt(fade, { x: 0.5, y: 0 }), { r: 1, g: 0, b: 0, a: 0.5 });
    close(paintColorAt(fade, { x: 1, y: 0 }), { r: 0, g: 1, b: 0, a: 0 });
  });

  it('evaluates a radial gradient and hard stops (the later stop wins)', () => {
    const radial: Gradient = {
      kind: 'radial',
      transform: [0.5, 0, 0, 0.5, 0.5, 0.5],
      stops: [
        { offset: 0, color: red },
        { offset: 0.5, color: red },
        { offset: 0.5, color: green },
        { offset: 1, color: green },
      ],
      spread: 'pad',
    };
    expect(paintColorAt(radial, { x: 0.5, y: 0.5 })).toEqual(red);
    expect(paintColorAt(radial, { x: 0.5 + 0.25, y: 0.5 })).toEqual(green);
    expect(paintColorAt(radial, { x: 0.9, y: 0.5 })).toEqual(green);
  });

  it('a stroke wins over the fill within half its width', () => {
    const target = editor();
    const id = rect(target, 0, 0, red);
    ok(target, { type: 'setStyle', ids: [id], style: { stroke: { color: blue, width: 10 } } });
    expect(sample(target, { x: 2, y: 50 })).toEqual(blue);
    expect(sample(target, { x: -4, y: 50 })).toEqual(blue);
    expect(sample(target, { x: 6, y: 50 })).toEqual(red);
    expect(sample(target, { x: -6, y: 50 })).toBeNull();
  });

  it('reads text as its first run colour, and a frame background and border', () => {
    const target = withText();
    expect(sample(target, { x: 290, y: 30 })).toEqual(green);
    const frame = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 300, width: 100, height: 100 },
      fill: green,
    })[0]!;
    ok(target, { type: 'setStyle', ids: [frame], style: { stroke: { color: blue, width: 4 } } });
    expect(sample(target, { x: 50, y: 350 })).toEqual(green);
    expect(sample(target, { x: 1, y: 350 })).toEqual(blue);
  });

  it('reaches into an instance expansion', () => {
    const target = editor();
    const source = rect(target, 0, 0, red);
    const [symbol] = ok(target, { type: 'createSymbol', ids: [source] });
    const [instance] = ok(target, {
      type: 'createInstance',
      symbol: symbol!,
      frame: { x: 300, y: 0, width: 100, height: 100 },
    });
    expect(instance).toBeDefined();
    expect(sample(target, { x: 350, y: 50 })).toEqual(red);
    ok(target, { type: 'setStyle', ids: [source], style: { fill: green } });
    expect(sample(target, { x: 350, y: 50 })).toEqual(green);
  });
});

describe('V39-A05 the eyedropper tool (E7)', () => {
  const press = (target: Editor, point: PagePoint, shift = false) =>
    target.execute({
      type: 'input',
      event: { kind: 'pointerdown', point, modifiers: { ...none, shift } },
    });

  it('applies the fill in one undo step, keeps the selection and returns to select', () => {
    const target = editor();
    const a = rect(target, 0, 0, red);
    const b = rect(target, 200, 0, green);
    ok(target, { type: 'setSelection', ids: [a] });
    ok(target, { type: 'setTool', tool: 'eyedropper' });
    const depth = target.query({ type: 'history' }).undoDepth;
    ok(target, {
      type: 'input',
      event: { kind: 'pointermove', point: { x: 250, y: 50 }, modifiers: none },
    });
    expect(target.query({ type: 'overlay' })).toEqual({
      kind: 'eyedropper',
      point: { x: 250, y: 50 },
      color: green,
    });
    expect(press(target, { x: 250, y: 50 })).toMatchObject({ ok: true, consumed: true });
    expect(node(target, a)).toMatchObject({ fill: green });
    expect(node(target, b)).toMatchObject({ fill: green });
    expect(target.query({ type: 'history' }).undoDepth).toBe(depth + 1);
    expect(target.query({ type: 'selection' })).toEqual([a]);
    expect(target.query({ type: 'tool' })).toBe('select');
    expect(target.query({ type: 'pickedColor' })).toEqual(green);
    expect(target.getSnapshot().pickedColor).toEqual(green);
    ok(target, { type: 'undo' });
    expect(node(target, a)).toMatchObject({ fill: red });
  });

  it('Shift applies the stroke; lines take the stroke; text takes the run colour', () => {
    const target = withText();
    const a = Object.keys(target.query({ type: 'document' }).nodes).find((id) => id !== 't')!;
    const line = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 300 },
      end: { x: 100, y: 300 },
    })[0]!;
    const blueRect = rect(target, 400, 0, blue);
    ok(target, { type: 'setSelection', ids: [a, line, 't'] });
    ok(target, { type: 'setTool', tool: 'eyedropper' });
    press(target, { x: 450, y: 50 });
    expect(node(target, a)).toMatchObject({ fill: blue });
    expect((node(target, line) as { stroke: { color: Color } }).stroke.color).toEqual(blue);
    expect((node(target, 't') as TextNodeV7).runs).toEqual([
      { text: 'abcd', family: 'Inter', size: 16, color: blue },
    ]);
    ok(target, { type: 'setStyle', ids: [blueRect], style: { fill: green } });
    ok(target, { type: 'setTool', tool: 'eyedropper' });
    press(target, { x: 450, y: 50 }, true);
    const stroke = (node(target, a) as { stroke: { color: Color; width: number } }).stroke;
    expect(stroke.color).toEqual(green);
    expect(node(target, a)).toMatchObject({ fill: blue });
  });

  it('skips groups; a press on nothing does nothing; Escape returns to select', () => {
    const target = editor();
    const a = rect(target, 0, 0, red);
    const b = rect(target, 200, 0, green);
    const [group] = ok(target, { type: 'groupNodes', ids: [a, b], kind: 'group' });
    ok(target, { type: 'setSelection', ids: [group!] });
    ok(target, { type: 'setTool', tool: 'eyedropper' });
    const depth = target.query({ type: 'history' }).undoDepth;
    expect(press(target, { x: 600, y: 500 })).toMatchObject({ ok: true, consumed: true });
    expect(target.query({ type: 'tool' })).toBe('eyedropper');
    expect(target.query({ type: 'pickedColor' })).toBeNull();
    press(target, { x: 250, y: 50 });
    expect(target.query({ type: 'history' }).undoDepth).toBe(depth);
    expect(node(target, a)).toMatchObject({ fill: red });
    expect(target.query({ type: 'pickedColor' })).toEqual(green);
    ok(target, { type: 'setTool', tool: 'eyedropper' });
    ok(target, {
      type: 'input',
      event: { kind: 'keydown', key: 'Escape', modifiers: none },
    });
    expect(target.query({ type: 'tool' })).toBe('select');
  });

  it('with nothing selected only records the pick', () => {
    const target = editor();
    rect(target, 0, 0, red);
    ok(target, { type: 'setTool', tool: 'eyedropper' });
    const depth = target.query({ type: 'history' }).undoDepth;
    press(target, { x: 50, y: 50 });
    expect(target.query({ type: 'pickedColor' })).toEqual(red);
    expect(target.query({ type: 'history' }).undoDepth).toBe(depth);
  });
});

describe('V39-A07 (U1) the toolbar notice text', () => {
  it('writes #RRGGBB in upper case, rounding and clamping channels', async () => {
    const { pickedHex } = await import('../../packages/ui/src/editor-toolbar.js');
    expect(pickedHex({ r: 1, g: 0.5, b: 0 })).toBe('#FF8000');
    expect(pickedHex({ r: 2, g: -1, b: 0.0019 })).toBe('#FF0000');
  });
});
