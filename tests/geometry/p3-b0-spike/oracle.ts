/**
 * P3 B0 spike, unit SL-U2 (`docs/plans/p3-b0-spike-ladder-contract.md` sections 4.1-4.5 and
 * 4.8): independent TypeScript oracles over the `emit_spike_fixtures` hand-off.
 *
 * - SL-O1 (section 4.1) re-derives, from the dumped source bits, owners and polygon bits alone,
 *   each edge's source piece, the closure class of every contour, the micro-closure
 *   contractions and SL-C0, then re-checks SL-C1 to SL-C4 and SL-M1 to SL-M4 in exact rational
 *   arithmetic over every pair (no sweep, no interval). It shares no code or algorithm with the
 *   Rust fast rung: restricted controls come from the cubic's blossom instead of de Casteljau
 *   bit walking, distances are exact rationals instead of interval bounds, and every
 *   non-consecutive pair is checked.
 * - SL-O2 (section 4.2) checks a mesh against the exact region R(P) of the polygon: exact
 *   simplicity of P, orientations from exact shoelace areas, nesting from exact winding
 *   numbers, the boundary contours, positive triangles, the vertex set, the cancelled
 *   directed-edge chain against the oriented boundary and the exact area; it also runs
 *   `inspectTriangleMesh` of `packages/geometry-reference` (P3.1b).
 * - SL-O3 (section 4.3) compares the exact rung's published polygon with the fast rung's S1
 *   view and checks the exact area band.
 * - SL-O5 (section 4.5) computes observational Float64 sliver statistics.
 */
import { inspectTriangleMesh } from '../../../packages/geometry-reference/src/triangle-mesh.js';
import { nearestRank } from '../p3-b0/analysis.js';
import {
  add,
  compare,
  div,
  exactInteger,
  fromBits,
  mul,
  rational,
  sign,
  sub,
  ZERO,
  type Rational,
} from '../rounded-fill/exact.js';

// ------------------------------------------------------------------------------------------
// Hand-off schema `p3-b0-spike-fixtures/1` (section 4.8).

export const FIXTURES_SCHEMA = 'p3-b0-spike-fixtures/1';
export const FRAME_BEGIN = 'P3_B0_SPIKE_FIXTURES_BEGIN';
export const FRAME_END = 'P3_B0_SPIKE_FIXTURES_END';

export type Hex = string;
export type HexPoint = readonly [Hex, Hex];
export type FillRule = 'nonzero' | 'evenodd';
export type Reason =
  | 'PREFIX'
  | 'STRUCTURE'
  | 'DEVIATION'
  | 'CLOSURE'
  | 'MONOTONE'
  | 'CROSSING'
  | 'CLEARANCE'
  | 'TRIANGLE';
export type Stage = 'S1' | 'Fr1' | 'Fr2' | 'Fr3' | 'Fr4' | 'Fr5' | 'Fr6' | 'Fr7' | 'Fr8';

export type SpikeOwner =
  | Readonly<{ kind: 'line'; sourceVerb: number }>
  | Readonly<{ kind: 'cubicLeaf'; sourceVerb: number; endNumerator: number; depth: number }>
  | Readonly<{ kind: 'implicitClosure'; contour: number }>
  | Readonly<{ kind: 'explicitClose'; sourceVerb: number }>;

export type SpikeSource = Readonly<{
  kind: 'line' | 'cubic';
  sourceVerb: number;
  contour: number;
  points: readonly HexPoint[];
}>;

export type SpikeView = Readonly<{
  ranges: readonly (readonly [start: number, count: number])[];
  points: readonly HexPoint[];
  owners: readonly SpikeOwner[];
  sources: readonly SpikeSource[];
}>;

export type SpikeMesh = Readonly<{
  vertices: readonly HexPoint[];
  triangles: readonly (readonly [number, number, number])[];
}>;

export type SpikeExpected =
  | Readonly<{
      kind: 'fast';
      area: Hex | null;
      boundary: readonly number[] | null;
      triangles: number | null;
    }>
  | Readonly<{ kind: 'fallback'; reason: Reason }>
  | Readonly<{ kind: 'passes'; stage: Stage }>;

export type SpikeEntry = SpikeView &
  Readonly<{
    id: string;
    kind: 'view' | 'ladder';
    rule: FillRule;
    expected: SpikeExpected;
    stop: Stage;
    rung: 'fast' | 'fallback' | 'none';
    reason: Reason | null;
    maxDeviationSquared: Hex | null;
    mesh: SpikeMesh | null;
    exact?: SpikeView & Readonly<{ mesh: SpikeMesh }>;
  }>;

export type SpikeDefectEntry = Readonly<{ defect: string; entry: SpikeEntry }>;

export type SpikeFixtures = Readonly<{
  schema: typeof FIXTURES_SCHEMA;
  delta: Hex;
  fixtures: readonly SpikeEntry[];
  defects: readonly SpikeDefectEntry[];
}>;

const REASONS: readonly Reason[] = [
  'PREFIX',
  'STRUCTURE',
  'DEVIATION',
  'CLOSURE',
  'MONOTONE',
  'CROSSING',
  'CLEARANCE',
  'TRIANGLE',
];
const STAGES: readonly Stage[] = ['S1', 'Fr1', 'Fr2', 'Fr3', 'Fr4', 'Fr5', 'Fr6', 'Fr7', 'Fr8'];

function fail(message: string): never {
  throw new Error(`spike hand-off: ${message}`);
}

function record(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(`${where} is not an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${where} keys mismatch: ${actual.join(',')}`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(`${where} is not a nonnegative integer`);
  return value;
}

function hex(value: unknown, where: string): Hex {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/u.test(value)) fail(`${where} is not hex`);
  if (!Number.isFinite(fromBits(BigInt(`0x${value}`)))) fail(`${where} is not finite`);
  return value;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} is not an array`);
  return value;
}

function hexPoint(value: unknown, where: string): HexPoint {
  const pair = list(value, where);
  if (pair.length !== 2) fail(`${where} is not a point`);
  return [hex(pair[0], `${where}.x`), hex(pair[1], `${where}.y`)];
}

function oneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(`${where} is invalid`);
  return value as T;
}

function parseOwner(value: unknown, where: string): SpikeOwner {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === 'line') {
    const owner = record(value, ['kind', 'sourceVerb'], where);
    return { kind, sourceVerb: integer(owner.sourceVerb, where) };
  }
  if (kind === 'cubicLeaf') {
    const owner = record(value, ['kind', 'sourceVerb', 'endNumerator', 'depth'], where);
    return {
      kind,
      sourceVerb: integer(owner.sourceVerb, where),
      endNumerator: integer(owner.endNumerator, where),
      depth: integer(owner.depth, where),
    };
  }
  if (kind === 'implicitClosure') {
    const owner = record(value, ['kind', 'contour'], where);
    return { kind, contour: integer(owner.contour, where) };
  }
  if (kind === 'explicitClose') {
    const owner = record(value, ['kind', 'sourceVerb'], where);
    return { kind, sourceVerb: integer(owner.sourceVerb, where) };
  }
  return fail(`${where} has an unknown owner kind`);
}

function parseSource(value: unknown, where: string): SpikeSource {
  const source = record(value, ['kind', 'sourceVerb', 'contour', 'points'], where);
  const kind = oneOf(source.kind, ['line', 'cubic'] as const, `${where}.kind`);
  const points = list(source.points, where).map((point, index) =>
    hexPoint(point, `${where}.points[${index}]`),
  );
  if (points.length !== (kind === 'line' ? 2 : 4)) fail(`${where} has the wrong point count`);
  return {
    kind,
    sourceVerb: integer(source.sourceVerb, where),
    contour: integer(source.contour, where),
    points,
  };
}

function parseViewFields(value: Record<string, unknown>, where: string): SpikeView {
  return {
    ranges: list(value.ranges, `${where}.ranges`).map((range, index) => {
      const pair = list(range, `${where}.ranges[${index}]`);
      if (pair.length !== 2) fail(`${where}.ranges[${index}] is not a range`);
      return [integer(pair[0], where), integer(pair[1], where)] as const;
    }),
    points: list(value.points, `${where}.points`).map((point, index) =>
      hexPoint(point, `${where}.points[${index}]`),
    ),
    owners: list(value.owners, `${where}.owners`).map((owner, index) =>
      parseOwner(owner, `${where}.owners[${index}]`),
    ),
    sources: list(value.sources, `${where}.sources`).map((source, index) =>
      parseSource(source, `${where}.sources[${index}]`),
    ),
  };
}

function parseMesh(value: unknown, where: string): SpikeMesh {
  const mesh = record(value, ['vertices', 'triangles'], where);
  const vertices = list(mesh.vertices, `${where}.vertices`).map((point, index) =>
    hexPoint(point, `${where}.vertices[${index}]`),
  );
  const triangles = list(mesh.triangles, `${where}.triangles`).map((triangle, index) => {
    const corners = list(triangle, `${where}.triangles[${index}]`);
    if (corners.length !== 3) fail(`${where}.triangles[${index}] is not a triangle`);
    return [
      integer(corners[0], where),
      integer(corners[1], where),
      integer(corners[2], where),
    ] as const;
  });
  return { vertices, triangles };
}

function parseExpected(value: unknown, where: string): SpikeExpected {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === 'fast') {
    const expected = record(value, ['kind', 'area', 'boundary', 'triangles'], where);
    return {
      kind,
      area: expected.area === null ? null : hex(expected.area, `${where}.area`),
      boundary:
        expected.boundary === null
          ? null
          : list(expected.boundary, `${where}.boundary`).map((contour) => integer(contour, where)),
      triangles: expected.triangles === null ? null : integer(expected.triangles, where),
    };
  }
  if (kind === 'fallback') {
    const expected = record(value, ['kind', 'reason'], where);
    return { kind, reason: oneOf(expected.reason, REASONS, `${where}.reason`) };
  }
  if (kind === 'passes') {
    const expected = record(value, ['kind', 'stage'], where);
    return { kind, stage: oneOf(expected.stage, STAGES, `${where}.stage`) };
  }
  return fail(`${where} has an unknown expectation kind`);
}

function parseEntry(value: unknown, where: string): SpikeEntry {
  const kind = (value as { kind?: unknown } | null)?.kind;
  const keys = [
    'id',
    'kind',
    'rule',
    'expected',
    'ranges',
    'points',
    'owners',
    'sources',
    'stop',
    'rung',
    'reason',
    'maxDeviationSquared',
    'mesh',
  ];
  const entry = record(value, kind === 'ladder' ? [...keys, 'exact'] : keys, where);
  if (typeof entry.id !== 'string' || entry.id.length === 0) fail(`${where}.id is invalid`);
  const rung = oneOf(entry.rung, ['fast', 'fallback', 'none'] as const, `${where}.rung`);
  const reason = entry.reason === null ? null : oneOf(entry.reason, REASONS, `${where}.reason`);
  const mesh = entry.mesh === null ? null : parseMesh(entry.mesh, `${where}.mesh`);
  if ((rung === 'fallback') !== (reason !== null)) fail(`${where} rung/reason mismatch`);
  if ((rung === 'fast') !== (mesh !== null)) fail(`${where} rung/mesh mismatch`);
  if (rung === 'fast' && entry.stop !== 'Fr8') fail(`${where} fast entry stopped before Fr8`);
  const parsed = {
    id: entry.id,
    kind: oneOf(kind, ['view', 'ladder'] as const, `${where}.kind`),
    rule: oneOf(entry.rule, ['nonzero', 'evenodd'] as const, `${where}.rule`),
    expected: parseExpected(entry.expected, `${where}.expected`),
    ...parseViewFields(entry, where),
    stop: oneOf(entry.stop, STAGES, `${where}.stop`),
    rung,
    reason,
    maxDeviationSquared:
      entry.maxDeviationSquared === null
        ? null
        : hex(entry.maxDeviationSquared, `${where}.maxDeviationSquared`),
    mesh,
  };
  if (kind !== 'ladder') return parsed;
  const exact = record(entry.exact, ['ranges', 'points', 'owners', 'sources', 'mesh'], where);
  return {
    ...parsed,
    exact: {
      ...parseViewFields(exact, `${where}.exact`),
      mesh: parseMesh(exact.mesh, `${where}.exact.mesh`),
    },
  };
}

/** Extracts and strictly parses the one framed JSON block of `emit_spike_fixtures`. */
export function parseSpikeFixtures(stdout: string): SpikeFixtures {
  if (stdout.split(FRAME_BEGIN).length !== 2 || stdout.split(FRAME_END).length !== 2)
    fail('expected exactly one frame');
  const frame = new RegExp(`${FRAME_BEGIN}\\r?\\n([\\s\\S]*?)\\r?\\n${FRAME_END}`, 'u').exec(
    stdout,
  );
  if (!frame) fail('frame is incomplete');
  const value = record(JSON.parse(frame[1]!), ['schema', 'delta', 'fixtures', 'defects'], 'root');
  if (value.schema !== FIXTURES_SCHEMA) fail('schema mismatch');
  return {
    schema: FIXTURES_SCHEMA,
    delta: hex(value.delta, 'delta'),
    fixtures: list(value.fixtures, 'fixtures').map((entry, index) =>
      parseEntry(entry, `fixtures[${index}]`),
    ),
    defects: list(value.defects, 'defects').map((item, index) => {
      const defect = record(item, ['defect', 'entry'], `defects[${index}]`);
      if (typeof defect.defect !== 'string') fail(`defects[${index}].defect is invalid`);
      return { defect: defect.defect, entry: parseEntry(defect.entry, `defects[${index}].entry`) };
    }),
  };
}

// ------------------------------------------------------------------------------------------
// Exact arithmetic on binary64 values.

/** An exact point with its bit identity. */
export type XPoint = Readonly<{ x: Rational; y: Rational; key: string }>;

const BINARY64_SCALE = 1n << 1074n;
const valueCache = new Map<Hex, Rational>();

/** The exact rational value of a binary64 given as 16 hex digits. */
export function exactHex(bits: Hex): Rational {
  let value = valueCache.get(bits);
  if (value === undefined) {
    value = rational(exactInteger(BigInt(`0x${bits}`)), BINARY64_SCALE);
    valueCache.set(bits, value);
  }
  return value;
}

export function exactPoint([x, y]: HexPoint): XPoint {
  return { x: exactHex(x), y: exactHex(y), key: `${x},${y}` };
}

function point(x: Rational, y: Rational): XPoint {
  return { x, y, key: '' };
}

function minus(a: XPoint, b: XPoint): XPoint {
  return point(sub(a.x, b.x), sub(a.y, b.y));
}

function dot(a: XPoint, b: XPoint): Rational {
  return add(mul(a.x, b.x), mul(a.y, b.y));
}

function norm2(a: XPoint): Rational {
  return dot(a, a);
}

function cross(a: XPoint, b: XPoint): Rational {
  return sub(mul(a.x, b.y), mul(a.y, b.x));
}

/** Exact orient2d: positive when a, b, c turn counterclockwise. */
function orient(a: XPoint, b: XPoint, c: XPoint): -1 | 0 | 1 {
  return sign(cross(minus(b, a), minus(c, a)));
}

function twiceArea(a: XPoint, b: XPoint, c: XPoint): Rational {
  return cross(minus(b, a), minus(c, a));
}

function samePoint(a: XPoint, b: XPoint): boolean {
  return compare(a.x, b.x) === 0 && compare(a.y, b.y) === 0;
}

/** (1 − t) a + t b. */
function lerp(a: XPoint, b: XPoint, t: Rational): XPoint {
  const s = sub(rational(1n), t);
  return point(add(mul(s, a.x), mul(t, b.x)), add(mul(s, a.y), mul(t, b.y)));
}

function combine(a: XPoint, wa: Rational, b: XPoint, wb: Rational): XPoint {
  return point(add(mul(wa, a.x), mul(wb, b.x)), add(mul(wa, a.y), mul(wb, b.y)));
}

/** The blossom b(u1, u2, u3) of a cubic Bézier curve with controls c. */
function blossom(c: readonly XPoint[], u: readonly [Rational, Rational, Rational]): XPoint {
  let level = [...c];
  for (const t of u) {
    const next: XPoint[] = [];
    for (let index = 0; index + 1 < level.length; index += 1)
      next.push(lerp(level[index]!, level[index + 1]!, t));
    level = next;
  }
  return level[0]!;
}

/** Exact restricted Bernstein controls of a cubic on [a, b], by blossoming. */
export function restrictCubic(
  controls: readonly XPoint[],
  a: Rational,
  b: Rational,
): readonly [XPoint, XPoint, XPoint, XPoint] {
  return [
    blossom(controls, [a, a, a]),
    blossom(controls, [a, a, b]),
    blossom(controls, [a, b, b]),
    blossom(controls, [b, b, b]),
  ];
}

function onCollinearSegment(a: XPoint, b: XPoint, p: XPoint): boolean {
  const between = (u: Rational, v: Rational, w: Rational): boolean =>
    compare(u, v) <= 0
      ? compare(u, w) <= 0 && compare(w, v) <= 0
      : compare(v, w) <= 0 && compare(w, u) <= 0;
  return between(a.x, b.x, p.x) && between(a.y, b.y, p.y);
}

/** Whether the closed segments [a, b] and [c, d] share a point, exactly. */
export function segmentsMeet(a: XPoint, b: XPoint, c: XPoint, d: XPoint): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (
    (o1 === 0 && onCollinearSegment(a, b, c)) ||
    (o2 === 0 && onCollinearSegment(a, b, d)) ||
    (o3 === 0 && onCollinearSegment(c, d, a)) ||
    (o4 === 0 && onCollinearSegment(c, d, b))
  );
}

/** The exact squared distance from p to the closed segment [s, t]. */
export function pointSegmentDistance2(p: XPoint, s: XPoint, t: XPoint): Rational {
  const v = minus(t, s);
  const w = minus(p, s);
  const along = dot(w, v);
  if (sign(along) <= 0) return norm2(w);
  const length2 = norm2(v);
  if (compare(length2, along) <= 0) return norm2(minus(p, t));
  return sub(norm2(w), div(mul(along, along), length2));
}

/** The exact squared distance of two disjoint closed segments (the minimum over endpoints). */
export function segmentDistance2(a: XPoint, b: XPoint, c: XPoint, d: XPoint): Rational {
  let best = pointSegmentDistance2(a, c, d);
  for (const value of [
    pointSegmentDistance2(b, c, d),
    pointSegmentDistance2(c, a, b),
    pointSegmentDistance2(d, a, b),
  ])
    if (compare(value, best) < 0) best = value;
  return best;
}

// ------------------------------------------------------------------------------------------
// SL-O1: exact certificate re-verification (section 4.1).

export type Condition =
  'SL-C0' | 'SL-C1' | 'SL-C4' | 'SL-C2' | 'SL-C3/relation' | 'SL-C3/clearance';
/** Conditions in the fast rung's stage order (section 2.6). */
export const CONDITIONS: readonly Condition[] = [
  'SL-C0',
  'SL-C1',
  'SL-C4',
  'SL-C2',
  'SL-C3/relation',
  'SL-C3/clearance',
];

export type ClosureClass =
  'exact-close' | 'non-degenerate-close' | 'degenerate-source-close' | 'closed-polygon-open-source';

type Piece =
  | Readonly<{ kind: 'cubic'; controls: readonly [XPoint, XPoint, XPoint, XPoint] }>
  | Readonly<{ kind: 'segment'; from: XPoint; to: XPoint }>;

type Edge = Readonly<{ start: XPoint; end: XPoint; piece: Piece; contour: number; label: string }>;

type Micro = Readonly<{ contour: number; p: XPoint; k: XPoint; m: XPoint; r: XPoint; q: XPoint }>;

export type CertificateResult = Readonly<{
  /** Each condition: true when it holds exactly, false when it fails, null when unevaluated. */
  holds: Readonly<Record<Condition, boolean | null>>;
  /** The first failure detail of each failing condition. */
  details: Readonly<Partial<Record<Condition, string>>>;
  closures: readonly ClosureClass[];
  /** The exact max over P′ edges of max_m |d_m|² (null when SL-C0 fails). */
  maxDeviationSquared: Rational | null;
  pairs: number;
}>;

function pieceStart(piece: Piece): XPoint {
  return piece.kind === 'cubic' ? piece.controls[0] : piece.from;
}

function pieceEnd(piece: Piece): XPoint {
  return piece.kind === 'cubic' ? piece.controls[3] : piece.to;
}

type Structure =
  | Readonly<{
      ok: true;
      contours: readonly (readonly Edge[])[];
      micros: readonly Micro[];
      closures: readonly ClosureClass[];
    }>
  | Readonly<{ ok: false; detail: string; closures: readonly ClosureClass[] }>;

/** Independent structure derivation: source pieces, closure classes and contractions. */
function deriveStructure(view: SpikeView): Structure {
  const closures: ClosureClass[] = [];
  const bad = (detail: string) => ({ ok: false as const, detail, closures });
  const points = view.points.map(exactPoint);
  const contours: Edge[][] = [];
  const micros: Micro[] = [];
  let ownerBase = 0;
  let pointBase = 0;
  for (const [contour, [start, count]] of view.ranges.entries()) {
    if (start !== pointBase) return bad(`contour ${contour} range does not follow the previous`);
    pointBase += count;
    if (count < 2) return bad(`contour ${contour} has ${count} vertices`);
    const owners = view.owners.slice(ownerBase, ownerBase + count);
    ownerBase += count;
    if (owners.length !== count) return bad(`contour ${contour} lacks owners`);
    const sources = view.sources.filter((source) => source.contour === contour);
    if (sources.length === 0) return bad(`contour ${contour} has no source`);
    for (let index = 1; index < sources.length; index += 1)
      if (sources[index]!.sourceVerb <= sources[index - 1]!.sourceVerb)
        return bad(`contour ${contour} sources out of order`);
    const bySourceVerb = new Map(sources.map((source) => [source.sourceVerb, source]));
    // The MOVE point m is the first source's start; S1 emits it unchanged.
    const m = exactPoint(sources[0]!.points[0]!);
    const z = exactPoint(sources[sources.length - 1]!.points.at(-1)!);
    const ring = points.slice(start, start + count);
    if (ring[0]!.key !== m.key) return bad(`contour ${contour} first vertex is not the MOVE point`);
    const edges: Edge[] = [];
    // Leaves of one source must partition [0, 1] in order; each nonzero line is one edge.
    const consumed: { verb: number; next: Rational }[] = [];
    for (let index = 0; index < count; index += 1) {
      const owner = owners[index]!;
      const from = ring[index]!;
      const to = ring[(index + 1) % count]!;
      const label = `contour ${contour} edge ${index}`;
      if (owner.kind === 'implicitClosure' || owner.kind === 'explicitClose') {
        if (index !== count - 1) return bad(`${label}: close edge is not last`);
        if (owner.kind === 'implicitClosure' && owner.contour !== contour)
          return bad(`${label}: closure of another contour`);
        // The CLOSE verb follows the contour's last source and precedes the next contour's.
        const nextSource = view.sources.find((source) => source.contour > contour);
        if (
          owner.kind === 'explicitClose' &&
          (owner.sourceVerb <= sources[sources.length - 1]!.sourceVerb ||
            (nextSource !== undefined && owner.sourceVerb >= nextSource.sourceVerb))
        )
          return bad(`${label}: CLOSE verb out of order`);
        edges.push({
          start: from,
          end: to,
          piece: { kind: 'segment', from: z, to: m },
          contour,
          label,
        });
        continue;
      }
      const source = bySourceVerb.get(owner.sourceVerb);
      if (source === undefined) return bad(`${label}: no source ${owner.sourceVerb}`);
      const last = consumed.at(-1);
      if (owner.kind === 'line') {
        if (source.kind !== 'line') return bad(`${label}: line owner over a cubic source`);
        if (last !== undefined && compare(last.next, rational(1n)) !== 0)
          return bad(`${label}: previous cubic source not completed`);
        consumed.push({ verb: source.sourceVerb, next: rational(1n) });
        const [a, b] = source.points.map(exactPoint);
        edges.push({
          start: from,
          end: to,
          piece: { kind: 'segment', from: a!, to: b! },
          contour,
          label,
        });
        continue;
      }
      if (source.kind !== 'cubic') return bad(`${label}: leaf owner over a line source`);
      if (owner.depth > 60) return bad(`${label}: depth ${owner.depth}`);
      const scale = 1n << BigInt(owner.depth);
      const n = BigInt(owner.endNumerator);
      if (n < 1n || n > scale) return bad(`${label}: numerator out of range`);
      const ta = rational(n - 1n, scale);
      const tb = rational(n, scale);
      if (last !== undefined && last.verb === source.sourceVerb) {
        if (compare(last.next, ta) !== 0)
          return bad(`${label}: leaf does not abut its predecessor`);
        last.next = tb;
      } else {
        if (last !== undefined && compare(last.next, rational(1n)) !== 0)
          return bad(`${label}: previous cubic source not completed`);
        if (sign(ta) !== 0) return bad(`${label}: first leaf does not start at 0`);
        consumed.push({ verb: source.sourceVerb, next: tb });
      }
      const controls = restrictCubic(source.points.map(exactPoint), ta, tb);
      edges.push({ start: from, end: to, piece: { kind: 'cubic', controls }, contour, label });
    }
    const lastConsumed = consumed.at(-1);
    if (lastConsumed !== undefined && compare(lastConsumed.next, rational(1n)) !== 0)
      return bad(`contour ${contour}: last cubic source not completed`);
    // Every source with a nonzero span is consumed exactly once, in order.
    const spanning = sources.filter(
      (source) =>
        !(
          source.kind === 'line' &&
          samePoint(exactPoint(source.points[0]!), exactPoint(source.points[1]!))
        ),
    );
    if (
      JSON.stringify(consumed.map(({ verb }) => verb)) !==
      JSON.stringify(spanning.map(({ sourceVerb }) => sourceVerb))
    )
      return bad(`contour ${contour}: sources are not consumed exactly once in order`);
    // Closure class (section 3.6).
    const closeEdge =
      owners[count - 1]!.kind === 'implicitClosure' || owners[count - 1]!.kind === 'explicitClose';
    const closedSource = samePoint(z, m);
    const closure: ClosureClass = closeEdge
      ? closedSource
        ? 'degenerate-source-close'
        : 'non-degenerate-close'
      : closedSource
        ? 'exact-close'
        : 'closed-polygon-open-source';
    closures.push(closure);
    if (closure === 'closed-polygon-open-source')
      return bad(`contour ${contour}: closed polygon over an open source`);
    // Consistency at every vertex (section 3.3): γ_e(1) = γ_f(0).
    for (let index = 0; index < count; index += 1) {
      const e = edges[index]!;
      const f = edges[(index + 1) % count]!;
      if (!samePoint(pieceEnd(e.piece), pieceStart(f.piece)))
        return bad(`${e.label}: source piece does not meet the next one`);
    }
    if (closure === 'degenerate-source-close') {
      // SL-L5: delete k, merge e and the close edge g into e′ = [p, m] with γ_e′ = γ_e.
      if (count < 3) return bad(`contour ${contour}: no edge before the close edge`);
      const e = edges[count - 2]!;
      const g = edges[count - 1]!;
      const h = edges[(count - 3 + count) % count]!;
      const f = edges[0]!;
      micros.push({ contour, p: e.start, k: g.start, m, r: h.start, q: f.end });
      edges.splice(count - 2, 2, { ...e, end: m, label: `${e.label} (merged e′)` });
    }
    // SL-C0 after contraction: at least three edges, each with distinct endpoints.
    if (edges.length < 3) return bad(`contour ${contour}: ${edges.length} edges after contraction`);
    for (const edge of edges)
      if (samePoint(edge.start, edge.end)) return bad(`${edge.label}: zero length`);
    contours.push(edges);
  }
  if (pointBase !== view.points.length) return bad('ranges do not cover the points');
  if (ownerBase !== view.owners.length) return bad('owners do not match the ranges');
  if (view.sources.some((source) => source.contour >= view.ranges.length))
    return bad('a source belongs to no contour');
  return { ok: true, contours, micros, closures };
}

function deviationControls(edge: Edge): readonly XPoint[] {
  const { start: s, end: e, piece } = edge;
  if (piece.kind === 'segment') return [minus(piece.from, s), minus(piece.to, e)];
  const third = rational(1n, 3n);
  const twoThirds = rational(2n, 3n);
  const [r0, r1, r2, r3] = piece.controls;
  return [
    minus(r0, s),
    minus(r1, combine(s, twoThirds, e, third)),
    minus(r2, combine(s, third, e, twoThirds)),
    minus(r3, e),
  ];
}

function controlDifferences(piece: Piece): readonly XPoint[] {
  if (piece.kind === 'segment') return [minus(piece.to, piece.from)];
  const [r0, r1, r2, r3] = piece.controls;
  return [minus(r1, r0), minus(r2, r1), minus(r3, r2)];
}

/** SL-O1: re-derives the structure and re-checks SL-C0 to SL-C4 exactly over every pair. */
export function verifyCertificate(view: SpikeView, delta: Rational): CertificateResult {
  const holds: Record<Condition, boolean | null> = {
    'SL-C0': null,
    'SL-C1': null,
    'SL-C4': null,
    'SL-C2': null,
    'SL-C3/relation': null,
    'SL-C3/clearance': null,
  };
  const details: Partial<Record<Condition, string>> = {};
  const failAt = (condition: Condition, detail: string): void => {
    if (holds[condition] !== false) details[condition] = detail;
    holds[condition] = false;
  };
  const structure = deriveStructure(view);
  if (!structure.ok) {
    failAt('SL-C0', structure.detail);
    return { holds, details, closures: structure.closures, maxDeviationSquared: null, pairs: 0 };
  }
  holds['SL-C0'] = true;
  const delta2 = mul(delta, delta);
  const radius = add(delta, delta);
  const radius2 = mul(radius, radius);
  const edges = structure.contours.flat();

  // SL-C1: max_m |d_m|² < δ² on every edge of P′.
  holds['SL-C1'] = true;
  let maxDeviation = ZERO;
  for (const edge of edges) {
    for (const [index, d] of deviationControls(edge).entries()) {
      const squared = norm2(d);
      if (compare(squared, maxDeviation) > 0) maxDeviation = squared;
      if (compare(squared, delta2) >= 0) failAt('SL-C1', `${edge.label}: |d_${index}|² ≥ δ²`);
    }
  }

  // SL-C4: SL-M1 to SL-M4 for each degenerate-source close edge.
  holds['SL-C4'] = true;
  for (const { contour, p, k, m, r, q } of structure.micros) {
    const label = `contour ${contour} micro-closure`;
    if (structure.contours[contour]!.length < 3) failAt('SL-C4', `${label}: SL-M1`);
    if (compare(norm2(minus(k, m)), delta2) >= 0) failAt('SL-C4', `${label}: SL-M2`);
    const sigma = orient(p, k, m);
    if (sigma === 0) {
      if (sign(dot(minus(k, p), minus(m, k))) <= 0) failAt('SL-C4', `${label}: SL-M3`);
      if (orient(p, m, q) === 0 && sign(dot(minus(q, m), minus(p, m))) > 0)
        failAt('SL-C4', `${label}: SL-M4 at m`);
      if (orient(p, m, r) === 0 && sign(dot(minus(r, p), minus(m, p))) > 0)
        failAt('SL-C4', `${label}: SL-M4 at p`);
    } else {
      if (sigma * orient(k, m, q) >= 0 && sigma * orient(m, p, q) >= 0)
        failAt('SL-C4', `${label}: SL-M4 at m`);
      if (sigma * orient(m, p, r) >= 0 && sigma * orient(p, k, r) >= 0)
        failAt('SL-C4', `${label}: SL-M4 at p`);
    }
  }

  // SL-C2: every consecutive pair of P′, cyclically.
  holds['SL-C2'] = true;
  for (const contour of structure.contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const e = contour[index]!;
      const f = contour[(index + 1) % contour.length]!;
      const w = minus(f.end, e.start);
      const dots = [
        dot(minus(e.end, e.start), w),
        dot(minus(f.end, f.start), w),
        ...controlDifferences(e.piece).map((difference) => dot(difference, w)),
        ...controlDifferences(f.piece).map((difference) => dot(difference, w)),
      ];
      if (dots.some((value) => sign(value) <= 0)) failAt('SL-C2', `${e.label} with ${f.label}`);
    }
  }

  // SL-C3: every non-consecutive pair, in one contour or two, without the sweep.
  holds['SL-C3/relation'] = true;
  holds['SL-C3/clearance'] = true;
  let pairs = 0;
  const position = structure.contours.flatMap((contour, c) =>
    contour.map((_, i) => [c, i, contour.length] as const),
  );
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const [ci, ii, n] = position[i]!;
      const [cj, jj] = position[j]!;
      if (ci === cj && (jj - ii === 1 || (ii === 0 && jj === n - 1))) continue;
      pairs += 1;
      const e = edges[i]!;
      const f = edges[j]!;
      if (segmentsMeet(e.start, e.end, f.start, f.end)) {
        failAt('SL-C3/relation', `${e.label} meets ${f.label}`);
        continue;
      }
      if (compare(segmentDistance2(e.start, e.end, f.start, f.end), radius2) <= 0)
        failAt('SL-C3/clearance', `${e.label} within 2δ of ${f.label}`);
    }
  }
  return { holds, details, closures: structure.closures, maxDeviationSquared: maxDeviation, pairs };
}

const REASON_CONDITION: Readonly<Partial<Record<Reason, Condition>>> = {
  STRUCTURE: 'SL-C0',
  DEVIATION: 'SL-C1',
  CLOSURE: 'SL-C4',
  MONOTONE: 'SL-C2',
  CROSSING: 'SL-C3/relation',
  CLEARANCE: 'SL-C3/clearance',
};
const STAGE_CONDITIONS: Readonly<Record<Stage, readonly Condition[]>> = {
  S1: [],
  Fr1: ['SL-C0'],
  Fr2: ['SL-C0', 'SL-C1'],
  Fr3: ['SL-C0', 'SL-C1', 'SL-C4'],
  Fr4: ['SL-C0', 'SL-C1', 'SL-C4', 'SL-C2'],
  Fr5: CONDITIONS,
  Fr6: CONDITIONS,
  Fr7: CONDITIONS,
  Fr8: CONDITIONS,
};

export type RungJudgement = Readonly<{
  /** Conditions the Rust rung passed (proved) that do not hold exactly: a soundness defect. */
  unsound: readonly Condition[];
  /**
   * For a fallback: conservative in the sense of section 4.1, every exact condition holds.
   * Null for a fast or stage-stopped entry.
   */
  conservative: boolean | null;
  /**
   * For a fallback: 'exact' when its reason's condition fails exactly, 'reason-not-exact' when it
   * holds, 'no-condition' for `PREFIX` and `TRIANGLE`, whose reasons name no condition.
   */
  reason: 'exact' | 'reason-not-exact' | 'no-condition' | null;
}>;

/**
 * Compares the Rust rung's outcome with the exact certificate (section 4.1): every condition of
 * a stage the rung passed must hold exactly, all of them for a fast entry; a fallback is
 * classified separately by whether every exact condition holds (conservative) and by whether
 * its reason's own condition fails exactly.
 */
export function judgeRung(entry: SpikeEntry, certificate: CertificateResult): RungJudgement {
  if (entry.rung !== 'fallback') {
    const passed = entry.rung === 'fast' ? CONDITIONS : STAGE_CONDITIONS[entry.stop];
    return {
      unsound: passed.filter((condition) => certificate.holds[condition] !== true),
      conservative: null,
      reason: null,
    };
  }
  const reason = entry.reason!;
  const condition = REASON_CONDITION[reason];
  let passed: readonly Condition[];
  if (reason === 'TRIANGLE') passed = CONDITIONS;
  else if (condition === undefined) passed = [];
  else if (condition.startsWith('SL-C3'))
    passed = CONDITIONS.slice(0, CONDITIONS.indexOf('SL-C3/relation'));
  else passed = CONDITIONS.slice(0, CONDITIONS.indexOf(condition));
  return {
    unsound: passed.filter((held) => certificate.holds[held] !== true),
    conservative: CONDITIONS.every((held) => certificate.holds[held] === true),
    reason:
      condition === undefined
        ? 'no-condition'
        : certificate.holds[condition] === false
          ? 'exact'
          : 'reason-not-exact',
  };
}

// ------------------------------------------------------------------------------------------
// SL-O2: exact region and mesh validity (section 4.2).

/** The SL-O2 checks a failure belongs to (section 4.2 items 1-4, plus P's simplicity premise). */
export type RegionItem = 'simplicity' | 'item1' | 'item2' | 'item3' | 'item4' | 'inspect' | 'shape';

function failedItems(issues: readonly string[]): readonly RegionItem[] {
  const items = new Set<RegionItem>();
  for (const issue of issues) {
    if (issue.startsWith('P ')) items.add('simplicity');
    else if (issue.startsWith('item 1:')) items.add('item1');
    else if (issue.startsWith('item 2:')) items.add('item2');
    else if (issue.startsWith('item 3:')) items.add('item3');
    else if (issue.startsWith('item 4:')) items.add('item4');
    else if (issue.startsWith('inspectTriangleMesh:')) items.add('inspect');
    else items.add('shape');
  }
  return [...items];
}

export type RegionResult = Readonly<{
  ok: boolean;
  issues: readonly string[];
  /** The SL-O2 checks that failed. */
  failed: readonly RegionItem[];
  /** The boundary contours derived exactly from P (orientation, winding, the rule). */
  boundary: readonly number[];
  /** Exact signed area of the oriented boundary, A(R(P)). */
  regionArea: Rational;
  /** Exact signed area of the triangles. */
  meshArea: Rational;
  /** SL-O2 item 3 alone, reported for the exact rung's mesh (section 4.3). */
  chainMatches: boolean;
}>;

function filled(winding: number, rule: FillRule): boolean {
  return rule === 'nonzero' ? winding !== 0 : Math.abs(winding) % 2 === 1;
}

/** Exact winding number of a closed polygon around v, for v not on the polygon. */
function windingNumber(ring: readonly XPoint[], v: XPoint): number {
  let winding = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const p = ring[index]!;
    const q = ring[(index + 1) % ring.length]!;
    if (compare(p.y, v.y) <= 0) {
      if (compare(q.y, v.y) > 0 && orient(p, q, v) > 0) winding += 1;
    } else if (compare(q.y, v.y) <= 0 && orient(p, q, v) < 0) winding -= 1;
  }
  return winding;
}

function shoelace(ring: readonly XPoint[]): Rational {
  let twice = ZERO;
  for (let index = 0; index < ring.length; index += 1)
    twice = add(twice, cross(ring[index]!, ring[(index + 1) % ring.length]!));
  return twice;
}

/** Exact boundary of R(P): contours, orientations, nesting, rule (section 2.3, Fill rule). */
export function deriveRegion(
  view: Pick<SpikeView, 'ranges' | 'points'>,
  rule: FillRule,
): Readonly<{
  issues: readonly string[];
  rings: readonly (readonly XPoint[])[];
  boundary: readonly number[];
  /** Directed boundary edges, filled side on the left, keyed by vertex bits. */
  directed: readonly (readonly [XPoint, XPoint])[];
  twiceArea: Rational;
}> {
  const issues: string[] = [];
  const points = view.points.map(exactPoint);
  const rings = view.ranges.map(([start, count]) => points.slice(start, start + count));
  // Exact simplicity and disjointness of P (the premise of SL-O2's region argument).
  const edges = rings.flatMap((ring, contour) =>
    ring.map((start, index) => ({
      contour,
      index,
      n: ring.length,
      start,
      end: ring[(index + 1) % ring.length]!,
    })),
  );
  for (const [contour, ring] of rings.entries())
    if (ring.length < 3) issues.push(`P contour ${contour} has ${ring.length} vertices`);
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const e = edges[i]!;
      const f = edges[j]!;
      const same = e.contour === f.contour;
      if (same && f.index === e.index + 1) {
        // e = [a, b], f = [b, c] meet only at b unless c folds back onto e.
        if (
          orient(e.start, e.end, f.end) === 0 &&
          sign(dot(minus(e.start, e.end), minus(f.end, e.end))) > 0
        )
          issues.push(`P edges ${e.contour}:${e.index} and ${f.index} overlap`);
      } else if (same && e.index === 0 && f.index === e.n - 1) {
        if (
          orient(f.start, f.end, e.end) === 0 &&
          sign(dot(minus(f.start, f.end), minus(e.end, f.end))) > 0
        )
          issues.push(`P edges ${e.contour}:${f.index} and ${e.index} overlap`);
      } else if (segmentsMeet(e.start, e.end, f.start, f.end)) {
        issues.push(`P edges ${e.contour}:${e.index} and ${f.contour}:${f.index} meet`);
      }
    }
  }
  const orientation = rings.map((ring) => sign(shoelace(ring)));
  if (orientation.some((value) => value === 0)) issues.push('P has a zero-area contour');
  const boundary: number[] = [];
  const directed: (readonly [XPoint, XPoint])[] = [];
  let twice = ZERO;
  for (const [a, ring] of rings.entries()) {
    let outside = 0;
    for (const [b, other] of rings.entries())
      if (b !== a) outside += windingNumber(other, ring[0]!);
    const inside = outside + orientation[a]!;
    if (filled(outside, rule) === filled(inside, rule)) continue;
    boundary.push(a);
    // Traverse counterclockwise when the inside is filled, clockwise otherwise.
    const counterclockwise = filled(inside, rule);
    const forward = orientation[a]! > 0 === counterclockwise;
    const area = shoelace(ring);
    twice = add(twice, forward ? area : sub(ZERO, area));
    for (let index = 0; index < ring.length; index += 1) {
      const from = ring[index]!;
      const to = ring[(index + 1) % ring.length]!;
      directed.push(forward ? [from, to] : [to, from]);
    }
  }
  return { issues, rings, boundary, directed, twiceArea: twice };
}

function meshArea(vertices: readonly XPoint[], mesh: SpikeMesh): Rational {
  let twice = ZERO;
  for (const [a, b, c] of mesh.triangles)
    twice = add(twice, twiceArea(vertices[a]!, vertices[b]!, vertices[c]!));
  return div(twice, rational(2n));
}

function boundsOf(
  points: readonly (readonly [number, number])[],
): readonly [number, number, number, number] {
  return [
    Math.min(...points.map(([x]) => x)),
    Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)),
    Math.max(...points.map(([, y]) => y)),
  ];
}

/** SL-O2 items 1-4 and `inspectTriangleMesh` for one mesh against R(P). */
export function verifyRegionMesh(
  view: Pick<SpikeView, 'ranges' | 'points'>,
  rule: FillRule,
  mesh: SpikeMesh,
): RegionResult {
  const region = deriveRegion(view, rule);
  const issues = [...region.issues];
  const vertices = mesh.vertices.map(exactPoint);
  for (const triangle of mesh.triangles)
    for (const index of triangle)
      if (index >= vertices.length) {
        return {
          ok: false,
          issues: [...issues, 'shape: triangle index out of range'],
          failed: failedItems([...issues, 'shape: triangle index out of range']),
          boundary: region.boundary,
          regionArea: div(region.twiceArea, rational(2n)),
          meshArea: ZERO,
          chainMatches: false,
        };
      }
  // Item 1: every triangle strictly positive.
  for (const [index, [a, b, c]] of mesh.triangles.entries())
    if (orient(vertices[a]!, vertices[b]!, vertices[c]!) <= 0)
      issues.push(`item 1: triangle ${index} is not positive`);
  // Item 2: mesh vertices are boundary-contour vertices, and every one of those is used.
  const boundaryKeys = new Set(
    region.boundary.flatMap((contour) => region.rings[contour]!.map(({ key }) => key)),
  );
  for (const [index, vertex] of vertices.entries())
    if (!boundaryKeys.has(vertex.key))
      issues.push(`item 2: vertex ${index} is not a boundary vertex`);
  const used = new Set(
    mesh.triangles.flatMap((triangle) => triangle.map((index) => vertices[index]!.key)),
  );
  for (const key of boundaryKeys)
    if (!used.has(key)) issues.push(`item 2: boundary vertex ${key} unused`);
  // Item 3: no directed edge twice; the cancelled chain equals the oriented boundary exactly.
  const directed = new Map<string, number>();
  let duplicate = false;
  for (const triangle of mesh.triangles) {
    for (let side = 0; side < 3; side += 1) {
      const edge = `${vertices[triangle[side]!]!.key}>${vertices[triangle[(side + 1) % 3]!]!.key}`;
      if (directed.has(edge)) duplicate = true;
      directed.set(edge, (directed.get(edge) ?? 0) + 1);
    }
  }
  if (duplicate) issues.push('item 3: a directed edge occurs twice');
  const remaining = [...directed.keys()].filter((edge) => {
    const [from, to] = edge.split('>');
    return !directed.has(`${to}>${from}`);
  });
  const expected = region.directed.map(([from, to]) => `${from.key}>${to.key}`);
  const chainMatches =
    !duplicate &&
    remaining.length === expected.length &&
    new Set(expected).size === expected.length &&
    expected.every((edge) => remaining.includes(edge));
  if (!chainMatches)
    issues.push('item 3: the cancelled chain is not the oriented boundary of R(P)');
  // Item 4: exact total area.
  const area = meshArea(vertices, mesh);
  const regionArea = div(region.twiceArea, rational(2n));
  if (compare(area, regionArea) !== 0) issues.push('item 4: area differs from A(R(P))');
  // P3.1b's inspector (cap 256 vertices and triangles).
  const numeric = mesh.vertices.map(
    ([x, y]) => [fromBits(BigInt(`0x${x}`)), fromBits(BigInt(`0x${y}`))] as const,
  );
  if (numeric.length > 0) {
    // `inspectTriangleMesh` throws above its 256-vertex or 256-triangle cap; that is reported.
    try {
      const inspection = inspectTriangleMesh({
        vertices: numeric,
        indices: mesh.triangles.flat(),
        bounds: boundsOf(numeric),
      });
      if (!inspection.valid) issues.push(`inspectTriangleMesh: ${inspection.issue}`);
    } catch (error) {
      issues.push(`inspectTriangleMesh: threw ${(error as Error).message}`);
    }
  } else issues.push('shape: empty mesh');
  return {
    ok: issues.length === 0,
    issues,
    failed: failedItems(issues),
    boundary: region.boundary,
    regionArea,
    meshArea: area,
    chainMatches,
  };
}

// ------------------------------------------------------------------------------------------
// SL-O3: agreement with the exact rung (section 4.3).

export type AgreementResult = Readonly<{
  samePolygon: boolean;
  difference: Rational;
  band: Rational;
  withinBand: boolean;
  exactMesh: RegionResult;
}>;

function absolute(value: Rational): Rational {
  return sign(value) < 0 ? sub(ZERO, value) : value;
}

export function viewIdentity(view: SpikeView): string {
  return JSON.stringify([view.ranges, view.points, view.owners, view.sources]);
}

/** Same input polygon, and |A(exact mesh) − A(R(P))| ≤ Σ_e (2τ (|Δx| + |Δy|) + 4τ²). */
export function verifyAgreement(
  fast: SpikeView,
  rule: FillRule,
  exact: SpikeView & Readonly<{ mesh: SpikeMesh }>,
  tau: Rational,
): AgreementResult {
  const region = deriveRegion(fast, rule);
  const exactArea = meshArea(exact.mesh.vertices.map(exactPoint), exact.mesh);
  const difference = absolute(sub(exactArea, div(region.twiceArea, rational(2n))));
  let band = ZERO;
  const twoTau = add(tau, tau);
  const fourTau2 = mul(rational(4n), mul(tau, tau));
  for (const [from, to] of region.directed) {
    const length = add(absolute(sub(to.x, from.x)), absolute(sub(to.y, from.y)));
    band = add(band, add(mul(twoTau, length), fourTau2));
  }
  return {
    samePolygon: viewIdentity(fast) === viewIdentity(exact),
    difference,
    band,
    withinBand: compare(difference, band) <= 0,
    exactMesh: verifyRegionMesh(fast, rule, exact.mesh),
  };
}

// ------------------------------------------------------------------------------------------
// SL-O5: sliver statistics (section 4.5), observational Float64.

export type SliverStatistics = Readonly<{
  triangles: number;
  quality: Readonly<{ min: number; p5: number; median: number }>;
  angle: Readonly<{ min: number; p5: number; median: number }>;
  below01: number;
  below001: number;
  minAltitude: number;
  /** Raw per-triangle values in triangle order, for per-cell and per-rung aggregation (SL-U3). */
  perTriangle: readonly Readonly<{ quality: number; angle: number; altitude: number }>[];
}>;

export function sliverStatistics(mesh: SpikeMesh): SliverStatistics {
  const vertices = mesh.vertices.map(
    ([x, y]) => [fromBits(BigInt(`0x${x}`)), fromBits(BigInt(`0x${y}`))] as const,
  );
  const perTriangle: { quality: number; angle: number; altitude: number }[] = [];
  for (const [a, b, c] of mesh.triangles) {
    const corners = [vertices[a]!, vertices[b]!, vertices[c]!];
    const [p, q, r] = corners;
    const crossValue = (q![0] - p![0]) * (r![1] - p![1]) - (q![1] - p![1]) * (r![0] - p![0]);
    const area = Math.abs(crossValue) / 2;
    const sides = [
      Math.hypot(q![0] - p![0], q![1] - p![1]),
      Math.hypot(r![0] - q![0], r![1] - q![1]),
      Math.hypot(p![0] - r![0], p![1] - r![1]),
    ];
    const squares = sides.reduce((sum, side) => sum + side * side, 0);
    // Each corner angle as atan2(|cross|, dot) of its two edge vectors.
    let angle = Infinity;
    for (let corner = 0; corner < 3; corner += 1) {
      const o = corners[corner]!;
      const u = corners[(corner + 1) % 3]!;
      const v = corners[(corner + 2) % 3]!;
      const ux = u[0] - o[0];
      const uy = u[1] - o[1];
      const vx = v[0] - o[0];
      const vy = v[1] - o[1];
      const value = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
      angle = Math.min(angle, (value * 180) / Math.PI);
    }
    perTriangle.push({
      quality: (4 * Math.sqrt(3) * area) / squares,
      angle,
      altitude: (2 * area) / Math.max(...sides),
    });
  }
  const qualities = perTriangle.map(({ quality }) => quality);
  const angles = perTriangle.map(({ angle }) => angle);
  const summary = (values: readonly number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return { min: sorted[0]!, p5: nearestRank(sorted, 0.05), median: nearestRank(sorted, 0.5) };
  };
  return {
    triangles: mesh.triangles.length,
    quality: summary(qualities),
    angle: summary(angles),
    below01: qualities.filter((value) => value < 0.1).length,
    below001: qualities.filter((value) => value < 0.01).length,
    minAltitude: Math.min(...perTriangle.map(({ altitude }) => altitude)),
    perTriangle,
  };
}
