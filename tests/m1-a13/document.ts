// MVP M1-A13 (M1 contract, section 8): a deterministic 10,000-node mixed v2 document for the
// load, projection, move and isolation observation. The same seed gives the same document, so
// the observation needs no committed JSON fixture.
//
// Layout. Page 1 (active after load) holds 650 clusters, one nested group chain and one nested
// frame chain, and 50 loose leaves; page 2 holds 50 clusters and 50 loose leaves. A cluster is
// a frame (some rotated, some stroked) of 14 nodes:
//
//   frame F
//     rectangle (per-corner radii, some stroked)
//     group G (some rotated)
//       rectangle a, ellipse, path (triangle or cubic), group G2 (rotated)
//         line (arrows), ellipse
//     maskGroup M (source a cubic path)
//       path source, rectangle, ellipse
//     line (arrows)
//
// Group frames are the bounds of their children's rotated frames, as the editor's refit keeps
// them (contract section 4.2). Leaves vary opacity and visibility.

type Frame = { x: number; y: number; width: number; height: number };
type Color = { r: number; g: number; b: number; a: number };
type Node = Record<string, unknown> & {
  id: string;
  parent: string;
  frame: Frame;
  rotation: number;
};

export type GeneratedDocument = {
  schemaVersion: 2;
  id: string;
  pages: { id: string; name: string; children: string[] }[];
  nodes: Record<string, Node>;
};

export const M1_A13_NODE_COUNT = 10_000;
export const M1_A13_SEED = 0x6d31_a13;
const CELL = 200;
const COLUMNS = 26;
const START = { horizontal: 'start', vertical: 'start' } as const;
const ARROWS = ['none', 'line', 'triangle'] as const;
const CAPS = ['butt', 'round', 'square'] as const;
const JOINS = ['miter', 'round', 'bevel'] as const;

/** mulberry32: a small deterministic PRNG in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The axis-aligned bounds of a frame turned by `rotation` about its centre. */
function rotatedBounds(frame: Frame, rotation: number) {
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const hx = (frame.width * cos + frame.height * sin) / 2;
  const hy = (frame.width * sin + frame.height * cos) / 2;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
}

export function generateM1A13Document(seed = M1_A13_SEED): GeneratedDocument {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const color = (): Color => ({
    r: Math.round(next() * 255) / 255,
    g: Math.round(next() * 255) / 255,
    b: Math.round(next() * 255) / 255,
    a: 1,
  });
  const nodes: Record<string, Node> = {};
  let counter = 0;

  function base(prefix: string, parent: string, frame: Frame, rotation = 0) {
    counter += 1;
    const id = `${prefix}${counter}`;
    return {
      id,
      name: id,
      parent,
      frame,
      rotation,
      constraints: START,
      // Leaves vary these; containers keep opacity 1 (contract M1-S5).
      opacity: 1,
      visible: true,
    };
  }

  function leafStyle() {
    return { opacity: next() < 0.2 ? 0.5 : 1, visible: next() >= 0.03 };
  }

  function add(node: Node): string {
    nodes[node.id] = node;
    return node.id;
  }

  function rectangle(parent: string, frame: Frame, rotation = 0): string {
    return add({
      ...base('r', parent, frame, rotation),
      ...leafStyle(),
      type: 'rectangle',
      cornerRadii: [0, 1, 2, 3].map(() => (next() < 0.5 ? 0 : Math.round(next() * 12))),
      fill: color(),
      stroke: next() < 0.4 ? { color: color(), width: 1 + Math.round(next() * 3) } : null,
    });
  }

  function ellipse(parent: string, frame: Frame, rotation = 0): string {
    return add({
      ...base('e', parent, frame, rotation),
      ...leafStyle(),
      type: 'ellipse',
      fill: color(),
      stroke: next() < 0.4 ? { color: color(), width: 2 } : null,
    });
  }

  function pathStroke() {
    return {
      color: color(),
      width: 1 + Math.round(next() * 3),
      cap: pick(CAPS),
      join: pick(JOINS),
      miterLimit: 4,
    };
  }

  function path(parent: string, frame: Frame, cubic: boolean, rotation = 0): string {
    const data = cubic
      ? {
          verbs: ['move', 'cubic', 'cubic', 'close'],
          points: [0, 0.5, 0, 0, 1, 0, 1, 0.5, 1, 1, 0, 1, 0, 0.5],
          fillRule: 'nonzero',
        }
      : {
          verbs: ['move', 'line', 'line', 'close'],
          points: [0.5, 0, 1, 1, 0, 1],
          fillRule: pick(['nonzero', 'evenodd'] as const),
        };
    return add({
      ...base('p', parent, frame, rotation),
      ...leafStyle(),
      type: 'path',
      path: data,
      fill: color(),
      stroke: next() < 0.5 ? pathStroke() : null,
    });
  }

  function line(parent: string, frame: Frame, rotation = 0): string {
    return add({
      ...base('l', parent, frame, rotation),
      ...leafStyle(),
      type: 'line',
      points: [0, 0, 1, 1],
      stroke: pathStroke(),
      startArrow: pick(ARROWS),
      endArrow: pick(ARROWS),
    });
  }

  /**
   * A group at `at` in its parent's space: `build` creates the children in a provisional local
   * space; they are shifted so that their rotated bounds start at (0, 0), which is then the frame.
   */
  function group(
    kind: 'group' | 'maskGroup',
    parent: string,
    at: { x: number; y: number },
    rotation: number,
    build: (id: string) => string[],
  ): string {
    const node = {
      ...base(kind === 'group' ? 'g' : 'm', parent, { x: 0, y: 0, width: 0, height: 0 }, rotation),
    };
    const children = build(node.id);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of children) {
      const box = rotatedBounds(nodes[id]!.frame, nodes[id]!.rotation);
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
    }
    for (const id of children) {
      const child = nodes[id]!;
      child.frame = { ...child.frame, x: child.frame.x - minX, y: child.frame.y - minY };
    }
    return add({
      ...node,
      frame: { x: at.x, y: at.y, width: maxX - minX, height: maxY - minY },
      type: kind,
      children,
    });
  }

  function frame(parent: string, box: Frame, rotation: number, build: (id: string) => string[]) {
    const node = { ...base('f', parent, box, rotation) };
    const children = build(node.id);
    return add({
      ...node,
      type: 'frame',
      children,
      fill: next() < 0.8 ? color() : null,
      stroke: next() < 0.3 ? { color: color(), width: 2 } : null,
    });
  }

  function cluster(parent: string, index: number): string {
    const x = (index % COLUMNS) * CELL;
    const y = Math.floor(index / COLUMNS) * CELL;
    const turn = index % 4 === 3 ? 0.1 : 0;
    return frame(parent, { x, y, width: 180, height: 180 }, turn, (f) => [
      rectangle(f, { x: 10, y: 10, width: 160, height: 20 }),
      group('group', f, { x: 10, y: 40 }, index % 3 === 0 ? 0.2 : 0, (g) => [
        rectangle(g, { x: 0, y: 0, width: 40, height: 30 }),
        ellipse(g, { x: 50, y: 0, width: 30, height: 30 }),
        path(g, { x: 0, y: 40, width: 40, height: 40 }, index % 2 === 0),
        group('group', g, { x: 50, y: 40 }, 0.3, (g2) => [
          line(g2, { x: 0, y: 0, width: 40, height: 20 }),
          ellipse(g2, { x: 0, y: 25, width: 20, height: 20 }),
        ]),
      ]),
      group('maskGroup', f, { x: 110, y: 100 }, 0, (m) => [
        path(m, { x: 0, y: 0, width: 50, height: 50 }, true),
        rectangle(m, { x: 10, y: 10, width: 40, height: 40 }),
        ellipse(m, { x: 20, y: 0, width: 30, height: 30 }, 0.4),
      ]),
      line(f, { x: 10, y: 160, width: 150, height: 10 }),
    ]);
  }

  /** `levels` nested groups, each holding one rectangle and the next group (no clip depth). */
  function groupChain(parent: string, at: { x: number; y: number }, levels: number): string {
    const level = (owner: string, left: number): string[] =>
      left === 0
        ? [rectangle(owner, { x: 0, y: 0, width: 20, height: 20 })]
        : [
            rectangle(owner, { x: 0, y: 0, width: 20, height: 20 }),
            group('group', owner, { x: 4, y: 4 }, 0.05, (child) => level(child, left - 1)),
          ];
    return group('group', parent, at, 0, (g) => level(g, levels - 1));
  }

  /** `levels` nested frames (one clip level each), each holding one rectangle. */
  function frameChain(parent: string, at: { x: number; y: number }, levels: number): string {
    const level = (owner: string, left: number): string[] => {
      const rect = rectangle(owner, { x: 2, y: 2, width: 10, height: 10 });
      if (left === 0) return [rect];
      const inset = 6;
      const size = 6 * left + 20;
      return [
        rect,
        frame(owner, { x: inset, y: inset, width: size, height: size }, 0.02, (f) =>
          level(f, left - 1),
        ),
      ];
    };
    return frame(parent, { ...at, width: 6 * levels + 40, height: 6 * levels + 40 }, 0, (f) =>
      level(f, levels - 1),
    );
  }

  function loose(parent: string, count: number, top: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const box = { x: (i % 20) * 60, y: top + Math.floor(i / 20) * 60, width: 50, height: 40 };
      const turn = i % 5 === 0 ? -0.7 : 0;
      const kind = i % 4;
      out.push(
        kind === 0
          ? rectangle(parent, box, turn)
          : kind === 1
            ? ellipse(parent, box, turn)
            : kind === 2
              ? path(parent, box, i % 8 === 2, turn)
              : line(parent, box, turn),
      );
    }
    return out;
  }

  const page1: string[] = [];
  for (let i = 0; i < 650; i += 1) page1.push(cluster('page-1', i));
  const below = Math.ceil(650 / COLUMNS) * CELL;
  // 40 group levels: 40 groups and 40 rectangles; 10 frame levels: 10 frames and 10 rectangles.
  page1.push(groupChain('page-1', { x: 0, y: below }, 40));
  page1.push(frameChain('page-1', { x: 400, y: below }, 10));
  page1.push(...loose('page-1', 50, below + 400));
  const page2: string[] = [];
  for (let i = 0; i < 50; i += 1) page2.push(cluster('page-2', i));
  page2.push(...loose('page-2', 50, Math.ceil(50 / COLUMNS) * CELL));

  const document: GeneratedDocument = {
    schemaVersion: 2,
    id: 'm1-a13',
    pages: [
      { id: 'page-1', name: 'Page 1', children: page1 },
      { id: 'page-2', name: 'Page 2', children: page2 },
    ],
    nodes,
  };
  const count = Object.keys(nodes).length;
  if (count !== M1_A13_NODE_COUNT) throw new Error(`generated ${count} nodes, not 10,000`);
  return document;
}

/** The ID of the first cluster's group G and of its rectangle and ellipse (a nested selection). */
export function m1A13MoveSelection(document: GeneratedDocument): {
  group: string;
  ids: [string, string];
} {
  const first = document.nodes[document.pages[0]!.children[0]!]!;
  const group = (first.children as string[])[1]!;
  const [rect, ell] = document.nodes[group]!.children as string[];
  return { group, ids: [rect!, ell!] };
}
