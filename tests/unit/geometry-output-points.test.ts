import { describe, expect, it } from 'vitest';
import {
  ABI_VERSION,
  decodeOutput,
  OUTPUT_MAGIC,
  PATH_STATUS,
  type PackedPath,
} from '../../packages/geometry-wasm/src/abi.js';

const FIRST_SOURCE: PackedPath = {
  requestId: 101,
  sourceEpoch: 102,
  sourceRevision: 103,
  tolerance: 0.25,
  verbs: new Uint8Array([0, 1]),
  points: new Float64Array([-0, Number.MIN_VALUE, 1e-300, 1e-200]),
};

const SECOND_SOURCE: PackedPath = {
  requestId: 201,
  sourceEpoch: 202,
  sourceRevision: 203,
  tolerance: 0.25,
  verbs: new Uint8Array([0, 1]),
  points: new Float64Array([10, 20, 30, 40]),
};

const SOURCES = [FIRST_SOURCE, SECOND_SOURCE] as const;

type OutputPath = {
  readonly source: PackedPath;
  readonly points: readonly number[];
  readonly bounds: readonly [number, number, number, number];
  readonly verbs?: readonly number[];
  readonly provenance?: readonly number[];
};

type PackedFixture = {
  readonly bytes: Uint8Array;
};

function validPaths(): readonly OutputPath[] {
  return [
    {
      source: FIRST_SOURCE,
      points: Array.from(FIRST_SOURCE.points),
      bounds: [-0, Number.MIN_VALUE, 1e-300, 1e-200],
    },
    {
      source: SECOND_SOURCE,
      points: Array.from(SECOND_SOURCE.points),
      bounds: [10, 20, 30, 40],
    },
  ];
}

describe('packed output point decoding', () => {
  it('copies finite signed-zero, subnormal, and small coordinates from a misaligned little-endian view', () => {
    const fixture = packOutput(validPaths(), 3);

    const decoded = decodeOutput(fixture.bytes, SOURCES);

    expect(fixture.bytes.byteOffset).toBe(3);
    expect(decoded[0]!.points).toHaveLength(4);
    expect(Object.is(decoded[0]!.points[0], -0)).toBe(true);
    expect(decoded[0]!.points[1]).toBe(Number.MIN_VALUE);
    expect(decoded[0]!.points[2]).toBe(1e-300);
    expect(decoded[0]!.points[3]).toBe(1e-200);
    expect(decoded[1]!.points).toEqual(new Float64Array([10, 20, 30, 40]));
  });

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s in both an early and late coordinate slot', (_name, nonfinite) => {
    for (const scalar of [0, 7]) {
      const paths = validPaths().map((path) => ({ ...path, points: [...path.points] }));
      paths[Math.floor(scalar / 4)]!.points[scalar % 4] = nonfinite;

      expect(() => decodeOutput(packOutput(paths).bytes, SOURCES)).toThrow(
        'successful output contains a nonfinite coordinate',
      );
    }
  });

  it('checks malformed bounds and unsupported verbs before coordinates', () => {
    const badBounds = validPaths().map((path) => ({ ...path, points: [...path.points] }));
    badBounds[0]!.bounds = [2, 0, 1, 0];
    badBounds[0]!.points[0] = Number.NaN;
    expect(() => decodeOutput(packOutput(badBounds).bytes, SOURCES)).toThrow(
      'successful output has nonfinite bounds',
    );

    const badVerb = validPaths().map((path) => ({ ...path, points: [...path.points] }));
    badVerb[0]!.verbs = [2, 1];
    badVerb[0]!.points[0] = Number.NaN;
    expect(() => decodeOutput(packOutput(badVerb).bytes, SOURCES)).toThrow(
      'output contains an unsupported verb',
    );
  });

  it('checks coordinates before malformed provenance', () => {
    const paths = validPaths().map((path) => ({ ...path, points: [...path.points] }));
    paths[0]!.provenance = [99, 99, 99, 1, 1, 0];

    expect(() => decodeOutput(packOutput(paths).bytes, SOURCES)).toThrow(
      'non-cubic provenance is invalid',
    );

    paths[0]!.points[0] = Number.NaN;

    expect(() => decodeOutput(packOutput(paths).bytes, SOURCES)).toThrow(
      'successful output contains a nonfinite coordinate',
    );
  });

  it('returns owned point, verb, and provenance buffers across byte mutation and subsequent decoding', () => {
    const firstFixture = packOutput(validPaths(), 3);
    const first = decodeOutput(firstFixture.bytes, SOURCES);
    const firstPath = first[0]!;
    const expectedPoints = Array.from(firstPath.points);
    const expectedVerbs = Array.from(firstPath.verbs);
    const expectedProvenance = Array.from(firstPath.provenance);

    firstFixture.bytes.fill(0);
    const second = decodeOutput(packOutput(validPaths(), 5).bytes, SOURCES);
    second[0]!.points[0] = 99;
    second[0]!.verbs[0] = 3;
    second[0]!.provenance[0] = 99;

    expect(Array.from(firstPath.points)).toEqual(expectedPoints);
    expect(Array.from(firstPath.verbs)).toEqual(expectedVerbs);
    expect(Array.from(firstPath.provenance)).toEqual(expectedProvenance);
    expect(firstPath.points.buffer).not.toBe(first[1]!.points.buffer);
    expect(firstPath.verbs.buffer).not.toBe(first[1]!.verbs.buffer);
    expect(firstPath.provenance.buffer).not.toBe(first[1]!.provenance.buffer);
    expect(firstPath.points.buffer).not.toBe(second[0]!.points.buffer);
    expect(firstPath.verbs.buffer).not.toBe(second[0]!.verbs.buffer);
    expect(firstPath.provenance.buffer).not.toBe(second[0]!.provenance.buffer);
  });

  it('fails the entire batch when a later path has a nonfinite coordinate', () => {
    const paths = validPaths().map((path) => ({ ...path, points: [...path.points] }));
    paths[1]!.points[3] = Number.NEGATIVE_INFINITY;
    const fixture = packOutput(paths, 3);
    let published: ReturnType<typeof decodeOutput> | undefined;

    try {
      published = decodeOutput(fixture.bytes, SOURCES);
    } catch (error) {
      expect(error).toHaveProperty('message', 'successful output contains a nonfinite coordinate');
    }

    expect(published).toBeUndefined();
  });
});

function packOutput(paths: readonly OutputPath[], outerByteOffset = 0): PackedFixture {
  const pathCount = paths.length;
  const verbCount = paths.reduce((total, path) => total + (path.verbs?.length ?? 2), 0);
  const pointCount = paths.reduce((total, path) => total + path.points.length, 0);
  const resultsOffset = 48;
  const verbsOffset = resultsOffset + pathCount * 64;
  const pointsOffset = align(verbsOffset + verbCount, 8);
  const provenanceOffset = align(pointsOffset + pointCount * 8, 4);
  const totalBytes = provenanceOffset + verbCount * 12;
  const bytes = new Uint8Array(
    new ArrayBuffer(outerByteOffset + totalBytes),
    outerByteOffset,
    totalBytes,
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const setU32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  const setF64 = (offset: number, value: number) => view.setFloat64(offset, value, true);

  [
    OUTPUT_MAGIC,
    ABI_VERSION,
    totalBytes,
    pathCount,
    verbCount,
    pointCount,
    resultsOffset,
    verbsOffset,
    pointsOffset,
    provenanceOffset,
    0,
    0,
  ].forEach((value, index) => setU32(index * 4, value));

  let verbStart = 0;
  let pointStart = 0;
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]!;
    const verbs = path.verbs ?? [0, 1];
    const provenance = path.provenance ?? [0, 1, 0, 1, 1, 0];
    const resultOffset = resultsOffset + index * 64;
    setU32(resultOffset, path.source.requestId);
    setU32(resultOffset + 4, path.source.sourceEpoch);
    setU32(resultOffset + 8, path.source.sourceRevision);
    setU32(resultOffset + 12, PATH_STATUS.OK);
    setU32(resultOffset + 16, verbStart);
    setU32(resultOffset + 20, verbStart + verbs.length);
    setU32(resultOffset + 24, pointStart);
    setU32(resultOffset + 28, pointStart + path.points.length);
    path.bounds.forEach((value, boundsIndex) => setF64(resultOffset + 32 + boundsIndex * 8, value));
    verbs.forEach((verb, verbIndex) => {
      bytes[verbsOffset + verbStart + verbIndex] = verb;
    });
    path.points.forEach((point, pointIndex) =>
      setF64(pointsOffset + (pointStart + pointIndex) * 8, point),
    );
    provenance.forEach((value, provenanceIndex) => {
      setU32(provenanceOffset + (verbStart * 3 + provenanceIndex) * 4, value);
    });
    verbStart += verbs.length;
    pointStart += path.points.length;
  }

  return { bytes };
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
