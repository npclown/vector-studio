import { add, compare, mul, sign, sub } from '../rounded-fill/exact.js';
import type { Q2 } from '../extent-t01/clip.js';
import type { ProjectionInput } from '../mesh-projection/model.js';
import { sourceContext, type MergedMesh } from '../extent-t02/merged.js';

/**
 * P3.1p T03 fringe Delaunay flips (docs/plans/p3-r2-tiling-rev4-contract.md, D-C). Test-only and
 * exact.
 *
 * Lawson flips on one cell's exterior triangles:
 *
 * - Only an edge shared by exactly two triangles of the set, used in opposite directions, can flip
 *   (asserted: any other multiple use throws `delaunay:opposite-use`). Every edge used once is a
 *   constraint.
 * - An edge pq with triangles (p, q, c) and (q, p, d) flips when d lies strictly inside the
 *   circumcircle of (p, q, c) under the winding-normalized sign, and both new triangles (p, d, c)
 *   and (q, c, d) keep the winding strictly.
 * - Order: each iteration flips the flippable edge whose endpoint pair is smallest by exact
 *   position (endpoints compared lexicographically by exact (x, y); the pair is (smaller, larger)
 *   endpoint, pairs compared lexicographically), then rescans.
 * - In place: p is the pair's smaller endpoint; the slot of the triangle using p→q becomes
 *   (p, d, c), the slot of the triangle using q→p becomes (q, c, d).
 * - Guard: after 10,000 flips with a flippable edge still left, `partition:delaunay` is thrown.
 *
 * Only exact positions decide anything, so the result is invariant under renumbering the points.
 */

export type Tri = [number, number, number];

export const DELAUNAY_GUARD = 10_000;

const orient = (a: Q2, b: Q2, c: Q2) =>
  sign(sub(mul(sub(b[0], a[0]), sub(c[1], a[1])), mul(sub(b[1], a[1]), sub(c[0], a[0]))));

/** Sign of the incircle determinant: positive when d is inside the circle of CCW (a, b, c). */
export function incircle(a: Q2, b: Q2, c: Q2, d: Q2): -1 | 0 | 1 {
  const rows = [a, b, c].map((p) => {
    const x = sub(p[0], d[0]);
    const y = sub(p[1], d[1]);
    return [x, y, add(mul(x, x), mul(y, y))] as const;
  });
  const [r0, r1, r2] = rows as [(typeof rows)[0], (typeof rows)[0], (typeof rows)[0]];
  const det = add(
    sub(
      mul(r0[0], sub(mul(r1[1], r2[2]), mul(r1[2], r2[1]))),
      mul(r0[1], sub(mul(r1[0], r2[2]), mul(r1[2], r2[0]))),
    ),
    mul(r0[2], sub(mul(r1[0], r2[1]), mul(r1[1], r2[0]))),
  );
  return sign(det);
}

const comparePositions = (left: Q2, right: Q2) =>
  compare(left[0], right[0]) || compare(left[1], right[1]);

type EdgeUse = { lo: number; hi: number; forward: number[]; backward: number[] };

/**
 * Exact Lawson flips of `triangles` (indices into `points`) toward the constrained Delaunay
 * triangulation, in the given region winding. Returns new triangles, slot for slot.
 */
export function delaunayFlip(
  points: readonly Q2[],
  triangles: readonly (readonly [number, number, number])[],
  winding: 1 | -1,
): Tri[] {
  const tris: Tri[] = triangles.map((t) => [t[0], t[1], t[2]]);
  if (tris.length < 2) return tris;

  // Rank the referenced points by exact position (equal positions share a rank).
  const used = [...new Set(tris.flat())].sort((a, b) => comparePositions(points[a]!, points[b]!));
  const rank = new Map<number, number>();
  used.forEach((id, k) => {
    const previous = used[k - 1];
    rank.set(
      id,
      previous !== undefined && comparePositions(points[previous]!, points[id]!) === 0
        ? rank.get(previous)!
        : k,
    );
  });
  /** Pair order: (smaller, larger) endpoint by position; index only breaks exact-position ties. */
  const orderPair = (a: number, b: number): [number, number] => {
    const ra = rank.get(a)!;
    const rb = rank.get(b)!;
    return ra < rb || (ra === rb && a < b) ? [a, b] : [b, a];
  };

  const decided = new Map<string, boolean>();
  const shouldFlip = (p: number, q: number, c: number, d: number): boolean => {
    const key = `${p},${q},${c},${d}`;
    const known = decided.get(key);
    if (known !== undefined) return known;
    const P = points[p]!;
    const Q = points[q]!;
    const C = points[c]!;
    const D = points[d]!;
    const result =
      incircle(P, Q, C, D) * winding > 0 &&
      orient(P, D, C) === winding &&
      orient(Q, C, D) === winding;
    decided.set(key, result);
    return result;
  };

  for (let iteration = 0; ; iteration += 1) {
    const uses = new Map<string, EdgeUse>();
    tris.forEach((t, slot) => {
      for (let k = 0; k < 3; k += 1) {
        const from = t[k]!;
        const to = t[(k + 1) % 3]!;
        const [lo, hi] = orderPair(from, to);
        const key = `${lo},${hi}`;
        const entry = uses.get(key) ?? { lo, hi, forward: [], backward: [] };
        (from === lo ? entry.forward : entry.backward).push(slot);
        uses.set(key, entry);
      }
    });
    const shared: EdgeUse[] = [];
    for (const entry of uses.values()) {
      const count = entry.forward.length + entry.backward.length;
      if (count === 1) continue;
      if (count !== 2 || entry.forward.length !== 1) throw new Error('delaunay:opposite-use');
      shared.push(entry);
    }
    shared.sort(
      (x, y) =>
        rank.get(x.lo)! - rank.get(y.lo)! ||
        x.lo - y.lo ||
        rank.get(x.hi)! - rank.get(y.hi)! ||
        x.hi - y.hi,
    );
    let chosen: { entry: EdgeUse; c: number; d: number } | null = null;
    for (const entry of shared) {
      const p = entry.lo;
      const q = entry.hi;
      const c = tris[entry.forward[0]!]!.find((v) => v !== p && v !== q)!;
      const d = tris[entry.backward[0]!]!.find((v) => v !== p && v !== q)!;
      if (shouldFlip(p, q, c, d)) {
        chosen = { entry, c, d };
        break;
      }
    }
    if (chosen === null) return tris;
    if (iteration >= DELAUNAY_GUARD) throw new Error('partition:delaunay');
    const { entry, c, d } = chosen;
    tris[entry.forward[0]!] = [entry.lo, d, c];
    tris[entry.backward[0]!] = [entry.hi, c, d];
  }
}

/** Region winding of a merged mesh: the orientation of its first non-degenerate triangle. */
export function meshWinding(mesh: MergedMesh): 1 | -1 {
  for (const { ids } of mesh.triangles) {
    const s = orient(
      mesh.records[ids[0]]!.pos,
      mesh.records[ids[1]]!.pos,
      mesh.records[ids[2]]!.pos,
    );
    if (s !== 0) return s;
  }
  return 1;
}

/**
 * D-C on a merged mesh: each fringe cell's exterior triangles (role `exterior`, by `cell`) are
 * flipped by `delaunayFlip` in the region winding `sourceContext(input).winding` (the sign of the
 * first non-degenerate source triangle, as `merged.ts` determines it; it equals `meshWinding`
 * because every merged triangle is emitted in the region winding). Throws `partition:delaunay`
 * (guard) or `delaunay:opposite-use` (assertion).
 * Records, triangle order and slots are unchanged; only exterior triangle ids are replaced.
 */
export function flipMergedExteriors(
  input: ProjectionInput,
  mesh: MergedMesh,
  winding: 1 | -1 = sourceContext(input).winding,
): MergedMesh {
  const points = mesh.records.map((record) => record.pos);
  const slotsByCell = new Map<number, number[]>();
  mesh.triangles.forEach((triangle, slot) => {
    if (triangle.role !== 'exterior') return;
    const list = slotsByCell.get(triangle.cell) ?? [];
    list.push(slot);
    slotsByCell.set(triangle.cell, list);
  });
  const triangles = mesh.triangles.map((triangle) => ({
    ...triangle,
    ids: [...triangle.ids] as [number, number, number],
  }));
  for (const slots of slotsByCell.values()) {
    const flipped = delaunayFlip(
      points,
      slots.map((slot) => mesh.triangles[slot]!.ids),
      winding,
    );
    slots.forEach((slot, k) => {
      triangles[slot]!.ids = flipped[k]!;
    });
  }
  return { ...mesh, triangles };
}
