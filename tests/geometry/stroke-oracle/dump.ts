/**
 * P3 B2 unit ST-U3 (`docs/plans/p3-b2-stroke-contract.md` section 11.1): the `P3STKIN1` input
 * writer and the strict reader of the `emit_stroke_dump` hand-off (`P3STKDUMP1`). Every binary64
 * value travels as its 16-digit hexadecimal bit pattern, so nothing is rounded on the way.
 */
import type { FillMesh } from '@vector-studio/contracts';

export const INPUT_MAGIC = 'P3STKIN1';
export const DUMP_MAGIC = 'P3STKDUMP1';

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

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
}>;

export type DumpPoint = readonly [x: number, y: number];
export type DumpTriple = readonly [minus: DumpPoint, center: DumpPoint, plus: DumpPoint];

export type DumpSegment = Readonly<{
  subpath: number;
  a: DumpPoint;
  b: DumpPoint;
  start: DumpTriple;
  end: DumpTriple;
  join: Readonly<{ class: string; next: number; seam: boolean }> | null;
}>;

export type DumpPiece = Readonly<{
  kind: string;
  segment: number;
  t: readonly [number, number];
  disk: number;
  points: readonly DumpPoint[];
}>;

export type DumpEntry = Readonly<{
  name: string;
  status: string;
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
    lines.push(
      [
        entry.name,
        String(entry.exponent),
        bitsOf(entry.width),
        entry.cap,
        entry.join,
        bitsOf(entry.miterLimit),
        entry.verbs.join(''),
        entry.points.map(bitsOf).join(','),
      ].join('\t'),
    );
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
type RawPiece = Omit<DumpPiece, 't' | 'points'> & { t: [string, string]; points: unknown[] };
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
      subpaths: raw.subpaths,
      segments: raw.segments.map((segment) => ({
        subpath: segment.subpath,
        a: point(segment.a),
        b: point(segment.b),
        start: triple(segment.start),
        end: triple(segment.end),
        join: segment.join,
      })),
      pieces: raw.pieces.map((piece) => ({
        kind: piece.kind,
        segment: piece.segment,
        t: [fromBits(piece.t[0]), fromBits(piece.t[1])] as const,
        disk: piece.disk,
        points: piece.points.map(point),
      })),
      mesh: raw.mesh === null ? null : mesh(raw.mesh),
    };
  });
}
