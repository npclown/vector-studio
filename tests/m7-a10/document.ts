// MVP M7-A10 (M7 contract, section 9): a deterministic page of 100 instances of one 100-node
// source, about 10,000 projected scene nodes from 200 document nodes, for the load, projection,
// source edit, detach and instance move observation. It is built from indices alone, so the
// observation needs no committed JSON fixture.
//
// Layout. One page holds the source `S` (a `symbol` of 100 nodes: itself and 99 descendants)
// and 100 instances of it in a 10 x 10 grid below it. The source is 200 x 200 with a white fill
// and no stroke, so each instance projects its outer, content and background nodes and its 99
// expanded nodes (102 scene nodes). Its content is 11 groups (some rotated) of 8 leaves each, 99
// nodes:
//
//   symbol S
//     group G<k> (k = 0..10), in a 4 x 3 grid of 50 x 66 cells
//       rectangle (per-corner radii on some), ellipse, path (a triangle or a cubic shape),
//       line (arrows), rectangle (rotated), ellipse (stroked), path, line
//
// Even-numbered instances keep the source's size (an expansion at scale 1 is the source's own
// nodes, M7-X1); odd-numbered ones are 300 x 250, so their content is mapped. Group frames are
// the bounds of their children's rotated frames, as the editor's refit keeps them.

type Frame = { x: number; y: number; width: number; height: number };
type Color = { r: number; g: number; b: number; a: number };
type Node = Record<string, unknown> & {
  id: string;
  parent: string;
  frame: Frame;
  rotation: number;
};

export type GeneratedDocument = {
  schemaVersion: 4;
  id: string;
  pages: { id: string; name: string; children: string[] }[];
  nodes: Record<string, Node>;
};

export const M7_A10_INSTANCES = 100;
/** The source's own node count: the symbol and its 99 descendants. */
export const M7_A10_SOURCE_NODES = 100;
export const M7_A10_SOURCE = 'S';
export const M7_A10_PAGE = 'page-1';
const GROUPS = 11;
const COLUMNS = 10;
const CELL = 320;
const START = { horizontal: 'start', vertical: 'start' } as const;
const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 };

/** A colour from an index, in steps of 1/255. */
function color(index: number): Color {
  return {
    r: ((index * 67) % 256) / 255,
    g: ((index * 131) % 256) / 255,
    b: ((index * 199) % 256) / 255,
    a: 1,
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

function base(id: string, parent: string, frame: Frame, rotation = 0) {
  return {
    id,
    name: id,
    parent,
    frame,
    rotation,
    constraints: START,
    opacity: 1,
    visible: true,
  };
}

function pathStroke(index: number) {
  return {
    color: color(index + 7),
    width: 1 + (index % 3),
    cap: (['butt', 'round', 'square'] as const)[index % 3],
    join: (['miter', 'round', 'bevel'] as const)[index % 3],
    miterLimit: 4,
  };
}

/** The 8 leaves of group `g` (index `k`), in a 4 x 2 grid of 10 x 10 cells in a local space. */
function leaves(g: string, k: number): Node[] {
  const at = (slot: number, width = 8, height = 8): Frame => ({
    x: (slot % 4) * 12,
    y: Math.floor(slot / 4) * 12,
    width,
    height,
  });
  const triangle = {
    verbs: ['move', 'line', 'line', 'close'],
    points: [0.5, 0, 1, 1, 0, 1],
    fillRule: 'nonzero',
  };
  const cubic = {
    verbs: ['move', 'cubic', 'cubic', 'close'],
    points: [0, 0.5, 0, 0, 1, 0, 1, 0.5, 1, 1, 0, 1, 0, 0.5],
    fillRule: 'evenodd',
  };
  const id = (slot: number) => `${g}-${slot}`;
  return [
    {
      ...base(id(0), g, at(0)),
      type: 'rectangle',
      cornerRadii: k % 2 === 0 ? [0, 0, 0, 0] : [1, 2, 3, 0],
      fill: color(k * 8),
      stroke: null,
    },
    { ...base(id(1), g, at(1)), type: 'ellipse', fill: color(k * 8 + 1), stroke: null },
    {
      ...base(id(2), g, at(2)),
      type: 'path',
      path: k % 2 === 0 ? triangle : cubic,
      fill: color(k * 8 + 2),
      stroke: k % 3 === 0 ? pathStroke(k) : null,
    },
    {
      ...base(id(3), g, at(3, 8, 4)),
      type: 'line',
      points: [0, 0, 1, 1],
      stroke: pathStroke(k + 1),
      startArrow: 'none',
      endArrow: k % 2 === 0 ? 'triangle' : 'line',
    },
    {
      ...base(id(4), g, at(4), 0.3),
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: color(k * 8 + 4),
      stroke: { color: color(k * 8 + 5), width: 1 },
    },
    {
      ...base(id(5), g, at(5)),
      type: 'ellipse',
      fill: color(k * 8 + 5),
      stroke: { color: color(k * 8 + 6), width: 2 },
    },
    {
      ...base(id(6), g, at(6)),
      type: 'path',
      path: k % 2 === 0 ? cubic : triangle,
      fill: null,
      stroke: pathStroke(k + 2),
    },
    {
      ...base(id(7), g, at(7, 8, 0)),
      type: 'line',
      points: [0, 0, 1, 0],
      stroke: pathStroke(k + 3),
      startArrow: 'line',
      endArrow: 'none',
    },
  ] as Node[];
}

export function generateM7A10Document(): GeneratedDocument {
  const nodes: Record<string, Node> = {};
  const add = (node: Node) => {
    nodes[node.id] = node;
    return node.id;
  };

  const groups: string[] = [];
  for (let k = 0; k < GROUPS; k += 1) {
    const g = `G${k}`;
    const children = leaves(g, k);
    // Shift the children so that their rotated bounds start at (0, 0), which is then the frame.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const child of children) {
      const box = rotatedBounds(child.frame, child.rotation);
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
    }
    for (const child of children) {
      child.frame = { ...child.frame, x: child.frame.x - minX, y: child.frame.y - minY };
      add(child);
    }
    const frame = {
      x: 4 + (k % 4) * 50,
      y: 4 + Math.floor(k / 4) * 66,
      width: maxX - minX,
      height: maxY - minY,
    };
    groups.push(
      add({
        ...base(g, M7_A10_SOURCE, frame, k % 3 === 1 ? 0.2 : 0),
        type: 'group',
        children: children.map((child) => child.id),
      }),
    );
  }
  add({
    ...base(M7_A10_SOURCE, M7_A10_PAGE, { x: 0, y: 0, width: 200, height: 200 }),
    name: 'Source',
    type: 'symbol',
    children: groups,
    fill: WHITE,
    stroke: null,
  });

  const instances: string[] = [];
  for (let index = 0; index < M7_A10_INSTANCES; index += 1) {
    const scaled = index % 2 === 1;
    instances.push(
      add({
        ...base(`I${index}`, M7_A10_PAGE, {
          x: (index % COLUMNS) * CELL,
          y: 240 + Math.floor(index / COLUMNS) * CELL,
          width: scaled ? 300 : 200,
          height: scaled ? 250 : 200,
        }),
        name: 'Source',
        type: 'instance',
        symbol: M7_A10_SOURCE,
      }),
    );
  }

  return {
    schemaVersion: 4,
    id: 'doc-m7-a10',
    pages: [{ id: M7_A10_PAGE, name: 'Page 1', children: [M7_A10_SOURCE, ...instances] }],
    nodes,
  };
}
