import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Editor,
  type EditorOptions,
  type Modifiers,
  type PagePoint,
} from '@vector-studio/editor-core';
import {
  FREEHAND,
  fitCubics,
  freehandPath,
  freehandPreview,
  gridSnap,
  polygonPath,
  smooth,
} from '../../packages/editor-core/src/freehand.js';
import {
  polygonSidesCommit,
  polygonSidesStep,
} from '../../packages/ui/src/editor-toolbar-model.js';

// V-40 (Figma gap item 10; contract docs/plans/viz-v40-pencil-polygon-contract.md): the pencil
// tool (freehand stroke smoothed and fitted with cubics) and the polygon tool (a regular polygon
// filling its drag box, 3 to 60 sides).

const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const shift: Modifiers = { ...none, shift: true };

function editor(tool: 'pencil' | 'polygon', options: EditorOptions = {}): Editor {
  const target = createEditor({ ids: createCounterIdSource('n'), ...options });
  const result = target.execute({ type: 'setTool', tool });
  if (!result.ok) throw new Error(result.code);
  return target;
}

function send(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
  modifiers: Modifiers = none,
) {
  target.execute({ type: 'input', event: { kind, point, modifiers } });
}

function key(target: Editor, name: string) {
  target.execute({
    type: 'input',
    event: { kind: 'keydown', key: name, repeat: false, composing: false, modifiers: none },
  });
}

function drag(target: Editor, points: readonly PagePoint[], modifiers: Modifiers = none) {
  send(target, 'pointerdown', points[0]!, modifiers);
  for (const point of points.slice(1)) send(target, 'pointermove', point, modifiers);
  send(target, 'pointerup', points[points.length - 1]!, modifiers);
}

function paths(target: Editor) {
  return Object.values(target.getSnapshot().document.nodes).filter((node) => node.type === 'path');
}

/** Samples of a sine wave from x 0 to 200, one every `step` px, with optional jitter. */
function wave(step = 2, jitter = 0): PagePoint[] {
  const out: PagePoint[] = [];
  for (let x = 0; x <= 200; x += step) {
    const noise = jitter === 0 ? 0 : (((x * 7919) % 13) / 13 - 0.5) * 2 * jitter;
    out.push({ x, y: 50 + 40 * Math.sin(x / 30) + noise });
  }
  return out;
}

/** Samples of a circle of radius 50 around (100, 100), ending on its start. */
function circle(count = 120): PagePoint[] {
  const out: PagePoint[] = [];
  for (let i = 0; i <= count; i += 1) {
    const angle = (2 * Math.PI * i) / count;
    out.push({ x: 100 + 50 * Math.cos(angle), y: 100 + 50 * Math.sin(angle) });
  }
  return out;
}

function onCubic(c: readonly number[], t: number): PagePoint {
  const mt = 1 - t;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = c as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    x: mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
    y: mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
  };
}

/** Dense samples of a `move`/`cubic` path's curve. */
function sampleCurve(points: readonly number[]): PagePoint[] {
  const out: PagePoint[] = [];
  for (let i = 2; i + 6 <= points.length; i += 6) {
    const c = points.slice(i - 2, i + 6);
    for (let k = 0; k <= 256; k += 1) out.push(onCubic(c, k / 256));
  }
  return out;
}

const nearest = (curve: readonly PagePoint[], p: PagePoint) =>
  Math.min(...curve.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));

describe('V-40 freehand geometry', () => {
  it('fits a smooth stroke with few cubics, within the tolerance of the smoothed samples', () => {
    const samples = wave(2);
    const data = freehandPath(samples, 1)!;
    expect(data.verbs[0]).toBe('move');
    expect(data.verbs.slice(1).every((verb) => verb === 'cubic')).toBe(true);
    // 101 samples become a handful of curves.
    expect(data.verbs.length - 1).toBeLessThanOrEqual(8);
    const curve = sampleCurve(data.points);
    const smoothed = smooth(samples, FREEHAND.smoothPx);
    for (const p of smoothed) expect(nearest(curve, p)).toBeLessThan(FREEHAND.tolerancePx + 0.1);
    // Ends where the stroke starts and ends.
    expect(data.points.slice(0, 2)).toEqual([0, 50]);
    expect(data.points.at(-2)).toBe(200);
  });

  it('smooths hand jitter away: a jittered stroke fits with no more curves than a clean one plus 2', () => {
    const clean = freehandPath(wave(2), 1)!;
    const jittered = freehandPath(wave(2, 1.5), 1)!;
    expect(jittered.verbs.length).toBeLessThanOrEqual(clean.verbs.length + 2);
  });

  it('closes a stroke that ends near its start, with the last cubic ending on the start', () => {
    const data = freehandPath(circle(), 1)!;
    expect(data.verbs.at(-1)).toBe('close');
    expect(data.points.slice(-2)).toEqual(data.points.slice(0, 2));
    const curve = sampleCurve(data.points);
    for (let i = 0; i < 12; i += 1) {
      const angle = (2 * Math.PI * i) / 12;
      const p = { x: 100 + 50 * Math.cos(angle), y: 100 + 50 * Math.sin(angle) };
      expect(nearest(curve, p)).toBeLessThan(FREEHAND.tolerancePx + 1);
    }
  });

  it('keeps the size of a loop however sparse its samples (review B1, r2)', () => {
    for (const radius of [10, 30, 100]) {
      for (let count = 4; count <= 40; count += 1) {
        const samples: PagePoint[] = [];
        for (let i = 0; i <= count; i += 1) {
          const angle = (2 * Math.PI * i) / count;
          samples.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
        }
        const data = freehandPath(samples, 1);
        // Too short to close (a loop of 10 px with few samples) is still a path, never null.
        expect(data, `r ${radius} n ${count}`).not.toBeNull();
        const curve = sampleCurve(data!.points);
        const xs = curve.map((p) => p.x);
        // The drawn polygon's own width is at least 2r cos(pi / n); the curve keeps 90 % of it.
        const drawn = 2 * radius * Math.cos(Math.PI / count);
        expect(Math.max(...xs) - Math.min(...xs), `r ${radius} n ${count}`).toBeGreaterThan(
          0.9 * drawn,
        );
      }
    }
    // The reviewer's square loop makes a real shape, not a point.
    const square = freehandPath(
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
        { x: 0, y: 5 },
        { x: 0, y: 0.5 },
        { x: 0.2, y: 0.1 },
      ],
      1,
    )!;
    const ys = square.points.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(15);
  });

  it('leaves a stroke open when it ends away from its start', () => {
    const open = circle().slice(0, 100);
    expect(freehandPath(open, 1)!.verbs.at(-1)).toBe('cubic');
  });

  it('accepts a 3 px stroke in any direction and a tiny dense scribble (review r2)', () => {
    for (const angle of [0, Math.PI / 4, Math.PI / 2, 1]) {
      const end = { x: 3.2 * Math.cos(angle), y: 3.2 * Math.sin(angle) };
      expect(freehandPath([{ x: 0, y: 0 }, end], 1), `angle ${angle}`).not.toBeNull();
    }
    const scribble: PagePoint[] = [];
    for (let i = 0; i <= 50; i += 1) {
      const a = (8 * Math.PI * i) / 50;
      scribble.push({ x: 2 * Math.cos(a) + i * 0.01, y: 2 * Math.sin(a) });
    }
    expect(freehandPath(scribble, 1)).not.toBeNull();
  });

  it('keeps the drawn preview still while the stroke grows, except near its tip', () => {
    const samples = wave(1, 0.8);
    const before = freehandPreview(samples.slice(0, 60), 1)!.points;
    const after = freehandPreview(samples.slice(0, 61), 1)!.points;
    // Points more than the smoothing reach (3 px, about 3 samples here) behind the tip stay put.
    expect(after.slice(0, 2 * 55)).toEqual(before.slice(0, 2 * 55));
  });

  it('makes nothing for a click or a stroke shorter than the minimum length', () => {
    expect(freehandPath([{ x: 5, y: 5 }], 1)).toBeNull();
    expect(
      freehandPath(
        [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
          { x: 6.5, y: 5.5 },
        ],
        1,
      ),
    ).toBeNull();
    expect(freehandPreview([{ x: 5, y: 5 }], 1)).toBeNull();
  });

  it('measures its tuning in CSS px: at zoom 4 the same page stroke keeps finer detail', () => {
    const near = freehandPath(wave(0.5, 0.3), 4)!;
    const far = freehandPath(wave(0.5, 0.3), 1)!;
    expect(near.verbs.length).toBeGreaterThanOrEqual(far.verbs.length);
  });

  it('puts every coordinate on the 2^-16 grid and ignores non-finite samples', () => {
    const samples = [...wave(3), { x: Number.NaN, y: 0 }];
    const data = freehandPath(samples, 1)!;
    for (const value of data.points) expect(gridSnap(value)).toBe(value);
    expect(data.points.every(Number.isFinite)).toBe(true);
  });

  it('fits a straight stroke with one cubic on the line', () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i * 2, y: i }));
    const curves = fitCubics(line, 1);
    expect(curves).toHaveLength(1);
  });

  it('previews the stroke as a smoothed polyline', () => {
    const data = freehandPreview(wave(4), 1)!;
    expect(data.verbs[0]).toBe('move');
    expect(data.verbs.slice(1).every((verb) => verb === 'line')).toBe(true);
    expect(data.points).toHaveLength(2 * data.verbs.length);
  });
});

describe('V-40 polygon geometry', () => {
  it('inscribes a triangle with its apex at the top centre and its base on the bottom edge', () => {
    const data = polygonPath({ x: 0, y: 0, width: 100, height: 80 }, 3)!;
    expect(data.verbs).toEqual(['move', 'line', 'line', 'close']);
    expect(data.points).toEqual([50, 0, 100, 80, 0, 80]);
  });

  it('fills the box: some vertex touches each side', () => {
    for (const sides of [3, 4, 5, 6, 7, 8, 12, 60]) {
      const frame = { x: 10, y: 20, width: 90, height: 70 };
      const data = polygonPath(frame, sides)!;
      const xs = data.points.filter((_, i) => i % 2 === 0);
      const ys = data.points.filter((_, i) => i % 2 === 1);
      expect(Math.min(...xs)).toBe(10);
      expect(Math.max(...xs)).toBe(100);
      expect(Math.min(...ys)).toBe(20);
      expect(Math.max(...ys)).toBe(90);
      expect(data.verbs).toHaveLength(sides + 1);
    }
  });

  it('is exactly mirror-symmetric about the vertical axis (no cos and sin noise)', () => {
    for (const sides of [5, 6, 7, 9]) {
      const data = polygonPath({ x: 0, y: 0, width: 120, height: 120 }, sides)!;
      for (let i = 1; i < sides; i += 1) {
        const j = sides - i;
        expect(data.points[2 * i]! + data.points[2 * j]!).toBe(120);
        expect(data.points[2 * i + 1]).toBe(data.points[2 * j + 1]);
      }
    }
  });

  it('refuses an empty box or a side count outside 3 to 60', () => {
    expect(polygonPath({ x: 0, y: 0, width: 0, height: 10 }, 5)).toBeNull();
    expect(polygonPath({ x: 0, y: 0, width: 10, height: 10 }, 2)).toBeNull();
    expect(polygonPath({ x: 0, y: 0, width: 10, height: 10 }, 61)).toBeNull();
    expect(polygonPath({ x: 0, y: 0, width: 10, height: 10 }, 4.5)).toBeNull();
  });
});

describe('V-40 pencil tool', () => {
  it('draws one selected open path as one undo step, named Pencil', () => {
    const target = editor('pencil');
    drag(target, wave(2));
    const node = paths(target)[0]!;
    expect(paths(target)).toHaveLength(1);
    expect(node.name).toBe('Pencil');
    expect(node.type === 'path' && node.path.verbs.at(-1)).toBe('cubic');
    expect(target.query({ type: 'selection' })).toEqual([node.id]);
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
    target.execute({ type: 'undo' });
    expect(paths(target)).toHaveLength(0);
  });

  it('shows the stroke live while dragging and replaces it with the fitted path on release', () => {
    const target = editor('pencil');
    const samples = wave(2);
    send(target, 'pointerdown', samples[0]!);
    for (const point of samples.slice(1, 40)) send(target, 'pointermove', point);
    const live = paths(target);
    expect(live).toHaveLength(1);
    expect(
      live[0]!.type === 'path' && live[0]!.path.verbs.slice(1).every((v) => v === 'line'),
    ).toBe(true);
    for (const point of samples.slice(40)) send(target, 'pointermove', point);
    send(target, 'pointerup', samples.at(-1)!);
    const done = paths(target)[0]!;
    expect(paths(target)).toHaveLength(1);
    expect(done.type === 'path' && done.path.verbs.slice(1).every((v) => v === 'cubic')).toBe(true);
  });

  it('closes a loop drawn back to its start', () => {
    const target = editor('pencil');
    drag(target, circle());
    const node = paths(target)[0]!;
    expect(node.type === 'path' && node.path.verbs.at(-1)).toBe('close');
  });

  it('makes nothing for a click', () => {
    const target = editor('pencil');
    drag(target, [{ x: 10, y: 10 }]);
    expect(paths(target)).toHaveLength(0);
    expect(target.query({ type: 'history' }).undoDepth).toBe(0);
  });

  it('cancels the stroke on Escape', () => {
    const target = editor('pencil');
    const samples = wave(2);
    send(target, 'pointerdown', samples[0]!);
    for (const point of samples.slice(1, 30)) send(target, 'pointermove', point);
    key(target, 'Escape');
    expect(paths(target)).toHaveLength(0);
    send(target, 'pointerup', samples[30]!);
    expect(paths(target)).toHaveLength(0);
    expect(target.query({ type: 'history' }).undoDepth).toBe(0);
  });

  it('uses the host stroke colour and hands over to select with returnToSelect', () => {
    const target = editor('pencil', {
      returnToSelect: true,
      drawStrokeColor: () => ({ r: 1, g: 1, b: 1, a: 1 }),
    });
    drag(target, wave(2));
    const node = paths(target)[0]!;
    expect(node.type === 'path' && node.stroke?.color).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(target.query({ type: 'tool' })).toBe('select');
  });

  it('is on Shift+P', () => {
    const target = createEditor({ ids: createCounterIdSource('n') });
    target.execute({
      type: 'input',
      event: { kind: 'keydown', key: 'P', repeat: false, composing: false, modifiers: shift },
    });
    expect(target.query({ type: 'tool' })).toBe('pencil');
  });
});

describe('V-40 drawing options', () => {
  function framed(tool: 'pencil' | 'polygon') {
    const target = editor(tool, { adoptIntoFrames: true });
    const frame = target.execute({
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 400, height: 400 },
    });
    if (!frame.ok) throw new Error(frame.code);
    return { target, frame: frame.ids[0]! };
  }

  it('creates the pencil path in the frame under the press with adoptIntoFrames', () => {
    const { target, frame } = framed('pencil');
    drag(
      target,
      wave(2).map((p) => ({ x: p.x + 50, y: p.y + 50 })),
    );
    expect(paths(target)[0]!.parent).toBe(frame);
  });

  it('creates the polygon in the frame under the press with adoptIntoFrames', () => {
    const { target, frame } = framed('polygon');
    drag(target, [
      { x: 50, y: 50 },
      { x: 150, y: 150 },
    ]);
    expect(paths(target)[0]!.parent).toBe(frame);
  });

  it('draws on the page when the press is outside every frame', () => {
    const { target } = framed('polygon');
    drag(target, [
      { x: 500, y: 500 },
      { x: 600, y: 600 },
    ]);
    expect(paths(target)[0]!.parent).toBe(target.getSnapshot().activePage);
  });

  it('shows no snap guide while Shift squares the polygon (review S4)', () => {
    const target = editor('polygon');
    target.execute({ type: 'createRectangle', frame: { x: 200, y: 0, width: 50, height: 50 } });
    target.execute({ type: 'setTool', tool: 'polygon' });
    send(target, 'pointerdown', { x: 0, y: 0 }, shift);
    send(target, 'pointermove', { x: 199, y: 49 }, shift);
    expect(target.query({ type: 'snap' })).toBeNull();
    send(target, 'pointerup', { x: 199, y: 49 }, shift);
  });
});

describe('V-40 Sides field model', () => {
  it('sends typed text on commit only when it differs from the count', () => {
    expect(polygonSidesCommit(null, 3)).toBeNull();
    expect(polygonSidesCommit('  ', 3)).toBeNull();
    expect(polygonSidesCommit('3', 3)).toBeNull();
    expect(polygonSidesCommit('20', 3)).toBe(20);
    // Out of range is sent, so the command refuses it and the refusal shows.
    expect(polygonSidesCommit('2', 3)).toBe(2);
  });

  it('steps by one with the arrow keys within 3 to 60', () => {
    expect(polygonSidesStep(3, 'ArrowUp')).toBe(4);
    expect(polygonSidesStep(3, 'ArrowDown')).toBeNull();
    expect(polygonSidesStep(60, 'ArrowUp')).toBeNull();
    expect(polygonSidesStep(10, 'ArrowDown')).toBe(9);
    expect(polygonSidesStep(10, 'Enter')).toBeNull();
  });
});

describe('V-40 polygon tool', () => {
  it('draws a selected triangle filling the drag box, one undo step, shape defaults', () => {
    const target = editor('polygon');
    drag(target, [
      { x: 10, y: 10 },
      { x: 60, y: 40 },
      { x: 110, y: 90 },
    ]);
    const node = paths(target)[0]!;
    expect(paths(target)).toHaveLength(1);
    expect(node.name).toBe('Polygon');
    expect(node.frame).toEqual({ x: 10, y: 10, width: 100, height: 80 });
    expect(node.type === 'path' && node.path.verbs).toEqual(['move', 'line', 'line', 'close']);
    expect(node.type === 'path' && node.fill).toEqual({ r: 0.8, g: 0.8, b: 0.8, a: 1 });
    expect(node.type === 'path' && node.stroke).toBeNull();
    expect(target.query({ type: 'selection' })).toEqual([node.id]);
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
  });

  it('draws with the session side count, which setPolygonSides sets within 3 to 60', () => {
    const target = editor('polygon');
    expect(target.getSnapshot().polygonSides).toBe(3);
    expect(target.execute({ type: 'setPolygonSides', sides: 6 }).ok).toBe(true);
    expect(target.getSnapshot().polygonSides).toBe(6);
    for (const sides of [2, 61, 4.5, Number.NaN]) {
      const result = target.execute({ type: 'setPolygonSides', sides });
      expect(result.ok ? null : result.code).toBe('editor.invalid-command');
    }
    expect(target.getSnapshot().polygonSides).toBe(6);
    drag(target, [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]);
    const node = paths(target)[0]!;
    expect(node.type === 'path' && node.path.verbs).toHaveLength(7);
  });

  it('steps the side count with ArrowUp and ArrowDown during the drag, and keeps it', () => {
    const target = editor('polygon');
    send(target, 'pointerdown', { x: 0, y: 0 });
    send(target, 'pointermove', { x: 100, y: 100 });
    key(target, 'ArrowUp');
    key(target, 'ArrowUp');
    const live = paths(target)[0]!;
    expect(live.type === 'path' && live.path.verbs).toHaveLength(6);
    key(target, 'ArrowDown');
    send(target, 'pointerup', { x: 100, y: 100 });
    const node = paths(target)[0]!;
    expect(node.type === 'path' && node.path.verbs).toHaveLength(5);
    expect(target.getSnapshot().polygonSides).toBe(4);
    // Without a drag the arrows are the keymap's: they nudge the selected polygon.
    key(target, 'ArrowDown');
    expect(target.getSnapshot().polygonSides).toBe(4);
    expect(paths(target)[0]!.frame.y).toBe(1);
  });

  it('squares the box with Shift', () => {
    const target = editor('polygon');
    drag(
      target,
      [
        { x: 0, y: 0 },
        { x: 100, y: 40 },
      ],
      shift,
    );
    expect(paths(target)[0]!.frame).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('makes nothing for a click and cancels on Escape', () => {
    const target = editor('polygon');
    drag(target, [{ x: 5, y: 5 }]);
    expect(paths(target)).toHaveLength(0);
    send(target, 'pointerdown', { x: 0, y: 0 });
    send(target, 'pointermove', { x: 50, y: 50 });
    expect(paths(target)).toHaveLength(1);
    key(target, 'Escape');
    expect(paths(target)).toHaveLength(0);
    expect(target.query({ type: 'history' }).undoDepth).toBe(0);
  });
});
