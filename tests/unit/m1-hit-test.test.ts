import type { Frame } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';
// Source imports: the hit-test functions are package-internal.
import {
  boundsOf,
  deepestHit,
  marqueeHits,
  selectionTarget,
} from '../../packages/editor-core/src/hit-test.js';

// MVP M1-U4, M1-A10 (M1 contract, section 6): hit testing and selection targets through
// rotation, nested groups, top-level and nested frames, frame clips and mask groups.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
/** The default path stroke in its v2 form, without the v6 `dash` (M4 contract, section 2.1). */
const V2_PATH_STROKE = { color: black, width: 1, cap: 'butt', join: 'miter', miterLimit: 4 };
const white = { r: 1, g: 1, b: 1, a: 1 };
const none = { shift: false, alt: false, meta: false, ctrl: false };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

type Loose = Record<string, unknown> & { id: string };

function base(id: string, parent: string, frame: Frame, rotation = 0) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible: true };
}

function rect(id: string, parent: string, frame: Frame, extra: object = {}): Loose {
  return {
    ...base(id, parent, frame),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
    ...extra,
  };
}

function ellipse(id: string, parent: string, frame: Frame, extra: object = {}): Loose {
  return { ...base(id, parent, frame), type: 'ellipse', fill: black, stroke: null, ...extra };
}

function line(id: string, parent: string, frame: Frame, extra: object = {}): Loose {
  return {
    ...base(id, parent, frame),
    type: 'line',
    points: [0, 0, 1, 1],
    stroke: V2_PATH_STROKE,
    startArrow: 'none',
    endArrow: 'none',
    ...extra,
  };
}

function path(id: string, parent: string, frame: Frame, points: number[], extra: object = {}) {
  const verbs = ['move', ...Array.from({ length: points.length / 2 - 1 }, () => 'line'), 'close'];
  return {
    ...base(id, parent, frame),
    type: 'path',
    path: { verbs, points, fillRule: 'nonzero' },
    fill: black,
    stroke: null,
    ...extra,
  } as Loose;
}

function container(
  type: 'group' | 'maskGroup' | 'frame',
  id: string,
  parent: string,
  children: string[],
  frame: Frame,
  extra: object = {},
): Loose {
  const node: Loose = { ...base(id, parent, frame), type, children };
  return type === 'frame'
    ? { ...node, fill: white, stroke: null, ...extra }
    : { ...node, ...extra };
}

function doc(pages: [string, string[]][], nodes: Loose[]) {
  return {
    schemaVersion: 2,
    id: 'doc',
    pages: pages.map(([id, children]) => ({ id, name: id, children })),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

function editor(document: unknown, zoom = 10): Editor {
  const target = createEditor({ ids: createCounterIdSource('n'), document });
  ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom } });
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

/** The selection after a click at (x, y) from an empty selection. */
function clickAt(target: Editor, x: number, y: number): readonly string[] {
  ok(target, { type: 'setSelection', ids: [] });
  pointer(target, 'pointerdown', x, y);
  pointer(target, 'pointerup', x, y);
  return target.query({ type: 'selection' });
}

function deepest(target: Editor, x: number, y: number): string | null {
  const zoom = target.query({ type: 'viewport' }).zoom;
  return deepestHit(
    target.query({ type: 'document' }),
    target.query({ type: 'activePage' }),
    { x, y },
    zoom,
    () => null,
  );
}

describe('M1-A10 leaf geometry in local space', () => {
  it('hits a rotated rectangle inside its rotated frame only', () => {
    // 100 × 20 turned by π/2 about (50, 10): it covers x 40..60, y -40..60.
    const target = editor(
      doc([['p', ['r']]], [{ ...rect('r', 'p', f(0, 0, 100, 20)), rotation: Math.PI / 2 }]),
    );
    expect(clickAt(target, 50, 50)).toEqual(['r']);
    expect(clickAt(target, 50, -35)).toEqual(['r']);
    // Inside the unrotated frame, outside the rotated one.
    expect(clickAt(target, 90, 10)).toEqual([]);
  });

  it('hits a rectangle with the clamped corner radii of section 5', () => {
    // Radii 80 and 80 on a 100-wide top edge clamp to 50 each.
    const target = editor(
      doc([['p', ['r']]], [rect('r', 'p', f(0, 0, 100, 100), { cornerRadii: [80, 80, 0, 0] })]),
    );
    expect(clickAt(target, 5, 5)).toEqual([]);
    // Outside an unclamped radius-80 corner, inside the clamped radius-50 one.
    expect(clickAt(target, 12, 25)).toEqual(['r']);
    expect(clickAt(target, 50, 95)).toEqual(['r']);
    // Unfilled: near the rounded outline only.
    const outline = editor(
      doc(
        [['p', ['r']]],
        [
          rect('r', 'p', f(0, 0, 100, 100), {
            cornerRadii: [50, 0, 0, 0],
            fill: null,
            stroke: { color: black, width: 1 },
          }),
        ],
      ),
    );
    expect(clickAt(outline, 50, 50)).toEqual([]);
    const onArc = 50 - 50 * Math.SQRT1_2;
    expect(clickAt(outline, onArc + 0.2, onArc + 0.2)).toEqual(['r']);
    // The unrounded corner point is far from the arc.
    expect(clickAt(outline, 0.2, 0.2)).toEqual([]);
  });

  it('hits a filled ellipse inside, and an unfilled one near its flattened outline', () => {
    const filled = editor(doc([['p', ['e']]], [ellipse('e', 'p', f(0, 0, 100, 50))]));
    expect(clickAt(filled, 50, 25)).toEqual(['e']);
    expect(clickAt(filled, 99, 25)).toEqual(['e']);
    // Inside the frame's corner, outside the ellipse.
    expect(clickAt(filled, 4, 4)).toEqual([]);
    const open = editor(
      doc(
        [['p', ['e']]],
        [ellipse('e', 'p', f(0, 0, 100, 50), { fill: null, stroke: { color: black, width: 1 } })],
      ),
    );
    expect(clickAt(open, 50, 25)).toEqual([]);
    expect(clickAt(open, 50, 0.3)).toEqual(['e']);
    expect(clickAt(open, 100.3, 25)).toEqual(['e']);
    expect(clickAt(open, 50, 1)).toEqual([]);
  });

  it('hits a line near its segment and arrowheads, and inside a triangle head', () => {
    // From (0, 0) to (100, 0), stroke width 4: radius max(2, 4 / 10). The head at (100, 0)
    // has its base centre at (84, 0) and base corners (84, ±8).
    const stroke = { ...V2_PATH_STROKE, width: 4 };
    const make = (extra: object) =>
      editor(
        doc(
          [['p', ['l']]],
          [line('l', 'p', f(0, 0, 100, 0), { points: [0, 0, 1, 0], stroke, ...extra })],
        ),
      );
    const plain = make({});
    expect(clickAt(plain, 50, 1.9)).toEqual(['l']);
    expect(clickAt(plain, 50, 2.1)).toEqual([]);
    expect(clickAt(plain, 102, 0)).toEqual(['l']);
    expect(clickAt(plain, 87.5, 3)).toEqual([]);
    // A line head: near its two strokes from the base corners to the tip.
    const lined = make({ endArrow: 'line' });
    expect(clickAt(lined, 92, 4)).toEqual(['l']);
    expect(clickAt(lined, 87.5, 3)).toEqual([]);
    // A triangle head is hit inside it, too.
    const filled = make({ endArrow: 'triangle' });
    expect(clickAt(filled, 87.5, 3)).toEqual(['l']);
    expect(clickAt(filled, 84, -7.9)).toEqual(['l']);
    expect(clickAt(filled, 80, 7)).toEqual([]);
    // The start head points the other way: tip (0, 0), base corners (16, ±8).
    const start = make({ startArrow: 'triangle' });
    expect(clickAt(start, 12.5, 3)).toEqual(['l']);
    expect(clickAt(start, 87.5, 3)).toEqual([]);
    // No stroke: no arrowheads, and the P5 radius 4 / zoom.
    const bare = make({ endArrow: 'triangle', stroke: null });
    expect(clickAt(bare, 87.5, 3)).toEqual([]);
    expect(clickAt(bare, 50, 0.3)).toEqual(['l']);
  });

  it('hits a line in either mode at the same places, through rotation', () => {
    const stroke = { ...V2_PATH_STROKE, width: 2 };
    for (const endArrow of ['line', 'triangle']) {
      // A diagonal (0, 0) to (100, 100) turned by π/2 about (50, 50): it runs (100, 0) to (0, 100).
      const target = editor(
        doc(
          [['p', ['l']]],
          [{ ...line('l', 'p', f(0, 0, 100, 100), { stroke, endArrow }), rotation: Math.PI / 2 }],
        ),
      );
      expect(clickAt(target, 50, 50)).toEqual(['l']);
      expect(clickAt(target, 75, 25)).toEqual(['l']);
      expect(clickAt(target, 25, 25)).toEqual([]);
    }
  });
});

/**
 * Page `p`: a top-level frame F (0, 0, 200, 200) holding a group H with b, a rectangle c that
 * leaves F's rect, a nested frame N with d and a rectangle e across F's left edge; a rotated
 * group G1 holding a group G2 holding a; a mask group M; a group K holding a frame N2.
 */
function scene(frameExtra: object = {}) {
  return doc(
    [
      ['p', ['G1', 'F', 'M', 'K', 'r']],
      ['q', ['other']],
    ],
    [
      container('frame', 'F', 'p', ['H', 'c', 'N', 'e'], f(0, 0, 200, 200), frameExtra),
      container('group', 'H', 'F', ['b'], f(10, 10, 20, 20)),
      rect('b', 'H', f(0, 0, 20, 20)),
      rect('c', 'F', f(150, 150, 100, 100)),
      container('frame', 'N', 'F', ['d'], f(50, 100, 50, 50)),
      rect('d', 'N', f(0, 0, 10, 10)),
      rect('e', 'F', f(-10, 90, 20, 20)),
      { ...container('group', 'G1', 'p', ['G2'], f(100, 300, 100, 100)), rotation: Math.PI / 2 },
      container('group', 'G2', 'G1', ['a'], f(0, 0, 50, 50)),
      rect('a', 'G2', f(0, 0, 50, 50)),
      // The source is the triangle (0, 0), (100, 0), (0, 100); m covers the right half.
      container('maskGroup', 'M', 'p', ['src', 'm'], f(300, 0, 100, 100)),
      path('src', 'M', f(0, 0, 100, 100), [0, 0, 1, 0, 0, 1]),
      rect('m', 'M', f(50, 0, 50, 100)),
      container('group', 'K', 'p', ['N2'], f(500, 0, 50, 50)),
      container('frame', 'N2', 'K', ['k'], f(0, 0, 50, 50)),
      rect('k', 'N2', f(0, 0, 10, 10)),
      rect('r', 'p', f(0, 600, 10, 10)),
      rect('other', 'q', f(0, 0, 10, 10)),
    ],
  );
}

describe('M1-A10 selection targets', () => {
  it('targets the outermost ancestor below the page through rotated nested groups', () => {
    const target = editor(scene());
    // a's local (25, 25) in G1 maps to (175, 325): G1 turns by π/2 about (150, 350).
    expect(deepest(target, 175, 325)).toBe('a');
    expect(clickAt(target, 175, 325)).toEqual(['G1']);
    // Inside G1's frame, outside every child.
    expect(clickAt(target, 125, 325)).toEqual([]);
    expect(selectionTarget(target.query({ type: 'document' }), 'a')).toBe('G1');
  });

  it('a top-level frame is a scope: a hit inside it targets the frame child', () => {
    const target = editor(scene());
    expect(clickAt(target, 20, 20)).toEqual(['H']);
    expect(clickAt(target, 175, 175)).toEqual(['c']);
    // Nested frame: its child and its background target the nested frame.
    expect(deepest(target, 55, 105)).toBe('d');
    expect(clickAt(target, 55, 105)).toEqual(['N']);
    expect(clickAt(target, 75, 125)).toEqual(['N']);
    // The frame's own background targets the frame.
    expect(clickAt(target, 100, 50)).toEqual(['F']);
    // A frame below a group is no scope.
    expect(clickAt(target, 505, 5)).toEqual(['K']);
    expect(clickAt(target, 540, 40)).toEqual(['K']);
  });

  it('a frame is hit on its background when filled and near its border when stroked', () => {
    const stroked = editor(scene({ fill: null, stroke: { color: black, width: 1 } }));
    expect(clickAt(stroked, 100, 50)).toEqual([]);
    expect(clickAt(stroked, 100, 0.3)).toEqual(['F']);
    expect(clickAt(stroked, 200.3, 100)).toEqual(['F']);
    // The border paints above the children: e crosses the left edge.
    expect(clickAt(stroked, 0, 100)).toEqual(['F']);
    expect(clickAt(stroked, 5, 100)).toEqual(['e']);
    // Neither filled nor stroked: the frame itself is never hit.
    const bare = editor(scene({ fill: null }));
    expect(clickAt(bare, 100, 50)).toEqual([]);
    expect(clickAt(bare, 20, 20)).toEqual(['H']);
  });

  it('clips leaves to every frame ancestor', () => {
    const target = editor(scene());
    // c leaves F's rect at x, y = 200.
    expect(clickAt(target, 199, 199)).toEqual(['c']);
    expect(clickAt(target, 225, 225)).toEqual([]);
    // e is hit inside F only.
    expect(clickAt(target, 5, 95)).toEqual(['e']);
    expect(clickAt(target, -5, 95)).toEqual([]);
    // A child of N leaving N's rect is clipped by N, and N by F.
    const nested = editor(
      doc(
        [['p', ['F']]],
        [
          container('frame', 'F', 'p', ['N'], f(0, 0, 100, 100)),
          container('frame', 'N', 'F', ['x'], f(50, 50, 100, 100), { fill: null }),
          rect('x', 'N', f(-20, -20, 200, 200)),
        ],
      ),
    );
    expect(deepest(nested, 60, 60)).toBe('x');
    expect(deepest(nested, 40, 60)).toBe('F');
    expect(deepest(nested, 110, 60)).toBe(null);
  });

  it('a mask group clips its children to the source fill region; the source is never hit', () => {
    const target = editor(scene());
    // m at (350..400, 0..100); the source covers x + y ≤ 100 in M's space.
    expect(deepest(target, 360, 10)).toBe('m');
    expect(clickAt(target, 360, 10)).toEqual(['M']);
    expect(clickAt(target, 390, 50)).toEqual([]);
    // Inside the source, where only the source is: nothing.
    expect(clickAt(target, 310, 10)).toEqual([]);
    // The source's fill and visibility do not matter.
    ok(target, { type: 'setNodeProps', id: 'src', props: { fill: null, visible: false } });
    expect(deepest(target, 360, 10)).toBe('m');
    expect(deepest(target, 390, 50)).toBe(null);
  });

  it('applies the source fill rule', () => {
    // Two nested squares under evenodd: the inner square is a hole in the mask.
    const square = [0, 0, 1, 0, 1, 1, 0, 1];
    const target = editor(
      doc(
        [['p', ['M']]],
        [
          container('maskGroup', 'M', 'p', ['src', 'm'], f(0, 0, 100, 100)),
          {
            ...path('src', 'M', f(0, 0, 100, 100), square),
            path: {
              verbs: [
                'move',
                'line',
                'line',
                'line',
                'close',
                'move',
                'line',
                'line',
                'line',
                'close',
              ],
              points: [...square, 0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75],
              fillRule: 'evenodd',
            },
          },
          rect('m', 'M', f(0, 0, 100, 100)),
        ],
      ),
    );
    expect(deepest(target, 10, 10)).toBe('m');
    expect(deepest(target, 50, 50)).toBe(null);
  });

  it('clips to a rotated frame in its own space', () => {
    // F turns by π/4 about (50, 50); x covers all of F's rect.
    const target = editor(
      doc(
        [['p', ['F']]],
        [
          { ...container('frame', 'F', 'p', ['x'], f(0, 0, 100, 100)), rotation: Math.PI / 4 },
          rect('x', 'F', f(-100, -100, 300, 300)),
        ],
      ),
    );
    expect(deepest(target, 50, 50)).toBe('x');
    // (2, 2) is F-local (-17.9, 50): outside the rect, inside its page bounds.
    expect(deepest(target, 2, 2)).toBe(null);
    // (50, -15) is F-local (4.0, 4.0): above F's page-aligned top edge, inside the clip.
    expect(deepest(target, 50, -15)).toBe('x');
  });

  it('masks by a source inside a rotated mask group', () => {
    // M turns by π/2 about (50, 50); its source covers M-local x 0..50.
    const target = editor(
      doc(
        [['p', ['F']]],
        [
          // Unfilled, so a miss inside the mask does not land on F's background.
          container('frame', 'F', 'p', ['M'], f(0, 0, 100, 100), { fill: null }),
          {
            ...container('maskGroup', 'M', 'F', ['src', 'm'], f(0, 0, 100, 100)),
            rotation: Math.PI / 2,
          },
          path('src', 'M', f(0, 0, 50, 100), [0, 0, 1, 0, 1, 1, 0, 1]),
          rect('m', 'M', f(-50, -50, 200, 200)),
        ],
      ),
    );
    // (50, 25) is M-local (25, 50), inside the source; (50, 75) is M-local (75, 50).
    expect(deepest(target, 50, 25)).toBe('m');
    expect(deepest(target, 50, 75)).toBe(null);
    expect(clickAt(target, 50, 25)).toEqual(['M']);
  });

  it('hits a line and its triangle head inside a rotated group', () => {
    // G turns by π about (50, 5): L runs page (100, 5) to (0, 5) with its tip at (0, 5), base
    // centre (20, 5) and base corners (20, -5) and (20, 15); radius max(5 / 2, 4 / 10).
    const stroke = { ...V2_PATH_STROKE, width: 5 };
    const target = editor(
      doc(
        [['p', ['G']]],
        [
          { ...container('group', 'G', 'p', ['L'], f(0, 0, 100, 10)), rotation: Math.PI },
          line('L', 'G', f(0, 5, 100, 0), { points: [0, 0, 1, 0], stroke, endArrow: 'triangle' }),
        ],
      ),
    );
    // 1.8 from the head's edge (20, 15) to (0, 5), outside the triangle.
    expect(deepest(target, 10, 12)).toBe('L');
    expect(deepest(target, 50, 5)).toBe('L');
    expect(deepest(target, 10, 18)).toBe(null);
    expect(clickAt(target, 10, 12)).toEqual(['G']);
  });

  it('a node is hittable only if it and every ancestor are visible', () => {
    const target = editor(scene());
    ok(target, { type: 'setNodeProps', id: 'G2', props: { visible: false } });
    expect(clickAt(target, 175, 325)).toEqual([]);
    ok(target, { type: 'setNodeProps', id: 'G2', props: { visible: true } });
    ok(target, { type: 'setNodeProps', id: 'F', props: { visible: false } });
    expect(clickAt(target, 20, 20)).toEqual([]);
    expect(clickAt(target, 100, 50)).toEqual([]);
  });

  it('works on the active page only', () => {
    const target = editor(scene());
    expect(clickAt(target, 5, 605)).toEqual(['r']);
    ok(target, { type: 'setActivePage', id: 'q' });
    expect(clickAt(target, 5, 5)).toEqual(['other']);
    expect(clickAt(target, 20, 20)).not.toEqual(['H']);
  });
});

describe('M1-A10 marquee, press on a frame, selection and bounds', () => {
  const marquee = (target: Editor, from: [number, number], to: [number, number]) => {
    ok(target, { type: 'setSelection', ids: [] });
    pointer(target, 'pointerdown', ...from);
    pointer(target, 'pointermove', ...to);
    pointer(target, 'pointerup', ...to);
    return target.query({ type: 'selection' });
  };

  it('selects a top-level frame only when it contains its bounds; its children are no candidates', () => {
    const target = editor(scene());
    expect(marquee(target, [-10, -10], [50, 50])).toEqual([]);
    expect(marquee(target, [-10, -10], [210, 210])).toEqual(['F']);
    // Other candidates intersect; a nested node is never a candidate itself.
    expect(marquee(target, [-5, 590], [5, 595])).toEqual([]);
    expect(marquee(target, [-5, 590], [5, 601])).toEqual(['r']);
    expect(marquee(target, [170, 320], [180, 330])).toEqual(['G1']);
    expect(marquee(target, [355, -5], [365, 5])).toEqual(['M']);
  });

  it('uses the page bounds of rotated frames', () => {
    const turned = doc(
      [['p', ['r', 'F']]],
      [
        { ...rect('r', 'p', f(0, 0, 100, 20)), rotation: Math.PI / 2 },
        { ...container('frame', 'F', 'p', [], f(200, 0, 100, 20)), rotation: Math.PI / 2 },
      ],
    );
    const value = editor(turned).query({ type: 'document' });
    // r covers x 40..60, y -40..60; F covers x 240..260, y -40..60.
    expect(marqueeHits(value, 'p', f(0, -45, 39, 10))).toEqual([]);
    expect(marqueeHits(value, 'p', f(55, -45, 10, 10))).toEqual(['r']);
    expect(marqueeHits(value, 'p', f(239, -39, 22, 98))).toEqual([]);
    expect(marqueeHits(value, 'p', f(239, -41, 22, 102))).toEqual(['F']);
    const box = boundsOf(value, ['F'])!;
    expect(box.x).toBeCloseTo(240, 12);
    expect(box.y).toBeCloseTo(-40, 12);
    expect(box.width).toBeCloseTo(20, 12);
    expect(box.height).toBeCloseTo(100, 12);
  });

  it('press-and-drag on a top-level frame background moves the frame', () => {
    const target = editor(scene());
    const before = target.query({ type: 'node', id: 'b' });
    pointer(target, 'pointerdown', 100, 50);
    pointer(target, 'pointermove', 110, 65);
    pointer(target, 'pointerup', 110, 65);
    expect(target.query({ type: 'selection' })).toEqual(['F']);
    expect(target.query({ type: 'node', id: 'F' })?.frame).toEqual(f(10, 15, 200, 200));
    expect(target.query({ type: 'node', id: 'b' })).toBe(before);
  });

  it('a press on a selected node below its target drags that node; a click selects the target', () => {
    const target = editor(scene());
    ok(target, { type: 'setSelection', ids: ['b'] });
    pointer(target, 'pointerdown', 20, 20);
    pointer(target, 'pointermove', 25, 20);
    pointer(target, 'pointerup', 25, 20);
    expect(target.query({ type: 'selection' })).toEqual(['b']);
    // H refits around the moved b at commit; b's page placement moved by (5, 0).
    expect(boundsOf(target.query({ type: 'document' }), ['b'])).toEqual(f(15, 10, 20, 20));
    pointer(target, 'pointerdown', 20, 20);
    pointer(target, 'pointerup', 20, 20);
    expect(target.query({ type: 'selection' })).toEqual(['H']);
  });

  it('setSelection takes nodes at any depth of the active page, normalized to ancestors', () => {
    const target = editor(scene());
    ok(target, { type: 'setSelection', ids: ['a', 'd'] });
    expect(target.query({ type: 'selection' })).toEqual(['a', 'd']);
    ok(target, { type: 'setSelection', ids: ['a', 'G1'] });
    expect(target.query({ type: 'selection' })).toEqual(['G1']);
    expect(target.execute({ type: 'setSelection', ids: ['other'] })).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
  });

  it('boundsOf returns page-aligned bounds of rotated nested frames', () => {
    const value = editor(scene()).query({ type: 'document' });
    // a: G1 local (0..50, 0..50) turned by π/2 about (150, 350).
    const box = boundsOf(value, ['a'])!;
    expect(box.x).toBeCloseTo(150, 12);
    expect(box.y).toBeCloseTo(300, 12);
    expect(box.width).toBeCloseTo(50, 12);
    expect(box.height).toBeCloseTo(50, 12);
    expect(boundsOf(value, ['d', 'b'])).toEqual(f(10, 10, 50, 100));
  });
});
