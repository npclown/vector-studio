import { describe, expect, it } from 'vitest';
import { pathUnitBounds } from '../../packages/editor-core/src/content-box.js';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type PagePoint,
} from '../../packages/editor-core/src/index.js';

// V-26: a path's selection box is the box of its drawn curve, not of its Bézier handles.

const none = { shift: false, alt: false, meta: false, ctrl: false };

function editor(): Editor {
  const target = createEditor({ ids: createCounterIdSource('n') });
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
  x: number,
  y: number,
) {
  ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
}

function drag(target: Editor, from: readonly [number, number], to: readonly [number, number]) {
  pointer(target, 'pointerdown', from[0], from[1]);
  pointer(target, 'pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  pointer(target, 'pointermove', to[0], to[1]);
  pointer(target, 'pointerup', to[0], to[1]);
}

function corners(target: Editor): readonly PagePoint[] {
  return target.query({ type: 'handles' })!.corners;
}

function close(actual: readonly PagePoint[], expected: readonly (readonly [number, number])[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, index) => {
    expect(point.x).toBeCloseTo(expected[index]![0], 9);
    expect(point.y).toBeCloseTo(expected[index]![1], 9);
  });
}

/** An arch from (0, 0) to (100, 0) whose handles reach y = 100; the curve peaks at y = 75. */
function arch(target: Editor, dx = 0, dy = 0): string {
  return ok(target, {
    type: 'createPath',
    verbs: ['move', 'cubic'],
    points: [dx, dy, dx, dy + 100, dx + 100, dy + 100, dx + 100, dy],
  })[0]!;
}

describe('V-26 path content box', () => {
  it('finds the extrema of each cubic in the unit box', () => {
    expect(
      pathUnitBounds({
        verbs: ['move', 'cubic'],
        points: [0, 0, 0, 1, 1, 1, 1, 0],
        fillRule: 'nonzero',
      }),
    ).toEqual([0, 0, 1, 0.75]);
    // Handles inside the end points' range: the frame itself.
    expect(
      pathUnitBounds({
        verbs: ['move', 'cubic', 'line', 'close'],
        points: [0, 0, 0.2, 0.3, 0.8, 0.6, 1, 1, 0, 1],
        fillRule: 'nonzero',
      }),
    ).toEqual([0, 0, 1, 1]);
    // An S curve bulges both ways in x past its end points, short of its handles.
    const s = pathUnitBounds({
      verbs: ['move', 'cubic'],
      points: [0.5, 0, 1, 0.33, 0, 0.67, 0.5, 1],
      fillRule: 'nonzero',
    })!;
    expect(s[0]).toBeGreaterThan(0);
    expect(s[2]).toBeLessThan(1);
    expect(s[0] + s[2]).toBeCloseTo(1, 12);
    expect(s[1]).toBe(0);
    expect(s[3]).toBe(1);
  });

  it('puts the handles on the curve, not on its control points', () => {
    const target = editor();
    const id = arch(target, 10, 20);
    ok(target, { type: 'setSelection', ids: [id] });
    // The frame still holds the handles (the model is unchanged).
    expect(target.query({ type: 'node', id })!.frame).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 100,
    });
    close(corners(target), [
      [10, 20],
      [110, 20],
      [110, 95],
      [10, 95],
    ]);
  });

  it('keeps a straight-sided path box equal to its frame', () => {
    const target = editor();
    const [id] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 40, 0, 40, 30],
    });
    ok(target, { type: 'setSelection', ids: [id!] });
    expect(corners(target)).toEqual([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 0, y: 30 },
    ]);
  });

  it('resizes from the curve box: the opposite curve edge stays put', () => {
    const target = editor();
    const id = arch(target);
    ok(target, { type: 'setSelection', ids: [id] });
    drag(target, [100, 75], [200, 150]);
    close(corners(target), [
      [0, 0],
      [200, 0],
      [200, 150],
      [0, 150],
    ]);
    expect(target.query({ type: 'node', id })!.frame).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    });
  });

  it('resizes a rotated path about the opposite corner of its curve box', () => {
    const target = editor();
    const id = arch(target);
    ok(target, { type: 'setSelection', ids: [id] });
    ok(target, { type: 'rotateNodes', ids: [id], angle: Math.PI / 2 });
    const before = corners(target);
    // A turned box: sides 100 and 75.
    expect(Math.hypot(before[1]!.x - before[0]!.x, before[1]!.y - before[0]!.y)).toBeCloseTo(100);
    expect(Math.hypot(before[3]!.x - before[0]!.x, before[3]!.y - before[0]!.y)).toBeCloseTo(75);
    const anchor = before[0]!;
    const handle = before[2]!;
    // Drag the bottom-right handle so the box doubles in its own axes.
    drag(
      target,
      [handle.x, handle.y],
      [anchor.x + 2 * (handle.x - anchor.x), anchor.y + 2 * (handle.y - anchor.y)],
    );
    const after = corners(target);
    expect(after[0]!.x).toBeCloseTo(anchor.x, 9);
    expect(after[0]!.y).toBeCloseTo(anchor.y, 9);
    expect(Math.hypot(after[1]!.x - after[0]!.x, after[1]!.y - after[0]!.y)).toBeCloseTo(200);
    expect(Math.hypot(after[3]!.x - after[0]!.x, after[3]!.y - after[0]!.y)).toBeCloseTo(150);
  });

  it('selects by marquee on the curve box, not on the handles', () => {
    const target = editor();
    const id = arch(target);
    // Between the curve's peak (75) and its handles (100): nothing.
    drag(target, [40, 120], [60, 85]);
    expect(target.query({ type: 'selection' })).toEqual([]);
    drag(target, [40, 120], [60, 70]);
    expect(target.query({ type: 'selection' })).toEqual([id]);
  });

  it('moves the box with the path', () => {
    const target = editor();
    const id = arch(target);
    ok(target, { type: 'setStyle', ids: [id], style: { fill: { r: 1, g: 0, b: 0, a: 1 } } });
    ok(target, { type: 'setSelection', ids: [id] });
    drag(target, [50, 40], [60, 50]);
    close(corners(target), [
      [10, 10],
      [110, 10],
      [110, 85],
      [10, 85],
    ]);
  });
});

describe('V-26 arrange on the curve box', () => {
  it('aligns a path by its curve box', () => {
    const target = editor();
    const id = arch(target);
    const [r] = ok(target, {
      type: 'createRectangle',
      frame: { x: 200, y: 0, width: 50, height: 300 },
      fill: { r: 1, g: 0, b: 0, a: 1 },
      stroke: null,
    });
    ok(target, { type: 'alignNodes', ids: [id, r!], edge: 'bottom' });
    ok(target, { type: 'setSelection', ids: [id] });
    expect(corners(target)[2]!.y).toBeCloseTo(300, 9);
  });

  it('distributes paths by their curve boxes', () => {
    const target = editor();
    const s = (dx: number) =>
      ok(target, {
        type: 'createPath',
        verbs: ['move', 'cubic'],
        points: [dx + 50, 0, dx + 100, 33, dx, 67, dx + 50, 100],
      })[0]!;
    const ids = [s(0), s(100), s(400)];
    ok(target, { type: 'distributeNodes', ids, axis: 'horizontal' });
    const box = (id: string) => {
      ok(target, { type: 'setSelection', ids: [id] });
      const c = corners(target);
      return [c[0]!.x, c[1]!.x] as const;
    };
    const [a, b, c] = ids.map(box) as [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
    ];
    expect(b[0] - a[1]).toBeCloseTo(c[0] - b[1], 9);
  });
});

describe('V-26 group box from its children curve boxes', () => {
  function groupOf(target: Editor, ids: string[]): string {
    return ok(target, { type: 'groupNodes', ids, kind: 'group' })[0]!;
  }

  it('fits a group of curves to the curves, not their handles', () => {
    const target = editor();
    const a = arch(target);
    const b = arch(target, 50, 40);
    const g = groupOf(target, [a, b]);
    // The group's frame still spans the handles (0..150 x 0..140).
    expect(target.query({ type: 'node', id: g })!.frame).toEqual({
      x: 0,
      y: 0,
      width: 150,
      height: 140,
    });
    ok(target, { type: 'setSelection', ids: [g] });
    close(corners(target), [
      [0, 0],
      [150, 0],
      [150, 115],
      [0, 115],
    ]);
  });

  it('fits nested groups and resizes about the opposite curve edge', () => {
    const target = editor();
    const inner = groupOf(target, [arch(target), arch(target, 50, 40)]);
    const [r] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: -20, width: 10, height: 10 },
      fill: { r: 1, g: 0, b: 0, a: 1 },
      stroke: null,
    });
    const outer = groupOf(target, [inner, r!]);
    ok(target, { type: 'setSelection', ids: [outer] });
    close(corners(target), [
      [0, -20],
      [150, -20],
      [150, 115],
      [0, 115],
    ]);
    drag(target, [150, 115], [300, 250]);
    close(corners(target), [
      [0, -20],
      [300, -20],
      [300, 250],
      [0, 250],
    ]);
  });

  it('fits a group of a rectangle and a curve', () => {
    const target = editor();
    const [r] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      fill: { r: 1, g: 0, b: 0, a: 1 },
      stroke: null,
    });
    const g = groupOf(target, [r!, arch(target, 20, 0)]);
    ok(target, { type: 'setSelection', ids: [g] });
    // The arch's handles reach y = 100 but the curve only 75.
    close(corners(target), [
      [0, 0],
      [120, 0],
      [120, 75],
      [0, 75],
    ]);
  });
});

describe('V-26 group box exactness', () => {
  it('aligns a group whose curve box equals its frame exactly', () => {
    const target = editor();
    const red = { r: 1, g: 0, b: 0, a: 1 };
    const [big] = ok(target, {
      type: 'createRectangle',
      frame: { x: 3.3, y: 0.1, width: 100.3, height: 80.7 },
      fill: red,
      stroke: null,
    });
    const a = ok(target, {
      type: 'createPath',
      verbs: ['move', 'cubic'],
      points: [10, 10, 10, 30, 30, 30, 30, 10],
    })[0]!;
    const g = ok(target, { type: 'groupNodes', ids: [big!, a], kind: 'group' })[0]!;
    const [r] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0.1, y: 0, width: 5, height: 5 },
      fill: red,
      stroke: null,
    });
    ok(target, { type: 'alignNodes', ids: [g, r!], edge: 'left' });
    expect(target.query({ type: 'node', id: g })!.frame.x).toBe(0.1);
  });

  it('keeps the opposite corner of a rotated group box in place on resize', () => {
    const target = editor();
    const g = ok(target, {
      type: 'groupNodes',
      ids: [arch(target), arch(target, 50, 40)],
      kind: 'group',
    })[0]!;
    ok(target, { type: 'rotateNodes', ids: [g], angle: 0.4 });
    ok(target, { type: 'setSelection', ids: [g] });
    const before = corners(target);
    const anchor = before[0]!;
    const handle = before[2]!;
    drag(
      target,
      [handle.x, handle.y],
      [anchor.x + 1.5 * (handle.x - anchor.x), anchor.y + 1.5 * (handle.y - anchor.y)],
    );
    const after = corners(target);
    expect(after[0]!.x).toBeCloseTo(anchor.x, 9);
    expect(after[0]!.y).toBeCloseTo(anchor.y, 9);
    expect(after[2]!.x).toBeCloseTo(anchor.x + 1.5 * (handle.x - anchor.x), 6);
    expect(after[2]!.y).toBeCloseTo(anchor.y + 1.5 * (handle.y - anchor.y), 6);
  });
});
