import { describe, expect, it } from 'vitest';
import { bitsOf } from './rounded-fill/exact.js';
import { exactMeshTwiceArea } from './native-triangle-free-cubic/verify.js';
import {
  DEFAULT_LIMITS,
  refineConformingMesh,
  verifyConformingRefinement,
  type ConformingMeshResult,
  type ConformingRefinementMesh,
} from './conforming-mesh/oracle.js';
import {
  fixedCarrierConformingMeshFixtures,
  fixedConformingMeshFixtures,
  type ConformingMeshFixture,
  type PlainMesh,
} from './conforming-mesh/fixtures.js';

function pointBits(vertices: readonly (readonly [number, number])[]) {
  return vertices.map(([x, y]) => [bitsOf(x), bitsOf(y)] as const);
}

function certified(
  fixture: ConformingMeshFixture,
  limits = DEFAULT_LIMITS,
): ConformingRefinementMesh {
  const result = refineConformingMesh(fixture.mesh, limits);
  expect(result.status, `${fixture.id}: ${result.reason}`).toBe('CERTIFIED');
  if (result.status !== 'CERTIFIED') throw new Error(`${fixture.id}: ${result.reason}`);
  expect(() => verifyConformingRefinement(fixture.mesh, result.mesh)).not.toThrow();
  expect(pointBits(result.mesh.vertices)).toEqual(pointBits(fixture.mesh.vertices));
  expect(result.mesh.vertices).not.toBe(fixture.mesh.vertices);
  expect(result.mesh.indices.length / 3).toBe(fixture.expectedTriangleCount);
  expect(result.stats.emittedTriangles).toBe(fixture.expectedTriangleCount);
  expect(exactMeshTwiceArea(result.mesh)).toBe(fixture.expectedTwiceArea);
  const counts = Array<number>(fixture.mesh.indices.length / 3).fill(0);
  for (const parent of result.mesh.parentTriangle) counts[parent] = counts[parent]! + 1;
  expect(counts).toEqual(fixture.expectedParentCounts);
  if (fixture.expectedIndices) expect(result.mesh.indices).toEqual(fixture.expectedIndices);
  if (fixture.expectedParents) expect(result.mesh.parentTriangle).toEqual(fixture.expectedParents);
  return result.mesh;
}

function expectFailure(
  mesh: unknown,
  status: Exclude<ConformingMeshResult['status'], 'CERTIFIED'>,
  reason: string,
  limits?: unknown,
): Exclude<ConformingMeshResult, { status: 'CERTIFIED' }> {
  const result =
    limits === undefined ? refineConformingMesh(mesh) : refineConformingMesh(mesh, limits);
  expect(result.status).toBe(status);
  if (result.status === 'CERTIFIED') throw new Error('unexpected conforming success');
  expect(result.reason).toContain(reason);
  expect('mesh' in result).toBe(false);
  return result;
}

function expectVerifyFailure(source: unknown, proposed: unknown, reason: string): void {
  expect(() => verifyConformingRefinement(source, proposed)).toThrow(reason);
}

describe('P3.1j conforming mesh refinement oracle', () => {
  const analytic = fixedConformingMeshFixtures();

  it.each(analytic)('$id preserves coordinates, exact area, parents, and conformity', (fixture) => {
    const result = refineConformingMesh(fixture.mesh);
    expect(result.status, result.status === 'CERTIFIED' ? '' : result.reason).toBe('CERTIFIED');
    if (result.status !== 'CERTIFIED') return;
    const expectedEdgeChecks = 3 * fixture.mesh.vertices.length * (fixture.mesh.indices.length / 3);
    expect(result.stats.edgeVertexChecks).toBe(expectedEdgeChecks);
    expect(result.stats.work).toBe(result.stats.edgeVertexChecks + result.stats.earChecks);
    certified(fixture);
  });

  it('pins the exact analytic counter boundaries and deterministic literals', () => {
    const triangle = analytic[0]!;
    const hanging = analytic[2]!;
    const chain = analytic[4]!;
    const eachSide = analytic[6]!;
    for (const [fixture, edgeVertexChecks, earChecks, work] of [
      [triangle, 9, 0, 9],
      [hanging, 45, 2, 47],
      [chain, 18, 4, 22],
      [eachSide, 18, 3, 21],
    ] as const) {
      const result = refineConformingMesh(fixture.mesh);
      expect(result.status).toBe('CERTIFIED');
      if (result.status !== 'CERTIFIED') continue;
      expect(result.stats).toEqual({
        edgeVertexChecks,
        earChecks,
        emittedTriangles: fixture.expectedTriangleCount,
        work,
      });
    }
  });

  it('accepts an independently valid each-side triangulation with different ears', () => {
    const source = analytic[6]!.mesh;
    const alternative: ConformingRefinementMesh = {
      vertices: source.vertices.map(([x, y]) => [x, y] as const),
      indices: [4, 2, 5, 5, 0, 3, 3, 1, 5, 1, 4, 5],
      parentTriangle: [0, 0, 0, 0],
    };
    expect(() => verifyConformingRefinement(source, alternative)).not.toThrow();
    expect(alternative.indices).not.toEqual(analytic[6]!.expectedIndices);
  });

  it('preserves all twelve independent W/Y/Z carriers and their metadata', () => {
    const fixtures = fixedCarrierConformingMeshFixtures();
    expect(fixtures).toHaveLength(12);
    for (const fixture of fixtures) {
      const snapshot = structuredClone(fixture.carrier);
      const result = refineConformingMesh(fixture.mesh);
      expect(result.status, fixture.id).toBe('CERTIFIED');
      if (result.status !== 'CERTIFIED') continue;
      expect(() => verifyConformingRefinement(fixture.mesh, result.mesh)).not.toThrow();
      expect(pointBits(result.mesh.vertices)).toEqual(pointBits(fixture.mesh.vertices));
      expect(result.mesh.indices.length / 3).toBe(fixture.expectedTriangleCount);
      expect(exactMeshTwiceArea(result.mesh)).toBe(fixture.expectedTwiceArea);
      const counts = Array<number>(fixture.mesh.indices.length / 3).fill(0);
      for (const parent of result.mesh.parentTriangle) counts[parent] = counts[parent]! + 1;
      expect(counts).toEqual(fixture.expectedParentCounts);
      expect(fixture.carrier).toEqual(snapshot);
      const expectedEdgeChecks =
        3 * fixture.mesh.vertices.length * (fixture.mesh.indices.length / 3);
      expect(result.stats.edgeVertexChecks).toBe(expectedEdgeChecks);
      expect(result.stats.emittedTriangles).toBe(fixture.expectedTriangleCount);
      expect(result.stats.work).toBe(result.stats.edgeVertexChecks + result.stats.earChecks);
    }
  });

  it('returns detached copies and preserves signed-zero bits and unused vertices', () => {
    const source: PlainMesh = {
      vertices: [
        [-0, 0],
        [1, 0],
        [0, 1],
        [7, 9],
      ],
      indices: [0, 1, 2],
    };
    const sourceBits = pointBits(source.vertices);
    const result = refineConformingMesh(source);
    expect(result.status).toBe('CERTIFIED');
    if (result.status !== 'CERTIFIED') return;
    expect(pointBits(result.mesh.vertices)).toEqual(sourceBits);
    expect(result.mesh.vertices).not.toBe(source.vertices);
    expect(result.mesh.vertices[0]).not.toBe(source.vertices[0]);
    const returned = result.mesh.vertices as Array<[number, number]>;
    returned[0]![0] = 5;
    expect(pointBits(source.vertices)).toEqual(sourceBits);

    const mutableSource = {
      vertices: [
        [0, 0],
        [1, 0],
        [0, 1],
      ] as Array<[number, number]>,
      indices: [0, 1, 2],
    };
    const detached = refineConformingMesh(mutableSource);
    expect(detached.status).toBe('CERTIFIED');
    if (detached.status !== 'CERTIFIED') return;
    const detachedBits = pointBits(detached.mesh.vertices);
    const detachedIndices = [...detached.mesh.indices];
    mutableSource.vertices[0]![0] = 9;
    mutableSource.indices[0] = 2;
    expect(pointBits(detached.mesh.vertices)).toEqual(detachedBits);
    expect(detached.mesh.indices).toEqual(detachedIndices);
  });

  it('rejects malformed limits and mesh shapes in frozen precedence order', () => {
    const triangle = analytic[0]!.mesh;
    expectFailure(null, 'INVALID_INPUT', 'input:');
    expectFailure({}, 'INVALID_INPUT', 'input:');
    expectFailure(triangle, 'INVALID_INPUT', 'limits', { ...DEFAULT_LIMITS, extra: 1 });
    expectFailure(triangle, 'INVALID_INPUT', 'limits', {
      maxVertices: DEFAULT_LIMITS.maxVertices,
      maxInputTriangles: DEFAULT_LIMITS.maxInputTriangles,
      maxOutputTriangles: DEFAULT_LIMITS.maxOutputTriangles,
    });
    for (const [field, value] of [
      ['maxVertices', 0],
      ['maxInputTriangles', -1],
      ['maxOutputTriangles', 1.5],
      ['maxWork', 0],
      ['maxVertices', DEFAULT_LIMITS.maxVertices + 1],
      ['maxInputTriangles', DEFAULT_LIMITS.maxInputTriangles + 1],
      ['maxOutputTriangles', DEFAULT_LIMITS.maxOutputTriangles + 1],
      ['maxWork', DEFAULT_LIMITS.maxWork + 1],
    ] as const)
      expectFailure(triangle, 'INVALID_INPUT', 'limits', { ...DEFAULT_LIMITS, [field]: value });
    expectFailure({ vertices: new Array(3), indices: [] }, 'INVALID_INPUT', 'vertices:');
    expectFailure(
      { vertices: triangle.vertices, indices: new Array(3) },
      'INVALID_INPUT',
      'indices:',
    );
    expectFailure({ vertices: triangle.vertices, indices: [0, 1] }, 'INVALID_INPUT', 'divisible');
    expectFailure(
      {
        vertices: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        indices: [0, 1],
      },
      'INVALID_INPUT',
      'divisible',
      { ...DEFAULT_LIMITS, maxVertices: 2 },
    );
  });

  it('rejects finite, uniqueness, index, orientation, and overlap controls by stage', () => {
    expectFailure(
      {
        vertices: [
          [0, 0],
          [1, 0],
          [0, Infinity],
        ],
        indices: [0, 1, 2],
      },
      'INVALID_INPUT',
      'vertices:',
    );
    expectFailure(
      {
        vertices: [
          [0, 0],
          [-0, 0],
          [0, 1],
        ],
        indices: [],
      },
      'INVALID_INPUT',
      'vertices:',
    );
    expectFailure(
      {
        vertices: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        indices: [0, 1, 3],
      },
      'INVALID_INPUT',
      'indices:',
    );
    expectFailure(
      {
        vertices: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        indices: [0, 1, 1.5],
      },
      'INVALID_INPUT',
      'indices:',
    );
    expectFailure(
      {
        vertices: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        indices: [0, 1, 2],
      },
      'INVALID_INPUT',
      'triangles:',
    );
    expectFailure(
      {
        vertices: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        indices: [0, 2, 1],
      },
      'INVALID_INPUT',
      'triangles:',
    );
    expectFailure(
      {
        vertices: [
          [0, 0],
          [2, 0],
          [0, 2],
          [1, 0],
          [2, 1],
          [1, 1],
        ],
        indices: [0, 1, 2, 3, 4, 5],
      },
      'INVALID_INPUT',
      'triangles:',
    );
  });

  it('enforces input, output, and work caps without partial publication', () => {
    const hanging = analytic[2]!.mesh;
    expect(refineConformingMesh(hanging, { ...DEFAULT_LIMITS, maxVertices: 5 }).status).toBe(
      'CERTIFIED',
    );
    expect(refineConformingMesh(hanging, { ...DEFAULT_LIMITS, maxInputTriangles: 3 }).status).toBe(
      'CERTIFIED',
    );
    const vertexFail = expectFailure(hanging, 'WORK_LIMIT', 'input-limit:', {
      ...DEFAULT_LIMITS,
      maxVertices: 4,
    });
    expect(vertexFail.stats).toEqual({
      edgeVertexChecks: 0,
      earChecks: 0,
      emittedTriangles: 0,
      work: 0,
    });
    expect(vertexFail.reason).toBe('input-limit: vertices exceed 4');
    const triangleFail = expectFailure(hanging, 'WORK_LIMIT', 'input-limit:', {
      ...DEFAULT_LIMITS,
      maxInputTriangles: 2,
    });
    expect(triangleFail.stats).toEqual({
      edgeVertexChecks: 0,
      earChecks: 0,
      emittedTriangles: 0,
      work: 0,
    });
    expect(triangleFail.reason).toBe('input-limit: triangles exceed 2');
    const outputPass = refineConformingMesh(hanging, { ...DEFAULT_LIMITS, maxOutputTriangles: 4 });
    expect(outputPass.status).toBe('CERTIFIED');
    const outputFail = expectFailure(hanging, 'WORK_LIMIT', 'output-limit:', {
      ...DEFAULT_LIMITS,
      maxOutputTriangles: 3,
    });
    expect(outputFail.stats).toEqual({
      edgeVertexChecks: 45,
      earChecks: 2,
      emittedTriangles: 3,
      work: 47,
    });
    expect(outputFail.reason).toBe('output-limit: triangles exceed 3');
    const workPass = refineConformingMesh(hanging, { ...DEFAULT_LIMITS, maxWork: 47 });
    expect(workPass.status).toBe('CERTIFIED');
    const workFail = expectFailure(hanging, 'WORK_LIMIT', 'work-limit:', {
      ...DEFAULT_LIMITS,
      maxWork: 46,
    });
    expect(workFail.stats).toEqual({
      edgeVertexChecks: 44,
      earChecks: 2,
      emittedTriangles: 3,
      work: 46,
    });
    expect(workFail.reason).toBe('work-limit: edge-vertex check exceeds 46');
  });

  it('independently rejects missing, duplicated, changed, overlapping, and misattributed output', () => {
    const hanging = analytic[2]!;
    const result = refineConformingMesh(hanging.mesh);
    expect(result.status).toBe('CERTIFIED');
    if (result.status !== 'CERTIFIED') return;
    const mesh = result.mesh;
    expectVerifyFailure(
      hanging.mesh,
      { ...mesh, indices: mesh.indices.slice(3), parentTriangle: mesh.parentTriangle.slice(1) },
      'area',
    );
    expectVerifyFailure(
      analytic[6]!.mesh,
      {
        vertices: analytic[6]!.mesh.vertices.map(([x, y]) => [x, y] as const),
        indices: [0, 1, 4, 0, 1, 4],
        parentTriangle: [0, 0],
      },
      'overlap',
    );
    expectVerifyFailure(
      hanging.mesh,
      { ...mesh, parentTriangle: [0, 1, ...mesh.parentTriangle.slice(2)] },
      'parent',
    );
    const vertices = mesh.vertices.map((point, index) =>
      index === 0 ? ([point[0] + 1 / 16, point[1]] as const) : point,
    );
    expectVerifyFailure(hanging.mesh, { ...mesh, vertices }, 'proposed-vertices');
    expectVerifyFailure(
      analytic[6]!.mesh,
      {
        vertices: analytic[6]!.mesh.vertices.map(([x, y]) => [x, y] as const),
        indices: [0, 1, 4, 0, 1, 5],
        parentTriangle: [0, 0],
      },
      'overlap',
    );
  });

  it('rejects unrefined T contacts, stranded chains, and sparse inputs and proposals', () => {
    const hanging = analytic[2]!.mesh;
    expectVerifyFailure(
      hanging,
      {
        vertices: hanging.vertices.map(([x, y]) => [x, y] as const),
        indices: [...hanging.indices],
        parentTriangle: [0, 1, 2],
      },
      'boundary',
    );
    const chain = analytic[4]!.mesh;
    expectVerifyFailure(
      chain,
      {
        vertices: chain.vertices.map(([x, y]) => [x, y] as const),
        indices: [0, 1, 2],
        parentTriangle: [0],
      },
      'boundary',
    );
    expectVerifyFailure(
      hanging,
      { vertices: new Array(5), indices: [], parentTriangle: [] },
      'proposed-vertices',
    );
    const valid = certified(analytic[0]!);
    expectVerifyFailure(
      { vertices: new Array(3), indices: analytic[0]!.mesh.indices },
      valid,
      'source-vertices',
    );
    expectVerifyFailure(
      { vertices: analytic[0]!.mesh.vertices, indices: new Array(3) },
      valid,
      'source-indices',
    );
    expectVerifyFailure(
      analytic[0]!.mesh,
      { ...valid, parentTriangle: new Array(1) },
      'proposed-parent',
    );
    expectVerifyFailure(
      { vertices: Array.from({ length: 257 }, (_, index) => [index, 0]), indices: [] },
      valid,
      'source-limit',
    );
    expectVerifyFailure(
      analytic[0]!.mesh,
      {
        vertices: valid.vertices,
        indices: Array.from({ length: 513 }, () => [0, 1, 2]).flat(),
        parentTriangle: Array<number>(513).fill(0),
      },
      'proposed-limit',
    );
  });
});
