import type { DocumentV8, Guide, PagePoint, RenderCamera } from '@vector-studio/editor-core';

// V-38 contract, section 5 (V38-H1, H2): the pure parts of the rulers and guides, so the unit
// tests reach them without a DOM: ruler ticks, picking a guide, whether a press may pick one up,
// and the guides a finished drag writes.

/** The ruler thickness in CSS px (V38-H1). */
export const RULER_PX = 20;
/** How near (CSS px) a press picks up a guide (V38-H2). */
export const GUIDE_PICK_PX = 3;
/** How near (CSS px) the selection box keeps M2 press precedence: the rotate zone's reach. */
export const SELECTION_GUARD_PX = 18;
/** The largest guide value magnitude (V38-S1). */
export const GUIDE_LIMIT = 1e7;

/** The labelled spacing (CSS px) the ruler's step at least has. */
const MAJOR_PX = 50;
/** The spacing (CSS px) a minor tick at least has. */
const MINOR_PX = 5;

/** A ruler's ticks: labelled majors and unlabelled minors, at CSS px along the ruler. */
export type RulerTicks = Readonly<{
  step: number;
  major: readonly Readonly<{ px: number; value: number; label: string }>[];
  minor: readonly number[];
}>;

/** The smallest of 1, 2, 5 × 10^k page units at least `MAJOR_PX` CSS px apart at `zoom`. */
export function rulerStep(zoom: number): number {
  const target = MAJOR_PX / zoom;
  let power = 10 ** Math.floor(Math.log10(target));
  for (;;) {
    for (const factor of [1, 2, 5]) {
      if (factor * power * zoom >= MAJOR_PX - 1e-9) return factor * power;
    }
    power *= 10;
  }
}

/** A tick label: whole numbers as they are, else at most 3 decimals without trailing zeros. */
export function tickLabel(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * The ticks of a ruler `length` CSS px long whose start shows page coordinate `start` at `zoom`
 * (V38-H1): majors every `rulerStep(zoom)`, minors at a tenth of it where they are at least
 * `MINOR_PX` apart, else at a half, else none.
 */
export function rulerTicks(start: number, zoom: number, length: number): RulerTicks {
  const step = rulerStep(zoom);
  const minorStep =
    (step / 10) * zoom >= MINOR_PX ? step / 10 : (step / 2) * zoom >= MINOR_PX ? step / 2 : 0;
  const end = start + length / zoom;
  const major: { px: number; value: number; label: string }[] = [];
  for (let k = Math.ceil(start / step); k * step <= end; k += 1) {
    const value = k * step;
    major.push({ px: (value - start) * zoom, value, label: tickLabel(value) });
  }
  const minor: number[] = [];
  if (minorStep > 0) {
    const perMajor = Math.round(step / minorStep);
    for (let k = Math.ceil(start / minorStep); k * minorStep <= end; k += 1) {
      if (k % perMajor !== 0) minor.push((k * minorStep - start) * zoom);
    }
  }
  return { step, major, minor };
}

/** A guide's position along the canvas in CSS px. */
export function guideScreen(guide: Guide, camera: RenderCamera): number {
  const origin = guide.axis === 'x' ? camera.position.x : camera.position.y;
  return (guide.value - origin) * camera.zoom;
}

/**
 * The index of the guide nearest the canvas point `(x, y)` (CSS px) within `GUIDE_PICK_PX`, or
 * null; on a tie the later guide (drawn on top) wins.
 */
export function guideAt(
  guides: readonly Guide[],
  camera: RenderCamera,
  x: number,
  y: number,
): number | null {
  let best: { index: number; distance: number } | null = null;
  guides.forEach((guide, index) => {
    const distance = Math.abs(guideScreen(guide, camera) - (guide.axis === 'x' ? x : y));
    if (distance <= GUIDE_PICK_PX && (best === null || distance <= best.distance)) {
      best = { index, distance };
    }
  });
  return (best as { index: number } | null)?.index ?? null;
}

/** What decides whether a canvas press may pick up a guide (V38-H2). */
export type PickState = Readonly<{
  tool: string;
  /** A tool overlay, path edit or text edit is active. */
  busy: boolean;
  /** The selection box corners in page space (TL, TR, BR, BL), or null. */
  corners: readonly PagePoint[] | null;
  camera: RenderCamera;
}>;

/**
 * Whether a press at canvas point `(x, y)` (CSS px) may pick up a guide: the select tool with
 * nothing in progress, and the press farther than `SELECTION_GUARD_PX` from the selection box in
 * the box's own axes (where M2 press precedence would resize, edge-resize or rotate).
 */
export function mayPickGuide(state: PickState, x: number, y: number): boolean {
  if (state.tool !== 'select' || state.busy) return false;
  const corners = state.corners;
  if (corners === null || corners.length !== 4) return true;
  const { position, zoom } = state.camera;
  const screen = corners.map((p) => ({
    x: (p.x - position.x) * zoom,
    y: (p.y - position.y) * zoom,
  }));
  const [a, b, , d] = screen as [PagePoint, PagePoint, PagePoint, PagePoint];
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = d.x - a.x;
  const vy = d.y - a.y;
  const width = Math.hypot(ux, uy);
  const height = Math.hypot(vx, vy);
  // Along each box axis: the distance outside the box (0 inside), in CSS px.
  const outside = (along: number, length: number) =>
    along < 0 ? -along : along > length ? along - length : 0;
  const px = x - a.x;
  const py = y - a.y;
  if (width === 0 && height === 0) return Math.hypot(px, py) > SELECTION_GUARD_PX;
  // A zero-size axis (a horizontal or vertical line) measures across from the other axis.
  const s = width > 0 ? (px * ux + py * uy) / width : Math.abs(px * vy - py * vx) / height;
  const t = height > 0 ? (px * vx + py * vy) / height : Math.abs(px * uy - py * ux) / width;
  const dx = width > 0 ? outside(s, width) : s;
  const dy = height > 0 ? outside(t, height) : t;
  return Math.hypot(dx, dy) > SELECTION_GUARD_PX;
}

/** A guide drag in progress (V38-H2): `index` null for a new guide from a ruler. */
export type GuideDrag = Readonly<{
  axis: Guide['axis'];
  index: number | null;
  value: number;
  page: string;
  revision: number;
}>;

/** A page coordinate rounded to a whole unit and clamped to the guide range. */
export function guideValue(coordinate: number): number {
  const value = Math.min(GUIDE_LIMIT, Math.max(-GUIDE_LIMIT, Math.round(coordinate)));
  return value === 0 ? 0 : value;
}

/**
 * Whether a release at canvas point `(x, y)` removes the dragged guide: over its own ruler (the
 * top one for a horizontal guide, the left one for a vertical guide) or outside the canvas.
 */
export function releaseRemoves(
  axis: Guide['axis'],
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (x < 0 || y < 0 || x > width || y > height) return true;
  return axis === 'y' ? y < RULER_PX : x < RULER_PX;
}

/**
 * The guides a finished drag writes: the page's current guides with the dragged one moved in
 * place, added at the end, or removed (`remove`). Null when the drag changes nothing.
 */
export function releasedGuides(
  current: readonly Guide[],
  drag: GuideDrag,
  remove: boolean,
): readonly Guide[] | null {
  if (drag.index === null) {
    return remove ? null : [...current, { axis: drag.axis, value: drag.value }];
  }
  if (drag.index >= current.length) return null;
  if (remove) return current.filter((_, index) => index !== drag.index);
  return current.map((guide, index) =>
    index === drag.index ? { axis: guide.axis, value: drag.value } : guide,
  );
}

/** Whether a drag is stale: the document or the page changed since it began. */
export function dragStale(drag: GuideDrag, revision: number, page: string): boolean {
  return drag.revision !== revision || drag.page !== page;
}

/** The guides of `page`, or none. */
export function pageGuides(document: DocumentV8, page: string): readonly Guide[] {
  return document.pages.find((entry) => entry.id === page)?.guides ?? [];
}

// V-41 contract, V41-H1: the page's canvas grid over the whole canvas.

/** The smallest CSS px spacing the canvas grid draws at (V41-H1). */
export const CANVAS_GRID_MIN_PX = 8;

/** `size · 2^k` for the smallest whole `k >= 0` with a spacing of at least 8 CSS px at `zoom`. */
export function canvasGridStep(size: number, zoom: number): number {
  let step = size;
  // A bounded loop: `size > 0` and `zoom > 0`, so 64 doublings cover every finite pair.
  for (let k = 0; k < 64 && step * zoom < CANVAS_GRID_MIN_PX; k += 1) step *= 2;
  return step;
}

/**
 * The SVG path data of the canvas grid lines visible on a `width` × `height` CSS px canvas: the
 * page multiples of `step` on both axes, each a full-height or full-width line at half-pixel
 * offsets so a 1 px stroke stays crisp.
 */
export function canvasGridPath(
  camera: RenderCamera,
  width: number,
  height: number,
  step: number,
): string {
  const { position, zoom } = camera;
  const parts: string[] = [];
  const axis = (origin: number, extent: number, line: (px: number) => string) => {
    const first = Math.ceil(origin / step);
    const last = Math.floor((origin + extent / zoom) / step);
    for (let k = first; k <= last; k += 1) {
      const px = Math.round((k * step - origin) * zoom) + 0.5;
      parts.push(line(px));
    }
  };
  axis(position.x, width, (px) => `M${px} 0V${height}`);
  axis(position.y, height, (px) => `M0 ${px}H${width}`);
  return parts.join('');
}
