import type { Gradient, NodeV6 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';

// Resize past zero (Figma-style flip): dragging any resize handle past the opposite side flips
// the box over the anchor instead of stopping at size 0. Content mirrors where the model can
// express it (path and line points, corner radii, gradients, container children).

const red = { r: 1, g: 0, b: 0, a: 1 };
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

/** A press at `from`, moves through each of `via` and a release at the last point. */
function drag(target: Editor, from: readonly [number, number], ...via: [number, number][]) {
  pointer(target, 'pointerdown', from[0], from[1]);
  for (const [x, y] of via) pointer(target, 'pointermove', x, y);
  const last = via[via.length - 1]!;
  pointer(target, 'pointerup', last[0], last[1]);
}

function node(target: Editor, id: string): NodeV6 {
  return target.query({ type: 'node', id })!;
}

function rect(target: Editor, x: number, y: number, w: number, h: number): string {
  return ok(target, {
    type: 'createRectangle',
    frame: { x, y, width: w, height: h },
    fill: red,
    stroke: null,
  })[0]!;
}

const gradient: Gradient = {
  kind: 'linear',
  transform: [1, 0, 0, 1, 0, 0],
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
  ],
  spread: 'pad',
};

/** A triangle path (0, 0), (10, 0), (10, 10) with a gradient fill. */
function triangle(target: Editor): string {
  const [id] = ok(target, {
    type: 'createPath',
    verbs: ['move', 'line', 'line', 'close'],
    points: [0, 0, 10, 0, 10, 10],
    fill: red,
  });
  ok(target, { type: 'setStyle', ids: [id!], style: { fill: gradient } });
  return id!;
}

function points(target: Editor, id: string): readonly number[] {
  const n = node(target, id);
  if (n.type !== 'path') throw new Error('not a path');
  return n.path.points;
}

describe('resize past the opposite handle flips', () => {
  it('flips a multi-selection over the anchor instead of clamping at 0, as one step', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 30, 10, 10, 30);
    ok(target, { type: 'setSelection', ids: [a, b] });
    const depth = target.query({ type: 'history' }).undoDepth;
    // Selection box (0, 0)-(40, 40); the right edge handle goes from x 40 to x -50: scale -1.25.
    drag(target, [40, 20], [20, 20], [-50, 20]);
    expect(node(target, a).frame).toEqual({ x: -12.5, y: 0, width: 12.5, height: 10 });
    expect(node(target, b).frame).toEqual({ x: -50, y: 10, width: 12.5, height: 30 });
    expect(target.query({ type: 'history' }).undoDepth).toBe(depth + 1);
    ok(target, { type: 'undo' });
    expect(node(target, b).frame).toEqual({ x: 30, y: 10, width: 10, height: 30 });
  });

  it('mirrors path points and the gradient of one node dragged past by a corner', () => {
    const target = editor();
    const p = triangle(target);
    ok(target, { type: 'setSelection', ids: [p] });
    // Corner (10, 10) to (-20, 10): x scale -2, y scale 1.
    drag(target, [10, 10], [5, 10], [-20, 10]);
    const after = node(target, p);
    expect(after.frame).toEqual({ x: -20, y: 0, width: 20, height: 10 });
    expect(points(target, p)).toEqual([1, 0, 0, 0, 0, 1]);
    expect(after.type === 'path' && after.fill).toEqual({
      ...gradient,
      transform: [-1, 0, 0, 1, 1, 0],
    });
  });

  it('flips both axes when a corner crosses diagonally', () => {
    const target = editor();
    const p = triangle(target);
    ok(target, { type: 'setSelection', ids: [p] });
    drag(target, [10, 10], [-10, -10]);
    expect(node(target, p).frame).toEqual({ x: -10, y: -10, width: 10, height: 10 });
    expect(points(target, p)).toEqual([1, 1, 0, 1, 0, 0]);
  });

  it('flips by an edge handle too', () => {
    const target = editor();
    const p = triangle(target);
    ok(target, { type: 'setSelection', ids: [p] });
    // Bottom edge handle (5, 10) up past the top edge to y -30: y scale -3.
    drag(target, [5, 10], [5, -30]);
    expect(node(target, p).frame).toEqual({ x: 0, y: -30, width: 10, height: 30 });
    expect(points(target, p)).toEqual([0, 1, 1, 1, 1, 0]);
  });

  it('unflips when dragged back within the same gesture', () => {
    const target = editor();
    const p = triangle(target);
    const before = node(target, p);
    ok(target, { type: 'setSelection', ids: [p] });
    drag(target, [10, 10], [-20, 10], [-20, -20], [20, 30]);
    const after = node(target, p);
    expect(after.frame).toEqual({ x: 0, y: 0, width: 20, height: 30 });
    expect(after.type === 'path' && [after.path, after.fill]).toEqual(
      before.type === 'path' && [before.path, before.fill],
    );
  });

  it('mirrors a group: children reflect inside it and their content mirrors', () => {
    const target = editor();
    const p = triangle(target);
    const r = rect(target, 20, 0, 10, 10);
    ok(target, { type: 'setNodeProps', id: r, props: { cornerRadii: [1, 2, 3, 4] } });
    const [g] = ok(target, { type: 'groupNodes', ids: [p, r], kind: 'group' });
    ok(target, { type: 'setSelection', ids: [g!] });
    // Group box (0, 0)-(30, 10); left edge handle from x 0 to x 60: x scale -1 about x 30.
    drag(target, [0, 5], [60, 5]);
    expect(node(target, g!).frame).toEqual({ x: 30, y: 0, width: 30, height: 10 });
    const page = (id: string) => {
      const f = node(target, id).frame;
      const gf = node(target, g!).frame;
      return { x: gf.x + f.x, y: gf.y + f.y, width: f.width, height: f.height };
    };
    expect(page(p)).toEqual({ x: 50, y: 0, width: 10, height: 10 });
    expect(page(r)).toEqual({ x: 30, y: 0, width: 10, height: 10 });
    expect(points(target, p)).toEqual([1, 0, 0, 0, 0, 1]);
    const radii = node(target, r);
    expect(radii.type === 'rectangle' && radii.cornerRadii).toEqual([2, 1, 4, 3]);
  });

  it('flips a rotated node in its own axes and keeps its rotation', () => {
    const target = editor();
    const p = triangle(target);
    const turn = 0.5;
    ok(target, { type: 'rotateNodes', ids: [p], angle: turn });
    ok(target, { type: 'setSelection', ids: [p] });
    const handles = target.query({ type: 'handles' })!;
    // Handles in order TL, T, TR, R, BR, B, BL, L; drag R past L by the box width again.
    const right = handles.handles[3]!;
    const left = handles.handles[7]!;
    const to: [number, number] = [2 * left.x - right.x, 2 * left.y - right.y];
    const centre = { x: (right.x + left.x) / 2, y: (right.y + left.y) / 2 };
    drag(target, [right.x, right.y], to);
    const after = node(target, p);
    expect(after.rotation).toBeCloseTo(turn, 12);
    expect(after.frame.width).toBeCloseTo(10, 9);
    expect(after.frame.height).toBeCloseTo(10, 9);
    // The box mirrored over its left edge: its centre moved back by the width along own x.
    expect(after.frame.x + 5).toBeCloseTo(centre.x - 10 * Math.cos(turn), 9);
    expect(after.frame.y + 5).toBeCloseTo(centre.y - 10 * Math.sin(turn), 9);
    expect(points(target, p)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it('reflects a rotated node within a flipped multi-selection: angle θ becomes −θ', () => {
    const target = editor();
    const p = triangle(target);
    const r = rect(target, 40, 0, 10, 10);
    ok(target, { type: 'rotateNodes', ids: [p], angle: 0.3 });
    ok(target, { type: 'setSelection', ids: [p, r] });
    const [tl, , br] = target.query({ type: 'handles' })!.corners;
    const midY = (tl.y + br.y) / 2;
    // Right edge handle to the mirror image of itself over the left edge: scale −1.
    drag(target, [br.x, midY], [2 * tl.x - br.x, midY]);
    const after = node(target, p);
    expect(after.rotation).toBeCloseTo(-0.3, 12);
    expect(points(target, p)).toEqual([1, 0, 0, 0, 0, 1]);
    // The rectangle mirrored over the left edge of the box.
    expect(node(target, r).frame.x).toBeCloseTo(2 * tl.x - 50, 9);
  });
});
