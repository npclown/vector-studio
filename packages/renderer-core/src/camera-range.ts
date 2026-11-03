import { meetsClipChain, type ClipChain } from './clip-resolution.js';
import { bucketZoomRange, type BucketHint } from './path-buckets.js';
import type { SceneBounds } from './scene-numeric.js';

// E30 contract (docs/plans/d9-e30-renderer-cost-contract.md), section 4.1, U3: the validity range
// of a camera-only frame. A range is a zoom interval and a box of camera positions (the
// viewport's top-left corner in world units) over which a kept decision does not change. Ranges
// are computed conservatively: every bound is narrowed by a relative margin far above the
// rounding of the viewport arithmetic (`viewportBounds` in path-mesh-pipeline.ts and the
// primitive cull: a few roundings of the camera position, the viewport extent and the guard).

export type CameraRange = Readonly<{
  zoomMin: number;
  zoomMax: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

export type RangeCamera = Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>;
export type RangeTarget = Readonly<{ width: number; height: number; devicePixelRatio: number }>;

/** The relative margin of every range bound; the viewport arithmetic's error is below 1e-15. */
const MARGIN = 1e-9;

/** Zoom ratios tried for a range, widest first; 0 is the current zoom alone. */
export const RANGE_ZOOM_RATIOS: readonly number[] = Object.freeze([1 / 16, 1 / 256, 1 / 4096, 0]);

export const ANY_CAMERA: CameraRange = Object.freeze({
  zoomMin: 0,
  zoomMax: Infinity,
  minX: -Infinity,
  maxX: Infinity,
  minY: -Infinity,
  maxY: Infinity,
});

/** The range that holds only at this camera: a kept decision is reused only at the same one. */
export function pointRange(camera: RangeCamera): CameraRange {
  return Object.freeze({
    zoomMin: camera.zoom,
    zoomMax: camera.zoom,
    minX: camera.position.x,
    maxX: camera.position.x,
    minY: camera.position.y,
    maxY: camera.position.y,
  });
}

export function rangeHolds(range: CameraRange, camera: RangeCamera): boolean {
  const { x, y } = camera.position;
  return (
    range.zoomMin <= camera.zoom &&
    camera.zoom <= range.zoomMax &&
    range.minX <= x &&
    x <= range.maxX &&
    range.minY <= y &&
    y <= range.maxY
  );
}

export function intersectRanges(left: CameraRange, right: CameraRange): CameraRange {
  return Object.freeze({
    zoomMin: Math.max(left.zoomMin, right.zoomMin),
    zoomMax: Math.min(left.zoomMax, right.zoomMax),
    minX: Math.max(left.minX, right.minX),
    maxX: Math.min(left.maxX, right.maxX),
    minY: Math.max(left.minY, right.minY),
    maxY: Math.min(left.maxY, right.maxY),
  });
}

/**
 * The positions, for every zoom in [zoomMin, zoomMax], at which each item's cull decision is
 * its decision at `camera`: a drawn item's bounds keep meeting the viewport widened by the 2 px
 * guard (P4-K5) and its clip chain under that guard; a culled item's bounds keep missing the
 * viewport or its clip chain. Null when a decision would change inside the zoom interval (a clip
 * chain test that differs at its two guards) or the current camera is not inside the box.
 *
 * The viewport at (x, z) is [x - g, x + W / z + g] (and the same in y) with g = 2 / (z * DPR) and
 * W the CSS width; both W / z and g fall as z grows, so the narrowest viewport is at zoomMax and
 * the widest at zoomMin. A drawn item keeps meeting it while x <= maxX + g(zoomMax) and
 * x >= minX - W / zoomMax - g(zoomMax); a culled item stays past one side while x stays past that
 * side's bound at zoomMin. Of a culled item's sides, the one with the most room is kept.
 */
export function cullRange(
  camera: RangeCamera,
  target: RangeTarget,
  zoomMin: number,
  zoomMax: number,
  items: Iterable<Readonly<{ bounds: SceneBounds; clip: ClipChain | null; drawn: boolean }>>,
): CameraRange | null {
  const dpr = target.devicePixelRatio;
  // The same expressions as the cull's viewport, so their rounding is monotone in the zoom.
  const guardSmall = 2 / (zoomMax * dpr);
  const guardLarge = 2 / (zoomMin * dpr);
  const widthSmall = target.width / dpr / zoomMax;
  const widthLarge = target.width / dpr / zoomMin;
  const heightSmall = target.height / dpr / zoomMax;
  const heightLarge = target.height / dpr / zoomMin;
  const { x, y } = camera.position;
  const margin = (value: number, extent: number) =>
    MARGIN * (Math.abs(value) + Math.abs(x) + Math.abs(y) + extent + 1);
  let minX = -Infinity;
  let maxX = Infinity;
  let minY = -Infinity;
  let maxY = Infinity;
  for (const { bounds, clip, drawn } of items) {
    if (drawn) {
      // The narrowest guard is the clip test's hardest; a larger guard meets more.
      if (clip !== null && !meetsClipChain(bounds, clip, guardSmall)) return null;
      maxX = Math.min(maxX, bounds.maxX + guardSmall - margin(bounds.maxX, guardSmall));
      maxY = Math.min(maxY, bounds.maxY + guardSmall - margin(bounds.maxY, guardSmall));
      const left = bounds.minX - widthSmall - guardSmall;
      const top = bounds.minY - heightSmall - guardSmall;
      minX = Math.max(minX, left + margin(left, widthSmall + guardSmall));
      minY = Math.max(minY, top + margin(top, heightSmall + guardSmall));
      continue;
    }
    if (clip !== null && !meetsClipChain(bounds, clip, guardLarge)) continue;
    if (clip !== null && !meetsClipChain(bounds, clip, guardSmall)) return null;
    // Culled by the viewport alone: past one side at every zoom in the interval.
    const sides = [
      // Left of the viewport: maxX < x - g, so x > maxX + g(zoomMin).
      {
        slack: x - (bounds.maxX + guardLarge),
        apply: () => {
          const bound = bounds.maxX + guardLarge;
          minX = Math.max(minX, bound + margin(bound, guardLarge));
        },
      },
      // Right of it: minX > x + W / z + g, so x < minX - W / zoomMin - g(zoomMin).
      {
        slack: bounds.minX - widthLarge - guardLarge - x,
        apply: () => {
          const bound = bounds.minX - widthLarge - guardLarge;
          maxX = Math.min(maxX, bound - margin(bound, widthLarge + guardLarge));
        },
      },
      {
        slack: y - (bounds.maxY + guardLarge),
        apply: () => {
          const bound = bounds.maxY + guardLarge;
          minY = Math.max(minY, bound + margin(bound, guardLarge));
        },
      },
      {
        slack: bounds.minY - heightLarge - guardLarge - y,
        apply: () => {
          const bound = bounds.minY - heightLarge - guardLarge;
          maxY = Math.min(maxY, bound - margin(bound, heightLarge + guardLarge));
        },
      },
    ];
    let best = sides[0]!;
    for (const side of sides) if (side.slack > best.slack) best = side;
    if (!(best.slack > 0)) return null;
    best.apply();
  }
  if (!(minX <= x && x <= maxX && minY <= y && y <= maxY)) return null;
  return Object.freeze({ zoomMin, zoomMax, minX, maxX, minY, maxY });
}

/**
 * A kept decision's range: the widest zoom ratio of `RANGE_ZOOM_RATIOS` whose interval keeps the
 * buckets (when `hint` is given: one whose buckets are the exact buckets at the camera's zoom;
 * null declines to a point) and whose cull box holds the camera,
 * else the point range.
 */
export function decisionRange(
  camera: RangeCamera,
  target: RangeTarget,
  hint: BucketHint | null | undefined,
  items: readonly Readonly<{ bounds: SceneBounds; clip: ClipChain | null; drawn: boolean }>[],
): CameraRange {
  const { zoom } = camera;
  if (hint === null) return pointRange(camera);
  for (const ratio of RANGE_ZOOM_RATIOS) {
    let zoomMin = ratio === 0 ? zoom : zoom / (1 + ratio);
    let zoomMax = ratio === 0 ? zoom : zoom * (1 + ratio);
    if (hint !== undefined) {
      [zoomMin, zoomMax] = bucketZoomRange(hint, zoom, target.devicePixelRatio, zoomMin, zoomMax);
    }
    const range = cullRange(camera, target, zoomMin, zoomMax, items);
    if (range !== null) return range;
  }
  return pointRange(camera);
}
