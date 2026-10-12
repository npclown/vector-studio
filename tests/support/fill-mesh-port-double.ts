import type {
  FillMesh,
  FillMeshBatchResult,
  FillMeshFailureCode,
  FillMeshPort,
  FillMeshRequest,
  FillMeshResult,
} from '@vector-studio/contracts';
import {
  FILL_CONFORMANCE_PATHS,
  type FillConformancePathName,
  type FillFixturePath,
  type FillMeshPortHarness,
} from './fill-mesh-port-conformance.js';

// Test double of the fill-mesh port (P3 V2 contract, section j). It serves
// hand-written meshes from a fixed table keyed by path content and returns a
// configured failure code for marked inputs. It never computes geometry.

type Rule = 'nonzero' | 'evenodd';

type HandMesh = Readonly<{
  positions: readonly number[];
  indices: readonly number[];
  boundaryEdges: readonly number[];
}>;

type Outcome =
  | Readonly<{ status: 'ok'; mesh: HandMesh }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'failed'; code: FillMeshFailureCode }>;

// [0,10]^2, counter-clockwise.
const SQUARE: HandMesh = {
  positions: [0, 0, 10, 0, 10, 10, 0, 10],
  indices: [0, 1, 2, 0, 2, 3],
  boundaryEdges: [0, 1, 1, 2, 2, 3, 3, 0],
};

// [0,10]^2 minus the hole [3,7]^2 (F02 evenodd, F03).
const RING: HandMesh = {
  positions: [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 7, 3, 7, 7, 3, 7],
  indices: [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  boundaryEdges: [0, 1, 1, 2, 2, 3, 3, 0, 5, 4, 6, 5, 7, 6, 4, 7],
};

// F06: two triangles that meet at the crossing (2,2).
const BOWTIE: HandMesh = {
  positions: [0, 0, 4, 0, 2, 2, 4, 4, 0, 4],
  indices: [0, 1, 2, 2, 3, 4],
  boundaryEdges: [0, 1, 1, 2, 2, 0, 2, 3, 3, 4, 4, 2],
};

function rectangle(x0: number, y0: number, x1: number, y1: number, base = 0): HandMesh {
  return {
    positions: [x0, y0, x1, y0, x1, y1, x0, y1],
    indices: [0, 1, 2, 0, 2, 3].map((index) => index + base),
    boundaryEdges: [0, 1, 1, 2, 2, 3, 3, 0].map((index) => index + base),
  };
}

function join(left: HandMesh, right: HandMesh): HandMesh {
  const offset = left.positions.length / 2;
  return {
    positions: [...left.positions, ...right.positions],
    indices: [...left.indices, ...right.indices.map((index) => index + offset)],
    boundaryEdges: [...left.boundaryEdges, ...right.boundaryEdges.map((index) => index + offset)],
  };
}

// F10 evenodd and F10 reversed: [0,2]x[0,4] and [4,6]x[0,4].
const TWO_RECTANGLES = join(rectangle(0, 0, 2, 4), rectangle(4, 0, 6, 4));

// F11: [0,4]^2 and [2,6]x[4,8], conforming at (2,4) and (4,4).
const F11: HandMesh = {
  positions: [0, 0, 4, 0, 4, 4, 2, 4, 0, 4, 6, 4, 6, 8, 2, 8],
  indices: [0, 1, 2, 0, 2, 3, 0, 3, 4, 3, 2, 7, 2, 5, 6, 2, 6, 7],
  boundaryEdges: [0, 1, 1, 2, 3, 4, 4, 0, 7, 3, 2, 5, 5, 6, 6, 7],
};

// H1: [0,4]^2 and [4,8]x[1,3]; (4,1)-(4,3) is interior.
const H1: HandMesh = {
  positions: [0, 0, 4, 0, 4, 1, 4, 3, 4, 4, 0, 4, 8, 1, 8, 3],
  indices: [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 2, 6, 7, 2, 7, 3],
  boundaryEdges: [0, 1, 1, 2, 3, 4, 4, 5, 5, 0, 2, 6, 6, 7, 7, 3],
};

// H2: [0,10]^2 and [-5,0]x[0,5]; the boundary (0,10)-(0,5) ends at (0,5).
const H2: HandMesh = {
  positions: [0, 0, 10, 0, 10, 10, 0, 10, 0, 5, -5, 0, -5, 5],
  indices: [1, 2, 3, 1, 3, 4, 1, 4, 0, 5, 0, 4, 5, 4, 6],
  boundaryEdges: [1, 2, 2, 3, 3, 4, 0, 1, 5, 0, 4, 6, 6, 5],
};

const ok = (mesh: HandMesh): Outcome => ({ status: 'ok', mesh });
const EMPTY: Outcome = { status: 'empty' };
const failed = (code: FillMeshFailureCode): Outcome => ({ status: 'failed', code });

type TableRow = readonly [FillConformancePathName, Outcome | Readonly<Record<Rule, Outcome>>];

const TABLE_ROWS: readonly TableRow[] = [
  ['square', ok(SQUARE)],
  ['moveOnly', EMPTY],
  ['grammarError', failed('invalid-path')],
  ['oddPointCount', failed('invalid-path')],
  ['unknownVerb', failed('invalid-path')],
  ['nanCoordinate', failed('invalid-path')],
  ['longLines', failed('work-limit')],
  ['fineCubic', failed('numeric-range')],
  ['f01', ok(SQUARE)],
  ['f02', { nonzero: ok(SQUARE), evenodd: ok(RING) }],
  ['f03', ok(RING)],
  ['f04', { nonzero: ok(SQUARE), evenodd: EMPTY }],
  ['f05', EMPTY],
  ['f06', ok(BOWTIE)],
  ['f07', ok(rectangle(0, 0, 4, 2))],
  ['f10', { nonzero: ok(rectangle(0, 0, 6, 4)), evenodd: ok(TWO_RECTANGLES) }],
  ['f10Reversed', ok(TWO_RECTANGLES)],
  ['f11', ok(F11)],
  ['h1', ok(H1)],
  ['h2', ok(H2)],
];

function contentKey(verbs: ArrayLike<number>, points: ArrayLike<number>, rule: Rule): string {
  return `${rule}|${Array.from(verbs).join(',')}|${Array.from(points, String).join(',')}`;
}

function fixtureKey(fixture: FillFixturePath, rule: Rule): string {
  return contentKey(fixture.verbs, fixture.points, rule);
}

const TABLE = new Map<string, Outcome>();
for (const [name, outcome] of TABLE_ROWS) {
  for (const rule of ['nonzero', 'evenodd'] as const) {
    const resolved = 'status' in outcome ? outcome : outcome[rule];
    TABLE.set(fixtureKey(FILL_CONFORMANCE_PATHS[name], rule), resolved);
  }
}

function copyMesh(mesh: HandMesh): FillMesh {
  const positions = Float64Array.from(mesh.positions);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let scalar = 0; scalar < positions.length; scalar += 2) {
    minX = Math.min(minX, positions[scalar]!);
    minY = Math.min(minY, positions[scalar + 1]!);
    maxX = Math.max(maxX, positions[scalar]!);
    maxY = Math.max(maxY, positions[scalar + 1]!);
  }
  return {
    positions,
    indices: Uint32Array.from(mesh.indices),
    boundaryEdges: Uint32Array.from(mesh.boundaryEdges),
    bounds: { minX, minY, maxX, maxY },
  };
}

function isValidBatch(requests: readonly FillMeshRequest[]): boolean {
  if (!Array.isArray(requests)) return false;
  const seen = new Set<number>();
  for (let index = 0; index < requests.length; index += 1) {
    if (!(index in requests)) return false;
    const value: unknown = requests[index];
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    const requestId = candidate.requestId;
    if (
      typeof requestId !== 'number' ||
      !Number.isInteger(requestId) ||
      requestId < 0 ||
      requestId > 0xffff_ffff ||
      seen.has(requestId)
    ) {
      return false;
    }
    seen.add(requestId);
    if (!(candidate.verbs instanceof Uint8Array)) return false;
    if (!(candidate.points instanceof Float64Array)) return false;
    if (candidate.fillRule !== 'nonzero' && candidate.fillRule !== 'evenodd') return false;
    const exponent = candidate.toleranceExponent;
    if (typeof exponent !== 'number' || !Number.isInteger(exponent)) return false;
  }
  return true;
}

export class FillMeshPortDouble implements FillMeshPort {
  readonly portVersion = 0 as const;
  readonly operationId = 'test/fill-mesh-double';
  private disposed = false;

  dispose(): void {
    this.disposed = true;
  }

  buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult {
    if (this.disposed) return { status: 'batch-failed', code: 'disposed' };
    try {
      if (!isValidBatch(requests)) return { status: 'batch-failed', code: 'invalid-request' };
    } catch {
      return { status: 'batch-failed', code: 'invalid-request' };
    }
    return { status: 'ok', results: requests.map((request) => this.result(request)) };
  }

  private result(request: FillMeshRequest): FillMeshResult {
    const echo = { requestId: request.requestId, toleranceExponent: request.toleranceExponent };
    const outcome = TABLE.get(contentKey(request.verbs, request.points, request.fillRule));
    if (outcome?.status === 'failed' && outcome.code === 'invalid-path') {
      return { ...echo, status: 'failed', code: 'invalid-path' };
    }
    if (request.toleranceExponent < -1021 || request.toleranceExponent > 1023) {
      return { ...echo, status: 'failed', code: 'invalid-tolerance' };
    }
    if (request.verbs.length === 0) return { ...echo, status: 'empty' };
    if (outcome === undefined) {
      throw new Error('the fill-mesh double has no fixture for this path content');
    }
    if (outcome.status === 'ok') return { ...echo, status: 'ok', mesh: copyMesh(outcome.mesh) };
    if (outcome.status === 'empty') return { ...echo, status: 'empty' };
    return { ...echo, status: 'failed', code: outcome.code };
  }
}

export function createFillMeshPortDouble(): FillMeshPortHarness {
  const port = new FillMeshPortDouble();
  return { port, dispose: () => port.dispose() };
}
