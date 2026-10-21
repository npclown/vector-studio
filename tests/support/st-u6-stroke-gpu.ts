import type {
  PathStroke,
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneColor,
} from '@vector-studio/contracts';

// B2 stroke contract, ST-A10 (unit ST-U6): the headed GPU stroke fixtures and their analytic
// pixel oracle, drawn by the V3 smoke fixture page in its `?stroke=1` mode with static
// test-double fill and stroke ports (no WASM). The approved example of the visible semantics is
// a red fill under a blue stroke, here with stroke alpha 0.5: at opacity 1 its stroke-only,
// overlap and fill-only pixels are exact two-draw composites; a single-paint path is exact at
// opacity 0.5; and with both paints
// at opacity 0.5 the path draws the joint fill draw and the stroke draw (ST-U7), the
// stroke-over-fill composite with opacity applied once. Functional evidence only: precision is
// UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence; no Q4 coverage threshold is claimed. Pixels
// within 3 physical px of any boundary are captured, never gated.

export const ST_U6_EVIDENCE_LABEL =
  'UNVERIFIED: functional ST-A10 stroke fixtures only; precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed.';

type Point = readonly [number, number];
type Loop = readonly Point[];

const square = (x0: number, y0: number, x1: number, y1: number): Loop => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const F01 = {
  verbs: ['move', 'line', 'line', 'line', 'close'] as const,
  points: [0, 0, 10, 0, 10, 10, 0, 10],
};

const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const BLUE: SceneColor = { r: 0, g: 0, b: 1, a: 1 };

/** The one stroke the static double meshes: width 2, butt caps, miter joins with limit 4. */
const STROKE: PathStroke = { color: BLUE, width: 2, cap: 'butt', join: 'miter', miterLimit: 4 };
const HALF_BLUE: SceneColor = { r: 0, g: 0, b: 1, a: 0.5 };

type StrokeFixtureNode = Readonly<{
  id: string;
  /** Local-to-root transform; 1 local unit is 8 CSS px. */
  x: number;
  fill: SceneColor | null;
  stroke: PathStroke | null;
  opacity: number;
  /** Every fixture node is drawn (ST-U7 draws both paints at 0 < opacity < 1). */
  drawn: boolean;
}>;

/** Paint order left to right. */
export const STROKE_FIXTURE_NODES: readonly StrokeFixtureNode[] = [
  // Review M2: the stroke color has alpha 0.5 at node opacity 1, so the overlap checks that two
  // draws are exact for any paint alphas (section 9.6): S + F * (1 - S.a) over the destination.
  {
    id: 'both-opaque',
    x: 20,
    fill: RED,
    stroke: { ...STROKE, color: HALF_BLUE },
    opacity: 1,
    drawn: true,
  },
  { id: 'fill-half', x: 160, fill: RED, stroke: null, opacity: 0.5, drawn: true },
  { id: 'stroke-half', x: 300, fill: null, stroke: STROKE, opacity: 0.5, drawn: true },
  { id: 'both-half', x: 440, fill: RED, stroke: STROKE, opacity: 0.5, drawn: true },
];

export const STROKE_FIXTURE_MESH_DRAWS = 6;
export const STROKE_FIXTURE_CAMERA: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };
const SCALE = 8;
const TOP = 30;

export function strokeFixtureSnapshot(revision: number): RenderSceneSnapshot {
  const nodes: RenderNodeSnapshot[] = [
    {
      id: 'root',
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'container',
      children: STROKE_FIXTURE_NODES.map((node) => node.id),
    },
  ];
  for (const node of STROKE_FIXTURE_NODES) {
    nodes.push({
      id: node.id,
      parentId: 'root',
      transform: [SCALE, 0, 0, SCALE, node.x, TOP] satisfies SceneAffine,
      visible: true,
      opacity: node.opacity,
      kind: 'path',
      geometry: {
        kind: 'path',
        verbs: [...F01.verbs],
        points: [...F01.points],
        fillRule: 'nonzero',
      },
      style: { fill: node.fill, stroke: node.stroke },
    });
  }
  return {
    identity: { documentId: 'p3-st-u6-stroke', pageId: 'page' },
    revision,
    nodes,
    rootOrder: ['root'],
  };
}

export type StrokePixelClass = 'exterior' | 'fill-only' | 'stroke-only' | 'overlap';

export type StrokeInspection = Readonly<{
  failures: readonly string[];
  gatedPixels: number;
  /** Gated pixels per node and class. */
  classes: Readonly<Record<string, Partial<Record<StrokePixelClass, number>>>>;
  maximumDeviation: number;
  probed: readonly number[];
}>;

const MARGIN_PX = 3;
const TOLERANCE = 2;

function inBox(p: Point, [x0, y0, x1, y1]: readonly [number, number, number, number]): boolean {
  return p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1;
}

function nearLoop(p: Point, loop: Loop): boolean {
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]!;
    const b = loop[(index + 1) % loop.length]!;
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

/**
 * Pixel centers at least 3 physical px from every boundary (the fill square and both stroke
 * ring loops of every node) must be within 2/255 of the analytic composite over opaque black:
 * the stroke-over-fill value L = S + F (1 - S.a), scaled by the node opacity once (P = o L), then
 * source-over (P + dst (1 - P.a)) with P1's encoded-sRGB blending.
 */
export function inspectStrokeFixture(
  dpr: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): StrokeInspection {
  const scale = STROKE_FIXTURE_CAMERA.zoom * dpr;
  const shapes = STROKE_FIXTURE_NODES.map((node) => {
    const box = (x0: number, x1: number) =>
      [
        (node.x + SCALE * x0) * scale,
        (TOP + SCALE * x0) * scale,
        (node.x + SCALE * x1) * scale,
        (TOP + SCALE * x1) * scale,
      ] as const;
    const fill = box(0, 10);
    const outer = box(-1, 11);
    const inner = box(1, 9);
    const loops = [fill, outer, inner].map(([x0, y0, x1, y1]) => square(x0, y0, x1, y1));
    return { node, fill, outer, inner, loops };
  });
  const failures: string[] = [];
  const probed: number[] = [];
  const classes: Record<string, Partial<Record<StrokePixelClass, number>>> = {};
  let maximumDeviation = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p: Point = [x + 0.5, y + 0.5];
      if (shapes.some((shape) => shape.loops.some((loop) => nearLoop(p, loop)))) continue;
      let dst = [0, 0, 0, 1];
      let owner = 'background';
      let pixelClass: StrokePixelClass = 'exterior';
      for (const shape of shapes) {
        const inFill = shape.node.fill !== null && inBox(p, shape.fill);
        const inStroke =
          shape.node.stroke !== null && inBox(p, shape.outer) && !inBox(p, shape.inner);
        if (!inFill && !inStroke) continue;
        owner = shape.node.id;
        pixelClass = inFill && inStroke ? 'overlap' : inFill ? 'fill-only' : 'stroke-only';
        // L = S + F (1 - S.a), P = o L, dst = P + dst (1 - P.a). For opacity 1 or one paint it
        // equals the two source-over draws; for both paints at 0 < o < 1 it is the joint value.
        const premultiplied = (inside: boolean, color: SceneColor | null) =>
          !inside || color === null
            ? [0, 0, 0, 0]
            : [color.r * color.a, color.g * color.a, color.b * color.a, color.a];
        const f = premultiplied(inFill, shape.node.fill);
        const s = premultiplied(inStroke, shape.node.stroke?.color ?? null);
        const joint = s.map(
          (value, channel) => (value + f[channel]! * (1 - s[3]!)) * shape.node.opacity,
        );
        dst = dst.map((value, channel) => joint[channel]! + value * (1 - joint[3]!));
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
          `dpr${dpr} (${x},${y}) ${owner} ${pixelClass} [${Array.from(rgba.subarray(index, index + 4)).join()}] expected [${dst.map((value) => Math.round(value * 255)).join()}]`,
        );
      }
    }
  }
  // Every class the fixtures name must be gated somewhere.
  const required: ReadonlyArray<readonly [string, StrokePixelClass]> = [
    ['both-opaque', 'stroke-only'],
    ['both-opaque', 'overlap'],
    ['both-opaque', 'fill-only'],
    ['fill-half', 'fill-only'],
    ['stroke-half', 'stroke-only'],
    ['both-half', 'stroke-only'],
    ['both-half', 'overlap'],
    ['both-half', 'fill-only'],
  ];
  for (const [node, pixelClass] of required) {
    if ((classes[node]?.[pixelClass] ?? 0) === 0) {
      failures.push(`dpr${dpr}: no gated ${pixelClass} pixel for ${node}`);
    }
  }
  return { failures, gatedPixels: probed.length, classes, maximumDeviation, probed };
}
