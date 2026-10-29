import type {
  GlyphRasterRequest,
  RenderCamera,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';

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

type Affine = readonly [number, number, number, number, number, number];

/**
 * E28-K1 to K3 from the contract's text, written apart from renderer-core's helpers, checked
 * against the page's placements: the device map, the device size, the bucket, the snapped or
 * general mode, and a snapped cluster's phase and pixel corner. Returns the disagreements.
 */
export function checkPlacements(
  snapshot: RenderSceneSnapshot,
  camera: RenderCamera,
  dpr: number,
  placements: readonly E28Placement[],
): string[] {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  // Column-vector affines [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f.
  const then = (outer: Affine, inner: Affine): Affine => [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
  const world = (id: string): Affine => {
    const node = byId.get(id)!;
    const local = node.transform;
    return node.parentId === null ? local : then(world(node.parentId), local);
  };
  const k = camera.zoom * dpr;
  const view: Affine = [k, 0, 0, k, -k * camera.position.x, -k * camera.position.y];
  const near = (left: number, right: number) =>
    Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
  const failures: string[] = [];
  let index = 0;
  for (const node of snapshot.nodes) {
    if (node.kind !== 'text') continue;
    const m = then(view, world(node.id));
    const sigma = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const eps = 1e-9 * sigma;
    const uniform =
      m[0] > 0 &&
      m[3] > 0 &&
      Math.abs(m[0] - sigma) <= eps &&
      Math.abs(m[3] - sigma) <= eps &&
      Math.abs(m[1]) <= eps &&
      Math.abs(m[2]) <= eps;
    node.runs.forEach((run, runIndex) => {
      const s = run.size * sigma;
      if (s < 0.5) return;
      // K2: quarter pixels up to 64 px, whole pixels above, half up; capped at 256 (K4).
      const bucket = Math.min(256, s <= 64 ? Math.floor(s * 4 + 0.5) / 4 : Math.floor(s + 0.5));
      const snapped = uniform && s <= 256;
      run.clusters.forEach((cluster, clusterIndex) => {
        const label = `${node.id}/${runIndex}/${clusterIndex}`;
        const placement = placements[index];
        index += 1;
        if (placement === undefined) {
          failures.push(`${label}: no placement`);
          return;
        }
        const ox = m[0] * cluster.x + m[2] * cluster.y + m[4];
        const oy = m[1] * cluster.x + m[3] * cluster.y + m[5];
        const problems: string[] = [];
        if (placement.nodeId !== node.id || placement.cluster !== clusterIndex)
          problems.push('order');
        if (!m.every((value, at) => near(value, placement.map[at]!))) problems.push('map');
        if (!near(ox, placement.origin[0]) || !near(oy, placement.origin[1]))
          problems.push('origin');
        if (!near(s, placement.deviceSize)) problems.push('size');
        if (placement.bucket !== bucket) problems.push(`bucket ${placement.bucket} vs ${bucket}`);
        if (placement.mode !== (snapped ? 'snapped' : 'general')) problems.push('mode');
        if (snapped) {
          // K3: the pen x rounds half up to a quarter pixel; its whole part is the corner and
          // its fraction the phase. The pen y rounds half up to a whole pixel.
          const quarters = Math.floor(ox * 4 + 0.5);
          const cornerX = Math.floor(quarters / 4);
          const phase = (quarters - 4 * cornerX) / 4;
          const cornerY = Math.floor(oy + 0.5);
          if (placement.phaseX !== phase) problems.push(`phase ${placement.phaseX} vs ${phase}`);
          if (placement.corner?.[0] !== cornerX || placement.corner?.[1] !== cornerY)
            problems.push(`corner ${JSON.stringify(placement.corner)} vs [${cornerX},${cornerY}]`);
        }
        if (problems.length > 0) failures.push(`${label}: ${problems.join(', ')}`);
      });
    });
  }
  if (index !== placements.length)
    failures.push(`${placements.length} placements, ${index} expected`);
  return failures.slice(0, 12);
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
