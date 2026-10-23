// D9 E3 unit E3-U3: synthetic ports and hand-made meshes for the harness controls
// (docs/plans/d9-e3-b4-precision-contract.md section 8). No kernel is loaded: a synthetic port
// answers each request with a mesh the test built by hand, in the port's FillMesh form, so the
// controls exercise the real renderer stages and the shader model without reading kernel output
// (section 5.5).
import type {
  FillMesh,
  FillMeshRequest,
  FillMeshResult,
  StrokeMeshFailureCode,
  StrokeMeshRequest,
  StrokeMeshResult,
} from '@vector-studio/contracts';
import type { MeshPorts } from './harness.js';

/** A triangle list in node-local Float64 coordinates, counter-clockwise (positive cross). */
export type Tri = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

/**
 * A port-form mesh from triangles that share vertices by exact coordinate. `boundaryEdges` are
 * the directed edges used by one triangle (V1 rule 5's orientation for a conforming mesh), and
 * the bounds are the exact bounds of the positions, as the renderer's validation requires.
 */
export function meshFromTriangles(triangles: readonly Tri[]): FillMesh {
  const index = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const vertex = ([x, y]: readonly [number, number]): number => {
    const key = `${x},${y}`;
    let at = index.get(key);
    if (at === undefined) {
      at = positions.length / 2;
      index.set(key, at);
      positions.push(x, y);
    }
    return at;
  };
  for (const tri of triangles) for (const p of tri) indices.push(vertex(p));
  const used = new Map<string, readonly [number, number]>();
  for (let k = 0; k < indices.length; k += 3) {
    for (let e = 0; e < 3; e += 1) {
      const a = indices[k + e]!;
      const b = indices[k + ((e + 1) % 3)]!;
      const reverse = `${b}:${a}`;
      if (used.has(reverse)) used.delete(reverse);
      else used.set(`${a}:${b}`, [a, b]);
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < positions.length; v += 2) {
    minX = Math.min(minX, positions[v]!);
    maxX = Math.max(maxX, positions[v]!);
    minY = Math.min(minY, positions[v + 1]!);
    maxY = Math.max(maxY, positions[v + 1]!);
  }
  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    boundaryEdges: Uint32Array.from([...used.values()].flat()),
    bounds: { minX, minY, maxX, maxY },
  };
}

/** A convex polygon (counter-clockwise) as a triangle fan. */
export function fanTriangles(points: readonly (readonly [number, number])[]): Tri[] {
  const out: Tri[] = [];
  for (let i = 1; i + 1 < points.length; i += 1) out.push([points[0]!, points[i]!, points[i + 1]!]);
  return out;
}

export type Answer = FillMesh | 'empty' | Readonly<{ failed: StrokeMeshFailureCode }>;

type AnswerFn = (
  request: FillMeshRequest | StrokeMeshRequest,
  paint: 'fill' | 'stroke',
) => Answer;

/** Ports whose answers are scripted per request; both paints go through one function. */
export function syntheticPorts(answer: AnswerFn | Answer): MeshPorts {
  const pick: AnswerFn = typeof answer === 'function' ? answer : () => answer;
  const result = (
    request: FillMeshRequest | StrokeMeshRequest,
    paint: 'fill' | 'stroke',
  ): FillMeshResult & StrokeMeshResult => {
    const a = pick(request, paint);
    const echo = { requestId: request.requestId, toleranceExponent: request.toleranceExponent };
    if (a === 'empty') return { ...echo, status: 'empty' } as never;
    if ('failed' in a) return { ...echo, status: 'failed', code: a.failed } as never;
    return { ...echo, status: 'ok', mesh: a } as never;
  };
  return {
    fill: {
      portVersion: 0,
      operationId: 'e3-a04/synthetic-fill',
      buildFillMeshes: (requests) => ({
        status: 'ok',
        results: requests.map((r) => result(r, 'fill')),
      }),
    },
    stroke: {
      portVersion: 0,
      operationId: 'e3-a04/synthetic-stroke',
      buildStrokeMeshes: (requests) => ({
        status: 'ok',
        results: requests.map((r) => result(r, 'stroke')),
      }),
    },
  };
}
