import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Editor,
  type Modifiers,
  type PagePoint,
  type SelectionHandles,
} from '../../packages/editor-core/src/index.js';

// V-29 (Figma): a press anywhere along an edge of the handle box, on it or within 6 / zoom
// outside it and between its corners, resizes that edge as its middle handle does. A click
// there without movement keeps its old meaning; strictly inside the box nothing changes. The
// next-host hover shows the resize cursor wherever such a press resizes.

const appSource = path.resolve(import.meta.dirname, '../../apps/next-host/src');
type HandleCursor = Readonly<{ kind: 'resize' | 'rotate'; angle: number }>;
const { handleCursorAt } = (await import(path.join(appSource, 'm2-geometry.ts'))) as {
  handleCursorAt: (
    handles: SelectionHandles,
    point: PagePoint,
    zoom: number,
  ) => HandleCursor | null;
};

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

function ok(target: Editor, command: Parameters<Editor['execute']>[0]): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

/** A selected 200 x 100 rectangle at (100, 100), rotated by `rotation`, plus a second one. */
function setup(rotation = 0) {
  const target = createEditor({ ids: createCounterIdSource('n') });
  ok(target, { type: 'setSnapping', enabled: false });
  const [id] = ok(target, {
    type: 'createRectangle',
    frame: { x: 100, y: 100, width: 200, height: 100 },
    rotation,
  });
  const [other] = ok(target, {
    type: 'createRectangle',
    frame: { x: 140, y: 40, width: 40, height: 62 },
  });
  ok(target, { type: 'setSelection', ids: [id!] });
  return { target, id: id!, other: other!, handles: target.query({ type: 'handles' })! };
}

function send(target: Editor, kind: 'pointerdown' | 'pointermove' | 'pointerup', p: PagePoint) {
  return target.execute({ type: 'input', event: { kind, point: p, modifiers: none } });
}

function drag(target: Editor, from: PagePoint, to: PagePoint) {
  send(target, 'pointerdown', from);
  send(target, 'pointermove', to);
  send(target, 'pointerup', to);
}

/** A point on the box's edge at fraction `t` from `a` to `b`, pushed `out` page units outward. */
function along(handles: SelectionHandles, a: number, b: number, t: number, out: number) {
  const [p, q] = [handles.corners[a as 0], handles.corners[b as 0]];
  const centre = {
    x: (handles.corners[0].x + handles.corners[2].x) / 2,
    y: (handles.corners[0].y + handles.corners[2].y) / 2,
  };
  const point = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  // The outward normal of the edge: away from the centre, perpendicular to the edge.
  const ex = q.x - p.x;
  const ey = q.y - p.y;
  const length = Math.hypot(ex, ey);
  let nx = -ey / length;
  let ny = ex / length;
  if (nx * (point.x - centre.x) + ny * (point.y - centre.y) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: point.x + nx * out, y: point.y + ny * out };
}

describe('V-29 edge resize', () => {
  it('resizes one axis from anywhere along an edge, on it or just outside', () => {
    for (const out of [0, 4]) {
      const { target, id, handles } = setup();
      // The bottom edge, a quarter of the way along, dragged down 20.
      const from = along(handles, 3, 2, 0.25, out);
      drag(target, from, { x: from.x + 7, y: from.y + 20 });
      expect(target.query({ type: 'node', id })!.frame).toEqual({
        x: 100,
        y: 100,
        width: 200,
        height: 120,
      });
    }
    // The left edge, dragged left 10.
    const { target, id, handles } = setup();
    const from = along(handles, 0, 3, 0.8, 3);
    drag(target, from, { x: from.x - 10, y: from.y + 30 });
    expect(target.query({ type: 'node', id })!.frame).toEqual({
      x: 90,
      y: 100,
      width: 210,
      height: 100,
    });
  });

  it('resizes a rotated box along its own axes', () => {
    const { target, id, handles } = setup(0.4);
    // The right edge (corners 1 to 2), pushed out by 25 along its normal.
    const from = along(handles, 1, 2, 0.3, 2);
    const to = { x: from.x + 25 * Math.cos(0.4), y: from.y + 25 * Math.sin(0.4) };
    drag(target, from, to);
    const node = target.query({ type: 'node', id })!;
    expect(node.frame.width).toBeCloseTo(225, 9);
    expect(node.frame.height).toBeCloseTo(100, 9);
    expect(node.rotation).toBeCloseTo(0.4, 12);
  });

  it('leaves presses beyond the reach, strictly inside, or past a corner as they were', () => {
    // 7 outside the edge: empty canvas, a marquee that clears the selection.
    const far = setup();
    const outside = along(far.handles, 3, 2, 0.3, 7);
    drag(far.target, outside, { x: outside.x + 5, y: outside.y + 5 });
    expect(far.target.query({ type: 'node', id: far.id })!.frame.height).toBe(100);
    // 3 inside the edge, on the selected node: a move.
    const inside = setup();
    const point = along(inside.handles, 3, 2, 0.3, -3);
    drag(inside.target, point, { x: point.x, y: point.y + 10 });
    expect(inside.target.query({ type: 'node', id: inside.id })!.frame).toEqual({
      x: 100,
      y: 110,
      width: 200,
      height: 100,
    });
  });

  it('keeps a click on an edge: it selects the node there, or clears on empty canvas', () => {
    // The other rectangle reaches 2 over the top edge; a click on the edge selects it.
    const { target, other, handles } = setup();
    const onOther = along(handles, 0, 1, 0.25, 0);
    send(target, 'pointerdown', onOther);
    send(target, 'pointerup', onOther);
    expect(target.query({ type: 'selection' })).toEqual([other]);
    // On empty canvas just outside the bottom edge (past the node's hit tolerance), a click
    // clears the selection.
    const empty = setup();
    const point = along(empty.handles, 3, 2, 0.3, 5.5);
    send(empty.target, 'pointerdown', point);
    send(empty.target, 'pointerup', point);
    expect(empty.target.query({ type: 'selection' })).toEqual([]);
  });

  it('shows the resize cursor where the press resizes, at zoom 1 and 2', () => {
    for (const rotation of [0, 0.4]) {
      const { handles } = setup(rotation);
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ] as const) {
        expect(handleCursorAt(handles, along(handles, a, b, 0.3, 0.001), 1)?.kind).toBe('resize');
        expect(handleCursorAt(handles, along(handles, a, b, 0.3, 5.9), 1)?.kind).toBe('resize');
        expect(handleCursorAt(handles, along(handles, a, b, 0.3, 6.1), 1)).toBeNull();
        expect(handleCursorAt(handles, along(handles, a, b, 0.3, -2), 1)).toBeNull();
        expect(handleCursorAt(handles, along(handles, a, b, 0.3, 2.9), 2)?.kind).toBe('resize');
        expect(handleCursorAt(handles, along(handles, a, b, 0.3, 3.1), 2)).toBeNull();
      }
      // The arrow is perpendicular to the edge: the right edge points along the box's x axis.
      const right = handleCursorAt(handles, along(handles, 1, 2, 0.3, 2), 1)!;
      expect(right.angle).toBeCloseTo((rotation * 180) / Math.PI, 9);
    }
  });
});
