import type { ProjectionInput } from '../mesh-projection/model.js';
import {
  absolute,
  add,
  compare,
  mul,
  rational,
  sign,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import { q, sqrtUp } from './certificate.js';

/**
 * P3.1n R0a independent cross-check (docs/plans/p3-r0a-wedge-clearance-contract.md,
 * role "Sol medium"). Recomputes W4 exterior-wedge identification and both W2/W3 margins
 * without importing the primary wedge module. Test-only; adopts nothing.
 */

type Mesh = ProjectionInput['mesh'];
type Vec = readonly [Rational, Rational];

export type IndependentWedge = Readonly<{ vertex: number; a: number; b: number }>;

export type IndependentWedgeResult = Readonly<{
  vertex: number;
  a: number;
  b: number;
  margin: 'cross' | 'W' | null;
  pass: boolean;
  slack: Rational;
}>;

const ZERO = rational(0n);
const TWO = rational(2n);
const FOUR = rational(4n);
const EIGHT = rational(8n);
const SHIFT = 1n << 128n;

function integerSqrtFloor(value: bigint): bigint {
  if (value <= 0n) return 0n;
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / 2) + 1);
  for (;;) {
    const y = (x + value / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > value) x -= 1n;
  while ((x + 1n) * (x + 1n) <= value) x += 1n;
  return x;
}

/** Largest k / 2^64 with (k / 2^64)^2 <= floor(value * 2^128) / 2^128; zero for value <= 0. */
export function independentSqrtDown(value: Rational): Rational {
  if (value.n <= 0n) return ZERO;
  const scaled = (value.n * SHIFT) / value.d;
  return rational(integerSqrtFloor(scaled), 1n << 64n);
}

const vx = (p: Vec): Rational => p[0];
const vy = (p: Vec): Rational => p[1];
const crossOf = (u: Vec, v: Vec): Rational => sub(mul(vx(u), vy(v)), mul(vy(u), vx(v)));
const dotOf = (u: Vec, v: Vec): Rational => add(mul(vx(u), vx(v)), mul(vy(u), vy(v)));
const l1Of = (u: Vec): Rational => add(absolute(vx(u)), absolute(vy(u)));
const maxR = (l: Rational, r: Rational): Rational => (compare(l, r) >= 0 ? l : r);
const minR = (l: Rational, r: Rational): Rational => (compare(l, r) <= 0 ? l : r);

/** 0 for the half-plane y > 0 or (y = 0, x > 0); 1 otherwise. */
function halfPlane(u: Vec): 0 | 1 {
  const sy = sign(vy(u));
  if (sy > 0) return 0;
  if (sy === 0 && sign(vx(u)) > 0) return 0;
  return 1;
}

function exactPoints(mesh: Mesh): Vec[] {
  return mesh.vertices.map(([x, y]): Vec => [q(x), q(y)]);
}

/** W4: exterior consecutive CCW ray pairs per referenced vertex, ascending vertex index. */
export function independentExteriorWedges(mesh: Mesh): readonly IndependentWedge[] {
  const points = exactPoints(mesh);
  const triangles: (readonly [number, number, number])[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3)
    triangles.push([mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!]);

  // Orientation: one shared nonzero sign.
  let sigma: -1 | 0 | 1 = 0;
  for (const [i, j, k] of triangles) {
    const p = points[i]!;
    const s = sign(
      crossOf(
        [sub(points[j]![0], p[0]), sub(points[j]![1], p[1])],
        [sub(points[k]![0], p[0]), sub(points[k]![1], p[1])],
      ),
    );
    if (s === 0 || (sigma !== 0 && s !== sigma)) throw new Error('input:wedge-orientation');
    sigma = s;
  }
  if (sigma === 0) return [];

  // Directed edges: each used at most once.
  const directed = new Set<string>();
  for (const [i, j, k] of triangles)
    for (const [from, to] of [
      [i, j],
      [j, k],
      [k, i],
    ] as const) {
      const key = `${from}>${to}`;
      if (directed.has(key)) throw new Error('input:wedge-nonmanifold');
      directed.add(key);
    }

  // Neighbor sets and interior ordered pairs (neighbor indices) per vertex.
  const neighbors = new Map<number, Set<number>>();
  const interior = new Map<number, Set<string>>();
  const note = (p: number, x: number, y: number) => {
    if (!neighbors.has(p)) neighbors.set(p, new Set());
    if (!interior.has(p)) interior.set(p, new Set());
    neighbors.get(p)!.add(x).add(y);
    interior.get(p)!.add(sigma > 0 ? `${x},${y}` : `${y},${x}`);
  };
  for (const [i, j, k] of triangles) {
    note(i, j, k);
    note(j, k, i);
    note(k, i, j);
  }

  const result: IndependentWedge[] = [];
  const vertices = [...neighbors.keys()].sort((l, r) => l - r);
  for (const vertex of vertices) {
    const origin = points[vertex]!;
    const rays = [...neighbors.get(vertex)!].map((n) => ({
      n,
      ray: [sub(points[n]![0], origin[0]), sub(points[n]![1], origin[1])] as Vec,
    }));
    for (let i = 0; i < rays.length; i += 1)
      for (let j = i + 1; j < rays.length; j += 1) {
        const u = rays[i]!.ray;
        const v = rays[j]!.ray;
        if (sign(crossOf(u, v)) === 0 && sign(dotOf(u, v)) > 0)
          throw new Error('input:wedge-degenerate');
      }
    rays.sort((l, r) => {
      const hl = halfPlane(l.ray);
      const hr = halfPlane(r.ray);
      if (hl !== hr) return hl - hr;
      return -sign(crossOf(l.ray, r.ray));
    });
    const pairs = interior.get(vertex)!;
    for (let i = 0; i < rays.length; i += 1) {
      const a = rays[i]!.n;
      const b = rays[(i + 1) % rays.length]!.n;
      if (!pairs.has(`${a},${b}`)) result.push({ vertex, a, b });
    }
  }
  return result;
}

/** W2/W3: both margins for every exterior wedge at the supplied delta^2. */
export function independentWedgeTerm(
  input: ProjectionInput,
  delta2: Rational,
): { term: 'wedge' | null; wedges: readonly IndependentWedgeResult[] } {
  const points = exactPoints(input.mesh);
  const [la, lb, lc, ld] = input.affine.slice(0, 4).map(q) as [
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const s = mul(q(input.zoom), q(input.dpr));
  const s2 = mul(s, s);
  const sigmaMax = sqrtUp(
    mul(s2, add(add(mul(la, la), mul(lb, lb)), add(mul(lc, lc), mul(ld, ld)))),
  );
  const physical = (u: Vec): Vec => [
    mul(s, add(mul(la, u[0]), mul(lc, u[1]))),
    mul(s, add(mul(lb, u[0]), mul(ld, u[1]))),
  ];
  const deltaBar = sqrtUp(delta2);
  const deltaBar2 = mul(deltaBar, deltaBar);

  const wedges: IndependentWedgeResult[] = [];
  for (const { vertex, a: na, b: nb } of independentExteriorWedges(input.mesh)) {
    const o = points[vertex]!;
    const u: Vec = [sub(points[na]![0], o[0]), sub(points[na]![1], o[1])];
    const v: Vec = [sub(points[nb]![0], o[0]), sub(points[nb]![1], o[1])];
    const a = physical(u);
    const b = physical(v);
    const aa = dotOf(a, a);
    const bb = dotOf(b, b);
    const ab = dotOf(a, b);
    const cr = crossOf(a, b);
    const lenA = minR(sqrtUp(aa), mul(sigmaMax, l1Of(u)));
    const lenB = minR(sqrtUp(bb), mul(sigmaMax, l1Of(v)));
    const lenSum = add(lenA, lenB);
    const wLo =
      sign(ab) <= 0
        ? sub(maxR(independentSqrtDown(mul(aa, bb)), rational(-ab.n, ab.d)), ab)
        : (() => {
            const root = sqrtUp(mul(aa, bb));
            return root.n === 0n ? ZERO : rational(cr.n * cr.n * root.d, cr.d * cr.d * 2n * root.n);
          })();
    const crossRhs = add(mul(mul(TWO, deltaBar), lenSum), mul(FOUR, deltaBar2));
    const wRhs = add(mul(mul(FOUR, deltaBar), lenSum), mul(EIGHT, deltaBar2));
    const crossSlack = sub(absolute(cr), crossRhs);
    const wSlack = sub(wLo, wRhs);
    const crossPass = sign(crossSlack) > 0;
    const wPass = sign(wSlack) > 0;
    let margin: 'cross' | 'W' | null = null;
    if (crossPass && wPass) margin = compare(crossSlack, wSlack) >= 0 ? 'cross' : 'W';
    else if (crossPass) margin = 'cross';
    else if (wPass) margin = 'W';
    wedges.push({
      vertex,
      a: na,
      b: nb,
      margin,
      pass: crossPass || wPass,
      slack: maxR(crossSlack, wSlack),
    });
  }
  return { term: wedges.some((w) => !w.pass) ? 'wedge' : null, wedges };
}
