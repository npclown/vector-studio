import { createHash } from 'node:crypto';
import { readSync } from 'node:fs';
import { LIMITS } from './artifact.js';
import {
  MAX_EDGES,
  MAX_RAW_EMITTED,
  type CarriedPath,
  type Edge,
  type NormalizedPath,
} from './types.js';

export type InputFrame = Readonly<{
  frame: Uint8Array<ArrayBuffer>;
  payload: Uint8Array<ArrayBuffer>;
  totalBytes: number;
}>;
export type OutputFrame = InputFrame & Readonly<{ status: number }>;

function exactRead(fd: number, length: number, label: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, null);
    if (count === 0) throw new Error(`truncated ${label}`);
    offset += count;
  }
  return bytes;
}

export function readInputFrame(fd: number, priorBytes: number): InputFrame {
  const prefix = exactRead(fd, 4, 'native input frame prefix');
  const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, true);
  if (length > LIMITS.inputFrameBytes) throw new Error('native input frame exceeds 4096 bytes');
  const totalBytes = priorBytes + 4 + length;
  if (totalBytes > LIMITS.inputBytes) throw new Error('native input exceeds 4 MiB');
  const payload = exactRead(fd, length, 'native input frame');
  const frame = new Uint8Array(4 + length);
  frame.set(prefix);
  frame.set(payload, 4);
  return { frame, payload, totalBytes };
}

export function readOutputFrame(fd: number, priorBytes: number): OutputFrame {
  const prefix = exactRead(fd, 8, 'native output frame prefix');
  const view = new DataView(prefix.buffer, prefix.byteOffset, 8);
  const status = view.getUint32(0, true);
  const length = view.getUint32(4, true);
  if (length > LIMITS.outputFrameBytes) throw new Error('native output frame exceeds 256 KiB');
  const totalBytes = priorBytes + 8 + length;
  if (totalBytes > LIMITS.outputBytes) throw new Error('native output exceeds 128 MiB');
  const payload = exactRead(fd, length, 'native output frame');
  const frame = new Uint8Array(8 + length);
  frame.set(prefix);
  frame.set(payload, 8);
  return { frame, payload, totalBytes, status };
}

export function authenticateFrame(frame: Uint8Array, expectedSha256: string, label: string): void {
  const actual = createHash('sha256').update(frame).digest('hex');
  if (actual !== expectedSha256) throw new Error(`${label} SHA-256 mismatch`);
}

export function assertFrameEof(fd: number, label: string): void {
  if (readSync(fd, new Uint8Array(1)) !== 0) throw new Error(`trailing ${label} frame`);
}

function samePoint(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function pointAt(points: Float64Array, index: number): readonly [number, number] {
  return [points[index * 2]!, points[index * 2 + 1]!];
}

/** Normalize the carried MOVE/LINE stream. The current point advances across omitted zero edges. */
export function extractEdges(path: CarriedPath): NormalizedPath {
  if (path.verbs.length === 0) throw new Error('carried path must contain an initial MOVE');
  const rawEmitted = path.verbs.length - 1;
  if (rawEmitted > MAX_RAW_EMITTED) throw new Error('raw emitted line cap exceeded');
  if (path.points.length !== path.verbs.length * 2)
    throw new Error('carried point cardinality mismatch');
  if (path.provenance.length !== path.verbs.length * 3)
    throw new Error('carried provenance cardinality mismatch');
  if (path.verbs[0] !== 0) throw new Error('carried path must begin with MOVE');
  if (path.provenance[0] !== 0 || path.provenance[1] !== 1 || path.provenance[2] !== 0)
    throw new Error('initial MOVE provenance mismatch');
  for (const coordinate of path.points) {
    if (!Number.isFinite(coordinate)) throw new Error('carried path contains a nonfinite point');
  }

  const first = pointAt(path.points, 0);
  let current = first;
  const edges: Edge[] = [];
  let omittedZero = 0;
  let previousOrdinal = 0;
  for (let verbIndex = 1; verbIndex < path.verbs.length; verbIndex += 1) {
    if (path.verbs[verbIndex] !== 1) throw new Error('carried path contains a non-LINE verb');
    const provenanceIndex = verbIndex * 3;
    const sourceVerbOrdinal = path.provenance[provenanceIndex]!;
    const endNumerator = path.provenance[provenanceIndex + 1]!;
    const depth = path.provenance[provenanceIndex + 2]!;
    if (sourceVerbOrdinal < 1 || sourceVerbOrdinal > 32)
      throw new Error('LINE source ordinal outside frozen bounds');
    if (sourceVerbOrdinal < previousOrdinal)
      throw new Error('LINE source ordinals are not partitioned in source order');
    if (depth > 7 || endNumerator < 1 || endNumerator > 2 ** depth)
      throw new Error('LINE provenance outside frozen bounds');
    previousOrdinal = sourceVerbOrdinal;
    const end = pointAt(path.points, verbIndex);
    if (samePoint(current, end)) {
      omittedZero += 1;
    } else {
      edges.push({
        rawIndex: verbIndex - 1,
        kind: 'emitted',
        sourceVerbOrdinal,
        endNumerator,
        depth,
        start: current,
        end,
      });
    }
    current = end;
  }
  const retainedEmitted = edges.length;
  let closure: 0 | 1 = 0;
  if (!samePoint(current, first)) {
    closure = 1;
    edges.push({
      rawIndex: rawEmitted,
      kind: 'closure',
      sourceVerbOrdinal: null,
      endNumerator: null,
      depth: null,
      start: current,
      end: first,
    });
  }
  if (edges.length > MAX_EDGES) throw new Error('normalized edge cap exceeded');
  return {
    edges,
    rawEmitted,
    omittedZero,
    retainedEmitted,
    closure,
    normalizedEdges: edges.length,
  };
}
