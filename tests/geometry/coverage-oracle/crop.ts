import { floorDiv } from './numeric.js';
import type { CoverageRowGeometry } from './positions.js';

/** Integer physical-pixel rectangle, top-left origin, y down; pixel (i, j) is [i, i+1) x [j, j+1). */
export type Crop = Readonly<{ x: number; y: number; w: number; h: number }>;

export const CROP_DILATION = 3;

/**
 * Integer pixel bounding box of the reference region (bbox of the referenced preimage vertices)
 * dilated by 3 px, clipped to [0, W) x [0, H). A pixel belongs when its half-open square meets the
 * closed dilated box. Returns null when the clipped box is empty.
 */
export function cropFor(geometry: CoverageRowGeometry): Crop | null {
  const S = 1n << BigInt(geometry.scaleExponent);
  const r = BigInt(CROP_DILATION) * S;
  const xs = geometry.referenced.map((v) => geometry.scaled[v]![0]);
  const ys = geometry.referenced.map((v) => geometry.scaled[v]![1]);
  const min = (values: bigint[]) => values.reduce((a, b) => (b < a ? b : a));
  const max = (values: bigint[]) => values.reduce((a, b) => (b > a ? b : a));
  const clamp = (value: bigint, high: number) =>
    Number(value < 0n ? 0n : value > BigInt(high) ? BigInt(high) : value);
  const x0 = clamp(floorDiv(min(xs) - r, S), geometry.width);
  const x1 = clamp(floorDiv(max(xs) + r, S) + 1n, geometry.width);
  const y0 = clamp(floorDiv(min(ys) - r, S), geometry.height);
  const y1 = clamp(floorDiv(max(ys) + r, S) + 1n, geometry.height);
  if (x0 >= x1 || y0 >= y1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
