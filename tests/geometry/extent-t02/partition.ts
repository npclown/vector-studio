import { add, compare, mul, rational, sign, type Rational } from '../rounded-fill/exact.js';
import { cross3, type Q2 } from '../extent-t01/clip.js';
import { pow2 } from '../extent-t01/tile.js';
import { onClosedSegment, pointKey } from './fringe.js';
import { cellKey, type MergedMesh } from './merged.js';

/**
 * P3.1p T02 S4 partition check (docs/plans/p3-r2-tiling-contract.md, "S4. Partition"): O02's exact
 * partition check on the drawn merged mesh. Checks run in this order, the first failure wins:
 *
 * 1. `orientation:t<index>`: every triangle has the same non-zero exact orientation.
 * 2. `duplicate-record:<a>:<b>`: no two referenced records share an exact position.
 * 3. `t-junction:<v>:<a>:<b>`: no referenced record lies strictly inside a triangle edge. Records
 *    are bucketed by owner cell; an edge of a triangle of cell (i, j) lies in that closed square, so
 *    only the owners {i, i+1} × {j, j+1} are scanned.
 * 4. `edge-use:<a>:<b>`: every edge is used twice in opposite directions, except an edge on a side
 *    of its triangle's (drawn) cell whose neighbour across that side is not drawn, used once.
 * 5. `area`: the total |area| equals (drawn cells) · 2^(2L), drawn = region or fringe.
 *
 * T-junction runs before edge use because a T-junction always also breaks edge pairing, and the
 * narrower diagnosis is the more useful one.
 */

export type PartitionResult = Readonly<{ ok: true }> | Readonly<{ ok: false; check: string }>;

export function checkMergedPartition(mesh: MergedMesh): PartitionResult {
  const failed = (check: string): PartitionResult => ({ ok: false, check });
  const pos = (id: number): Q2 => mesh.records[id]!.pos;

  // 1. Orientation.
  let orientation = 0;
  let total: Rational = rational(0n);
  for (let t = 0; t < mesh.triangles.length; t += 1) {
    const [a, b, c] = mesh.triangles[t]!.ids;
    const twice = cross3(pos(a), pos(b), pos(c));
    const s = sign(twice);
    if (s === 0 || (orientation !== 0 && s !== orientation)) return failed(`orientation:t${t}`);
    orientation = s;
    total = add(total, s < 0 ? rational(-twice.n, twice.d) : twice);
  }

  // 2. Duplicate record positions.
  const used = [...new Set(mesh.triangles.flatMap((triangle) => triangle.ids))].sort(
    (a, b) => a - b,
  );
  const seen = new Map<string, number>();
  for (const id of used) {
    const key = pointKey(pos(id));
    const previous = seen.get(key);
    if (previous !== undefined) return failed(`duplicate-record:${previous}:${id}`);
    seen.set(key, id);
  }

  // Edge uses.
  const uses = new Map<
    string,
    { a: number; b: number; forward: number; backward: number; cell: number }
  >();
  for (const triangle of mesh.triangles)
    for (let side = 0; side < 3; side += 1) {
      const p = triangle.ids[side]!;
      const q = triangle.ids[(side + 1) % 3]!;
      const a = Math.min(p, q);
      const b = Math.max(p, q);
      const key = `${a}:${b}`;
      const entry = uses.get(key) ?? { a, b, forward: 0, backward: 0, cell: triangle.cell };
      if (p === a) entry.forward += 1;
      else entry.backward += 1;
      uses.set(key, entry);
    }
  const entries = [...uses.values()].sort((x, y) => x.a - y.a || x.b - y.b);

  // 3. T-junctions, bucketed by owner cell.
  const buckets = new Map<string, number[]>();
  for (const id of used) {
    const key = cellKey(...mesh.records[id]!.owner);
    const list = buckets.get(key) ?? [];
    list.push(id);
    buckets.set(key, list);
  }
  for (const entry of entries) {
    const { i, j } = mesh.cells[entry.cell]!;
    const A = pos(entry.a);
    const B = pos(entry.b);
    for (const [di, dj] of [
      [0n, 0n],
      [1n, 0n],
      [0n, 1n],
      [1n, 1n],
    ] as const)
      for (const v of buckets.get(cellKey(i + di, j + dj)) ?? []) {
        if (v === entry.a || v === entry.b) continue;
        if (onClosedSegment(pos(v), A, B)) return failed(`t-junction:${v}:${entry.a}:${entry.b}`);
      }
  }

  // 4. Edge use.
  const drawn = new Set(
    mesh.cells.filter((cell) => cell.region || cell.fringe).map((cell) => cellKey(cell.i, cell.j)),
  );
  const side = pow2(mesh.L);
  for (const entry of entries) {
    if (entry.forward === 1 && entry.backward === 1) continue;
    if (entry.forward + entry.backward === 1) {
      const { i, j } = mesh.cells[entry.cell]!;
      const A = pos(entry.a);
      const B = pos(entry.b);
      const x0 = mul(rational(i), side);
      const x1 = mul(rational(i + 1n), side);
      const y0 = mul(rational(j), side);
      const y1 = mul(rational(j + 1n), side);
      const both = (axis: 0 | 1, value: Rational) =>
        compare(A[axis], value) === 0 && compare(B[axis], value) === 0;
      const across: [bigint, bigint] | null = both(0, x0)
        ? [i - 1n, j]
        : both(0, x1)
          ? [i + 1n, j]
          : both(1, y0)
            ? [i, j - 1n]
            : both(1, y1)
              ? [i, j + 1n]
              : null;
      if (across !== null && !drawn.has(cellKey(...across))) continue;
    }
    return failed(`edge-use:${entry.a}:${entry.b}`);
  }

  // 5. Area.
  const expected = mul(rational(2n * BigInt(drawn.size)), mul(side, side));
  if (compare(total, expected) !== 0) return failed('area');
  return { ok: true };
}
