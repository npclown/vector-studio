import { COVERAGE_FLOOR, type Pixels } from './m6c-agreement';

// M6c-U4 (MVP M6c contract, section 10, M6c-A05 and A08): the pure half of the headed scene spec
// (m6c-scene.spec.ts) and the visible-typing spec (m6c-typing.spec.ts), unit tested in
// tests/unit/m6c-u4-scene.test.ts. No browser and no renderer import: the device map, the E28-K2
// bucket, the E28-K3 phase and the E28-K9 bound are recomputed here, apart from renderer-core, as
// m6c-agreement.ts recomputes K1 to K3.
//
// A cluster is judged from three crops over the same device rectangle: the probe's GPU cluster
// (`readCluster`, black on white, opacity 1, so its coverage is `α = (255 − min(R, G, B)) / 255`),
// the host frame with the text shown, and the host frame with every text node hidden (the
// background the text is drawn over). Each probe ink pixel (coverage above M6-S0's floor of 2/255)
// is classified by the leaf's cover rule:
// - hidden: inside a shape painted above the text, outside the clipping frame, outside the mask
//   source. The shown frame must equal the background there (the text is cut or covered).
// - visible: the shown frame must be the background darkened by the black text at the leaf's
//   group opacity `o`: per channel at most `bg · (1 − o·α) + tolerance` (a neighbouring cluster
//   can only darken it further) and at least `bg · (1 − o) − tolerance` (never darker than the
//   group's opacity allows, which also bounds an isolated group's overlaps).
// - edge: within `margin` device px of a rule's boundary (antialiasing), not judged.

/** A page or local point. */
export type Point = Readonly<{ x: number; y: number }>;
export type Affine = readonly [number, number, number, number, number, number];
export type Camera = Readonly<{ position: Point; zoom: number }>;

/** E28-K1: the device map of a leaf, `zoom × DPR` times its world transform less the camera. */
export function deviceMap(world: Affine, camera: Camera, devicePixelRatio: number): Affine {
  const scale = camera.zoom * devicePixelRatio;
  const [a, b, c, d, e, f] = world;
  return [
    scale * a,
    scale * b,
    scale * c,
    scale * d,
    scale * (e - camera.position.x),
    scale * (f - camera.position.y),
  ];
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The inverse of a non-singular affine. */
export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) throw new Error('singular affine');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** A region of the canvas in device px. */
export type Region =
  | Readonly<{ kind: 'rect'; x0: number; y0: number; x1: number; y1: number }>
  | Readonly<{ kind: 'polygon'; points: readonly (readonly [number, number])[] }>;

/** A page rectangle (`frame`, unrotated) mapped to device px by `camera` and the DPR. */
export function deviceRect(
  frame: Readonly<{ x: number; y: number; width: number; height: number }>,
  camera: Camera,
  devicePixelRatio: number,
): Region {
  const m = deviceMap([1, 0, 0, 1, 0, 0], camera, devicePixelRatio);
  const [x0, y0] = applyAffine(m, frame.x, frame.y);
  const [x1, y1] = applyAffine(m, frame.x + frame.width, frame.y + frame.height);
  return { kind: 'rect', x0, y0, x1, y1 };
}

/**
 * A path's points (the model's unit box `[0, 1]²` of its frame) placed in an unrotated page
 * frame, as a device polygon.
 */
export function devicePolygon(
  unitPoints: readonly number[],
  frame: Readonly<{ x: number; y: number; width: number; height: number }>,
  camera: Camera,
  devicePixelRatio: number,
): Region {
  const m = deviceMap([1, 0, 0, 1, 0, 0], camera, devicePixelRatio);
  const points: [number, number][] = [];
  for (let index = 0; index + 1 < unitPoints.length; index += 2) {
    points.push(
      applyAffine(
        m,
        frame.x + unitPoints[index]! * frame.width,
        frame.y + unitPoints[index + 1]! * frame.height,
      ),
    );
  }
  return { kind: 'polygon', points };
}

function segmentDistance(
  px: number,
  py: number,
  [ax, ay]: readonly [number, number],
  [bx, by]: readonly [number, number],
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Signed distance from `(x, y)` to the region's boundary: negative inside, positive outside. */
export function signedDistance(region: Region, x: number, y: number): number {
  if (region.kind === 'rect') {
    const x0 = Math.min(region.x0, region.x1);
    const x1 = Math.max(region.x0, region.x1);
    const y0 = Math.min(region.y0, region.y1);
    const y1 = Math.max(region.y0, region.y1);
    const dx = Math.max(x0 - x, x - x1);
    const dy = Math.max(y0 - y, y - y1);
    if (dx <= 0 && dy <= 0) return Math.max(dx, dy);
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }
  const { points } = region;
  let inside = false;
  let distance = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    distance = Math.min(distance, segmentDistance(x, y, points[j]!, points[i]!));
  }
  return inside ? -distance : distance;
}

/** What may show of a leaf: inside every `within` region and outside every occluder. */
export type CoverRule = Readonly<{ within: readonly Region[]; occluders: readonly Region[] }>;
export const OPEN_RULE: CoverRule = Object.freeze({ within: [], occluders: [] });

export type PixelState = 'visible' | 'hidden' | 'edge';

/** The state of the point `(x, y)` (a pixel centre) under `rule`, `margin` device px of slack. */
export function pixelState(rule: CoverRule, x: number, y: number, margin: number): PixelState {
  let edge = false;
  for (const region of rule.within) {
    const distance = signedDistance(region, x, y);
    if (distance > margin) return 'hidden';
    if (distance > -margin) edge = true;
  }
  for (const region of rule.occluders) {
    const distance = signedDistance(region, x, y);
    if (distance < -margin) return 'hidden';
    if (distance < margin) edge = true;
  }
  return edge ? 'edge' : 'visible';
}

/** Probe coverage at or above this (of 255) is strong ink, which must change the shown frame. */
export const STRONG_INK = 64;
/**
 * Probe coverage at or above this (α ≥ 0.75) is dense: drawn at full opacity it falls below a
 * half-opacity group's floor `bg · 0.5 − tolerance`, so a dense pixel that passes proves the
 * group's opacity was applied.
 */
export const SOLID_INK = 192;
/** Per-channel slack of the composite, out of 255 (8-bit blending, the isolated group pass). */
export const COMPOSITE_TOLERANCE = 3;
/** Device px of slack around a cover rule's boundary. */
export const EDGE_MARGIN = 1.5;

export type ClusterJudgement = {
  /** Probe ink pixels (coverage above the floor) in each state. */
  visible: number;
  hidden: number;
  edge: number;
  /** Visible pixels of strong probe ink, and how many of them changed in the shown frame. */
  strong: number;
  strongChanged: number;
  /** Strong visible pixels whose background is not white (the text is over a shape). */
  strongOnColour: number;
  /** Visible pixels of dense probe ink (`SOLID_INK`, for a group's opacity). */
  solid: number;
  /** Hidden pixels whose shown frame differs from the background by more than one level. */
  hiddenChanged: number;
  /** Hidden pixels under another leaf's ink (`others`), not judged. */
  hiddenShared: number;
  /** Up to four `[x, y, probe ink, shown R, G, B, background R, G, B]` per failing kind. */
  samples: Record<'hiddenChanged' | 'tooLight' | 'tooDark' | 'strongUnchanged', number[][]>;
  /** Visible channel values above (lighter) or below (darker) the composite bounds. */
  tooLight: number;
  tooDark: number;
  worstLight: number;
  worstDark: number;
};

const sameRect = (a: Pixels, b: Pixels) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Judges one probe cluster against the shown frame and the background over the same rect. */
export function judgeCluster(
  input: Readonly<{
    probe: Pixels;
    shown: Pixels;
    background: Pixels;
    rule: CoverRule;
    opacity: number;
    margin?: number;
    tolerance?: number;
    /**
     * Pixels another leaf's probe ink covers (a device px mask of `width` columns, as
     * `inkMask`): a hidden pixel there may change by that leaf's ink, so it is counted as
     * `hiddenShared` and not judged (pre-run of 0f8eb08: `clip-text`'s tail beyond its frame lies
     * on `mask-text`).
     */
    others?: Readonly<{ mask: Uint8Array; width: number }>;
  }>,
): ClusterJudgement {
  const { probe, shown, background, rule, opacity } = input;
  if (!sameRect(probe, shown) || !sameRect(probe, background)) {
    throw new Error('the probe, shown and background crops must cover one rectangle');
  }
  const margin = input.margin ?? EDGE_MARGIN;
  const tolerance = input.tolerance ?? COMPOSITE_TOLERANCE;
  const out: ClusterJudgement = {
    visible: 0,
    hidden: 0,
    edge: 0,
    strong: 0,
    strongChanged: 0,
    strongOnColour: 0,
    solid: 0,
    hiddenChanged: 0,
    hiddenShared: 0,
    samples: { hiddenChanged: [], tooLight: [], tooDark: [], strongUnchanged: [] },
    tooLight: 0,
    tooDark: 0,
    worstLight: 0,
    worstDark: 0,
  };
  for (let row = 0; row < probe.height; row += 1) {
    for (let column = 0; column < probe.width; column += 1) {
      const i = (row * probe.width + column) * 4;
      const ink = 255 - Math.min(probe.rgba[i]!, probe.rgba[i + 1]!, probe.rgba[i + 2]!);
      if (ink <= COVERAGE_FLOOR) continue;
      const state = pixelState(rule, probe.x + column + 0.5, probe.y + row + 0.5, margin);
      let changed = false;
      for (let channel = 0; channel < 3; channel += 1) {
        if (Math.abs(shown.rgba[i + channel]! - background.rgba[i + channel]!) > 1) changed = true;
      }
      if (state === 'edge') {
        out.edge += 1;
        continue;
      }
      const x = probe.x + column;
      const y = probe.y + row;
      const sample = (kind: keyof ClusterJudgement['samples']) => {
        if (out.samples[kind].length >= 4) return;
        out.samples[kind].push([
          x,
          y,
          ink,
          shown.rgba[i]!,
          shown.rgba[i + 1]!,
          shown.rgba[i + 2]!,
          background.rgba[i]!,
          background.rgba[i + 1]!,
          background.rgba[i + 2]!,
        ]);
      };
      if (state === 'hidden') {
        if (input.others !== undefined && input.others.mask[y * input.others.width + x] === 1) {
          out.hiddenShared += 1;
          continue;
        }
        out.hidden += 1;
        if (changed) {
          out.hiddenChanged += 1;
          sample('hiddenChanged');
        }
        continue;
      }
      out.visible += 1;
      const alpha = ink / 255;
      if (ink >= STRONG_INK) {
        out.strong += 1;
        if (changed) out.strongChanged += 1;
        else sample('strongUnchanged');
        const white = [0, 1, 2].every((channel) => background.rgba[i + channel]! >= 250);
        if (!white) out.strongOnColour += 1;
      }
      if (ink >= SOLID_INK) out.solid += 1;
      let light = false;
      let dark = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const bg = background.rgba[i + channel]!;
        const value = shown.rgba[i + channel]!;
        const upper = bg * (1 - opacity * alpha) + tolerance;
        const lower = bg * (1 - opacity) - tolerance;
        if (value > upper) {
          out.tooLight += 1;
          out.worstLight = Math.max(out.worstLight, value - upper);
          light = true;
        }
        if (value < lower) {
          out.tooDark += 1;
          out.worstDark = Math.max(out.worstDark, lower - value);
          dark = true;
        }
      }
      if (light) sample('tooLight');
      if (dark) sample('tooDark');
    }
  }
  return out;
}

/** A crop of uniform colour, for a background known by construction (A08's white backdrop). */
export function uniformPixels(
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
  rgb: readonly [number, number, number],
): Pixels {
  const rgba = new Uint8Array(rect.width * rect.height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = rgb[0];
    rgba[offset + 1] = rgb[1];
    rgba[offset + 2] = rgb[2];
    rgba[offset + 3] = 255;
  }
  return { ...rect, rgba };
}

/** A cluster's local layout values (`x`, `y` the pen origin on the baseline). */
export type LocalCluster = Readonly<{ x: number; y: number; advance: number }>;

/**
 * The share of the probe's ink mass whose pixel centres, mapped back through the inverse of the
 * device map `map`, fall inside the cluster's local box: from `x − 0.3 · size` to
 * `x + advance + 0.3 · size` and from `y − 1.3 · size` to `y + 0.5 · size`. A cluster drawn at
 * another rotation, scale or position than its leaf's map puts its ink outside. Null for no ink.
 */
export function localInkShare(
  probe: Pixels,
  map: Affine,
  cluster: LocalCluster,
  size: number,
): number | null {
  const inverse = invertAffine(map);
  const left = cluster.x + Math.min(cluster.advance, 0) - 0.3 * size;
  const right = cluster.x + Math.max(cluster.advance, 0) + 0.3 * size;
  const top = cluster.y - 1.3 * size;
  const bottom = cluster.y + 0.5 * size;
  let total = 0;
  let inside = 0;
  for (let row = 0; row < probe.height; row += 1) {
    for (let column = 0; column < probe.width; column += 1) {
      const i = (row * probe.width + column) * 4;
      const ink = 255 - Math.min(probe.rgba[i]!, probe.rgba[i + 1]!, probe.rgba[i + 2]!);
      if (ink <= COVERAGE_FLOOR) continue;
      const [lx, ly] = applyAffine(inverse, probe.x + column + 0.5, probe.y + row + 0.5);
      total += ink;
      if (lx >= left && lx <= right && ly >= top && ly <= bottom) inside += ink;
    }
  }
  return total === 0 ? null : inside / total;
}

/** Probe ink pixels outside a device rectangle (the port's bitmap rectangle of a snapped cluster). */
export function inkOutside(
  probe: Pixels,
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
): number {
  let outside = 0;
  for (let row = 0; row < probe.height; row += 1) {
    for (let column = 0; column < probe.width; column += 1) {
      const i = (row * probe.width + column) * 4;
      const ink = 255 - Math.min(probe.rgba[i]!, probe.rgba[i + 1]!, probe.rgba[i + 2]!);
      if (ink <= COVERAGE_FLOOR) continue;
      const x = probe.x + column;
      const y = probe.y + row;
      if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) {
        outside += 1;
      }
    }
  }
  return outside;
}

/** E28's raster cap and the snap tolerance of K3's uniform-scale test (renderer-core). */
const RASTER_CAP = 256;
const SNAP_TOLERANCE = 1e-9;

/** One cluster as E28 requests its raster, recomputed from the leaf, camera and DPR. */
export type ClusterKey = Readonly<{
  /** `[lang, fontList, text, bucket, phaseX]` as JSON. */
  key: string;
  text: string;
  mode: 'snapped' | 'general' | 'omitted';
  bound: Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
}>;

/** A text leaf as `scene()` gives it, reduced to what the keys need. */
export type KeyLeaf = Readonly<{
  world: Affine;
  leaf: Readonly<{
    lang: string;
    runs: readonly Readonly<{
      fontList: string;
      size: number;
      clusters: readonly Readonly<{ text: string; x: number; y: number; advance: number }>[];
    }>[];
  }>;
}>;

/**
 * Each cluster's raster key: K2's bucket (the device size rounded half up to a quarter px up to
 * 64 px, else to a whole px, at most the cap); K3's phase when snapped (an axis-aligned uniform
 * scale and a device size at most the cap), else 0; K9's bound (`x ± size` beyond the advance,
 * `y − 2·size` to `y + size`) mapped to device px. Below 0.5 device px a cluster is omitted.
 */
export function clusterKeys(
  entry: KeyLeaf,
  camera: Camera,
  devicePixelRatio: number,
): ClusterKey[] {
  const m = deviceMap(entry.world, camera, devicePixelRatio);
  const [a, b, c, d] = m;
  const sigma = Math.sqrt(Math.abs(a * d - b * c));
  const tolerance = SNAP_TOLERANCE * sigma;
  const uniform =
    a > 0 &&
    d > 0 &&
    Math.abs(a - sigma) <= tolerance &&
    Math.abs(d - sigma) <= tolerance &&
    Math.abs(b) <= tolerance &&
    Math.abs(c) <= tolerance;
  const out: ClusterKey[] = [];
  for (const run of entry.leaf.runs) {
    const deviceSize = run.size * sigma;
    const rounded =
      deviceSize <= 64 ? Math.floor(4 * deviceSize + 0.5) / 4 : Math.floor(deviceSize + 0.5);
    const bucket = Math.min(rounded, RASTER_CAP);
    const mode =
      deviceSize < 0.5 ? 'omitted' : uniform && deviceSize <= RASTER_CAP ? 'snapped' : 'general';
    for (const cluster of run.clusters) {
      const [ox] = applyAffine(m, cluster.x, cluster.y);
      const phaseX = mode === 'snapped' ? (((Math.floor(4 * ox + 0.5) % 4) + 4) % 4) / 4 : 0;
      const xs: number[] = [];
      const ys: number[] = [];
      const left = cluster.x + Math.min(cluster.advance, 0) - run.size;
      const right = cluster.x + Math.max(cluster.advance, 0) + run.size;
      for (const [x, y] of [
        [left, cluster.y - 2 * run.size],
        [right, cluster.y - 2 * run.size],
        [left, cluster.y + run.size],
        [right, cluster.y + run.size],
      ] as const) {
        const [dx, dy] = applyAffine(m, x, y);
        xs.push(dx);
        ys.push(dy);
      }
      out.push({
        key: JSON.stringify([entry.leaf.lang, run.fontList, cluster.text, bucket, phaseX]),
        text: cluster.text,
        mode,
        bound: {
          x0: Math.min(...xs),
          y0: Math.min(...ys),
          x1: Math.max(...xs),
          y1: Math.max(...ys),
        },
      });
    }
  }
  return out;
}

/** The raster keys one generation of a page draws (A05's generation change). */
export type KeySets = Readonly<{
  /** Every key E28 requests: white space included, each once per generation. */
  exact: ReadonlySet<string>;
  /** The non-space keys among them: each uploads one bitmap. */
  exactInk: ReadonlySet<string>;
}>;

/**
 * The request set of renderer-core's `planTextFrame`: every drawn cluster (device size ≥ 0.5) of
 * a shown leaf whose E28-K9 bound meets the target with the 2 device px guard, white space
 * included; a clip or a mask does not cull a request (it cuts the drawn pixels only).
 */
export function rasterKeySets(
  entries: readonly (KeyLeaf & Readonly<{ shown: boolean }>)[],
  camera: Camera,
  devicePixelRatio: number,
  target: Readonly<{ width: number; height: number }>,
  guard = 2,
): KeySets {
  const meets = (b: ClusterKey['bound']) =>
    !(
      b.x1 < -guard ||
      b.y1 < -guard ||
      b.x0 > target.width + guard ||
      b.y0 > target.height + guard
    );
  const exact = new Set<string>();
  const exactInk = new Set<string>();
  for (const entry of entries) {
    if (!entry.shown) continue;
    for (const value of clusterKeys(entry, camera, devicePixelRatio)) {
      if (value.mode === 'omitted' || !meets(value.bound)) continue;
      exact.add(value.key);
      if (value.text.trim().length > 0) exactInk.add(value.key);
    }
  }
  return { exact, exactInk };
}

/** A raster port call as the host's log records it (src/renderer-options.ts). */
export type RasterCall = Readonly<{
  generation: number | null;
  text: string;
  fontList: string;
  lang: string;
  pixelSize: number;
  phaseX: number;
}>;

/** A logged call's key, in `clusterKeys`' form. */
export const callKey = (call: RasterCall) =>
  JSON.stringify([call.lang, call.fontList, call.text, call.pixelSize, call.phaseX]);

/**
 * Review S2: the calls of one bump against the request set of its final generation. At the final
 * generation every key of `exact` is rasterized exactly once and nothing else; a generation
 * between `from` (exclusive) and the final one rasterizes no key twice and none outside `exact`
 * (the same face, two bumps of one load); no call is at `from` or older, or without a generation.
 */
export function rasterCallFailures(
  calls: readonly RasterCall[],
  exact: ReadonlySet<string>,
  from: number,
  final: number,
): string[] {
  const failures: string[] = [];
  const byGeneration = new Map<number, string[]>();
  for (const call of calls) {
    if (call.generation === null || call.generation <= from || call.generation > final) {
      failures.push(`call at generation ${call.generation}: ${callKey(call)}`);
      continue;
    }
    const list = byGeneration.get(call.generation) ?? [];
    list.push(callKey(call));
    byGeneration.set(call.generation, list);
  }
  for (const [generation, keys] of byGeneration) {
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) failures.push(`generation ${generation}: ${key} rasterized twice`);
      seen.add(key);
      if (!exact.has(key)) failures.push(`generation ${generation}: ${key} not requested`);
    }
  }
  const last = new Set(byGeneration.get(final) ?? []);
  for (const key of exact) {
    if (!last.has(key)) failures.push(`generation ${final}: ${key} not rasterized`);
  }
  return failures;
}

/**
 * Review S3: a device px mask (1 = may hold ink) of every pixel with any probe coverage, grown by
 * `grow` px, over a `width` × `height` frame.
 */
export function inkMask(
  width: number,
  height: number,
  crops: readonly Pixels[],
  grow = 1,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const crop of crops) {
    for (let row = 0; row < crop.height; row += 1) {
      for (let column = 0; column < crop.width; column += 1) {
        const i = (row * crop.width + column) * 4;
        if (Math.min(crop.rgba[i]!, crop.rgba[i + 1]!, crop.rgba[i + 2]!) === 255) continue;
        const x = crop.x + column;
        const y = crop.y + row;
        for (let dy = -grow; dy <= grow; dy += 1) {
          for (let dx = -grow; dx <= grow; dx += 1) {
            const mx = x + dx;
            const my = y + dy;
            if (mx >= 0 && my >= 0 && mx < width && my < height) mask[my * width + mx] = 1;
          }
        }
      }
    }
  }
  return mask;
}

/** Packs a 0/1 pixel flag array into bits, row major, as the page sends its changed pixels. */
export function packBits(flags: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.ceil(flags.length / 8));
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] !== 0) out[index >> 3]! |= 1 << (index & 7);
  }
  return out;
}

/**
 * Review S3: changed pixels (`changedBits`, one bit per pixel, row major) outside the ink mask:
 * ink no probe cluster accounts for. Returns the count and up to eight `[x, y]` samples.
 */
export function extraInk(
  changedBits: Uint8Array,
  mask: Uint8Array,
  width: number,
): Readonly<{ count: number; sample: readonly (readonly [number, number])[] }> {
  let count = 0;
  const sample: [number, number][] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (((changedBits[index >> 3]! >> (index & 7)) & 1) === 0 || mask[index] === 1) continue;
    count += 1;
    if (sample.length < 8) sample.push([index % width, Math.floor(index / width)]);
  }
  return { count, sample };
}
