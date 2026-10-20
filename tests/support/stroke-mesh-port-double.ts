import type {
  StrokeMesh,
  StrokeMeshBatchResult,
  StrokeMeshFailureCode,
  StrokeMeshPort,
  StrokeMeshRequest,
  StrokeMeshResult,
} from '@vector-studio/contracts';
import {
  DEFAULT_STROKE_STYLE,
  STROKE_CAPS,
  STROKE_CONFORMANCE_PATHS,
  STROKE_JOINS,
  type StrokeConformancePathName,
  type StrokeFixtureStyle,
  type StrokeMeshPortHarness,
} from './stroke-mesh-port-conformance.js';

// Test double of the stroke-mesh port (B2 stroke contract, section 11.4). It serves
// hand-built meshes from a fixed table keyed by path content and stroke values, applies the
// stage order of section 7.8 to the values it can decide without geometry, and returns a
// configured failure code for marked inputs. It never strokes a path: every mesh below is a
// union of unit grid cells plus, for round pieces, fans of the 16-gon, written by hand.

type HandMesh = Readonly<{
  positions: readonly number[];
  indices: readonly number[];
  boundaryEdges: readonly number[];
}>;

type Outcome =
  | Readonly<{ status: 'ok'; mesh: HandMesh }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'failed'; code: StrokeMeshFailureCode }>;

type Cell = readonly [x: number, y: number];
type Fan = Readonly<{ center: Cell; from: number; to: number }>;

/** Unit direction at `k·π/8`, exact at multiples of a quarter turn. */
function direction(k: number): Cell {
  const quarter = ((k % 16) + 16) % 16;
  if (quarter === 0) return [1, 0];
  if (quarter === 4) return [0, 1];
  if (quarter === 8) return [-1, 0];
  if (quarter === 12) return [0, -1];
  return [Math.cos((k * Math.PI) / 8), Math.sin((k * Math.PI) / 8)];
}

/**
 * A conforming mesh from unit cells `[x, x+1]×[y, y+1]`, extra counter-clockwise triangles
 * and unit-radius fans; shared points are shared vertices, and `boundaryEdges` are the edges
 * used by exactly one triangle.
 */
function gridMesh(
  cells: readonly Cell[],
  triangles: readonly (readonly [Cell, Cell, Cell])[] = [],
  fans: readonly Fan[] = [],
): HandMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertices = new Map<string, number>();
  const vertex = ([x, y]: Cell): number => {
    const key = `${String(x)},${String(y)}`;
    let index = vertices.get(key);
    if (index === undefined) {
      index = positions.length / 2;
      vertices.set(key, index);
      positions.push(x, y);
    }
    return index;
  };
  for (const [x, y] of cells) {
    const corners = [
      vertex([x, y]),
      vertex([x + 1, y]),
      vertex([x + 1, y + 1]),
      vertex([x, y + 1]),
    ];
    indices.push(corners[0]!, corners[1]!, corners[2]!, corners[0]!, corners[2]!, corners[3]!);
  }
  for (const [a, b, c] of triangles) indices.push(vertex(a), vertex(b), vertex(c));
  for (const { center, from, to } of fans) {
    for (let k = from; k < to; k += 1) {
      const [ax, ay] = direction(k);
      const [bx, by] = direction(k + 1);
      indices.push(
        vertex(center),
        vertex([center[0] + ax, center[1] + ay]),
        vertex([center[0] + bx, center[1] + by]),
      );
    }
  }
  const uses = new Map<string, number>();
  const key = (a: number, b: number): string =>
    `${String(Math.min(a, b))}-${String(Math.max(a, b))}`;
  for (let slot = 0; slot < indices.length; slot += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const edge = key(indices[slot + corner]!, indices[slot + ((corner + 1) % 3)]!);
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  }
  const boundaryEdges: number[] = [];
  for (let slot = 0; slot < indices.length; slot += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const a = indices[slot + corner]!;
      const b = indices[slot + ((corner + 1) % 3)]!;
      if (uses.get(key(a, b)) === 1) boundaryEdges.push(a, b);
    }
  }
  return { positions, indices, boundaryEdges };
}

function cellRange(x0: number, y0: number, x1: number, y1: number): Cell[] {
  const cells: Cell[] = [];
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) cells.push([x, y]);
  return cells;
}

function union(...parts: readonly Cell[][]): Cell[] {
  const seen = new Set<string>();
  const cells: Cell[] = [];
  for (const cell of parts.flat()) {
    const key = cell.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      cells.push(cell);
    }
  }
  return cells;
}

const without = (cells: readonly Cell[], removed: Cell): Cell[] =>
  cells.filter(([x, y]) => x !== removed[0] || y !== removed[1]);

// ST-F1: [0,4]×[−1,1]. ST-F2: [−1,5]×[−1,1]. ST-F3: ST-F1 with half 16-gons at both ends.
const F1_CELLS = cellRange(0, -1, 4, 1);
const F1 = gridMesh(F1_CELLS);
const F2 = gridMesh(cellRange(-1, -1, 5, 1));
const F3 = gridMesh(
  F1_CELLS,
  [],
  [
    { center: [0, 0], from: 4, to: 12 },
    { center: [4, 0], from: -4, to: 4 },
  ],
);
// ST-F4: [0,4]×[−1,1] ∪ [3,5]×[0,4], plus the join at (4,0).
const F4_BASE = union(cellRange(0, -1, 4, 1), cellRange(3, 0, 5, 4));
const F4_MITER = gridMesh(union(F4_BASE, [[4, -1]]));
const F4_BEVEL = gridMesh(F4_BASE, [
  [
    [4, -1],
    [5, 0],
    [4, 0],
  ],
]);
const F4_ROUND = gridMesh(F4_BASE, [], [{ center: [4, 0], from: -4, to: 0 }]);
// ST-F8 square: [3,5]×[4,6].
const F8_SQUARE = gridMesh(cellRange(3, 4, 5, 6));
// ST-F11 miter: [−1,5]² ∖ (1,3)².
const F11_MITER = gridMesh(F11_MITER_CELLS());
// ST-F14 (a): [0,4]×[1,3] ∪ [1,3]×[0,4].
const F14A = gridMesh(union(cellRange(0, 1, 4, 3), cellRange(1, 0, 3, 4)));
// ST-F14 (b): four sweeps and three unit miter squares, area 20.
const F14B = gridMesh(
  union(
    cellRange(0, 1, 4, 3),
    cellRange(3, 2, 5, 4),
    cellRange(2, 3, 4, 5),
    cellRange(1, 0, 3, 4),
    [
      [4, 1],
      [4, 4],
      [1, 4],
    ],
  ),
);
// The reversal ST-F6 under miter or bevel adds nothing: ST-F1's region.
const F6 = F1;

const ok = (mesh: HandMesh): Outcome => ({ status: 'ok', mesh });
const EMPTY: Outcome = { status: 'empty' };
const failed = (code: StrokeMeshFailureCode): Outcome => ({ status: 'failed', code });

type TableRow = readonly [StrokeConformancePathName, Partial<StrokeFixtureStyle>, Outcome];

const TABLE_ROWS: TableRow[] = [
  ['stF1', {}, ok(F1)],
  ['stF1', { cap: 'square' }, ok(F2)],
  ['stF1', { cap: 'round' }, ok(F3)],
  ['stF4', {}, ok(F4_MITER)],
  ['stF4', { miterLimit: 2 }, ok(F4_MITER)],
  ['stF4', { miterLimit: 1 }, ok(F4_BEVEL)],
  ['stF4', { join: 'bevel' }, ok(F4_BEVEL)],
  ['stF4', { join: 'round' }, ok(F4_ROUND)],
  ['stF6', {}, ok(F6)],
  ['stF8', {}, EMPTY],
  ['stF8', { cap: 'square' }, ok(F8_SQUARE)],
  ['stF11', { miterLimit: 2 }, ok(F11_MITER)],
  ['stF14a', {}, ok(F14A)],
  ['stF14b', { miterLimit: 2 }, ok(F14B)],
  ['longLines', {}, failed('work-limit')],
];
for (const cap of STROKE_CAPS) {
  for (const join of STROKE_JOINS) {
    TABLE_ROWS.push(['stF7', { cap, join }, EMPTY], ['stF9', { cap, join }, EMPTY]);
  }
  TABLE_ROWS.push(['stF23', { cap }, failed('numeric-range')]);
}

// ST-F11 with round caps and round joins serves SC11 and SC13: the ring with a quarter
// 16-gon at each outer corner instead of the miter square, area 28 + 16-gon.
const F11_ROUND = gridMesh(
  without(without(without(without(F11_MITER_CELLS(), [-1, -1]), [4, -1]), [4, 4]), [-1, 4]),
  [],
  [
    { center: [0, 0], from: 8, to: 12 },
    { center: [4, 0], from: 12, to: 16 },
    { center: [4, 4], from: 0, to: 4 },
    { center: [0, 4], from: 4, to: 8 },
  ],
);
TABLE_ROWS.push(
  ['stF11', { join: 'round' }, ok(F11_ROUND)],
  ['stF11', { join: 'round', cap: 'round' }, ok(F11_ROUND)],
);

function F11_MITER_CELLS(): Cell[] {
  return without(
    without(without(without(cellRange(-1, -1, 5, 5), [1, 1]), [2, 1]), [1, 2]),
    [2, 2],
  );
}

/** Paths whose grammar or values make them invalid-path whatever the style. */
const INVALID_PATHS: readonly StrokeConformancePathName[] = [
  'grammarError',
  'oddPointCount',
  'unknownVerb',
  'nanCoordinate',
];

function contentKey(
  verbs: ArrayLike<number>,
  points: ArrayLike<number>,
  values: StrokeFixtureStyle,
): string {
  return [
    values.width,
    values.cap,
    values.join,
    values.miterLimit,
    Array.from(verbs).join(','),
    Array.from(points, String).join(','),
  ].join('|');
}

const TABLE = new Map<string, Outcome>();
for (const [name, overrides, outcome] of TABLE_ROWS) {
  const fixture = STROKE_CONFORMANCE_PATHS[name];
  TABLE.set(
    contentKey(fixture.verbs, fixture.points, { ...DEFAULT_STROKE_STYLE, ...overrides }),
    outcome,
  );
}
const INVALID_CONTENT = new Set(
  INVALID_PATHS.map((name) => {
    const fixture = STROKE_CONFORMANCE_PATHS[name];
    return `${Array.from(fixture.verbs).join(',')}|${Array.from(fixture.points, String).join(',')}`;
  }),
);

function copyMesh(mesh: HandMesh): StrokeMesh {
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

function isValidBatch(requests: readonly StrokeMeshRequest[]): boolean {
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
    if (typeof candidate.width !== 'number') return false;
    if (candidate.cap !== 'butt' && candidate.cap !== 'round' && candidate.cap !== 'square') {
      return false;
    }
    if (candidate.join !== 'miter' && candidate.join !== 'round' && candidate.join !== 'bevel') {
      return false;
    }
    if (typeof candidate.miterLimit !== 'number') return false;
    const exponent = candidate.toleranceExponent;
    if (typeof exponent !== 'number' || !Number.isInteger(exponent)) return false;
  }
  return true;
}

export class StrokeMeshPortDouble implements StrokeMeshPort {
  readonly portVersion = 0 as const;
  readonly operationId = 'test/stroke-mesh-double';
  private disposed = false;

  dispose(): void {
    this.disposed = true;
  }

  buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult {
    if (this.disposed) return { status: 'batch-failed', code: 'disposed' };
    try {
      if (!isValidBatch(requests)) return { status: 'batch-failed', code: 'invalid-request' };
    } catch {
      return { status: 'batch-failed', code: 'invalid-request' };
    }
    return { status: 'ok', results: requests.map((request) => this.result(request)) };
  }

  /** Section 7.8's stages 1 to 4, then the table. */
  private result(request: StrokeMeshRequest): StrokeMeshResult {
    const echo = { requestId: request.requestId, toleranceExponent: request.toleranceExponent };
    const content = `${Array.from(request.verbs).join(',')}|${Array.from(request.points, String).join(',')}`;
    if (INVALID_CONTENT.has(content)) return { ...echo, status: 'failed', code: 'invalid-path' };
    const width = request.width;
    const limit = request.miterLimit;
    if (!Number.isFinite(width) || width < 0 || !Number.isFinite(limit) || limit < 1) {
      return { ...echo, status: 'failed', code: 'invalid-stroke' };
    }
    if (request.toleranceExponent < -1020 || request.toleranceExponent > 1023) {
      return { ...echo, status: 'failed', code: 'invalid-tolerance' };
    }
    if (request.verbs.length === 0 || width === 0) return { ...echo, status: 'empty' };
    const outcome = TABLE.get(contentKey(request.verbs, request.points, request));
    if (outcome === undefined) {
      throw new Error('the stroke-mesh double has no fixture for this path content');
    }
    if (outcome.status === 'ok') return { ...echo, status: 'ok', mesh: copyMesh(outcome.mesh) };
    if (outcome.status === 'empty') return { ...echo, status: 'empty' };
    return { ...echo, status: 'failed', code: outcome.code };
  }
}

export function createStrokeMeshPortDouble(): StrokeMeshPortHarness {
  const port = new StrokeMeshPortDouble();
  return { port, dispose: () => port.dispose() };
}
