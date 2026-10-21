import type {
  PathStroke,
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneColor,
  ScenePathVerb,
  SceneStrokeCap,
  SceneStrokeJoin,
} from '@vector-studio/contracts';

// B2 stroke contract, unit ST-U8: the playground stroke page's scene. Caps, joins, a miter limit
// next to its switch point, thin and wide strokes, cubic strokes (including cusps), fill plus
// stroke at opacity 1 and single-paint paths at opacity 0.5. Functional evidence only: precision
// is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence.
//
// Cubic strokes cost more than lines (the open ST-U9 decision), so several cubic and crossing
// strokes report the D8-interim `work-limit` notice at some views. That is shown, not hidden:
// the page lists every D8 notice, and the paths below are chosen to show both outcomes.

export const B2_EVIDENCE_LABEL =
  'UNVERIFIED: functional ST-U8 stroke playground evidence only; precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed. work-limit notices are the D8-interim state of the open ST-U9 decision.';

export const B2_SURFACE = Object.freeze({ width: 720, height: 600 });

type PathData = Readonly<{ verbs: ScenePathVerb[]; points: number[] }>;
type Point = readonly [number, number];

/** An open or closed polyline through `vertices`. */
function polyline(vertices: readonly Point[], closed = false): PathData {
  return {
    verbs: [
      'move',
      ...vertices.slice(1).map(() => 'line' as const),
      ...(closed ? (['close'] as const) : []),
    ],
    points: vertices.flat(),
  };
}

/** A chevron: apex at (0, `apexY`), two arms of `length` that open downward by `halfAngle` each. */
function chevron(halfAngle: number, length: number, apexY: number): PathData {
  const radians = (halfAngle * Math.PI) / 180;
  const dx = length * Math.sin(radians);
  const dy = length * Math.cos(radians);
  return polyline([
    [-dx, apexY + dy],
    [0, apexY],
    [dx, apexY + dy],
  ]);
}

const KAPPA = 0.5522847498307936;

/** A circle of four cubics starting at (cx + r, cy). */
function circle(cx: number, cy: number, r: number): PathData {
  const anchors: Point[] = [
    [cx + r, cy],
    [cx, cy + r],
    [cx - r, cy],
    [cx, cy - r],
    [cx + r, cy],
  ];
  const verbs: ScenePathVerb[] = ['move'];
  const points = [cx + r, cy];
  for (let index = 0; index < 4; index += 1) {
    const [x0, y0] = anchors[index]!;
    const [x1, y1] = anchors[index + 1]!;
    const t0 = [-(y0 - cy), x0 - cx] as const;
    const t1 = [-(y1 - cy), x1 - cx] as const;
    verbs.push('cubic');
    points.push(x0 + KAPPA * t0[0], y0 + KAPPA * t0[1], x1 - KAPPA * t1[0], y1 - KAPPA * t1[1]);
    points.push(x1, y1);
  }
  verbs.push('close');
  return { verbs, points };
}

/** One open cubic through four control points. */
function cubic(p0: Point, p1: Point, p2: Point, p3: Point): PathData {
  return { verbs: ['move', 'cubic'], points: [...p0, ...p1, ...p2, ...p3] };
}

const rgb = (r: number, g: number, b: number, a = 1): SceneColor => ({ r, g, b, a });

function stroke(
  color: SceneColor,
  width: number,
  cap: SceneStrokeCap,
  join: SceneStrokeJoin,
  miterLimit = 4,
): PathStroke {
  return { color, width, cap, join, miterLimit };
}

const ZIGZAG = polyline([
  [-50, 22],
  [-18, -22],
  [14, 22],
  [46, -22],
]);
const SQUARE = polyline(
  [
    [-30, -30],
    [30, -30],
    [30, 30],
    [-30, 30],
  ],
  true,
);
/**
 * ST-F16's curve translated by (-0.5, -0.5), exact in binary: one interior reversal (a cusp) at
 * t = 1/2, center (0, 0.25).
 */
const F16 = cubic([-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5]);
/** ST-U4/cusp-shared-a: an exact reversal at t = 19/64. */
const CUSP_A = cubic(
  [0, 0],
  [-0.037109375, -0.22265625],
  [-0.0302734375, -0.21875],
  [0.1455078125, 1.01171875],
);

export type B2PathSpec = Readonly<{
  id: string;
  label: string;
  data: PathData;
  fill: SceneColor | null;
  stroke: PathStroke | null;
  /** Uniform scale of the node transform; the stroke width is in node-local units. */
  scale: number;
  center: Point;
  opacity: number;
  /** World-space probes: [x, y, what] with the paint expected at that point (overview only). */
  probes: readonly (readonly [number, number, 'fill' | 'stroke' | 'background' | 'stroke-half'])[];
}>;

export const B2_COLUMNS = [110, 270, 430, 590] as const;
export const B2_ROWS = [75, 185, 295, 405, 515] as const;

const BLUE = rgb(0.25, 0.6, 1);
const ORANGE = rgb(1, 0.6, 0.2);
const GREEN = rgb(0.35, 0.85, 0.5);
const PINK = rgb(1, 0.45, 0.65);
const YELLOW = rgb(1, 0.85, 0.3);
const RED = rgb(0.85, 0.2, 0.25);

type Cell = Omit<B2PathSpec, 'center' | 'scale' | 'probes' | 'fill' | 'opacity'> &
  Partial<Pick<B2PathSpec, 'scale' | 'probes' | 'fill' | 'opacity'>>;

/** Row-major cells in paint order. */
const CELLS: readonly (readonly Cell[])[] = [
  [
    {
      id: 'cap-butt',
      label: 'Butt caps, zigzag, width 14, miter joins',
      data: ZIGZAG,
      stroke: stroke(BLUE, 14, 'butt', 'miter'),
      probes: [[110, 77.75, 'stroke']],
    },
    {
      id: 'cap-round',
      label: 'Round caps, same zigzag',
      data: ZIGZAG,
      stroke: stroke(ORANGE, 14, 'round', 'miter'),
    },
    {
      id: 'cap-square',
      label: 'Square caps, same zigzag',
      data: ZIGZAG,
      stroke: stroke(GREEN, 14, 'square', 'miter'),
    },
    {
      id: 'thin-quarter-px',
      label: 'Thin: width 0.25, a quarter of a pixel at zoom 1',
      data: ZIGZAG,
      stroke: stroke(YELLOW, 0.25, 'butt', 'miter'),
    },
  ],
  [
    {
      id: 'join-miter',
      label: 'Miter join, 90 degrees, width 12',
      data: chevron(45, 52, -26),
      stroke: stroke(BLUE, 12, 'butt', 'miter'),
    },
    {
      id: 'join-round',
      label: 'Round join, same chevron (known defect ST-U3c: not drawn)',
      data: chevron(45, 52, -26),
      stroke: stroke(ORANGE, 12, 'butt', 'round'),
    },
    {
      id: 'join-bevel',
      label: 'Bevel join, same chevron',
      data: chevron(45, 52, -26),
      stroke: stroke(GREEN, 12, 'butt', 'bevel'),
    },
    {
      id: 'miter-extreme',
      label: 'Extreme miter: half angle 6 degrees, width 4, limit 100 (spike 19 beyond the apex)',
      data: chevron(6, 60, -30),
      stroke: stroke(PINK, 4, 'butt', 'miter', 100),
    },
  ],
  [
    {
      id: 'miter-limit-keeps',
      label: 'Miter limit 4 at half angle 15 degrees (1/sin = 3.86): miter kept',
      data: chevron(15, 60, -30),
      stroke: stroke(BLUE, 12, 'butt', 'miter', 4),
    },
    {
      id: 'miter-limit-bevels',
      label: 'Miter limit 4 at half angle 14 degrees (1/sin = 4.13): beveled',
      data: chevron(14, 60, -30),
      stroke: stroke(ORANGE, 12, 'butt', 'miter', 4),
    },
    {
      id: 'wide-cubic',
      label: 'Wide stroke on a cubic S-curve, width 24, round caps',
      data: cubic([-55, 25], [-10, -60], [10, 60], [55, -25]),
      stroke: stroke(GREEN, 24, 'round', 'round'),
    },
    {
      id: 'thin-one-px',
      label: 'Thin: width 1 round-capped zigzag',
      data: ZIGZAG,
      stroke: stroke(YELLOW, 1, 'round', 'round'),
    },
  ],
  [
    {
      id: 'fill-stroke-square',
      label: 'Fill plus stroke at opacity 1: red square fill, blue stroke width 10, miter',
      data: SQUARE,
      fill: RED,
      stroke: stroke(BLUE, 10, 'butt', 'miter'),
      probes: [
        [110, 405, 'fill'],
        [110 - 30, 405, 'stroke'],
      ],
    },
    {
      id: 'fill-stroke-circle',
      label: 'Fill plus stroke at opacity 1: cubic circle radius 30, stroke width 8',
      data: circle(0, 0, 30),
      fill: RED,
      stroke: stroke(ORANGE, 8, 'butt', 'round'),
    },
    {
      id: 'fill-only-half',
      label: 'Single paint at opacity 0.5: fill only',
      data: SQUARE,
      fill: GREEN,
      stroke: null,
      opacity: 0.5,
      probes: [[430, 405, 'fill']],
    },
    {
      id: 'stroke-only-half',
      label: 'Single paint at opacity 0.5: stroke only, width 10',
      data: SQUARE,
      stroke: stroke(PINK, 10, 'butt', 'miter'),
      opacity: 0.5,
      probes: [[590 - 30, 405, 'stroke-half']],
    },
  ],
  [
    {
      id: 'both-half',
      label: 'Fill plus stroke at opacity 0.5: composition-unsupported until ST-U7 (not drawn)',
      data: SQUARE,
      fill: RED,
      stroke: stroke(BLUE, 10, 'butt', 'miter'),
      opacity: 0.5,
    },
    {
      id: 'cusp-f16p',
      label: 'ST-F16p: cubic cusp, width 0.125, scale 3 (ok at production limits at e = -5)',
      data: F16,
      stroke: stroke(ORANGE, 0.125, 'butt', 'miter'),
      scale: 3,
    },
    {
      id: 'cusp-shared-a',
      label: 'ST-U4/cusp-shared-a: cubic cusp, width 1',
      data: CUSP_A,
      stroke: stroke(GREEN, 1, 'butt', 'miter'),
    },
    {
      id: 'cusp-f16-large',
      label: 'ST-F16 at scale 60: cubic cusp, width 0.125 local (7.5 px)',
      data: F16,
      stroke: stroke(PINK, 0.125, 'butt', 'miter'),
      scale: 60,
    },
  ],
];

export const B2_PATHS: readonly B2PathSpec[] = CELLS.flatMap((row, rowIndex) =>
  row.map((cell, columnIndex): B2PathSpec => {
    const center: Point = [B2_COLUMNS[columnIndex]!, B2_ROWS[rowIndex]!];
    return {
      fill: null,
      opacity: 1,
      scale: 1,
      probes: [],
      ...cell,
      center,
    };
  }),
);

export type B2View = Readonly<{
  id: string;
  label: string;
  /** World point shown at the surface center. */
  focus: Readonly<{ x: number; y: number }>;
  zoom: number;
}>;

export const SCENE_CENTER = Object.freeze({ x: 360, y: 300 });

const at = (id: string): B2PathSpec => B2_PATHS.find((path) => path.id === id)!;

/** The miter tip of `miter-extreme`: 19.1 units above its apex (half angle 6 degrees, width 4). */
const EXTREME_TIP = {
  x: at('miter-extreme').center[0],
  y: at('miter-extreme').center[1] - 30 - 2 / Math.sin((6 * Math.PI) / 180),
};

/** Zoom 0.01, 1 and 64 are the contract's zooms; the others are intermediate observations. */
export const B2_VIEWS: readonly B2View[] = [
  { id: 'overview-zoom-1', label: 'Whole scene, zoom 1', focus: SCENE_CENTER, zoom: 1 },
  { id: 'zoom-0.01', label: 'Zoom 0.01: the scene is 7 px wide', focus: SCENE_CENTER, zoom: 0.01 },
  { id: 'zoom-0.25', label: 'Zoom 0.25', focus: SCENE_CENTER, zoom: 0.25 },
  {
    id: 'zoom-4-joins',
    label: 'Zoom 4 on the joins row',
    focus: { x: 270, y: B2_ROWS[1] },
    zoom: 4,
  },
  {
    id: 'zoom-64-extreme-miter-tip',
    label: 'Zoom 64 at the extreme miter tip',
    focus: EXTREME_TIP,
    zoom: 64,
  },
  {
    id: 'zoom-64-thin',
    label: 'Zoom 64 on the quarter-pixel stroke',
    focus: { x: B2_COLUMNS[3] - 18, y: B2_ROWS[0] - 22 },
    zoom: 64,
  },
  {
    id: 'zoom-2-cusp',
    label: 'Zoom 2 on the ST-F16p cusp',
    focus: { x: at('cusp-f16p').center[0], y: at('cusp-f16p').center[1] + 0.75 },
    zoom: 2,
  },
  {
    id: 'zoom-64-cusp',
    label: 'Zoom 64 on the ST-F16p cusp',
    focus: {
      x: at('cusp-f16p').center[0],
      y: at('cusp-f16p').center[1] + 0.75,
    },
    zoom: 64,
  },
];

/** The view as a camera: the world point at the surface's top-left corner and the zoom. */
export function viewCamera(view: B2View): RenderCamera {
  return {
    position: {
      x: view.focus.x - B2_SURFACE.width / 2 / view.zoom,
      y: view.focus.y - B2_SURFACE.height / 2 / view.zoom,
    },
    zoom: view.zoom,
  };
}

/** Maps a world point through the view to CSS pixels on the surface. */
export function worldToSurface(
  view: B2View,
  point: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> {
  const camera = viewCamera(view);
  return {
    x: (point.x - camera.position.x) * view.zoom,
    y: (point.y - camera.position.y) * view.zoom,
  };
}

export const B2_BACKGROUND = Object.freeze({ id: 'backdrop', color: rgb(0.1, 0.12, 0.17) });

export function b2Snapshot(revision: number): RenderSceneSnapshot {
  const nodes: RenderNodeSnapshot[] = [
    {
      id: 'world',
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'container',
      children: [B2_BACKGROUND.id, ...B2_PATHS.map((path) => path.id)],
    },
    {
      id: B2_BACKGROUND.id,
      parentId: 'world',
      transform: [1, 0, 0, 1, 20, 20],
      visible: true,
      opacity: 1,
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: 680, height: 560, cornerRadii: [16, 16, 16, 16] },
      style: { fill: B2_BACKGROUND.color, stroke: null },
    },
    ...B2_PATHS.map((path): RenderNodeSnapshot => ({
      id: path.id,
      parentId: 'world',
      transform: [path.scale, 0, 0, path.scale, path.center[0], path.center[1]],
      visible: true,
      opacity: path.opacity,
      kind: 'path',
      geometry: {
        kind: 'path',
        verbs: path.data.verbs,
        points: path.data.points,
        fillRule: 'nonzero',
      },
      style: { fill: path.fill, stroke: path.stroke },
    })),
  ];
  return {
    identity: { documentId: 'p3-b2-strokes', pageId: 'page-1' },
    revision,
    nodes,
    rootOrder: ['world'],
  };
}
