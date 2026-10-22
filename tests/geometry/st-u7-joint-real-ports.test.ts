import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  PATH_VERB_CODES,
  type FillMesh,
  type ScenePathVerb,
  type SceneStrokeCap,
  type SceneStrokeJoin,
} from '@vector-studio/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import { buildJointOverlay } from '../../packages/renderer-core/src/path-joint-overlay.js';

// P3 B2 ST-U7 addendum, unit ST-U7c+d, review follow-up S4 of ST-U7b: the joint overlay builder
// on meshes from the real geometry-wasm fill-v0 and stroke-v0 ports, not hand-built ones:
// curve-flattened paths and round joins and caps with non-dyadic coordinates. Each case runs
// the fill and stroke fringe variants as the renderer would (fringed at or below the 128-vertex
// cap, region-only above it) and the overlay builder, whose own exact partition check is on.
// Every outcome is recorded in artifacts/p3-st-u7-real-ports/results.json; the expectations
// below were fixed from the first run (2026-10-21). Functional evidence only: precision is
// UNVERIFIED against the 0.25 physical-pixel target until B4.

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

type Path = Readonly<{ verbs: readonly ScenePathVerb[]; points: readonly number[] }>;
type Case = Readonly<{
  id: string;
  path: Path;
  width: number;
  cap: SceneStrokeCap;
  join: SceneStrokeJoin;
  /** Tolerance exponent and fringe bucket of both paints. */
  e: number;
  f: number;
}>;

/** A closed blob of four cubics with non-dyadic control points. */
const BLOB: Path = {
  verbs: ['move', 'cubic', 'cubic', 'cubic', 'cubic', 'close'],
  points: [
    0.1, 5.3, 0.7, 1.9, 3.3, 0.2, 5.1, 0.3, 7.7, 0.4, 10.3, 2.9, 10.1, 5.3, 9.9, 8.1, 7.3, 10.3,
    5.1, 10.1, 2.9, 9.9, -0.3, 8.7, 0.1, 5.3,
  ],
};
/** An open S-curve: one cubic then a line, non-dyadic. */
const S_CURVE: Path = {
  verbs: ['move', 'cubic', 'line'],
  points: [0.3, 0.7, 4.1, -3.3, 6.7, 9.1, 10.9, 4.3, 12.1, 0.3],
};
/** A closed D shape: lines and one cubic, non-dyadic. */
const D_SHAPE: Path = {
  verbs: ['move', 'line', 'cubic', 'line', 'close'],
  points: [0.1, 0.3, 8.3, 0.3, 11.7, 0.3, 11.7, 9.9, 8.3, 9.9, 0.1, 9.9],
};
/** An open arch: one cubic, non-dyadic. */
const ARCH: Path = {
  verbs: ['move', 'cubic'],
  points: [0.3, 0.7, 3.3, 7.1, 7.1, 7.1, 10.3, 0.7],
};
/** A closed pentagon with non-dyadic vertices and sharp and blunt turns. */
const PENTAGON: Path = {
  verbs: ['move', 'line', 'line', 'line', 'line', 'close'],
  points: [0.3, 0.1, 9.7, 1.3, 11.1, 6.9, 5.3, 10.7, -0.9, 7.3],
};

const CASES: readonly Case[] = [
  { id: 'blob-round-join', path: BLOB, width: 1.3, cap: 'butt', join: 'round', e: -4, f: -1 },
  { id: 'blob-miter', path: BLOB, width: 0.7, cap: 'butt', join: 'miter', e: -5, f: -2 },
  {
    id: 's-curve-round-caps',
    path: S_CURVE,
    width: 1.1,
    cap: 'round',
    join: 'round',
    e: -4,
    f: -1,
  },
  {
    id: 's-curve-square-caps',
    path: S_CURVE,
    width: 0.9,
    cap: 'square',
    join: 'bevel',
    e: -4,
    f: -1,
  },
  {
    id: 'd-shape-round-join-e-2',
    path: D_SHAPE,
    width: 1.3,
    cap: 'butt',
    join: 'round',
    e: -2,
    f: -1,
  },
  {
    id: 'd-shape-round-join-e-3',
    path: D_SHAPE,
    width: 1.3,
    cap: 'butt',
    join: 'round',
    e: -3,
    f: -1,
  },
  {
    id: 'd-shape-round-join-e-1',
    path: D_SHAPE,
    width: 0.9,
    cap: 'butt',
    join: 'round',
    e: -1,
    f: -2,
  },
  { id: 'd-shape-miter-e-1', path: D_SHAPE, width: 0.9, cap: 'butt', join: 'miter', e: -1, f: -2 },
  { id: 'arch-round-caps-e-2', path: ARCH, width: 1.1, cap: 'round', join: 'round', e: -2, f: -1 },
  { id: 'arch-butt-e-1', path: ARCH, width: 0.7, cap: 'butt', join: 'miter', e: -1, f: -2 },
  { id: 'blob-round-join-e-1', path: BLOB, width: 1.3, cap: 'butt', join: 'round', e: -1, f: -1 },
  {
    id: 'pentagon-round-join',
    path: PENTAGON,
    width: 1.7,
    cap: 'butt',
    join: 'round',
    e: -3,
    f: 0,
  },
  { id: 'pentagon-bevel', path: PENTAGON, width: 0.3, cap: 'butt', join: 'bevel', e: -6, f: -3 },
];

const FRINGE_CAP = 128;

function variantBucket(mesh: FillMesh, f: number): number | null {
  return new Set(mesh.boundaryEdges).size > FRINGE_CAP ? null : f;
}

function nonDyadic(mesh: FillMesh): number {
  let count = 0;
  for (const value of mesh.positions) if (!Number.isInteger(value * 2 ** 20)) count += 1;
  return count;
}

describe('ST-U7 joint overlay on real-port meshes (ST-U7b review S4)', () => {
  it('builds or refuses with a reason on every curve-flattened and round case', async () => {
    const fillPort = await createFillMeshPort(module);
    const strokePort = await createStrokeMeshPort(module);
    const results: Record<string, unknown>[] = [];
    try {
      for (const testCase of CASES) {
        const verbs = Uint8Array.from(testCase.path.verbs, (verb) => PATH_VERB_CODES[verb]);
        const points = Float64Array.from(testCase.path.points);
        const fill = fillPort.buildFillMeshes([
          { requestId: 0, verbs, points, fillRule: 'nonzero', toleranceExponent: testCase.e },
        ]);
        const stroke = strokePort.buildStrokeMeshes([
          {
            requestId: 0,
            verbs,
            points,
            width: testCase.width,
            cap: testCase.cap,
            join: testCase.join,
            miterLimit: 4,
            toleranceExponent: testCase.e,
          },
        ]);
        const fillResult = fill.status === 'ok' ? fill.results[0]! : null;
        const strokeResult = stroke.status === 'ok' ? stroke.results[0]! : null;
        if (fillResult?.status !== 'ok' || strokeResult?.status !== 'ok') {
          results.push({
            id: testCase.id,
            outcome: 'port-failure',
            fill: fillResult?.status === 'failed' ? fillResult.code : fill.status,
            stroke: strokeResult?.status === 'failed' ? strokeResult.code : stroke.status,
          });
          continue;
        }
        const fillMesh = fillResult.mesh;
        const strokeMesh = strokeResult.mesh;
        const fillBucket = variantBucket(fillMesh, testCase.f);
        const strokeBucket = variantBucket(strokeMesh, testCase.f);
        const fringes = {
          fill: fillBucket === null ? 'region-only' : buildPathFringe(fillMesh, fillBucket).status,
          stroke:
            strokeBucket === null
              ? 'region-only'
              : buildPathFringe(strokeMesh, strokeBucket).status,
        };
        const record: Record<string, unknown> = {
          id: testCase.id,
          fillVertices: fillMesh.positions.length / 2,
          strokeVertices: strokeMesh.positions.length / 2,
          strokeBoundaryVertices: new Set(strokeMesh.boundaryEdges).size,
          nonDyadicCoordinates: nonDyadic(fillMesh) + nonDyadic(strokeMesh),
          buckets: [fillBucket, strokeBucket],
          fringes,
        };
        if (fringes.fill !== 'built' && fringes.fill !== 'region-only') {
          results.push({ ...record, outcome: `fill-fringe-${fringes.fill}` });
          continue;
        }
        if (fringes.stroke !== 'built' && fringes.stroke !== 'region-only') {
          results.push({ ...record, outcome: `stroke-fringe-${fringes.stroke}` });
          continue;
        }
        const started = performance.now();
        const overlay = buildJointOverlay({
          fill: { mesh: fillMesh, fringeBucket: fillBucket },
          stroke: { mesh: strokeMesh, fringeBucket: strokeBucket },
        });
        const milliseconds = performance.now() - started;
        results.push({
          ...record,
          outcome: overlay.status,
          ...(overlay.status === 'built'
            ? {
                triangles: overlay.overlay.triangles.length / 8,
                steinerPoints: overlay.overlay.steinerPoints,
                exactTests: overlay.overlay.work.exactTests,
                droppedTriangles: overlay.overlay.droppedTriangles,
              }
            : { reason: overlay.reason, work: overlay.work }),
          milliseconds: Math.round(milliseconds),
        });
      }
    } finally {
      fillPort.dispose();
      strokePort.dispose();
    }
    mkdirSync('artifacts/p3-st-u7-real-ports', { recursive: true });
    writeFileSync(
      'artifacts/p3-st-u7-real-ports/results.json',
      JSON.stringify(
        {
          schema: 'p3-st-u7-real-ports-v1',
          evidence: 'UNVERIFIED: functional only; timings are diagnostic, not performance evidence',
          results,
        },
        null,
        2,
      ),
    );
    expect(results.map((result) => [result.id, result.outcome])).toEqual(
      CASES.map((testCase) => [testCase.id, EXPECTED_OUTCOMES[testCase.id]]),
    );
  });
});

/**
 * Observed at the first run, 2026-10-21 (stroke-v0+r3), unchanged at +r4 (2026-10-22). Every case whose ports return both
 * meshes builds, including curve-flattened round joins drawn fringed and region-only; the
 * failures are the ports' own (stroke work-limit on the cubic blob, the open ST-U9 decision;
 * fill unsupported-geometry on the open curves), so no overlay is attempted for them.
 *
 * Note, 2026-10-23 (E8-U1, docs/plans/p3-rounded-knot-topology-contract.md E8 addendum E8.3):
 * the exact-rung direction hint admits the fill of four of them, which now build (s-curve round
 * and square caps, arch round caps at e = -2, arch butt at e = -1): failure-to-success changes.
 */
const EXPECTED_OUTCOMES: Readonly<Record<string, string>> = {
  'blob-round-join': 'port-failure',
  'blob-miter': 'port-failure',
  's-curve-round-caps': 'built',
  's-curve-square-caps': 'built',
  'd-shape-round-join-e-2': 'built',
  'd-shape-round-join-e-3': 'built',
  'd-shape-round-join-e-1': 'built',
  'd-shape-miter-e-1': 'built',
  'arch-round-caps-e-2': 'built',
  'arch-butt-e-1': 'built',
  'blob-round-join-e-1': 'port-failure',
  'pentagon-round-join': 'built',
  'pentagon-bevel': 'built',
};
