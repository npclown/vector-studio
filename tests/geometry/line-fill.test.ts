import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  inspectLineFillMesh,
  type LineFillRule,
  type Point,
  type TriangleMeshInput,
} from '../../packages/geometry-reference/src/index.js';

type SourceCase = Readonly<{
  id: string;
  contours: readonly (readonly Point[])[];
  areas: Readonly<Record<LineFillRule, number>>;
}>;

type NativeRow = Readonly<{
  id: string;
  rule: LineFillRule;
  contours: readonly (readonly Point[])[];
  vertices: readonly Point[];
  indices: readonly number[];
  bounds: readonly [number, number, number, number];
}>;

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const rules = ['nonzero', 'evenodd'] as const;

const rectangle = (left: number, bottom: number, right: number, top: number): Point[] => [
  [left, bottom],
  [right, bottom],
  [right, top],
  [left, top],
];

const reverse = (contour: readonly Point[]): Point[] => [...contour].reverse();

const outer = rectangle(0, 0, 10, 10);
const inner = rectangle(3, 3, 7, 7);
const squareA = rectangle(0, 0, 4, 4);
const overlapB = rectangle(2, 0, 6, 4);
const sharedB = rectangle(2, 4, 6, 8);
const bowtie: Point[] = [
  [0, 0],
  [4, 4],
  [0, 4],
  [4, 0],
];

const sources: readonly SourceCase[] = [
  { id: 'F01', contours: [outer], areas: { nonzero: 100, evenodd: 100 } },
  { id: 'F02', contours: [outer, inner], areas: { nonzero: 100, evenodd: 84 } },
  { id: 'F03', contours: [outer, reverse(inner)], areas: { nonzero: 84, evenodd: 84 } },
  { id: 'F04', contours: [outer, outer], areas: { nonzero: 100, evenodd: 0 } },
  { id: 'F05', contours: [outer, reverse(outer)], areas: { nonzero: 0, evenodd: 0 } },
  { id: 'F06', contours: [bowtie], areas: { nonzero: 8, evenodd: 8 } },
  {
    id: 'F07',
    contours: [rectangle(0, 0, 2, 2), rectangle(2, 0, 4, 2)],
    areas: { nonzero: 8, evenodd: 8 },
  },
  {
    id: 'F08',
    contours: [
      [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
    ],
    areas: { nonzero: 32, evenodd: 32 },
  },
  {
    id: 'F09-repeat',
    contours: [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [10, 10],
        [0, 10],
      ],
    ],
    areas: { nonzero: 100, evenodd: 100 },
  },
  {
    id: 'F09-permuted',
    contours: [inner, outer],
    areas: { nonzero: 100, evenodd: 84 },
  },
  { id: 'F10', contours: [squareA, overlapB], areas: { nonzero: 24, evenodd: 16 } },
  {
    id: 'F10-reversed',
    contours: [squareA, reverse(overlapB)],
    areas: { nonzero: 16, evenodd: 16 },
  },
  { id: 'F11', contours: [squareA, sharedB], areas: { nonzero: 32, evenodd: 32 } },
  {
    id: 'F03-global-reversed',
    contours: [reverse(outer), inner],
    areas: { nonzero: 84, evenodd: 84 },
  },
  {
    id: 'F06-global-reversed',
    contours: [reverse(bowtie)],
    areas: { nonzero: 8, evenodd: 8 },
  },
  {
    id: 'F10-global-reversed',
    contours: [reverse(squareA), reverse(overlapB)],
    areas: { nonzero: 24, evenodd: 16 },
  },
];

function isPoint(value: unknown): value is Point {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function points(value: unknown, label: string): readonly Point[] {
  if (!Array.isArray(value) || !value.every(isPoint))
    throw new Error(`${label} must be finite points`);
  return value;
}

function parseRow(line: string, index: number): NativeRow {
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`row ${index} must be an object`);
  }
  const record = value as Record<string, unknown>;
  expect(Object.keys(record).sort(), `row ${index} keys`).toEqual([
    'bounds',
    'contours',
    'id',
    'indices',
    'rule',
    'vertices',
  ]);
  if (typeof record.id !== 'string') throw new Error(`row ${index} id must be a string`);
  if (record.rule !== 'nonzero' && record.rule !== 'evenodd') {
    throw new Error(`row ${index} rule is invalid`);
  }
  if (!Array.isArray(record.contours)) throw new Error(`row ${index} contours must be an array`);
  const contours = record.contours.map((contour, contourIndex) =>
    points(contour, `row ${index} contour ${contourIndex}`),
  );
  const vertices = points(record.vertices, `row ${index} vertices`);
  if (
    !Array.isArray(record.indices) ||
    !record.indices.every((item) => typeof item === 'number' && Number.isInteger(item))
  ) {
    throw new Error(`row ${index} indices must be integers`);
  }
  if (!Array.isArray(record.bounds) || record.bounds.length !== 4) {
    throw new Error(`row ${index} bounds must contain four values`);
  }
  const bounds = record.bounds;
  if (!bounds.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error(`row ${index} bounds must be finite`);
  }
  return {
    id: record.id,
    rule: record.rule,
    contours,
    vertices,
    indices: record.indices as number[],
    bounds: bounds as [number, number, number, number],
  };
}

function captureRows(): NativeRow[] {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const result = spawnSync(
    rustup,
    [
      'run',
      '1.94.1',
      'cargo',
      'test',
      '--manifest-path',
      manifest,
      '--locked',
      '--offline',
      '--lib',
      'line_fill_tests::emit_line_fill_meshes',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.match(/P3_LINE_FILL_BEGIN/g)).toHaveLength(1);
  expect(result.stdout.match(/P3_LINE_FILL_END/g)).toHaveLength(1);
  const frame = /P3_LINE_FILL_BEGIN\r?\n([\s\S]*?)\r?\nP3_LINE_FILL_END/.exec(result.stdout);
  if (!frame) throw new Error('native line-fill frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/);
  expect(lines).toHaveLength(32);
  return lines.map(parseRow);
}

function mesh(row: NativeRow, expectedArea: number): TriangleMeshInput {
  return {
    vertices: row.vertices,
    indices: row.indices,
    bounds: row.bounds,
    expectedArea,
  };
}

function sourceFor(id: string): SourceCase {
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`unknown source id ${id}`);
  return source;
}

let rows: NativeRow[] = [];

beforeAll(() => {
  rows = captureRows();
}, 120_000);

describe('P3.2d independent native line-fill mesh bridge', () => {
  it('accepts all 32 frozen source/rule meshes with exact source echoes and analytic areas (L01)', () => {
    const expectedOrder = sources.flatMap((source) => rules.map((rule) => `${source.id}:${rule}`));
    expect(rows.map((row) => `${row.id}:${row.rule}`)).toEqual(expectedOrder);
    for (const row of rows) {
      const source = sourceFor(row.id);
      expect(row.contours, `${row.id}:${row.rule} source echo`).toEqual(source.contours);
      expect(
        inspectLineFillMesh({
          contours: source.contours,
          rule: row.rule,
          mesh: mesh(row, source.areas[row.rule]),
        }),
        `${row.id}:${row.rule}`,
      ).toEqual({ valid: true, issue: null });
    }
  });

  it('rejects all seven frozen corruptions for their intended reason (L01)', () => {
    const f01 = rows.find((row) => row.id === 'F01' && row.rule === 'nonzero')!;
    const f02 = rows.find((row) => row.id === 'F02' && row.rule === 'nonzero')!;
    const f01Source = sourceFor('F01');
    const inspectF01 = (candidate: TriangleMeshInput) =>
      inspectLineFillMesh({ contours: f01Source.contours, rule: 'nonzero', mesh: candidate });

    expect(
      inspectF01({ ...mesh(f01, 100), indices: f01.indices.slice(3) }),
      'removed triangle',
    ).toEqual({ valid: false, issue: 'AREA_MISMATCH' });
    expect(
      inspectF01({ ...mesh(f01, 100), indices: [...f01.indices, ...f01.indices.slice(0, 3)] }),
      'duplicated triangle',
    ).toEqual({ valid: false, issue: 'OVERLAPPING_TRIANGLES' });
    const reversed = [...f01.indices];
    [reversed[1], reversed[2]] = [reversed[2]!, reversed[1]!];
    expect(inspectF01({ ...mesh(f01, 100), indices: reversed }), 'reversed winding').toEqual({
      valid: false,
      issue: 'REVERSED_TRIANGLE',
    });
    expect(
      () => inspectF01({ ...mesh(f01, 100), indices: [f01.vertices.length, 1, 2] }),
      'out-of-range index',
    ).toThrow('index must be an in-range integer');
    expect(
      inspectF01({ ...mesh(f01, 100), bounds: [0, 0, 9, 10] }),
      'underreported bounds',
    ).toEqual({ valid: false, issue: 'BOUNDS_MISMATCH' });

    const f02Source = sourceFor('F02');
    expect(
      inspectLineFillMesh({
        contours: f02Source.contours,
        rule: 'evenodd',
        mesh: mesh(f02, 100),
      }),
      'wrong F02 fill rule',
    ).toEqual({ valid: false, issue: 'REGION_MISMATCH' });

    const translatedVertices = f01.vertices.map(([x, y]) => [x + 20, y] as Point);
    expect(
      inspectF01({
        vertices: translatedVertices,
        indices: f01.indices,
        bounds: [20, 0, 30, 10],
        expectedArea: 100,
      }),
      'translated same-area region',
    ).toEqual({ valid: false, issue: 'REGION_MISMATCH' });
  });
});
