import type {
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneColor,
} from '@vector-studio/contracts';

// Visualization track V-3 (docs/plans/viz-v3-a07-integration-contract.md, section 4): the
// independent painter's-order oracle. It walks a scene snapshot's depth-first order, tests a
// point for membership in each visible node's shape, and blends the node colors source-over
// with node opacity in encoded sRGB, premultiplied, as P1's D2 rule does. It imports no page or
// renderer code; its only input is the plain scene data.
//
// Membership: rectangles and ellipses analytically; lines by the distance to the segment
// against half the width (butt caps); path fills by the fill rule's winding number against the
// path flattened here (each cubic subdivided at t = 1/2 until both inner control points lie
// within EPSILON of the chord segment); path strokes on line-only paths by the distance to the
// segments against half the width, butt caps, and miter joins within the miter limit (bevel
// above it). A path with both paints at opacity o is one layer: stroke over fill, times o, then
// source-over the destination (the D2 group-opacity rule of the ST-U7 joint draw).
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target.

export const EPSILON = 0.05;

type Point = readonly [number, number];
type Premultiplied = readonly [number, number, number, number];
export type OracleColor = Readonly<{
  /** Encoded sRGB, 0 to 1, after blending every covering layer over a transparent start. */
  rgb: readonly [number, number, number];
  alpha: number;
  /** The topmost node that covers the point, or null. */
  top: string | null;
  /** Every covering node, bottom to top. */
  covering: readonly string[];
}>;

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];

function compose(parent: SceneAffine, local: SceneAffine): SceneAffine {
  const [a, b, c, d, e, f] = parent;
  const [A, B, Cc, D, E, F] = local;
  return [
    a * A + c * B,
    b * A + d * B,
    a * Cc + c * D,
    b * Cc + d * D,
    a * E + c * F + e,
    b * E + d * F + f,
  ];
}

function invertPoint(m: SceneAffine, x: number, y: number): Point | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) return null;
  const px = x - e;
  const py = y - f;
  return [(d * px - c * py) / det, (-b * px + a * py) / det];
}

const premultiply = (color: SceneColor): Premultiplied => [
  color.r * color.a,
  color.g * color.a,
  color.b * color.a,
  color.a,
];

/** Source-over: s + d * (1 - s.a). */
const over = (s: Premultiplied, d: Premultiplied): Premultiplied => [
  s[0] + d[0] * (1 - s[3]),
  s[1] + d[1] * (1 - s[3]),
  s[2] + d[2] * (1 - s[3]),
  s[3] + d[3] * (1 - s[3]),
];

const scale = (p: Premultiplied, k: number): Premultiplied => [
  p[0] * k,
  p[1] * k,
  p[2] * k,
  p[3] * k,
];
const ZERO: Premultiplied = [0, 0, 0, 0];

// ---------------------------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------------------------

/** Distance from p to the segment ab. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export type CubicLeaf = Readonly<{ p0: Point; p1: Point; p2: Point; p3: Point }>;

/**
 * Subdivides a cubic at t = 1/2 until both inner control points of each leaf lie within `eps`
 * of the leaf's chord segment; the curve lies in the leaf's convex hull, so within `eps` of the
 * chord.
 */
export function flattenCubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  eps = EPSILON,
  leaves: CubicLeaf[] = [],
  depth = 0,
): CubicLeaf[] {
  if (depth >= 24 || (segmentDistance(p1, p0, p3) <= eps && segmentDistance(p2, p0, p3) <= eps)) {
    leaves.push({ p0, p1, p2, p3 });
    return leaves;
  }
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const a = mid(p0, p1);
  const b = mid(p1, p2);
  const c = mid(p2, p3);
  const ab = mid(a, b);
  const bc = mid(b, c);
  const m = mid(ab, bc);
  flattenCubic(p0, a, ab, m, eps, leaves, depth + 1);
  flattenCubic(m, bc, c, p3, eps, leaves, depth + 1);
  return leaves;
}

export type Subpath = Readonly<{ points: readonly Point[]; closed: boolean; curved: boolean }>;

/** Flattens path data into subpaths in local coordinates. */
export function flattenPath(
  verbs: readonly string[],
  points: readonly number[],
  eps = EPSILON,
): Subpath[] {
  const subpaths: Subpath[] = [];
  let current: Point[] = [];
  let closed = false;
  let curved = false;
  let cursor = 0;
  const take = (): Point => {
    const point: Point = [points[cursor]!, points[cursor + 1]!];
    cursor += 2;
    return point;
  };
  const flush = () => {
    if (current.length > 0) subpaths.push({ points: current, closed, curved });
    current = [];
    closed = false;
    curved = false;
  };
  for (const verb of verbs) {
    if (verb === 'move') {
      flush();
      current.push(take());
    } else if (verb === 'line') {
      current.push(take());
    } else if (verb === 'cubic') {
      const p0 = current[current.length - 1]!;
      const p1 = take();
      const p2 = take();
      const p3 = take();
      curved = true;
      for (const leaf of flattenCubic(p0, p1, p2, p3, eps)) current.push(leaf.p3);
    } else if (verb === 'close') {
      // Every path of this scene follows a close with a move or ends.
      closed = true;
      flush();
    }
  }
  flush();
  return subpaths;
}

function winding(subpaths: readonly Subpath[], x: number, y: number): number {
  let total = 0;
  for (const subpath of subpaths) {
    const pts = subpath.points;
    for (let index = 0; index < pts.length; index += 1) {
      const a = pts[index]!;
      const b = pts[(index + 1) % pts.length]!;
      const isLeft = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
      if (a[1] <= y) {
        if (b[1] > y && isLeft > 0) total += 1;
      } else if (b[1] <= y && isLeft < 0) {
        total -= 1;
      }
    }
  }
  return total;
}

function inConvexPolygon(polygon: readonly Point[], x: number, y: number): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;
    const cross = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Stroke membership on a line-only subpath list: segments, butt caps, miter or bevel joins. */
function inStroke(
  subpaths: readonly Subpath[],
  x: number,
  y: number,
  width: number,
  join: string,
  miterLimit: number,
): boolean {
  const h = width / 2;
  const p: Point = [x, y];
  for (const subpath of subpaths) {
    if (subpath.curved) throw new Error('The oracle strokes line-only paths only.');
    const pts = subpath.points;
    const count = pts.length;
    const segments = subpath.closed ? count : count - 1;
    for (let index = 0; index < segments; index += 1) {
      const a = pts[index]!;
      const b = pts[(index + 1) % count]!;
      // Butt: the projection must fall on the segment.
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length2 = dx * dx + dy * dy;
      if (length2 === 0) continue;
      const t = ((x - a[0]) * dx + (y - a[1]) * dy) / length2;
      if (t >= 0 && t <= 1 && segmentDistance(p, a, b) <= h) return true;
    }
    // Joins at interior vertices (every vertex of a closed subpath).
    for (let index = 0; index < count; index += 1) {
      if (!subpath.closed && (index === 0 || index === count - 1)) continue;
      const v = pts[index]!;
      const prev = pts[(index - 1 + count) % count]!;
      const next = pts[(index + 1) % count]!;
      if ((v[0] === prev[0] && v[1] === prev[1]) || (v[0] === next[0] && v[1] === next[1]))
        throw new Error('The oracle strokes paths without repeated vertices only.');
      const d1 = normalize([v[0] - prev[0], v[1] - prev[1]]);
      const d2 = normalize([next[0] - v[0], next[1] - v[1]]);
      const cross = d1[0] * d2[1] - d1[1] * d2[0];
      if (cross === 0) continue;
      // The outer side is opposite the turn.
      const side = cross > 0 ? -1 : 1;
      const n1: Point = [-d1[1] * side, d1[0] * side];
      const n2: Point = [-d2[1] * side, d2[0] * side];
      const e1: Point = [v[0] + h * n1[0], v[1] + h * n1[1]];
      const e2: Point = [v[0] + h * n2[0], v[1] + h * n2[1]];
      if (join === 'round') {
        if (Math.hypot(x - v[0], y - v[1]) <= h) return true;
        continue;
      }
      const cosTheta = -(d1[0] * d2[0] + d1[1] * d2[1]);
      const ratio = 1 / Math.sin(Math.acos(Math.max(-1, Math.min(1, cosTheta))) / 2);
      if (join === 'miter' && ratio <= miterLimit) {
        const bisector = normalize([n1[0] + n2[0], n1[1] + n2[1]]);
        const tip: Point = [v[0] + h * ratio * bisector[0], v[1] + h * ratio * bisector[1]];
        if (inConvexPolygon([v, e1, tip, e2], x, y)) return true;
      } else if (inConvexPolygon([v, e1, e2], x, y)) {
        return true;
      }
    }
  }
  return false;
}

function normalize(v: Point): Point {
  const length = Math.hypot(v[0], v[1]);
  return [v[0] / length, v[1] / length];
}

// ---------------------------------------------------------------------------------------------
// Painter's order
// ---------------------------------------------------------------------------------------------

type Layer = Readonly<{ node: RenderNodeSnapshot; world: SceneAffine }>;

const flatCache = new WeakMap<object, Subpath[]>();
function flattenedOf(node: RenderNodeSnapshot & { kind: 'path' }): Subpath[] {
  let cached = flatCache.get(node.geometry);
  if (cached === undefined) {
    cached = flattenPath(node.geometry.verbs, node.geometry.points);
    flatCache.set(node.geometry, cached);
  }
  return cached;
}

const layerCache = new WeakMap<RenderSceneSnapshot, Layer[]>();

/** Visible layers in depth-first, left-first order with their world transforms. */
export function paintOrder(scene: RenderSceneSnapshot): readonly Layer[] {
  const cached = layerCache.get(scene);
  if (cached !== undefined) return cached;
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const layers: Layer[] = [];
  const visit = (id: string, parent: SceneAffine) => {
    const node = byId.get(id);
    if (node === undefined) throw new Error(`The scene lists an unknown node ${id}.`);
    if (!node.visible) return;
    const world = compose(parent, node.transform);
    if (node.kind === 'container') {
      if (node.opacity !== 1) throw new Error('The oracle supports container opacity 1 only.');
      for (const child of node.children) visit(child, world);
      return;
    }
    layers.push({ node, world });
  };
  for (const id of scene.rootOrder) visit(id, IDENTITY);
  layerCache.set(scene, layers);
  return layers;
}

/** The premultiplied contribution of one layer at a world point, or null when it misses. */
function contribution(layer: Layer, x: number, y: number): Premultiplied | null {
  const { node } = layer;
  const local = invertPoint(layer.world, x, y);
  if (local === null) return null;
  const [lx, ly] = local;
  let fill: Premultiplied = ZERO;
  let stroke: Premultiplied = ZERO;
  let hit = false;
  if (node.kind === 'primitive') {
    const geometry = node.geometry;
    if (geometry.kind === 'rectangle') {
      if (geometry.cornerRadii.some((radius) => radius !== 0))
        throw new Error('The oracle supports square-cornered rectangles only.');
      if (node.style.stroke !== null) throw new Error('The oracle supports unstroked rectangles.');
      if (lx >= 0 && lx <= geometry.width && ly >= 0 && ly <= geometry.height && node.style.fill) {
        fill = premultiply(node.style.fill);
        hit = true;
      }
    } else if (geometry.kind === 'ellipse') {
      if (node.style.stroke !== null) throw new Error('The oracle supports unstroked ellipses.');
      const rx = geometry.width / 2;
      const ry = geometry.height / 2;
      const u = (lx - rx) / rx;
      const v = (ly - ry) / ry;
      if (u * u + v * v <= 1 && node.style.fill) {
        fill = premultiply(node.style.fill);
        hit = true;
      }
    } else {
      const stroked = node.style.stroke;
      if (stroked !== null) {
        const a: Point = [geometry.start.x, geometry.start.y];
        const b: Point = [geometry.end.x, geometry.end.y];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length2 = dx * dx + dy * dy;
        const t = length2 === 0 ? -1 : ((lx - a[0]) * dx + (ly - a[1]) * dy) / length2;
        if (t >= 0 && t <= 1 && segmentDistance([lx, ly], a, b) <= stroked.width / 2) {
          stroke = premultiply(stroked.color);
          hit = true;
        }
      }
    }
  } else if (node.kind === 'path') {
    const subpaths = flattenedOf(node);
    if (node.style.fill !== null) {
      const w = winding(subpaths, lx, ly);
      const inside = node.geometry.fillRule === 'evenodd' ? w % 2 !== 0 : w !== 0;
      if (inside) {
        fill = premultiply(node.style.fill);
        hit = true;
      }
    }
    const pathStroke = node.style.stroke;
    if (pathStroke !== null && pathStroke.width > 0) {
      if (pathStroke.cap !== 'butt') throw new Error('The oracle supports butt caps only.');
      if (inStroke(subpaths, lx, ly, pathStroke.width, pathStroke.join, pathStroke.miterLimit)) {
        stroke = premultiply(pathStroke.color);
        hit = true;
      }
    }
  } else {
    return null;
  }
  if (!hit) return null;
  // D2: L = S + F * (1 - S.a), then times the node opacity.
  return scale(over(stroke, fill), node.opacity);
}

/** The oracle's color at a world point (CSS px at zoom 1). */
export function oracleColor(scene: RenderSceneSnapshot, x: number, y: number): OracleColor {
  let destination: Premultiplied = ZERO;
  const covering: string[] = [];
  for (const layer of paintOrder(scene)) {
    const source = contribution(layer, x, y);
    if (source === null) continue;
    covering.push(layer.node.id);
    destination = over(source, destination);
  }
  const alpha = destination[3];
  // The surface is covered by the opaque bg, so alpha is 1 and premultiplied equals straight.
  const rgb: [number, number, number] =
    alpha === 0
      ? [0, 0, 0]
      : [destination[0] / alpha, destination[1] / alpha, destination[2] / alpha];
  return { rgb, alpha, top: covering.at(-1) ?? null, covering };
}

/** 8-bit encoded channels of an oracle color. */
export const to8 = (color: OracleColor): readonly [number, number, number] => [
  Math.round(color.rgb[0] * 255),
  Math.round(color.rgb[1] * 255),
  Math.round(color.rgb[2] * 255),
];

/** The largest channel difference of two 8-bit colors. */
export const separation = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((value, lane) => Math.abs(value - b[lane]!)));

/**
 * The probe rule: the oracle's color is constant over the closed disc of `radius` around the
 * point, sampled on concentric circles every 0.1 px of radius and at most 0.1 px of arc.
 * Returns the first sample where the color changes, or null.
 */
export function colorChangeWithin(
  scene: RenderSceneSnapshot,
  x: number,
  y: number,
  radius: number,
): Readonly<{ x: number; y: number }> | null {
  const center = oracleColor(scene, x, y).rgb;
  const rings = Math.ceil(radius / 0.1);
  for (let ring = 1; ring <= rings; ring += 1) {
    const r = Math.min(radius, ring * 0.1);
    const samples = Math.max(16, Math.ceil((2 * Math.PI * r) / 0.1));
    for (let index = 0; index < samples; index += 1) {
      const angle = (2 * Math.PI * index) / samples;
      const sx = x + r * Math.cos(angle);
      const sy = y + r * Math.sin(angle);
      const color = oracleColor(scene, sx, sy).rgb;
      if (color.some((value, lane) => Math.abs(value - center[lane]!) > 1e-12)) {
        return { x: sx, y: sy };
      }
    }
  }
  return null;
}

/** World bounds of a node's shape, strokes included; null for containers. */
export function nodeBounds(
  node: RenderNodeSnapshot,
  world: SceneAffine,
): Readonly<{ minX: number; minY: number; maxX: number; maxY: number }> | null {
  let local: Point[] = [];
  let pad = 0;
  if (node.kind === 'container') return null;
  if (node.kind === 'primitive') {
    const g = node.geometry;
    if (g.kind === 'line') {
      local = [
        [g.start.x, g.start.y],
        [g.end.x, g.end.y],
      ];
      pad = (node.style.stroke?.width ?? 0) / 2;
    } else {
      local = [
        [0, 0],
        [g.width, 0],
        [0, g.height],
        [g.width, g.height],
      ];
    }
  } else {
    for (let index = 0; index + 1 < node.geometry.points.length; index += 2)
      local.push([node.geometry.points[index]!, node.geometry.points[index + 1]!]);
    const s = node.style.stroke;
    // A miter tip reaches at most limit * width / 2 from the outline.
    if (s !== null) pad = (s.width / 2) * (s.join === 'miter' ? s.miterLimit : 1);
  }
  const [a, b, c, d, e, f] = world;
  const xs = local.map(([x, y]) => a * x + c * y + e);
  const ys = local.map(([x, y]) => b * x + d * y + f);
  return {
    minX: Math.min(...xs) - pad,
    minY: Math.min(...ys) - pad,
    maxX: Math.max(...xs) + pad,
    maxY: Math.max(...ys) + pad,
  };
}
