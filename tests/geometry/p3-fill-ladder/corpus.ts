// P3 Alt-A1 unit AL-U2 (docs/plans/p3-alt-a1-fill-ladder-contract.md sections 4.2 and 4.4):
// the randomized generic-coordinate family `p3-fill-ladder-random/v1`, the binary input of the
// ignored Rust test `emit_fill_ladder_dump`, and the dump sets of section 4.2. Only erasable
// TypeScript; its one runtime import is the `p3-b0r-random/v1` module, whose xorshift32,
// source caps and corpus frame it reuses unchanged.
import {
  encodeRandomCorpus,
  maxCubicSides,
  VERB_CLOSE,
  VERB_CUBIC,
  VERB_LINE,
  VERB_MOVE,
  withinSourceCaps,
  Xorshift32,
  type RandomFamily,
  type RandomPath,
} from '../p3-b0r/corpus.js';

/** The family's identifier (contract section 4.2). */
export const LADDER_CORPUS_ID = 'p3-fill-ladder-random/v1';
/** The one family of the corpus, in the `p3-b0r-random/v1` frame (`P3BRRND1`). */
export const LADDER_FAMILY: RandomFamily = Object.freeze({
  id: 'L1-generic-ladder',
  title: 'generic-coordinate rings, side by side or nested, cubic, line and mixed edges, scaled',
  entry: 'attempt',
});
/** Seed of the family's xorshift32 (13, 17, 5) stream, recorded here as section 4.2 asks. */
export const LADDER_SEED = 0x4c414452;
/** Paths in the full family; the CI dump set takes the first `LADDER_CI_PATHS`. */
export const LADDER_PATHS = 2_000;
export const LADDER_CI_PATHS = 200;
/** AL-FR0's range (contract section 3.2). */
export const MIN_FAST_EXPONENT = -511;
export const MAX_FAST_EXPONENT = 510;

type Point = readonly [number, number];
type Segment =
  | { readonly kind: 'line'; readonly end: Point }
  | { readonly kind: 'cubic'; readonly c1: Point; readonly c2: Point; readonly end: Point };
interface Contour {
  readonly start: Point;
  readonly segments: readonly Segment[];
}
type EdgeKind = 'cubic' | 'line' | 'mixed';

const TAU = 2 * Math.PI;
/** Outward control offset per edge length for a nominal leaf count, as B0's map. */
const BULGE: readonly number[] = [1 / 128, 3 / 64, 3 / 16, 3 / 8];

function regular(sides: number, radius: number, centre: Point, phase: number): Point[] {
  const vertices: Point[] = [];
  for (let index = 0; index < sides; index += 1) {
    const phi = (TAU * index) / sides + phase;
    vertices.push([centre[0] + radius * Math.cos(phi), centre[1] + radius * Math.sin(phi)]);
  }
  return vertices;
}

/** A closed contour through counterclockwise `vertices`, cubic edges bulging outward. */
function ring(vertices: readonly Point[], offset: number, kind: EdgeKind, random: Xorshift32) {
  const segments: Segment[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index]!;
    const end = vertices[(index + 1) % vertices.length]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    const [nx, ny] = [dy / length, -dx / length];
    if (kind === 'line' || (kind === 'mixed' && random.chance(0.5)))
      segments.push({ kind: 'line', end });
    else
      segments.push({
        kind: 'cubic',
        c1: [start[0] + dx / 3 + offset * nx, start[1] + dy / 3 + offset * ny],
        c2: [start[0] + (2 * dx) / 3 + offset * nx, start[1] + (2 * dy) / 3 + offset * ny],
        end,
      });
  }
  return { start: vertices[0]!, segments } satisfies Contour;
}

function reverse(contour: Contour): Contour {
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
  return { start: contour.segments.at(-1)!.end, segments };
}

function encode(contours: readonly Contour[], scale: number, rule: 0 | 1, exponent: number) {
  const verbs: number[] = [];
  const points: number[] = [];
  const push = (point: Point) => points.push(point[0] * scale, point[1] * scale);
  for (const contour of contours) {
    verbs.push(VERB_MOVE);
    push(contour.start);
    for (const segment of contour.segments) {
      if (segment.kind === 'line') {
        verbs.push(VERB_LINE);
        push(segment.end);
      } else {
        verbs.push(VERB_CUBIC);
        push(segment.c1);
        push(segment.c2);
        push(segment.end);
      }
    }
    verbs.push(VERB_CLOSE);
  }
  return { rule, exponent, verbs, points } satisfies RandomPath;
}

/**
 * One path. Generic (unsnapped) coordinates: one to four rings, side by side or nested, each
 * contour reversed with probability 1/2, cubic, line or mixed edges with B0's bulges. The
 * flattening exponent is e = e₀ + p with e₀ in {−4, −3, −2} relative to edges of length 4-16,
 * and the coordinates are scaled exactly by 2^p. Three strata: p in [−40, 40] for 70% of the
 * paths; |e| in [400, 510], inside AL-FR0's range [−511, 510], for 15%; and |p| in [515, 1000]
 * for 15%, so that e leaves the range up to |e| ≈ 1004, inside V2's −1021 ≤ e ≤ 1023. The bound
 * |p| ≤ 1000 keeps every coordinate finite: before scaling they stay below 2^8 in magnitude,
 * and the nonzero ones of v1 lie between about 3.5·10^-300 and 6.7·10^301.
 */
function ladderPath(random: Xorshift32): RandomPath {
  const contours = random.pick([1, 1, 2, 2, 3, 4]);
  const nested = contours > 1 && random.chance(0.5);
  const kind = random.pick(['cubic', 'cubic', 'cubic', 'mixed', 'mixed', 'line'] as const);
  const limit = Math.min(12, maxCubicSides(contours));
  const list: Contour[] = [];
  const origin: Point = [random.range(-40, 40), random.range(-40, 40)];
  let radius = 0;
  let x = origin[0];
  for (let k = 0; k < contours; k += 1) {
    const sides = random.int(3, limit);
    const bulge = random.pick(BULGE);
    if (!nested || k === 0) {
      const edge = random.range(4, 16);
      radius = edge / (2 * Math.sin(Math.PI / sides));
    }
    const offset = bulge * 2 * radius * Math.sin(Math.PI / sides);
    const centre: Point = nested ? origin : [x + radius + offset, origin[1] + random.range(-3, 3)];
    const contour = ring(regular(sides, radius, centre, TAU * random.next()), offset, kind, random);
    list.push(random.chance(0.5) ? reverse(contour) : contour);
    if (nested) {
      // The next ring fits inside this ring's inradius, clear of its inward-free bulges.
      radius = (radius * Math.cos(Math.PI / sides) - offset) * random.range(0.4, 0.75);
    } else x += 2 * (radius + offset) + random.range(1, 6);
  }
  const base = random.pick([-4, -3, -2]);
  const stratum = random.next();
  const sign = random.chance(0.5) ? 1 : -1;
  let power: number;
  if (stratum < 0.7) power = sign * random.int(0, 40);
  else if (stratum < 0.85) power = sign * random.int(400, 510) - base;
  else power = sign * random.int(515, 1000);
  return encode(list, 2 ** power, random.chance(0.5) ? 1 : 0, base + power);
}

/** The family's paths, in order; a draw outside the source caps is discarded. */
export function generateLadderCorpus(paths = LADDER_PATHS): RandomPath[] {
  const random = new Xorshift32(LADDER_SEED);
  const generated: RandomPath[] = [];
  while (generated.length < paths) {
    const path = ladderPath(random);
    if (withinSourceCaps(path)) generated.push(path);
  }
  return generated;
}

/** The family in the `p3-b0r-random/v1` frame, which the native harnesses read. */
export function encodeLadderCorpus(paths = generateLadderCorpus()): Uint8Array {
  return encodeRandomCorpus([{ family: LADDER_FAMILY, paths }]);
}

// ------------------------------------------------------------------------------------------
// The input of `emit_fill_ladder_dump` (frame `P3FLDIN1`).

export const DUMP_INPUT_MAGIC = 'P3FLDIN1';

export type HexPoint = readonly [string, string];
export type ViewOwner =
  | Readonly<{ kind: 'line'; sourceVerb: number }>
  | Readonly<{ kind: 'cubicLeaf'; sourceVerb: number; endNumerator: number; depth: number }>
  | Readonly<{ kind: 'implicitClosure'; contour: number }>
  | Readonly<{ kind: 'explicitClose'; sourceVerb: number }>;
export type ViewSource = Readonly<{
  kind: 'line' | 'cubic';
  sourceVerb: number;
  contour: number;
  points: readonly HexPoint[];
}>;
export type InputView = Readonly<{
  ranges: readonly (readonly [number, number])[];
  points: readonly HexPoint[];
  owners: readonly ViewOwner[];
  sources: readonly ViewSource[];
}>;

/** One dump input: a real path through the ladder, or a synthetic S1 view on rung 0 alone. */
export type DumpInput = Readonly<{
  name: string;
  rule: 0 | 1;
  exponent: number;
  /** `LadderFault` variant names, switched on around the whole entry (seeded defects). */
  faults?: readonly string[];
}> &
  (
    | Readonly<{ kind: 'path'; verbs: readonly number[]; points: readonly number[] }>
    | Readonly<{ kind: 'view'; view: InputView }>
  );

const OWNER_TAGS = { line: 0, cubicLeaf: 1, implicitClosure: 2, explicitClose: 3 } as const;

function hexValue(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  return view.getFloat64(0);
}

/**
 * Little-endian: magic, u32 entry count; per entry u32 name length, name, u8 kind (0 path,
 * 1 view), u8 rule, i32 exponent, u32 fault-list length, comma-separated fault names; a path:
 * u32 verb count, verbs, u32 scalar count, f64 scalars; a view: u32 range count, (u32 start,
 * u32 count) each, u32 point count, (f64 x, f64 y) each, u32 owner count, (u8 tag, u32, u32,
 * u32) each, u32 source count, (u8 tag, u32 source verb, u32 contour, 2 or 4 points) each.
 */
export function encodeDumpInput(entries: readonly DumpInput[]): Uint8Array {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const scratch = new DataView(new ArrayBuffer(8));
  const u8 = (value: number) => bytes.push(value & 0xff);
  const u32 = (value: number, signed = false) => {
    if (signed) scratch.setInt32(0, value, true);
    else scratch.setUint32(0, value, true);
    for (let index = 0; index < 4; index += 1) bytes.push(scratch.getUint8(index));
  };
  const f64 = (value: number) => {
    scratch.setFloat64(0, value, true);
    for (let index = 0; index < 8; index += 1) bytes.push(scratch.getUint8(index));
  };
  const text = (value: string) => {
    const encoded = encoder.encode(value);
    u32(encoded.length);
    for (const byte of encoded) bytes.push(byte);
  };
  const point = ([x, y]: HexPoint) => {
    f64(hexValue(x));
    f64(hexValue(y));
  };
  for (const byte of encoder.encode(DUMP_INPUT_MAGIC)) bytes.push(byte);
  u32(entries.length);
  for (const entry of entries) {
    text(entry.name);
    u8(entry.kind === 'path' ? 0 : 1);
    u8(entry.rule);
    u32(entry.exponent, true);
    text((entry.faults ?? []).join(','));
    if (entry.kind === 'path') {
      u32(entry.verbs.length);
      for (const verb of entry.verbs) u8(verb);
      u32(entry.points.length);
      for (const value of entry.points) f64(value);
      continue;
    }
    const { view } = entry;
    u32(view.ranges.length);
    for (const [start, count] of view.ranges) {
      u32(start);
      u32(count);
    }
    u32(view.points.length);
    for (const item of view.points) point(item);
    u32(view.owners.length);
    for (const owner of view.owners) {
      u8(OWNER_TAGS[owner.kind]);
      const fields =
        owner.kind === 'cubicLeaf'
          ? [owner.sourceVerb, owner.endNumerator, owner.depth]
          : owner.kind === 'implicitClosure'
            ? [owner.contour, 0, 0]
            : [owner.sourceVerb, 0, 0];
      for (const field of fields) u32(field);
    }
    u32(view.sources.length);
    for (const source of view.sources) {
      u8(source.kind === 'line' ? 0 : 1);
      u32(source.sourceVerb);
      u32(source.contour);
      for (const item of source.points) point(item);
    }
  }
  return Uint8Array.from(bytes);
}

/** Hex bits of a binary64 value, as the spike hand-off writes them. */
export function hexBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

export function hexPoint(x: number, y: number): HexPoint {
  return [hexBits(x), hexBits(y)];
}

/**
 * AL-F3 and AL-F4 (contract section 4.3) as the S1 view that `fill_ladder_tests.rs`'s
 * `al_closure_rectangle(κ)` builds: the rectangle m = (0, 0), (4, 0), (4, 3), p = (0, 3),
 * closed by the cubic p, (3/32, 2), (0, 1), m whose single leaf ends at k = (0, κ), then the
 * degenerate `ExplicitClose` [k, m].
 */
export function alClosureRectangle(kappa: number): InputView {
  const p = (x: number, y: number) => hexPoint(x, y);
  return {
    ranges: [[0, 5]],
    points: [p(0, 0), p(4, 0), p(4, 3), p(0, 3), p(0, kappa)],
    owners: [
      { kind: 'line', sourceVerb: 1 },
      { kind: 'line', sourceVerb: 2 },
      { kind: 'line', sourceVerb: 3 },
      { kind: 'cubicLeaf', sourceVerb: 4, endNumerator: 1, depth: 0 },
      { kind: 'explicitClose', sourceVerb: 5 },
    ],
    sources: [
      { kind: 'line', sourceVerb: 1, contour: 0, points: [p(0, 0), p(4, 0)] },
      { kind: 'line', sourceVerb: 2, contour: 0, points: [p(4, 0), p(4, 3)] },
      { kind: 'line', sourceVerb: 3, contour: 0, points: [p(4, 3), p(0, 3)] },
      {
        kind: 'cubic',
        sourceVerb: 4,
        contour: 0,
        points: [p(0, 3), p(3 / 32, 2), p(0, 1), p(0, 0)],
      },
    ],
  };
}

/** A path with every contour closed, from flat coordinate lists. */
function polygonPath(name: string, rule: 0 | 1, exponent: number, rings: number[][]): DumpInput {
  const verbs: number[] = [];
  for (const ringPoints of rings) {
    verbs.push(VERB_MOVE);
    for (let index = 2; index < ringPoints.length; index += 2) verbs.push(VERB_LINE);
    verbs.push(VERB_CLOSE);
  }
  return { name, kind: 'path', rule, exponent, verbs, points: rings.flat() };
}

const rectangle = (x0: number, y0: number, x1: number, y1: number) => [
  x0,
  y0,
  x1,
  y0,
  x1,
  y1,
  x0,
  y1,
];
const SQUARE_10 = rectangle(0, 0, 10, 10);

/**
 * The real-path fixtures of section 4.3 (AL-F1, AL-F2, AL-F5, AL-F6 and AL-F7's synthetic real
 * inputs, as `fill_ladder_tests.rs` builds them). AL-F7's corpus inputs and AL-F9 are B0 paths
 * in the B0 dump set.
 */
export function fixturePaths(): DumpInput[] {
  const kappa = 0.5522847498307935 * 1024;
  const r = 1024;
  return [
    polygonPath('fixture/AL-F1/e=511', 0, 511, [SQUARE_10]),
    polygonPath('fixture/AL-F1/e=-512', 0, -512, [SQUARE_10]),
    polygonPath('fixture/AL-F2/e=510', 0, 510, [SQUARE_10]),
    polygonPath('fixture/AL-F2/e=-511', 0, -511, [SQUARE_10]),
    polygonPath('fixture/AL-F5/nonzero', 0, -3, [SQUARE_10]),
    polygonPath('fixture/AL-F5/evenodd', 1, -3, [SQUARE_10]),
    {
      name: 'fixture/AL-F6',
      kind: 'path',
      rule: 0,
      exponent: -3,
      verbs: [VERB_MOVE, VERB_CUBIC, VERB_CLOSE],
      points: [0, 0, 1, 2, 3, 2, 4, 0],
    },
    polygonPath('fixture/F02', 0, -3, [SQUARE_10, rectangle(3, 3, 7, 7)]),
    polygonPath('fixture/F04', 0, -3, [SQUARE_10, SQUARE_10]),
    polygonPath('fixture/F06', 0, -3, [[0, 0, 4, 4, 0, 4, 4, 0]]),
    polygonPath('fixture/F07', 0, -3, [rectangle(0, 0, 2, 2), rectangle(2, 0, 4, 2)]),
    polygonPath('fixture/SL-F3', 0, -3, [rectangle(0, 0, 1, 1), rectangle(1.25, 0, 2.25, 1)]),
    polygonPath('fixture/SL-F4', 0, -3, [
      rectangle(0, 0, 1, 1),
      rectangle(1.25 + 2 ** -20, 0, 2.25 + 2 ** -20, 1),
    ]),
    {
      name: 'fixture/SL-F15',
      kind: 'path',
      rule: 0,
      exponent: -3,
      verbs: [VERB_MOVE, VERB_LINE, VERB_LINE, VERB_LINE, VERB_CLOSE, VERB_MOVE, VERB_LINE],
      points: [0, 0, 10, 0, 10, 10, 0, 10, 20, 0, 21, 0],
    },
    {
      name: 'fixture/big-circle',
      kind: 'path',
      rule: 0,
      exponent: -3,
      verbs: [VERB_MOVE, VERB_CUBIC, VERB_CUBIC, VERB_CUBIC, VERB_CUBIC, VERB_CLOSE],
      points: [
        r,
        0,
        r,
        kappa,
        kappa,
        r,
        0,
        r,
        -kappa,
        r,
        -r,
        kappa,
        -r,
        0,
        -r,
        -kappa,
        -kappa,
        -r,
        0,
        -r,
        kappa,
        -r,
        r,
        -kappa,
        r,
        0,
      ],
    },
  ];
}

/** A B0 corpus path by cell and index, as an input named `b0/<cell>#<index>`. */
export function b0Input(
  cell: string,
  index: number,
  verbs: readonly number[],
  points: readonly number[],
): DumpInput {
  return { name: `b0/${cell}#${index}`, kind: 'path', rule: 0, exponent: -3, verbs, points };
}

/** A ladder-family path as an input named `ladder/<index>`. */
export function ladderInput(index: number, path: RandomPath): DumpInput {
  return {
    name: `ladder/${index}`,
    kind: 'path',
    rule: path.rule,
    exponent: path.exponent,
    verbs: path.verbs,
    points: path.points,
  };
}
