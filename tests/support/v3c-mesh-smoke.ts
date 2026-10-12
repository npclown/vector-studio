import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneColor,
  SceneFillRule,
} from '@vector-studio/contracts';

// P3 V3 contract, section l, V3-A14: the headed functional smoke's scenes and its analytic
// pixel oracle. Functional evidence only: precision is UNVERIFIED against the 0.25
// physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed.
// Pixels within 3 physical px of any boundary are captured, never gated.

export const V3C_EVIDENCE_LABEL =
  'UNVERIFIED: functional V3-A14 smoke only; precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed.';

type Point = readonly [number, number];
type Loop = readonly Point[];

const square = (x0: number, y0: number, x1: number, y1: number): Loop => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** F01 and F02 path data (P3 private contract) in path-local units. */
export const SMOKE_PATHS = Object.freeze({
  f01: {
    verbs: ['move', 'line', 'line', 'line', 'close'] as const,
    points: [0, 0, 10, 0, 10, 10, 0, 10],
  },
  f02: {
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
    ] as const,
    points: [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 7, 3, 7, 7, 3, 7],
  },
});

/** The filled region of each path under its rule, as loops for the oracle. */
function pathRegion(
  path: 'f01' | 'f02',
  rule: SceneFillRule,
): Readonly<{ loops: Loop[]; rule: SceneFillRule }> {
  if (path === 'f01') return { loops: [square(0, 0, 10, 10)], rule: 'nonzero' };
  // Both F02 contours run the same way: nonzero fills the square, evenodd leaves the hole.
  return { loops: [square(0, 0, 10, 10), square(3, 3, 7, 7)], rule };
}

export type SmokeVariant = Readonly<{ id: string; transform: SceneAffine }>;

const C30 = Math.cos(Math.PI / 6);
const S30 = Math.sin(Math.PI / 6);

/** The base scene under these container transforms (V3-A14). */
export const SMOKE_VARIANTS: readonly SmokeVariant[] = [
  { id: 'identity', transform: [1, 0, 0, 1, 40, 40] },
  { id: 'rotate-30', transform: [C30, S30, -S30, C30, 90, 40] },
  { id: 'reflect-a-1', transform: [-1, 0, 0, 1, 230, 40] },
  { id: 'scale-3x0.5', transform: [3, 0, 0, 0.5, 30, 40] },
];

type SmokeNode = Readonly<{
  id: string;
  kind: 'path' | 'rectangle';
  transform: SceneAffine;
  color: SceneColor;
  opacity: number;
  path?: 'f01' | 'f02';
  rule?: SceneFillRule;
  size?: Point;
}>;

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };
const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const YELLOW = { r: 1, g: 1, b: 0, a: 1 };
const MAGENTA = { r: 1, g: 0, b: 1, a: 1 };

/**
 * Paint order: F02 nonzero; F02 evenodd; a path between two rectangles (R1, path, R2); an opaque
 * rectangle under a half-opacity path.
 */
export const SMOKE_NODES: readonly SmokeNode[] = [
  {
    id: 'f02-nonzero',
    kind: 'path',
    path: 'f02',
    rule: 'nonzero',
    transform: [5, 0, 0, 5, 0, 0],
    color: YELLOW,
    opacity: 1,
  },
  {
    id: 'f02-evenodd',
    kind: 'path',
    path: 'f02',
    rule: 'evenodd',
    transform: [5, 0, 0, 5, 60, 0],
    color: MAGENTA,
    opacity: 1,
  },
  {
    id: 'rect-below',
    kind: 'rectangle',
    size: [30, 50],
    transform: [1, 0, 0, 1, 120, 0],
    color: BLUE,
    opacity: 1,
  },
  {
    id: 'path-between',
    kind: 'path',
    path: 'f01',
    rule: 'nonzero',
    transform: [4, 0, 0, 4, 135, 5],
    color: RED,
    opacity: 1,
  },
  {
    id: 'rect-above',
    kind: 'rectangle',
    size: [30, 50],
    transform: [1, 0, 0, 1, 160, 0],
    color: GREEN,
    opacity: 1,
  },
  {
    id: 'rect-under-half',
    kind: 'rectangle',
    size: [110, 40],
    transform: [1, 0, 0, 1, 0, 60],
    color: BLUE,
    opacity: 1,
  },
  {
    id: 'path-half',
    kind: 'path',
    path: 'f01',
    rule: 'nonzero',
    transform: [4, 0, 0, 4, 30, 55],
    color: RED,
    opacity: 0.5,
  },
];

export const SMOKE_CAMERA: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };
export const SMOKE_CSS_SIZE = Object.freeze({ width: 640, height: 360 });
export const SMOKE_IDENTITY = Object.freeze({ documentId: 'p3-v3c-smoke', pageId: 'page' });

export function smokeSnapshot(variant: SmokeVariant, revision: number): RenderSceneSnapshot {
  const children = SMOKE_NODES.map((node) => node.id);
  const nodes: RenderNodeSnapshot[] = [
    {
      id: 'root',
      parentId: null,
      transform: variant.transform,
      visible: true,
      opacity: 1,
      kind: 'container',
      children,
    },
  ];
  for (const node of SMOKE_NODES) {
    const base = {
      id: node.id,
      parentId: 'root',
      transform: node.transform,
      visible: true,
      opacity: node.opacity,
    };
    if (node.kind === 'rectangle') {
      nodes.push({
        ...base,
        kind: 'primitive',
        geometry: {
          kind: 'rectangle',
          width: node.size![0],
          height: node.size![1],
          cornerRadii: [0, 0, 0, 0],
        },
        style: { fill: node.color, stroke: null },
      });
    } else {
      const data = SMOKE_PATHS[node.path!];
      nodes.push({
        ...base,
        kind: 'path',
        geometry: {
          kind: 'path',
          verbs: [...data.verbs],
          points: [...data.points],
          fillRule: node.rule!,
        },
        style: { fill: node.color },
      });
    }
  }
  return { identity: SMOKE_IDENTITY, revision, nodes, rootOrder: ['root'] };
}

function compose(left: SceneAffine, right: SceneAffine): SceneAffine {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

type PhysicalShape = Readonly<{
  loops: Loop[];
  rule: SceneFillRule;
  color: SceneColor;
  opacity: number;
  id: string;
}>;

function physicalShapes(variant: SmokeVariant, dpr: number): PhysicalShape[] {
  const scale = SMOKE_CAMERA.zoom * dpr;
  return SMOKE_NODES.map((node) => {
    const world = compose(variant.transform, node.transform);
    const map = ([x, y]: Point): Point => [
      (world[0] * x + world[2] * y + world[4] - SMOKE_CAMERA.position.x) * scale,
      (world[1] * x + world[3] * y + world[5] - SMOKE_CAMERA.position.y) * scale,
    ];
    const region =
      node.kind === 'rectangle'
        ? { loops: [square(0, 0, node.size![0], node.size![1])], rule: 'nonzero' as const }
        : pathRegion(node.path!, node.rule!);
    return {
      id: node.id,
      loops: region.loops.map((loop) => loop.map(map)),
      rule: region.rule,
      color: node.color,
      opacity: node.opacity,
    };
  });
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)),
  );
  return Math.hypot(p[0] - (a[0] + t * ex), p[1] - (a[1] + t * ey));
}

function winding(p: Point, loop: Loop): number {
  let total = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]!;
    const b = loop[(index + 1) % loop.length]!;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (a[1] <= p[1] && b[1] > p[1] && cross > 0) total += 1;
    else if (a[1] > p[1] && b[1] <= p[1] && cross < 0) total -= 1;
  }
  return total;
}

function inside(p: Point, shape: PhysicalShape): boolean {
  const total = shape.loops.reduce((sum, loop) => sum + winding(p, loop), 0);
  return shape.rule === 'nonzero' ? total !== 0 : total % 2 !== 0;
}

export type SmokePixelClass = 'interior' | 'overlap';

export type SmokeInspection = Readonly<{
  pass: boolean;
  failures: readonly string[];
  gatedPixels: number;
  overlapPixels: number;
  maximumDeviation: number;
  /** Minimum over overlap pixels of the largest channel distance to the double-opacity value, in 1/255. */
  minimumDoubleOpacityDistance: number | null;
  /** Gated pixel indices, for the device-loss comparison. */
  probed: readonly number[];
}>;

const MARGIN_PX = 3;
const TOLERANCE = 2;
const DOUBLE_OPACITY_SEPARATION = 20;

/**
 * Pixel centers at least 3 physical px from every boundary must be within 2/255 of the analytic
 * composite of the scene over opaque black (P1's encoded-sRGB premultiplied source-over). Overlap
 * pixels of the half-opacity path over its opaque rectangle must also differ from the
 * double-opacity value by more than 20/255.
 */
export function inspectSmoke(
  variant: SmokeVariant,
  dpr: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): SmokeInspection {
  const shapes = physicalShapes(variant, dpr);
  const failures: string[] = [];
  const probed: number[] = [];
  let maximumDeviation = 0;
  let overlapPixels = 0;
  let minimumDoubleOpacityDistance: number | null = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p: Point = [x + 0.5, y + 0.5];
      let near = false;
      for (const shape of shapes) {
        for (const loop of shape.loops) {
          for (let index = 0; index < loop.length && !near; index += 1) {
            if (segmentDistance(p, loop[index]!, loop[(index + 1) % loop.length]!) < MARGIN_PX)
              near = true;
          }
        }
        if (near) break;
      }
      if (near) continue;
      let dst = [0, 0, 0, 1];
      let single: number[] | null = null;
      let double: number[] | null = null;
      const covered = new Set<string>();
      for (const shape of shapes) {
        if (!inside(p, shape)) continue;
        covered.add(shape.id);
        const alpha = shape.color.a * shape.opacity;
        const source = [shape.color.r * alpha, shape.color.g * alpha, shape.color.b * alpha, alpha];
        const next = dst.map((value, channel) => source[channel]! + value * (1 - alpha));
        if (shape.id === 'path-half' && covered.has('rect-under-half')) {
          single = next;
          double = next.map((value, channel) => source[channel]! + value * (1 - alpha));
        }
        dst = next;
      }
      const index = (y * width + x) * 4;
      probed.push(y * width + x);
      let deviation = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        deviation = Math.max(deviation, Math.abs(rgba[index + channel]! - dst[channel]! * 255));
      }
      maximumDeviation = Math.max(maximumDeviation, deviation);
      if (deviation > TOLERANCE && failures.length < 16) {
        failures.push(
          `${variant.id} dpr${dpr} (${x},${y}) [${Array.from(rgba.subarray(index, index + 4)).join()}] expected [${dst.map((value) => Math.round(value * 255)).join()}]`,
        );
      }
      if (single !== null && double !== null) {
        overlapPixels += 1;
        let distance = 0;
        for (let channel = 0; channel < 4; channel += 1) {
          distance = Math.max(distance, Math.abs(rgba[index + channel]! - double[channel]! * 255));
        }
        minimumDoubleOpacityDistance =
          minimumDoubleOpacityDistance === null
            ? distance
            : Math.min(minimumDoubleOpacityDistance, distance);
        if (distance <= DOUBLE_OPACITY_SEPARATION && failures.length < 16) {
          failures.push(
            `${variant.id} dpr${dpr} (${x},${y}) overlap within 20/255 of double opacity`,
          );
        }
      }
    }
  }
  if (overlapPixels === 0) failures.push(`${variant.id} dpr${dpr}: no gated overlap pixel`);
  return {
    pass: failures.length === 0,
    failures,
    gatedPixels: probed.length,
    overlapPixels,
    maximumDeviation,
    minimumDoubleOpacityDistance,
    probed,
  };
}

export type SmokeEdgeObservation = Readonly<{
  /** Observation only, never gated (V3-A14 captures edge pixels). */
  gated: false;
  node: string;
  edge: 'axis-aligned' | '30-degree';
  pixels: number;
  /** max |observed - O02 rule| over the pixels, in 1/255 units. */
  maximumAbsolute: number;
  meanAbsolute: number;
}>;

/**
 * Edge observation (not gated): for the opaque F02 nonzero square over black, under identity
 * (axis-aligned edges) or the 30 degree rotation, compares the observed red channel with O02's
 * coverage rule at every pixel center within 1.5 physical px of the square's boundary and at
 * least 3 px from every other node's boundary. The rule, in float64: q the nearest boundary
 * point, v = p - q, s = +-|v| (negative inside), w = (|v.x| + |v.y|) / |v| (c = 1/2 at |v| = 0),
 * c = clamp(1/2 - s / w, 0, 1).
 */
export function observeEdges(
  variant: SmokeVariant,
  dpr: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): SmokeEdgeObservation | null {
  const edge =
    variant.id === 'identity' ? 'axis-aligned' : variant.id === 'rotate-30' ? '30-degree' : null;
  if (edge === null) return null;
  const shapes = physicalShapes(variant, dpr);
  const target = shapes.find((shape) => shape.id === 'f02-nonzero')!;
  // Under nonzero the F02 region is the outer square; the inner contour is not a boundary.
  const boundary = target.loops[0]!;
  const others = shapes.filter((shape) => shape !== target);
  let pixels = 0;
  let maximumAbsolute = 0;
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p: Point = [x + 0.5, y + 0.5];
      let best = Number.POSITIVE_INFINITY;
      let nearest: Point = p;
      for (let index = 0; index < boundary.length; index += 1) {
        const a = boundary[index]!;
        const b = boundary[(index + 1) % boundary.length]!;
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)),
        );
        const q: Point = [a[0] + t * ex, a[1] + t * ey];
        const distance = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (distance < best) {
          best = distance;
          nearest = q;
        }
      }
      if (best >= 1.5) continue;
      let near = false;
      for (const shape of others)
        for (const loop of shape.loops)
          for (let index = 0; index < loop.length && !near; index += 1)
            if (segmentDistance(p, loop[index]!, loop[(index + 1) % loop.length]!) < MARGIN_PX)
              near = true;
      if (near) continue;
      const vx = p[0] - nearest[0];
      const vy = p[1] - nearest[1];
      const signed = inside(p, target) ? -best : best;
      const coverage =
        best === 0
          ? 0.5
          : Math.min(1, Math.max(0, 0.5 - signed / ((Math.abs(vx) + Math.abs(vy)) / best)));
      const deviation = Math.abs(rgba[(y * width + x) * 4]! - coverage * 255);
      pixels += 1;
      total += deviation;
      maximumAbsolute = Math.max(maximumAbsolute, deviation);
    }
  }
  return {
    gated: false,
    node: target.id,
    edge,
    pixels,
    maximumAbsolute,
    meanAbsolute: pixels === 0 ? 0 : total / pixels,
  };
}
