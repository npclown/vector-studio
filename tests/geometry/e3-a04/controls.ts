// D9 E3 unit E3-U3: the harness-level positive controls of contract section 8.1 (E3-PC1 to PC9,
// PC11 and PC14), executable form in section 15.8. Every control is a synthetic port answer, a
// known-answer mesh written here and served by a port double through the real PathMeshPipeline,
// so no kernel output is read (section 5.5). Each runs at T0, z = 1, d = 1 unless stated, where
// one local unit is one physical px. The reference run records their outcomes (E3-A5).
import type {
  FillMesh,
  FillMeshBatchResult,
  FillMeshPort,
  FillMeshRequest,
  StrokeMeshBatchResult,
  StrokeMeshPort,
  StrokeMeshRequest,
} from '@vector-studio/contracts';
import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import {
  decodeCase,
  dNum,
  measureCase,
  type HarnessOptions,
  type HarnessRow,
  type Mapped,
} from './harness.js';
import type { ControlOutcome } from './record.js';
import { harnessCase } from './smoke.js';
import { fill, polygon, polygons, rect, stroke } from './oracle-cases.js';

type Pt = readonly [number, number];
type Answer = Readonly<{ status: 'ok'; mesh: FillMesh }> | Readonly<{ status: 'empty' }>;

/** A mesh from triangles given by coordinates; shared vertices are merged by value. */
export function meshFromTriangles(triangles: readonly (readonly Pt[])[]): FillMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const index = new Map<string, number>();
  for (const tri of triangles)
    for (const [x, y] of tri) {
      const key = `${x},${y}`;
      let i = index.get(key);
      if (i === undefined) {
        i = positions.length / 2;
        index.set(key, i);
        positions.push(x, y);
      }
      indices.push(i);
    }
  // Boundary edges for the fringe builder: index pairs used by one triangle.
  const uses = new Map<string, [number, number, number]>();
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t + k]!;
      const b = indices[t + ((k + 1) % 3)]!;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = uses.get(key) ?? [a, b, 0];
      entry[2] += 1;
      uses.set(key, entry);
    }
  const boundary: number[] = [];
  for (const [a, b, n] of uses.values()) if (n === 1) boundary.push(a, b);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    minX = Math.min(minX, positions[i]!);
    maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!);
    maxY = Math.max(maxY, positions[i + 1]!);
  }
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    boundaryEdges: Uint32Array.from(boundary),
    bounds: { minX, minY, maxX, maxY },
  };
}

/** A fan from vertex 0 of a star-shaped polygon. */
export function fan(points: readonly Pt[]): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 1; i + 1 < points.length; i += 1) out.push([points[0]!, points[i]!, points[i + 1]!]);
  return out;
}

const answerFor = (answer: Answer, request: FillMeshRequest | StrokeMeshRequest) =>
  answer.status === 'ok'
    ? {
        requestId: request.requestId,
        toleranceExponent: request.toleranceExponent,
        status: 'ok' as const,
        mesh: {
          positions: answer.mesh.positions.slice(),
          indices: answer.mesh.indices.slice(),
          boundaryEdges: answer.mesh.boundaryEdges.slice(),
          bounds: { ...answer.mesh.bounds },
        },
      }
    : {
        requestId: request.requestId,
        toleranceExponent: request.toleranceExponent,
        status: 'empty' as const,
      };

/** Port doubles that answer every request with the given mesh or `empty`. */
export function controlPorts(answer: Answer): { fill: FillMeshPort; stroke: StrokeMeshPort } {
  return {
    fill: {
      portVersion: 0,
      operationId: 'test/e3-a04-control',
      buildFillMeshes: (requests): FillMeshBatchResult => ({
        status: 'ok',
        results: requests.map((r) => answerFor(answer, r)),
      }),
    },
    stroke: {
      portVersion: 0,
      operationId: 'test/e3-a04-control',
      buildStrokeMeshes: (requests): StrokeMeshBatchResult => ({
        status: 'ok',
        results: requests.map((r) => answerFor(answer, r)),
      }),
    },
  };
}

function run(kase: A04Case, mesh: FillMesh | null, options: HarnessOptions = {}): HarnessRow {
  return measureCase(
    kase,
    controlPorts(mesh === null ? { status: 'empty' } : { status: 'ok', mesh }),
    options,
  );
}

const contains = (row: HarnessRow, value: number, slack: number) =>
  row.eLo !== null && row.eHi !== null && row.eLo <= value + slack && value - slack <= row.eHi;

function outcome(
  id: string,
  expected: string,
  row: HarnessRow,
  ok: boolean,
  detail: Record<string, unknown> = {},
): ControlOutcome {
  return {
    id,
    expected,
    observed: `${row.status}${row.reason === null ? '' : ` (${row.reason})`}, E ∈ [${String(row.eLo)}, ${String(row.eHi)}], β_c ${String(row.betaC)}`,
    ok,
    detail,
  };
}

// ---------------------------------------------------------------------------------------------
// E3-PC1, PC2: a boundary vertex moved along its outward normal

const RECT = rect(0, 0, 96, 48);

/** The rectangle with a vertex at the top edge's midpoint moved by `offset` outward (−y). */
function bumpedRect(offset: number): FillMesh {
  const top: Pt = [48, -offset];
  return meshFromTriangles([
    [[0, 0], top, [0, 48]],
    [top, [96, 48], [0, 48]],
    [top, [96, 0], [96, 48]],
  ]);
}

function bumpControl(id: string, offset: number, expected: 'fail' | 'pass'): ControlOutcome {
  const kase = harnessCase({ id, ...polygon(RECT), paint: fill() });
  // At T0, z = 1, d = 1 the ideal top edge lies at y = −c_y physical px.
  const topEdge = -decodeCase(kase).camera.y;
  let realized = Number.NaN;
  const row = run(kase, bumpedRect(offset), {
    oracle: { separateTerms: true },
    onMapped: (m: Mapped) => {
      // Vertex 1 is the moved one.
      realized = topEdge - dNum(m.points[1]!.y);
    },
  });
  const ok =
    row.status === expected && contains(row, realized, 0) && Math.abs(realized - offset) < 1e-5;
  return outcome(
    id,
    `${expected.toUpperCase()} with the realized offset in [E_lo, E_hi]`,
    row,
    ok,
    {
      realized,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// E3-PC3: coarse flattening at the chord count that the e + 3 tolerance admits

/** At T0, z = 1, d = 1 the bucket is e = −3, so e + 3 admits chords of error up to 1 px. */
const COARSE_TOLERANCE = 1;

function circleControl(): ControlOutcome {
  const radius = 16;
  let n = 3;
  while (radius * (1 - Math.cos(Math.PI / n)) > COARSE_TOLERANCE) n += 1;
  const known = radius * (1 - Math.cos(Math.PI / n));
  const ring: Pt[] = [];
  for (let k = 0; k < n; k += 1) {
    const t = (2 * Math.PI * k) / n;
    ring.push([radius * Math.cos(t), radius * Math.sin(t)]);
  }
  const tris = ring.map((p, k): Pt[] => [[0, 0], p, ring[(k + 1) % n]!]);
  const kase = harnessCase({
    id: 'E3-PC3/circle',
    verbs: 'ML',
    points: [0, 0, 0, 0],
    paint: stroke(2 * radius, 'round'),
    c: [-320, -180],
  });
  const row = run(kase, meshFromTriangles(tris), {
    oracle: { separateTerms: true, resolution: 2 ** -6 },
  });
  const ok = row.status === 'fail' && known > 0.3 && known < 1 && contains(row, known, 1e-5);
  return outcome('E3-PC3/circle', 'FAIL with the sagitta in [E_lo, E_hi]', row, ok, {
    chords: n,
    known,
  });
}

type Cubic = readonly [Pt, Pt, Pt, Pt];
const S_CURVE: Cubic = [
  [0, 10],
  [40, -10],
  [60, 30],
  [100, 10],
];
const bez = (c: Cubic, t: number): Pt => {
  const s = 1 - t;
  const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
  return [
    w.reduce((a, wi, i) => a + wi * c[i]![0], 0),
    w.reduce((a, wi, i) => a + wi * c[i]![1], 0),
  ];
};

/** The closed-form chord error: the extremum of the cubic distance-to-chord polynomial. */
function chordError(c: Cubic, t0: number, t1: number): { error: number; t: number } {
  const a = bez(c, t0);
  const b = bez(c, t1);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  // f(t) = n · (C(t) − a), a cubic; f'(t) = 0 is a quadratic in t.
  const [p0, p1, p2, p3] = c.map(([x, y]) => nx * (x - a[0]) + ny * (y - a[1])) as [
    number,
    number,
    number,
    number,
  ];
  const qa = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const qb = 6 * (p0 - 2 * p1 + p2);
  const qc = 3 * (p1 - p0);
  const roots: number[] = [];
  if (Math.abs(qa) < 1e-300) roots.push(-qc / qb);
  else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0)
      roots.push((-qb + Math.sqrt(disc)) / (2 * qa), (-qb - Math.sqrt(disc)) / (2 * qa));
  }
  let best = { error: 0, t: t0 };
  for (const t of roots)
    if (t > t0 && t < t1) {
      const p = bez(c, t);
      const d = Math.abs(nx * (p[0] - a[0]) + ny * (p[1] - a[1]));
      if (d > best.error) best = { error: d, t };
    }
  return best;
}

function sCurveControl(): ControlOutcome {
  const chordsFor = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);
  const worst = (n: number) => {
    const ts = chordsFor(n);
    let w = { error: 0, t: 0 };
    for (let i = 0; i < n; i += 1) {
      const e = chordError(S_CURVE, ts[i]!, ts[i + 1]!);
      if (e.error > w.error) w = e;
    }
    return w;
  };
  let n = 1;
  while (worst(n).error > COARSE_TOLERANCE) n += 1;
  const known = worst(n);
  const pts = chordsFor(n).map((t) => bez(S_CURVE, t));
  // The worst point's nearest polygon point is its foot on its own chord (checked, not assumed).
  const at = bez(S_CURVE, known.t);
  const segDist = (p: Pt, a: Pt, b: Pt) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const u = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
    );
    return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
  };
  let nearest = Infinity;
  for (let i = 0; i + 1 < pts.length; i += 1)
    nearest = Math.min(nearest, segDist(at, pts[i]!, pts[i + 1]!));
  const tris: Pt[][] = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    tris.push([a, b, [b[0], 40]], [a, [b[0], 40], [a[0], 40]]);
  }
  const kase = harnessCase({
    id: 'E3-PC3/s-curve',
    verbs: 'MCLLZ',
    points: [...S_CURVE.flat(), 100, 40, 0, 40],
    paint: fill(),
  });
  const row = run(kase, meshFromTriangles(tris), {
    oracle: { separateTerms: true, resolution: 2 ** -6 },
  });
  const ok =
    row.status === 'fail' &&
    known.error > 0.3 &&
    known.error <= 1 &&
    Math.abs(nearest - known.error) < 1e-9 &&
    contains(row, known.error, 1e-5);
  return outcome(
    'E3-PC3/s-curve',
    'FAIL with the closed-form chord error in [E_lo, E_hi]',
    row,
    ok,
    {
      chords: n,
      known: known.error,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// E3-PC4 to PC6: dropped triangle, flipped rule, closed hole

function droppedTriangleControl(): ControlOutcome {
  const tris: Pt[][] = [];
  for (let i = 0; i < 4; i += 1)
    for (let j = 0; j < 4; j += 1) {
      const [x, y] = [16 * i, 16 * j];
      tris.push(
        [
          [x, y],
          [x + 16, y],
          [x + 16, y + 16],
        ],
        [
          [x, y],
          [x + 16, y + 16],
          [x, y + 16],
        ],
      );
    }
  // Cell (1, 1) is interior: its first triangle touches no boundary.
  tris.splice(2 * (1 * 4 + 1), 1);
  const kase = harnessCase({ id: 'E3-PC4', ...polygon(rect(0, 0, 64, 64)), paint: fill() });
  const row = run(kase, meshFromTriangles(tris));
  return outcome('E3-PC4', 'FAIL', row, row.status === 'fail');
}

/**
 * The fill rule flipped: two nested squares of the same orientation, whose nonzero region is the
 * outer square (winding 2 inside the inner one) and whose evenodd region is the annulus. The
 * contract names the star; its evenodd mesh has pinch vertices at the inner pentagon, which the
 * product's fringe builder rejects (`fringe-unsupported`, not drawn), so this control uses a
 * shape with the same rule flip and no pinch (section 15.8).
 */
function ruleControl(): ControlOutcome {
  const outer = rect(0, 0, 64, 64);
  const inner = rect(16, 16, 48, 48);
  const tris: Pt[][] = [];
  for (let k = 0; k < 4; k += 1) {
    const a = outer[k]!;
    const b = outer[(k + 1) % 4]!;
    const c = inner[(k + 1) % 4]!;
    const d = inner[k]!;
    tris.push([a, b, c], [a, c, d]);
  }
  const kase = harnessCase({ id: 'E3-PC5', ...polygons([outer, inner]), paint: fill('nonzero') });
  const row = run(kase, meshFromTriangles(tris));
  return outcome('E3-PC5', 'FAIL (G)', row, row.status === 'fail');
}

function holeControl(): ControlOutcome {
  const kase = harnessCase({
    id: 'E3-PC6',
    ...polygons([rect(0, 0, 64, 32), [...rect(31.8, 8, 32.2, 24)].reverse()]),
    paint: fill(),
  });
  const row = run(kase, meshFromTriangles(fan(rect(0, 0, 64, 32))));
  return outcome('E3-PC6', 'FAIL (B_R)', row, row.status === 'fail');
}

// ---------------------------------------------------------------------------------------------
// E3-PC7, PC8: lane and pan defects

const FAR: readonly [number, number] = [2 ** 24, -(2 ** 24)];

function laneControl(): ControlOutcome {
  // Lane a = 1 has ulp 2^-23; 2^16 ulps is 2^-7, so u_x = ±38.4 moves the sides by 0.3 px.
  const r = rect(0, 0, 76.8, 32);
  const kase = harnessCase({ id: 'E3-PC7', ...polygon(r), paint: fill(), t: FAR });
  const row = run(kase, meshFromTriangles(fan(r)), {
    mutations: { linearLane: { index: 0, ulps: 2 ** 16 } },
  });
  return outcome('E3-PC7', 'FAIL', row, row.status === 'fail');
}

function panControl(): ControlOutcome {
  const r = rect(0, 0, 64, 32);
  const kase = harnessCase({ id: 'E3-PC8', ...polygon(r), paint: fill() });
  const row = run(kase, meshFromTriangles(fan(r)), { mutations: { panPx: [0.3, 0] } });
  return outcome('E3-PC8', 'FAIL', row, row.status === 'fail');
}

// ---------------------------------------------------------------------------------------------
// E3-PC9: stroke defects (r + 0.3, bevel for a kept miter, square for a round cap)

function strokeControls(): ControlOutcome[] {
  const r = 2;
  const out: ControlOutcome[] = [];
  {
    const kase = harnessCase({
      id: 'E3-PC9/width',
      verbs: 'ML',
      points: [0, 0, 100, 0],
      paint: stroke(2 * r),
    });
    const row = run(kase, meshFromTriangles(fan(rect(0, -r - 0.3, 100, r + 0.3))));
    out.push(outcome('E3-PC9/width', 'FAIL', row, row.status === 'fail'));
  }
  {
    // A 90° turn: the kept miter's tip (50 + r, −r) lies r/√2 ≈ 1.41 px beyond the bevel line.
    const kase = harnessCase({
      id: 'E3-PC9/bevel',
      verbs: 'MLL',
      points: [0, 0, 50, 0, 50, 50],
      paint: stroke(2 * r, 'butt', 'miter', 4),
    });
    const reflex: Pt = [50 - r, r];
    const bevel: Pt[] = [
      reflex,
      [0, r],
      [0, -r],
      [50, -r],
      [50 + r, 0],
      [50 + r, 50],
      [50 - r, 50],
    ];
    const row = run(kase, meshFromTriangles(fan(bevel)));
    out.push(outcome('E3-PC9/bevel', 'FAIL', row, row.status === 'fail'));
  }
  {
    const kase = harnessCase({
      id: 'E3-PC9/cap',
      verbs: 'ML',
      points: [0, 0, 100, 0],
      paint: stroke(2 * r, 'round'),
    });
    const row = run(kase, meshFromTriangles(fan(rect(-r, -r, 100 + r, r))));
    out.push(
      outcome('E3-PC9/cap', 'FAIL', row, row.status === 'fail', { cornerPx: r * (Math.SQRT2 - 1) }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// E3-PC11, PC14: empty results

function emptyControl(): ControlOutcome {
  const kase = harnessCase({ id: 'E3-PC11', ...polygon(RECT), paint: fill() });
  const row = run(kase, null);
  return outcome(
    'E3-PC11',
    'FAIL with B_R = +∞',
    row,
    row.status === 'fail' && row.eLo === Infinity,
  );
}

function coverControl(): ControlOutcome {
  const kase = harnessCase({
    id: 'E3-PC14',
    ...polygon(rect(-1000, -1000, 2000, 2000)),
    paint: fill(),
    c: [0, 0],
  });
  const row = run(kase, null);
  return outcome(
    'E3-PC14',
    'FAIL at the window point',
    row,
    row.status === 'fail' && row.drawn === 'empty',
  );
}

/** Every harness-level control, in section 8.1 order. */
export function runHarnessControls(): ControlOutcome[] {
  return [
    bumpControl('E3-PC1', 0.26, 'fail'),
    bumpControl('E3-PC2', 0.24, 'pass'),
    circleControl(),
    sCurveControl(),
    droppedTriangleControl(),
    ruleControl(),
    holeControl(),
    laneControl(),
    panControl(),
    ...strokeControls(),
    emptyControl(),
    coverControl(),
  ];
}

export const CONTROL_IDS = [
  'E3-PC1',
  'E3-PC2',
  'E3-PC3/circle',
  'E3-PC3/s-curve',
  'E3-PC4',
  'E3-PC5',
  'E3-PC6',
  'E3-PC7',
  'E3-PC8',
  'E3-PC9/width',
  'E3-PC9/bevel',
  'E3-PC9/cap',
  'E3-PC11',
  'E3-PC14',
] as const;

export { bumpedRect, RECT };
