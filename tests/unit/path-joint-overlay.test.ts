import type { FillMesh, StrokeMeshRequest } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  pointTriangleDistanceSquared,
  segmentTriangleDistanceSquared,
} from '../geometry/coverage-oracle/exterior.js';
import type { Q2 } from '../geometry/coverage-oracle/positions.js';
import {
  bitsOf,
  compare,
  exactInteger,
  fromBits,
  rational,
} from '../geometry/rounded-fill/exact.js';
import { buildPathFringeDetailed } from '../../packages/renderer-core/src/path-fringe.js';
import {
  JOINT_OVERLAY_LIMITS,
  buildJointOverlay,
  buildJointOverlayDetailed,
  type JointOverlay,
  type JointOverlayDetail,
  type JointOverlayInput,
  type JointOverlaySeededDefect,
} from '../../packages/renderer-core/src/path-joint-overlay.js';
import {
  DEFAULT_STROKE_STYLE,
  STROKE_CONFORMANCE_PATHS,
  type StrokeConformancePathName,
  type StrokeFixtureStyle,
} from '../support/stroke-mesh-port-conformance.js';
import { StrokeMeshPortDouble } from '../support/stroke-mesh-port-double.js';
import { strokeRingMesh } from '../support/st-u6-stroke-harness.js';
import { squareMesh } from '../support/v3a-path-harness.js';

// P3 B2 ST-U7 addendum, unit ST-U7b, acceptance row ST-A14: the joint overlay builder
// (packages/renderer-core/src/path-joint-overlay.ts) on fixtures ST7-F1 to ST7-F10, ST7-F13 and
// ST7-F15 (built) and ST7-F14 (overlay-unsupported), against an independent exact oracle in this
// file. The oracle side imports nothing from the overlay builder: it rebuilds every position from
// the port meshes, the frame lanes and the published Steiner roundings, recomputes every exact
// intersection itself, and uses only the test-only exact helpers of tests/geometry and the fill
// variant's own published lists (path-fringe.ts) as the parents' data. Seeded defects ST7-D3 to
// ST7-D6 and ST7-D11 must fail their named checks. Functional evidence only: precision is
// UNVERIFIED against the 0.25 physical-pixel target until B4; no Q4 coverage threshold is claimed.

type Point = readonly [number, number];
type Triangle3 = readonly [number, number, number];

// ---------------------------------------------------------------------------------------------
// Fixture meshes, shaped as the ports return them.

/** An owned port-shaped mesh: triangles made counterclockwise, boundary edges used once. */
function meshOf(vertices: readonly Point[], triangles: readonly (readonly number[])[]): FillMesh {
  const oriented = triangles.map(([a, b, c]) => {
    const [ax, ay] = vertices[a!]!;
    const [bx, by] = vertices[b!]!;
    const [cx, cy] = vertices[c!]!;
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0 ? [a!, b!, c!] : [a!, c!, b!];
  });
  const uses = new Map<string, number>();
  const key = (p: number, q: number) => `${Math.min(p, q)}:${Math.max(p, q)}`;
  for (const [a, b, c] of oriented)
    for (const [p, q] of [
      [a!, b!],
      [b!, c!],
      [c!, a!],
    ] as const)
      uses.set(key(p, q), (uses.get(key(p, q)) ?? 0) + 1);
  const boundary: number[] = [];
  for (const [a, b, c] of oriented)
    for (const [p, q] of [
      [a!, b!],
      [b!, c!],
      [c!, a!],
    ] as const)
      if (uses.get(key(p, q)) === 1) boundary.push(p, q);
  const xs = vertices.map(([x]) => x);
  const ys = vertices.map(([, y]) => y);
  return {
    positions: Float64Array.from(vertices.flat()),
    indices: Uint32Array.from(oriented.flat()),
    boundaryEdges: Uint32Array.from(boundary),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}

/** A fan from vertex `apex` of a polygon visible from it. */
function fanMesh(polygon: readonly Point[], apex = 0): FillMesh {
  const n = polygon.length;
  const triangles: number[][] = [];
  for (let i = 1; i < n - 1; i += 1) triangles.push([apex, (apex + i) % n, (apex + i + 1) % n]);
  return meshOf(polygon, triangles);
}

/** A ring between two polygons of n vertices each, as a quad strip. */
function ringMesh(outer: readonly Point[], inner: readonly Point[]): FillMesh {
  const n = outer.length;
  const triangles: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    triangles.push([i, j, n + j], [i, n + j, n + i]);
  }
  return meshOf([...outer, ...inner], triangles);
}

const rectangle = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const regular = (n: number, radius: number, cx = 0, cy = 0, phase = 0): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const angle = phase + (2 * Math.PI * i) / n;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
  });

function doubleStroke(name: StrokeConformancePathName, style: Partial<StrokeFixtureStyle>) {
  const fixture = STROKE_CONFORMANCE_PATHS[name];
  const values = { ...DEFAULT_STROKE_STYLE, ...style };
  const request: StrokeMeshRequest = {
    requestId: 0,
    verbs: Uint8Array.from(fixture.verbs),
    points: Float64Array.from(fixture.points),
    width: values.width,
    cap: values.cap,
    join: values.join,
    miterLimit: values.miterLimit,
    toleranceExponent: -3,
  };
  const batch = new StrokeMeshPortDouble().buildStrokeMeshes([request]);
  if (batch.status !== 'ok' || batch.results[0]!.status !== 'ok') throw new Error(name);
  return batch.results[0]!.mesh;
}

const mirrored = (mesh: FillMesh): FillMesh => {
  const vertices: Point[] = [];
  for (let i = 0; i < mesh.positions.length; i += 2)
    vertices.push([-mesh.positions[i]!, mesh.positions[i + 1]!]);
  const triangles: number[][] = [];
  for (let t = 0; t < mesh.indices.length; t += 3)
    triangles.push([mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!]);
  return meshOf(vertices, triangles);
};

/** The fringe test's even-odd star: five tips, its center pentagon a hole. */
const star = (() => {
  const outer: Point[] = [];
  const inner: Point[] = [];
  for (let i = 0; i < 5; i += 1) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / 5;
    const b = a + Math.PI / 5;
    outer.push([10 + 9 * Math.cos(a), 10 + 9 * Math.sin(a)]);
    inner.push([
      10 + 3.5 * Math.cos(b - (2 * Math.PI) / 5),
      10 + 3.5 * Math.sin(b - (2 * Math.PI) / 5),
    ]);
  }
  const triangles: number[][] = [];
  for (let i = 0; i < 5; i += 1) triangles.push([i, 5 + ((i + 1) % 5), 5 + i]);
  return meshOf([...outer, ...inner], triangles);
})();

type Buckets = readonly [fill: number | null, stroke: number | null];
type Fixture = Readonly<{
  id: string;
  fill: FillMesh;
  stroke: FillMesh;
  buckets: readonly Buckets[];
}>;

const BOTH: readonly Buckets[] = [
  [-1, -1],
  [0, -2],
  [1, 0],
  [-2, null],
];

/** ST7-F1 to ST7-F10, ST7-F13 and ST7-F15 (built); expectations fixed before the first run. */
const FIXTURES: readonly Fixture[] = [
  // ST7-F1: ST-U6's both-half node: the square [0, 10]^2 under the width-2 miter ring.
  { id: 'ST7-F1', fill: squareMesh(10), stroke: strokeRingMesh(), buckets: BOTH },
  // ST7-F2: ST-F11's ring (miter, the double's unit cells) over [0, 4]^2 split by one diagonal:
  // the ring's inner corners (1, 1) and (3, 3) lie exactly on it.
  {
    id: 'ST7-F2',
    fill: squareMesh(4),
    stroke: doubleStroke('stF11', { miterLimit: 2 }),
    buckets: BOTH,
  },
  // ST7-F3: ST-F14 (b), a self-overlapping stroke, with the path's nonzero fill: the square
  // [2, 4]^2 and the triangle (0, 2), (2, 0), (2, 2), pinched at (2, 2).
  {
    id: 'ST7-F3',
    fill: meshOf(
      [
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
        [0, 2],
        [2, 0],
      ],
      [
        [0, 1, 2],
        [0, 2, 3],
        [0, 4, 5],
      ],
    ),
    stroke: doubleStroke('stF14b', { miterLimit: 2 }),
    buckets: BOTH,
  },
  // ST7-F4: an open subpath (0, 0), (8, 0), (8, 7) with its fill, the triangle closed by the
  // implicit edge (8, 7) to (0, 0), which is fill boundary with no stroke; the butt-capped,
  // mitered width-2 stroke crosses that edge at the non-dyadic (8/7, 1).
  {
    id: 'ST7-F4',
    fill: meshOf(
      [
        [0, 0],
        [8, 0],
        [8, 7],
      ],
      [[0, 1, 2]],
    ),
    stroke: fanMesh(
      [
        [0, -1],
        [9, -1],
        [9, 7],
        [7, 7],
        [7, 1],
        [0, 1],
      ],
      4,
    ),
    buckets: BOTH,
  },
  // ST7-F5: the even-odd star with a decagon ring over its center hole and its tips.
  {
    id: 'ST7-F5',
    fill: star,
    stroke: ringMesh(regular(10, 5, 10, 10, 0.1), regular(10, 2.5, 10, 10, 0.1)),
    buckets: BOTH,
  },
  // ST7-F6: ST-F3 (ST-F1 with round caps: half 16-gons) under a convex pentagon fill.
  {
    id: 'ST7-F6',
    fill: fanMesh([
      [-1.5, -0.5],
      [2, -2],
      [5.5, -0.5],
      [4, 2],
      [0, 2],
    ]),
    stroke: doubleStroke('stF1', { cap: 'round' }),
    buckets: BOTH,
  },
  // ST7-F7: a region-only stroke (a 72-gon ring, 144 boundary vertices, above the 128 cap) over a
  // fringed 64-gon fill.
  {
    id: 'ST7-F7',
    fill: fanMesh(regular(64, 20)),
    stroke: ringMesh(regular(72, 21, 0, 0, 0.01), regular(72, 19, 0, 0, 0.01)),
    buckets: [
      [-1, null],
      [0, null],
    ],
  },
  // ST7-F8: a closed region-only fill (a 136-gon, above the cap) with a width-4 ring stroke whose
  // turns are 2.6 degrees: r_phys cos(theta/2) is far above delta_F + delta_S at every turn.
  {
    id: 'ST7-F8',
    fill: fanMesh(regular(136, 50)),
    stroke: ringMesh(regular(136, 52), regular(136, 48)),
    buckets: [
      [null, -1],
      [null, null],
    ],
  },
  // ST7-F9: ST7-F1 under a reflection. The builder takes no transform, so the reflected node's
  // overlay is ST7-F1's; the locally mirrored geometry is built as well.
  {
    id: 'ST7-F9',
    fill: mirrored(squareMesh(10)),
    stroke: mirrored(strokeRingMesh()),
    buckets: BOTH,
  },
  // ST7-F10: translucent colors (f.a = s.a = 0.5) do not reach the overlay: ST7-F1's geometry.
  { id: 'ST7-F10', fill: squareMesh(10), stroke: strokeRingMesh(), buckets: [[-1, -1]] },
  // ST7-F13: [0, 12] x [0, 7] split by its anti-diagonal; the ring's inner corner (1, 1) lies in
  // the only fill triangle of the convex corner (0, 0): a reflex face.
  {
    id: 'ST7-F13',
    fill: meshOf(rectangle(0, 0, 12, 7), [
      [0, 1, 3],
      [1, 2, 3],
    ]),
    stroke: ringMesh(rectangle(-1, -1, 13, 8), rectangle(1, 1, 11, 6)),
    buckets: BOTH,
  },
  // ST7-F15: a small ring subpath wholly inside one large fill triangle: faces with holes.
  {
    id: 'ST7-F15',
    fill: meshOf(
      [
        [0, 0],
        [100, 0],
        [0, 100],
      ],
      [[0, 1, 2]],
    ),
    stroke: ringMesh(rectangle(15, 15, 25, 25), rectangle(17, 17, 23, 23)),
    buckets: [
      [-1, -1],
      [2, 0],
      [0, null],
    ],
  },
  // Positive control for section 4.2 step 6 (review S1): a region-only rectangle fill under an
  // inverted-U stroke whose legs cross the fill's axis-aligned bottom edge y = 0, one of them
  // sloped from the non-dyadic (1.3, -1) to (1.2, 1). The four Steiner points on that outer
  // edge keep y = 0 exactly after rounding, so the overlay builds.
  {
    id: 'U7b-axis-outer',
    fill: meshOf(rectangle(0, 0, 4, 2), [
      [0, 1, 2],
      [0, 2, 3],
    ]),
    stroke: meshOf(
      [
        [1.3, -1],
        [1.5, -1],
        [1.5, 0.8],
        [2.5, 0.8],
        [2.5, -1],
        [2.7, -1],
        [2.7, 1],
        [1.2, 1],
      ],
      [
        [0, 1, 2],
        [0, 2, 7],
        [2, 6, 7],
        [2, 3, 6],
        [3, 4, 5],
        [3, 5, 6],
      ],
    ),
    buckets: [
      [null, -1],
      [null, null],
    ],
  },
];

/**
 * ST7-F14: an open polyline (0, 0), (10, 0), (10, 8) whose fill is region-only (above the cap),
 * with square caps (width 2): both endpoints are interior to the stroke, so the sloped implicit
 * closing edge, longer than w, crosses the stroke boundary.
 */
const F14: Fixture = {
  id: 'ST7-F14',
  fill: meshOf(
    [
      [0, 0],
      [10, 0],
      [10, 8],
    ],
    [[0, 1, 2]],
  ),
  stroke: fanMesh(
    [
      [-1, -1],
      [11, -1],
      [11, 9],
      [9, 9],
      [9, 1],
      [-1, 1],
    ],
    4,
  ),
  buckets: [
    [null, -1],
    [null, null],
  ],
};

const inputOf = (fixture: Fixture, [fill, stroke]: Buckets): JointOverlayInput => ({
  fill: { mesh: fixture.fill, fringeBucket: fill },
  stroke: { mesh: fixture.stroke, fringeBucket: stroke },
});

// ---------------------------------------------------------------------------------------------
// The independent oracle. Exact values are BigInt multiples of one power of two (every Float64
// and every Float64 plus binary32 sum is one); unrounded Steiner points are homogeneous
// (X, Y, W) with W > 0.

const STROKE_BIT = 0x8000_0000;
type Exact = readonly [bigint, bigint];
type H = readonly [bigint, bigint, bigint];
const fixed = (value: number): bigint => exactInteger(bitsOf(value));

function trailingZeros(value: bigint): number {
  if (value === 0n) return Number.POSITIVE_INFINITY;
  let v = value < 0n ? -value : value;
  let count = 0;
  while ((v & 1n) === 0n) {
    v >>= 1n;
    count += 1;
  }
  return count;
}

const orientE = (p: Exact, q: Exact, r: Exact) =>
  (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
/** Sign-correct orientation of homogeneous points (all W > 0). */
const orientH = (p: H, q: H, r: H) =>
  p[0] * (q[1] * r[2] - q[2] * r[1]) -
  p[1] * (q[0] * r[2] - q[2] * r[0]) +
  p[2] * (q[0] * r[1] - q[1] * r[0]);
const lift = (p: Exact): H => [p[0], p[1], 1n];

type OracleView = Readonly<{
  /** Rounded (drawn) exact position of a joint index. */
  rounded: (index: number) => Exact;
  /** Unrounded exact position of a joint index. */
  unrounded: (index: number) => H;
  strokePoint: (s: number) => Exact;
  fillPoint: (variantIndex: number) => Exact;
  scale: (value: number) => bigint;
  shift: number;
  frame: readonly Exact[] | null;
  midpoint: Point;
}>;

function oracleView(
  input: JointOverlayInput,
  overlay: JointOverlay,
  detail: JointOverlayDetail,
): OracleView {
  const fill = input.fill.mesh;
  const stroke = input.stroke.mesh;
  const n = fill.positions.length / 2;
  const midpoint: Point = [
    fill.bounds.minX / 2 + fill.bounds.maxX / 2,
    fill.bounds.minY / 2 + fill.bounds.maxY / 2,
  ];
  const fringed = input.fill.fringeBucket !== null;
  const lane = (index: number) => overlay.positions[index]!;
  // One power-of-two grid for every value the oracle uses.
  const raw: bigint[] = [];
  for (const value of fill.positions) raw.push(fixed(value));
  for (const value of stroke.positions) raw.push(fixed(value));
  raw.push(fixed(midpoint[0]), fixed(midpoint[1]));
  // The stroke reach rho_S = 2^f' lies on the grid too.
  if (input.stroke.fringeBucket !== null) raw.push(fixed(2 ** input.stroke.fringeBucket));
  for (let i = 2 * n; i < overlay.positions.length; i += 1) raw.push(fixed(lane(i)));
  for (const s of detail.steiner) {
    if (s.x !== null) raw.push(fixed(s.x));
    if (s.y !== null) raw.push(fixed(s.y));
  }
  const shift = Math.min(...raw.map(trailingZeros).filter(Number.isFinite), 1074);
  const scale = (value: number) => fixed(value) >> BigInt(shift);
  const fillPoint = (index: number): Exact => {
    if (index < n)
      return [scale(fill.positions[2 * index]!), scale(fill.positions[2 * index + 1]!)];
    const corner = index - n;
    return [
      scale(midpoint[0]) + scale(lane(2 * (n + corner))),
      scale(midpoint[1]) + scale(lane(2 * (n + corner) + 1)),
    ];
  };
  const strokePoint = (s: number): Exact => [
    scale(stroke.positions[2 * s]!),
    scale(stroke.positions[2 * s + 1]!),
  ];
  const steinerRounded = (j: number): Exact => {
    const s = detail.steiner[j]!;
    const at = 2 * (overlay.fillVertices + j);
    return [
      s.x === null ? scale(midpoint[0]) + scale(lane(at)) : scale(s.x),
      s.y === null ? scale(midpoint[1]) + scale(lane(at + 1)) : scale(s.y),
    ];
  };
  const steinerExact = (j: number): H => {
    const s = detail.steiner[j]!;
    const a = fillPoint(s.domainEdge[0]);
    const b = fillPoint(s.domainEdge[1]);
    const c = strokePoint(s.strokeEdge[0]);
    const d = strokePoint(s.strokeEdge[1]);
    // a + t (b - a), t = orient(c, d, a) / (orient(c, d, a) - orient(c, d, b)).
    const oa = orientE(c, d, a);
    const ob = orientE(c, d, b);
    let w = oa - ob;
    let num = oa;
    if (w < 0n) {
      w = -w;
      num = -num;
    }
    return [a[0] * w + (b[0] - a[0]) * num, a[1] * w + (b[1] - a[1]) * num, w];
  };
  const rounded = (index: number): Exact => {
    if (index >= STROKE_BIT) return strokePoint(index - STROKE_BIT);
    if (index < overlay.fillVertices) return fillPoint(index);
    return steinerRounded(index - overlay.fillVertices);
  };
  const unrounded = (index: number): H => {
    if (index >= STROKE_BIT || index < overlay.fillVertices) return lift(rounded(index));
    return steinerExact(index - overlay.fillVertices);
  };
  return {
    rounded,
    unrounded,
    strokePoint,
    fillPoint,
    scale,
    shift,
    frame: fringed ? [0, 1, 2, 3].map((corner) => fillPoint(n + corner)) : null,
    midpoint,
  };
}

const triplesOf = (words: Uint32Array, stride: number): Triangle3[] =>
  Array.from(
    { length: words.length / stride },
    (_, t) => [words[stride * t]!, words[stride * t + 1]!, words[stride * t + 2]!] as const,
  );

/** Directed domain boundary edges, exact: the frame sides or the fill's boundaryEdges. */
function domainBoundary(input: JointOverlayInput, view: OracleView): [Exact, Exact][] {
  if (view.frame !== null)
    return view.frame.map((p, i) => [p, view.frame![(i + 1) % 4]!] as [Exact, Exact]);
  const edges: [Exact, Exact][] = [];
  const b = input.fill.mesh.boundaryEdges;
  for (let i = 0; i < b.length; i += 2)
    edges.push([view.fillPoint(b[i]!), view.fillPoint(b[i + 1]!)]);
  return edges;
}

const within = (a: Exact, b: Exact, p: Exact) =>
  (p[0] - a[0]) * (p[0] - b[0]) <= 0n && (p[1] - a[1]) * (p[1] - b[1]) <= 0n;
const equal = (p: Exact, q: Exact) => p[0] === q[0] && p[1] === q[1];

function gcdOf(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

const keyOf = (p: H): string => {
  const g = gcdOf(gcdOf(p[0], p[1]), p[2]);
  return `${p[0] / g}:${p[1] / g}:${p[2] / g}`;
};

/** Every stroke vertex in the interior of ab and every proper crossing of a stroke edge with it. */
function insertionKeys(input: JointOverlayInput, view: OracleView, a: Exact, b: Exact): string[] {
  const keys = new Set<string>();
  const boundary = input.stroke.mesh.boundaryEdges;
  const interior = (p: Exact) => !equal(p, a) && !equal(p, b) && within(a, b, p);
  for (let i = 0; i < boundary.length; i += 2) {
    const c = view.strokePoint(boundary[i]!);
    const d = view.strokePoint(boundary[i + 1]!);
    const o1 = orientE(a, b, c);
    const o2 = orientE(a, b, d);
    if (o1 === 0n && interior(c)) keys.add(keyOf(lift(c)));
    if (o2 === 0n && interior(d)) keys.add(keyOf(lift(d)));
    const o3 = orientE(c, d, a);
    const o4 = orientE(c, d, b);
    if (o1 * o2 < 0n && o3 * o4 < 0n) {
      const w = o3 - o4;
      const s = w > 0n ? 1n : -1n;
      keys.add(
        keyOf([s * (a[0] * w + (b[0] - a[0]) * o3), s * (a[1] * w + (b[1] - a[1]) * o3), s * w]),
      );
    }
  }
  return [...keys];
}

/** O02's partition rules over the domain boundary, on the drawn (rounded) positions. */
function partitionFindings(
  input: JointOverlayInput,
  view: OracleView,
  triangles: readonly Triangle3[],
): string[] {
  const findings: string[] = [];
  let total = 0n;
  triangles.forEach((triangle, t) => {
    const o = orientE(
      view.rounded(triangle[0]),
      view.rounded(triangle[1]),
      view.rounded(triangle[2]),
    );
    if (o <= 0n) findings.push(`orientation:${t}`);
    total += o;
  });
  const used = [...new Set(triangles.flat())];
  const byPosition = new Map<string, number>();
  for (const index of used) {
    const p = view.rounded(index);
    const key = `${p[0]}:${p[1]}`;
    const other = byPosition.get(key);
    if (other !== undefined) findings.push(`duplicate-position:${other}:${index}`);
    byPosition.set(key, index);
  }
  const directed = new Map<string, number>();
  for (const [a, b, c] of triangles)
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const)
      directed.set(`${p}:${q}`, (directed.get(`${p}:${q}`) ?? 0) + 1);
  const once: [number, number][] = [];
  for (const [key, count] of directed) {
    const [p, q] = key.split(':').map(Number) as [number, number];
    if (count !== 1) findings.push(`edge-reused:${key}`);
    if (!directed.has(`${q}:${p}`)) once.push([p, q]);
  }
  // Once-used edges lie on the domain boundary, same direction, and chain along each side.
  const boundary = domainBoundary(input, view);
  const onSide: [Exact, Exact, number][][] = boundary.map(() => []);
  for (const [p, q] of once) {
    const P0 = view.rounded(p);
    const Q0 = view.rounded(q);
    const side = boundary.findIndex(
      ([a, b]) =>
        orientE(a, b, P0) === 0n &&
        orientE(a, b, Q0) === 0n &&
        within(a, b, P0) &&
        within(a, b, Q0) &&
        (Q0[0] - P0[0]) * (b[0] - a[0]) + (Q0[1] - P0[1]) * (b[1] - a[1]) > 0n,
    );
    if (side < 0) findings.push(`once-off-boundary:${p}:${q}`);
    else onSide[side]!.push([P0, Q0, q]);
  }
  boundary.forEach(([a, b], side) => {
    const pieces = onSide[side]!;
    const along = (p: Exact) => (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
    pieces.sort((l, r) => (along(l[0]) < along(r[0]) ? -1 : 1));
    let at = a;
    for (const [p, q] of pieces) {
      if (!equal(p, at)) findings.push(`boundary-gap:${side}`);
      at = q;
    }
    if (!equal(at, b)) findings.push(`boundary-open:${side}`);
    // The side is subdivided at exactly its insertion points, computed here independently.
    const found = pieces.slice(0, -1).map(([, , q]) => keyOf(view.unrounded(q)));
    const expected = insertionKeys(input, view, a, b);
    if (found.sort().join() !== expected.sort().join()) findings.push(`boundary-points:${side}`);
  });
  let area = 0n;
  for (const [a, b] of boundary) area += a[0] * b[1] - a[1] * b[0];
  if (total !== area) findings.push(`area:${total}:${area}`);
  // No used vertex in the interior of any used edge.
  const points = used.map((index) => [index, view.rounded(index)] as const);
  for (const key of directed.keys()) {
    const [p, q] = key.split(':').map(Number) as [number, number];
    if (p > q && directed.has(`${q}:${p}`)) continue;
    const A = view.rounded(p);
    const B = view.rounded(q);
    for (const [index, X] of points) {
      if (index === p || index === q || !within(A, B, X)) continue;
      if (orientE(A, B, X) === 0n) findings.push(`t-junction:${index}:${p}:${q}`);
    }
  }
  return findings;
}

/** Exact winding of the stroke boundary loops at a homogeneous point: nonzero is inside. */
function strokeInside(input: JointOverlayInput, view: OracleView, q: H): boolean {
  const b = input.stroke.mesh.boundaryEdges;
  let winding = 0;
  for (let i = 0; i < b.length; i += 2) {
    const c = view.strokePoint(b[i]!);
    const d = view.strokePoint(b[i + 1]!);
    const cy = c[1] * q[2];
    const dy = d[1] * q[2];
    const left = (d[0] - c[0]) * (q[1] - cy) - (q[0] - c[0] * q[2]) * (d[1] - c[1]);
    if (cy <= q[1]) {
      if (dy > q[1] && left > 0n) winding += 1;
    } else if (dy <= q[1] && left < 0n) winding -= 1;
  }
  return winding !== 0;
}

/** True when the stroke edge cd meets the open interior of the positive triangle T. */
function entersInterior(c: Exact, d: Exact, triangle: readonly [H, H, H]): boolean {
  let lo = [0n, 1n] as [bigint, bigint];
  let hi = [1n, 1n] as [bigint, bigint];
  const at = (t: readonly [bigint, bigint]): H => [
    c[0] * t[1] + t[0] * (d[0] - c[0]),
    c[1] * t[1] + t[0] * (d[1] - c[1]),
    t[1],
  ];
  for (let side = 0; side < 3; side += 1) {
    const A = triangle[side]!;
    const B = triangle[(side + 1) % 3]!;
    const alpha = orientH(A, B, lift(c));
    const beta = orientH(A, B, lift(d));
    if (alpha <= 0n && beta <= 0n) return false;
    if (alpha < 0n) {
      const t: [bigint, bigint] = [-alpha, beta - alpha];
      if (t[0] * lo[1] > lo[0] * t[1]) lo = t;
    } else if (beta < 0n) {
      const t: [bigint, bigint] = [alpha, alpha - beta];
      if (t[0] * hi[1] < hi[0] * t[1]) hi = t;
    }
  }
  if (lo[0] * hi[1] >= hi[0] * lo[1]) return false;
  const middle = at([lo[0] * hi[1] + hi[0] * lo[1], 2n * lo[1] * hi[1]]);
  return [0, 1, 2].every(
    (side) => orientH(triangle[side]!, triangle[(side + 1) % 3]!, middle) > 0n,
  );
}

/** Stroke roles from independent exact membership, and one-sidedness, on unrounded positions. */
function membershipFindings(
  input: JointOverlayInput,
  view: OracleView,
  detail: JointOverlayDetail,
): string[] {
  const findings: string[] = [];
  const b = input.stroke.mesh.boundaryEdges;
  const triangles = triplesOf(detail.triangles, 3);
  triangles.forEach((triangle, t) => {
    const corners = triangle.map(view.unrounded) as unknown as [H, H, H];
    if (orientH(corners[0], corners[1], corners[2]) <= 0n) {
      findings.push(`unrounded-orientation:${t}`);
      return;
    }
    // Centroid: (sum X_i / W_i) / 3 as one homogeneous point.
    const w = corners[0][2] * corners[1][2] * corners[2][2];
    const sum = (axis: 0 | 1) =>
      corners[0][axis] * corners[1][2] * corners[2][2] +
      corners[1][axis] * corners[0][2] * corners[2][2] +
      corners[2][axis] * corners[0][2] * corners[1][2];
    const inside = strokeInside(input, view, [sum(0), sum(1), 3n * w]);
    const role = (detail.roles[t]! >> 1) & 1;
    if ((role === 0) !== inside) findings.push(`stroke-role:${t}`);
    for (let i = 0; i < b.length; i += 2)
      if (entersInterior(view.strokePoint(b[i]!), view.strokePoint(b[i + 1]!), corners))
        findings.push(`crossed:${t}:${b[i]}:${b[i + 1]}`);
  });
  return findings;
}

type ParentData = Readonly<{ domain: Triangle3[]; roles: number[]; lists: number[][] }>;

/** The parents' data as the fill variant publishes it (fill lists and roles). */
function parentData(input: JointOverlayInput): ParentData {
  const mesh = input.fill.mesh;
  const region = triplesOf(mesh.indices, 3);
  if (input.fill.fringeBucket === null)
    return { domain: region, roles: region.map(() => 0), lists: region.map(() => []) };
  const built = buildPathFringeDetailed(mesh, input.fill.fringeBucket);
  if (built.result.status !== 'built') throw new Error('fill fringe');
  const fringe = built.result.fringe;
  const records = triplesOf(fringe.triangles, 8).map((triangle, r) => ({
    triangle,
    list: Array.from(
      fringe.lists.subarray(
        fringe.triangles[8 * r + 3],
        fringe.triangles[8 * r + 3]! + fringe.triangles[8 * r + 4]!,
      ),
    ),
  }));
  const lists = records.slice(0, region.length).map((record) => record.list);
  const kept = new Map(records.slice(region.length).map((r) => [r.triangle.join(), r.list]));
  for (const triangle of built.exterior!) lists.push(kept.get(triangle.join()) ?? []);
  return {
    domain: [...region, ...built.exterior!],
    roles: [...region.map(() => 0), ...built.exterior!.map(() => 1)],
    lists,
  };
}

/** Fill lists, fill roles, parent containment, the drop rule and the stroke lists. */
function listFindings(
  input: JointOverlayInput,
  view: OracleView,
  overlay: JointOverlay,
  detail: JointOverlayDetail,
): string[] {
  const findings: string[] = [];
  const parents = parentData(input);
  if (JSON.stringify(detail.domain) !== JSON.stringify(parents.domain)) findings.push('domain');
  const preDrop = triplesOf(detail.triangles, 3);
  // Containment of each unrounded triangle in its parent.
  preDrop.forEach((triangle, t) => {
    const parent = parents.domain[detail.parents[t]!]!.map((i) => lift(view.fillPoint(i)));
    for (const index of triangle) {
      const p = view.unrounded(index);
      for (let side = 0; side < 3; side += 1)
        if (orientH(parent[side]!, parent[(side + 1) % 3]!, p) < 0n)
          findings.push(`outside-parent:${t}`);
    }
  });
  const expectedKept = preDrop
    .map((_, t) => t)
    .filter(
      (t) =>
        !(
          parents.roles[detail.parents[t]!] === 1 && parents.lists[detail.parents[t]!]!.length === 0
        ),
    );
  if (expectedKept.join() !== Array.from(detail.kept).join()) findings.push('drop-rule');
  // Stroke features: the brute-force set is geometric (each boundary edge and vertex of the stroke
  // mesh); each published list entry is decoded through the stroke fringe variant's own feature
  // record (kind and binary32 lanes), so no feature order is re-derived on either side.
  const stroke = input.stroke.mesh;
  const edges: [number, number][] = [];
  for (let i = 0; i < stroke.boundaryEdges.length; i += 2)
    edges.push([stroke.boundaryEdges[i]!, stroke.boundaryEdges[i + 1]!]);
  const vertices = [...new Set(stroke.boundaryEdges)];
  const strokeMid = [
    stroke.bounds.minX / 2 + stroke.bounds.maxX / 2,
    stroke.bounds.minY / 2 + stroke.bounds.maxY / 2,
  ] as const;
  const lane = (s: number, axis: 0 | 1) =>
    Math.fround(stroke.positions[2 * s + axis]! - strokeMid[axis]);
  const edgeKey = ([a, b]: readonly [number, number]) =>
    `E:${lane(a, 0)},${lane(a, 1)},${lane(b, 0)},${lane(b, 1)}`;
  const vertexKey = (v: number) => `V:${lane(v, 0)},${lane(v, 1)}`;
  let published: ((entry: number) => string) | null = null;
  if (input.stroke.fringeBucket !== null) {
    const variant = buildPathFringeDetailed(stroke, input.stroke.fringeBucket).result;
    if (variant.status !== 'built') throw new Error('stroke fringe');
    const words = variant.fringe.features;
    const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
    published = (entry) => {
      const at = 16 * entry;
      if (at >= words.length) return `out-of-range:${entry}`;
      if (words[at] === 0)
        return `E:${floats[at + 1]},${floats[at + 2]},${floats[at + 3]},${floats[at + 4]}`;
      return `V:${floats[at + 2]},${floats[at + 3]}`;
    };
  }
  const q = (p: Exact): Q2 => [rational(p[0]), rational(p[1])];
  const reachValue = input.stroke.fringeBucket === null ? 0 : 2 ** input.stroke.fringeBucket;
  const rho = view.scale(reachValue);
  const reach = rational(rho * rho);
  const box = (points: readonly Exact[]) => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const min = (v: bigint[]) => v.reduce((l, r) => (r < l ? r : l));
    const max = (v: bigint[]) => v.reduce((l, r) => (r > l ? r : l));
    return [min(xs), min(ys), max(xs), max(ys)] as const;
  };
  const near = (l: readonly bigint[], r: readonly bigint[]) =>
    l[0]! - rho <= r[2]! && r[0]! - rho <= l[2]! && l[1]! - rho <= r[3]! && r[1]! - rho <= l[3]!;
  for (let k = 0; k < detail.kept.length; k += 1) {
    const t = detail.kept[k]!;
    const at = 8 * k;
    const words = overlay.triangles;
    const parent = detail.parents[t]!;
    const fillList = Array.from(
      overlay.lists.subarray(words[at + 3], words[at + 3]! + words[at + 4]!),
    );
    if (fillList.join() !== parents.lists[parent]!.join()) findings.push(`fill-list:${t}`);
    if ((words[at + 7]! & 1) !== parents.roles[parent]) findings.push(`fill-role:${t}`);
    if (words[at + 7] !== detail.roles[t]) findings.push(`roles:${t}`);
    const record = [words[at]!, words[at + 1]!, words[at + 2]!];
    if (record.join() !== preDrop[t]!.join()) findings.push(`record:${t}`);
    const strokeList = Array.from(
      overlay.lists.subarray(words[at + 5], words[at + 5]! + words[at + 6]!),
    );
    const expected: string[] = [];
    if (published !== null) {
      const corners = record.map(view.rounded);
      const triangle = corners.map(q) as unknown as readonly [Q2, Q2, Q2];
      const tbox = box(corners);
      for (const edge of edges) {
        const A = view.strokePoint(edge[0]);
        const B = view.strokePoint(edge[1]);
        if (!near(box([A, B]), tbox)) continue;
        if (compare(segmentTriangleDistanceSquared(q(A), q(B), triangle), reach) <= 0)
          expected.push(edgeKey(edge));
      }
      for (const vertex of vertices) {
        const V = view.strokePoint(vertex);
        if (!near(box([V]), tbox)) continue;
        if (compare(pointTriangleDistanceSquared(q(V), triangle), reach) <= 0)
          expected.push(vertexKey(vertex));
      }
    }
    const found = published === null ? strokeList.map(String) : strokeList.map(published);
    // Sorted by (kind, global id): EDGE records precede VERTEX records, indices ascend.
    const ascending = strokeList.every((entry, i) => i === 0 || entry > strokeList[i - 1]!);
    if (!ascending || [...found].sort().join() !== [...expected].sort().join())
      findings.push(`stroke-list:${t}:${found.join(';')}|${expected.join(';')}`);
  }
  return findings;
}

/** The nearest Float64 to the exact value v (fixed units, as X / W), ties to even. */
function isNearest(value: number, X: bigint, W: bigint): boolean {
  const bits = bitsOf(value);
  const up = fromBits(value >= 0 ? bits + 1n : bits - 1n);
  const down = value === 0 ? -Number.MIN_VALUE : fromBits(value > 0 ? bits - 1n : bits + 1n);
  const twice = 2n * X;
  const low = (fixed(down) + fixed(value)) * W;
  const high = (fixed(value) + fixed(up)) * W;
  if (twice < low || twice > high) return false;
  if (twice === low || twice === high) return (bits & 1n) === 0n;
  return true;
}

/** Steiner points: proper crossings, rounded once, frame points on the exact frame coordinate. */
function steinerFindings(
  view: OracleView,
  overlay: JointOverlay,
  detail: JointOverlayDetail,
): string[] {
  const findings: string[] = [];
  const unshift = BigInt(view.shift);
  detail.steiner.forEach((s, j) => {
    const exact = view.unrounded(overlay.fillVertices + j);
    const a = lift(view.fillPoint(s.domainEdge[0]));
    const b = lift(view.fillPoint(s.domainEdge[1]));
    const c = lift(view.strokePoint(s.strokeEdge[0]));
    const d = lift(view.strokePoint(s.strokeEdge[1]));
    if (orientH(a, b, exact) !== 0n || orientH(c, d, exact) !== 0n) findings.push(`off-line:${j}`);
    if (orientH(c, d, a) * orientH(c, d, b) >= 0n || orientH(a, b, c) * orientH(a, b, d) >= 0n)
      findings.push(`not-proper:${j}`);
    const at = 2 * (overlay.fillVertices + j);
    for (const axis of [0, 1] as const) {
      const value = axis === 0 ? s.x : s.y;
      const lane = overlay.positions[at + axis]!;
      if (value === null) {
        // The exact frame coordinate: the domain edge is a frame side with that coordinate.
        const frameValue = view.scale(view.midpoint[axis]) + view.scale(lane);
        if (a[axis] !== frameValue || b[axis] !== frameValue) findings.push(`frame-side:${j}`);
        if (exact[axis] !== frameValue * exact[2]) findings.push(`frame-exact:${j}`);
      } else {
        if (!isNearest(value, exact[axis] << unshift, exact[2]))
          findings.push(`rounding:${j}:${axis}`);
        if (lane !== Math.fround(value - view.midpoint[axis])) findings.push(`lane:${j}:${axis}`);
      }
    }
  });
  return findings;
}

/** Stroke boundary vertices are referenced by bit-31 indices, never copied. */
function indexFindings(
  input: JointOverlayInput,
  view: OracleView,
  detail: JointOverlayDetail,
): string[] {
  const findings: string[] = [];
  const stroke = new Map<string, number>();
  for (const s of new Set(input.stroke.mesh.boundaryEdges)) {
    const p = view.strokePoint(s);
    stroke.set(`${p[0]}:${p[1]}`, s);
  }
  for (const index of new Set(detail.triangles)) {
    const p = view.rounded(index);
    const s = stroke.get(`${p[0]}:${p[1]}`);
    if (index >= STROKE_BIT) {
      if (s !== index - STROKE_BIT) findings.push(`stroke-index:${index}`);
    } else if (s !== undefined) findings.push(`copied-stroke-vertex:${index}:${s}`);
  }
  return findings;
}

type Inspection = Readonly<{
  partition: string[];
  membership: string[];
  lists: string[];
  steiner: string[];
  indices: string[];
}>;

function inspect(
  input: JointOverlayInput,
  overlay: JointOverlay,
  detail: JointOverlayDetail,
): Inspection {
  const view = oracleView(input, overlay, detail);
  return {
    partition: partitionFindings(input, view, triplesOf(detail.triangles, 3)),
    membership: membershipFindings(input, view, detail),
    lists: listFindings(input, view, overlay, detail),
    steiner: steinerFindings(view, overlay, detail),
    indices: indexFindings(input, view, detail),
  };
}

function built(input: JointOverlayInput, seededDefect?: JointOverlaySeededDefect) {
  const run = buildJointOverlayDetailed(input, {
    ...(seededDefect === undefined ? {} : { seededDefect, selfCheck: false }),
  });
  if (run.result.status !== 'built' || run.detail === null)
    throw new Error(`not built: ${JSON.stringify(run.result)}`);
  return { overlay: run.result.overlay, detail: run.detail };
}

const bytesOf = (overlay: JointOverlay) => [
  Array.from(new Uint8Array(overlay.positions.buffer)).join(','),
  Array.from(overlay.triangles).join(','),
  Array.from(overlay.lists).join(','),
];

// ---------------------------------------------------------------------------------------------

describe('ST-A14: the joint overlay builder (ST-U7 addendum section 4.2)', () => {
  for (const fixture of FIXTURES) {
    for (const buckets of fixture.buckets) {
      it(
        `${fixture.id} f=${buckets.join('/')}: partition, one-sided faces, lists, roles, rounding, indices, bytes`,
        { timeout: 60_000 },
        () => {
          const input = inputOf(fixture, buckets);
          const { overlay, detail } = built(input);
          const findings = inspect(input, overlay, detail);
          expect(findings).toEqual({
            partition: [],
            membership: [],
            lists: [],
            steiner: [],
            indices: [],
          });
          // The fill variant's own vertices: K4 offsets of the port vertices, then the corners.
          const fill = input.fill.mesh;
          const n = fill.positions.length / 2;
          const midpoint = [
            fill.bounds.minX / 2 + fill.bounds.maxX / 2,
            fill.bounds.minY / 2 + fill.bounds.maxY / 2,
          ];
          for (let i = 0; i < 2 * n; i += 1)
            expect(overlay.positions[i]).toBe(Math.fround(fill.positions[i]! - midpoint[i % 2]!));
          expect(overlay.fillVertices).toBe(n + (buckets[0] === null ? 0 : 4));
          if (buckets[0] !== null) {
            const fringe = buildPathFringeDetailed(fill, buckets[0]).result;
            expect(fringe.status === 'built' && Array.from(fringe.fringe.corners)).toEqual(
              Array.from(overlay.positions.subarray(2 * n, 2 * n + 8)),
            );
          }
          expect(overlay.positions.length).toBe(2 * (overlay.fillVertices + overlay.steinerPoints));
          // Deterministic bytes.
          const again = buildJointOverlay(input);
          expect(again.status).toBe('built');
          if (again.status === 'built') expect(bytesOf(again.overlay)).toEqual(bytesOf(overlay));
        },
      );
    }
  }

  it('ST7-F14: a Steiner point on a sloped outer edge of a region-only fill is overlay-unsupported', () => {
    for (const buckets of F14.buckets) {
      const result = buildJointOverlay(inputOf(F14, buckets));
      expect(result.status).toBe('unsupported');
      expect(result.status === 'unsupported' && result.reason).toBe('sloped-outer-edge');
    }
  });
});

/** Fixture lookup and the faces of a build, from its detail. */
const fixtureOf = (id: string) => FIXTURES.find((fixture) => fixture.id === id)!;
function facesOf(detail: JointOverlayDetail) {
  const faces = new Map<number, { parent: number; triangles: number; roles: number }>();
  detail.faces.forEach((face, t) => {
    const entry = faces.get(face) ?? {
      parent: detail.parents[t]!,
      triangles: 0,
      roles: detail.roles[t]!,
    };
    entry.triangles += 1;
    faces.set(face, entry);
  });
  return [...faces.values()];
}

describe('ST-A14: each fixture exercises the case it names', () => {
  it('ST7-F1 f=0: frame corners coincide with the ring corners and are referenced as stroke vertices', () => {
    const { overlay, detail } = built(inputOf(fixtureOf('ST7-F1'), [0, -2]));
    // The frame [-1, 11]^2 is the ring's outer loop: its corners are bit-31 indices.
    const used = new Set(detail.triangles);
    for (const corner of [4, 5, 6, 7]) expect(used.has(corner)).toBe(false);
    expect([...used].filter((index) => index >= STROKE_BIT).length).toBeGreaterThanOrEqual(8);
    expect(overlay.steinerPoints).toBe(0);
  });

  it('ST7-F2: the inner ring corners on the shared diagonal split both region triangles', () => {
    for (const buckets of fixtureOf('ST7-F2').buckets) {
      const { detail } = built(inputOf(fixtureOf('ST7-F2'), buckets));
      const stroke = fixtureOf('ST7-F2').stroke;
      const at = (x: number, y: number) => {
        for (let s = 0; s < stroke.positions.length / 2; s += 1)
          if (stroke.positions[2 * s] === x && stroke.positions[2 * s + 1] === y) return s;
        return -1;
      };
      for (const [x, y] of [
        [1, 1],
        [3, 3],
      ] as const) {
        const index = STROKE_BIT + at(x, y);
        const parents = new Set<number>();
        triplesOf(detail.triangles, 3).forEach((triangle, t) => {
          if (triangle.includes(index)) parents.add(detail.parents[t]!);
        });
        expect(parents.has(0) && parents.has(1), `${x},${y}`).toBe(true);
      }
    }
  });

  it('ST7-F4 and ST7-F6: Steiner points are inexact, and frame-edge points keep the frame coordinate', () => {
    for (const id of ['ST7-F4', 'ST7-F6']) {
      let inexact = 0;
      let frame = 0;
      for (const buckets of fixtureOf(id).buckets) {
        const input = inputOf(fixtureOf(id), buckets);
        const { overlay, detail } = built(input);
        const view = oracleView(input, overlay, detail);
        detail.steiner.forEach((s, j) => {
          if (s.x === null || s.y === null) frame += 1;
          const exact = view.unrounded(overlay.fillVertices + j);
          if (exact[2] !== 1n && view.rounded(overlay.fillVertices + j)[0] * exact[2] !== exact[0])
            inexact += 1;
        });
      }
      expect(inexact, id).toBeGreaterThan(0);
      if (id === 'ST7-F4') expect(frame, id).toBeGreaterThan(0);
    }
  });

  it('ST7-F5: fill holes under the stroke: exterior fill pieces with the stroke region role', () => {
    const { detail } = built(inputOf(fixtureOf('ST7-F5'), [-1, -1]));
    expect(Array.from(detail.roles).some((roles) => roles === 1)).toBe(true);
  });

  it('ST7-F7: a region-only stroke has empty stroke lists and still splits the fill', () => {
    for (const buckets of fixtureOf('ST7-F7').buckets) {
      const { overlay } = built(inputOf(fixtureOf('ST7-F7'), buckets));
      expect(overlay.steinerPoints).toBeGreaterThan(0);
      for (let t = 0; t < overlay.triangles.length; t += 8)
        expect(overlay.triangles[t + 6]).toBe(0);
    }
  });

  it('ST7-F8: the closed region-only fill builds with Steiner points on interior edges only', () => {
    for (const buckets of fixtureOf('ST7-F8').buckets) {
      const { overlay } = built(inputOf(fixtureOf('ST7-F8'), buckets));
      expect(overlay.steinerPoints).toBeGreaterThan(0);
      for (let t = 0; t < overlay.triangles.length; t += 8)
        expect(overlay.triangles[t + 4]).toBe(0);
    }
  });

  it('ST7-F9 and ST7-F10: the overlay takes no transform and no colour, so ST7-F1 is reused', () => {
    const f1 = built(inputOf(fixtureOf('ST7-F1'), [-1, -1]));
    const f10 = built(inputOf(fixtureOf('ST7-F10'), [-1, -1]));
    expect(bytesOf(f10.overlay)).toEqual(bytesOf(f1.overlay));
    const f9 = built(inputOf(fixtureOf('ST7-F9'), [-1, -1]));
    expect(f9.overlay.triangles.length).toBe(f1.overlay.triangles.length);
  });

  it('ST7-F13: the convex corner triangle holds a reflex face of at least five triangles', () => {
    for (const buckets of fixtureOf('ST7-F13').buckets) {
      const { detail } = built(inputOf(fixtureOf('ST7-F13'), buckets));
      const lower = facesOf(detail).filter((face) => face.parent === 0);
      expect(lower.length).toBe(2);
      expect(Math.max(...lower.map((face) => face.triangles))).toBeGreaterThanOrEqual(5);
    }
  });

  it('ST7-F15: the ring inside one triangle gives three faces, two of them with holes, bridged', () => {
    for (const buckets of fixtureOf('ST7-F15').buckets) {
      const { detail } = built(inputOf(fixtureOf('ST7-F15'), buckets));
      const faces = facesOf(detail).filter((face) => face.parent === 0);
      expect(faces.length).toBe(3);
      // Outer face: triangle minus a square (3 + 4 vertices, one hole): 3 + 4 + 2 - 2 = 7.
      // Ring: 4 + 4 vertices, one hole: 8. Inner square: 2.
      expect(faces.map((face) => face.triangles).sort((a, b) => a - b)).toEqual([2, 7, 8]);
      expect(faces.map((face) => (face.roles >> 1) & 1).sort()).toEqual([0, 1, 1]);
    }
  });
});

/** Every fixture build the seeded defect changes, with the named check's findings. */
function defectRuns(defect: JointOverlaySeededDefect) {
  const runs: Array<{ name: string; input: JointOverlayInput; inspection: Inspection }> = [];
  // The large region-only fixtures ST7-F7 and ST7-F8 are left out to bound the run time.
  for (const fixture of FIXTURES.filter(({ id }) => id !== 'ST7-F7' && id !== 'ST7-F8'))
    for (const buckets of fixture.buckets) {
      const input = inputOf(fixture, buckets);
      const name = `${fixture.id} ${buckets.join('/')}`;
      const clean = built(input);
      const seeded = buildJointOverlayDetailed(input, { seededDefect: defect, selfCheck: false });
      // Without its own check the seeded builder still publishes, so the oracle sees the defect.
      if (seeded.result.status !== 'built') throw new Error(`${defect} ${name}: not built`);
      const changed =
        JSON.stringify(bytesOf(seeded.result.overlay)) !== JSON.stringify(bytesOf(clean.overlay)) ||
        Array.from(seeded.detail!.triangles).join() !== Array.from(clean.detail.triangles).join() ||
        Array.from(seeded.detail!.roles).join() !== Array.from(clean.detail.roles).join();
      if (!changed) continue;
      runs.push({ name, input, inspection: inspect(input, seeded.result.overlay, seeded.detail!) });
    }
  return runs;
}

describe('ST-A14 seeded defects (addendum section 5.6)', () => {
  const cases: ReadonlyArray<readonly [JointOverlaySeededDefect, keyof Inspection, boolean]> = [
    // [defect, the named check that must fail, whether the builder's own check also refuses it]
    ['ST7-D3', 'partition', true],
    ['ST7-D4', 'membership', false],
    ['ST7-D5', 'lists', false],
    ['ST7-D6', 'partition', true],
    ['ST7-D11', 'partition', true],
  ];
  for (const [defect, check, selfChecked] of cases) {
    it(
      `${defect} fails the ${check} check on every fixture it changes`,
      { timeout: 120_000 },
      () => {
        const runs = defectRuns(defect);
        expect(runs.length, `${defect} changes no fixture`).toBeGreaterThan(0);
        for (const run of runs) {
          expect(run.inspection[check].length, run.name).toBeGreaterThan(0);
          // With its own exact partition check on, the builder refuses the same defect.
          const result = buildJointOverlay(run.input, { seededDefect: defect });
          if (selfChecked)
            expect(result.status === 'unsupported' && result.reason, run.name).toMatch(
              /^partition:/,
            );
          else expect(result.status, run.name).toBe('built');
        }
      },
    );
  }
});

describe('ST7-Q5 (a): the overlay work cap, at the builder', () => {
  it('a build at its exact counts builds; one fewer test or Steiner point is overlay-unsupported', () => {
    const input = inputOf(fixtureOf('ST7-F6'), [-1, -1]);
    const reference = buildJointOverlay(input);
    if (reference.status !== 'built') throw new Error('reference');
    const { exactTests, steinerPoints } = reference.overlay.work;
    expect(exactTests).toBeGreaterThan(0);
    expect(steinerPoints).toBeGreaterThan(0);
    expect(exactTests).toBeLessThanOrEqual(JOINT_OVERLAY_LIMITS.exactTests);
    const at = buildJointOverlay(input, { limits: { exactTests, steinerPoints } });
    expect(at.status).toBe('built');
    if (at.status === 'built') expect(bytesOf(at.overlay)).toEqual(bytesOf(reference.overlay));
    const tests = buildJointOverlay(input, { limits: { exactTests: exactTests - 1 } });
    expect(tests.status === 'unsupported' && tests.reason).toBe('work-cap:tests');
    const steiner = buildJointOverlay(input, { limits: { steinerPoints: steinerPoints - 1 } });
    expect(steiner.status === 'unsupported' && steiner.reason).toBe('work-cap:steiner');
  });

  it('the fill fringe re-run counts inside the cap and leaves the fringe bytes unchanged', () => {
    const mesh = fixtureOf('ST7-F6').fill;
    const plain = buildPathFringeDetailed(mesh, -1);
    const work = { tests: 0, testLimit: Number.POSITIVE_INFINITY };
    const counted = buildPathFringeDetailed(mesh, -1, work);
    expect(work.tests).toBeGreaterThan(0);
    expect(JSON.stringify(counted.exterior)).toBe(JSON.stringify(plain.exterior));
    if (plain.result.status !== 'built' || counted.result.status !== 'built')
      throw new Error('fringe');
    for (const key of ['corners', 'triangles', 'lists', 'features'] as const)
      expect(Array.from(counted.result.fringe[key])).toEqual(Array.from(plain.result.fringe[key]));
  });

  it('many small rings in one large triangle exhaust the exact-test cap (holes, angles, bridges)', () => {
    // 16 x 16 square rings inside one region triangle: one face with 246 holes.
    const rings: FillMesh[] = [];
    for (let i = 0; i < 16; i += 1)
      for (let j = 0; j < 16; j += 1) {
        const x = 10 + 6 * i;
        const y = 10 + 6 * j;
        if (x + y > 180) continue;
        rings.push(ringMesh(rectangle(x, y, x + 4, y + 4), rectangle(x + 1, y + 1, x + 3, y + 3)));
      }
    const positions: number[] = [];
    const indices: number[] = [];
    const boundary: number[] = [];
    for (const ring of rings) {
      const base = positions.length / 2;
      positions.push(...ring.positions);
      indices.push(...Array.from(ring.indices, (v) => v + base));
      boundary.push(...Array.from(ring.boundaryEdges, (v) => v + base));
    }
    const xs = positions.filter((_, i) => i % 2 === 0);
    const ys = positions.filter((_, i) => i % 2 === 1);
    const stroke: FillMesh = {
      positions: Float64Array.from(positions),
      indices: Uint32Array.from(indices),
      boundaryEdges: Uint32Array.from(boundary),
      bounds: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      },
    };
    const fill = meshOf(
      [
        [0, 0],
        [200, 0],
        [0, 200],
      ],
      [[0, 1, 2]],
    );
    const result = buildJointOverlay({
      fill: { mesh: fill, fringeBucket: null },
      stroke: { mesh: stroke, fringeBucket: null },
    });
    expect(result.status === 'unsupported' && result.reason).toBe('work-cap:tests');
    expect(result.status === 'unsupported' && result.work.exactTests).toBe(
      JOINT_OVERLAY_LIMITS.exactTests + 1,
    );
  }, 120_000);
});

describe('section 4.2 step 6 positive control (review S1)', () => {
  it('Steiner points on an axis-aligned outer edge of a region-only fill keep their coordinate', () => {
    for (const buckets of fixtureOf('U7b-axis-outer').buckets) {
      const { overlay, detail } = built(inputOf(fixtureOf('U7b-axis-outer'), buckets));
      const onBottom = detail.steiner.filter((s) => s.y === 0);
      expect(onBottom.length).toBe(4);
      expect(onBottom.some((s) => s.x !== null && ![1.5, 2.5, 2.7].includes(s.x))).toBe(true);
      expect(overlay.steinerPoints).toBeGreaterThanOrEqual(4);
    }
  });
});
