// D9 E11 unit E11-U2: the A01 sweep (docs/plans/d9-e11-p3-c03-c05-closure-contract.md, sections 7
// and 8). It sends fill and stroke requests through the real ports in batches, checks every `ok`
// mesh with the independent structure checker, checks the echoes, and re-runs every request
// alone to show that its outcome does not depend on its batch (deterministic failure isolation).

import { createHash } from 'node:crypto';

import type {
  FillMesh,
  FillMeshPort,
  FillMeshRequest,
  StrokeMeshPort,
  StrokeMeshRequest,
} from '../../../packages/contracts/src/geometry.js';
import { checkMeshStructure, type StructureIssue } from './structure.js';

export type SweepItem =
  | Readonly<{ id: string; kind: 'fill'; request: Omit<FillMeshRequest, 'requestId'> }>
  | Readonly<{ id: string; kind: 'stroke'; request: Omit<StrokeMeshRequest, 'requestId'> }>;

export type SweepPorts = Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>;

/** One request's outcome: `ok:<mesh sha256>`, `empty`, `failed:<code>` or `batch-failed:<code>`. */
type Outcome = string;

type KindTotals = {
  requests: number;
  outcomes: Record<string, number>;
  issues: Partial<Record<StructureIssue, number>>;
  oracleChecked: number;
  duplicatePositions: number;
  maxTriangles: number;
  maxVertices: number;
  triangles: number;
};

export type SweepResult = Readonly<{
  batchSize: number;
  fill: KindTotals;
  stroke: KindTotals;
  /** Requests whose mesh broke a structure rule, with their issues (all of them). */
  structureFailures: readonly Readonly<{ id: string; issues: readonly StructureIssue[] }>[];
  /** Results whose requestId or toleranceExponent echo was wrong, or that were missing. */
  echoFailures: readonly string[];
  /** Requests whose outcome alone differs from their outcome in the batch. */
  isolationFailures: readonly Readonly<{ id: string; batch: Outcome; alone: Outcome }>[];
  /** The non-ok outcomes, by id, for the known-defect classification of E11 section 7.2. */
  rejected: readonly Readonly<{ id: string; outcome: Outcome }>[];
  /** sha256 over every id and outcome in order: equal across runs when the kernel is. */
  outcomeDigest: string;
  wallMilliseconds: number;
}>;

function meshDigest(mesh: FillMesh): string {
  const h = createHash('sha256');
  for (const array of [mesh.positions, mesh.indices, mesh.boundaryEdges])
    h.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  h.update(JSON.stringify(mesh.bounds));
  return h.digest('hex');
}

function totals(): KindTotals {
  return {
    requests: 0,
    outcomes: {},
    issues: {},
    oracleChecked: 0,
    duplicatePositions: 0,
    maxTriangles: 0,
    maxVertices: 0,
    triangles: 0,
  };
}

type Built = Readonly<{
  outcome: Outcome;
  mesh: FillMesh | null;
  echoOk: boolean;
}>;

/** Runs one batch of a single kind and maps each item to its outcome. */
function runBatch(ports: SweepPorts, items: readonly SweepItem[]): Built[] {
  const kind = items[0]!.kind;
  const requests = items.map((item, i) => ({ ...item.request, requestId: i }));
  const result =
    kind === 'fill'
      ? ports.fill.buildFillMeshes(requests as FillMeshRequest[])
      : ports.stroke.buildStrokeMeshes(requests as StrokeMeshRequest[]);
  if (result.status === 'batch-failed')
    return items.map(() => ({ outcome: `batch-failed:${result.code}`, mesh: null, echoOk: true }));
  return items.map((item, i) => {
    const r = result.results[i];
    if (r === undefined) return { outcome: 'missing', mesh: null, echoOk: false };
    const echoOk = r.requestId === i && r.toleranceExponent === item.request.toleranceExponent;
    if (r.status === 'ok') return { outcome: `ok:${meshDigest(r.mesh)}`, mesh: r.mesh, echoOk };
    if (r.status === 'empty') return { outcome: 'empty', mesh: null, echoOk };
    return { outcome: `failed:${r.code}`, mesh: null, echoOk };
  });
}

export function runSweep(
  ports: SweepPorts,
  items: readonly SweepItem[],
  options: Readonly<{ batchSize?: number; isolation?: boolean }> = {},
): SweepResult {
  const started = Date.now();
  const batchSize = options.batchSize ?? 32;
  const isolation = options.isolation ?? true;
  const byKind = { fill: totals(), stroke: totals() };
  const structureFailures: { id: string; issues: StructureIssue[] }[] = [];
  const echoFailures: string[] = [];
  const isolationFailures: { id: string; batch: Outcome; alone: Outcome }[] = [];
  const rejected: { id: string; outcome: Outcome }[] = [];
  const digest = createHash('sha256');

  // Batches never mix kinds; consecutive items of one kind form a batch.
  let i = 0;
  while (i < items.length) {
    const kind = items[i]!.kind;
    const batch: SweepItem[] = [];
    while (i < items.length && items[i]!.kind === kind && batch.length < batchSize)
      batch.push(items[i++]!);
    const built = runBatch(ports, batch);
    batch.forEach((item, k) => {
      const b = built[k]!;
      const t = byKind[item.kind];
      t.requests += 1;
      const head = b.outcome.startsWith('ok:') ? 'ok' : b.outcome;
      t.outcomes[head] = (t.outcomes[head] ?? 0) + 1;
      digest.update(`${item.id}\u0000${b.outcome}\n`);
      if (!b.echoOk) echoFailures.push(item.id);
      if (b.mesh !== null) {
        const report = checkMeshStructure(b.mesh);
        t.triangles += report.triangles;
        t.maxTriangles = Math.max(t.maxTriangles, report.triangles);
        t.maxVertices = Math.max(t.maxVertices, report.vertices);
        t.duplicatePositions += report.duplicatePositions;
        if (report.oracleChecked) t.oracleChecked += 1;
        for (const issue of report.issues) t.issues[issue] = (t.issues[issue] ?? 0) + 1;
        if (report.issues.length > 0)
          structureFailures.push({ id: item.id, issues: [...report.issues] });
      } else {
        rejected.push({ id: item.id, outcome: b.outcome });
      }
      if (isolation && batch.length > 1) {
        const alone = runBatch(ports, [item])[0]!;
        if (alone.outcome !== b.outcome)
          isolationFailures.push({ id: item.id, batch: b.outcome, alone: alone.outcome });
      }
    });
  }
  return Object.freeze({
    batchSize,
    fill: byKind.fill,
    stroke: byKind.stroke,
    structureFailures,
    echoFailures,
    isolationFailures,
    rejected,
    outcomeDigest: digest.digest('hex'),
    wallMilliseconds: Date.now() - started,
  });
}

// --- seeded controls ----------------------------------------------------------------------------

export type ControlResult = Readonly<{ id: string; expected: StructureIssue; caught: boolean }>;

const copy = (mesh: FillMesh, patch: Partial<FillMesh>): FillMesh => ({
  positions: new Float64Array(mesh.positions),
  indices: new Uint32Array(mesh.indices),
  boundaryEdges: new Uint32Array(mesh.boundaryEdges),
  bounds: { ...mesh.bounds },
  ...patch,
});

/**
 * Corrupts a valid mesh in the ways A01 must catch and checks that the checker names each one.
 * The mesh must pass the checker unmodified and have at least two triangles.
 */
export function runSeededControls(mesh: FillMesh): readonly ControlResult[] {
  if (checkMeshStructure(mesh).issues.length > 0)
    throw new Error('seeded controls need a valid base mesh');
  if (mesh.indices.length < 6) throw new Error('seeded controls need two triangles');
  const vertices = mesh.positions.length / 2;
  const cases: [string, StructureIssue, FillMesh][] = [];

  const outOfRange = new Uint32Array(mesh.indices);
  outOfRange[1] = vertices;
  cases.push(['index-out-of-range', 'INDEX_RANGE', copy(mesh, { indices: outOfRange })]);

  const nan = new Float64Array(mesh.positions);
  nan[0] = Number.NaN;
  cases.push(['nan-vertex', 'NON_FINITE_VERTEX', copy(mesh, { positions: nan })]);

  cases.push([
    'bounds-underreported',
    'BOUNDS_NOT_EXACT',
    copy(mesh, { bounds: { ...mesh.bounds, maxX: mesh.bounds.minX } }),
  ]);

  const flipped = new Uint32Array(mesh.indices);
  [flipped[1], flipped[2]] = [flipped[2]!, flipped[1]!];
  cases.push(['flipped-triangle', 'NONPOSITIVE_TRIANGLE', copy(mesh, { indices: flipped })]);

  cases.push([
    'missing-triangle',
    'BOUNDARY_MISMATCH',
    copy(mesh, { indices: new Uint32Array(mesh.indices.subarray(3)) }),
  ]);

  const duplicated = new Uint32Array(mesh.indices.length + 3);
  duplicated.set(mesh.indices);
  duplicated.set(mesh.indices.subarray(0, 3), mesh.indices.length);
  cases.push([
    'duplicated-triangle',
    'DUPLICATE_DIRECTED_EDGE',
    copy(mesh, { indices: duplicated }),
  ]);

  cases.push([
    'truncated-indices',
    'INDEX_COUNT',
    copy(mesh, { indices: new Uint32Array(mesh.indices.subarray(1)) }),
  ]);

  const boundary = new Uint32Array(mesh.boundaryEdges);
  if (boundary.length >= 2) [boundary[0], boundary[1]] = [boundary[1]!, boundary[0]!];
  cases.push([
    'reversed-boundary-edge',
    'BOUNDARY_MISMATCH',
    copy(mesh, { boundaryEdges: boundary }),
  ]);

  return cases.map(([id, expected, corrupted]) => ({
    id,
    expected,
    caught: checkMeshStructure(corrupted).issues.includes(expected),
  }));
}
