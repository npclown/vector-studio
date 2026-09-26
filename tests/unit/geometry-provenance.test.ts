import { describe, expect, it } from 'vitest';
import {
  ABI_VERSION,
  decodeOutput,
  OUTPUT_MAGIC,
  PATH_STATUS,
  type PackedPath,
} from '../../packages/geometry-wasm/src/abi.js';

type Interval = readonly [numerator: number, depth: number];

const SOURCE: PackedPath = {
  requestId: 17,
  sourceEpoch: 23,
  sourceRevision: 29,
  tolerance: 0.25,
  verbs: new Uint8Array([0, 2]),
  points: new Float64Array([0, 0, 1, 0, 2, 0, 3, 0]),
};

const MIXED_DEPTH_PARTITION: readonly Interval[] = [
  [1, 1],
  [524_289, 20],
  [524_290, 20],
  [262_146, 19],
  [131_074, 18],
  [65_538, 17],
  [32_770, 16],
  [16_386, 15],
  [8_194, 14],
  [4_098, 13],
  [2_050, 12],
  [1_026, 11],
  [514, 10],
  [258, 9],
  [130, 8],
  [66, 7],
  [34, 6],
  [18, 5],
  [10, 4],
  [6, 3],
  [4, 2],
];

describe('packed output provenance validation', () => {
  it('accepts mixed-depth coverage through depth 20 with exact cross-products above u32', () => {
    expect(bigIntPartitionCoversUnitInterval(MIXED_DEPTH_PARTITION)).toBe(true);
    expect(524_289n * (1n << 20n)).toBeGreaterThan(0xffff_ffffn);

    const decoded = decodeOutput(packOutput(MIXED_DEPTH_PARTITION), [SOURCE]);
    expect(decoded).toHaveLength(1);
    expect(Array.from(decoded[0]!.provenance.slice(3))).toEqual(
      MIXED_DEPTH_PARTITION.flatMap(([numerator, depth]) => [1, numerator, depth]),
    );
  });

  it('uses a test-only BigInt oracle for adversarial partition acceptance', () => {
    const gap = MIXED_DEPTH_PARTITION.map(([numerator, depth], index) =>
      index === 2 ? [numerator + 1, depth] : [numerator, depth],
    ) as readonly Interval[];
    const overlap = MIXED_DEPTH_PARTITION.map(([numerator, depth], index) =>
      index === 2 ? [numerator - 1, depth] : [numerator, depth],
    ) as readonly Interval[];
    const partitions: readonly (readonly [string, readonly Interval[], boolean])[] = [
      ['mixed-depth coverage', MIXED_DEPTH_PARTITION, true],
      ['whole depth-zero interval', [[1, 0]], true],
      ['depth-21 mutation', [[1, 21]], false],
      ['u32-extreme depth mutation', [[1, 0xffff_ffff]], false],
      ['zero-numerator mutation', [[0, 0]], false],
      ['over-denominator mutation', [[2, 0]], false],
      ['u32-extreme numerator mutation', [[0xffff_ffff, 20]], false],
      ['gap mutation', gap, false],
      ['overlap mutation', overlap, false],
      ['incomplete coverage', [[1, 1]], false],
    ];

    for (const [name, intervals, expected] of partitions) {
      expect(bigIntPartitionCoversUnitInterval(intervals), name).toBe(expected);
      expect(decoderAccepts(intervals), name).toBe(expected);
    }
  });

  it.each([
    ['depth 21', [[1, 21]] satisfies readonly Interval[], 'cubic provenance depth is invalid'],
    [
      'u32-extreme depth',
      [[1, 0xffff_ffff]] satisfies readonly Interval[],
      'cubic provenance depth is invalid',
    ],
    [
      'zero numerator',
      [[0, 0]] satisfies readonly Interval[],
      'cubic provenance numerator is invalid',
    ],
    [
      'over-denominator numerator',
      [[2, 0]] satisfies readonly Interval[],
      'cubic provenance numerator is invalid',
    ],
    [
      'u32-extreme numerator',
      [[0xffff_ffff, 20]] satisfies readonly Interval[],
      'cubic provenance numerator is invalid',
    ],
    [
      'gap',
      [
        [1, 1],
        [524_290, 20],
      ] satisfies readonly Interval[],
      'cubic provenance intervals are not contiguous',
    ],
    [
      'overlap',
      [
        [1, 1],
        [524_289, 20],
        [524_289, 20],
      ] satisfies readonly Interval[],
      'cubic provenance intervals are not contiguous',
    ],
    [
      'incomplete coverage',
      [[1, 1]] satisfies readonly Interval[],
      'cubic provenance does not cover [0,1]',
    ],
  ])('rejects %s before accepting malformed coverage', (_name, intervals, message) => {
    expect(() => decodeOutput(packOutput(intervals), [SOURCE])).toThrow(message);
  });
});

function packOutput(intervals: readonly Interval[]): Uint8Array {
  const verbCount = intervals.length + 1;
  const pointCount = verbCount * 2;
  const resultsOffset = 48;
  const verbsOffset = resultsOffset + 64;
  const pointsOffset = align(verbsOffset + verbCount, 8);
  const provenanceOffset = align(pointsOffset + pointCount * 8, 4);
  const totalBytes = provenanceOffset + verbCount * 12;
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  [
    OUTPUT_MAGIC,
    ABI_VERSION,
    totalBytes,
    1,
    verbCount,
    pointCount,
    resultsOffset,
    verbsOffset,
    pointsOffset,
    provenanceOffset,
    0,
    0,
  ].forEach((value, index) => view.setUint32(index * 4, value, true));
  view.setUint32(resultsOffset, SOURCE.requestId, true);
  view.setUint32(resultsOffset + 4, SOURCE.sourceEpoch, true);
  view.setUint32(resultsOffset + 8, SOURCE.sourceRevision, true);
  view.setUint32(resultsOffset + 12, PATH_STATUS.OK, true);
  view.setUint32(resultsOffset + 16, 0, true);
  view.setUint32(resultsOffset + 20, verbCount, true);
  view.setUint32(resultsOffset + 24, 0, true);
  view.setUint32(resultsOffset + 28, pointCount, true);
  view.setFloat64(resultsOffset + 32, 0, true);
  view.setFloat64(resultsOffset + 40, 0, true);
  view.setFloat64(resultsOffset + 48, 3, true);
  view.setFloat64(resultsOffset + 56, 0, true);

  bytes[verbsOffset] = 0;
  view.setFloat64(pointsOffset, 0, true);
  view.setFloat64(pointsOffset + 8, 0, true);
  view.setUint32(provenanceOffset, 0, true);
  view.setUint32(provenanceOffset + 4, 1, true);
  view.setUint32(provenanceOffset + 8, 0, true);
  for (let index = 0; index < intervals.length; index += 1) {
    const [numerator, depth] = intervals[index]!;
    const verbIndex = index + 1;
    bytes[verbsOffset + verbIndex] = 1;
    const endpointX = depth <= 20 ? (3 * numerator) / 2 ** depth : 0;
    view.setFloat64(pointsOffset + verbIndex * 16, endpointX, true);
    view.setFloat64(pointsOffset + verbIndex * 16 + 8, 0, true);
    view.setUint32(provenanceOffset + verbIndex * 12, 1, true);
    view.setUint32(provenanceOffset + verbIndex * 12 + 4, numerator, true);
    view.setUint32(provenanceOffset + verbIndex * 12 + 8, depth, true);
  }
  return bytes;
}

function bigIntPartitionCoversUnitInterval(intervals: readonly Interval[]): boolean {
  let previousNumerator = 0n;
  let previousDenominator = 1n;
  for (const [numerator, depth] of intervals) {
    if (!Number.isInteger(depth) || depth < 0 || depth > 20) return false;
    const denominator = 1n << BigInt(depth);
    const currentNumerator = BigInt(numerator);
    if (currentNumerator <= 0n || currentNumerator > denominator) return false;
    if (previousNumerator * denominator !== (currentNumerator - 1n) * previousDenominator) {
      return false;
    }
    previousNumerator = currentNumerator;
    previousDenominator = denominator;
  }
  return intervals.length > 0 && previousNumerator === previousDenominator;
}

function decoderAccepts(intervals: readonly Interval[]): boolean {
  try {
    decodeOutput(packOutput(intervals), [SOURCE]);
    return true;
  } catch {
    return false;
  }
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
