// D9 E11 unit E11-U2: the A01 structure checker (docs/plans/d9-e11-p3-c03-c05-closure-contract.md,
// sections 7 and 8). It checks one port mesh against the port's own published rules (V1 rule 5,
// V2 section g) and is written independently of the adapters: it reads only the four arrays of a
// FillMesh or StrokeMesh, never adapter code, and decides orientation exactly.

import type { FillMesh } from '../../../packages/contracts/src/geometry.js';
import { inspectTriangleMesh } from '../../../packages/geometry-reference/src/triangle-mesh.js';

export type StructureIssue =
  | 'POSITIONS_LENGTH'
  | 'NON_FINITE_VERTEX'
  | 'EMPTY_MESH'
  | 'INDEX_COUNT'
  | 'INDEX_RANGE'
  | 'BOUNDS_NON_FINITE'
  | 'BOUNDS_NOT_EXACT'
  | 'NONPOSITIVE_TRIANGLE'
  | 'DUPLICATE_DIRECTED_EDGE'
  | 'BOUNDARY_LENGTH'
  | 'BOUNDARY_INDEX_RANGE'
  | 'BOUNDARY_MISMATCH'
  | 'T_JUNCTION'
  | 'OVERLAPPING_TRIANGLES'
  | 'ORACLE_DISAGREES';

export type StructureReport = Readonly<{
  /** Issues in check order; empty when the mesh is valid. Later checks are skipped once an
   *  earlier one makes them meaningless (lengths, ranges, finiteness). */
  issues: readonly StructureIssue[];
  vertices: number;
  triangles: number;
  boundaryEdges: number;
  /** Vertex indices whose exact position repeats an earlier vertex (merged for the edge check). */
  duplicatePositions: number;
  /** Whether the geometry-reference triangle-mesh oracle also inspected this mesh (its cap is
   *  256 vertices and 256 triangles). */
  oracleChecked: boolean;
}>;

const ORACLE_CAP = 256;

// --- exact orientation --------------------------------------------------------------------------

const scratch = new DataView(new ArrayBuffer(8));

/** A finite binary64 value as n · 2^-1074 exactly. */
function scaled(value: number): bigint {
  if (value === 0) return 0n;
  scratch.setFloat64(0, value);
  const hi = scratch.getUint32(0);
  const lo = scratch.getUint32(4);
  const sign = hi >>> 31 === 1 ? -1n : 1n;
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let shift: number;
  if (biased === 0) {
    shift = 0; // subnormal: mantissa · 2^-1074
  } else {
    mantissa |= 1n << 52n;
    shift = biased - 1;
  }
  return sign * (mantissa << BigInt(shift));
}

/** sign((b - a) × (c - a)), exactly. A Float64 filter decides most triangles; the rest are
 *  evaluated over BigInt. */
export function orientation(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): -1 | 0 | 1 {
  const left = (bx - ax) * (cy - ay);
  const right = (by - ay) * (cx - ax);
  const det = left - right;
  // Shewchuk's orient2d bound A, widened, applies when the differences are exact enough; any
  // overflow or doubt falls through to the exact path.
  const bound = 4e-15 * (Math.abs(left) + Math.abs(right));
  if (Number.isFinite(det) && Number.isFinite(bound) && Math.abs(det) > bound && bound > 0)
    return det > 0 ? 1 : -1;
  const [axs, ays, bxs, bys, cxs, cys] = [ax, ay, bx, by, cx, cy].map(scaled) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  const exact = (bxs - axs) * (cys - ays) - (bys - ays) * (cxs - axs);
  return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}

// --- the checker ---------------------------------------------------------------------------------

function positionKey(x: number, y: number): string {
  scratch.setFloat64(0, x);
  const a = `${scratch.getUint32(0)}:${scratch.getUint32(4)}`;
  scratch.setFloat64(0, y);
  return `${a}:${scratch.getUint32(0)}:${scratch.getUint32(4)}`;
}

/**
 * Checks one `ok` mesh. Rules: positions are finite pairs; at least one triangle; indices come
 * in threes and are in range; `bounds` is the exact component-wise minimum and maximum of the
 * positions (V2 section g); every triangle is counter-clockwise with positive area (V2 section
 * g); no directed edge occurs twice, by exact position (a duplicated or overlapping fan would);
 * the boundary edges (V1 rule 5) equal the directed edges whose reverse no triangle uses,
 * again by exact position, which fails a missing triangle; and conformity: no vertex lies
 * strictly inside such an edge (a T-junction), decided exactly.
 */
export function checkMeshStructure(mesh: FillMesh): StructureReport {
  const issues: StructureIssue[] = [];
  const { positions, indices, boundaryEdges, bounds } = mesh;
  const vertexCount = Math.floor(positions.length / 2);
  const triangleCount = Math.floor(indices.length / 3);
  const base = {
    vertices: vertexCount,
    triangles: triangleCount,
    boundaryEdges: Math.floor(boundaryEdges.length / 2),
  };
  const done = (duplicatePositions = 0, oracleChecked = false): StructureReport =>
    Object.freeze({ issues, ...base, duplicatePositions, oracleChecked });

  if (positions.length % 2 !== 0) issues.push('POSITIONS_LENGTH');
  for (let i = 0; i < positions.length; i += 1)
    if (!Number.isFinite(positions[i]!)) {
      issues.push('NON_FINITE_VERTEX');
      break;
    }
  if (indices.length === 0) issues.push('EMPTY_MESH');
  if (indices.length % 3 !== 0) issues.push('INDEX_COUNT');
  for (let i = 0; i < indices.length; i += 1)
    if (indices[i]! >= vertexCount) {
      issues.push('INDEX_RANGE');
      break;
    }
  if (boundaryEdges.length % 2 !== 0) issues.push('BOUNDARY_LENGTH');
  for (let i = 0; i < boundaryEdges.length; i += 1)
    if (boundaryEdges[i]! >= vertexCount) {
      issues.push('BOUNDARY_INDEX_RANGE');
      break;
    }
  if (issues.length > 0) return done();

  const b = [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
  if (!b.every(Number.isFinite)) issues.push('BOUNDS_NON_FINITE');
  else if (vertexCount > 0) {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let v = 0; v < vertexCount; v += 1) {
      const x = positions[2 * v]!;
      const y = positions[2 * v + 1]!;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    // Exact equality, with -0 and +0 treated alike (both are the same coordinate).
    if (minX !== b[0] || minY !== b[1] || maxX !== b[2] || maxY !== b[3])
      issues.push('BOUNDS_NOT_EXACT');
  }

  // Canonical vertex per exact position.
  const canonical = new Uint32Array(vertexCount);
  const seen = new Map<string, number>();
  let duplicatePositions = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = positions[2 * v]! === 0 ? 0 : positions[2 * v]!;
    const y = positions[2 * v + 1]! === 0 ? 0 : positions[2 * v + 1]!;
    const key = positionKey(x, y);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, v);
      canonical[v] = v;
    } else {
      canonical[v] = first;
      duplicatePositions += 1;
    }
  }

  const edgeKey = (from: number, to: number) => from * vertexCount + to;
  const directed = new Map<number, number>();
  let nonpositive = false;
  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = indices[3 * t]!;
    const i1 = indices[3 * t + 1]!;
    const i2 = indices[3 * t + 2]!;
    const o = orientation(
      positions[2 * i0]!,
      positions[2 * i0 + 1]!,
      positions[2 * i1]!,
      positions[2 * i1 + 1]!,
      positions[2 * i2]!,
      positions[2 * i2 + 1]!,
    );
    if (o <= 0) nonpositive = true;
    const c = [canonical[i0]!, canonical[i1]!, canonical[i2]!];
    for (let k = 0; k < 3; k += 1) {
      const key = edgeKey(c[k]!, c[(k + 1) % 3]!);
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  if (nonpositive) issues.push('NONPOSITIVE_TRIANGLE');
  for (const count of directed.values())
    if (count > 1) {
      issues.push('DUPLICATE_DIRECTED_EDGE');
      break;
    }

  // Boundary: directed edges whose reverse is unused, against the listed pairs.
  const expected = new Set<number>();
  for (const key of directed.keys()) {
    const from = Math.floor(key / vertexCount);
    const to = key % vertexCount;
    if (!directed.has(edgeKey(to, from))) expected.add(key);
  }
  const listed = new Set<number>();
  let mismatch = false;
  for (let e = 0; e < boundaryEdges.length; e += 2) {
    const key = edgeKey(canonical[boundaryEdges[e]!]!, canonical[boundaryEdges[e + 1]!]!);
    if (listed.has(key) || !expected.has(key)) mismatch = true;
    listed.add(key);
  }
  if (mismatch || listed.size !== expected.size) issues.push('BOUNDARY_MISMATCH');

  // Conformity: a vertex strictly inside an unmatched edge is a T-junction. Vertices are
  // sorted by x so each edge scans only the vertices within its x range.
  // Only vertices some triangle uses count: an unused position is not part of the mesh.
  const used = new Uint8Array(vertexCount);
  for (let i = 0; i < indices.length; i += 1) used[indices[i]!] = 1;
  const order = Array.from({ length: vertexCount }, (_, v) => v)
    .filter((v) => used[v] === 1)
    .sort((p, q) => positions[2 * p]! - positions[2 * q]!);
  const xs = order.map((v) => positions[2 * v]!);
  const lowerBound = (x: number) => {
    let [lo, hi] = [0, xs.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let tJunction = false;
  for (const key of expected) {
    if (tJunction) break;
    const from = Math.floor(key / vertexCount);
    const to = key % vertexCount;
    const [ax, ay, bx, by] = [
      positions[2 * from]!,
      positions[2 * from + 1]!,
      positions[2 * to]!,
      positions[2 * to + 1]!,
    ];
    const [minX, maxX] = [Math.min(ax, bx), Math.max(ax, bx)];
    const [minY, maxY] = [Math.min(ay, by), Math.max(ay, by)];
    for (let k = lowerBound(minX); k < order.length && xs[k]! <= maxX; k += 1) {
      const v = order[k]!;
      const x = positions[2 * v]!;
      const y = positions[2 * v + 1]!;
      if (y < minY || y > maxY) continue;
      if ((x === ax && y === ay) || (x === bx && y === by)) continue;
      if (orientation(ax, ay, bx, by, x, y) === 0) {
        tJunction = true;
        break;
      }
    }
  }
  if (tJunction) issues.push('T_JUNCTION');

  // Independent second opinion inside the reference oracle's cap.
  let oracleChecked = false;
  if (vertexCount <= ORACLE_CAP && triangleCount <= ORACLE_CAP && vertexCount > 0) {
    oracleChecked = true;
    const vertices = Array.from(
      { length: vertexCount },
      (_, v) => [positions[2 * v]!, positions[2 * v + 1]!] as const,
    );
    let oracleIssue: string | null;
    try {
      oracleIssue = inspectTriangleMesh({
        vertices,
        indices: Array.from(indices),
        bounds: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
      }).issue;
    } catch {
      oracleIssue = 'INPUT_REJECTED';
    }
    // The oracle reports its first issue: orientation, then bounds enclosure, then overlap.
    const orientationBad = issues.includes('NONPOSITIVE_TRIANGLE');
    const oracleOrientation =
      oracleIssue === 'DEGENERATE_TRIANGLE' || oracleIssue === 'REVERSED_TRIANGLE';
    if (orientationBad !== oracleOrientation) issues.push('ORACLE_DISAGREES');
    else if (oracleIssue === 'BOUNDS_MISMATCH' && !issues.includes('BOUNDS_NOT_EXACT'))
      issues.push('ORACLE_DISAGREES');
    else if (oracleIssue === 'OVERLAPPING_TRIANGLES') issues.push('OVERLAPPING_TRIANGLES');
    else if (oracleIssue === 'INPUT_REJECTED') issues.push('ORACLE_DISAGREES');
  }
  return done(duplicatePositions, oracleChecked);
}
