import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inspectTriangleMesh } from '../../../packages/geometry-reference/src/triangle-mesh.js';
import { verifyConformingRefinement } from '../conforming-mesh/oracle.js';
import { roundExact32 } from '../mesh-projection/audit.js';
import type { ProjectionFixture } from '../mesh-projection/fixtures.js';
import type { ProjectionInput } from '../mesh-projection/model.js';
import { loadFixtureRows, sha256 } from '../position-certificate/corpus.js';
import {
  absolute,
  add,
  compare,
  fromBits,
  mul,
  rational,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import { dyadicExponent, f32Bits, q32Bits, q64 } from './numeric.js';

/**
 * P3.1o O01 positions (docs/plans/p3-o01-coverage-experiment-contract.md, "Position and distance
 * path"). For each vertex: the exact K reference R = ((a x + c y + e - camX) zoom dpr, ...), the
 * once-rounded binary32 NDC words of 2 Rx / W - 1 and 1 - 2 Ry / H, and their exact dyadic
 * preimage rx = (ndcX + 1) W / 2, ry = (1 - ndcY) H / 2. The reference region of a row is the union
 * of its triangles over the preimage vertices.
 */

export type Q2 = readonly [Rational, Rational];
export type BoundaryEdge = Readonly<{ a: number; b: number; third: number; triangle: number }>;
export type InternalEdge = Readonly<{ a: number; b: number; triangles: readonly [number, number] }>;

export type CoverageRowGeometry = Readonly<{
  id: string;
  width: number;
  height: number;
  /** Triangles as vertex index triples, in input order. */
  triangles: readonly (readonly [number, number, number])[];
  /** Vertex indices referenced by some triangle, ascending. */
  referenced: readonly number[];
  /** Exact K reference physical position R per vertex. */
  reference: readonly Q2[];
  /** Once-rounded binary32 NDC values per vertex (JS numbers holding f32 values). */
  ndc: readonly (readonly [number, number])[];
  /** The uint32 words of `ndc`. */
  ndcBits: readonly (readonly [number, number])[];
  /** Exact dyadic preimage of the NDC words, physical pixels, y down. */
  preimage: readonly Q2[];
  /** k such that every preimage coordinate times 2^k is an integer (k >= 1). */
  scaleExponent: number;
  /** preimage * 2^k as integers. */
  scaled: readonly (readonly [bigint, bigint])[];
  /** Index pairs used by exactly one triangle; a < b; sorted by (a, b). */
  boundaryEdges: readonly BoundaryEdge[];
  /** Index pairs used by two triangles; a < b; sorted by (a, b). */
  internalEdges: readonly InternalEdge[];
  /** Exact maximum over referenced vertices of |preimage - R|^2 (Euclidean) and per-axis |.|. */
  maxPreimageError: Readonly<{ squared: Rational; axis: Rational; vertex: number }>;
}>;

export type Unsupported = Readonly<{ unsupported: string }>;

const ONE = rational(1n);
const TWO = rational(2n);

function bboxOf(vertices: readonly (readonly [number, number])[]) {
  const xs = vertices.map((v) => v[0]);
  const ys = vertices.map((v) => v[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
}

/** INPUT_UNSUPPORTED reason for the original local mesh, or null when it passes. */
export function meshConformity(mesh: ProjectionInput['mesh']): string | null {
  try {
    const inspection = inspectTriangleMesh({
      vertices: mesh.vertices,
      indices: mesh.indices,
      bounds: bboxOf(mesh.vertices),
    });
    if (!inspection.valid) return `inspect:${inspection.issue}`;
  } catch (error) {
    return `inspect:${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const parents = Array.from({ length: mesh.indices.length / 3 }, (_, index) => index);
    verifyConformingRefinement(mesh, { ...mesh, parentTriangle: parents });
  } catch (error) {
    return `conforming:${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/** Exact K original-input reference position of every vertex. */
export function referencePositions(input: ProjectionInput): Q2[] {
  const [a, b, c, d, e, f] = input.affine.map(q64) as [
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const scale = mul(q64(input.zoom), q64(input.dpr));
  const camX = q64(input.camera[0]);
  const camY = q64(input.camera[1]);
  return input.mesh.vertices.map(([vx, vy]) => {
    const x = q64(vx);
    const y = q64(vy);
    return [
      mul(sub(add(add(mul(a, x), mul(c, y)), e), camX), scale),
      mul(sub(add(add(mul(b, x), mul(d, y)), f), camY), scale),
    ] as const;
  });
}

function orient(
  p: readonly [bigint, bigint],
  q: readonly [bigint, bigint],
  r: readonly [bigint, bigint],
) {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

export function coverageRowGeometry(input: ProjectionInput): CoverageRowGeometry | Unsupported {
  const conformity = meshConformity(input.mesh);
  if (conformity !== null) return { unsupported: `INPUT_UNSUPPORTED:${conformity}` };
  const W = rational(BigInt(input.width));
  const H = rational(BigInt(input.height));
  const reference = referencePositions(input);
  const triangles: [number, number, number][] = [];
  for (let offset = 0; offset < input.mesh.indices.length; offset += 3)
    triangles.push([
      input.mesh.indices[offset]!,
      input.mesh.indices[offset + 1]!,
      input.mesh.indices[offset + 2]!,
    ]);
  const referenced = [...new Set(input.mesh.indices)].sort((x, y) => x - y);
  const ndc: [number, number][] = [];
  const ndcBits: [number, number][] = [];
  const preimage: Q2[] = [];
  for (const [rx, ry] of reference) {
    const ndcXExact = sub(mul(TWO, mul(rx, rational(1n, BigInt(input.width)))), ONE);
    const ndcYExact = sub(ONE, mul(TWO, mul(ry, rational(1n, BigInt(input.height)))));
    const x = roundExact32(ndcXExact);
    const y = roundExact32(ndcYExact);
    const bits: [number, number] = [f32Bits(x), f32Bits(y)];
    ndc.push([x, y]);
    ndcBits.push(bits);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      preimage.push([rational(0n), rational(0n)]);
      continue;
    }
    preimage.push([
      mul(add(q32Bits(bits[0]), ONE), mul(W, rational(1n, 2n))),
      mul(sub(ONE, q32Bits(bits[1])), mul(H, rational(1n, 2n))),
    ]);
  }
  for (const vertex of referenced)
    if (!ndc[vertex]!.every(Number.isFinite))
      return { unsupported: `INPUT_UNSUPPORTED:ndc-overflow:${vertex}` };

  let k = 1;
  for (const vertex of referenced)
    for (const value of preimage[vertex]!) k = Math.max(k, dyadicExponent(value));
  const scaled = preimage.map(
    ([x, y]) =>
      [
        x.n * (1n << BigInt(k - dyadicExponent(x))),
        y.n * (1n << BigInt(k - dyadicExponent(y))),
      ] as const,
  );

  // The preimage triangles must keep one consistent nonzero orientation, otherwise the union is not
  // the parity region of the boundary edges.
  let orientation = 0n;
  for (let t = 0; t < triangles.length; t += 1) {
    const [p, q, r] = triangles[t]!;
    const value = orient(scaled[p]!, scaled[q]!, scaled[r]!);
    const s = value > 0n ? 1n : value < 0n ? -1n : 0n;
    if (s === 0n || (orientation !== 0n && s !== orientation))
      return { unsupported: `INPUT_UNSUPPORTED:preimage-orientation:${t}` };
    orientation = s;
  }

  const uses = new Map<
    string,
    { a: number; b: number; entries: { triangle: number; third: number }[] }
  >();
  triangles.forEach((triangle, t) => {
    for (let side = 0; side < 3; side += 1) {
      const p = triangle[side]!;
      const q = triangle[(side + 1) % 3]!;
      const third = triangle[(side + 2) % 3]!;
      const a = Math.min(p, q);
      const b = Math.max(p, q);
      const key = `${a}:${b}`;
      const entry = uses.get(key) ?? { a, b, entries: [] };
      entry.entries.push({ triangle: t, third });
      uses.set(key, entry);
    }
  });
  const edges = [...uses.values()].sort((x, y) => x.a - y.a || x.b - y.b);
  const boundaryEdges: BoundaryEdge[] = [];
  const internalEdges: InternalEdge[] = [];
  for (const edge of edges) {
    if (edge.entries.length === 1)
      boundaryEdges.push({
        a: edge.a,
        b: edge.b,
        third: edge.entries[0]!.third,
        triangle: edge.entries[0]!.triangle,
      });
    else if (edge.entries.length === 2)
      internalEdges.push({
        a: edge.a,
        b: edge.b,
        triangles: [edge.entries[0]!.triangle, edge.entries[1]!.triangle],
      });
    else return { unsupported: `INPUT_UNSUPPORTED:edge-multiplicity:${edge.a}:${edge.b}` };
  }

  let squared = rational(0n);
  let axis = rational(0n);
  let worst = referenced[0]!;
  for (const vertex of referenced) {
    const dx = sub(preimage[vertex]![0], reference[vertex]![0]);
    const dy = sub(preimage[vertex]![1], reference[vertex]![1]);
    const value = add(mul(dx, dx), mul(dy, dy));
    if (compare(value, squared) > 0) {
      squared = value;
      worst = vertex;
    }
    for (const component of [absolute(dx), absolute(dy)])
      if (compare(component, axis) > 0) axis = component;
  }

  return {
    id: input.id,
    width: input.width,
    height: input.height,
    triangles,
    referenced,
    reference,
    ndc,
    ndcBits,
    preimage,
    scaleExponent: k,
    scaled,
    boundaryEdges,
    internalEdges,
    maxPreimageError: { squared, axis, vertex: worst },
  };
}

// ---------------------------------------------------------------------------------------------
// Rows.

export type CoverageRow = Readonly<{
  rowIndex: number;
  id: string;
  kind: 'fixture' | 'literal';
  input: ProjectionInput;
}>;

/** The exact LINEARS R15 bits of tests/geometry/mesh-projection/fixtures.ts. */
export const R15_LINEAR = [
  fromBits(0x3feee8dd4748bf15n),
  fromBits(0x3fd0907dc1930690n),
  fromBits(0xbfd0907dc1930690n),
  fromBits(0x3feee8dd4748bf15n),
] as const;
export const LITERAL_TRANSLATION = [10.265625, 10.7734375] as const;
const IDENTITY = [1, 0, 0, 1] as const;

function literal(
  id: string,
  zoom: number,
  linear: readonly [number, number, number, number],
  vertices: readonly (readonly [number, number])[],
  triangles: readonly (readonly [number, number, number])[],
): ProjectionInput {
  return {
    id,
    mesh: { vertices: vertices.map(([x, y]) => [x, y] as const), indices: triangles.flat() },
    // K applies (a x + c y + e - camX) * zoom * dpr: linear part, then translation, then zoom.
    affine: [...linear, ...LITERAL_TRANSLATION],
    camera: [0, 0],
    origin: [0, 0],
    zoom,
    dpr: 1,
    width: 640,
    height: 360,
  };
}

const F07 = {
  vertices: [
    [0, 0],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
    [0, 2],
  ],
  triangles: [
    [0, 1, 4],
    [0, 4, 5],
    [1, 2, 3],
    [1, 3, 4],
  ],
} as const;
const F11 = {
  vertices: [
    [0, 0],
    [4, 0],
    [4, 4],
    [2, 4],
    [0, 4],
    [6, 4],
    [6, 8],
    [2, 8],
  ],
  triangles: [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 4],
    [3, 2, 7],
    [2, 5, 6],
    [2, 6, 7],
  ],
} as const;
const SQ = {
  vertices: [
    [0, 0],
    [37.5, 0],
    [37.5, 21.25],
    [0, 21.25],
  ],
  triangles: [
    [0, 1, 2],
    [0, 2, 3],
  ],
} as const;
const THIN = {
  vertices: [
    [0, 0],
    [40, 0],
    [40, 0.3125],
    [0, 0.3125],
  ],
  triangles: SQ.triangles,
} as const;

/** The six literal rows of the contract table, in table order. */
export function literalRows(): readonly ProjectionInput[] {
  return [
    literal('F07-Z16', 16, IDENTITY, F07.vertices, F07.triangles),
    literal('F07-Z16R15', 16, R15_LINEAR, F07.vertices, F07.triangles),
    literal('F11-Z8', 8, IDENTITY, F11.vertices, F11.triangles),
    literal('SQ-Z1', 1, IDENTITY, SQ.vertices, SQ.triangles),
    literal('SQ-Z1R15', 1, R15_LINEAR, SQ.vertices, SQ.triangles),
    literal('THIN-Z1', 1, IDENTITY, THIN.vertices, THIN.triangles),
  ];
}

export const R0A_REPORT = {
  path: 'docs/evidence/p3.1n-r0a-wedge/report.json',
  sha256: 'a25b53af41db7b5600fcaba3d7a687e0ad4ce3f28cd191f4a7f8f34c7e3f77cc',
  admitted: 143,
} as const;

/** loadFixtureRows() filtered to the R0a `policy: fixture, status: ADMITTED` ids, corpus order. */
export function admittedFixtureRows(): readonly ProjectionFixture[] {
  const bytes = readFileSync(path.resolve(R0A_REPORT.path));
  const actual = sha256(bytes);
  if (actual !== R0A_REPORT.sha256) throw new Error(`pinned:${R0A_REPORT.path}:${actual}`);
  const report = JSON.parse(bytes.toString('utf8')) as {
    rows: readonly { id: string; policy: string; status: string }[];
  };
  const admitted = new Set(
    report.rows
      .filter((row) => row.policy === 'fixture' && row.status === 'ADMITTED')
      .map((row) => row.id),
  );
  const fixtures = loadFixtureRows();
  const rows = fixtures.filter((fixture) => admitted.has(fixture.id));
  if (admitted.size !== R0A_REPORT.admitted || rows.length !== R0A_REPORT.admitted)
    throw new Error(`r0a:admitted-count:${admitted.size}:${rows.length}`);
  return rows;
}

/** The O01 corpus: the 143 admitted fixture rows (corpus order), then the six literal rows. */
export function coverageCorpus(): readonly CoverageRow[] {
  const fixtures = admittedFixtureRows().map((fixture) => ({
    id: fixture.id,
    kind: 'fixture' as const,
    input: fixture.input,
  }));
  const literals = literalRows().map((input) => ({
    id: input.id,
    kind: 'literal' as const,
    input,
  }));
  return [...fixtures, ...literals].map((row, rowIndex) => ({ rowIndex, ...row }));
}
