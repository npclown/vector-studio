import type { Crop } from '../geometry/coverage-oracle/crop.js';
import {
  pointTriangleDistanceSquared,
  segmentTriangleDistanceSquared,
  type ExteriorMesh,
} from '../geometry/coverage-oracle/exterior.js';
import type { Q2 } from '../geometry/coverage-oracle/positions.js';
import { compare, rational, toNumber } from '../geometry/rounded-fill/exact.js';

/**
 * P3.1o O02 CPU builder (docs/plans/p3-o02-a5-coverage-contract.md, "Features and reach" and
 * "Runner and records"). Feature records are 16 words: kind/flags as u32, everything else f32,
 * computed in binary64 from the exact preimage relative to the crop origin, then rounded once.
 */

const RECORD_WORDS = 16;
const REFLEX_SHIFT = 8;
const REACH_SQUARED = rational(9n, 4n);
const ROLE_REGION = 0;
const ROLE_EXTERIOR = 1;

type Feature = Readonly<{ kind: 0 | 1; id: number; words: Uint32Array }>;

export type O02Build = Readonly<{
  origin: readonly [number, number];
  soup: Uint8Array;
  features: Uint8Array;
  regionDraw: Readonly<{ first: number; count: number }>;
  exteriorDraw: Readonly<{ first: number; count: number }>;
  stats: Readonly<{
    regionPrimitives: number;
    exteriorPrimitives: number;
    droppedExterior: number;
    maxFeatures: number;
    p99Features: number;
    featureBytes: number;
    /** Drawn primitives only, in draw order (dropped exterior triangles are excluded). */
    perPrimitive: readonly Readonly<{
      triangle: readonly [number, number, number];
      role: 0 | 1;
      count: number;
    }>[];
  }>;
}>;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function floatWord(value: number): number {
  f32[0] = value;
  return u32[0]!;
}

function unit(dx: number, dy: number): readonly [number, number] {
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) throw new Error('degenerate-direction');
  return [dx / length, dy / length];
}

function boundaryFeatures(exterior: ExteriorMesh, origin: readonly [number, number]) {
  const point = (index: number) => {
    const [x, y] = exterior.preimage[index]!;
    return [toNumber(x), toNumber(y)] as const;
  };
  const edges: Feature[] = exterior.sectors.directed.map((edge, id) => {
    const a = point(edge.from);
    const b = point(edge.to);
    const [ex, ey] = unit(b[0] - a[0], b[1] - a[1]);
    // Region on the left in y-down coordinates; the outward normal points right of e.
    const n = [ey, -ex] as const;
    const t = [-n[1], n[0]] as const;
    const ar = [a[0] - origin[0], a[1] - origin[1]] as const;
    const br = [b[0] - origin[0], b[1] - origin[1]] as const;
    const words = new Uint32Array(RECORD_WORDS);
    words[0] = 0;
    words[1] = floatWord(n[0]);
    words[2] = floatWord(n[1]);
    words[3] = floatWord(-(n[0] * ar[0] + n[1] * ar[1]));
    words[4] = floatWord(t[0] * ar[0] + t[1] * ar[1]);
    words[5] = floatWord(t[0] * br[0] + t[1] * br[1]);
    return { kind: 0, id, words };
  });
  const vertices: Feature[] = exterior.sectors.vertices.map(({ vertex, sectors }) => {
    if (sectors.length < 1 || sectors.length > 3) throw new Error('sector-count');
    const v = point(vertex);
    const words = new Uint32Array(RECORD_WORDS);
    words[0] = 1;
    words[1] = floatWord(v[0] - origin[0]);
    words[2] = floatWord(v[1] - origin[1]);
    let flags = sectors.length;
    sectors.forEach((sector, index) => {
      if (sector.reflex) flags |= 1 << (REFLEX_SHIFT + index);
      const w = point(sector.rOut[1]);
      const u = point(sector.rIn[0]);
      const rOut = unit(w[0] - v[0], w[1] - v[1]);
      const rIn = unit(u[0] - v[0], u[1] - v[1]);
      const at = 4 + index * 4;
      words[at] = floatWord(rOut[0]);
      words[at + 1] = floatWord(rOut[1]);
      words[at + 2] = floatWord(rIn[0]);
      words[at + 3] = floatWord(rIn[1]);
    });
    words[3] = flags >>> 0;
    return { kind: 1, id: vertex, words };
  });
  return { edges, vertices };
}

export function buildO02(exterior: ExteriorMesh, crop: Crop): O02Build {
  const origin = [crop.x, crop.y] as const;
  const { edges, vertices } = boundaryFeatures(exterior, origin);
  const points = exterior.preimage;
  const edgeEnds = exterior.sectors.directed.map(
    (edge) => [points[edge.from]!, points[edge.to]!] as const,
  );
  const listFor = (triangle: readonly [number, number, number]): Feature[] => {
    const corners = triangle.map((index) => points[index]!) as unknown as readonly [Q2, Q2, Q2];
    const near: Feature[] = [];
    edges.forEach((feature, index) => {
      const [a, b] = edgeEnds[index]!;
      if (compare(segmentTriangleDistanceSquared(a, b, corners), REACH_SQUARED) <= 0)
        near.push(feature);
    });
    for (const feature of vertices)
      if (compare(pointTriangleDistanceSquared(points[feature.id]!, corners), REACH_SQUARED) <= 0)
        near.push(feature);
    // Global order: edges before vertices (ascending). `sectors.directed` follows
    // geometry.boundaryEdges, which is sorted by (a, b), so `edges` is already in global order.
    return near;
  };

  const records: Uint32Array[] = [];
  const primitives: {
    triangle: readonly [number, number, number];
    role: 0 | 1;
    offset: number;
    count: number;
  }[] = [];
  let dropped = 0;
  const add = (triangle: readonly [number, number, number], role: 0 | 1) => {
    const list = listFor(triangle);
    if (role === ROLE_EXTERIOR && list.length === 0) {
      dropped += 1;
      return;
    }
    primitives.push({ triangle, role, offset: records.length, count: list.length });
    for (const feature of list) records.push(feature.words);
  };
  for (const triangle of exterior.regionTriangles) add(triangle, ROLE_REGION);
  const regionCount = primitives.length;
  for (const triangle of exterior.exteriorTriangles) add(triangle, ROLE_EXTERIOR);

  const soupWords = new Uint32Array(primitives.length * 3 * 8);
  primitives.forEach((primitive, index) => {
    primitive.triangle.forEach((vertex, corner) => {
      const at = (index * 3 + corner) * 8;
      const [x, y] = exterior.ndcBits[vertex]!;
      soupWords[at] = x;
      soupWords[at + 1] = y;
      soupWords[at + 2] = primitive.offset;
      soupWords[at + 3] = primitive.count;
      soupWords[at + 4] = primitive.role;
    });
  });
  const featureWords = new Uint32Array(records.length * RECORD_WORDS);
  records.forEach((record, index) => featureWords.set(record, index * RECORD_WORDS));
  const counts = primitives.map((primitive) => primitive.count).sort((a, b) => a - b);
  const p99 =
    counts.length === 0
      ? 0
      : counts[Math.min(counts.length - 1, Math.ceil(0.99 * counts.length) - 1)]!;
  return {
    origin,
    soup: littleEndian(soupWords),
    features: littleEndian(featureWords),
    regionDraw: { first: 0, count: regionCount * 3 },
    exteriorDraw: { first: regionCount * 3, count: (primitives.length - regionCount) * 3 },
    stats: {
      regionPrimitives: regionCount,
      exteriorPrimitives: primitives.length - regionCount,
      droppedExterior: dropped,
      maxFeatures: counts.at(-1) ?? 0,
      p99Features: p99,
      featureBytes: featureWords.byteLength,
      perPrimitive: primitives.map(({ triangle, role, count }) => ({ triangle, role, count })),
    },
  };
}

function littleEndian(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  return bytes;
}
