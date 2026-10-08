// P3 B0 feasibility corpus, frozen by docs/plans/p3-b0-feasibility-benchmark-contract.md
// section 2. This module uses only erasable TypeScript so that the Node runner can load it
// directly; it imports nothing at runtime.

export const SCENARIO_ID = 'p3-b0-feasibility';
export const SCENARIO_VERSION = 1;
export const CORPUS_MAGIC = 'P3B0COR1';

export const VERB_MOVE = 0;
export const VERB_CUBIC = 2;
export const VERB_CLOSE = 3;

const EDGE = 8;
const GRID = 1024;
const TAU = 2 * Math.PI;
const CELL_SEED = 0x12345678;

export type Family = 'ring' | 'star';
export type Role = 'decision' | 'o1' | 'o2';
export type Entry = 'attempt' | 'attempt_transverse';

export interface CellSpec {
  readonly id: string;
  readonly series: string;
  readonly role: Role;
  readonly family: Family;
  readonly entry: Entry;
  readonly contours: number;
  readonly cubicsPerContour: number;
  /** Expected leaves per cubic; 1 for the straight star. */
  readonly lambda: number;
  /** Bulge as a fraction of the edge length. */
  readonly bulge: number;
  readonly snapped: boolean;
  readonly paths: number;
}

export interface CorpusPath {
  readonly verbs: readonly number[];
  readonly points: readonly number[];
}

/** Failure codes classified CAP-BOUND (contract section 2); anything else is NOT-ADMITTED. */
export const CAP_CODES = Object.freeze([
  'SourceLimit',
  'CommandLimit',
  'PointLimit',
  'OwnerLimit',
  'ContourLimit',
  'CombinedByteLimit',
  'Rounded(WorkLimit)',
  'Rounded(OutputLimit)',
  'Topology(WorkLimit)',
  'EmissionStatus(5)',
  'NO_MESH(flat_status=5)',
] as const);

export const BULGE_BY_LAMBDA: Readonly<Record<number, number>> = Object.freeze({
  2: 3 / 64,
  4: 3 / 16,
  8: 3 / 8,
});

const SERIES = [
  { series: 'P2', contours: 1, lambda: 2, s: [3, 4, 5, 6, 7, 8, 10, 12, 14, 16] },
  { series: 'P4', contours: 1, lambda: 4, s: [3, 4, 5, 6, 7, 8, 10, 12, 14, 16] },
  { series: 'P8', contours: 1, lambda: 8, s: [3, 4, 5, 6, 7, 8] },
  { series: 'K2', contours: 2, lambda: 4, s: [3, 4, 5, 6, 7, 8] },
  { series: 'K4', contours: 4, lambda: 4, s: [3, 4] },
] as const;
export const PRIMARY_SERIES = ['P2', 'P4', 'P8'] as const;
export const STAR_SIDES = [5, 7, 9, 11, 13, 15] as const;
export const LINEARITY_CELL = 'P4/s=16';
export const DECISION_PATHS = 10;
export const LINEARITY_PATHS = 100;
export const O1_PATHS = 30;
export const O2_PATHS = 10;

/** Every corpus cell in its fixed corpus order. */
export function corpusCells(): CellSpec[] {
  const cells: CellSpec[] = [];
  for (const entry of SERIES) {
    for (const s of entry.s) {
      const id = `${entry.series}/s=${s}`;
      cells.push({
        id,
        series: entry.series,
        role: 'decision',
        family: 'ring',
        entry: 'attempt',
        contours: entry.contours,
        cubicsPerContour: s,
        lambda: entry.lambda,
        bulge: BULGE_BY_LAMBDA[entry.lambda]!,
        snapped: true,
        paths: id === LINEARITY_CELL ? LINEARITY_PATHS : DECISION_PATHS,
      });
    }
  }
  for (const entry of SERIES.filter(({ series }) => series.startsWith('P'))) {
    for (const s of entry.s) {
      cells.push({
        id: `O1/${entry.series}/s=${s}`,
        series: `O1/${entry.series}`,
        role: 'o1',
        family: 'ring',
        entry: 'attempt',
        contours: entry.contours,
        cubicsPerContour: s,
        lambda: entry.lambda,
        bulge: BULGE_BY_LAMBDA[entry.lambda]!,
        snapped: false,
        paths: O1_PATHS,
      });
    }
  }
  for (const s of STAR_SIDES) {
    cells.push({
      id: `X/s=${s}`,
      series: 'X',
      role: 'o2',
      family: 'star',
      entry: 'attempt_transverse',
      contours: 1,
      cubicsPerContour: s,
      lambda: 1,
      bulge: 0,
      snapped: true,
      paths: O2_PATHS,
    });
  }
  return cells;
}

/** xorshift32 with shifts 13, 17, 5; u = state / 2^32 drawn after each update. */
export class Xorshift32 {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    let x = this.state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.state = x;
    return x / 2 ** 32;
  }
}

/** Round to the nearest multiple of 2^-10, ties to even, keeping the sign of zero. */
export function snap(value: number): number {
  const scaled = value * GRID;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  let rounded: number;
  if (fraction > 0.5) rounded = floor + 1;
  else if (fraction < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  // IEEE roundTiesEven keeps the sign of zero, as Rust's f64::round_ties_even does.
  if (rounded === 0 && (scaled < 0 || Object.is(scaled, -0))) return -0;
  return rounded / GRID;
}

type Point = readonly [number, number];
type Cubic = readonly [Point, Point, Point, Point];

function edgeCubic(start: Point, end: Point, bulge: number): Cubic {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.sqrt(dx * dx + dy * dy);
  const nx = dy / length;
  const ny = -dx / length;
  const offset = bulge * EDGE;
  return [
    start,
    [start[0] + dx / 3 + offset * nx, start[1] + dy / 3 + offset * ny],
    [start[0] + (2 * dx) / 3 + offset * nx, start[1] + (2 * dy) / 3 + offset * ny],
    end,
  ];
}

function contourCubics(cell: CellSpec, k: number, rho: number): Cubic[] {
  const s = cell.cubicsPerContour;
  const r = EDGE / (2 * Math.sin(Math.PI / s));
  const centre = k * (2 * (r + cell.bulge * EDGE) + 4);
  const vertices: Point[] = [];
  for (let i = 0; i < s; i += 1) {
    const phi = (TAU * i) / s + rho;
    vertices.push([centre + r * Math.cos(phi), r * Math.sin(phi)]);
  }
  const step = cell.family === 'star' ? 2 : 1;
  const cubics: Cubic[] = [];
  for (let m = 0; m < s; m += 1) {
    const start = vertices[(m * step) % s]!;
    const end = vertices[((m + 1) * step) % s]!;
    cubics.push(edgeCubic(start, end, cell.bulge));
  }
  return cubics;
}

function emitPoint(points: number[], point: Point, snapped: boolean): void {
  points.push(snapped ? snap(point[0]) : point[0], snapped ? snap(point[1]) : point[1]);
}

/** Generates the first `count` paths of a cell; the RNG resets at the start of each cell. */
export function generateCellPaths(cell: CellSpec, count = cell.paths): CorpusPath[] {
  const random = new Xorshift32(CELL_SEED);
  const paths: CorpusPath[] = [];
  for (let j = 0; j < count; j += 1) {
    const verbs: number[] = [];
    const points: number[] = [];
    for (let k = 0; k < cell.contours; k += 1) {
      const rho = TAU * random.next();
      const cubics = contourCubics(cell, k, rho);
      const ordered =
        k % 2 === 0
          ? cubics
          : cubics
              .slice()
              .reverse()
              .map(([a, b, c, d]): Cubic => [d, c, b, a]);
      verbs.push(VERB_MOVE);
      emitPoint(points, ordered[0]![0], cell.snapped);
      for (const [, c1, c2, end] of ordered) {
        verbs.push(VERB_CUBIC);
        emitPoint(points, c1, cell.snapped);
        emitPoint(points, c2, cell.snapped);
        emitPoint(points, end, cell.snapped);
      }
      verbs.push(VERB_CLOSE);
    }
    paths.push({ verbs, points });
  }
  return paths;
}

/** Little-endian framed corpus that the native harness reads. */
export function encodeCorpus(cells: readonly CellSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const u8 = (value: number) => Uint8Array.of(value);
  const u32 = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
  };
  chunks.push(encoder.encode(CORPUS_MAGIC), u32(cells.length));
  for (const cell of cells) {
    const id = encoder.encode(cell.id);
    chunks.push(u32(id.length), id);
    chunks.push(u8(cell.entry === 'attempt' ? 0 : 1));
    chunks.push(u32(cell.contours), u32(cell.cubicsPerContour), u32(cell.lambda));
    const paths = generateCellPaths(cell);
    chunks.push(u32(paths.length));
    for (const path of paths) {
      chunks.push(u32(path.verbs.length), Uint8Array.from(path.verbs));
      const scalars = new Uint8Array(path.points.length * 8);
      const view = new DataView(scalars.buffer);
      path.points.forEach((value, index) => view.setFloat64(index * 8, value, true));
      chunks.push(u32(path.points.length), scalars);
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Hex of the IEEE-754 bits of each scalar, big-endian digit order. */
export function scalarBits(points: readonly number[]): string[] {
  const view = new DataView(new ArrayBuffer(8));
  return points.map((value) => {
    view.setFloat64(0, value);
    return view.getBigUint64(0).toString(16).padStart(16, '0');
  });
}

export type Profile = 'functional' | 'reference';

export interface Sampling {
  readonly repetitions: number;
  readonly warmup: number;
  readonly timed: number;
  readonly linearityWarmup: number;
  readonly linearityTimed: number;
  readonly diagnostic: {
    readonly warmup: number;
    readonly timed: number;
    readonly replayLoops: number;
    readonly replayCalls: number;
  } | null;
}

export const SAMPLING: Readonly<Record<Profile, Sampling>> = Object.freeze({
  reference: {
    repetitions: 5,
    warmup: 3,
    timed: 20,
    linearityWarmup: 2,
    linearityTimed: 5,
    diagnostic: { warmup: 3, timed: 10, replayLoops: 5, replayCalls: 1_000_000 },
  },
  functional: {
    repetitions: 1,
    warmup: 1,
    timed: 2,
    linearityWarmup: 1,
    linearityTimed: 1,
    diagnostic: null,
  },
});

/** One-sided 0.95 Student-t quantiles by degrees of freedom. */
export const T_QUANTILE_95: Readonly<Record<number, number>> = Object.freeze({
  2: 2.919986,
  3: 2.353363,
  4: 2.131847,
  5: 2.015048,
  6: 1.94318,
  7: 1.894579,
  8: 1.859548,
});

/** The complete configuration of contract sections 2-5; its canonical JSON is hashed. */
export function scenarioConfig(profile: Profile) {
  return {
    scenario: { id: SCENARIO_ID, version: SCENARIO_VERSION },
    profile,
    generator: {
      family: 'p3-b0-ring/v1',
      edge: EDGE,
      grid: GRID,
      cellSeed: CELL_SEED,
      bulgeByLambda: BULGE_BY_LAMBDA,
    },
    kernel: {
      entry: 'CubicFillWorkspace::attempt (Legacy); X uses attempt_transverse',
      flattenTolerance: 0.125,
      topologyTolerance: 0.0625,
      fillRule: 'nonzero',
      limits: 'native_cubic_fill_tests::LIMITS',
    },
    cells: corpusCells(),
    admission: {
      decisionPaths: DECISION_PATHS,
      linearityPaths: LINEARITY_PATHS,
      o1Paths: O1_PATHS,
      o2Paths: O2_PATHS,
      okRule: 'attempt Ok and output() Some with nonempty vertices and indices',
      capCodes: CAP_CODES,
    },
    sampling: SAMPLING[profile],
    checksum:
      'FNV-1a 64 per batch over u32 0, V and T as u32 LE, vertex x and y f64 bits LE, indices u32 LE',
    aggregation: 'nearest rank: ascending samples, index ceil(p * n) - 1',
    fits: {
      model: 'OLS of ln(per-path ns) on ln(L), per repetition and series',
      upperBound: 'yhat + t(0.95, n-2) * se * sqrt(1 + 1/n + (x* - xbar)^2 / Sxx)',
      guard:
        'line through the largest-L point and the point with L nearest half of it (ties: smaller L)',
      estimate: 'exp(max(upper, guard)); maximum over repetitions and primary series',
      editProxy: 'same fit on per-cell p95 of individually timed paths',
      mesh: 'OLS of per-cell mean (16 V + 12 T) over paths 0-9 on L at L* = 32 lambda',
    },
    diagnosticCapture: { cell: LINEARITY_CELL, limit: 1000 },
    order: { seed: 0x9e3779b9, algorithm: 'fisher-yates-descending' },
    decision: {
      workloadPaths: 1000,
      workloadCubics: 32,
      wasmFactor: 2,
      budgets: { initialMs: 1000, editMs: 4, meshBytes: 64 * 2 ** 20 },
      primarySeries: PRIMARY_SERIES,
      minimumPrimaryCells: 4,
      predictionFactorLimit: 2,
      linearityLimit: 1.25,
      quantumMultiple: 100,
      tQuantile95: T_QUANTILE_95,
    },
    h1: { supported: 0.5, notSupported: 0.25, overheadLimit: 1.5 },
  };
}

export type ScenarioConfig = ReturnType<typeof scenarioConfig>;
