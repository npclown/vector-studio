import type {
  PathStroke,
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneColor,
  StrokeMeshRequest,
} from '@vector-studio/contracts';
import { STROKE_CONFORMANCE_PATHS } from './stroke-mesh-port-conformance.js';
import { StrokeMeshPortDouble } from './stroke-mesh-port-double.js';
import { solidColor } from './scene-paint.js';

// P3 B2 ST-U7 addendum, unit ST-U7d: the headed GPU joint fixtures and their oracles, drawn by
// the V3 smoke fixture page in its `?joint=1` mode with static test-double fill and stroke ports
// (no WASM). ST-A11: the approved example (opaque red fill, opaque blue stroke) at opacity 0.5,
// the separate opaque-stroke node at 0.25, and the half-opacity path over an opaque primitive,
// gated at pixel centers at least 3 physical px from every boundary within 2/255 of the analytic
// single-opacity composite, and more than 20/255 from the double-opacity value in the overlap.
// ST-A16: every fixture rendered at o in {0.5, 0.25} equals o times its rendering at o = 1 in
// every RGB channel within 2/255 over the opaque black clear, under the identity, a 30 degree
// rotation, a reflection and a 3 x 0.5 scale, except the excluded band within 1 physical px of a
// region-only boundary edge, which is reported with its count, fraction and 3 L + 8 E bound.
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target
// until B4 has A04 evidence; no Q4 coverage threshold is claimed.

export const ST_U7_EVIDENCE_LABEL =
  'UNVERIFIED: functional ST-U7 joint-coverage fixtures (ST-A11, ST-A16, ST-A17) only; precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed.';

export const JOINT_CAMERA: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };
export const CANVAS = { width: 640, height: 360 } as const;
const TOLERANCE = 2;
const MARGIN_PX = 3;
const SEPARATION = 20;

type Point = readonly [number, number];
type HandMesh = Readonly<{ positions: number[]; indices: number[]; boundaryEdges: number[] }>;
export type MeshTable = Readonly<{
  fill: readonly (readonly [string, HandMesh])[];
  stroke: readonly (readonly [string, HandMesh])[];
}>;

// ---------------------------------------------------------------------------------------------
// Meshes, shaped as the ports return them (counterclockwise triangles, boundary edges once).

function meshOf(vertices: readonly Point[], triangles: readonly (readonly number[])[]): HandMesh {
  const oriented = triangles.map(([a, b, c]) => {
    const [ax, ay] = vertices[a!]!;
    const [bx, by] = vertices[b!]!;
    const [cx, cy] = vertices[c!]!;
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0 ? [a!, b!, c!] : [a!, c!, b!];
  });
  const key = (p: number, q: number) => `${Math.min(p, q)}:${Math.max(p, q)}`;
  const uses = new Map<string, number>();
  const sides = (t: readonly number[]) =>
    [
      [t[0]!, t[1]!],
      [t[1]!, t[2]!],
      [t[2]!, t[0]!],
    ] as const;
  for (const t of oriented)
    for (const [p, q] of sides(t)) uses.set(key(p, q), (uses.get(key(p, q)) ?? 0) + 1);
  const boundary: number[] = [];
  for (const t of oriented)
    for (const [p, q] of sides(t)) if (uses.get(key(p, q)) === 1) boundary.push(p, q);
  return { positions: vertices.flat(), indices: oriented.flat(), boundaryEdges: boundary };
}

const fan = (polygon: readonly Point[]): HandMesh =>
  meshOf(
    polygon,
    Array.from({ length: polygon.length - 2 }, (_, i) => [0, i + 1, i + 2]),
  );

function ring(outer: readonly Point[], inner: readonly Point[]): HandMesh {
  const n = outer.length;
  const triangles: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    triangles.push([i, j, n + j], [i, n + j, n + i]);
  }
  return meshOf([...outer, ...inner], triangles);
}

const regular = (n: number, radius: number, phase = 0): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const angle = phase + (2 * Math.PI * i) / n;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
  });

/** The stroke double's hand-made mesh of a conformance path (ST-F3: ST-F1 with round caps). */
function doubleStroke(name: keyof typeof STROKE_CONFORMANCE_PATHS, stroke: PathStroke): HandMesh {
  const fixture = STROKE_CONFORMANCE_PATHS[name];
  const request: StrokeMeshRequest = {
    requestId: 0,
    verbs: Uint8Array.from(fixture.verbs),
    points: Float64Array.from(fixture.points),
    width: stroke.width,
    cap: stroke.cap,
    join: stroke.join,
    miterLimit: stroke.miterLimit,
    toleranceExponent: -3,
  };
  const batch = new StrokeMeshPortDouble().buildStrokeMeshes([request]);
  if (batch.status !== 'ok' || batch.results[0]!.status !== 'ok') throw new Error(name);
  const mesh = batch.results[0]!.mesh;
  return {
    positions: Array.from(mesh.positions),
    indices: Array.from(mesh.indices),
    boundaryEdges: Array.from(mesh.boundaryEdges),
  };
}

const F01_POINTS = [0, 0, 10, 0, 10, 10, 0, 10];
// The page's built-in F01 meshes: the square and its width-2 butt miter-4 ring.
const SQUARE_MESH = meshOf(
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
  [
    [0, 1, 2],
    [0, 2, 3],
  ],
);
const RING_MESH = ring(
  [
    [-1, -1],
    [11, -1],
    [11, 11],
    [-1, 11],
  ],
  [
    [1, 1],
    [9, 1],
    [9, 9],
    [1, 9],
  ],
);

// ---------------------------------------------------------------------------------------------
// Fixtures.

const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const BLUE: SceneColor = { r: 0, g: 0, b: 1, a: 1 };
const GREEN: SceneColor = { r: 0, g: 1, b: 0, a: 1 };
const stroke = (color: SceneColor, overrides: Partial<PathStroke> = {}): PathStroke => ({
  color,
  width: 2,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
  ...overrides,
});

export type JointFixture = Readonly<{
  id: string;
  /** The ST7-F fixture it realizes. */
  fixture: string;
  points: readonly number[];
  fill: SceneColor;
  stroke: PathStroke;
  /** CSS px per local unit; a negative value reflects x (sigma = -1). */
  scale: number;
  fillMesh: HandMesh;
  strokeMesh: HandMesh;
  /** True when the paint has more than 128 boundary vertices (drawn region-only). */
  regionOnly: Readonly<{ fill: boolean; stroke: boolean }>;
}>;

const F6_POLYGON: Point[] = [
  [-1.5, -0.5],
  [2, -2],
  [5.5, -0.5],
  [4, 2],
  [0, 2],
];
const F6_STROKE = stroke({ r: 0, g: 0.4, b: 1, a: 1 }, { cap: 'round' });
const F7_POLYGON = regular(64, 20);
const F8_POLYGON = regular(136, 50);

/** ST-A16's fixtures: ST7-F1, ST7-F6, ST7-F7, ST7-F8, ST7-F9 and ST7-F10. */
export const JOINT_FIXTURES: readonly JointFixture[] = [
  {
    id: 'f1',
    fixture: 'ST7-F1',
    points: F01_POINTS,
    fill: RED,
    stroke: stroke(BLUE),
    scale: 8,
    fillMesh: SQUARE_MESH,
    strokeMesh: RING_MESH,
    regionOnly: { fill: false, stroke: false },
  },
  {
    id: 'f6',
    fixture: 'ST7-F6',
    points: F6_POLYGON.flat(),
    fill: { r: 1, g: 0.5, b: 0, a: 1 },
    stroke: F6_STROKE,
    scale: 12,
    fillMesh: fan(F6_POLYGON),
    strokeMesh: doubleStroke('stF1', F6_STROKE),
    regionOnly: { fill: false, stroke: false },
  },
  {
    id: 'f7',
    fixture: 'ST7-F7',
    points: F7_POLYGON.flat(),
    fill: { r: 0.2, g: 0.8, b: 0.2, a: 1 },
    stroke: stroke({ r: 1, g: 0, b: 1, a: 1 }),
    scale: 2.5,
    fillMesh: fan(F7_POLYGON),
    strokeMesh: ring(regular(72, 21, 0.01), regular(72, 19, 0.01)),
    regionOnly: { fill: false, stroke: true },
  },
  {
    id: 'f8',
    fixture: 'ST7-F8',
    points: F8_POLYGON.flat(),
    fill: { r: 0.9, g: 0.9, b: 0.1, a: 1 },
    stroke: stroke({ r: 0, g: 0.6, b: 0.6, a: 1 }, { width: 4 }),
    scale: 1,
    fillMesh: fan(F8_POLYGON),
    strokeMesh: ring(regular(136, 52), regular(136, 48)),
    regionOnly: { fill: true, stroke: true },
  },
  {
    id: 'f9',
    fixture: 'ST7-F9',
    points: F01_POINTS,
    fill: RED,
    stroke: stroke(BLUE),
    scale: -8,
    fillMesh: SQUARE_MESH,
    strokeMesh: RING_MESH,
    regionOnly: { fill: false, stroke: false },
  },
  {
    id: 'f10',
    fixture: 'ST7-F10',
    points: F01_POINTS,
    fill: { r: 1, g: 0, b: 0, a: 0.5 },
    stroke: stroke({ r: 0, g: 0, b: 1, a: 0.5 }),
    scale: 8,
    fillMesh: SQUARE_MESH,
    strokeMesh: RING_MESH,
    regionOnly: { fill: false, stroke: false },
  },
];

/** The static double meshes the page must serve, beyond its built-in F01 meshes. */
export function jointMeshTable(): MeshTable {
  const fill: [string, HandMesh][] = [];
  const strokes: [string, HandMesh][] = [];
  for (const f of JOINT_FIXTURES) {
    if (f.points === F01_POINTS) continue;
    const points = f.points.join(',');
    fill.push([`${points}|nonzero`, f.fillMesh]);
    const s = f.stroke;
    strokes.push([[points, s.width, s.cap, s.join, s.miterLimit].join('|'), f.strokeMesh]);
  }
  return { fill, stroke: strokes };
}

// ---------------------------------------------------------------------------------------------
// Views and layout. A view's linear map L applies to every node; each node is placed so its
// mapped mesh bounds land in a free slot, and nodes never overlap.

export type JointView = Readonly<{ id: string; linear: readonly [number, number, number, number] }>;

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);
export const JOINT_VIEWS: readonly JointView[] = [
  { id: 'identity', linear: [1, 0, 0, 1] },
  { id: 'rotate-30', linear: [COS30, SIN30, -SIN30, COS30] },
  { id: 'reflect', linear: [-1, 0, 0, 1] },
  { id: 'scale-3x0.5', linear: [3, 0, 0, 0.5] },
];

export type PlacedNode = Readonly<{ fixture: JointFixture; transform: SceneAffine }>;

function meshCorners(f: JointFixture): Point[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const mesh of [f.fillMesh, f.strokeMesh]) {
    for (let i = 0; i < mesh.positions.length; i += 2) {
      xs.push(mesh.positions[i]!);
      ys.push(mesh.positions[i + 1]!);
    }
  }
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Frames of placed nodes for one view; each frame fits the canvas with 16 px gaps. */
export function layoutFrames(view: JointView): PlacedNode[][] {
  const [a, b, c, d] = view.linear;
  const frames: PlacedNode[][] = [[]];
  let cursorX = 16;
  let cursorY = 16;
  let rowHeight = 0;
  for (const f of JOINT_FIXTURES) {
    // Node linear map: L * diag(scale, |scale|).
    const sx = f.scale;
    const sy = Math.abs(f.scale);
    const m: [number, number, number, number] = [a * sx, b * sx, c * sy, d * sy];
    const mapped = meshCorners(f).map(([x, y]) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y]);
    const minX = Math.min(...mapped.map(([x]) => x!));
    const maxX = Math.max(...mapped.map(([x]) => x!));
    const minY = Math.min(...mapped.map(([, y]) => y!));
    const maxY = Math.max(...mapped.map(([, y]) => y!));
    const width = maxX - minX;
    const height = maxY - minY;
    if (cursorX + width > CANVAS.width - 16) {
      cursorX = 16;
      cursorY += rowHeight + 16;
      rowHeight = 0;
    }
    if (cursorY + height > CANVAS.height - 16) {
      frames.push([]);
      cursorX = 16;
      cursorY = 16;
      rowHeight = 0;
    }
    // Integer translations keep every placement exact.
    const tx = Math.ceil(cursorX - minX);
    const ty = Math.ceil(cursorY - minY);
    frames.at(-1)!.push({ fixture: f, transform: [m[0], m[1], m[2], m[3], tx, ty] });
    cursorX += width + 17;
    rowHeight = Math.max(rowHeight, height + 1);
  }
  return frames.filter((frame) => frame.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Snapshots. Every render carries every node of every scene, so meshes stay cached across
// renders and a device loss can be checked with zero port calls; only the current frame's
// nodes are visible.

export type SceneNode = Readonly<{
  id: string;
  kind: 'path' | 'rectangle';
  points?: readonly number[];
  fill: SceneColor;
  stroke: PathStroke | null;
  opacity: number;
  transform: SceneAffine;
  size?: number;
}>;

/** ST-A11's nodes: the approved example at 0.5 and 0.25, and the 0.5 node over a primitive. */
export const ST_A11_TOP = 40;
export const ST_A11_NODES: readonly (SceneNode & { x: number; under?: boolean })[] = [
  {
    id: 'joint-half',
    kind: 'path',
    points: F01_POINTS,
    fill: RED,
    stroke: stroke(BLUE),
    opacity: 0.5,
    x: 40,
    transform: [8, 0, 0, 8, 40, ST_A11_TOP],
  },
  {
    id: 'joint-quarter',
    kind: 'path',
    points: F01_POINTS,
    fill: RED,
    stroke: stroke(BLUE),
    opacity: 0.25,
    x: 200,
    transform: [8, 0, 0, 8, 200, ST_A11_TOP],
  },
  {
    id: 'under-primitive',
    kind: 'rectangle',
    fill: GREEN,
    stroke: null,
    opacity: 1,
    x: 360,
    size: 112,
    under: true,
    transform: [1, 0, 0, 1, 360 - 16, ST_A11_TOP - 16],
  },
  {
    id: 'joint-over-primitive',
    kind: 'path',
    points: F01_POINTS,
    fill: RED,
    stroke: stroke(BLUE),
    opacity: 0.5,
    x: 360,
    transform: [8, 0, 0, 8, 360, ST_A11_TOP],
  },
];

export type SceneRequest =
  | Readonly<{ kind: 'st-a11' }>
  | Readonly<{ kind: 'st-a16'; view: string; frame: number; opacity: number }>;

export function jointSnapshot(request: SceneRequest, revision: number): RenderSceneSnapshot {
  const children: RenderNodeSnapshot[] = [];
  const visibleA11 = request.kind === 'st-a11';
  for (const node of ST_A11_NODES) children.push(sceneNode(node, visibleA11));
  for (const view of JOINT_VIEWS) {
    layoutFrames(view).forEach((frame, index) => {
      for (const placed of frame) {
        const visible =
          request.kind === 'st-a16' && request.view === view.id && request.frame === index;
        const f = placed.fixture;
        children.push(
          sceneNode(
            {
              id: `${view.id}-${index}-${f.id}`,
              kind: 'path',
              points: f.points,
              fill: f.fill,
              stroke: f.stroke,
              opacity: request.kind === 'st-a16' ? request.opacity : 1,
              transform: placed.transform,
            },
            visible,
          ),
        );
      }
    });
  }
  return {
    identity: { documentId: 'p3-st-u7-joint', pageId: 'page' },
    revision,
    nodes: [
      {
        id: 'root',
        parentId: null,
        transform: [1, 0, 0, 1, 0, 0],
        visible: true,
        opacity: 1,
        kind: 'container',
        clip: null,
        children: children.map((node) => node.id),
      },
      ...children,
    ],
    rootOrder: ['root'],
  };
}

function sceneNode(node: SceneNode, visible: boolean): RenderNodeSnapshot {
  if (node.kind === 'rectangle') {
    return {
      id: node.id,
      parentId: 'root',
      transform: node.transform,
      visible,
      opacity: node.opacity,
      kind: 'primitive',
      geometry: {
        kind: 'rectangle',
        width: node.size!,
        height: node.size!,
        cornerRadii: [0, 0, 0, 0],
      },
      style: { fill: node.fill, stroke: null },
    };
  }
  const points = node.points!;
  return {
    id: node.id,
    parentId: 'root',
    transform: node.transform,
    visible,
    opacity: node.opacity,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: [
        'move',
        ...Array.from({ length: points.length / 2 - 1 }, () => 'line' as const),
        'close',
      ],
      points: [...points],
      fillRule: 'nonzero',
    },
    style: { fill: node.fill, stroke: node.stroke },
  };
}

// ---------------------------------------------------------------------------------------------
// ST-A11: analytic single-opacity composite at interior pixel centers.

export type JointPixelClass = 'exterior' | 'fill-only' | 'stroke-only' | 'overlap' | 'primitive';

export type St11Inspection = Readonly<{
  failures: readonly string[];
  gatedPixels: number;
  classes: Readonly<Record<string, Partial<Record<JointPixelClass, number>>>>;
  maximumDeviation: number;
  /** Per node, the minimum over overlap pixels of the largest channel distance to the double-opacity value (in /255). */
  minimumSeparation: Readonly<Record<string, number>>;
  overPrimitiveCenter: Readonly<{ pixel: readonly number[]; expected: readonly number[] }> | null;
  probed: readonly number[];
}>;

type Box = readonly [number, number, number, number];
const inBox = (p: Point, [x0, y0, x1, y1]: Box) => p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1;
function nearBox(p: Point, [x0, y0, x1, y1]: Box): boolean {
  const corners: Point[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)),
    );
    if (Math.hypot(p[0] - (a[0] + t * ex), p[1] - (a[1] + t * ey)) < MARGIN_PX) return true;
  }
  return false;
}

const premultiplied = (color: SceneColor, coverage: number) => {
  const alpha = color.a * coverage;
  return [color.r * alpha, color.g * alpha, color.b * alpha, alpha];
};

/**
 * The single-opacity composite of one path at an interior pixel: L = S + F (1 - S.a),
 * P = o L, dst = P + dst (1 - P.a). With `double` set, the forbidden double-opacity value
 * o S + o F (1 - o S.a) over the destination instead.
 */
function composite(
  dst: number[],
  fill: number[] | null,
  strokeColor: number[] | null,
  opacity: number,
  double = false,
): number[] {
  const f = fill ?? [0, 0, 0, 0];
  const s = strokeColor ?? [0, 0, 0, 0];
  if (double) {
    const fo = f.map((value) => value * opacity);
    const so = s.map((value) => value * opacity);
    const afterFill = dst.map((value, channel) => fo[channel]! + value * (1 - fo[3]!));
    return afterFill.map((value, channel) => so[channel]! + value * (1 - so[3]!));
  }
  const l = s.map((value, channel) => value + f[channel]! * (1 - s[3]!));
  const p = l.map((value) => value * opacity);
  return dst.map((value, channel) => p[channel]! + value * (1 - p[3]!));
}

export function inspectStA11(
  dpr: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): St11Inspection {
  const scale = JOINT_CAMERA.zoom * dpr;
  const paths = ST_A11_NODES.filter((node) => node.kind === 'path').map((node) => {
    const box = (u0: number, u1: number): Box => [
      (node.x + 8 * u0) * scale,
      (ST_A11_TOP + 8 * u0) * scale,
      (node.x + 8 * u1) * scale,
      (ST_A11_TOP + 8 * u1) * scale,
    ];
    return { node, fill: box(0, 10), outer: box(-1, 11), inner: box(1, 9) };
  });
  const primitive = ST_A11_NODES.find((node) => node.kind === 'rectangle')!;
  const rect: Box = [
    primitive.transform[4] * scale,
    primitive.transform[5] * scale,
    (primitive.transform[4] + primitive.size!) * scale,
    (primitive.transform[5] + primitive.size!) * scale,
  ];
  const boxes = [rect, ...paths.flatMap((path) => [path.fill, path.outer, path.inner])];
  const failures: string[] = [];
  const probed: number[] = [];
  const classes: Record<string, Partial<Record<JointPixelClass, number>>> = {};
  const minimumSeparation: Record<string, number> = {};
  let maximumDeviation = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p: Point = [x + 0.5, y + 0.5];
      if (boxes.some((box) => nearBox(p, box))) continue;
      let dst = [0, 0, 0, 1];
      let owner = 'background';
      let pixelClass: JointPixelClass = 'exterior';
      if (inBox(p, rect)) {
        dst = [0, 1, 0, 1];
        owner = primitive.id;
        pixelClass = 'primitive';
      }
      let double: number[] | null = null;
      for (const path of paths) {
        const inFill = inBox(p, path.fill);
        const inStroke = inBox(p, path.outer) && !inBox(p, path.inner);
        if (!inFill && !inStroke) continue;
        owner = path.node.id;
        pixelClass = inFill && inStroke ? 'overlap' : inFill ? 'fill-only' : 'stroke-only';
        const f = inFill ? premultiplied(path.node.fill, 1) : null;
        const s = inStroke ? premultiplied(solidColor(path.node.stroke!.color), 1) : null;
        if (pixelClass === 'overlap') double = composite(dst, f, s, path.node.opacity, true);
        dst = composite(dst, f, s, path.node.opacity);
      }
      const counts = (classes[owner] ??= {});
      counts[pixelClass] = (counts[pixelClass] ?? 0) + 1;
      const index = (y * width + x) * 4;
      probed.push(y * width + x);
      let deviation = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        deviation = Math.max(deviation, Math.abs(rgba[index + channel]! - dst[channel]! * 255));
      }
      maximumDeviation = Math.max(maximumDeviation, deviation);
      if (deviation > TOLERANCE && failures.length < 16) {
        failures.push(
          `st-a11 dpr${dpr} (${x},${y}) ${owner} ${pixelClass} [${Array.from(rgba.subarray(index, index + 4)).join()}] expected [${dst.map((value) => Math.round(value * 255)).join()}]`,
        );
      }
      if (double !== null) {
        let separation = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          separation = Math.max(
            separation,
            Math.abs(rgba[index + channel]! - double[channel]! * 255),
          );
        }
        minimumSeparation[owner] = Math.min(minimumSeparation[owner] ?? Infinity, separation);
      }
    }
  }
  for (const path of paths) {
    for (const pixelClass of ['overlap', 'fill-only', 'stroke-only'] as const) {
      if ((classes[path.node.id]?.[pixelClass] ?? 0) === 0)
        failures.push(`st-a11 dpr${dpr}: no gated ${pixelClass} pixel for ${path.node.id}`);
    }
    const separation = minimumSeparation[path.node.id] ?? 0;
    if (!(separation > SEPARATION))
      failures.push(
        `st-a11 dpr${dpr}: ${path.node.id} overlap is ${separation}/255 from the double-opacity value (need > ${SEPARATION})`,
      );
  }
  // The half-opacity path over the opaque primitive, at its overlap center: local (0.5, 5).
  const over = paths.find((path) => path.node.id === 'joint-over-primitive')!;
  const cx = Math.floor((over.node.x + 8 * 0.5) * scale);
  const cy = Math.floor((ST_A11_TOP + 8 * 5) * scale);
  const at = (cy * width + cx) * 4;
  const expected = composite([0, 1, 0, 1], premultiplied(RED, 1), premultiplied(BLUE, 1), 0.5).map(
    (value) => value * 255,
  );
  const pixel = Array.from(rgba.subarray(at, at + 4));
  if (pixel.some((value, channel) => Math.abs(value - expected[channel]!) > TOLERANCE))
    failures.push(
      `st-a11 dpr${dpr}: over-primitive center [${pixel.join()}] expected [${expected.join()}]`,
    );
  return {
    failures,
    gatedPixels: probed.length,
    classes,
    maximumDeviation,
    minimumSeparation,
    overPrimitiveCenter: { pixel, expected },
    probed,
  };
}

// ---------------------------------------------------------------------------------------------
// ST-A16: the relative check with the exactly computed excluded band.

export type St16Report = Readonly<{
  view: string;
  frame: number;
  opacity: number;
  dpr: number;
  failures: readonly string[];
  gatedPixels: number;
  maximumDeviation: number;
  /** Pixels whose RGB differs from o x the o = 1 render by more than 2/255, gated pixels only. */
  overTolerance: number;
  band: Readonly<{
    pixels: number;
    fraction: number;
    bound: number;
    lengthPx: number;
    edges: number;
    overTolerance: number;
  }>;
}>;

/** Region-only boundary edges of a frame's nodes, in physical px. */
function regionOnlyEdges(frame: readonly PlacedNode[], dpr: number): [Point, Point][] {
  const scale = JOINT_CAMERA.zoom * dpr;
  const edges: [Point, Point][] = [];
  for (const { fixture, transform } of frame) {
    const map = (mesh: HandMesh, vertex: number): Point => {
      const x = mesh.positions[2 * vertex]!;
      const y = mesh.positions[2 * vertex + 1]!;
      return [
        (transform[0] * x + transform[2] * y + transform[4]) * scale,
        (transform[1] * x + transform[3] * y + transform[5]) * scale,
      ];
    };
    for (const [paint, mesh] of [
      ['fill', fixture.fillMesh],
      ['stroke', fixture.strokeMesh],
    ] as const) {
      if (!fixture.regionOnly[paint]) continue;
      for (let i = 0; i < mesh.boundaryEdges.length; i += 2) {
        edges.push([map(mesh, mesh.boundaryEdges[i]!), map(mesh, mesh.boundaryEdges[i + 1]!)]);
      }
    }
  }
  return edges;
}

/** The excluded band: pixel centers within 1 physical px of a region-only boundary edge. */
export function excludedBand(
  frame: readonly PlacedNode[],
  dpr: number,
  width: number,
  height: number,
): Readonly<{ mask: Uint8Array; pixels: number; bound: number; lengthPx: number; edges: number }> {
  const mask = new Uint8Array(width * height);
  const edges = regionOnlyEdges(frame, dpr);
  let lengthPx = 0;
  for (const [a, b] of edges) {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const length2 = ex * ex + ey * ey;
    lengthPx += Math.sqrt(length2);
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - 1.5));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0]) + 1.5));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - 1.5));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1]) + 1.5));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5 - a[0];
        const py = y + 0.5 - a[1];
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, (px * ex + py * ey) / length2));
        const dx = px - t * ex;
        const dy = py - t * ey;
        if (dx * dx + dy * dy <= 1) mask[y * width + x] = 1;
      }
    }
  }
  let pixels = 0;
  for (const value of mask) pixels += value;
  return { mask, pixels, bound: 3 * lengthPx + 8 * edges.length, lengthPx, edges: edges.length };
}

export function inspectStA16(
  view: string,
  frameIndex: number,
  opacity: number,
  dpr: number,
  width: number,
  height: number,
  rgbaAtO: Uint8Array,
  rgbaAtOne: Uint8Array,
): St16Report {
  const frame = layoutFrames(JOINT_VIEWS.find((candidate) => candidate.id === view)!)[frameIndex]!;
  const band = excludedBand(frame, dpr, width, height);
  const failures: string[] = [];
  let gatedPixels = 0;
  let maximumDeviation = 0;
  let overTolerance = 0;
  let bandOver = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    let deviation = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      deviation = Math.max(
        deviation,
        Math.abs(rgbaAtO[4 * pixel + channel]! - opacity * rgbaAtOne[4 * pixel + channel]!),
      );
    }
    if (band.mask[pixel] === 1) {
      if (deviation > TOLERANCE) bandOver += 1;
      continue;
    }
    gatedPixels += 1;
    maximumDeviation = Math.max(maximumDeviation, deviation);
    if (deviation > TOLERANCE) {
      overTolerance += 1;
      if (failures.length < 12) {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        failures.push(
          `st-a16 ${view}/${frameIndex} o=${opacity} dpr${dpr} (${x},${y}) [${Array.from(rgbaAtO.subarray(4 * pixel, 4 * pixel + 3)).join()}] vs o x [${Array.from(rgbaAtOne.subarray(4 * pixel, 4 * pixel + 3)).join()}]`,
        );
      }
    }
  }
  if (band.pixels > band.bound)
    failures.push(
      `st-a16 ${view}/${frameIndex} dpr${dpr}: excluded band ${band.pixels} px above its bound ${band.bound}`,
    );
  return {
    view,
    frame: frameIndex,
    opacity,
    dpr,
    failures,
    gatedPixels,
    maximumDeviation,
    overTolerance,
    band: {
      pixels: band.pixels,
      fraction: band.pixels / (width * height),
      bound: band.bound,
      lengthPx: band.lengthPx,
      edges: band.edges,
      overTolerance: bandOver,
    },
  };
}
