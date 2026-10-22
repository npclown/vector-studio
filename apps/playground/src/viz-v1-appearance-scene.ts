import type {
  RenderCamera,
  SceneColor,
  SceneFillRule,
  ScenePathVerb,
  SceneStrokeCap,
  SceneStrokeJoin,
} from '@vector-studio/contracts';
import { B2_PATHS } from './p3-b2-strokes-scene.js';
import { V4_PATHS } from './p3-v4-paths-scene.js';

// Visualization track V-1 (docs/plans/viz-v1-path-appearance-contract.md, section 3.1): the
// scene of the path appearance page. It adds no geometry: every target's path data comes from the
// exported specs of the ST-U8 stroke page (B2_PATHS) and the V4 path page (V4_PATHS). This module
// has no DOM, GPU or WASM import, so unit tests can load it. Functional evidence only: precision
// is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence.

export const VIZ_V1_EVIDENCE_LABEL =
  'UNVERIFIED: functional V-1 path appearance page evidence only; precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed. work-limit and fringe-work-cap notices are the D8-interim state of the open ST-U9 decision.';

export const VIZ_V1_SURFACE = Object.freeze({ width: 720, height: 600 });

export type TargetPathData = Readonly<{
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
}>;

/** The editable appearance of one path, as plain JSON data (no DOM, GPU or WASM object). */
export type StrokeFields = Readonly<{
  color: SceneColor;
  width: number;
  cap: SceneStrokeCap;
  join: SceneStrokeJoin;
  miterLimit: number;
}>;
export type AppearanceState = Readonly<{
  fillOn: boolean;
  fill: SceneColor;
  fillRule: SceneFillRule;
  strokeOn: boolean;
  stroke: StrokeFields;
  opacity: number;
}>;

export type VizTarget = Readonly<{
  id: string;
  label: string;
  /** The page whose exported spec the path data comes from. */
  source: string;
  data: TargetPathData;
  center: readonly [number, number];
  /** The initial appearance; a paint that starts off carries its off-paint defaults. */
  initial: AppearanceState;
}>;

const b2 = (id: string) => B2_PATHS.find((path) => path.id === id)!;
const v4 = (id: string) => V4_PATHS.find((path) => path.id === id)!;

const square = b2('fill-stroke-square');
const zigzag = b2('cap-butt');
const chevron = b2('miter-limit-keeps');
const circle = b2('fill-stroke-circle');
const star = v4('star-nonzero');

/** The off-paint default fill: the red of the B2 fill-plus-stroke cells. */
const DEFAULT_FILL: SceneColor = square.fill!;
const STROKE_FIELDS = (stroke: NonNullable<typeof square.stroke>): StrokeFields => ({
  color: stroke.color,
  width: stroke.width,
  cap: stroke.cap,
  join: stroke.join,
  miterLimit: stroke.miterLimit,
});
/** The off-paint default stroke of `v1-star`: blue, width 4, butt, miter, limit 4. */
const STAR_STROKE: StrokeFields = {
  color: { r: 0.25, g: 0.6, b: 1, a: 1 },
  width: 4,
  cap: 'butt',
  join: 'miter',
  miterLimit: 4,
};

/** Row 1: square, star, zigzag. Row 2: chevron, circle. Paint order is this order. */
export const VIZ_V1_TARGETS: readonly VizTarget[] = [
  {
    id: 'v1-square',
    label: 'B2 fill-stroke-square: red fill, blue stroke width 10',
    source: 'B2_PATHS fill-stroke-square',
    data: square.data,
    center: [130, 170],
    initial: {
      fillOn: true,
      fill: square.fill!,
      fillRule: 'nonzero',
      strokeOn: true,
      stroke: STROKE_FIELDS(square.stroke!),
      opacity: 1,
    },
  },
  {
    id: 'v1-star',
    label: 'V4 star-nonzero: pentagram, fill only',
    source: 'V4_PATHS star-nonzero',
    data: star.data,
    center: [360, 170],
    initial: {
      fillOn: true,
      fill: star.color,
      fillRule: star.fillRule,
      strokeOn: false,
      stroke: STAR_STROKE,
      opacity: 1,
    },
  },
  {
    id: 'v1-zigzag',
    label: 'B2 cap-butt: open zigzag, blue stroke width 14',
    source: 'B2_PATHS cap-butt',
    data: zigzag.data,
    center: [590, 170],
    initial: {
      fillOn: false,
      fill: DEFAULT_FILL,
      fillRule: 'nonzero',
      strokeOn: true,
      stroke: STROKE_FIELDS(zigzag.stroke!),
      opacity: 1,
    },
  },
  {
    id: 'v1-chevron',
    label: 'B2 miter-limit-keeps: chevron, blue stroke width 12, limit 4',
    source: 'B2_PATHS miter-limit-keeps',
    data: chevron.data,
    center: [245, 430],
    initial: {
      fillOn: false,
      fill: DEFAULT_FILL,
      fillRule: 'nonzero',
      strokeOn: true,
      stroke: STROKE_FIELDS(chevron.stroke!),
      opacity: 1,
    },
  },
  {
    id: 'v1-circle',
    label: 'B2 fill-stroke-circle: cubic circle, red fill, stroke off',
    source: 'B2_PATHS fill-stroke-circle',
    data: circle.data,
    center: [475, 430],
    initial: {
      fillOn: true,
      fill: circle.fill!,
      fillRule: 'nonzero',
      strokeOn: false,
      stroke: STROKE_FIELDS(circle.stroke!),
      opacity: 1,
    },
  },
];

export const DEFAULT_TARGET_ID = 'v1-square';

export function targetById(id: string): VizTarget | undefined {
  return VIZ_V1_TARGETS.find((target) => target.id === id);
}

export type VizView = Readonly<{
  id: string;
  label: string;
  /** World point shown at the surface center. */
  focus: Readonly<{ x: number; y: number }>;
  zoom: number;
}>;

export const SCENE_CENTER = Object.freeze({ x: 360, y: 300 });

export const VIZ_V1_VIEWS: readonly VizView[] = [
  { id: 'overview-zoom-1', label: 'Whole scene, zoom 1', focus: SCENE_CENTER, zoom: 1 },
  { id: 'zoom-0.25', label: 'Zoom 0.25', focus: SCENE_CENTER, zoom: 0.25 },
  { id: 'zoom-4', label: 'Zoom 4 on v1-square', focus: { x: 130, y: 170 }, zoom: 4 },
];

/** The view as a camera: the world point at the surface's top-left corner and the zoom. */
export function viewCamera(view: VizView): RenderCamera {
  return {
    position: {
      x: view.focus.x - VIZ_V1_SURFACE.width / 2 / view.zoom,
      y: view.focus.y - VIZ_V1_SURFACE.height / 2 / view.zoom,
    },
    zoom: view.zoom,
  };
}

/** Maps a world point through the view to CSS pixels on the surface. */
export function worldToSurface(
  view: VizView,
  point: Readonly<{ x: number; y: number }>,
): Readonly<{ x: number; y: number }> {
  const camera = viewCamera(view);
  return {
    x: (point.x - camera.position.x) * view.zoom,
    y: (point.y - camera.position.y) * view.zoom,
  };
}

export const VIZ_V1_BACKGROUND = Object.freeze({
  id: 'backdrop',
  color: Object.freeze({ r: 0.1, g: 0.12, b: 0.17, a: 1 }),
});
