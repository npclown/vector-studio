import type { FillMesh } from '@vector-studio/contracts';
import {
  classifyLineFill,
  inspectTriangleMesh,
  type LineFillRule,
  type Point,
} from '../../packages/geometry-reference/src/index.js';

// Independent test-side mesh check of the P3 V2 contract, section f. It does
// not trust the implementation's boundary list: it recomputes everything in
// exact integer arithmetic (binary64 values as integer multiples of 2^-1074)
// and uses the exact geometry-reference triangle-mesh inspection and fill
// classifier as oracles.

type ExactPoint = Readonly<{ x: bigint; y: bigint }>;

const bits = new DataView(new ArrayBuffer(8));
const REFERENCE_MESH_CAP = 256;

/** The exact binary64 value as an integer multiple of 2^-1074. */
function exact(value: number): bigint {
  bits.setFloat64(0, value, false);
  const high = bits.getUint32(0, false);
  const low = bits.getUint32(4, false);
  const exponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const magnitude = exponent === 0 ? fraction : ((1n << 52n) | fraction) << BigInt(exponent - 1);
  return (high & 0x80000000) === 0 ? magnitude : -magnitude;
}

function orientation(a: ExactPoint, b: ExactPoint, c: ExactPoint): bigint {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function strictlyBetween(value: bigint, a: bigint, b: bigint): boolean {
  return (value > a && value < b) || (value < a && value > b);
}

/** True when `point` lies on the open segment (a, b). */
function onOpenSegment(point: ExactPoint, a: ExactPoint, b: ExactPoint): boolean {
  if (orientation(a, b, point) !== 0n) return false;
  return a.x !== b.x ? strictlyBetween(point.x, a.x, b.x) : strictlyBetween(point.y, a.y, b.y);
}

/** True when `point` lies on the closed segment [a, b]. */
function onClosedSegment(point: ExactPoint, a: ExactPoint, b: ExactPoint): boolean {
  if ((point.x === a.x && point.y === a.y) || (point.x === b.x && point.y === b.y)) return true;
  return onOpenSegment(point, a, b);
}

function separated(source: readonly ExactPoint[], other: readonly ExactPoint[]): boolean {
  for (let edge = 0; edge < 3; edge += 1) {
    const start = source[edge]!;
    const end = source[(edge + 1) % 3]!;
    if (other.every((point) => orientation(start, end, point) <= 0n)) return true;
  }
  return false;
}

function triangleBox(points: readonly ExactPoint[]): [bigint, bigint, bigint, bigint] {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const min = (values: bigint[]) => values.reduce((left, right) => (right < left ? right : left));
  const max = (values: bigint[]) => values.reduce((left, right) => (right > left ? right : left));
  return [min(xs), min(ys), max(xs), max(ys)];
}

function exactVertices(mesh: FillMesh): ExactPoint[] {
  const vertices: ExactPoint[] = [];
  for (let scalar = 0; scalar + 1 < mesh.positions.length; scalar += 2) {
    vertices.push({ x: exact(mesh.positions[scalar]!), y: exact(mesh.positions[scalar + 1]!) });
  }
  return vertices;
}

function directedEdgeKey(a: number, b: number): string {
  return `${String(a)}>${String(b)}`;
}

/**
 * Checks one `ok` mesh: valid lengths and indices, exact vertex bounds,
 * strictly positive and interior-disjoint triangles, conformity (no vertex
 * strictly inside any triangle edge), and `boundaryEdges` equal, as a
 * multiset of directed pairs, to the edges used by exactly one triangle.
 * Returns the issues found; an empty list means the mesh passes.
 */
export function checkFillMesh(mesh: FillMesh): string[] {
  const issues: string[] = [];
  const { positions, indices, boundaryEdges } = mesh;
  if (positions.length % 2 !== 0) return ['positions length is odd'];
  if (indices.length % 3 !== 0) return ['indices length is not a multiple of 3'];
  if (boundaryEdges.length % 2 !== 0) return ['boundaryEdges length is odd'];
  const vertexCount = positions.length / 2;
  if (vertexCount === 0 || indices.length === 0) return ['an ok mesh has no triangles'];
  for (const index of [...indices, ...boundaryEdges]) {
    if (index >= vertexCount) return ['an index lies outside the vertices'];
  }
  if (!positions.every((value) => Number.isFinite(value))) return ['a position is not finite'];

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
  const { bounds } = mesh;
  if (
    bounds.minX !== minX ||
    bounds.minY !== minY ||
    bounds.maxX !== maxX ||
    bounds.maxY !== maxY
  ) {
    issues.push('bounds differ from the vertex min/max');
  }

  const vertices = exactVertices(mesh);
  const triangles: ExactPoint[][] = [];
  const boxes: [bigint, bigint, bigint, bigint][] = [];
  for (let slot = 0; slot < indices.length; slot += 3) {
    const triangle = [
      vertices[indices[slot]!]!,
      vertices[indices[slot + 1]!]!,
      vertices[indices[slot + 2]!]!,
    ];
    if (orientation(triangle[0]!, triangle[1]!, triangle[2]!) <= 0n) {
      issues.push(`triangle ${String(slot / 3)} is not strictly positive`);
    }
    triangles.push(triangle);
    boxes.push(triangleBox(triangle));
  }
  if (issues.length > 0) return issues;

  for (let left = 0; left < triangles.length; left += 1) {
    const a = boxes[left]!;
    for (let right = left + 1; right < triangles.length; right += 1) {
      const b = boxes[right]!;
      if (a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]) continue;
      if (
        !separated(triangles[left]!, triangles[right]!) &&
        !separated(triangles[right]!, triangles[left]!)
      ) {
        issues.push(`triangles ${String(left)} and ${String(right)} overlap`);
        return issues;
      }
    }
  }

  const directedCounts = new Map<string, number>();
  const undirectedCounts = new Map<string, number>();
  const edges: [number, number][] = [];
  for (let slot = 0; slot < indices.length; slot += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const a = indices[slot + corner]!;
      const b = indices[slot + ((corner + 1) % 3)]!;
      edges.push([a, b]);
      const key = directedEdgeKey(Math.min(a, b), Math.max(a, b));
      undirectedCounts.set(key, (undirectedCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [a, b] of edges) {
    if (undirectedCounts.get(directedEdgeKey(Math.min(a, b), Math.max(a, b))) === 1) {
      const key = directedEdgeKey(a, b);
      directedCounts.set(key, (directedCounts.get(key) ?? 0) + 1);
    }
  }
  const listed = new Map<string, number>();
  for (let slot = 0; slot < boundaryEdges.length; slot += 2) {
    const key = directedEdgeKey(boundaryEdges[slot]!, boundaryEdges[slot + 1]!);
    listed.set(key, (listed.get(key) ?? 0) + 1);
  }
  const keys = new Set([...directedCounts.keys(), ...listed.keys()]);
  for (const key of keys) {
    if ((directedCounts.get(key) ?? 0) !== (listed.get(key) ?? 0)) {
      issues.push(`boundaryEdges differs from the edges used once at ${key}`);
      break;
    }
  }

  for (const [key] of undirectedCounts) {
    const [a, b] = key.split('>').map(Number) as [number, number];
    const start = vertices[a]!;
    const end = vertices[b]!;
    for (let vertex = 0; vertex < vertices.length; vertex += 1) {
      if (vertex === a || vertex === b) continue;
      if (onOpenSegment(vertices[vertex]!, start, end)) {
        issues.push(`vertex ${String(vertex)} hangs inside edge ${key}`);
        return issues;
      }
    }
  }

  if (vertexCount <= REFERENCE_MESH_CAP && indices.length / 3 <= REFERENCE_MESH_CAP) {
    const reference = inspectTriangleMesh({
      vertices: Array.from({ length: vertexCount }, (_, vertex) => [
        positions[2 * vertex]!,
        positions[2 * vertex + 1]!,
      ]),
      indices: Array.from(indices),
      bounds: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
    });
    if (!reference.valid) issues.push(`reference mesh inspection: ${String(reference.issue)}`);
  }
  return issues;
}

const SIDE_OFFSET = 2 ** -16;
const SAMPLES = [0.25, 0.5, 0.75];

/**
 * For a fixture with exactly representable output: the triangle area equals
 * `expectedArea` exactly, and the union of `boundaryEdges` equals the
 * boundary of the independent fill-region oracle for `contours` and `rule`.
 * Every listed edge lies on the oracle boundary with filled area on its left
 * only, and every oracle boundary span of a source edge is covered by a
 * listed edge.
 */
export function checkFillRegion(
  mesh: FillMesh,
  contours: readonly (readonly Point[])[],
  rule: LineFillRule,
  expectedArea: number,
): string[] {
  const issues: string[] = [];
  const vertices = exactVertices(mesh);
  let twiceArea = 0n;
  for (let slot = 0; slot < mesh.indices.length; slot += 3) {
    twiceArea += orientation(
      vertices[mesh.indices[slot]!]!,
      vertices[mesh.indices[slot + 1]!]!,
      vertices[mesh.indices[slot + 2]!]!,
    );
  }
  if (!Number.isInteger(expectedArea)) throw new RangeError('expected area must be an integer');
  if (twiceArea !== 2n * BigInt(expectedArea) * (1n << 2148n)) {
    issues.push('triangle area differs from the oracle area');
  }

  const position = (vertex: number): Point => [
    mesh.positions[2 * vertex]!,
    mesh.positions[2 * vertex + 1]!,
  ];
  const listed: [Point, Point][] = [];
  for (let slot = 0; slot < mesh.boundaryEdges.length; slot += 2) {
    listed.push([position(mesh.boundaryEdges[slot]!), position(mesh.boundaryEdges[slot + 1]!)]);
  }
  for (const [a, b] of listed) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    for (const t of SAMPLES) {
      const sample: Point = [a[0] + t * dx, a[1] + t * dy];
      const left: Point = [sample[0] - SIDE_OFFSET * dy, sample[1] + SIDE_OFFSET * dx];
      const right: Point = [sample[0] + SIDE_OFFSET * dy, sample[1] - SIDE_OFFSET * dx];
      if (
        classifyLineFill(contours, sample, rule) !== 'boundary' ||
        classifyLineFill(contours, left, rule) !== 'inside' ||
        classifyLineFill(contours, right, rule) !== 'outside'
      ) {
        issues.push(`edge (${a.join(',')})->(${b.join(',')}) is not a region boundary edge`);
        break;
      }
    }
  }

  const exactListed = listed.map(
    ([a, b]) =>
      [
        { x: exact(a[0]), y: exact(a[1]) },
        { x: exact(b[0]), y: exact(b[1]) },
      ] as const,
  );
  const splitPoints: Point[] = [
    ...Array.from({ length: mesh.positions.length / 2 }, (_, vertex) => position(vertex)),
    ...contours.flat(),
  ];
  for (const contour of contours) {
    for (let index = 0; index < contour.length; index += 1) {
      const start = contour[index]!;
      const end = contour[(index + 1) % contour.length]!;
      if (start[0] === end[0] && start[1] === end[1]) continue;
      const exactStart = { x: exact(start[0]), y: exact(start[1]) };
      const exactEnd = { x: exact(end[0]), y: exact(end[1]) };
      const axis = start[0] !== end[0] ? 0 : 1;
      const parameters = [start[axis], end[axis]];
      for (const point of splitPoints) {
        if (onOpenSegment({ x: exact(point[0]), y: exact(point[1]) }, exactStart, exactEnd)) {
          parameters.push(point[axis]);
        }
      }
      parameters.sort((left, right) => left - right);
      for (let span = 0; span + 1 < parameters.length; span += 1) {
        if (parameters[span] === parameters[span + 1]) continue;
        const middle = (parameters[span]! + parameters[span + 1]!) / 2;
        const t = (middle - start[axis]) / (end[axis] - start[axis]);
        const sample: Point = [
          start[0] + t * (end[0] - start[0]),
          start[1] + t * (end[1] - start[1]),
        ];
        if (classifyLineFill(contours, sample, rule) !== 'boundary') continue;
        const exactSample = { x: exact(sample[0]), y: exact(sample[1]) };
        if (!exactListed.some(([a, b]) => onClosedSegment(exactSample, a, b))) {
          issues.push(`oracle boundary at (${sample.join(',')}) is not covered`);
        }
      }
    }
  }
  return issues;
}
