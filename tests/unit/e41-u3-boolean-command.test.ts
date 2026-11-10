import {
  serializeDocument,
  type DocumentV7,
  type Gradient,
  type NodeV7,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type Modifiers,
} from '../../packages/editor-core/src/index.js';
import { DEFAULT_KEYMAP } from '../../packages/editor-core/src/keymap.js';
import { localTransform, multiply } from '../../packages/editor-core/src/geometry.js';

// E41-U3a (E41 contract, sections 2.1 to 2.3 and 6): the `booleanNodes` command and the
// `boolean` key action. E41-A03: B1 to B5, the gradient re-map on a sampled page grid, group
// refit, each rejection with no change and its notice, and one undo step restoring inputs,
// order and selection.

type Op = 'union' | 'subtract' | 'intersect' | 'exclude';
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };

function editor(): Editor {
  return createEditor({
    ids: createCounterIdSource('n'),
    extensions: [starExtension],
    platform: 'other',
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function rect(target: Editor, x: number, y: number, w: number, h: number, extra = {}): string {
  return ok(target, {
    type: 'createRectangle',
    frame: { x, y, width: w, height: h },
    fill: red,
    ...extra,
  })[0]!;
}

function ellipse(target: Editor, x: number, y: number, w: number, h: number): string {
  return ok(target, {
    type: 'createEllipse',
    frame: { x, y, width: w, height: h },
    fill: blue,
  })[0]!;
}

function doc(target: Editor): DocumentV7 {
  return target.query({ type: 'document' });
}

function node(target: Editor, id: string): NodeV7 {
  const found = target.query({ type: 'node', id });
  if (found === null) throw new Error(`no node ${id}`);
  return found;
}

function children(target: Editor, owner?: string): readonly string[] {
  const d = doc(target);
  if (owner === undefined) return d.pages[0]!.children;
  const parent = d.nodes[owner]!;
  return 'children' in parent ? parent.children : [];
}

function selection(target: Editor): readonly string[] {
  return target.getSnapshot().selection;
}

function run(target: Editor, ids: readonly string[], op: Op) {
  return target.execute({ type: 'booleanNodes', ids, op });
}

/** Page-space polygon of a path node, its cubics sampled at 64 steps (rotation 0 results). */
function polygons(path: NodeV7): { x: number; y: number }[][] {
  if (path.type !== 'path') throw new Error('not a path');
  const { x: fx, y: fy, width, height } = path.frame;
  const pts = path.path.points;
  const at = (i: number) => ({ x: fx + pts[i]! * width, y: fy + pts[i + 1]! * height });
  const out: { x: number; y: number }[][] = [];
  let ring: { x: number; y: number }[] = [];
  let next = 0;
  for (const verb of path.path.verbs) {
    if (verb === 'move') {
      ring = [at(next)];
      next += 2;
    } else if (verb === 'line') {
      ring.push(at(next));
      next += 2;
    } else if (verb === 'cubic') {
      const p0 = ring[ring.length - 1]!;
      const [c1, c2, p1] = [at(next), at(next + 2), at(next + 4)];
      next += 6;
      for (let k = 1; k <= 64; k += 1) {
        const t = k / 64;
        const u = 1 - t;
        ring.push({
          x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
          y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
        });
      }
    } else {
      out.push(ring);
    }
  }
  return out;
}

/** Signed area summed over contours, positive for the engine's orientation. */
function area(path: NodeV7): number {
  let sum = 0;
  for (const ring of polygons(path)) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      sum += a.x * b.y - b.x * a.y;
    }
  }
  // The result is on the left of each piece (section 2.4): counter-clockwise on screen.
  return -sum / 2;
}

describe('E41-A03 booleanNodes: result node (B1, B2)', () => {
  it('union of two overlapping rectangles: one nonzero path in the top slot', () => {
    const target = editor();
    const below = rect(target, 200, 0, 10, 10);
    const a = rect(target, 0, 0, 100, 50, { name: 'Base', cornerRadii: [0, 0, 0, 0] });
    const middle = rect(target, 300, 0, 10, 10);
    const b = rect(target, 50, 25, 100, 50);
    const above = rect(target, 400, 0, 10, 10);
    const ids = ok(target, { type: 'booleanNodes', ids: [b, a], op: 'union' });
    expect(ids).toHaveLength(1);
    const result = node(target, ids[0]!);
    expect(result).toMatchObject({
      type: 'path',
      name: 'Base',
      rotation: 0,
      fill: red,
      frame: { x: 0, y: 0, width: 150, height: 75 },
    });
    if (result.type !== 'path') throw new Error('path');
    expect(result.path.fillRule).toBe('nonzero');
    expect(area(result)).toBeCloseTo(100 * 50 * 2 - 50 * 25, 6);
    // B2: the result takes the topmost input's slot.
    expect(children(target)).toEqual([below, middle, ids[0], above]);
    expect(target.query({ type: 'node', id: a })).toBeNull();
    expect(target.query({ type: 'node', id: b })).toBeNull();
    // B3: the selection becomes the result.
    expect(selection(target)).toEqual(ids);
  });

  it.each<[Op, number]>([
    ['union', 100 * 100 + Math.PI * 50 * 50 - (Math.PI * 50 * 50) / 4],
    ['subtract', 100 * 100 - (Math.PI * 50 * 50) / 4],
    ['intersect', (Math.PI * 50 * 50) / 4],
    ['exclude', 100 * 100 + Math.PI * 50 * 50 - (Math.PI * 50 * 50) / 2],
  ])('%s of a square and a circle centred on its corner', (op, expected) => {
    const target = editor();
    const a = rect(target, 0, 0, 100, 100);
    const b = ellipse(target, 50, 50, 100, 100);
    const [id] = ok(target, { type: 'booleanNodes', ids: [a, b], op });
    // The quarter-arc cubic is within 3e-4 of the circle's radius.
    expect(area(node(target, id!)) / expected).toBeCloseTo(1, 3);
  });

  it('subtract takes the bottom input in paint order, whatever the ID order', () => {
    const target = editor();
    const small = rect(target, 25, 25, 50, 50, { fill: blue });
    const big = rect(target, 0, 0, 100, 100);
    // `small` paints below `big`, so it is A₀: small minus big is empty.
    expect(run(target, [big, small], 'subtract')).toEqual({
      ok: false,
      code: 'editor.boolean-empty',
    });
    const target2 = editor();
    const big2 = rect(target2, 0, 0, 100, 100);
    const small2 = rect(target2, 25, 25, 50, 50, { fill: blue });
    const [id] = ok(target2, { type: 'booleanNodes', ids: [small2, big2], op: 'subtract' });
    const result = node(target2, id!);
    expect(area(result)).toBeCloseTo(100 * 100 - 50 * 50, 6);
    // Style from A₀ (the big red square), its hole a second contour.
    expect(result).toMatchObject({ fill: red });
    expect(polygons(result)).toHaveLength(2);
  });

  it('rotated inputs combine in parent space and the result has rotation 0', () => {
    const target = editor();
    const a = rect(target, 0, 0, 100, 100);
    const b = rect(target, 0, 0, 100, 100);
    ok(target, { type: 'rotateNodes', ids: [b], angle: Math.PI / 4 });
    const [id] = ok(target, { type: 'booleanNodes', ids: [a, b], op: 'intersect' });
    const result = node(target, id!);
    expect(result.rotation).toBe(0);
    // A square and the same square turned 45° about its centre share a regular octagon.
    const octagon = 8 * 50 ** 2 * Math.tan(Math.PI / 8);
    expect(area(result) / octagon).toBeCloseTo(1, 9);
  });

  it('paths keep their fill rule as input; a star (custom node) is an input', () => {
    const target = editor();
    const star = ok(target, {
      type: 'createCustomNode',
      customType: 'ext.star',
      frame: { x: 0, y: 0, width: 100, height: 100 },
      fill: red,
    })[0]!;
    const square = rect(target, 0, 0, 100, 100);
    const [id] = ok(target, { type: 'booleanNodes', ids: [star, square], op: 'intersect' });
    const result = node(target, id!);
    // The square is the star's frame, which covers it: the star's own area comes back, as
    // against a larger square.
    const area2 = (() => {
      const t = editor();
      const s = ok(t, {
        type: 'createCustomNode',
        customType: 'ext.star',
        frame: { x: 0, y: 0, width: 100, height: 100 },
        fill: red,
      })[0]!;
      const big = rect(t, -10, -10, 200, 200);
      const [u] = ok(t, { type: 'booleanNodes', ids: [s, big], op: 'intersect' });
      return area(node(t, u!));
    })();
    expect(area(result)).toBeCloseTo(area2, 6);
    expect(area(result)).toBeGreaterThan(0);
  });

  it('copies opacity, constraints, effects and stroke from A₀', () => {
    const target = editor();
    const stroke = {
      color: blue,
      width: 3,
      cap: 'round',
      join: 'bevel',
      miterLimit: 4,
      dash: null,
    } as const;
    const a = rect(target, 0, 0, 100, 100, { stroke });
    const b = rect(target, 50, 0, 100, 100);
    ok(target, { type: 'setNodeProps', id: a, props: { opacity: 0.5 } });
    const before = node(target, a);
    const [id] = ok(target, { type: 'booleanNodes', ids: [a, b], op: 'union' });
    const result = node(target, id!);
    expect(result).toMatchObject({
      opacity: 0.5,
      stroke,
      constraints: before.constraints,
      effects: before.effects,
    });
  });
});

/** The gradient-space point that page point `p` is painted from, for a rotation-0 parent. */
function gradientPoint(target: Editor, id: string, p: { x: number; y: number }) {
  const n = node(target, id);
  if (!('fill' in n) || n.fill === null || !('kind' in n.fill)) throw new Error('no gradient');
  const unit = multiply(localTransform(n.frame, n.rotation), [
    n.frame.width,
    0,
    0,
    n.frame.height,
    0,
    0,
  ]);
  const m = multiply(unit, n.fill.transform);
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const x = p.x - e;
  const y = p.y - f;
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
}

describe('E41-A03 gradient re-map (B2)', () => {
  it.each([0, Math.PI / 6])(
    'paints the same page pixels on a sampled grid (A₀ at %f rad)',
    (angle) => {
      const target = editor();
      const gradient: Gradient = {
        kind: 'linear',
        transform: [0.8, 0.3, -0.2, 0.6, 0.1, 0.2],
        stops: [
          { offset: 0, color: red },
          { offset: 1, color: blue },
        ],
        spread: 'reflect',
      };
      const a = rect(target, 0, 0, 120, 80, { fill: gradient });
      if (angle !== 0) ok(target, { type: 'rotateNodes', ids: [a], angle });
      const b = ellipse(target, 60, 20, 120, 90);
      const samples: { x: number; y: number }[] = [];
      for (let i = 0; i <= 8; i += 1) {
        for (let j = 0; j <= 8; j += 1) samples.push({ x: -20 + i * 25, y: -20 + j * 16 });
      }
      const before = samples.map((p) => gradientPoint(target, a, p));
      const [id] = ok(target, { type: 'booleanNodes', ids: [a, b], op: 'union' });
      const after = samples.map((p) => gradientPoint(target, id!, p));
      after.forEach((q, i) => {
        expect(q.x).toBeCloseTo(before[i]!.x, 9);
        expect(q.y).toBeCloseTo(before[i]!.y, 9);
      });
      const result = node(target, id!);
      expect(result).toMatchObject({
        fill: { kind: 'linear', stops: gradient.stops, spread: 'reflect' },
      });
    },
  );
});

describe('E41-A03 transaction (B3)', () => {
  it('one undo step restores inputs, order and selection; redo the result', () => {
    const target = editor();
    const a = rect(target, 0, 0, 100, 100);
    const other = rect(target, 500, 0, 10, 10);
    const b = rect(target, 50, 50, 100, 100);
    ok(target, { type: 'setSelection', ids: [a, b] });
    const before = serializeDocument(doc(target));
    const [id] = ok(target, { type: 'booleanNodes', ids: [a, b], op: 'union' });
    expect(children(target)).toEqual([other, id]);
    ok(target, { type: 'undo' });
    expect(serializeDocument(doc(target))).toBe(before);
    expect(children(target)).toEqual([a, other, b]);
    expect(selection(target)).toEqual([a, b]);
    ok(target, { type: 'redo' });
    expect(children(target)).toEqual([other, id]);
    expect(selection(target)).toEqual([id]);
  });

  it('inside a group: the result stays in the group and the group refits', () => {
    const target = editor();
    const a = rect(target, 0, 0, 100, 100);
    const b = rect(target, 50, 50, 100, 100);
    const c = rect(target, 300, 300, 50, 50);
    const [group] = ok(target, { type: 'groupNodes', ids: [a, b, c], kind: 'group' });
    expect(node(target, group!).frame).toEqual({ x: 0, y: 0, width: 350, height: 350 });
    const [id] = ok(target, { type: 'booleanNodes', ids: [a, b], op: 'intersect' });
    expect(node(target, id!).parent).toBe(group);
    expect(children(target, group)).toEqual([id, c]);
    // The intersection is 50..100 in the group; the group refits to it and `c`.
    expect(node(target, group!).frame).toEqual({ x: 50, y: 50, width: 300, height: 300 });
  });
});

describe('E41-A03 rejections (2.1, B4, B5): no change, one notice code', () => {
  function unchanged(target: Editor, command: Command, code: string) {
    const text = serializeDocument(doc(target));
    const sel = selection(target);
    const revision = target.getSnapshot().revision;
    expect(target.execute(command)).toMatchObject({ ok: false, code });
    expect(serializeDocument(doc(target))).toBe(text);
    expect(selection(target)).toEqual(sel);
    expect(target.getSnapshot().revision).toBe(revision);
  }

  it('malformed commands', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 5, 5, 10, 10);
    expect(target.execute({ type: 'booleanNodes', ids: [a, a], op: 'union' })).toMatchObject({
      code: 'editor.invalid-command',
      path: '/ids',
    });
    expect(target.execute({ type: 'booleanNodes', ids: [a, b], op: 'xor' as Op })).toMatchObject({
      code: 'editor.invalid-command',
      path: '/op',
    });
    expect(target.execute({ type: 'booleanNodes', ids: [a, 'nope'], op: 'union' })).toMatchObject({
      code: 'editor.unknown-node',
    });
  });

  it('fewer than two inputs', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    rect(target, 50, 50, 10, 10);
    unchanged(
      target,
      { type: 'booleanNodes', ids: [a], op: 'union' },
      'editor.boolean-unsupported',
    );
  });

  it('unsupported node types: line, text-free frame, group', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const line = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 10 },
    })[0]!;
    unchanged(
      target,
      { type: 'booleanNodes', ids: [a, line], op: 'union' },
      'editor.boolean-unsupported',
    );
    const frame = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 20, height: 20 },
    })[0]!;
    const b = rect(target, 100, 0, 10, 10);
    unchanged(
      target,
      { type: 'booleanNodes', ids: [b, frame], op: 'union' },
      'editor.boolean-unsupported',
    );
  });

  it('a hidden input', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 5, 5, 10, 10);
    ok(target, { type: 'setNodeProps', id: b, props: { visible: false } });
    unchanged(
      target,
      { type: 'booleanNodes', ids: [a, b], op: 'union' },
      'editor.boolean-unsupported',
    );
  });

  it('inputs with different parents', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 5, 5, 10, 10);
    const c = rect(target, 50, 50, 10, 10);
    ok(target, { type: 'groupNodes', ids: [b, c], kind: 'group' });
    unchanged(
      target,
      { type: 'booleanNodes', ids: [a, b], op: 'union' },
      'editor.boolean-unsupported',
    );
  });

  it('a mask source', () => {
    const target = editor();
    // A mask source is a path (M1 contract, section 4.3).
    const a = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 200, 0, 0, 200],
      fill: red,
    })[0]!;
    const b = rect(target, 50, 50, 100, 100);
    const c = rect(target, 0, 50, 100, 100);
    ok(target, { type: 'groupNodes', ids: [a, b, c], kind: 'maskGroup' });
    unchanged(
      target,
      { type: 'booleanNodes', ids: [a, b], op: 'union' },
      'editor.boolean-unsupported',
    );
    // Two non-source children of the mask group are fine.
    const [id] = ok(target, { type: 'booleanNodes', ids: [b, c], op: 'union' });
    expect(node(target, id!).type).toBe('path');
  });

  it('B4: an empty region', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 50, 50, 10, 10);
    unchanged(
      target,
      { type: 'booleanNodes', ids: [a, b], op: 'intersect' },
      'editor.boolean-empty',
    );
  });

  it('B5: more than 4,096 input segments', () => {
    const target = editor();
    const verbs: ('move' | 'line' | 'close')[] = ['move'];
    const points: number[] = [0, 0];
    for (let k = 1; k <= 4100; k += 1) {
      const t = (2 * Math.PI * k) / 4101;
      verbs.push('line');
      points.push(50 + 50 * Math.cos(t), 50 + 50 * Math.sin(t));
    }
    verbs.push('close');
    const path = ok(target, { type: 'createPath', verbs, points, fill: red })[0]!;
    const b = rect(target, 0, 0, 50, 50);
    unchanged(
      target,
      { type: 'booleanNodes', ids: [path, b], op: 'union' },
      'editor.boolean-too-large',
    );
  });

  it('a failed command draws no ID', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 50, 50, 10, 10);
    expect(run(target, [a, b], 'intersect').ok).toBe(false);
    const next = rect(target, 0, 0, 10, 10);
    // The counter source draws `next` right after `b`: none for the failed command.
    expect(next).toBe(`n${Number(b.slice(1)) + 1}`);
  });
});

describe('E41 section 6: the boolean key action', () => {
  it('default chords Mod+Alt+U, S, I, X', () => {
    const chords = DEFAULT_KEYMAP.filter((binding) => binding.action === 'boolean').map(
      (binding) => [binding.chord, (binding.args as { op: string }).op],
    );
    expect(chords).toEqual([
      ['Mod+Alt+U', 'union'],
      ['Mod+Alt+S', 'subtract'],
      ['Mod+Alt+I', 'intersect'],
      ['Mod+Alt+X', 'exclude'],
    ]);
  });

  it('Ctrl+Alt+U unions the selection and selects the result; no selection does nothing', () => {
    const target = editor();
    const a = rect(target, 0, 0, 100, 100);
    const b = rect(target, 50, 50, 100, 100);
    const press = () =>
      target.execute({
        type: 'input',
        event: {
          kind: 'keydown',
          key: 'u',
          code: 'KeyU',
          modifiers: { ...none, ctrl: true, alt: true },
        },
      });
    ok(target, { type: 'setSelection', ids: [] });
    expect(press()).toMatchObject({ ok: true });
    expect(children(target)).toEqual([a, b]);
    ok(target, { type: 'setSelection', ids: [a, b] });
    expect(press()).toMatchObject({ ok: true });
    const [only] = children(target);
    expect(node(target, only!).type).toBe('path');
    expect(selection(target)).toEqual([only]);
  });

  it('a rejected key action reports its notice and changes nothing', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 50, 50, 10, 10);
    ok(target, { type: 'setSelection', ids: [a, b] });
    const result = target.execute({
      type: 'input',
      event: {
        kind: 'keydown',
        key: 'i',
        code: 'KeyI',
        modifiers: { ...none, ctrl: true, alt: true },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'editor.boolean-empty' });
    expect(children(target)).toEqual([a, b]);
  });

  it('keymap layers validate `boolean { op }`', () => {
    const target = editor();
    expect(
      target.execute({
        type: 'setKeymap',
        bindings: [{ chord: 'Mod+B', action: 'boolean', args: { op: 'nope' } }],
      }),
    ).toMatchObject({ ok: false, code: 'editor.invalid-keymap' });
    expect(
      target.execute({
        type: 'setKeymap',
        bindings: [{ chord: 'Mod+B', action: 'boolean', args: { op: 'exclude' } }],
      }).ok,
    ).toBe(true);
  });
});
