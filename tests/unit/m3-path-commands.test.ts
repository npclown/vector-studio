import {
  serializeDocument,
  type DocumentV2,
  type Frame,
  type PathNodeV2,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  createCounterIdSource,
  createEditor,
  type Command,
  type DocumentCommand,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type PagePoint,
} from '../../packages/editor-core/src/index.js';
// Source imports: the anchor model, the gesture API and the tree geometry are package-internal.
import { Draft } from '../../packages/editor-core/src/draft.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import {
  apply,
  localTransform,
  multiply,
  rotate,
} from '../../packages/editor-core/src/geometry.js';
import {
  handlesOf,
  inSegment,
  isMirrored,
  outSegment,
  readAnchorModel,
  renormalize,
  writeAnchorModel,
  type EditPoint,
} from '../../packages/editor-core/src/paths.js';
import { documentTree, spaceOf } from '../../packages/editor-core/src/tree.js';

// MVP M3-U1, M3-A01 to M3-A03 (M3 contract, sections 2 and 3): the anchor model (M3-P1), the
// serializer (M3-P2), re-normalization with value provenance (section 3.1), `movePathAnchors`
// and `setPathHandle`, the S1 relative rule and the section 3.5 failure order. Values are
// literal where the arithmetic is exact, otherwise the binary64 evaluation of the contract's
// formulas (M3-Q13).

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });
const s = (u: number, v: number): EditPoint => ({ kind: 'stored', u, v });

type Loose = Record<string, unknown> & { id: string };
type Verb = 'move' | 'line' | 'cubic' | 'close';

function base(id: string, parent: string, frame: Frame, rotation = 0) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible: true };
}

function rect(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
  };
}

function path(
  id: string,
  parent: string,
  frame: Frame,
  verbs: Verb[],
  points: number[],
  rotation = 0,
): Loose {
  return {
    ...base(id, parent, frame, rotation),
    type: 'path',
    path: { verbs, points, fillRule: 'nonzero' },
    fill: black,
    stroke: null,
  };
}

function container(
  type: 'group' | 'frame' | 'maskGroup',
  id: string,
  parent: string,
  children: string[],
  frame: Frame,
  rotation = 0,
): Loose {
  const node: Loose = { ...base(id, parent, frame, rotation), type, children };
  return type === 'frame' ? { ...node, fill: DEFAULT_FRAME_FILL, stroke: null } : node;
}

function doc(pages: [string, string[]][], nodes: Loose[]) {
  return {
    schemaVersion: 2,
    id: 'doc',
    pages: pages.map(([id, children]) => ({ id, name: id, children })),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

const SQUARE: [Verb[], number[]] = [
  ['move', 'line', 'line', 'line', 'line', 'close'],
  [0, 0, 1, 0.013, 1, 1, 0, 1, 0.5, 0.5],
];
const TRIANGLE: [Verb[], number[]] = [
  ['move', 'line', 'line', 'close'],
  [0, 0, 1, 0, 1, 1],
];

/**
 * Page p1: the A01 fixtures (`open`, the path-tool `closed` in the explicit form, the implicit
 * `tri`, the one-anchor `loop`, `dot` (`move, close`), `moves` (`move, move`), `multi`), the
 * provenance fixtures `sq` and `prov`, the zero-height `hline` and `hline3`, the rotated `rot`,
 * a path `np` in a rotated group in a rotated frame, a mask source `mp`, a path `cp` in a
 * clipping frame, a rectangle `r` and the far-off `big`; page p2: the path `op`.
 */
const FIXTURE = doc(
  [
    [
      'p1',
      [
        'open',
        'closed',
        'tri',
        'loop',
        'dot',
        'moves',
        'multi',
        'sq',
        'prov',
        'hline',
        'hline3',
        'vl',
        'rot',
        'fr',
        'mg',
        'clip',
        'r',
        'big',
      ],
    ],
    ['p2', ['op']],
  ],
  [
    path(
      'open',
      'p1',
      f(10, 20, 100, 50),
      ['move', 'line', 'cubic'],
      [0, 0, 0.5, 1, 0.75, 1, 1, 0.5, 1, 0],
    ),
    // Path-tool output: a closed path with an explicit closing segment back to anchor 0.
    path(
      'closed',
      'p1',
      f(200, 0, 100, 100),
      ['move', 'cubic', 'cubic', 'line', 'line', 'close'],
      [0, 0.5, 0, 0.5, 0.25, 0, 0.5, 0, 0.75, 0, 1, 0.5, 1, 0.5, 0.5, 1, 0, 0.5],
    ),
    path('tri', 'p1', f(0, 200, 100, 100), ...TRIANGLE),
    path('loop', 'p1', f(400, 0, 100, 100), ['move', 'cubic', 'close'], [0, 1, 0, 0, 1, 0, 0, 1]),
    path('dot', 'p1', f(5, 5, 0, 0), ['move', 'close'], [0, 0]),
    path('moves', 'p1', f(600, 0, 10, 10), ['move', 'move'], [0, 0, 1, 1]),
    path(
      'multi',
      'p1',
      f(0, 400, 100, 100),
      ['move', 'line', 'line', 'close', 'move', 'line', 'move', 'close'],
      [0, 0, 1, 0, 0, 1, 0.5, 0.5, 1, 1, 0.25, 0.75],
    ),
    path('sq', 'p1', f(10, 20, 100, 100), ...SQUARE),
    path(
      'prov',
      'p1',
      f(0, 0, 100, 100),
      ['move', 'line', 'line', 'line', 'close'],
      [0.014, 0, 0.007, 0.5, 1, 1, 0, 0.026],
    ),
    path('hline', 'p1', f(0, 500, 100, 0), ['move', 'line'], [0, 0, 1, 0]),
    path('hline3', 'p1', f(0, 520, 100, 0), ['move', 'line', 'line'], [0, 0, 0.5, 0, 1, 0]),
    path('vl', 'p1', f(0, 600, 100, 40), ['move', 'line'], [0, 0, 1, 1]),
    path('rot', 'p1', f(300, 300, 100, 50), ...SQUARE, 0.3),
    container('frame', 'fr', 'p1', ['g'], f(100, 700, 300, 200), -0.4),
    container('group', 'g', 'fr', ['np', 'gr'], f(20, 30, 200, 150), 0.5),
    path('np', 'g', f(10, 10, 80, 60), ...SQUARE, 0.2),
    rect('gr', 'g', f(120, 90, 30, 30)),
    container('maskGroup', 'mg', 'p1', ['mp', 'mr'], f(600, 600, 100, 100)),
    path('mp', 'mg', f(0, 0, 100, 100), ...TRIANGLE),
    rect('mr', 'mg', f(10, 10, 20, 20)),
    container('frame', 'clip', 'p1', ['cp'], f(800, 0, 100, 100)),
    path('cp', 'clip', f(10, 10, 50, 50), ...TRIANGLE),
    rect('r', 'p1', f(0, 900, 10, 10)),
    path('big', 'p1', f(1.7e308, 0, 100, 100), ...TRIANGLE),
    path('op', 'p2', f(0, 0, 10, 10), ...TRIANGLE),
  ],
);

function editor(document: unknown = FIXTURE): Editor {
  return createEditor({ ids: createCounterIdSource('n'), document });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const documentOf = (target: Editor) => target.query({ type: 'document' });
const pathOf = (target: Editor, id: string) => target.query({ type: 'node', id }) as PathNodeV2;
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const stored = (document: DocumentV2, id: string) => document.nodes[id] as PathNodeV2;

function move(id: string, anchors: [number, number][], dx: number, dy: number): DocumentCommand {
  return {
    type: 'movePathAnchors',
    id,
    anchors: anchors.map(([subpath, anchor]) => ({ subpath, anchor })),
    dx,
    dy,
  };
}

function handle(
  id: string,
  [subpath, anchor]: [number, number],
  side: 'in' | 'out',
  to: PagePoint | null,
  mirror?: boolean,
): DocumentCommand {
  return {
    type: 'setPathHandle',
    id,
    anchor: { subpath, anchor },
    side,
    to,
    ...(mirror === undefined ? {} : { mirror }),
  };
}

/** The page point of a node-local point: `apply(C, x, y)` with the node's chain `C`. */
function pagePoint(document: DocumentV2, id: string, x: number, y: number): PagePoint {
  const node = document.nodes[id]!;
  const space = spaceOf(documentTree(document), node.parent);
  return apply(multiply(space.matrix, localTransform(node.frame, node.rotation)), x, y);
}

/** Every stored point of a path node on the page, in point order. */
function pagePoints(document: DocumentV2, id: string): PagePoint[] {
  const node = stored(document, id);
  const { width, height } = node.frame;
  const out: PagePoint[] = [];
  for (let i = 0; i < node.path.points.length; i += 2) {
    out.push(
      pagePoint(document, id, node.path.points[i]! * width, node.path.points[i + 1]! * height),
    );
  }
  return out;
}

/** The M1-A05 bound: within `1e-9·max(1, |coordinate|)` page units. */
function expectNear(actual: PagePoint, expected: PagePoint, label: string) {
  for (const axis of ['x', 'y'] as const) {
    const bound = 1e-9 * Math.max(1, Math.abs(expected[axis]));
    expect(Math.abs(actual[axis] - expected[axis]), `${label}.${axis}`).toBeLessThanOrEqual(bound);
  }
}

/**
 * Section 3.1, box changed, in the test's own terms: every node-local point `L` becomes
 * `(L − min) / w′`; the frame is `(w′, h′)` about the node's own axes.
 */
function refitBox(node: PathNodeV2, local: readonly PagePoint[]) {
  const xs = local.map((p) => p.x);
  const ys = local.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX;
  const h = Math.max(...ys) - minY;
  const points = local.flatMap((p) => [
    w === 0 ? 0 : (p.x - minX) / w,
    h === 0 ? 0 : (p.y - minY) / h,
  ]);
  let origin: PagePoint;
  if (node.rotation === 0) origin = at(node.frame.x + minX, node.frame.y + minY);
  else {
    const c = apply(localTransform(node.frame, node.rotation), minX + w / 2, minY + h / 2);
    origin = at(c.x - w / 2, c.y - h / 2);
  }
  return { frame: f(origin.x, origin.y, w, h), points };
}

/** A path node's node-local points `(u·W, v·H)`. */
function localPoints(node: PathNodeV2): PagePoint[] {
  const out: PagePoint[] = [];
  for (let i = 0; i < node.path.points.length; i += 2) {
    out.push(
      at(node.path.points[i]! * node.frame.width, node.path.points[i + 1]! * node.frame.height),
    );
  }
  return out;
}

/** The document with `node` set and the M1 group refit, as text. */
function refitText(document: DocumentV2, node: PathNodeV2): string {
  const draft = new Draft(document);
  draft.set(node);
  const result = draft.finish(() => null);
  if ('ok' in result) throw new Error(result.code);
  return serializeDocument(result);
}

describe('M3-A01 anchor model and serializer', () => {
  const nodes = FIXTURE.nodes as unknown as Record<string, PathNodeV2>;
  const model = (id: string) => readAnchorModel(nodes[id]!.path);

  it('reads an open subpath: anchors, segments and handles', () => {
    const [sub] = model('open');
    expect(model('open')).toHaveLength(1);
    expect(sub).toEqual({
      closed: false,
      explicit: false,
      anchors: [s(0, 0), s(0.5, 1), s(1, 0)],
      segments: [{ kind: 'line' }, { kind: 'cubic', c1: s(0.75, 1), c2: s(1, 0.5) }],
    });
    expect([0, 1, 2].map((a) => [inSegment(sub!, a), outSegment(sub!, a)])).toEqual([
      [null, 0],
      [0, 1],
      [1, null],
    ]);
    expect(handlesOf(sub!, 0)).toEqual({ in: null, out: null });
    expect(handlesOf(sub!, 1)).toEqual({ in: null, out: s(0.75, 1) });
    expect(handlesOf(sub!, 2)).toEqual({ in: s(1, 0.5), out: null });
  });

  it('reads the explicit closing form (path-tool output) with n = m anchors', () => {
    const [sub] = model('closed');
    expect(sub).toEqual({
      closed: true,
      explicit: true,
      anchors: [s(0, 0.5), s(0.5, 0), s(1, 0.5), s(0.5, 1)],
      segments: [
        { kind: 'cubic', c1: s(0, 0.5), c2: s(0.25, 0) },
        { kind: 'cubic', c1: s(0.75, 0), c2: s(1, 0.5) },
        { kind: 'line' },
        { kind: 'line' },
      ],
    });
    // Segment 3 is the closing segment, from anchor 3 back to anchor 0.
    expect(inSegment(sub!, 0)).toBe(3);
    expect(outSegment(sub!, 3)).toBe(3);
    expect(handlesOf(sub!, 0)).toEqual({ in: null, out: s(0, 0.5) });
    expect(handlesOf(sub!, 1)).toEqual({ in: s(0.25, 0), out: s(0.75, 0) });
    expect(handlesOf(sub!, 2)).toEqual({ in: s(1, 0.5), out: null });
  });

  it('reads the implicit form with a virtual closing line', () => {
    const [sub] = model('tri');
    expect(sub).toEqual({
      closed: true,
      explicit: false,
      anchors: [s(0, 0), s(1, 0), s(1, 1)],
      segments: [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }],
    });
    expect(inSegment(sub!, 0)).toBe(2);
    expect(outSegment(sub!, 2)).toBe(2);
  });

  it('reads a one-anchor loop, move-close, move-move and several subpaths', () => {
    const [loop] = model('loop');
    expect(loop).toEqual({
      closed: true,
      explicit: true,
      anchors: [s(0, 1)],
      segments: [{ kind: 'cubic', c1: s(0, 0), c2: s(1, 0) }],
    });
    // Both sides of the one anchor are on its loop segment.
    expect([inSegment(loop!, 0), outSegment(loop!, 0)]).toEqual([0, 0]);
    expect(handlesOf(loop!, 0)).toEqual({ in: s(1, 0), out: s(0, 0) });
    const [dot] = model('dot');
    expect(dot).toEqual({ closed: true, explicit: false, anchors: [s(0, 0)], segments: [] });
    expect([inSegment(dot!, 0), outSegment(dot!, 0)]).toEqual([null, null]);
    expect(model('moves')).toEqual([
      { closed: false, explicit: false, anchors: [s(0, 0)], segments: [] },
      { closed: false, explicit: false, anchors: [s(1, 1)], segments: [] },
    ]);
    expect(model('multi')).toEqual([
      {
        closed: true,
        explicit: false,
        anchors: [s(0, 0), s(1, 0), s(0, 1)],
        segments: [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }],
      },
      {
        closed: false,
        explicit: false,
        anchors: [s(0.5, 0.5), s(1, 1)],
        segments: [{ kind: 'line' }],
      },
      { closed: true, explicit: false, anchors: [s(0.25, 0.75)], segments: [] },
    ]);
  });

  it('applies the mirrored test with its tolerance, per axis, in node-local units', () => {
    // The path-tool anchor of `closed`: in (25, 0), out (75, 0) about (50, 0) in a 100 box.
    const [sub] = model('closed');
    const { in: i, out: o } = handlesOf(sub!, 1);
    const local = (p: EditPoint) => (p.kind === 'stored' ? at(p.u * 100, p.v * 100) : p);
    expect(isMirrored(local(sub!.anchors[1]!), local(i!), local(o!))).toBe(true);
    // |in + out − 2·A| against 1e-9·max(1, |in|, |out|, |A|).
    expect(isMirrored(at(0, 0), at(-1, 0), at(1 + 0.9e-9, 0))).toBe(true);
    expect(isMirrored(at(0, 0), at(-1, 0), at(1 + 1.1e-9, 0))).toBe(false);
    expect(isMirrored(at(0, 0), at(0, -1), at(0, 1 + 1.1e-9))).toBe(false);
    // The tolerance scales with the largest magnitude.
    expect(isMirrored(at(1e6, 0), at(1e6 - 1, 0), at(1e6 + 1 + 0.9e-3, 0))).toBe(true);
    expect(isMirrored(at(1e6, 0), at(1e6 - 1, 0), at(1e6 + 1 + 1.1e-3, 0))).toBe(false);
    expect(isMirrored(at(50, 0), at(25, 0), at(75, 1))).toBe(false);
  });

  it('writes every unedited fixture back byte-identically (M3-P2, box unchanged)', () => {
    for (const id of ['open', 'closed', 'tri', 'loop', 'dot', 'moves', 'multi', 'sq', 'rot']) {
      const node = nodes[id]!;
      const { verbs, points } = writeAnchorModel(readAnchorModel(node.path));
      expect(verbs, id).toEqual(node.path.verbs);
      const { frame, unit } = renormalize(points, node.frame, node.rotation);
      expect(frame, id).toBe(node.frame);
      expect(unit, id).toEqual(node.path.points);
    }
  });

  it('reads an implicit subpath whose last anchor lands on anchor 0 as the explicit form', () => {
    const target = editor();
    // tri anchor 2 (100, 100) moves onto anchor 0 (0, 0); the box loses its height.
    ok(target, move('tri', [[0, 2]], -100, -100));
    const node = pathOf(target, 'tri');
    expect(node.path).toEqual({
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 1, 0, 0, 0],
      fillRule: 'nonzero',
    });
    expect(node.frame).toEqual(f(0, 200, 100, 0));
    expect(readAnchorModel(node.path)).toEqual([
      {
        closed: true,
        explicit: true,
        anchors: [s(0, 0), s(1, 0)],
        segments: [{ kind: 'line' }, { kind: 'line' }],
      },
    ]);
  });
});

describe('M3-A02 re-normalization', () => {
  it('box unchanged: the frame and every unwritten coordinate are kept bit for bit', () => {
    const target = editor();
    const before = stored(documentOf(target), 'sq');
    ok(target, move('sq', [[0, 4]], 2, -3));
    const node = pathOf(target, 'sq');
    expect(node.frame).toEqual(before.frame);
    // 0.013 is not (0.013·100)/100 in binary64, so it was copied, not recomputed.
    expect((0.013 * 100) / 100).not.toBe(0.013);
    expect(node.path.points).toEqual([0, 0, 1, 0.013, 1, 1, 0, 1, 0.52, 0.47]);
    expect(node.path.points[4 * 2]).toBe((0.5 * 100 + 2) / 100);
  });

  it('a growing box gives the formula frame and points', () => {
    const target = editor();
    ok(target, move('sq', [[0, 2]], 50, 100));
    const node = pathOf(target, 'sq');
    expect(node.frame).toEqual(f(10, 20, 150, 200));
    expect(node.path.points).toEqual([
      0,
      0,
      100 / 150,
      (0.013 * 100) / 200,
      1,
      1,
      0,
      100 / 200,
      50 / 150,
      50 / 200,
    ]);
  });

  it('a shrinking box gives the formula frame and points, on either side', () => {
    const target = editor();
    ok(target, move('tri', [[0, 2]], -50, -50));
    expect(pathOf(target, 'tri').frame).toEqual(f(0, 200, 100, 50));
    expect(pathOf(target, 'tri').path.points).toEqual([0, 0, 1, 0, 0.5, 1]);
    ok(target, { type: 'undo' });
    ok(target, move('tri', [[0, 0]], 25, 0));
    expect(pathOf(target, 'tri').frame).toEqual(f(25, 200, 75, 100));
    expect(pathOf(target, 'tri').path.points).toEqual([0, 0, 1, 0, 1, 1]);
  });

  it('zero-size axes: unit coordinate 0, in both directions', () => {
    const target = editor();
    // Box unchanged on a zero-height path: x is L / W, y is 0.
    ok(target, move('hline3', [[0, 1]], 10, 0));
    expect(pathOf(target, 'hline3').path.points).toEqual([0, 0, 0.6, 0, 1, 0]);
    expect(pathOf(target, 'hline3').frame).toEqual(f(0, 520, 100, 0));
    // A zero-height path grows wider, then gains height.
    ok(target, move('hline', [[0, 1]], 50, 0));
    expect(pathOf(target, 'hline').frame).toEqual(f(0, 500, 150, 0));
    expect(pathOf(target, 'hline').path.points).toEqual([0, 0, 1, 0]);
    ok(target, move('hline', [[0, 1]], 0, 30));
    expect(pathOf(target, 'hline').frame).toEqual(f(0, 500, 150, 30));
    expect(pathOf(target, 'hline').path.points).toEqual([0, 0, 1, 1]);
    // A path with height loses it.
    ok(target, move('vl', [[0, 1]], 0, -40));
    expect(pathOf(target, 'vl').frame).toEqual(f(0, 600, 100, 0));
    expect(pathOf(target, 'vl').path.points).toEqual([0, 0, 1, 0]);
  });

  it('θ = 0.3: the formula frame, and unmoved points keep their page placement', () => {
    const target = editor();
    const before = documentOf(target);
    const node = stored(before, 'rot');
    const pages = pagePoints(before, 'rot');
    ok(target, move('rot', [[0, 2]], 30, 10));
    const after = documentOf(target);
    const local = localPoints(node);
    const d = rotate(-0.3, 30, 10);
    local[2] = at(local[2]!.x + d.x, local[2]!.y + d.y);
    const expected = refitBox(node, local);
    expect(stored(after, 'rot').frame).toEqual(expected.frame);
    expect(stored(after, 'rot').path.points).toEqual(expected.points);
    expect(stored(after, 'rot').rotation).toBe(0.3);
    const moved = pagePoints(after, 'rot');
    pages.forEach((p, i) => {
      if (i === 2) expectNear(moved[i]!, at(p.x + 30, p.y + 10), 'moved');
      else expectNear(moved[i]!, p, `point ${i}`);
    });
  });

  it('a path in a rotated group in a rotated frame: placement kept, the group refits', () => {
    const target = editor();
    const before = documentOf(target);
    const pages = pagePoints(before, 'np');
    const gr = pagePoint(before, 'gr', 0, 0);
    ok(target, move('np', [[0, 1]], 40, -25));
    const after = documentOf(target);
    const node = stored(before, 'np');
    const local = localPoints(node);
    const d = rotate(-(-0.4 + 0.5 + 0.2), 40, -25);
    local[1] = at(local[1]!.x + d.x, local[1]!.y + d.y);
    const expected = refitBox(node, local);
    // The group refit moves `np` within it; its size and points are the formula's.
    expect(stored(after, 'np').path.points).toEqual(expected.points);
    expect(stored(after, 'np').frame.width).toBe(expected.frame.width);
    expect(stored(after, 'np').frame.height).toBe(expected.frame.height);
    expect(after.nodes.g!.frame).not.toEqual(before.nodes.g!.frame);
    expect(after.nodes.fr).toBe(before.nodes.fr);
    expect(text(target)).toBe(
      refitText(before, {
        ...node,
        frame: expected.frame,
        path: { ...node.path, points: expected.points },
      }),
    );
    const moved = pagePoints(after, 'np');
    pages.forEach((p, i) => {
      if (i === 1) expectNear(moved[i]!, at(p.x + 40, p.y - 25), 'moved');
      else expectNear(moved[i]!, p, `point ${i}`);
    });
    expectNear(pagePoint(after, 'gr', 0, 0), gr, 'sibling');
  });

  it('the group refits at a gesture commit, as the command does', () => {
    const direct = editor();
    ok(direct, move('np', [[0, 1]], 40, -25));
    const target = editor();
    const before = documentOf(target);
    const { gesture } = internalsOf(target);
    expect(gesture.begin()).toBe(true);
    expect(gesture.replace([move('np', [[0, 1]], 10, 10)]).ok).toBe(true);
    expect(gesture.replace([move('np', [[0, 1]], 40, -25)]).ok).toBe(true);
    // No refit during the gesture: the group keeps its frame.
    expect(documentOf(target).nodes.g).toBe(before.nodes.g);
    expect(pathOf(target, 'np').path.points).toEqual(pathOf(direct, 'np').path.points);
    gesture.commit();
    expect(text(target)).toBe(text(direct));
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(serializeDocument(before));
  });

  it('a mask source refits its mask group; a path in a frame leaves the frame', () => {
    const target = editor();
    const before = documentOf(target);
    ok(target, move('mp', [[0, 2]], 50, 50));
    const after = documentOf(target);
    expect(stored(after, 'mp').path.points).toEqual([0, 0, 100 / 150, 0, 1, 1]);
    expect(after.nodes.mg!.frame).toEqual(f(600, 600, 150, 150));
    expect(text(target)).toBe(refitText(before, stored(after, 'mp')));
    ok(target, move('cp', [[0, 2]], 100, 100));
    expect(stored(documentOf(target), 'cp').frame).toEqual(f(10, 10, 150, 150));
    expect(documentOf(target).nodes.clip).toBe(before.nodes.clip);
  });

  it('turns negative zero into 0', () => {
    const target = editor();
    // tri sits at x = 0, so the page point x = −0 maps to the local −0 − 0 = −0.
    ok(target, handle('tri', [0, 0], 'out', at(-0, 250)));
    const points = pathOf(target, 'tri').path.points;
    expect(points).toEqual([0, 0, 0, 0.5, 1, 0, 1, 0, 1, 1]);
    expect(Object.is(points[2], 0)).toBe(true);
    const { unit, frame } = renormalize(
      [{ kind: 'local', x: -0, y: -0 }, s(1, 1)],
      f(0, 0, 10, 10),
      0,
    );
    expect(unit.every((value) => !Object.is(value, -0))).toBe(true);
    expect(frame).toEqual(f(0, 0, 10, 10));
  });
});

describe('M3-A03 movePathAnchors and setPathHandle', () => {
  it('handles follow their anchor', () => {
    const target = editor();
    ok(target, move('closed', [[0, 1]], 5, 0));
    expect(pathOf(target, 'closed').path.points).toEqual([
      0, 0.5, 0, 0.5, 0.3, 0, 0.55, 0, 0.8, 0, 1, 0.5, 1, 0.5, 0.5, 1, 0, 0.5,
    ]);
    expect(pathOf(target, 'closed').frame).toEqual(f(200, 0, 100, 100));
  });

  it('moves both stored copies of anchor 0 in the explicit form', () => {
    const target = editor();
    ok(target, move('closed', [[0, 0]], 0, 10));
    expect(pathOf(target, 'closed').path).toEqual({
      verbs: ['move', 'cubic', 'cubic', 'line', 'line', 'close'],
      points: [0, 0.6, 0, 0.6, 0.25, 0, 0.5, 0, 0.75, 0, 1, 0.5, 1, 0.5, 0.5, 1, 0, 0.6],
      fillRule: 'nonzero',
    });
    // The one-anchor loop moves its anchor and both controls.
    ok(target, move('loop', [[0, 0]], 0, -50));
    expect(pathOf(target, 'loop').frame).toEqual(f(400, -50, 100, 100));
    expect(pathOf(target, 'loop').path.points).toEqual([0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it('moves anchors of several subpaths in one step, any listed order', () => {
    const a = editor();
    const b = editor();
    ok(
      a,
      move(
        'multi',
        [
          [1, 0],
          [0, 1],
        ],
        0,
        -50,
      ),
    );
    ok(
      b,
      move(
        'multi',
        [
          [0, 1],
          [1, 0],
        ],
        0,
        -50,
      ),
    );
    expect(text(a)).toBe(text(b));
    // Anchor (0, 1) reaches y = −50, so the box grows upward.
    expect(pathOf(a, 'multi').frame).toEqual(f(0, 350, 100, 150));
    expect(pathOf(a, 'multi').path.points).toEqual([
      0,
      50 / 150,
      1,
      0,
      0,
      1,
      0.5,
      50 / 150,
      1,
      1,
      0.25,
      125 / 150,
    ]);
    expect(undoDepth(a)).toBe(1);
  });

  it('a new handle turns a line into a cubic; the other control copies its anchor', () => {
    const target = editor();
    ok(target, handle('tri', [0, 1], 'out', at(50, 250)));
    expect(pathOf(target, 'tri').path).toEqual({
      verbs: ['move', 'line', 'cubic', 'close'],
      points: [0, 0, 1, 0, 0.5, 0.5, 1, 1, 1, 1],
      fillRule: 'nonzero',
    });
  });

  it('mirror sets the opposite control to 2·A − T, on a cubic and on a line', () => {
    const target = editor();
    ok(target, handle('closed', [0, 1], 'out', at(270, 0), true));
    expect(pathOf(target, 'closed').path.points).toEqual([
      0, 0.5, 0, 0.5, 0.3, 0, 0.5, 0, 0.7, 0, 1, 0.5, 1, 0.5, 0.5, 1, 0, 0.5,
    ]);
    // Without `mirror` only the own side moves.
    ok(target, handle('closed', [0, 1], 'in', at(210, 0)));
    expect(pathOf(target, 'closed').path.points.slice(2, 6)).toEqual([0, 0.5, 0.1, 0]);
    expect(pathOf(target, 'closed').path.points[8]).toBe(0.7);
    // On sq's last anchor both sides are lines; the implicit closing line becomes an explicit
    // cubic.
    ok(target, handle('sq', [0, 4], 'out', at(70, 60), true));
    expect(pathOf(target, 'sq').path).toEqual({
      verbs: ['move', 'line', 'line', 'line', 'cubic', 'cubic', 'close'],
      points: [0, 0, 1, 0.013, 1, 1, 0, 1, 0, 1, 0.4, 0.6, 0.5, 0.5, 0.6, 0.4, 0, 0, 0, 0],
      fillRule: 'nonzero',
    });
    expect(readAnchorModel(pathOf(target, 'sq').path)[0]!.explicit).toBe(true);
  });

  it('retraction back to a line, the explicit form kept', () => {
    const target = editor();
    ok(target, handle('sq', [0, 4], 'out', at(70, 60), true));
    ok(target, handle('sq', [0, 4], 'out', null, true));
    expect(pathOf(target, 'sq').path).toEqual({
      verbs: ['move', 'line', 'line', 'line', 'line', 'line', 'close'],
      points: [0, 0, 1, 0.013, 1, 1, 0, 1, 0.5, 0.5, 0, 0],
      fillRule: 'nonzero',
    });
    // A retracted side whose other control is off its anchor stays a cubic, its control A.
    ok(target, { type: 'undo' });
    ok(target, handle('sq', [0, 0], 'in', at(20, 30)));
    ok(target, handle('sq', [0, 4], 'out', null));
    expect(pathOf(target, 'sq').path.verbs).toEqual([
      'move',
      'line',
      'line',
      'line',
      'cubic',
      'cubic',
      'close',
    ]);
    expect(pathOf(target, 'sq').path.points.slice(14, 18)).toEqual([0.5, 0.5, 0.1, 0.1]);
    // The one-anchor loop retracts both sides of its loop segment.
    ok(target, handle('loop', [0, 0], 'in', null, true));
    expect(pathOf(target, 'loop').path).toEqual({
      verbs: ['move', 'line', 'close'],
      points: [0, 0, 0, 0],
      fillRule: 'nonzero',
    });
    expect(pathOf(target, 'loop').frame).toEqual(f(400, 100, 0, 0));
  });

  it('keeps copied values bit for bit (value provenance)', () => {
    const target = editor();
    ok(target, handle('prov', [0, 1], 'out', at(1, 40), true));
    const points = pathOf(target, 'prov').path.points;
    expect(pathOf(target, 'prov').path.verbs).toEqual(['move', 'cubic', 'cubic', 'line', 'close']);
    expect(points).toEqual([
      0.014,
      0,
      // The new control on the line's far side copies anchor 0; the mirrored one is computed.
      0.014,
      0,
      (2 * (0.007 * 100) - 1) / 100,
      (2 * (0.5 * 100) - 40) / 100,
      0.007,
      0.5,
      1 / 100,
      40 / 100,
      1,
      1,
      1,
      1,
      0,
      0.026,
    ]);
    // Recomputing would have changed them.
    for (const value of [0.014, 0.007, 0.026]) expect((value * 100) / 100).not.toBe(value);
    // Box changed: copies stay equal to their source.
    ok(target, move('prov', [[0, 2]], 10, 10));
    const grown = pathOf(target, 'prov').path.points;
    expect(grown[2]).toBe(grown[0]);
    expect(grown[3]).toBe(grown[1]);
  });

  it('is one undo step with byte-identical undo and redo', () => {
    const target = editor();
    const before = text(target);
    ok(target, handle('np', [0, 2], 'out', at(250, 820), true));
    const after = text(target);
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(after);
  });

  it('a result equal to the stored node records no step and no event', () => {
    const target = editor();
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    const before = documentOf(target);
    for (const command of [
      handle('tri', [0, 1], 'in', null, true),
      move(
        'tri',
        [
          [0, 0],
          [0, 2],
        ],
        0,
        0,
      ),
      handle('closed', [0, 2], 'in', at(300, 50)),
    ]) {
      expect(target.execute(command), command.type).toEqual({ ok: true, ids: [] });
    }
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
    expect(events).toEqual([]);
  });

  it('path commands are rejected in a gesture update and run through replace', () => {
    const target = editor();
    const { gesture } = internalsOf(target);
    const before = documentOf(target);
    expect(gesture.begin()).toBe(true);
    for (const command of [move('tri', [[0, 0]], 1, 0), handle('tri', [0, 0], 'out', at(1, 1))]) {
      expect(gesture.update(command)).toEqual({
        ok: false,
        code: 'editor.invalid-command',
        path: '/type',
      });
    }
    expect(documentOf(target)).toBe(before);
    // Two replaces do not compound.
    expect(gesture.replace([move('tri', [[0, 1]], -50, 0)]).ok).toBe(true);
    expect(gesture.replace([move('tri', [[0, 1]], -50, 0)]).ok).toBe(true);
    expect(pathOf(target, 'tri').path.points).toEqual([0, 0, 0.5, 0, 1, 1]);
    gesture.commit();
    expect(undoDepth(target)).toBe(1);
  });

  it('fails in the section 3.5 order and changes nothing', () => {
    const target = editor();
    const before = text(target);
    const ref = (subpath: unknown, anchor: unknown) => ({ subpath, anchor });
    const cases: [Record<string, unknown>, CommandResult][] = [
      // editor.invalid-command: shape first, before any node check.
      [
        { type: 'movePathAnchors', id: 7, anchors: [ref(0, 0)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-command', path: '/id' },
      ],
      [
        { type: 'movePathAnchors', id: 'nope', anchors: [], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-command', path: '/anchors' },
      ],
      [
        { type: 'movePathAnchors', id: 'tri', anchors: 'all', dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-command', path: '/anchors' },
      ],
      [
        { type: 'movePathAnchors', id: 'tri', anchors: [ref(0, 0), 5], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-command', path: '/anchors/1' },
      ],
      [
        { type: 'movePathAnchors', id: 'tri', anchors: [ref(0, NaN)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-command', path: '/anchors/0/anchor' },
      ],
      [
        { type: 'movePathAnchors', id: 'tri', anchors: [ref('0', 0)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-command', path: '/anchors/0/subpath' },
      ],
      [
        { type: 'movePathAnchors', id: 'r', anchors: [ref(0, 1), ref(0, 1)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-command', path: '/anchors' },
      ],
      [
        { type: 'movePathAnchors', id: 'nope', anchors: [ref(9, 9)], dx: Infinity, dy: 0 },
        { ok: false, code: 'editor.invalid-command', path: '/dx' },
      ],
      [
        { type: 'movePathAnchors', id: 'tri', anchors: [ref(0, 0)], dx: 1, dy: '0' },
        { ok: false, code: 'editor.invalid-command', path: '/dy' },
      ],
      // editor.unknown-node: no such node, or a node of another page.
      [
        { type: 'movePathAnchors', id: 'nope', anchors: [ref(9, 9)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.unknown-node' },
      ],
      [
        { type: 'movePathAnchors', id: 'op', anchors: [ref(0, 0)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.unknown-node' },
      ],
      // editor.not-a-path before editor.invalid-path-ref.
      [
        { type: 'movePathAnchors', id: 'r', anchors: [ref(9, 9)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.not-a-path' },
      ],
      [
        { type: 'movePathAnchors', id: 'g', anchors: [ref(0, 0)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.not-a-path' },
      ],
      // editor.invalid-path-ref: the first bad ref in list order wins.
      [
        {
          type: 'movePathAnchors',
          id: 'multi',
          anchors: [ref(0, 2), ref(1, 2), ref(3, 0)],
          dx: 1,
          dy: 0,
        },
        { ok: false, code: 'editor.invalid-path-ref', path: '/anchors/1' },
      ],
      [
        { type: 'movePathAnchors', id: 'multi', anchors: [ref(0.5, 0)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-path-ref', path: '/anchors/0' },
      ],
      [
        { type: 'movePathAnchors', id: 'multi', anchors: [ref(-1, 0)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-path-ref', path: '/anchors/0' },
      ],
      // The explicit form has one anchor fewer than its stored points.
      [
        { type: 'movePathAnchors', id: 'closed', anchors: [ref(0, 4)], dx: 1, dy: 0 },
        { ok: false, code: 'editor.invalid-path-ref', path: '/anchors/0' },
      ],
      // setPathHandle: shape, node, then `/anchor` before `/side`.
      [
        { type: 'setPathHandle', id: 'tri', anchor: 3, side: 'in', to: null },
        { ok: false, code: 'editor.invalid-command', path: '/anchor' },
      ],
      [
        { type: 'setPathHandle', id: 'tri', anchor: ref(9, 9), side: 'up', to: null },
        { ok: false, code: 'editor.invalid-command', path: '/side' },
      ],
      [
        { type: 'setPathHandle', id: 'tri', anchor: ref(0, 0), side: 'in', to: { x: NaN, y: 0 } },
        { ok: false, code: 'editor.invalid-command', path: '/to' },
      ],
      [
        { type: 'setPathHandle', id: 'tri', anchor: ref(0, 0), side: 'in' },
        { ok: false, code: 'editor.invalid-command', path: '/to' },
      ],
      [
        { type: 'setPathHandle', id: 'tri', anchor: ref(0, 0), side: 'in', to: null, mirror: 1 },
        { ok: false, code: 'editor.invalid-command', path: '/mirror' },
      ],
      [
        { type: 'setPathHandle', id: 'r', anchor: ref(9, 9), side: 'in', to: null },
        { ok: false, code: 'editor.not-a-path' },
      ],
      [
        { type: 'setPathHandle', id: 'open', anchor: ref(0, 9), side: 'in', to: null },
        { ok: false, code: 'editor.invalid-path-ref', path: '/anchor' },
      ],
      [
        { type: 'setPathHandle', id: 'open', anchor: ref(0, 0), side: 'in', to: null },
        { ok: false, code: 'editor.invalid-path-ref', path: '/side' },
      ],
      [
        { type: 'setPathHandle', id: 'open', anchor: ref(0, 2), side: 'out', to: at(0, 0) },
        { ok: false, code: 'editor.invalid-path-ref', path: '/side' },
      ],
      [
        { type: 'setPathHandle', id: 'dot', anchor: ref(0, 0), side: 'out', to: at(0, 0) },
        { ok: false, code: 'editor.invalid-path-ref', path: '/side' },
      ],
      [
        { type: 'setPathHandle', id: 'moves', anchor: ref(1, 0), side: 'in', to: at(0, 0) },
        { ok: false, code: 'editor.invalid-path-ref', path: '/side' },
      ],
      // Last, the model's rules on the re-validated node.
      [
        {
          type: 'movePathAnchors',
          id: 'big',
          anchors: [ref(0, 0), ref(0, 1), ref(0, 2)],
          dx: 1e308,
          dy: 0,
        },
        { ok: false, code: 'document.invalid-field', path: '/nodes/big/frame/x' },
      ],
    ];
    for (const [command, expected] of cases) {
      expect(target.execute(command as unknown as Command), JSON.stringify(command)).toEqual(
        expected,
      );
    }
    expect(text(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });

  it('accepts the new codes from extension results', () => {
    const target = createEditor({
      ids: createCounterIdSource('n'),
      document: FIXTURE,
      extensions: [
        {
          id: 'x',
          commands: [
            { id: 'x.a', run: () => ({ ok: false, code: 'editor.not-a-path' }) },
            {
              id: 'x.b',
              run: () => ({ ok: false, code: 'editor.invalid-path-ref', path: '/anchors/0' }),
            },
          ],
        },
      ],
    });
    expect(target.execute({ type: 'runCommand', id: 'x.a' })).toEqual({
      ok: false,
      code: 'editor.not-a-path',
    });
    expect(target.execute({ type: 'runCommand', id: 'x.b' })).toEqual({
      ok: false,
      code: 'editor.invalid-path-ref',
      path: '/anchors/0',
    });
  });
});
