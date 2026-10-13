// P3 B0R randomized identity corpus `p3-b0r-random/v1`, frozen by
// docs/plans/p3-b0r-kernel-performance-contract.md section 7 ("Randomized corpus"). Six
// families of 2,000 paths each, seeded xorshift32 (13, 17, 5) from 0x42305231, every path
// within the source caps of `cubic_fill.rs`. Only erasable TypeScript and no runtime import,
// so that the Node identity tool can load this module directly.

export const RANDOM_CORPUS_ID = 'p3-b0r-random/v1';
export const RANDOM_CORPUS_MAGIC = 'P3BRRND1';
export const RANDOM_SEED = 0x42305231;
export const FAMILY_PATHS = 2_000;

export const VERB_MOVE = 0;
export const VERB_LINE = 1;
export const VERB_CUBIC = 2;
export const VERB_CLOSE = 3;

/** Source caps of `cubic_fill.rs` (MAX_SOURCE_VERBS, MAX_SOURCE_SCALARS, MAX_CONTOURS, MAX_SOURCE_SEGMENTS). */
export const SOURCE_CAPS = Object.freeze({ verbs: 24, scalars: 104, contours: 4, segments: 16 });

/** Flattening tolerance 2^e and topology tolerance 2^(e-1), as fill-v0 `tolerances(e)`. */
export const DEFAULT_EXPONENT = -3;

/** Native entry the family is designed for; the harness runs every entry on every path. */
export type RandomEntry =
  'attempt' | 'attempt_transverse' | 'attempt_mixed_transverse' | 'attempt_triangle_free';

export const ENTRY_CODES: Readonly<Record<RandomEntry, number>> = Object.freeze({
  attempt: 0,
  attempt_transverse: 1,
  attempt_mixed_transverse: 2,
  attempt_triangle_free: 3,
});

export interface RandomFamily {
  readonly id: string;
  readonly title: string;
  readonly entry: RandomEntry;
}

/** The six families in corpus order. */
export const FAMILIES: readonly RandomFamily[] = Object.freeze([
  {
    id: 'F1-generic-rings',
    title: 'B0 rings, unsnapped, C 1-4, s 3-16, lambda 1-8',
    entry: 'attempt',
  },
  { id: 'F2-nested-rings', title: 'nested rings, both orientations', entry: 'attempt' },
  {
    id: 'F3-touching-rings',
    title: 'rings sharing a vertex or a collinear edge span',
    entry: 'attempt',
  },
  {
    id: 'F4-star-wave',
    title: 'star and wave paths with crossings',
    entry: 'attempt_triangle_free',
  },
  {
    id: 'F5-near-degenerate',
    title: 'collinear controls, ulp perturbations, extreme scales, mixed sources, vertical edges',
    entry: 'attempt',
  },
  {
    id: 'F6-slivers',
    title: 'thin slivers, overlapping leaf boxes with disjoint hulls',
    entry: 'attempt',
  },
] as const);

/** One path: fill rule (0 nonzero, 1 evenodd), tolerance exponent, verbs and scalars. */
export interface RandomPath {
  readonly rule: 0 | 1;
  readonly exponent: number;
  readonly verbs: readonly number[];
  readonly points: readonly number[];
}

/** Coverage floors of contract section 7, checked by the identity tool over the native results. */
export const COVERAGE_FLOORS = Object.freeze({
  ok: 1_000,
  knotMismatch: 100,
  unresolved: 100,
  capFailure: 100,
  okWithCrossings: 100,
});

/** xorshift32 with shifts 13, 17, 5; u = state / 2^32 drawn after each update. */
export class Xorshift32 {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  nextU32(): number {
    let x = this.state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.state = x;
    return x;
  }
  next(): number {
    return this.nextU32() / 2 ** 32;
  }
  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

type Point = readonly [number, number];
type Segment =
  | { readonly kind: 'line'; readonly end: Point }
  | { readonly kind: 'cubic'; readonly c1: Point; readonly c2: Point; readonly end: Point };

interface Contour {
  readonly start: Point;
  readonly segments: readonly Segment[];
}

const TAU = 2 * Math.PI;
const GRID = 1024;

function snapValue(value: number): number {
  return Math.round(value * GRID) / GRID;
}

function snapPoint(point: Point): Point {
  return [snapValue(point[0]), snapValue(point[1])];
}

/** The binary64 neighbour of `value` one ulp up (direction 1) or down (direction -1). */
export function ulpStep(value: number, direction: 1 | -1): number {
  if (value === 0) return direction * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const away = value > 0 === direction > 0;
  view.setBigUint64(0, away ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

/** Cubic from start to end with controls at the chord thirds pushed by `offset` along the right normal. */
function bulgedCubic(start: Point, end: Point, offset: number): Segment {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  const nx = length === 0 ? 0 : dy / length;
  const ny = length === 0 ? 0 : -dx / length;
  return {
    kind: 'cubic',
    c1: [start[0] + dx / 3 + offset * nx, start[1] + dy / 3 + offset * ny],
    c2: [start[0] + (2 * dx) / 3 + offset * nx, start[1] + (2 * dy) / 3 + offset * ny],
    end,
  };
}

function regularVertices(sides: number, radius: number, centre: Point, rho: number): Point[] {
  const vertices: Point[] = [];
  for (let index = 0; index < sides; index += 1) {
    const phi = (TAU * index) / sides + rho;
    vertices.push([centre[0] + radius * Math.cos(phi), centre[1] + radius * Math.sin(phi)]);
  }
  return vertices;
}

type EdgeKind = 'cubic' | 'line' | 'mixed';

/** Closed contour through `vertices` (counter-clockwise input), bulging outward by `offset`. */
function ringContour(
  vertices: readonly Point[],
  offset: number,
  kind: EdgeKind,
  random: Xorshift32,
): Contour {
  const segments: Segment[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index]!;
    const end = vertices[(index + 1) % vertices.length]!;
    const line = kind === 'line' || (kind === 'mixed' && random.chance(0.5));
    segments.push(line ? { kind: 'line', end } : bulgedCubic(start, end, offset));
  }
  return { start: vertices[0]!, segments };
}

function reverseContour(contour: Contour): Contour {
  const starts: Point[] = [contour.start];
  for (const segment of contour.segments.slice(0, -1)) starts.push(segment.end);
  const segments: Segment[] = [];
  for (let index = contour.segments.length - 1; index >= 0; index -= 1) {
    const segment = contour.segments[index]!;
    const end = starts[index]!;
    segments.push(
      segment.kind === 'line'
        ? { kind: 'line', end }
        : { kind: 'cubic', c1: segment.c2, c2: segment.c1, end },
    );
  }
  return { start: contour.segments[contour.segments.length - 1]!.end, segments };
}

function mapContour(contour: Contour, map: (point: Point) => Point): Contour {
  return {
    start: map(contour.start),
    segments: contour.segments.map((segment) =>
      segment.kind === 'line'
        ? { kind: 'line', end: map(segment.end) }
        : { kind: 'cubic', c1: map(segment.c1), c2: map(segment.c2), end: map(segment.end) },
    ),
  };
}

function encodePath(contours: readonly Contour[], rule: 0 | 1, exponent: number): RandomPath {
  const verbs: number[] = [];
  const points: number[] = [];
  for (const contour of contours) {
    verbs.push(VERB_MOVE);
    points.push(contour.start[0], contour.start[1]);
    for (const segment of contour.segments) {
      if (segment.kind === 'line') {
        verbs.push(VERB_LINE);
        points.push(segment.end[0], segment.end[1]);
      } else {
        verbs.push(VERB_CUBIC);
        points.push(
          segment.c1[0],
          segment.c1[1],
          segment.c2[0],
          segment.c2[1],
          segment.end[0],
          segment.end[1],
        );
      }
    }
    verbs.push(VERB_CLOSE);
  }
  return { rule, exponent, verbs, points };
}

/** True when the path respects every source cap and every scalar is finite. */
export function withinSourceCaps(path: RandomPath): boolean {
  const contours = path.verbs.filter((verb) => verb === VERB_MOVE).length;
  const segments = path.verbs.filter((verb) => verb === VERB_LINE || verb === VERB_CUBIC).length;
  return (
    path.verbs.length <= SOURCE_CAPS.verbs &&
    path.points.length <= SOURCE_CAPS.scalars &&
    contours >= 1 &&
    contours <= SOURCE_CAPS.contours &&
    segments <= SOURCE_CAPS.segments &&
    path.points.every(Number.isFinite)
  );
}

/** Largest sides per contour so that C contours of s cubics meet every source cap. */
export function maxCubicSides(contours: number): number {
  let sides = 0;
  while (
    contours * (sides + 1) <= SOURCE_CAPS.segments &&
    contours * (sides + 3) <= SOURCE_CAPS.verbs &&
    contours * (2 + 6 * (sides + 1)) <= SOURCE_CAPS.scalars
  )
    sides += 1;
  return sides;
}

/** Outward control offset per edge length for a nominal lambda (B0's map, extended to 1). */
const BULGE_BY_LAMBDA: Readonly<Record<number, number>> = Object.freeze({
  1: 1 / 128,
  2: 3 / 64,
  4: 3 / 16,
  8: 3 / 8,
});

const rule = (random: Xorshift32): 0 | 1 => (random.chance(0.5) ? 1 : 0);

function family1(random: Xorshift32): RandomPath {
  const contours = random.int(1, 4);
  const sides = random.int(3, Math.min(16, maxCubicSides(contours)));
  const lambda = random.pick([1, 2, 4, 8]);
  const edge = random.range(4, 16);
  const offset = BULGE_BY_LAMBDA[lambda]! * edge;
  const radius = edge / (2 * Math.sin(Math.PI / sides));
  const origin: Point = [random.range(-50, 50), random.range(-50, 50)];
  const list: Contour[] = [];
  for (let k = 0; k < contours; k += 1) {
    const centre: Point = [origin[0] + k * (2 * (radius + offset) + 4), origin[1]];
    const contour = ringContour(
      regularVertices(sides, radius, centre, TAU * random.next()),
      offset,
      'cubic',
      random,
    );
    list.push(k % 2 === 1 ? reverseContour(contour) : contour);
  }
  return encodePath(list, rule(random), DEFAULT_EXPONENT);
}

function family2(random: Xorshift32): RandomPath {
  const contours = random.int(2, 4);
  const snapped = random.chance(0.5);
  const centre: Point = [random.range(-20, 20), random.range(-20, 20)];
  let radius = random.range(20, 60);
  const list: Contour[] = [];
  for (let k = 0; k < contours; k += 1) {
    const sides = random.int(3, maxCubicSides(contours));
    const offset = random.range(0, 0.08) * radius;
    // Cubic outward extent is at most 0.75 offset; the next ring fits inside this ring's inradius.
    let contour = ringContour(
      regularVertices(sides, radius, centre, TAU * random.next()),
      offset,
      random.chance(0.2) ? 'mixed' : 'cubic',
      random,
    );
    if (snapped) contour = mapContour(contour, snapPoint);
    list.push(random.chance(0.5) ? reverseContour(contour) : contour);
    const inradius = radius * Math.cos(Math.PI / sides);
    radius = (inradius - offset) * random.range(0.45, 0.8);
  }
  return encodePath(list, rule(random), DEFAULT_EXPONENT);
}

function family3(random: Xorshift32): RandomPath {
  const list: Contour[] = [];
  const variant = random.int(0, 2);
  if (variant === 0) {
    // Two or three rings sharing one vertex.
    const sides = random.int(3, 5);
    const radius = random.range(5, 30);
    const offset = random.range(0, 0.15) * radius;
    const a = mapContour(
      ringContour(
        regularVertices(sides, radius, [0, 0], TAU * random.next()),
        offset,
        'cubic',
        random,
      ),
      snapPoint,
    );
    const shared = a.start;
    // Point reflection through the shared vertex: the second ring lies on the far side.
    const b = mapContour(a, ([x, y]) => [2 * shared[0] - x, 2 * shared[1] - y]);
    list.push(a, random.chance(0.5) ? reverseContour(b) : b);
    if (random.chance(0.3)) {
      // A third, disjoint copy far above both.
      const lift = snapValue(5 * radius + 10);
      list.push(mapContour(a, ([x, y]) => [x, y + lift]));
    }
  } else {
    // Axis-aligned rectangles sharing a collinear edge span.
    const w = snapValue(random.range(4, 40));
    const h = snapValue(random.range(4, 40));
    const shift = snapValue(random.range(-0.8, 0.8) * w);
    const w2 = snapValue(random.range(4, 40));
    const h2 = snapValue(random.range(4, 40));
    const kind: EdgeKind = random.pick(['line', 'cubic', 'mixed'] as const);
    const rect = (x0: number, y0: number, x1: number, y1: number): Contour =>
      ringContour(
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ],
        0,
        kind,
        random,
      );
    list.push(rect(0, 0, w, h));
    const second =
      variant === 1 ? rect(shift, h, shift + w2, h + h2) : rect(w, shift, w + w2, shift + h2);
    list.push(random.chance(0.5) ? reverseContour(second) : second);
  }
  return encodePath(list, rule(random), DEFAULT_EXPONENT);
}

function family4(random: Xorshift32): RandomPath {
  if (random.chance(0.5)) {
    // Star polygon {s/k}.
    const sides = random.int(5, 15);
    const step = random.int(2, Math.max(2, Math.floor((sides - 1) / 2)));
    const radius = random.range(8, 60);
    const vertices = regularVertices(
      sides,
      radius,
      [random.range(-20, 20), random.range(-20, 20)],
      TAU * random.next(),
    );
    const order: Point[] = [];
    for (let index = 0; index < sides; index += 1) order.push(vertices[(index * step) % sides]!);
    const offset = random.chance(0.5) ? 0 : random.range(0, 0.04) * radius;
    let contour = ringContour(
      order,
      offset,
      random.pick(['line', 'cubic', 'mixed'] as const),
      random,
    );
    if (random.chance(0.5)) contour = mapContour(contour, snapPoint);
    return encodePath([contour], rule(random), DEFAULT_EXPONENT);
  }
  // Wave band whose upper and lower boundaries cross.
  const lobes = random.int(1, 7);
  const width = random.range(20, 120);
  const amplitude = random.range(2, 20);
  const gap = random.range(-0.9, 0.9) * amplitude;
  const step = width / lobes;
  const segments: Segment[] = [];
  const start: Point = [0, gap];
  let sign = 1;
  for (let index = 0; index < lobes; index += 1) {
    const x0 = index * step;
    const x1 = x0 + step;
    segments.push({
      kind: 'cubic',
      c1: [x0 + step / 3, gap + sign * amplitude],
      c2: [x0 + (2 * step) / 3, gap + sign * amplitude],
      end: [x1, gap],
    });
    sign = -sign;
  }
  segments.push({ kind: 'line', end: [width, -gap] });
  sign = lobes % 2 === 0 ? 1 : -1;
  for (let index = lobes - 1; index >= 0; index -= 1) {
    const x1 = index * step;
    const x0 = x1 + step;
    segments.push({
      kind: 'cubic',
      c1: [x0 - step / 3, -gap - sign * amplitude],
      c2: [x0 - (2 * step) / 3, -gap - sign * amplitude],
      end: [x1, -gap],
    });
    sign = -sign;
  }
  let contour: Contour = { start, segments };
  const angle = random.chance(0.5) ? 0 : TAU * random.next();
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  contour = mapContour(contour, ([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
  if (random.chance(0.5)) contour = mapContour(contour, snapPoint);
  return encodePath([contour], rule(random), DEFAULT_EXPONENT);
}

function family5(random: Xorshift32): RandomPath {
  const variant = random.int(0, 5);
  const sides = random.int(3, 8);
  const radius = random.range(5, 40);
  const centre: Point = [random.range(-30, 30), random.range(-30, 30)];
  const vertices = regularVertices(sides, radius, centre, TAU * random.next());
  let exponent = DEFAULT_EXPONENT;
  let contour: Contour;
  switch (variant) {
    case 0: {
      // Collinear controls, sometimes overshooting the chord.
      const overshoot = random.chance(0.5) ? random.range(-0.3, 0.3) : 0;
      const segments: Segment[] = vertices.map((start, index) => {
        const end = vertices[(index + 1) % sides]!;
        const lerp = (t: number): Point => [
          start[0] + t * (end[0] - start[0]),
          start[1] + t * (end[1] - start[1]),
        ];
        return { kind: 'cubic', c1: lerp(1 / 3 - overshoot), c2: lerp(2 / 3 + overshoot), end };
      });
      contour = mapContour({ start: vertices[0]!, segments }, snapPoint);
      break;
    }
    case 1: {
      // One-ulp perturbation of a control of a snapped linear cubic.
      const base = mapContour(ringContour(vertices, 0, 'cubic', random), snapPoint);
      const target = random.int(0, sides - 1);
      const axis = random.int(0, 1);
      const direction = random.chance(0.5) ? 1 : -1;
      contour = {
        start: base.start,
        segments: base.segments.map((segment, index) => {
          if (index !== target || segment.kind !== 'cubic') return segment;
          const c1: Point =
            axis === 0
              ? [ulpStep(segment.c1[0], direction), segment.c1[1]]
              : [segment.c1[0], ulpStep(segment.c1[1], direction)];
          return { ...segment, c1 };
        }),
      };
      break;
    }
    case 2:
    case 3: {
      // Coordinates near 2^-30 or 2^40; the tolerance follows the scale in half the cases.
      const power = variant === 2 ? -30 + random.int(-2, 2) : 40 + random.int(-2, 2);
      const scale = 2 ** power / radius;
      const offset = random.range(0, 0.2) * radius;
      contour = mapContour(ringContour(vertices, offset, 'cubic', random), ([x, y]) => [
        (x - centre[0]) * scale,
        (y - centre[1]) * scale,
      ]);
      if (random.chance(0.5)) exponent = power - 6;
      break;
    }
    case 4:
      // Mixed LINE and CUBIC sources.
      contour = ringContour(vertices, random.range(0, 0.25) * radius, 'mixed', random);
      break;
    default: {
      // Vertical edges: an axis-aligned polygon with cubic or line edges.
      const w = random.range(4, 60);
      const h = random.range(4, 60);
      const notch = random.range(0.2, 0.8);
      const shape: Point[] = random.chance(0.5)
        ? [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
          ]
        : [
            [0, 0],
            [w, 0],
            [w, h],
            [w * notch, h],
            [w * notch, h * notch],
            [0, h * notch],
          ];
      contour = ringContour(
        shape.map(([x, y]) => [x + centre[0], y + centre[1]] as Point),
        random.chance(0.5) ? 0 : random.range(-0.1, 0.1) * w,
        random.pick(['line', 'cubic', 'mixed'] as const),
        random,
      );
      if (random.chance(0.5)) contour = mapContour(contour, snapPoint);
    }
  }
  const list = [random.chance(0.5) ? reverseContour(contour) : contour];
  return encodePath(list, rule(random), exponent);
}

function family6(random: Xorshift32): RandomPath {
  const angle = TAU * random.next();
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const rotate = ([x, y]: Point): Point => [x * cos - y * sin, x * sin + y * cos];
  const list: Contour[] = [];
  if (random.chance(0.5)) {
    // A thin rotated sliver: its long edges have overlapping boxes but disjoint hulls.
    const length = random.range(20, 120);
    const width = length * 10 ** random.range(-3, -1);
    const pieces = random.int(1, 6);
    // Counter-clockwise: the lower edge left to right, then the upper edge right to left,
    // each split into collinear pieces; at most 14 vertices.
    const ring: Point[] = [];
    for (let index = 0; index <= pieces; index += 1) ring.push([(length * index) / pieces, 0]);
    for (let index = 0; index <= pieces; index += 1)
      ring.push([length - (length * index) / pieces, width]);
    // A negative offset bulges the cubics inward, keeping the sliver thin.
    const offset = random.chance(0.5) ? 0 : -random.range(0, 0.2) * width;
    list.push(
      mapContour(
        ringContour(ring, offset, random.pick(['line', 'cubic', 'mixed'] as const), random),
        rotate,
      ),
    );
  } else {
    // Two or three parallel thin bands close together.
    const bands = random.int(2, 3);
    const length = random.range(20, 120);
    const width = random.range(0.05, 2);
    const gap = width * random.range(0.05, 1);
    for (let index = 0; index < bands; index += 1) {
      const y0 = index * (width + gap);
      const band = ringContour(
        [
          [0, y0],
          [length, y0],
          [length, y0 + width],
          [0, y0 + width],
        ],
        random.chance(0.5) ? 0 : -random.range(0, 0.1) * width,
        random.pick(['line', 'cubic', 'mixed'] as const),
        random,
      );
      const placed = mapContour(band, rotate);
      list.push(random.chance(0.5) ? reverseContour(placed) : placed);
    }
  }
  const snapped = random.chance(0.3) ? list.map((contour) => mapContour(contour, snapPoint)) : list;
  return encodePath(snapped, rule(random), DEFAULT_EXPONENT);
}

const GENERATORS = [family1, family2, family3, family4, family5, family6] as const;

/** Every family with its paths; each family draws from its own stream, seeded from the master seed. */
export function generateRandomCorpus(
  paths = FAMILY_PATHS,
): { family: RandomFamily; paths: RandomPath[] }[] {
  const master = new Xorshift32(RANDOM_SEED);
  const seeds = FAMILIES.map(() => master.nextU32() || 1);
  return FAMILIES.map((family, index) => {
    const random = new Xorshift32(seeds[index]!);
    const generated: RandomPath[] = [];
    while (generated.length < paths) {
      const path = GENERATORS[index]!(random);
      // A draw outside the source caps is discarded; the stream continues deterministically.
      if (withinSourceCaps(path)) generated.push(path);
    }
    return { family, paths: generated };
  });
}

/**
 * Little-endian framed corpus, like the B0 frame: magic, u32 family count; per family u32 id
 * length, id, u8 entry code, u32 path count; per path u8 rule, i32 exponent, u32 verb count,
 * verbs, u32 scalar count, f64 scalars.
 */
export function encodeRandomCorpus(corpus = generateRandomCorpus()): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const u32 = (value: number, signed = false) => {
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    if (signed) view.setInt32(0, value, true);
    else view.setUint32(0, value, true);
    return bytes;
  };
  chunks.push(encoder.encode(RANDOM_CORPUS_MAGIC), u32(corpus.length));
  for (const { family, paths } of corpus) {
    const id = encoder.encode(family.id);
    chunks.push(u32(id.length), id, Uint8Array.of(ENTRY_CODES[family.entry]), u32(paths.length));
    for (const path of paths) {
      chunks.push(Uint8Array.of(path.rule), u32(path.exponent, true));
      chunks.push(u32(path.verbs.length), Uint8Array.from(path.verbs));
      const scalars = new Uint8Array(path.points.length * 8);
      const view = new DataView(scalars.buffer);
      path.points.forEach((value, index) => view.setFloat64(index * 8, value, true));
      chunks.push(u32(path.points.length), scalars);
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
