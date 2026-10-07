import { describe, expect, it } from 'vitest';
import { bboxMidpoint, PHI, type CoreInput, type Q2 } from './extent-t01/core.js';
import { GAMMA_PAIR, k5Errors, packPairLanes } from './extent-t01/k5.js';
import { R15, syntheticRows, trajectoryRows } from './extent-t01/synthetic.js';
import { q } from './position-certificate/certificate.js';
import { termRows } from './position-certificate/corpus.js';
import { absolute, add, bitsOf, mul, rational, sub } from './rounded-fill/exact.js';

// P3.1p T01 S literals and the K5-ASSUMED formula (docs/plans/p3-t01-extent-experiment-contract.md).

describe('P3.1p T01 synthetic family', () => {
  it('builds the 360 S rows with exact far-vertex placement and no skips', () => {
    const { rows, skipped } = syntheticRows();
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(2 * 15 * 3 * 2 * 2);
    expect(rows[0]!.id).toBe('S/TRI/k10/z1/64/d1/I');
    for (const row of rows.filter((candidate) => candidate.linear === 'I')) {
      const [a, , , , e, f] = row.input.affine;
      const [x, y] = row.input.mesh.vertices[1]!;
      const scale = row.zoom * row.dpr;
      expect((a * x + e) * scale).toBe(640 + 2 ** row.k);
      expect(f * scale).toBe(360);
      expect(y).toBe(0);
    }
  });

  it('copies R15 bit-exactly from the PACK-R15 term row', () => {
    const pack = termRows().find((row) => row.id === 'PACK-R15')!;
    expect(R15.map((value) => bitsOf(value))).toEqual(
      pack.input.affine.slice(0, 4).map((value) => bitsOf(value)),
    );
  });

  it('lists the trajectory rows', () => {
    expect(trajectoryRows().map((row) => row.id)).toEqual([
      'S/TRI/k16/z1/d1/I',
      'S/TRI/k20/z1/d1/I',
      'S/RECT/k16/z1/d1/I',
      'S/RECT/k20/z1/d1/I',
      'rectangle/4096x4096/R45/stress',
      'rectangle/4096x4096/scale/stress',
    ]);
  });
});

describe('P3.1p T01 K5-ASSUMED', () => {
  it('composes Pack5, the pair Shader, the NDC term and Phi', () => {
    const vertices = [
      [-1, 0],
      [1, 0],
      [-1, 1],
    ] as const;
    const input: CoreInput = {
      points: vertices.map(([x, y]): Q2 => [q(x), q(y)]),
      triangles: [[0, 1, 2]],
      affine: [1, 0, 0, 1, 8, 4],
      camera: [0, 0],
      zoom: 1,
      dpr: 1,
      width: 32,
      height: 16,
    };
    const lanes = packPairLanes(
      vertices,
      input.affine,
      input.camera,
      1,
      1,
      bboxMidpoint(vertices),
      [0, 0],
    );
    const faithful = k5Errors(input, lanes, [0, 1, 2]);
    const rn = k5Errors(input, lanes, [0, 1, 2], true);
    if (faithful === 'lane-range' || rn === 'lane-range') throw new Error('lane-range');
    // Vertex 1 = (1, 0): u = (1, -0.5), B = (8, 4.5), F = 0, physical x = 9, size/2 = 16.
    const error = faithful.get(1)!;
    expect(error.pack[0].n).toBe(0n);
    const absSum = rational(9n);
    const shader = mul(GAMMA_PAIR, add(absSum, rational(16n)));
    const ndc = mul(
      rational(1n, 1n << 23n),
      add(absolute(sub(rational(9n), rational(16n))), shader),
    );
    expect(error.ex).toEqual(add(add(shader, ndc), PHI));
    const rnNdc = mul(rational(1n, 1n << 24n), add(rational(7n), shader));
    expect(rn.get(1)!.ex).toEqual(add(add(shader, rnNdc), PHI));
  });
});
