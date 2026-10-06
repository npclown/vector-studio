import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectionInput } from './mesh-projection/model.js';
import { classifyNativeProjection } from './native-projection/classify.js';
import { decodeCapture } from './native-projection/decode.js';
import { fromBits } from './rounded-fill/exact.js';

// P3.1l L05 offline reproduction: rebuild classification.json from capture.json alone.
// Set P3_NATIVE_PROJECTION_REPLAY to a corpus case directory; otherwise this test is skipped.
const replayDirectory = process.env.P3_NATIVE_PROJECTION_REPLAY;

type ArchivedInput = Readonly<{
  id: string;
  mesh: Readonly<{ vertices: readonly (readonly [string, string])[]; indices: readonly number[] }>;
  affine: readonly string[];
  camera: readonly [string, string];
  origin: readonly [string, string];
  zoom: string;
  dpr: string;
  width: number;
  height: number;
}>;

type CaptureRow = Readonly<{
  id: string;
  rowIndex: number;
  input: ArchivedInput;
  captureTag: number;
  vertexCount: number;
  readbackBase64: string | null;
  capture: string;
}>;

const number = (hex: string): number => fromBits(BigInt(`0x${hex}`));
const pair = ([x, y]: readonly [string, string]) => [number(x), number(y)] as const;

function projectionInput(encoded: ArchivedInput): ProjectionInput {
  return {
    id: encoded.id,
    mesh: { vertices: encoded.mesh.vertices.map(pair), indices: [...encoded.mesh.indices] },
    affine: encoded.affine.map(number) as unknown as ProjectionInput['affine'],
    camera: pair(encoded.camera),
    origin: pair(encoded.origin),
    zoom: number(encoded.zoom),
    dpr: number(encoded.dpr),
    width: encoded.width,
    height: encoded.height,
  };
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

describe.runIf(replayDirectory !== undefined)('P3.1l offline classification replay', () => {
  it('reproduces classification.json byte for byte', () => {
    const directory = path.resolve(replayDirectory!);
    const captureText = readFileSync(path.join(directory, 'capture.json'), 'utf8');
    const expected = readFileSync(path.join(directory, 'classification.json'), 'utf8');
    const capture = JSON.parse(captureText) as { mode: string; rows: readonly CaptureRow[] };
    const recorded = JSON.parse(expected) as {
      classifierSources: readonly { path: string; sha256?: string }[];
    };
    // Recorded classifier sources must be the files this replay actually executes.
    for (const source of recorded.classifierSources)
      expect(createHash('sha256').update(readFileSync(source.path)).digest('hex')).toBe(
        source.sha256,
      );
    expect(capture.mode).toBe('corpus');
    const rows = capture.rows.map((row) => {
      if (row.capture !== 'CAPTURED' || row.readbackBase64 === null)
        return { id: row.id, rowIndex: row.rowIndex, capture: row.capture };
      const decoded = decodeCapture(new Uint8Array(Buffer.from(row.readbackBase64, 'base64')), {
        rowIndex: row.rowIndex,
        expectedCount: row.vertexCount,
        captureTag: row.captureTag,
      });
      if (decoded.status !== 'CAPTURED') throw new Error(`replay decode ${row.id}`);
      try {
        return {
          id: row.id,
          rowIndex: row.rowIndex,
          result: classifyNativeProjection(projectionInput(row.input), decoded.clipWords),
        };
      } catch (error) {
        return { id: row.id, rowIndex: row.rowIndex, error: message(error) };
      }
    });
    const rebuilt = {
      schema: 'p3-native-projection-classification-v1',
      captureSha256: createHash('sha256').update(captureText).digest('hex'),
      classifierSources: recorded.classifierSources,
      rows,
    };
    expect(`${JSON.stringify(rebuilt, null, 2)}\n`).toBe(expected);
  });
});
