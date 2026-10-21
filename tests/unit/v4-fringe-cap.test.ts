import { DIAGNOSTIC_CODES, type FillMesh } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import {
  PATH_MESH_LIMITS,
  pathMeshNoticeDiagnostic,
  type PathFringeBuilder,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import {
  ScriptedFillMeshPort,
  createCountingPort,
  createPathHarness,
  fringeDouble,
  okResult,
  pathNode,
} from '../support/v3a-path-harness.js';

// P3 D8 checkpoint V4: the fringe-builder work cap that gates a real host port (plan entry
// "V4 playground path page"). A mesh whose boundaryEdges name more distinct vertices than
// fringeBoundaryVertexCap is drawn region-only, the builder is never called for it, and one
// D8-interim notice `renderer fringe-work-cap` is queued per cache entry. Functional evidence
// only: precision is UNVERIFIED against the 0.25 physical-pixel target.

/** A convex counterclockwise n-gon fan with its n boundary edges. */
function polygonMesh(n: number, radius = 10): FillMesh {
  const positions: number[] = [];
  for (let index = 0; index < n; index += 1) {
    const angle = (2 * Math.PI * index) / n;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle));
  }
  const indices: number[] = [];
  for (let index = 1; index + 1 < n; index += 1) indices.push(0, index, index + 1);
  const boundaryEdges: number[] = [];
  for (let index = 0; index < n; index += 1) boundaryEdges.push(index, (index + 1) % n);
  const xs = positions.filter((_, index) => index % 2 === 0);
  const ys = positions.filter((_, index) => index % 2 === 1);
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    boundaryEdges: Uint32Array.from(boundaryEdges),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}

/** Two disjoint convex contours of na and nb vertices: na + nb distinct boundary vertices. */
function twoContourMesh(na: number, nb: number): FillMesh {
  const a = polygonMesh(na);
  const b = polygonMesh(nb, 4);
  const positions = [...a.positions, ...b.positions].map((value, index) =>
    index >= a.positions.length && (index - a.positions.length) % 2 === 0 ? value + 100 : value,
  );
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (value) => value + na)]),
    boundaryEdges: Uint32Array.from([
      ...a.boundaryEdges,
      ...Array.from(b.boundaryEdges, (value) => value + na),
    ]),
    bounds: {
      minX: Math.min(a.bounds.minX, b.bounds.minX + 100),
      minY: Math.min(a.bounds.minY, b.bounds.minY),
      maxX: Math.max(a.bounds.maxX, b.bounds.maxX + 100),
      maxY: Math.max(a.bounds.maxY, b.bounds.maxY),
    },
  };
}

function countingBuilder(): { builder: PathFringeBuilder; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    builder: (_mesh, f) => {
      calls.push(f);
      return { status: 'built', fringe: fringeDouble(new Float32Array(8), new Uint32Array(8)) };
    },
  };
}

describe('V4 fringe-builder work cap', () => {
  it('V4: the production cap is 128 distinct boundary vertices', () => {
    expect(PATH_MESH_LIMITS.fringeBoundaryVertexCap).toBe(128);
  });

  it('V4: above the cap the path draws region-only, the builder is not called, and one notice is queued', () => {
    const { builder, calls } = countingBuilder();
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0)],
      fringeBuilder: builder,
      limits: { fringeBoundaryVertexCap: 3 },
    });
    const first = h.prepare();
    expect(first.draws.map((draw) => [draw.nodeId, draw.fringe, draw.fringeBucket])).toEqual([
      ['a', null, null],
    ]);
    expect(first.notices).toEqual([
      {
        interim: 'd8',
        nodeId: 'a',
        failureScope: 'renderer',
        failureCode: 'fringe-work-cap',
        toleranceExponent: -3,
        paint: 'fill',
      },
    ]);
    // Later frames and a new fringe bucket stay region-only without a second notice.
    expect(h.prepare()).toMatchObject({ notices: [] });
    h.setZoom(0.5);
    const zoomed = h.prepare();
    expect(zoomed.draws.map((draw) => draw.fringe)).toEqual([null]);
    expect(zoomed.notices).toEqual([]);
    expect(calls).toEqual([]);
    expect(port.calls).toHaveLength(1);
  });

  it('V4: at the cap the builder runs and the fringe is served', () => {
    const { builder, calls } = countingBuilder();
    const h = createPathHarness({
      port: createCountingPort(),
      nodes: [pathNode('a', 0)],
      fringeBuilder: builder,
      limits: { fringeBoundaryVertexCap: 4 },
    });
    const frame = h.prepare();
    expect(frame.notices).toEqual([]);
    expect(frame.draws.map((draw) => draw.fringeBucket)).toEqual([1]);
    expect(calls).toEqual([1]);
  });

  it('V4: a new tolerance entry above the cap notifies once for that entry', () => {
    const { builder } = countingBuilder();
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [pathNode('a', 0)],
      fringeBuilder: builder,
      limits: { fringeBoundaryVertexCap: 3 },
    });
    expect(h.prepare().notices).toHaveLength(1);
    h.setZoom(16);
    const frame = h.prepare();
    expect(port.calls).toHaveLength(2);
    expect(frame.notices.map((entry) => [entry.failureCode, entry.toleranceExponent])).toEqual([
      ['fringe-work-cap', frame.draws[0]!.toleranceExponent],
    ]);
  });

  it('V4: with the real builder, 128 boundary vertices get a fringe and 129 draw region-only', () => {
    const meshes = new Map<number, FillMesh>([
      [0, polygonMesh(128)],
      [40, polygonMesh(129)],
    ]);
    const port = new ScriptedFillMeshPort({
      request: (request, tag) => {
        const mesh = meshes.get(tag);
        if (mesh === undefined) throw new Error(`no mesh for tag ${tag}`);
        return okResult(request, mesh);
      },
    });
    const h = createPathHarness({
      port,
      nodes: [pathNode('at-cap', 0), pathNode('above-cap', 40)],
      fringeBuilder: buildPathFringe,
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => [draw.nodeId, draw.fringe !== null])).toEqual([
      ['at-cap', true],
      ['above-cap', false],
    ]);
    expect(frame.notices.map((entry) => [entry.nodeId, entry.failureCode])).toEqual([
      ['above-cap', 'fringe-work-cap'],
    ]);
  });

  it('V4 SF3: the cap counts distinct boundary vertices over all contours (64 + 65 capped, 64 + 64 not)', () => {
    const meshes = new Map<number, FillMesh>([
      [0, twoContourMesh(64, 64)],
      [40, twoContourMesh(64, 65)],
    ]);
    const port = new ScriptedFillMeshPort({
      request: (request, tag) => {
        const mesh = meshes.get(tag);
        if (mesh === undefined) throw new Error(`no mesh for tag ${tag}`);
        return okResult(request, mesh);
      },
    });
    const h = createPathHarness({
      port,
      nodes: [pathNode('at-cap', 0), pathNode('above-cap', 40)],
      fringeBuilder: buildPathFringe,
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => [draw.nodeId, draw.fringe !== null])).toEqual([
      ['at-cap', true],
      ['above-cap', false],
    ]);
    expect(frame.notices.map((entry) => [entry.nodeId, entry.failureCode])).toEqual([
      ['above-cap', 'fringe-work-cap'],
    ]);
  });

  it('V4 SF3: a geometry-revision bump starts a new cache entry that notifies again', () => {
    const { builder } = countingBuilder();
    const h = createPathHarness({
      port: createCountingPort(),
      nodes: [pathNode('a', 0)],
      fringeBuilder: builder,
      limits: { fringeBoundaryVertexCap: 3 },
    });
    expect(h.prepare().notices).toHaveLength(1);
    expect(h.prepare().notices).toHaveLength(0);
    h.replace([pathNode('a', 0, { points: [0, 0, 12, 0, 12, 12] })]);
    expect(h.prepare().notices.map((entry) => entry.failureCode)).toEqual(['fringe-work-cap']);
  });

  it('V4 SF3: a fill-rule change starts a new cache entry that notifies again', () => {
    const { builder } = countingBuilder();
    const h = createPathHarness({
      port: createCountingPort(),
      nodes: [pathNode('a', 0)],
      fringeBuilder: builder,
      limits: { fringeBoundaryVertexCap: 3 },
    });
    expect(h.prepare().notices).toHaveLength(1);
    h.replace([pathNode('a', 0, { fillRule: 'evenodd' })]);
    expect(h.prepare().notices.map((entry) => entry.failureCode)).toEqual(['fringe-work-cap']);
  });

  it('V4 SF3: a revision that drops under the cap gets its fringe and calls the builder', () => {
    const { builder, calls } = countingBuilder();
    let boundary = 129;
    const port = new ScriptedFillMeshPort({
      request: (request) => okResult(request, polygonMesh(boundary)),
    });
    const h = createPathHarness({ port, nodes: [pathNode('a', 0)], fringeBuilder: builder });
    const first = h.prepare();
    expect(first.draws.map((draw) => draw.fringe)).toEqual([null]);
    expect(first.notices).toHaveLength(1);
    expect(calls).toEqual([]);
    boundary = 128;
    h.replace([pathNode('a', 0, { points: [0, 0, 12, 0, 12, 12] })]);
    const second = h.prepare();
    expect(second.draws.map((draw) => draw.fringe !== null)).toEqual([true]);
    expect(second.notices).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('V4: the fringe-work-cap diagnostic says the path is drawn without its fringe', () => {
    const diagnostic = pathMeshNoticeDiagnostic(
      {
        interim: 'd8',
        nodeId: 'a',
        failureScope: 'renderer',
        failureCode: 'fringe-work-cap',
        toleranceExponent: -3,
        paint: 'fill',
      },
      2,
    );
    expect(diagnostic).toMatchObject({
      code: DIAGNOSTIC_CODES.PATH_MESH_INTERIM_FAILURE,
      severity: 'warning',
      generation: 2,
      message:
        'D8-interim: path a is drawn without its coverage fringe (renderer fringe-work-cap).',
      context: { failureCode: 'fringe-work-cap', failureScope: 'renderer', nodeId: 'a' },
    });
  });
});
