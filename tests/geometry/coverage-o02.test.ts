import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectionInput } from './mesh-projection/model.js';
import { encodeInput } from './position-certificate/corpus.js';
import { add, compare, rational, sub, toNumber } from './rounded-fill/exact.js';
import {
  decodeO02Passes,
  loadO02Capture,
  type O02CaptureCrop,
  type O02CaptureRow,
} from './coverage-oracle/capture-schema-o02.js';
import { cropFor } from './coverage-oracle/crop.js';
import {
  checkPartition,
  exteriorMesh,
  orient,
  pointSegmentDistanceSquared,
  pointTriangleDistanceSquared,
  projectLocalVertices,
  sectorsOf,
  segmentTriangleDistanceSquared,
  vertexSectors,
  type ExteriorMesh,
  type P,
} from './coverage-oracle/exterior.js';
import {
  centersInTriangle,
  distanceFlags,
  drawObservations,
  WITHIN_1,
} from './coverage-oracle/metrics-o02.js';
import { coverageOracle } from './coverage-oracle/oracle.js';
import {
  coverageCorpus,
  coverageRowGeometry,
  type CoverageRowGeometry,
  type Q2,
} from './coverage-oracle/positions.js';
import { encodeRleBase64, sampleSha256 } from './coverage-oracle/rle.js';
import {
  boundaryDistanceSquared,
  ruleAtPixel,
  ruleContext,
  ruleCoverage,
} from './coverage-oracle/rule.js';
import {
  ACCEPTANCE_DPRS,
  O02_DPRS,
  o02Variants,
  variantInput,
  variantStatus,
} from './coverage-oracle/variants.js';

// P3.1o O02 A5 coverage rule: docs/plans/p3-o02-a5-coverage-contract.md.

function shape(
  id: string,
  vertices: readonly (readonly [number, number])[],
  triangles: readonly (readonly [number, number, number])[],
  translation: readonly [number, number] = [40.3, 30.7],
  zoom = 4,
): ProjectionInput {
  return {
    id,
    mesh: { vertices, indices: triangles.flat() },
    affine: [1, 0, 0, 1, ...translation],
    camera: [0, 0],
    origin: [0, 0],
    zoom,
    dpr: 1,
    width: 640,
    height: 360,
  };
}

const star = (() => {
  // Even-odd star: 5 tips, each the triangle (outer i, pentagon corner i, corner i + 1); tips
  // touch at the pentagon corners, enclosing a pentagon pocket.
  const outer: [number, number][] = [];
  const inner: [number, number][] = [];
  for (let i = 0; i < 5; i += 1) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / 5;
    const b = a + Math.PI / 5;
    outer.push([10 + 9 * Math.cos(a), 10 + 9 * Math.sin(a)]);
    inner.push([
      10 + 3.5 * Math.cos(b - (2 * Math.PI) / 5),
      10 + 3.5 * Math.sin(b - (2 * Math.PI) / 5),
    ]);
  }
  // Tip i spans corners i and i + 1 around outer point i.
  const vertices = [...outer, ...inner];
  const triangles: [number, number, number][] = [];
  for (let i = 0; i < 5; i += 1) triangles.push([i, 5 + ((i + 1) % 5), 5 + i]);
  return { vertices, triangles };
})();

const SHAPES: readonly ProjectionInput[] = [
  shape(
    'convex-square',
    [
      [0, 0],
      [6, 0],
      [6, 6],
      [0, 6],
    ],
    [
      [0, 1, 2],
      [0, 2, 3],
    ],
  ),
  shape(
    'concave-L',
    [
      [0, 0],
      [8, 0],
      [8, 3],
      [3, 3],
      [3, 8],
      [0, 8],
    ],
    [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 5],
    ],
  ),
  shape(
    'square-with-hole',
    [
      [0, 0],
      [9, 0],
      [9, 9],
      [0, 9],
      [3, 3],
      [6, 3],
      [6, 6],
      [3, 6],
    ],
    [
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
    ],
  ),
  shape(
    'bowtie-pinch',
    [
      [0, 0],
      [6, 0],
      [3, 3],
      [0, 6],
      [6, 6],
    ],
    [
      [0, 1, 2],
      [2, 4, 3],
    ],
  ),
  shape('evenodd-star', star.vertices, star.triangles, [40.3, 30.7], 2),
  shape(
    'zero-closure-ring',
    // Four squares touching corner to corner around an enclosed square pocket [2,4]^2.
    [
      [0, 2],
      [2, 2],
      [2, 4],
      [0, 4],
      [2, 0],
      [4, 0],
      [4, 2],
      [6, 2],
      [6, 4],
      [4, 4],
      [4, 6],
      [2, 6],
    ],
    [
      [0, 1, 2],
      [0, 2, 3],
      [4, 5, 6],
      [4, 6, 1],
      [6, 7, 8],
      [6, 8, 9],
      [2, 9, 10],
      [2, 10, 11],
    ],
  ),
  shape(
    'collinear-boundary',
    // F07-like: a rectangle with collinear boundary vertices on two sides and a fan.
    [
      [0, 0],
      [2, 0],
      [4, 0],
      [6, 0],
      [6, 3],
      [3, 3],
      [0, 3],
    ],
    [
      [0, 1, 6],
      [1, 5, 6],
      [1, 2, 5],
      [2, 4, 5],
      [2, 3, 4],
    ],
  ),
];

function geometryOf(input: ProjectionInput): CoverageRowGeometry {
  const geometry = coverageRowGeometry(input);
  if ('unsupported' in geometry) throw new Error(geometry.unsupported);
  return geometry;
}

function meshOf(input: ProjectionInput): ExteriorMesh {
  const mesh = exteriorMesh(input, geometryOf(input));
  if (mesh.status !== 'OK') throw new Error(mesh.reason);
  return mesh;
}

function twiceArea(points: readonly P[], triangles: readonly (readonly number[])[]): bigint {
  let sum = 0n;
  for (const [a, b, c] of triangles) {
    const value = orient(points[a!]!, points[b!]!, points[c!]!);
    sum += value < 0n ? -value : value;
  }
  return sum;
}

// ---------------------------------------------------------------------------------------------
// Float brute force of the rule: nearest point over closed segments, sign by point-in-triangle.

function toFloat(point: Q2): [number, number] {
  return [toNumber(point[0]), toNumber(point[1])];
}

function bruteRule(geometry: CoverageRowGeometry, x: number, y: number) {
  let best = Infinity;
  let vx = 0;
  let vy = 0;
  for (const edge of geometry.boundaryEdges) {
    const [ax, ay] = toFloat(geometry.preimage[edge.a]!);
    const [bx, by] = toFloat(geometry.preimage[edge.b]!);
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    const qx = ax + t * ex;
    const qy = ay + t * ey;
    const d = Math.hypot(x - qx, y - qy);
    if (d < best) {
      best = d;
      vx = x - qx;
      vy = y - qy;
    }
  }
  let inside = false;
  for (const [a, b, c] of geometry.triangles) {
    const [p, q, r] = [a, b, c].map((v) => toFloat(geometry.preimage[v]!)) as [
      [number, number],
      [number, number],
      [number, number],
    ];
    const o = (u: [number, number], w: [number, number]) =>
      (w[0] - u[0]) * (y - u[1]) - (w[1] - u[1]) * (x - u[0]);
    const s = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const signs = [o(p, q), o(q, r), o(r, p)].map((value) => value * Math.sign(s));
    if (signs.every((value) => value > 0)) inside = true;
  }
  const s = (inside ? -1 : 1) * best;
  const w = (Math.abs(vx) + Math.abs(vy)) / best;
  return { distance: best, c: Math.min(1, Math.max(0, 0.5 - s / w)) };
}

/** Deterministic pseudo-random sequence (LCG) in [0, 1). */
function sequence(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// ---------------------------------------------------------------------------------------------

describe('P3.1o O02 exterior triangulation on synthetic shapes', () => {
  for (const input of SHAPES)
    it(input.id, () => {
      const geometry = geometryOf(input);
      const mesh = meshOf(input);
      const all = [...mesh.regionTriangles, ...mesh.exteriorTriangles];
      expect(checkPartition(mesh.scaled, all, mesh.frameIndices)).toBeNull();
      const frameArea = twiceArea(mesh.scaled, [
        [mesh.frameIndices[0], mesh.frameIndices[1], mesh.frameIndices[2]],
        [mesh.frameIndices[0], mesh.frameIndices[2], mesh.frameIndices[3]],
      ]);
      expect(
        twiceArea(mesh.scaled, mesh.regionTriangles) +
          twiceArea(mesh.scaled, mesh.exteriorTriangles),
      ).toBe(frameArea);
      // The exterior reuses the boundary vertices and the frame corners only (no Steiner point).
      const boundary = new Set(geometry.boundaryEdges.flatMap((edge) => [edge.a, edge.b]));
      for (const v of mesh.exteriorTriangles.flat())
        expect(boundary.has(v) || mesh.frameIndices.includes(v)).toBe(true);
      // The region triangles' orientation is kept.
      const sign = (t: readonly number[]) =>
        orient(mesh.scaled[t[0]!]!, mesh.scaled[t[1]!]!, mesh.scaled[t[2]!]!) > 0n;
      for (const t of mesh.exteriorTriangles) expect(sign(t)).toBe(sign(mesh.regionTriangles[0]!));
      // The frame is the physical boundary box +-2 px rounded outward, then projected.
      expect(mesh.vertices.length).toBe(input.mesh.vertices.length + 4);
      expect(mesh.frame.maxNdcMagnitude).toBeLessThan(2);
    });

  it('reports a sliver-free pocket for the even-odd star and the zero-closure ring', () => {
    for (const id of ['evenodd-star', 'zero-closure-ring']) {
      const mesh = meshOf(SHAPES.find((input) => input.id === id)!);
      // The pocket is covered: some exterior triangle has all three corners on the region boundary.
      expect(
        mesh.exteriorTriangles.some((t) => t.every((v) => !mesh.frameIndices.includes(v))),
      ).toBe(true);
    }
  });

  it('finds the sectors of a pinch vertex', () => {
    const geometry = geometryOf(SHAPES.find((input) => input.id === 'bowtie-pinch')!);
    const sectors = vertexSectors(geometry);
    if (sectors.status !== 'OK') throw new Error(sectors.reason);
    const pinch = sectors.vertices.find((entry) => entry.vertex === 2)!;
    expect(pinch.sectors.length).toBe(2);
    for (const sector of pinch.sectors) {
      expect(sector.rOut[0]).toBe(2);
      expect(sector.rIn[1]).toBe(2);
      expect(sector.reflex).toBe(false);
      // rOut and rIn belong to the same triangle.
      const triangle = geometry.triangles.find((t) =>
        [sector.rOut[1], sector.rIn[0], 2].every((v) => t.includes(v)),
      );
      expect(triangle).toBeDefined();
    }
    for (const entry of sectors.vertices)
      if (entry.vertex !== 2) expect(entry.sectors.length).toBe(1);
    // The concave L has exactly one reflex sector, at the inner corner.
    const L = vertexSectors(geometryOf(SHAPES.find((input) => input.id === 'concave-L')!));
    if (L.status !== 'OK') throw new Error(L.reason);
    expect(L.vertices.filter((entry) => entry.sectors[0]!.reflex).map((e) => e.vertex)).toEqual([
      3,
    ]);
  });

  it('rejects a vertex with more than three sectors and a duplicate coordinate', () => {
    // Four triangles meeting only at their common apex: degree 8, four sectors.
    const fan = shape(
      'degree-8',
      [
        [5, 5],
        [9, 4],
        [9, 6],
        [4, 9],
        [6, 9],
        [1, 6],
        [1, 4],
        [6, 1],
        [4, 1],
      ],
      [
        [0, 1, 2],
        [0, 4, 3],
        [0, 5, 6],
        [0, 8, 7],
      ],
    );
    const result = exteriorMesh(fan, geometryOf(fan));
    expect(result.status === 'OK' ? 'OK' : result.reason).toBe('VERTEX_UNSUPPORTED:degree:0:8');
    // Two triangles touching at a point through two distinct vertex indices.
    const twins = shape(
      'duplicate',
      [
        [0, 0],
        [4, 0],
        [2, 2],
        [2, 2],
        [4, 4],
        [0, 4],
      ],
      [
        [0, 1, 2],
        [3, 4, 5],
      ],
    );
    // O01 conformity rejects a duplicate local coordinate first ...
    const geometry = coverageRowGeometry(twins);
    expect('unsupported' in geometry && geometry.unsupported).toMatch(/^INPUT_UNSUPPORTED:/u);
    // ... so a preimage collision is exercised on the sector pairing directly.
    const points: P[] = [
      [0n, 0n],
      [4n, 0n],
      [2n, 2n],
      [2n, 2n],
      [4n, 4n],
      [0n, 4n],
    ];
    const directed = [
      { from: 0, to: 1, edge: 0 },
      { from: 1, to: 2, edge: 1 },
      { from: 2, to: 0, edge: 2 },
      { from: 3, to: 4, edge: 3 },
      { from: 4, to: 5, edge: 4 },
      { from: 5, to: 3, edge: 5 },
    ];
    const paired = sectorsOf(points, directed);
    expect(paired.status === 'OK' ? 'OK' : paired.reason).toBe('VERTEX_UNSUPPORTED:duplicate:2:3');
  });
});

describe('P3.1o O02 rule oracle', () => {
  it('matches a float brute force away from the boundary and medial ties', () => {
    for (const input of SHAPES) {
      const geometry = geometryOf(input);
      const sectors = vertexSectors(geometry);
      const crop = cropFor(geometry)!;
      const random = sequence(0x5eed + input.id.length);
      let compared = 0;
      for (let sample = 0; sample < 400; sample += 1) {
        const x = crop.x + random() * crop.w;
        const y = crop.y + random() * crop.h;
        // Dyadic sample point so that it is exact in both paths.
        const px = rational(BigInt(Math.round(x * 2 ** 20)), 1n << 20n);
        const py = rational(BigInt(Math.round(y * 2 ** 20)), 1n << 20n);
        const brute = bruteRule(geometry, toNumber(px), toNumber(py));
        if (brute.distance < 1e-6) continue;
        const exact = ruleCoverage(geometry, sectors, px, py);
        expect(Math.abs(toNumber(exact) - brute.c), `${input.id}:${sample}`).toBeLessThan(1e-9);
        const d2 = boundaryDistanceSquared(geometry, px, py);
        expect(Math.abs(Math.sqrt(toNumber(d2)) - brute.distance)).toBeLessThan(1e-9);
        compared += 1;
      }
      expect(compared).toBeGreaterThan(350);
    }
  });

  it('agrees at pixel centers with the generic point path and saturates beyond 1 px', () => {
    const input = SHAPES.find((shape) => shape.id === 'evenodd-star')!;
    const geometry = geometryOf(input);
    const sectors = vertexSectors(geometry);
    const context = ruleContext(geometry, sectors);
    const crop = cropFor(geometry)!;
    const oracle = coverageOracle(geometry, crop);
    const flags = distanceFlags(geometry, crop);
    for (let j = crop.y; j < crop.y + crop.h; j += 1)
      for (let i = crop.x; i < crop.x + crop.w; i += 1) {
        const value = ruleAtPixel(context, i, j);
        const generic = ruleCoverage(
          geometry,
          sectors,
          rational(BigInt(2 * i + 1), 2n),
          rational(BigInt(2 * j + 1), 2n),
        );
        expect(compare(value, generic)).toBe(0);
        const index = (j - crop.y) * crop.w + (i - crop.x);
        if (!(flags[index]! & WITHIN_1))
          expect(compare(value, rational(oracle.inside[index] ? 1n : 0n))).toBe(0);
      }
  });

  it('gives 1/2 on the boundary and a ramp of slope 1/w across a straight edge', () => {
    const input = SHAPES.find((shape) => shape.id === 'convex-square')!;
    const geometry = geometryOf(input);
    const sectors = vertexSectors(geometry);
    const P = geometry.preimage;
    const top = geometry.boundaryEdges.find(
      (edge) => compare(P[edge.a]![1], P[edge.b]![1]) === 0 && edge.a === 0,
    )!;
    const mid: Q2 = [
      rational(
        P[top.a]![0].n * P[top.b]![0].d + P[top.b]![0].n * P[top.a]![0].d,
        2n * P[top.a]![0].d * P[top.b]![0].d,
      ),
      P[top.a]![1],
    ];
    expect(ruleCoverage(geometry, sectors, mid[0], mid[1])).toEqual(rational(1n, 2n));
    // Axis-aligned edge: w = 1, so c = 1/2 +- distance.
    const quarter = rational(1n, 4n);
    const above = ruleCoverage(geometry, sectors, mid[0], sub(mid[1], quarter));
    const below = ruleCoverage(geometry, sectors, mid[0], add(mid[1], quarter));
    expect(above).toEqual(rational(1n, 4n));
    expect(below).toEqual(rational(3n, 4n));
  });

  it('computes exact feature distances', () => {
    const q = (x: number, y: number): Q2 => [rational(BigInt(x)), rational(BigInt(y))];
    expect(pointSegmentDistanceSquared(q(0, 3), q(-2, 0), q(2, 0))).toEqual(rational(9n));
    expect(pointSegmentDistanceSquared(q(5, 4), q(-2, 0), q(2, 0))).toEqual(rational(25n));
    const triangle = [q(0, 0), q(4, 0), q(0, 4)] as const;
    expect(pointTriangleDistanceSquared(q(1, 1), triangle)).toEqual(rational(0n));
    expect(pointTriangleDistanceSquared(q(4, 4), triangle)).toEqual(rational(8n));
    expect(segmentTriangleDistanceSquared(q(-3, 1), q(-1, 1), triangle)).toEqual(rational(1n));
    expect(segmentTriangleDistanceSquared(q(-3, 1), q(3, 1), triangle)).toEqual(rational(0n));
  });
});

describe('P3.1o O02 variants', () => {
  it('re-projects every row at 1, 1.5, 2 and 3 and reproduces O01 at the identity DPR', () => {
    const corpus = coverageCorpus();
    const variants = o02Variants(corpus);
    expect(variants.length).toBe(corpus.length * 4);
    expect(variants.length).toBe(596);
    variants.forEach((variant, index) => {
      const row = corpus[Math.floor(index / 4)]!;
      expect(variant.rowIndex).toBe(row.rowIndex);
      expect(variant.dpr).toBe(O02_DPRS[index % 4]);
      expect(variant.input.width * row.input.dpr).toBe(row.input.width * variant.dpr);
      expect(variant.input.width / variant.dpr).toBe(640);
      expect(variant.input.height / variant.dpr).toBe(360);
      const { dpr, width, height, ...rest } = variant.input;
      const { dpr: d0, width: w0, height: h0, ...rest0 } = row.input;
      expect(rest).toEqual(rest0);
      expect([dpr, width, height, d0, w0, h0].every(Number.isFinite)).toBe(true);
    });
    for (const row of corpus) {
      const identity = variants.filter((v) => v.rowIndex === row.rowIndex && v.identity);
      expect(identity.length).toBe(1);
      expect(JSON.stringify(encodeInput(identity[0]!.input))).toBe(
        JSON.stringify(encodeInput(row.input)),
      );
      const a = geometryOf(row.input);
      const b = geometryOf(identity[0]!.input);
      expect(b.ndcBits).toEqual(a.ndcBits);
      // The frame projection path reproduces the region vertices' NDC words and preimage.
      const projected = projectLocalVertices(row.input, row.input.mesh.vertices);
      for (const v of a.referenced) {
        expect(projected.ndcBits[v]).toEqual(a.ndcBits[v]);
        expect(projected.preimage[v]).toEqual(a.preimage[v]);
      }
    }
    expect(() => variantInput({ ...corpus[0]!.input, width: 641 }, 1.5)).toThrow();
    expect(ACCEPTANCE_DPRS).toEqual([1, 1.5, 2]);
  });

  it('census: statuses, frames and vertex degrees of all 596 variants', () => {
    const census = new Map<number, Map<string, number>>();
    const frameAbove16 = new Map<number, number>();
    const exteriorTriangles = new Map<number, number>();
    let maxFrame = 0;
    const pinchRows = new Set<number>();
    const lines: string[] = [];
    for (const variant of o02Variants()) {
      const status = variantStatus(variant.input);
      const counts = census.get(variant.dpr) ?? new Map<string, number>();
      counts.set(status.status, (counts.get(status.status) ?? 0) + 1);
      census.set(variant.dpr, counts);
      if (status.status !== 'RENDERED') {
        if (status.status !== 'EMPTY_CROP')
          lines.push(`${variant.rowIndex}:${variant.dpr}:${status.reason}`);
        continue;
      }
      const { exterior } = status;
      maxFrame = Math.max(maxFrame, exterior.frame.maxNdcMagnitude);
      if (exterior.frame.maxNdcMagnitude > 16)
        frameAbove16.set(variant.dpr, (frameAbove16.get(variant.dpr) ?? 0) + 1);
      exteriorTriangles.set(
        variant.dpr,
        Math.max(exteriorTriangles.get(variant.dpr) ?? 0, exterior.exteriorTriangles.length),
      );
      for (const entry of exterior.sectors.vertices) {
        expect(entry.sectors.length).toBeLessThanOrEqual(2);
        if (entry.sectors.length === 2) pinchRows.add(variant.rowIndex);
      }
      if ([77, 83, 89, 95].includes(variant.rowIndex))
        expect(exterior.frame.maxNdcMagnitude).toBeLessThan(4);
    }
    console.log(
      'O02 census',
      JSON.stringify([...census.entries()].map(([dpr, counts]) => [dpr, [...counts.entries()]])),
      JSON.stringify([...frameAbove16.entries()]),
      JSON.stringify([...exteriorTriangles.entries()]),
      maxFrame,
      pinchRows.size,
    );
    expect(lines).toEqual([]);
    for (const dpr of O02_DPRS) {
      expect(census.get(dpr)!.get('RENDERED')).toBe(143);
      expect(census.get(dpr)!.get('EMPTY_CROP')).toBe(6);
      expect(frameAbove16.get(dpr)).toBe(10);
    }
    expect(maxFrame).toBeGreaterThan(31);
    expect(maxFrame).toBeLessThan(32);
    expect(pinchRows.size).toBe(96);
  });
});

// ---------------------------------------------------------------------------------------------
// Capture reader (the full metrics document self-test is coverage-o02-document.test.ts).

describe('P3.1o O02 capture reader', () => {
  const crop = { x: 3, y: 4, w: 3, h: 2 };
  const entry = (
    pass: 'main' | 'count',
    sampleCount: number,
    channels: 'R' | 'RGBA',
    samples: Uint8Array | Uint16Array,
  ): O02CaptureCrop => ({
    pass,
    sampleCount,
    format: pass === 'main' ? 'rgba8unorm' : 'rgba16float',
    channels,
    rleBase64: encodeRleBase64(samples),
    sha256: sampleSha256(samples),
  });
  const row = (crops: O02CaptureCrop[]): O02CaptureRow => ({
    rowIndex: 0,
    id: 'x',
    kind: 'fixture',
    dpr: 1,
    identity: true,
    status: 'RENDERED',
    reason: null,
    input: null,
    width: 640,
    height: 360,
    crop,
    origin: [crop.x, crop.y],
    crops,
  });
  const main = Uint8Array.from([0, 64, 128, 255, 255, 0]);
  const count1 = new Uint16Array(6).fill(0x3c00);
  const count4 = Uint16Array.from({ length: 24 }, (_, i) => (i % 4 === 3 ? 0x4000 : 0x3c00));

  it('decodes the four crops in order, RGBA with the channel fastest', () => {
    const passes = decodeO02Passes(
      row([
        entry('main', 1, 'R', main),
        entry('main', 4, 'R', main),
        entry('count', 1, 'R', count1),
        entry('count', 4, 'RGBA', count4),
      ]),
      crop,
    );
    expect([...passes.main1]).toEqual([...main]);
    expect(passes.count4.length).toBe(24);
    expect(passes.count4[3]).toBe(0x4000);
  });

  it('rejects a wrong order, channel layout or hash', () => {
    const good = [
      entry('main', 1, 'R', main),
      entry('main', 4, 'R', main),
      entry('count', 1, 'R', count1),
      entry('count', 4, 'RGBA', count4),
    ];
    expect(() => decodeO02Passes(row([good[1]!, good[0]!, good[2]!, good[3]!]), crop)).toThrow(
      /crop-order/u,
    );
    expect(() =>
      decodeO02Passes(row([...good.slice(0, 3), { ...good[3]!, channels: 'R' }]), crop),
    ).toThrow();
    expect(() =>
      decodeO02Passes(row([...good.slice(0, 3), { ...good[3]!, sha256: '0'.repeat(64) }]), crop),
    ).toThrow(/sha256/u);
    expect(() => decodeO02Passes(row(good.slice(0, 3)), crop)).toThrow(/crop-set/u);
  });

  it('requires every acceptance DPR and a matching part hash', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'p3-o02-index-'));
    try {
      const body = JSON.stringify({ schema: 'p3-o02-capture-v1', contract: {}, dpr: 1, rows: [] });
      writeFileSync(path.join(directory, 'p1.json'), body);
      const part = { path: 'p1.json', sha256: sampleSha256(Buffer.from(body, 'utf8')), dpr: 1 };
      writeFileSync(
        path.join(directory, 'capture-index.json'),
        JSON.stringify({ schema: 'p3-o02-capture-index-v1', parts: [part] }),
      );
      expect(() => loadO02Capture(directory)).toThrow(/missing-dpr:1.5/u);
      writeFileSync(
        path.join(directory, 'capture-index.json'),
        JSON.stringify({
          schema: 'p3-o02-capture-index-v1',
          parts: [{ ...part, sha256: '0'.repeat(64) }],
        }),
      );
      expect(() => loadO02Capture(directory)).toThrow(/part-sha256/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('P3.1o O02 draw observations', () => {
  it('counts pixel centers in closed triangles exactly (brute force)', () => {
    const random = sequence(0xd2a3);
    const k = 3;
    const crop = { x: 2, y: 1, w: 9, h: 8 };
    for (let trial = 0; trial < 200; trial += 1) {
      // Coordinates on the 1/8-px grid, so centers often land exactly on edges and vertices.
      const coordinate = () => BigInt(Math.floor(random() * 13 * 8));
      const points: P[] = [
        [coordinate(), coordinate()],
        [coordinate(), coordinate()],
        [coordinate(), coordinate()],
      ];
      let brute = 0;
      const o = orient(points[0]!, points[1]!, points[2]!);
      if (o !== 0n)
        for (let j = crop.y; j < crop.y + crop.h; j += 1)
          for (let i = crop.x; i < crop.x + crop.w; i += 1) {
            const c: P = [BigInt(2 * i + 1) * 4n, BigInt(2 * j + 1) * 4n];
            const s = [
              orient(points[0]!, points[1]!, c),
              orient(points[1]!, points[2]!, c),
              orient(points[2]!, points[0]!, c),
            ].map((value) => (o > 0n ? value : -value));
            if (s.every((value) => value >= 0n)) brute += 1;
          }
      expect(centersInTriangle(points, [0, 1, 2], k, crop)).toBe(brute);
    }
  });

  it('reports shared-edge centers, the evaluation proxy and clipOutside', () => {
    // A 4 x 4 px square split by its diagonal through pixel centers (k = 1: unit 1/2 px).
    const points: P[] = [
      [1n, 1n],
      [9n, 1n],
      [9n, 9n],
      [1n, 9n],
    ];
    const crop = { x: 0, y: 0, w: 6, h: 6 };
    const word = (value: number) => {
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, value);
      return view.getUint32(0);
    };
    const inside = [[word(0.5), word(-0.5)]] as const;
    const stats = (
      perPrimitive: { triangle: [number, number, number]; role: 0 | 1; count: number }[],
    ) => ({
      regionPrimitives: 2,
      exteriorPrimitives: 0,
      droppedExterior: 0,
      maxFeatures: 3,
      p99Features: 3,
      featureBytes: 64,
      perPrimitive,
    });
    const result = drawObservations(
      points,
      1,
      [inside[0], inside[0], inside[0], inside[0]],
      crop,
      stats([
        { triangle: [0, 1, 2], role: 0, count: 2 },
        { triangle: [0, 2, 3], role: 0, count: 3 },
      ]),
    );
    // Centers (i + 1/2) in [0.5, 4.5]^2: 5 x 5 = 25, the 5 diagonal ones counted by both triangles.
    expect(result.fragmentFeatureEvaluations.sharedEdgeCenters).toBe(5);
    expect(result.fragmentFeatureEvaluations.value).toBe(String(15 * 2 + 15 * 3));
    expect(result.clipOutside).toBe(false);
    const outside = drawObservations(
      points,
      1,
      [inside[0], [word(1.0000001), word(0)], inside[0], inside[0]],
      crop,
      stats([
        { triangle: [0, 1, 2], role: 0, count: 2 },
        { triangle: [0, 2, 3], role: 0, count: 3 },
      ]),
    );
    expect(outside.clipOutside).toBe(true);
  });
});
