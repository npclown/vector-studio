/**
 * P3 B2 units ST-U3 and ST-U4 (`docs/plans/p3-b2-stroke-contract.md` section 11.1): the
 * `P3STKIN1` input writer and the strict reader of the `emit_stroke_dump` hand-off
 * (`P3STKDUMP1`). Every binary64 value travels as its 16-digit hexadecimal bit pattern, so nothing
 * is rounded on the way.
 */
import type { FillMesh } from '@vector-studio/contracts';
import type {
  StrokeDumpPiece,
  StrokeSampleTriple,
} from '../../../packages/geometry-reference/src/index.js';

export const INPUT_MAGIC = 'P3STKIN1';
export const DUMP_MAGIC = 'P3STKDUMP1';

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

/**
 * ST-U4 test flags (the input's ninth field): seeded defects ST-D6 to ST-D8, and `wide`, which
 * runs the case under the kernel's test-only arrangement limits `WIDE_TEST_LIMITS`.
 */
export type StrokeFlag = 'wide' | 'knot-join' | 'omit-cusp-disk' | 'leaf-factor-two';

/** One dump case: a path and a stroke request. */
export type StrokeCase = Readonly<{
  name: string;
  verbs: readonly number[];
  points: readonly number[];
  width: number;
  cap: StrokeCap;
  join: StrokeJoin;
  miterLimit: number;
  exponent: number;
  flags?: readonly StrokeFlag[];
}>;

export type DumpPoint = readonly [x: number, y: number];
export type DumpTriple = readonly [minus: DumpPoint, center: DumpPoint, plus: DumpPoint];

export type DumpSegment = Readonly<{
  subpath: number;
  verb: number;
  /** The cubic's class (section 4.6), or null for a line. */
  cubic: string | null;
  a: DumpPoint;
  b: DumpPoint;
  start: DumpTriple;
  end: DumpTriple;
  join: Readonly<{ class: string; next: number; seam: boolean }> | null;
}>;

export type DumpPiece = Readonly<{
  kind: string;
  /** Kernel segment index, or the subpath index of a point piece. */
  segment: number;
  /** Source verb ordinal of the segment (the CLOSE ordinal for a closing line). */
  verb: number;
  /** A join's outgoing verb ordinal, else null. */
  nextVerb: number | null;
  /** A zero-area hull, dropped from the arrangement. */
  dropped: boolean;
  /**
   * Joins: outer in, outer out and the miter tip. Square caps: the two extension points.
   * Round caps: the cap's own `E-` and `E+`.
   */
  extra: readonly DumpPoint[];
  t: readonly [number, number];
  disk: number;
  /** Collinear cubic sweep part. */
  part: number;
  /** Leaf range, depth and index. */
  range: readonly [number, number];
  depth: number;
  index: number;
  /** Sweep and leaf start and end triples; a cusp disk's center is `samples[0][1]`. */
  samples: readonly [DumpTriple, DumpTriple];
  points: readonly DumpPoint[];
}>;

export type DumpEntry = Readonly<{
  name: string;
  status: string;
  /** The failing stage of a non-ok case: the front end or the arrangement. */
  failure: Readonly<{ stage: 'front-end' | 'arrangement'; error: string }> | null;
  subpaths: readonly Readonly<{ firstSegment: number; segmentCount: number; closed: boolean }>[];
  segments: readonly DumpSegment[];
  pieces: readonly DumpPiece[];
  mesh: FillMesh | null;
}>;

const view = new DataView(new ArrayBuffer(8));

export function bitsOf(value: number): string {
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, '0');
}

export function fromBits(text: string): number {
  if (!/^[0-9a-f]{16}$/.test(text)) throw new Error(`bad bits ${text}`);
  view.setBigUint64(0, BigInt(`0x${text}`), false);
  return view.getFloat64(0, false);
}

export function encodeInput(cases: readonly StrokeCase[]): string {
  const lines = [INPUT_MAGIC];
  for (const entry of cases) {
    if (entry.name.includes('\t') || entry.name.includes('"')) throw new Error(entry.name);
    const fields = [
      entry.name,
      String(entry.exponent),
      bitsOf(entry.width),
      entry.cap,
      entry.join,
      bitsOf(entry.miterLimit),
      entry.verbs.join(''),
      entry.points.map(bitsOf).join(','),
    ];
    if (entry.flags && entry.flags.length > 0) fields.push(entry.flags.join(','));
    lines.push(fields.join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

const point = (value: unknown): DumpPoint => {
  const pair = value as [string, string];
  return [fromBits(pair[0]), fromBits(pair[1])];
};

const triple = (value: unknown): DumpTriple => {
  const items = value as unknown[];
  return [point(items[0]), point(items[1]), point(items[2])];
};

type RawSegment = Omit<DumpSegment, 'a' | 'b' | 'start' | 'end'> & {
  a: unknown;
  b: unknown;
  start: unknown;
  end: unknown;
};
type RawPiece = Omit<DumpPiece, 't' | 'points' | 'extra' | 'range' | 'samples'> & {
  t: [string, string];
  range: [string, string];
  samples: [unknown, unknown];
  points: unknown[];
  extra: unknown[];
};
type RawMesh = { positions: string[]; indices: number[]; boundaryEdges: number[] };
type RawEntry = Omit<DumpEntry, 'segments' | 'pieces' | 'mesh'> & {
  segments: RawSegment[];
  pieces: RawPiece[];
  mesh: RawMesh | null;
};

function mesh(raw: RawMesh): FillMesh {
  const positions = Float64Array.from(raw.positions.map(fromBits));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let scalar = 0; scalar < positions.length; scalar += 2) {
    minX = Math.min(minX, positions[scalar]!);
    minY = Math.min(minY, positions[scalar + 1]!);
    maxX = Math.max(maxX, positions[scalar]!);
    maxY = Math.max(maxY, positions[scalar + 1]!);
  }
  return {
    positions,
    indices: Uint32Array.from(raw.indices),
    boundaryEdges: Uint32Array.from(raw.boundaryEdges),
    bounds: { minX, minY, maxX, maxY },
  };
}

/** Parses the framed dump, checking the magic, the count and every frame length. */
export function parseDump(text: string): DumpEntry[] {
  const lines = text.split('\n').filter((line) => line.length > 0);
  const header = lines.shift() ?? '';
  const [magic, count] = header.split(' ');
  if (magic !== DUMP_MAGIC) throw new Error(`dump magic ${String(magic)}`);
  if (Number(count) !== lines.length) throw new Error('dump case count differs');
  return lines.map((line) => {
    const space = line.indexOf(' ');
    const body = line.slice(space + 1);
    if (Number(line.slice(0, space)) !== body.length) throw new Error('dump frame length differs');
    const raw = JSON.parse(body) as RawEntry;
    return {
      name: raw.name,
      status: raw.status,
      failure: raw.failure,
      subpaths: raw.subpaths,
      segments: raw.segments.map((segment) => ({
        subpath: segment.subpath,
        verb: segment.verb,
        cubic: segment.cubic,
        a: point(segment.a),
        b: point(segment.b),
        start: triple(segment.start),
        end: triple(segment.end),
        join: segment.join,
      })),
      pieces: raw.pieces.map((piece) => ({
        kind: piece.kind,
        segment: piece.segment,
        verb: piece.verb,
        nextVerb: piece.nextVerb,
        dropped: piece.dropped,
        extra: piece.extra.map(point),
        t: [fromBits(piece.t[0]), fromBits(piece.t[1])] as const,
        disk: piece.disk,
        part: piece.part,
        range: [fromBits(piece.range[0]), fromBits(piece.range[1])] as const,
        depth: piece.depth,
        index: piece.index,
        samples: [triple(piece.samples[0]), triple(piece.samples[1])] as const,
        points: piece.points.map(point),
      })),
      mesh: raw.mesh === null ? null : mesh(raw.mesh),
    };
  });
}

/** The point of the k-th MOVE of a case (the start of subpath k). */
function movePoint(source: StrokeCase, subpath: number): DumpPoint {
  let scalar = 0;
  let moves = 0;
  for (const verb of source.verbs) {
    if (verb === 0) {
      if (moves === subpath) return [source.points[scalar]!, source.points[scalar + 1]!];
      moves += 1;
    }
    scalar += verb === 2 ? 6 : verb === 3 ? 0 : 2;
  }
  throw new Error(`no subpath ${String(subpath)}`);
}

const sample = (value: DumpTriple): StrokeSampleTriple => ({
  minus: value[0],
  center: value[1],
  plus: value[2],
});

/** The oracle's `StrokeDumpPiece` view of one dumped entry (ST-U2's hand-off shape). */
export function oraclePieces(entry: DumpEntry, source: StrokeCase): StrokeDumpPiece[] {
  return entry.pieces.map((piece): StrokeDumpPiece => {
    const polygon = piece.dropped ? null : piece.points;
    switch (piece.kind) {
      case 'line-sweep':
        return {
          kind: 'line-sweep',
          verb: piece.verb,
          part: piece.part,
          start: sample(piece.samples[0]),
          end: sample(piece.samples[1]),
          polygon,
        };
      case 'cubic-leaf':
        return {
          kind: 'cubic-leaf',
          verb: piece.verb,
          rangeStart: piece.range[0],
          rangeEnd: piece.range[1],
          depth: piece.depth,
          index: piece.index,
          start: sample(piece.samples[0]),
          end: sample(piece.samples[1]),
          polygon,
        };
      case 'cusp-disk':
        return {
          kind: 'cusp-disk',
          verb: piece.verb,
          parameter: piece.t[0],
          center: piece.samples[0][1],
          diskVertices: piece.disk,
          polygon,
        };
      case 'bevel':
      case 'miter':
      case 'round-join':
        return {
          kind: 'join',
          incomingVerb: piece.verb,
          outgoingVerb: piece.nextVerb ?? -1,
          join: piece.kind === 'round-join' ? 'round' : piece.kind,
          outerIn: piece.extra[0]!,
          outerOut: piece.extra[1]!,
          tip: piece.extra[2] ?? null,
          ...(piece.kind === 'round-join' ? { diskVertices: piece.disk } : {}),
          polygon,
        };
      case 'round-cap':
      case 'square-cap': {
        const segment = entry.segments[piece.segment]!;
        const end = piece.t[0] === 1;
        return {
          kind: 'cap',
          end: end ? 'end' : 'start',
          verb: piece.verb,
          cap: piece.kind === 'round-cap' ? 'round' : 'square',
          // A round cap records its own `E-` and `E+` (the center is the segment's); a square
          // cap's hull uses the segment triple, so it is taken from there.
          triple:
            piece.kind === 'round-cap'
              ? {
                  minus: piece.extra[0]!,
                  center: sample(end ? segment.end : segment.start).center,
                  plus: piece.extra[1]!,
                }
              : sample(end ? segment.end : segment.start),
          extension: piece.kind === 'square-cap' ? [piece.extra[0]!, piece.extra[1]!] : null,
          ...(piece.kind === 'round-cap' ? { diskVertices: piece.disk } : {}),
          polygon,
        };
      }
      case 'point-round':
      case 'point-square':
        return {
          kind: 'point-cap',
          subpath: piece.segment,
          cap: piece.kind === 'point-round' ? 'round' : 'square',
          point: movePoint(source, piece.segment),
          ...(piece.kind === 'point-round' ? { diskVertices: piece.disk } : {}),
          polygon,
        };
      default:
        throw new Error(`unknown piece kind ${piece.kind}`);
    }
  });
}
