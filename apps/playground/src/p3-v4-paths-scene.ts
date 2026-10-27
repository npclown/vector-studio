import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneColor,
  SceneFillRule,
  ScenePathVerb,
} from '@vector-studio/contracts';

// P3 D8 checkpoint V4: the playground path page's scene. Fills (including cubic paths), holes,
// both fill rules, and a container transform for rotation; the camera gives pan and zoom.
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target
// until B4 has A04 evidence.
//
// Sizes respect the fill-kernel caps after B1 (at most 64 source segments, 4 contours and 264
// flat commands per path, cubic_fill.rs). The tolerance is 2^e local units with the largest e
// such that 2^e * zoom * DPR <= 1/8, so each zoom doubling roughly multiplies a cubic's flat
// segments by sqrt(2). Probed against the fill-v0+r2 kernel after B1, every shape below meshes
// for e >= -7, that is up to zoom * DPR = 16. A path beyond a kernel cap would still fail with
// the `work-limit` notice and not be drawn. A mesh with more than 128 boundary
// vertices draws region-only with the `fringe-work-cap` notice (V3-Q2 (c)); the teardrop
// reaches 198 at e = -7, but the spec's views (zoom <= 3) stay under it.

export const V4_EVIDENCE_LABEL =
  'UNVERIFIED: functional V4 playground evidence only; precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed.';

export const V4_SURFACE = Object.freeze({ width: 720, height: 450 });

type PathData = Readonly<{ verbs: ScenePathVerb[]; points: number[] }>;

const KAPPA = 0.5522847498307936;

/** A circle of four cubics starting at (cx + r, cy); `reverse` flips its winding. */
function circle(cx: number, cy: number, r: number, reverse = false): PathData {
  const s = reverse ? -1 : 1;
  const anchors: Array<readonly [number, number]> = [
    [cx + r, cy],
    [cx, cy + s * r],
    [cx - r, cy],
    [cx, cy - s * r],
    [cx + r, cy],
  ];
  const verbs: ScenePathVerb[] = ['move'];
  const points = [cx + r, cy];
  for (let index = 0; index < 4; index += 1) {
    const [x0, y0] = anchors[index]!;
    const [x1, y1] = anchors[index + 1]!;
    // Tangents of the circle at both anchors, in the direction of travel.
    const t0 = [-(y0 - cy) * s, (x0 - cx) * s] as const;
    const t1 = [-(y1 - cy) * s, (x1 - cx) * s] as const;
    verbs.push('cubic');
    points.push(x0 + KAPPA * t0[0], y0 + KAPPA * t0[1], x1 - KAPPA * t1[0], y1 - KAPPA * t1[1]);
    points.push(x1, y1);
  }
  verbs.push('close');
  return { verbs, points };
}

/** A closed polygon; `reverse` reverses its vertex order. */
function polygon(vertices: readonly (readonly [number, number])[], reverse = false): PathData {
  const ordered = reverse ? [...vertices].reverse() : vertices;
  return {
    verbs: ['move', ...ordered.slice(1).map(() => 'line' as const), 'close'],
    points: ordered.flat(),
  };
}

const square = (x0: number, y0: number, x1: number, y1: number, reverse = false) =>
  polygon(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    reverse,
  );

function join(...parts: PathData[]): PathData {
  return {
    verbs: parts.flatMap((part) => part.verbs),
    points: parts.flatMap((part) => part.points),
  };
}

/** A five-pointed star {5/2}: one self-intersecting contour of five lines. */
function pentagram(radius: number): PathData {
  const vertices: Array<readonly [number, number]> = [];
  for (let index = 0; index < 5; index += 1) {
    const angle = -Math.PI / 2 + (index * 4 * Math.PI) / 5;
    vertices.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return polygon(vertices);
}

/** A cubic teardrop: one contour of three cubics. */
const TEARDROP: PathData = {
  verbs: ['move', 'cubic', 'cubic', 'cubic', 'close'],
  points: [0, -30, 18, -14, 26, 2, 22, 14, 18, 26, -18, 26, -22, 14, -26, 2, -18, -14, 0, -30],
};

/** A cubic lens: two cubics. */
const LENS: PathData = {
  verbs: ['move', 'cubic', 'cubic', 'close'],
  points: [-40, 0, -20, -30, 20, -30, 40, 0, 20, 30, -20, 30, -40, 0],
};

export type V4PathSpec = Readonly<{
  id: string;
  label: string;
  data: PathData;
  fillRule: SceneFillRule;
  center: readonly [number, number];
  color: SceneColor;
  opacity: number;
  /** World-space probes: [x, y, expected] with 'fill' inside the region and 'hole' in a hole. */
  probes: readonly (readonly [number, number, 'fill' | 'hole'])[];
}>;

const rgb = (r: number, g: number, b: number): SceneColor => ({ r, g, b, a: 1 });

const SQUARE_WITH_CIRCLE = join(square(-32, -32, 32, 32), circle(0, 0, 10));
const SQUARE_WITH_REVERSED_CIRCLE = join(square(-32, -32, 32, 32), circle(0, 0, 10, true));
const FRAME_WITH_TWO_HOLES = join(
  square(-40, -30, 40, 30),
  square(-30, -20, -5, 20),
  square(5, -20, 30, 20),
);

/** In paint order. Row 1 at y = 120, row 2 at y = 320; columns at x = 110, 270, 430, 590. */
export const V4_PATHS: readonly V4PathSpec[] = [
  {
    id: 'cubic-teardrop',
    label: 'Cubic teardrop, nonzero',
    data: TEARDROP,
    fillRule: 'nonzero',
    center: [110, 120],
    color: rgb(0.95, 0.45, 0.2),
    opacity: 1,
    probes: [[110, 125, 'fill']],
  },
  {
    id: 'cubic-hole-evenodd',
    label: 'Square with a cubic circle, same winding, evenodd: hole',
    data: SQUARE_WITH_CIRCLE,
    fillRule: 'evenodd',
    center: [270, 120],
    color: rgb(0.2, 0.7, 0.95),
    opacity: 1,
    probes: [
      [270, 120, 'hole'],
      [270 - 26, 120 - 26, 'fill'],
    ],
  },
  {
    id: 'cubic-hole-nonzero',
    label: 'Same geometry, nonzero: no hole',
    data: SQUARE_WITH_CIRCLE,
    fillRule: 'nonzero',
    center: [430, 120],
    color: rgb(0.3, 0.85, 0.45),
    opacity: 1,
    probes: [
      [430, 120, 'fill'],
      [430 - 26, 120 - 26, 'fill'],
    ],
  },
  {
    id: 'cubic-hole-reversed',
    label: 'Square with a reversed cubic circle, nonzero: hole',
    data: SQUARE_WITH_REVERSED_CIRCLE,
    fillRule: 'nonzero',
    center: [590, 120],
    color: rgb(0.85, 0.35, 0.85),
    opacity: 1,
    probes: [
      [590, 120, 'hole'],
      [590 - 26, 120 - 26, 'fill'],
    ],
  },
  {
    id: 'star-nonzero',
    label: 'Pentagram, nonzero: center filled',
    data: pentagram(45),
    fillRule: 'nonzero',
    center: [110, 320],
    color: rgb(0.95, 0.85, 0.2),
    opacity: 1,
    probes: [
      [110, 320, 'fill'],
      [110, 320 - 30, 'fill'],
    ],
  },
  {
    id: 'star-evenodd',
    label: 'Pentagram, evenodd: center hole',
    data: pentagram(45),
    fillRule: 'evenodd',
    center: [270, 320],
    color: rgb(0.95, 0.6, 0.15),
    opacity: 1,
    probes: [
      [270, 320, 'hole'],
      [270, 320 - 30, 'fill'],
    ],
  },
  {
    id: 'frame-two-holes',
    label: 'Frame with two holes, evenodd',
    data: FRAME_WITH_TWO_HOLES,
    fillRule: 'evenodd',
    center: [450, 320],
    color: rgb(0.55, 0.6, 1),
    opacity: 1,
    probes: [
      [450 - 17, 320, 'hole'],
      [450 + 17, 320 - 14, 'hole'],
      [450, 320, 'fill'],
    ],
  },
  {
    id: 'cubic-lens-translucent',
    label: 'Cubic lens at opacity 0.6 over the frame',
    data: LENS,
    fillRule: 'nonzero',
    center: [500, 330],
    color: rgb(1, 0.3, 0.35),
    opacity: 0.6,
    probes: [[525, 330, 'fill']],
  },
];

export type V4View = Readonly<{
  id: string;
  /** World point at the surface's top-left corner. */
  position: Readonly<{ x: number; y: number }>;
  zoom: number;
  /** Rotation of the world container about the scene center, in degrees. */
  rotation: number;
}>;

export const SCENE_CENTER = Object.freeze({ x: 360, y: 225 });

/** A view that shows world point `focus` at the surface center. */
export function viewAt(
  id: string,
  focus: Readonly<{ x: number; y: number }>,
  zoom: number,
  rotation: number,
): V4View {
  return {
    id,
    position: {
      x: focus.x - V4_SURFACE.width / 2 / zoom,
      y: focus.y - V4_SURFACE.height / 2 / zoom,
    },
    zoom,
    rotation,
  };
}

export function viewCamera(view: V4View): RenderCamera {
  return { position: view.position, zoom: view.zoom };
}

/** The world container's transform: a rotation about the scene center. */
export function rotationTransform(degrees: number): SceneAffine {
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const { x, y } = SCENE_CENTER;
  return [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
}

export const V4_BACKGROUND = Object.freeze({ id: 'backdrop', color: rgb(0.1, 0.12, 0.17) });

export function v4Snapshot(rotation: number, revision: number): RenderSceneSnapshot {
  const nodes: RenderNodeSnapshot[] = [
    {
      id: 'world',
      parentId: null,
      transform: rotationTransform(rotation),
      visible: true,
      opacity: 1,
      kind: 'container',
      clip: null,
      children: [V4_BACKGROUND.id, ...V4_PATHS.map((path) => path.id)],
    },
    {
      id: V4_BACKGROUND.id,
      parentId: 'world',
      transform: [1, 0, 0, 1, 20, 20],
      visible: true,
      opacity: 1,
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: 680, height: 410, cornerRadii: [16, 16, 16, 16] },
      style: { fill: V4_BACKGROUND.color, stroke: null },
    },
    ...V4_PATHS.map((path): RenderNodeSnapshot => ({
      id: path.id,
      parentId: 'world',
      transform: [1, 0, 0, 1, path.center[0], path.center[1]],
      visible: true,
      opacity: path.opacity,
      kind: 'path',
      geometry: {
        kind: 'path',
        verbs: path.data.verbs,
        points: path.data.points,
        fillRule: path.fillRule,
      },
      style: { fill: path.color, stroke: null },
    })),
  ];
  return {
    identity: { documentId: 'p3-v4-paths', pageId: 'page-1' },
    revision,
    nodes,
    rootOrder: ['world'],
  };
}

/** Maps a world point through the view to CSS pixels on the surface. */
export function worldToSurface(
  view: V4View,
  point: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> {
  const [a, b, c, d, e, f] = rotationTransform(view.rotation);
  const x = a * point.x + c * point.y + e;
  const y = b * point.x + d * point.y + f;
  return { x: (x - view.position.x) * view.zoom, y: (y - view.position.y) * view.zoom };
}
