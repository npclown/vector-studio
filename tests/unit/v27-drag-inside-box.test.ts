import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type Modifiers,
} from '../../packages/editor-core/src/index.js';

// V-27 (Figma): a drag from empty space strictly inside the selection's handle box moves the
// selection instead of starting a marquee; a click there still acts as one on empty canvas.

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

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
  modifiers: Modifiers = none,
) {
  ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers } });
}

function drag(
  target: Editor,
  from: readonly [number, number],
  to: readonly [number, number],
  modifiers: Modifiers = none,
) {
  pointer(target, 'pointerdown', from[0], from[1], modifiers);
  pointer(target, 'pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, modifiers);
  pointer(target, 'pointermove', to[0], to[1], modifiers);
  pointer(target, 'pointerup', to[0], to[1], modifiers);
}

function rect(target: Editor, x: number, y: number, size = 20): string {
  return ok(target, {
    type: 'createPath',
    verbs: ['move', 'line', 'line', 'line', 'close'],
    points: [x, y, x + size, y, x + size, y + size, x, y + size],
  })[0]!;
}

const frameOf = (target: Editor, id: string) => target.query({ type: 'node', id })!.frame;
const selectionOf = (target: Editor) => target.query({ type: 'selection' });

/** Two squares at (0, 0) and (80, 80), grouped: the gap between them is empty. */
function grouped(target: Editor): { group: string; a: string; b: string } {
  const a = rect(target, 0, 0);
  const b = rect(target, 80, 80);
  const [group] = ok(target, { type: 'groupNodes', ids: [a, b], kind: 'group' });
  ok(target, { type: 'setSelection', ids: [group!] });
  return { group: group!, a, b };
}

describe('V-27 drag inside the selection box', () => {
  it('moves a selected group from empty space inside its box', () => {
    const target = editor();
    const { group } = grouped(target);
    const before = frameOf(target, group);
    drag(target, [50, 50], [60, 65]);
    expect(selectionOf(target)).toEqual([group]);
    const after = frameOf(target, group);
    expect(after.x).toBeCloseTo(before.x + 10, 9);
    expect(after.y).toBeCloseTo(before.y + 15, 9);
    expect(target.query({ type: 'history' }).undoDepth).toBeGreaterThan(0);
  });

  it('moves a multi-selection from the gap between its nodes', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 80, 80);
    ok(target, { type: 'setSelection', ids: [a, b] });
    drag(target, [50, 50], [40, 30]);
    expect(selectionOf(target)).toEqual([a, b]);
    expect(frameOf(target, a)).toMatchObject({ x: -10, y: -20 });
    expect(frameOf(target, b)).toMatchObject({ x: 70, y: 60 });
  });

  it('moves a rotated group from empty space inside its turned box', () => {
    const target = editor();
    const { group } = grouped(target);
    ok(target, { type: 'rotateNodes', ids: [group], angle: Math.PI / 4 });
    const box = target.query({ type: 'handles' })!;
    // The box centre is empty canvas (the squares sit at the box's ends).
    const cx = (box.corners[0].x + box.corners[2].x) / 2;
    const cy = (box.corners[0].y + box.corners[2].y) / 2;
    const before = target.query({ type: 'handles' })!.corners.map((p) => ({ ...p }));
    drag(target, [cx, cy], [cx + 5, cy - 7]);
    expect(selectionOf(target)).toEqual([group]);
    const after = target.query({ type: 'handles' })!.corners;
    after.forEach((point, index) => {
      expect(point.x).toBeCloseTo(before[index]!.x + 5, 9);
      expect(point.y).toBeCloseTo(before[index]!.y - 7, 9);
    });
  });

  it('a click inside the box still clears the selection, with and without Alt', () => {
    for (const modifiers of [none, { ...none, alt: true }]) {
      const target = editor();
      const { group } = grouped(target);
      const before = frameOf(target, group);
      const depth = target.query({ type: 'history' }).undoDepth;
      pointer(target, 'pointerdown', 50, 50, modifiers);
      pointer(target, 'pointerup', 50, 50, modifiers);
      expect(selectionOf(target)).toEqual([]);
      expect(frameOf(target, group)).toEqual(before);
      expect(target.query({ type: 'history' }).undoDepth).toBe(depth);
    }
  });

  it('a drag inside a scope keeps the scope; a click on page canvas there leaves it', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 80, 80);
    const [group] = ok(target, { type: 'groupNodes', ids: [a, b], kind: 'group' });
    ok(target, { type: 'setScope', id: group! });
    ok(target, { type: 'setSelection', ids: [a, b] });
    const before = target.query({ type: 'handles' })!.corners[0];
    drag(target, [50, 50], [55, 50]);
    expect(target.query({ type: 'scope' })).toBe(group);
    expect(selectionOf(target)).toEqual([a, b]);
    expect(target.query({ type: 'handles' })!.corners[0]).toEqual({
      x: before.x + 5,
      y: before.y,
    });
    pointer(target, 'pointerdown', 50, 50);
    pointer(target, 'pointerup', 50, 50);
    expect(target.query({ type: 'scope' })).toBeNull();
    expect(selectionOf(target)).toEqual([]);
  });

  it('still clears the selection on a click outside the box', () => {
    const target = editor();
    grouped(target);
    pointer(target, 'pointerdown', 300, 300);
    pointer(target, 'pointerup', 300, 300);
    expect(selectionOf(target)).toEqual([]);
  });

  it('Shift inside the box still starts an additive marquee', () => {
    const target = editor();
    const a = rect(target, 0, 0);
    const b = rect(target, 80, 80);
    const c = rect(target, 40, 40, 10);
    ok(target, { type: 'setSelection', ids: [a, b] });
    const shift = { ...none, shift: true };
    drag(target, [35, 35], [55, 55], shift);
    expect(frameOf(target, a)).toMatchObject({ x: 0, y: 0 });
    expect([...selectionOf(target)].sort()).toEqual([a, b, c].sort());
  });

  it('Alt-drag inside the box duplicates the selection', () => {
    const target = editor();
    const { group } = grouped(target);
    const before = frameOf(target, group);
    drag(target, [50, 50], [70, 50], { ...none, alt: true });
    const [copy] = selectionOf(target);
    expect(copy).not.toBe(group);
    expect(frameOf(target, group)).toEqual(before);
    expect(frameOf(target, copy!).x).toBeCloseTo(before.x + 20, 9);
  });
});
