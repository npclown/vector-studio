import type { ClusterPlacement, FrameCrop } from '../../apps/next-host/src/m6c-text-probe';
import type { FlowedReference } from '../../apps/next-host/src/m6c-text-reference';

// M6c-U3 (MVP M6c contract, section 6): the pure half of the DOM and GPU agreement, shared by the
// headed spec (m6c-agreement.spec.ts) and its unit tests (tests/unit/m6c-u3-agreement.test.ts).
// No browser and no renderer import: E28-K1 to K3 are recomputed here apart from renderer-core.
//
// Ink (contract section 2, M6-S0's ink boxes, docs/evidence/m6-s0/README.md (d)): the coverage of
// a pixel over white is `255 − min(R, G, B)`, so an LCD-coloured DOM edge counts by its darkest
// subpixel; coverage ≤ 2/255 is ignored. The subpixel measures are coverage weighted: a column's
// (row's) profile is its largest coverage c in 0..1, and an edge column with profile c puts the
// edge at its far side minus c; the centroid is the first moment of coverage. All in absolute
// device px of the canvas, so a GPU crop and a DOM crop of different extents compare directly.

/** RGBA pixels of a crop, rows top first, at its device offset. */
export type Pixels = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8Array;
}>;

/** `crop.rgbaBase64` decoded; throws when the byte count does not match the size. */
export function decodeCrop(crop: FrameCrop): Pixels {
  const rgba = Uint8Array.from(atob(crop.rgbaBase64), (char) => char.charCodeAt(0));
  if (rgba.length !== crop.width * crop.height * 4) {
    throw new Error(`crop of ${crop.width} x ${crop.height} has ${rgba.length} bytes`);
  }
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height, rgba };
}

/** The largest channel spread of a gated grayscale read (review r1 S4), out of 255. */
export const ACHROMATIC_LIMIT = 2;

/**
 * The largest `|R − G|` or `|G − B|` over the crop: 0 for a grayscale paint, larger where LCD
 * antialiasing coloured the edges. The gated DOM read is on a composited layer, which Chromium
 * paints grayscale; this checks it.
 */
export function maxChroma(pixels: Pixels): number {
  let spread = 0;
  for (let offset = 0; offset < pixels.rgba.length; offset += 4) {
    const [r, g, b] = [pixels.rgba[offset]!, pixels.rgba[offset + 1]!, pixels.rgba[offset + 2]!];
    spread = Math.max(spread, Math.abs(r - g), Math.abs(g - b));
  }
  return spread;
}

/** M6-S0's subpixel noise floor, out of 255. */
export const COVERAGE_FLOOR = 2;
/** M6-S0's lower integer-box threshold, out of 255 (recorded, not gated). */
export const BOX_THRESHOLD = 16;

/** Ink measures of one crop in absolute device px. */
export type Ink = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
  /** Summed coverage in 0..1 per pixel, device px². */
  mass: number;
  /** Pixels with coverage above `BOX_THRESHOLD`, whole px; null when none. */
  box: Readonly<{ x0: number; y0: number; x1: number; y1: number }> | null;
}>;

/** The ink measures of `pixels`, or null when nothing is above the floor. */
export function measureInk(pixels: Pixels, threshold: number = BOX_THRESHOLD): Ink | null {
  const { width, height, rgba } = pixels;
  const columns = new Float64Array(width);
  const rows = new Float64Array(height);
  let mass = 0;
  let mx = 0;
  let my = 0;
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const raw = 255 - Math.min(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
      if (raw <= COVERAGE_FLOOR) continue;
      const c = raw / 255;
      mass += c;
      mx += (x + 0.5) * c;
      my += (y + 0.5) * c;
      if (c > columns[x]!) columns[x] = c;
      if (c > rows[y]!) rows[y] = c;
      if (raw > threshold) {
        box ??= { x0: x, y0: y, x1: x + 1, y1: y + 1 };
        box.x0 = Math.min(box.x0, x);
        box.y0 = Math.min(box.y0, y);
        box.x1 = Math.max(box.x1, x + 1);
        box.y1 = Math.max(box.y1, y + 1);
      }
    }
  }
  if (mass === 0) return null;
  const first = (profile: Float64Array) => profile.findIndex((value) => value > 0);
  const last = (profile: Float64Array) => {
    for (let index = profile.length - 1; index >= 0; index -= 1) {
      if (profile[index]! > 0) return index;
    }
    return -1;
  };
  const fx = first(columns);
  const lx = last(columns);
  const fy = first(rows);
  const ly = last(rows);
  return {
    left: pixels.x + fx + 1 - columns[fx]!,
    right: pixels.x + lx + columns[lx]!,
    top: pixels.y + fy + 1 - rows[fy]!,
    bottom: pixels.y + ly + rows[ly]!,
    cx: pixels.x + mx / mass,
    cy: pixels.y + my / mass,
    mass,
    box:
      box === null
        ? null
        : {
            x0: pixels.x + box.x0,
            y0: pixels.y + box.y0,
            x1: pixels.x + box.x1,
            y1: pixels.y + box.y1,
          },
  };
}

/** Section 6.1's raster term of one cluster, GPU minus placed DOM, in CSS px. */
export type RasterTerm = Readonly<{
  dLeft: number;
  dTop: number;
  dRight: number;
  dBottom: number;
  dWidth: number;
  dHeight: number;
  /** Section 6.3's horizontal `subOffset`: the left edge shift, absolute. */
  subOffsetX: number;
  /** Section 6.3's vertical `subOffset`: the top edge shift, signed (GPU minus DOM). */
  subOffsetY: number;
  /** `max(|dWidth|, |dHeight|)`. */
  subSizeDiff: number;
  /** Centroid shifts (recorded): robust to an edge column of LCD fringe or hinting. */
  centroidX: number;
  centroidY: number;
  /** GPU over DOM ink mass (recorded). */
  massRatio: number;
  /** Integer forms on the thresholded boxes (recorded, not gated: section 6.3). */
  offset: number | null;
  sizeDiff: number | null;
}>;

export function rasterTerm(gpu: Ink, dom: Ink, devicePixelRatio: number): RasterTerm {
  const css = (value: number) => value / devicePixelRatio;
  const dLeft = css(gpu.left - dom.left);
  const dTop = css(gpu.top - dom.top);
  const dRight = css(gpu.right - dom.right);
  const dBottom = css(gpu.bottom - dom.bottom);
  const dWidth = css(gpu.right - gpu.left - (dom.right - dom.left));
  const dHeight = css(gpu.bottom - gpu.top - (dom.bottom - dom.top));
  const integer =
    gpu.box === null || dom.box === null
      ? null
      : {
          offset: css(
            Math.max(Math.abs(gpu.box.x0 - dom.box.x0), Math.abs(gpu.box.y0 - dom.box.y0)),
          ),
          sizeDiff: css(
            Math.max(
              Math.abs(gpu.box.x1 - gpu.box.x0 - (dom.box.x1 - dom.box.x0)),
              Math.abs(gpu.box.y1 - gpu.box.y0 - (dom.box.y1 - dom.box.y0)),
            ),
          ),
        };
  return {
    dLeft,
    dTop,
    dRight,
    dBottom,
    dWidth,
    dHeight,
    subOffsetX: Math.abs(dLeft),
    subOffsetY: dTop,
    subSizeDiff: Math.max(Math.abs(dWidth), Math.abs(dHeight)),
    centroidX: css(gpu.cx - dom.cx),
    centroidY: css(gpu.cy - dom.cy),
    massRatio: gpu.mass / dom.mass,
    offset: integer?.offset ?? null,
    sizeDiff: integer?.sizeDiff ?? null,
  };
}

/** Section 6.3 (a), in CSS px: horizontal ≤ 0.5, vertical within ±0.25, size ≤ 1. */
export type RasterBounds = Readonly<{ horizontal: number; vertical: number; size: number }>;
export const RASTER_BOUNDS: RasterBounds = Object.freeze({
  horizontal: 0.5,
  vertical: 0.25,
  size: 1,
});

/**
 * The bounds a raster term exceeds, one message per bound, each starting with its name. A named
 * limit (section 6.3, a dated amendment) is passed as `bounds` for its fixture alone.
 */
export function rasterFailures(term: RasterTerm, bounds: RasterBounds = RASTER_BOUNDS): string[] {
  const failures: string[] = [];
  if (term.subOffsetX > bounds.horizontal) {
    failures.push(`horizontal ${term.subOffsetX} > ${bounds.horizontal}`);
  }
  if (Math.abs(term.subOffsetY) > bounds.vertical) {
    failures.push(`vertical ${term.subOffsetY} outside ±${bounds.vertical}`);
  }
  if (term.subSizeDiff > bounds.size) failures.push(`size ${term.subSizeDiff} > ${bounds.size}`);
  return failures;
}

type Affine = readonly [number, number, number, number, number, number];
type Camera = Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>;

/** E28-K1 to K3 for one cluster, recomputed from the leaf's world transform and the camera. */
export type ExpectedPlacement = Readonly<{
  origin: readonly [number, number];
  deviceSize: number;
  bucket: number;
  corner: readonly [number, number];
  phaseX: number;
}>;

/**
 * K1: the device map is `zoom × DPR` times the world transform less the camera position, and
 * `o = M(x, y)`; K2: the bucket rounds the device size half up to a quarter px up to 64 px, else
 * to a whole px (the agreement fixtures stay far below the raster cap); K3 (snapped): `q =
 * ⌊4 o.x + 0.5⌋`, `phaseX = (q mod 4) / 4`, `P = (⌊q / 4⌋, ⌊o.y + 0.5⌋)`. Uniform scale only,
 * as the agreement fixtures are.
 */
export function expectedPlacement(
  world: Affine,
  camera: Camera,
  devicePixelRatio: number,
  cluster: Readonly<{ x: number; y: number }>,
  size: number,
): ExpectedPlacement {
  const scale = camera.zoom * devicePixelRatio;
  const [a, b, c, d, e, f] = world;
  const m: Affine = [
    scale * a,
    scale * b,
    scale * c,
    scale * d,
    scale * (e - camera.position.x),
    scale * (f - camera.position.y),
  ];
  const ox = m[0] * cluster.x + m[2] * cluster.y + m[4];
  const oy = m[1] * cluster.x + m[3] * cluster.y + m[5];
  const deviceSize = size * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const bucket =
    deviceSize <= 64 ? Math.floor(4 * deviceSize + 0.5) / 4 : Math.floor(deviceSize + 0.5);
  const q = Math.floor(4 * ox + 0.5);
  return {
    origin: [ox, oy],
    deviceSize,
    bucket,
    corner: [Math.floor(q / 4), Math.floor(oy + 0.5)],
    phaseX: (((q % 4) + 4) % 4) / 4,
  };
}

/**
 * Section 6.1's placement term, exact: the probe's mode, `o`, bucket, `P` and `phaseX` equal the
 * recomputed K1 to K3, and the quantization is in its bounds (horizontal `|P.x + phaseX − o.x|`
 * ≤ 1/8 device px, vertical snap `|P.y − o.y|` ≤ 0.5). One message per failed check.
 */
export function placementFailures(
  placement: Pick<ClusterPlacement, 'mode' | 'origin' | 'bucket' | 'corner' | 'phaseX'>,
  expected: ExpectedPlacement,
): string[] {
  if (placement.mode !== 'snapped' || placement.corner === null) {
    return [`mode ${placement.mode}`];
  }
  const failures: string[] = [];
  const same = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  if (!same(placement.origin, expected.origin)) {
    failures.push(
      `origin ${JSON.stringify(placement.origin)} ≠ ${JSON.stringify(expected.origin)}`,
    );
  }
  if (placement.bucket !== expected.bucket) {
    failures.push(`bucket ${placement.bucket} ≠ ${expected.bucket}`);
  }
  if (!same(placement.corner, expected.corner)) {
    failures.push(
      `corner ${JSON.stringify(placement.corner)} ≠ ${JSON.stringify(expected.corner)}`,
    );
  }
  if (placement.phaseX !== expected.phaseX) {
    failures.push(`phaseX ${placement.phaseX} ≠ ${expected.phaseX}`);
  }
  const quantX = placement.corner[0] + placement.phaseX - placement.origin[0];
  const snapY = placement.corner[1] - placement.origin[1];
  if (Math.abs(quantX) > 1 / 8) failures.push(`quantX ${quantX} > 1/8`);
  if (Math.abs(snapY) > 0.5) failures.push(`snapY ${snapY} > 0.5`);
  return failures;
}

/** Section 6.1's layout term per cluster: flowed DOM block minus port, recorded only. */
export type LayoutTerm = Readonly<{
  clusters: readonly Readonly<{
    index: number;
    text: string;
    run: number;
    line: number;
    portLine: number;
    /** CSS px at the displayed size. */
    dx: number;
    dBaseline: number;
    dxDevice: number;
    dBaselineDevice: number;
  }>[];
  maxAbsDx: number;
  maxAbsDBaseline: number;
  /** Clusters on another line than the port's. */
  lineMismatches: number;
  /** The same line count and every cluster on the port's line. */
  sameLines: boolean;
}>;

export function layoutTerm(flowed: FlowedReference, devicePixelRatio: number): LayoutTerm {
  const clusters = flowed.clusters.map((cluster) => {
    const dx = cluster.x - cluster.portX;
    const dBaseline = cluster.baseline - cluster.portBaseline;
    return {
      index: cluster.index,
      text: cluster.text,
      run: cluster.run,
      line: cluster.line,
      portLine: cluster.portLine,
      dx,
      dBaseline,
      dxDevice: dx * devicePixelRatio,
      dBaselineDevice: dBaseline * devicePixelRatio,
    };
  });
  const lineMismatches = clusters.filter((cluster) => cluster.line !== cluster.portLine).length;
  return {
    clusters,
    maxAbsDx: Math.max(0, ...clusters.map((cluster) => Math.abs(cluster.dx))),
    maxAbsDBaseline: Math.max(0, ...clusters.map((cluster) => Math.abs(cluster.dBaseline))),
    lineMismatches,
    sameLines: lineMismatches === 0 && flowed.lines === flowed.portLines,
  };
}

/** The start offset of each line of a layout (section 6.2's structural expectation). */
export function lineStarts<Line extends Readonly<{ start: number }>>(
  layout: Readonly<{ lines: readonly Line[] }>,
): number[] {
  return layout.lines.map((line) => line.start);
}
