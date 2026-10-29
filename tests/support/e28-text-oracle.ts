import type { GlyphRasterRequest, RenderCamera } from '@vector-studio/contracts';

import type { E28Placement } from '../../apps/playground/src/e23-gradient-paint.js';
import type { Premultiplied } from './e23-gradient-oracle.js';
import type { LeafSource } from './e25-layer-oracle.js';

// E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), unit U4: the CPU oracle of a
// text leaf (section 6, Oracle). It places the raster port's own bitmaps by E28-K1 to K3, from
// placements the page computes, and colours them by E28-K5; the E25 layer oracle composes the
// result with clips, masks and isolated containers (E28-K8). Snapped clusters read one texel per
// device pixel. General clusters sample bilinearly at the pixel centre, with the sample point
// clamped to the bitmap inset by half a texel. Clusters of a node blend in order (E28-K7).

export type TextBitmap = Readonly<{
  width: number;
  height: number;
  left: number;
  top: number;
  coverage: Uint8Array;
}>;

/** The port request of a placement (E28-K10 without the generation, which the port never sees). */
export function placementRequest(placement: E28Placement): GlyphRasterRequest {
  return {
    text: placement.text,
    fontList: placement.fontList,
    lang: placement.lang,
    pixelSize: placement.bucket,
    phaseX: placement.phaseX as GlyphRasterRequest['phaseX'],
  };
}

export const requestKey = (request: GlyphRasterRequest) =>
  JSON.stringify([request.text, request.fontList, request.lang, request.pixelSize, request.phaseX]);

/** The distinct requests of some placements, in first-use order. */
export function uniqueRequests(placements: readonly E28Placement[]): GlyphRasterRequest[] {
  const seen = new Map<string, GlyphRasterRequest>();
  for (const placement of placements) {
    const request = placementRequest(placement);
    const key = requestKey(request);
    if (!seen.has(key)) seen.set(key, request);
  }
  return [...seen.values()];
}

/** One placed cluster: its device quad and how its pixels read the bitmap. */
type Placed = Readonly<{
  bitmap: TextBitmap;
  color: Premultiplied;
  snapped: boolean;
  /** Snapped: the bitmap's top-left device pixel. */
  x0: number;
  y0: number;
  /** General: the quad origin and its two axis vectors in device px. */
  origin: readonly [number, number];
  axisX: readonly [number, number];
  axisY: readonly [number, number];
  /** Device bounds of the quad, for a quick reject. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

function place(placement: E28Placement, bitmap: TextBitmap): Placed {
  const { r, g, b, a } = placement.color;
  const color: Premultiplied = [r * a, g * a, b * a, a];
  if (placement.mode === 'snapped') {
    const x0 = placement.corner![0] - bitmap.left;
    const y0 = placement.corner![1] - bitmap.top;
    return {
      bitmap,
      color,
      snapped: true,
      x0,
      y0,
      origin: [x0, y0],
      axisX: [bitmap.width, 0],
      axisY: [0, bitmap.height],
      minX: x0,
      minY: y0,
      maxX: x0 + bitmap.width,
      maxY: y0 + bitmap.height,
    };
  }
  // E28-K3, general: bitmap point u maps to o + (size / b) · M_lin · (u − (left + phaseX, top)).
  const [ma, mb, mc, md] = placement.map;
  const k = placement.size / placement.bucket;
  const ux = -(bitmap.left + placement.phaseX);
  const uy = -bitmap.top;
  const origin: [number, number] = [
    placement.origin[0] + k * (ma * ux + mc * uy),
    placement.origin[1] + k * (mb * ux + md * uy),
  ];
  const axisX: [number, number] = [k * ma * bitmap.width, k * mb * bitmap.width];
  const axisY: [number, number] = [k * mc * bitmap.height, k * md * bitmap.height];
  const xs = [0, axisX[0], axisY[0], axisX[0] + axisY[0]].map((value) => origin[0] + value);
  const ys = [0, axisX[1], axisY[1], axisX[1] + axisY[1]].map((value) => origin[1] + value);
  return {
    bitmap,
    color,
    snapped: false,
    x0: 0,
    y0: 0,
    origin,
    axisX,
    axisY,
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

const texel = (bitmap: TextBitmap, x: number, y: number) =>
  bitmap.coverage[y * bitmap.width + x]! / 255;

/** Bilinear coverage at bitmap point (u, v), clamped to the bitmap inset by half a texel. */
function bilinear(bitmap: TextBitmap, u: number, v: number): number {
  const cu = Math.min(Math.max(u, 0.5), bitmap.width - 0.5) - 0.5;
  const cv = Math.min(Math.max(v, 0.5), bitmap.height - 0.5) - 0.5;
  const x0 = Math.floor(cu);
  const y0 = Math.floor(cv);
  const x1 = Math.min(x0 + 1, bitmap.width - 1);
  const y1 = Math.min(y0 + 1, bitmap.height - 1);
  const fx = cu - x0;
  const fy = cv - y0;
  return (
    (texel(bitmap, x0, y0) * (1 - fx) + texel(bitmap, x1, y0) * fx) * (1 - fy) +
    (texel(bitmap, x0, y1) * (1 - fx) + texel(bitmap, x1, y1) * fx) * fy
  );
}

/** A placed cluster's coverage at device point (dx, dy), or null near a quad edge with ink. */
function coverageAt(item: Placed, dx: number, dy: number): number | null {
  if (item.snapped) {
    const x = Math.floor(dx) - item.x0;
    const y = Math.floor(dy) - item.y0;
    if (x < 0 || y < 0 || x >= item.bitmap.width || y >= item.bitmap.height) return 0;
    return texel(item.bitmap, x, y);
  }
  const [ox, oy] = item.origin;
  const [ax, ay] = item.axisX;
  const [bx, by] = item.axisY;
  const det = ax * by - ay * bx;
  const px = dx - ox;
  const py = dy - oy;
  const s = (px * by - py * bx) / det;
  const t = (ax * py - ay * px) / det;
  const u = s * item.bitmap.width;
  const v = t * item.bitmap.height;
  // Within 1.5 device px of the quad's edge a pixel is partly covered at 4x: undecided unless
  // the bitmap there is empty (the port's 2 px border usually is).
  const scaleU = Math.hypot(ax, ay) / item.bitmap.width;
  const scaleV = Math.hypot(bx, by) / item.bitmap.height;
  const marginU = 1.5 / scaleU;
  const marginV = 1.5 / scaleV;
  const inside = u >= 0 && v >= 0 && u < item.bitmap.width && v < item.bitmap.height;
  const near =
    u > -marginU &&
    v > -marginV &&
    u < item.bitmap.width + marginU &&
    v < item.bitmap.height + marginV &&
    (u < marginU ||
      v < marginV ||
      u > item.bitmap.width - marginU ||
      v > item.bitmap.height - marginV);
  if (near) {
    const value = bilinear(item.bitmap, u, v);
    return value <= 1 / 255 ? 0 : null;
  }
  return inside ? bilinear(item.bitmap, u, v) : 0;
}

export type TextView = Readonly<{ camera: RenderCamera; dpr: number }>;

/** Counts of a source's evaluations: probes that met ink, and undecided probes. */
export type TextStatistics = { inked: number; undecided: number };

/**
 * A text node's oracle source: its placements (in run, then cluster order) with their bitmaps,
 * under a view. Clusters without a bitmap (`empty`) draw nothing.
 */
export function textLeafSource(
  placements: readonly E28Placement[],
  bitmaps: ReadonlyMap<string, TextBitmap | null>,
  view: TextView,
  statistics: TextStatistics = { inked: 0, undecided: 0 },
): LeafSource {
  const placed: Placed[] = [];
  for (const placement of placements) {
    const bitmap = bitmaps.get(requestKey(placementRequest(placement)));
    if (bitmap === undefined) throw new Error(`No bitmap for ${placement.text}`);
    if (bitmap !== null) placed.push(place(placement, bitmap));
  }
  const k = view.camera.zoom * view.dpr;
  return (wx, wy) => {
    const dx = (wx - view.camera.position.x) * k;
    const dy = (wy - view.camera.position.y) * k;
    let out: Premultiplied = [0, 0, 0, 0];
    let any = false;
    for (const item of placed) {
      if (dx < item.minX - 2 || dy < item.minY - 2 || dx > item.maxX + 2 || dy > item.maxY + 2)
        continue;
      const coverage = coverageAt(item, dx, dy);
      if (coverage === null) {
        statistics.undecided += 1;
        return null;
      }
      if (coverage === 0) continue;
      any = true;
      const source = item.color.map((lane) => lane * coverage);
      out = [0, 1, 2, 3].map(
        (lane) => source[lane]! + out[lane]! * (1 - source[3]!),
      ) as unknown as Premultiplied;
    }
    if (!any) return 'none';
    statistics.inked += 1;
    return out;
  };
}
