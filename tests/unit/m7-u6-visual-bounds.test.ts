import {
  serializeDocument,
  validateDocument,
  type DocumentV6,
  type NodeV6,
  type Stroke,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  type Command,
  type Editor,
  type IdSource,
} from '../../packages/editor-core/src/index.js';
import { rotatedBounds } from '../../packages/editor-core/src/geometry.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { visualBounds } from '../../packages/editor-core/src/visual-bounds.js';

// M7 contract, section 5.1 (M7-U6 hands-on check, 2026-10-30, 추천안 자동 채택): a `createSymbol`
// wrap takes the nodes' visual bounds (strokes, caps, joins and arrowheads included) as the new
// source's frame, so its clip keeps them painted; the children keep their page placement. A
// conversion in place and `groupNodes` keep their frames.

const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const noCustom = () => null;

function stroke(
  width: number,
  cap: Stroke['cap'] = 'butt',
  join: Stroke['join'] = 'miter',
  miterLimit = 4,
): Stroke {
  return { color: WHITE, width, cap, join, miterLimit, dash: null };
}

/** A rectangle or ellipse stroke at v6 (M4-M1's keys for `{ color, width }`). */
const shapeStroke = (width: number) =>
  ({ color: BLACK, width, cap: 'butt', join: 'round', miterLimit: 4, dash: null }) as const;

function editor(): Editor {
  let count = 0;
  const ids: IdSource = () => `n${++count}`;
  return createEditor({
    document: {
      schemaVersion: 4,
      id: 'doc',
      pages: [{ id: 'p', name: 'P', children: [] }],
      nodes: {},
    },
    ids,
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  const text = serializeDocument(target.query({ type: 'document' }));
  expect(validateDocument(JSON.parse(text)).ok).toBe(true);
  return result.ids;
}

const documentOf = (target: Editor): DocumentV6 => target.query({ type: 'document' });

/** Wraps `ids` in a symbol and returns the document and the symbol's ID. */
function wrap(target: Editor, ids: readonly string[]) {
  const [symbol] = ok(target, { type: 'createSymbol', ids });
  return { document: documentOf(target), symbol: symbol! };
}

/** A child's frame in page space (the symbol is at the page root, rotation 0). */
function pageFrame(document: DocumentV6, id: string) {
  const node = document.nodes[id]!;
  const parent = document.nodes[node.parent]!;
  return { ...node.frame, x: parent.frame.x + node.frame.x, y: parent.frame.y + node.frame.y };
}

describe('createSymbol wraps by visual bounds (M7 section 5.1)', () => {
  it('gives a horizontal line of stroke 8 a symbol 8 high that keeps it painted', () => {
    // The hands-on case: a line (300, 220) to (420, 220), white, 8 wide, butt caps.
    const target = editor();
    const [line] = ok(target, {
      type: 'createLine',
      start: { x: 300, y: 220 },
      end: { x: 420, y: 220 },
      stroke: stroke(8),
    });
    const before = documentOf(target).nodes[line!]!;
    const { document, symbol } = wrap(target, [line!]);
    expect(document.nodes[symbol]!.frame).toEqual({ x: 300, y: 216, width: 120, height: 8 });
    // The line keeps its page placement, 4 below the symbol's top.
    expect(document.nodes[line!]!.frame).toEqual({ x: 0, y: 4, width: 120, height: 0 });
    expect(pageFrame(document, line!)).toEqual(before.frame);
    // Its stroke, 4 each side of y = 4, lies inside the symbol's content clip {0, 0, 120, 8},
    // which the line is projected under.
    const projection = projectPage(document, 'p', noCustom);
    const content = projection.nodes.get(`${symbol}\u0000content`);
    expect(content).toMatchObject({ clip: { kind: 'rect', x: 0, y: 0, width: 120, height: 8 } });
    expect(projection.nodes.get(line!)).toMatchObject({ parentId: content!.id, visible: true });
  });

  it('grows a line by its caps: round and square ends reach w/2 beyond the end', () => {
    for (const cap of ['round', 'square'] as const) {
      const target = editor();
      const [line] = ok(target, {
        type: 'createLine',
        start: { x: 300, y: 220 },
        end: { x: 420, y: 220 },
        stroke: stroke(8, cap),
      });
      const { document, symbol } = wrap(target, [line!]);
      expect(document.nodes[symbol]!.frame).toEqual({ x: 296, y: 216, width: 128, height: 8 });
      expect(document.nodes[line!]!.frame).toEqual({ x: 4, y: 4, width: 120, height: 0 });
    }
  });

  it('includes arrowheads: a triangle head exactly, a line head by the path rule', () => {
    const target = editor();
    const [triangle] = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      stroke: stroke(2),
      endArrow: 'triangle',
    });
    // Base corners at x = 100 − 8, y = ±4; the tip at the end.
    expect(visualBounds(documentOf(target), documentOf(target).nodes[triangle!]!)).toEqual({
      x: 0,
      y: -4,
      width: 100,
      height: 8,
    });
    const [open] = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      stroke: stroke(2),
      startArrow: 'line',
    });
    // Stroke mode (no triangle): the polyline's points (the ends and the head's corners at
    // x = 8, y = 50 ± 4) grow by w/2 · 4 (miter join, limit 4).
    expect(visualBounds(documentOf(target), documentOf(target).nodes[open!]!)).toEqual({
      x: -4,
      y: 42,
      width: 108,
      height: 16,
    });
    const { document, symbol } = wrap(target, [triangle!, open!]);
    expect(document.nodes[symbol]!.frame).toEqual({ x: -4, y: -4, width: 108, height: 62 });
  });

  it('covers the miter at a line head tip and the diagonal square caps of its corners', () => {
    const target = editor();
    const [miter] = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      stroke: stroke(2, 'butt', 'miter', 4),
      endArrow: 'line',
    });
    // The head's half angle is atan(2w / 4w), so the miter tip lies (w/2) / sin(atan(0.5)) past
    // the tip: 102.236 for w = 2.
    const tip = 100 + 1 / Math.sin(Math.atan(0.5));
    const bounds = visualBounds(documentOf(target), documentOf(target).nodes[miter!]!);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(tip);
    expect(bounds).toEqual({ x: -4, y: -8, width: 108, height: 16 });

    const [diagonal] = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 0 },
      end: { x: 100, y: 100 },
      stroke: stroke(2, 'square', 'bevel'),
      endArrow: 'line',
    });
    // A square cap on a corner of the turned head reaches (w/2)·√2 past it; the bound grows the
    // points by 1.5 · w/2.
    const turned = visualBounds(documentOf(target), documentOf(target).nodes[diagonal!]!);
    expect(turned.x + turned.width).toBeGreaterThanOrEqual(100 + Math.SQRT2);
    expect(turned.y + turned.height).toBeGreaterThanOrEqual(100 + Math.SQRT2);
    expect(turned).toEqual({ x: -1.5, y: -1.5, width: 103, height: 103 });
  });

  it('grows a stroked custom node by the path rule, its geometry assumed inside its frame', () => {
    const star = {
      id: 's',
      name: 's',
      parent: 'p',
      frame: { x: 0, y: 0, width: 100, height: 100 },
      rotation: 0,
      constraints: { horizontal: 'start', vertical: 'start' },
      opacity: 1,
      visible: true,
      type: 'custom',
      customType: 'ext.star',
      data: { points: 5, innerRatio: 0.5 },
      fill: null,
      stroke: stroke(10, 'butt', 'miter', 4),
    } as unknown as NodeV6;
    const document = { nodes: { s: star } } as unknown as DocumentV6;
    // 10 / 2 · 4 = 20 on every side.
    expect(visualBounds(document, star)).toEqual({ x: -20, y: -20, width: 140, height: 140 });
    expect(visualBounds(document, { ...star, stroke: null } as NodeV6)).toEqual(star.frame);
  });

  it('grows a stroked rectangle by half its stroke and leaves an unstroked one as is', () => {
    const target = editor();
    const [stroked] = ok(target, {
      type: 'createRectangle',
      frame: { x: 10, y: 10, width: 40, height: 20 },
      stroke: shapeStroke(4),
    });
    const { document, symbol } = wrap(target, [stroked!]);
    expect(document.nodes[symbol]!.frame).toEqual({ x: 8, y: 8, width: 44, height: 24 });
    expect(document.nodes[stroked!]!.frame).toEqual({ x: 2, y: 2, width: 40, height: 20 });

    const plain = editor();
    const [rectangle] = ok(plain, {
      type: 'createRectangle',
      frame: { x: 10, y: 10, width: 40, height: 20 },
      stroke: null,
    });
    const wrapped = wrap(plain, [rectangle!]);
    expect(wrapped.document.nodes[wrapped.symbol]!.frame).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 20,
    });
  });

  it('grows a path by w/2 times its miter limit, as the renderer bounds it', () => {
    const target = editor();
    const [path] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 40, 0, 20, 30],
      stroke: stroke(2, 'butt', 'miter', 4),
    });
    expect(visualBounds(documentOf(target), documentOf(target).nodes[path!]!)).toEqual({
      x: -4,
      y: -4,
      width: 48,
      height: 38,
    });
  });

  it('unions mixed nodes, rotated ones by their turned box, and contains the geometric bounds', () => {
    const target = editor();
    const [stroked] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 20, height: 20 },
      stroke: shapeStroke(2),
    });
    const [ellipse] = ok(target, {
      type: 'createEllipse',
      frame: { x: 40, y: 0, width: 20, height: 10 },
      stroke: null,
    });
    const [turned] = ok(target, {
      type: 'createRectangle',
      frame: { x: 80, y: 0, width: 20, height: 20 },
      rotation: Math.PI / 4,
      stroke: shapeStroke(2),
    });
    const [line] = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 60 },
      end: { x: 100, y: 60 },
      stroke: stroke(6),
    });
    const document = documentOf(target);
    const ids = [stroked!, ellipse!, turned!, line!];
    for (const id of ids) {
      const node = document.nodes[id]!;
      const visual = visualBounds(document, node);
      const geometric = rotatedBounds(node);
      expect(visual.x).toBeLessThanOrEqual(geometric.x);
      expect(visual.y).toBeLessThanOrEqual(geometric.y);
      expect(visual.x + visual.width).toBeGreaterThanOrEqual(geometric.x + geometric.width);
      expect(visual.y + visual.height).toBeGreaterThanOrEqual(geometric.y + geometric.height);
    }
    // The 45° square of side 22 (with its stroke) spans 11·√2 each side of its centre (90, 10).
    const half = 11 * Math.SQRT2;
    const { document: wrapped, symbol } = wrap(target, ids);
    const frame = wrapped.nodes[symbol]!.frame;
    expect(frame.x).toBe(-1);
    expect(frame.y).toBeCloseTo(10 - half, 12);
    expect(frame.x + frame.width).toBeCloseTo(90 + half, 12);
    expect(frame.y + frame.height).toBe(63);
    for (const id of ids) expect(pageFrame(wrapped, id)).toEqual(document.nodes[id]!.frame);
  });

  it('bounds a group by its children, and groupNodes still keeps geometric bounds', () => {
    const target = editor();
    const [a] = ok(target, {
      type: 'createLine',
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      stroke: stroke(8),
    });
    const [b] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 20, width: 100, height: 20 },
      stroke: null,
    });
    const [group] = ok(target, { type: 'groupNodes', ids: [a!, b!], kind: 'group' });
    // The group's own frame stays geometric: the line's axis to the rectangle's bottom.
    expect(documentOf(target).nodes[group!]!.frame).toEqual({ x: 0, y: 0, width: 100, height: 40 });
    const { document, symbol } = wrap(target, [group!]);
    expect(document.nodes[symbol]!.frame).toEqual({ x: 0, y: -4, width: 100, height: 44 });
    expect(document.nodes[group!]!.frame).toEqual({ x: 0, y: 4, width: 100, height: 40 });
  });

  it('converts one frame in place, keeping its frame', () => {
    const target = editor();
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 10, y: 10, width: 50, height: 50 },
    });
    const before = documentOf(target).nodes[frame!]!.frame;
    const { document, symbol } = wrap(target, [frame!]);
    expect(symbol).toBe(frame);
    expect(document.nodes[frame!]).toMatchObject({ type: 'symbol', frame: before });
  });
});
