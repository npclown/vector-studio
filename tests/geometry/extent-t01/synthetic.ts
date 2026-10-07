import type { ProjectionInput } from '../mesh-projection/model.js';
import { loadFixtureRows } from '../position-certificate/corpus.js';
import { fromBits } from '../rounded-fill/exact.js';

/**
 * P3.1p T01 synthetic class A family S and the trajectory cost rows
 * (docs/plans/p3-t01-extent-experiment-contract.md, "Corpus" and "Metrics").
 */

/** corpus.ts R15 (hash-pinned and unexported), copied as binary64 literals. */
export const R15 = [
  fromBits(0x3feee8dd4748bf15n),
  fromBits(0x3fd0907dc1930690n),
  fromBits(0xbfd0907dc1930690n),
  fromBits(0x3feee8dd4748bf15n),
] as const;
export const IDENTITY = [1, 0, 0, 1] as const;

export const S_ZOOMS = [2 ** -6, 1, 2 ** 6] as const;
export const S_DPRS = [1, 2] as const;
export const S_KS = [10, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 28, 32, 40] as const;
export const S_SHAPES = ['TRI', 'RECT'] as const;
export const S_LINEARS = ['I', 'R15'] as const;
const WIDTH = 1280;
const HEIGHT = 720;
const INPUT_MAX = 2 ** 60;

export type SyntheticShape = (typeof S_SHAPES)[number];
export type SyntheticLinear = (typeof S_LINEARS)[number];
export type SyntheticRow = Readonly<{
  id: string;
  shape: SyntheticShape;
  k: number;
  zoom: number;
  dpr: number;
  linear: SyntheticLinear;
  input: ProjectionInput;
}>;

/** "n/d" with /d omitted at 1, for the power-of-two zoom and the DPR. */
function ratio(value: number): string {
  if (Number.isInteger(value)) return String(value);
  let denominator = 1;
  while (!Number.isInteger(value * denominator)) denominator *= 2;
  return `${value * denominator}/${denominator}`;
}

export function syntheticRow(
  shape: SyntheticShape,
  k: number,
  zoom: number,
  dpr: number,
  linear: SyntheticLinear,
): SyntheticRow | null {
  const scale = zoom * dpr;
  const far = 2 ** k / scale;
  const near = 64 / scale;
  const vertices: [number, number][] =
    shape === 'TRI'
      ? [
          [-near, 0],
          [far, 0],
          [-near, near],
        ]
      : [
          [-near, 0],
          [far, 0],
          [far, far / 4],
          [-near, far / 4],
        ];
  const indices = shape === 'TRI' ? [0, 1, 2] : [0, 1, 2, 0, 2, 3];
  const values = [...vertices.flat(), 640 / scale, 360 / scale, zoom, dpr];
  if (values.some((value) => Math.abs(value) > INPUT_MAX)) return null;
  const id = `S/${shape}/k${k}/z${ratio(zoom)}/d${ratio(dpr)}/${linear}`;
  const [a, b, c, d] = linear === 'I' ? IDENTITY : R15;
  return {
    id,
    shape,
    k,
    zoom,
    dpr,
    linear,
    input: {
      id,
      mesh: { vertices, indices },
      affine: [a, b, c, d, 640 / scale, 360 / scale],
      camera: [0, 0],
      origin: [0, 0],
      zoom,
      dpr,
      width: WIDTH,
      height: HEIGHT,
    },
  };
}

/** S in contract order: shape, then k, zoom, DPR, linear part. Skipped variants are listed. */
export function syntheticRows(): { rows: SyntheticRow[]; skipped: string[] } {
  const rows: SyntheticRow[] = [];
  const skipped: string[] = [];
  for (const shape of S_SHAPES)
    for (const k of S_KS)
      for (const zoom of S_ZOOMS)
        for (const dpr of S_DPRS)
          for (const linear of S_LINEARS) {
            const row = syntheticRow(shape, k, zoom, dpr, linear);
            if (row === null)
              skipped.push(`S/${shape}/k${k}/z${ratio(zoom)}/d${ratio(dpr)}/${linear}`);
            else rows.push(row);
          }
  return { rows, skipped };
}

export const CLASS_A_STRESS_IDS = [
  'rectangle/4096x4096/R45/stress',
  'rectangle/4096x4096/scale/stress',
] as const;

/** Trajectory cost rows: S TRI/RECT k 16 and 20 (I, zoom 1, DPR 1), plus the class A stress rows. */
export function trajectoryRows(): { id: string; input: ProjectionInput }[] {
  const rows: { id: string; input: ProjectionInput }[] = [];
  for (const shape of S_SHAPES)
    for (const k of [16, 20]) {
      const row = syntheticRow(shape, k, 1, 1, 'I')!;
      rows.push({ id: row.id, input: row.input });
    }
  const fixtures = loadFixtureRows();
  for (const id of CLASS_A_STRESS_IDS) {
    const fixture = fixtures.find((candidate) => candidate.id === id);
    if (fixture === undefined) throw new Error(`missing-stress-row:${id}`);
    rows.push({ id, input: fixture.input });
  }
  return rows;
}
