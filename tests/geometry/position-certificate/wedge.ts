import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import {
  absolute,
  add,
  compare,
  div,
  mul,
  rational,
  sign,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import { certifyPosition, certifyWindow, q, sqrtUp } from './certificate.js';
import { clearanceAtDelta } from './r3-window.js';

/**
 * P3.1n R0a C2 clearance (docs/plans/p3-r0a-wedge-clearance-contract.md): the P3.1m vertex, edge
 * and triangle terms unchanged, with the all-pairs fan term replaced by an exterior-wedge term.
 */

type Mesh = ProjectionInput['mesh'];
type Q2 = readonly [Rational, Rational];

export type ExteriorWedge = Readonly<{ vertex: number; a: number; b: number }>;
export type WedgeMargin = 'cross' | 'W';
export type WedgeResult = Readonly<{
  term: 'wedge' | null;
  worst: Readonly<{
    vertex: number;
    a: number;
    b: number;
    margin: WedgeMargin | null;
    slack: Rational;
  }> | null;
}>;
export type C2Term = 'vertex' | 'edge' | 'triangle' | 'wedge';
export type C2Certificate = Readonly<{
  status: 'ADMITTED' | 'NOT_ADMITTED';
  reason: string | null;
  delta2Max: Rational;
  clearance: Readonly<{ term: C2Term | null }>;
  wedge: WedgeResult['worst'];
  p31mFan: string | null;
}>;
export type C2WindowCertificate = Readonly<{
  windowAdmitted: boolean;
  delta2: Rational;
  clearance: Readonly<{ term: C2Term | null }>;
  wedge: WedgeResult['worst'];
}>;

const ZERO = rational(0n);
const TWO = rational(2n);
const FOUR = rational(4n);
const EIGHT = rational(8n);

/** floor(sqrt(floor(v * 2^128))) / 2^64 by integer Newton iteration (0 for v <= 0). */
export function sqrtDown(value: Rational): Rational {
  if (value.n <= 0n) return ZERO;
  const scaled = (value.n << 128n) / value.d;
  if (scaled === 0n) return ZERO;
  let root = 1n << BigInt(Math.ceil(scaled.toString(2).length / 2));
  for (;;) {
    const next = (root + scaled / root) / 2n;
    if (next >= root) break;
    root = next;
  }
  while (root * root > scaled) root -= 1n;
  while ((root + 1n) * (root + 1n) <= scaled) root += 1n;
  return rational(root, 1n << 64n);
}

const minus = (a: Q2, b: Q2): Q2 => [sub(a[0], b[0]), sub(a[1], b[1])];
const cross = (u: Q2, v: Q2) => sub(mul(u[0], v[1]), mul(u[1], v[0]));
const dot = (u: Q2, v: Q2) => add(mul(u[0], v[0]), mul(u[1], v[1]));
const l1 = (u: Q2) => add(absolute(u[0]), absolute(u[1]));
const minRational = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxRational = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

/** Upper half-plane (including the positive x axis) first, then counterclockwise by cross sign. */
function angularCompare(u: Q2, v: Q2): number {
  const half = (w: Q2) => (sign(w[1]) > 0 || (sign(w[1]) === 0 && sign(w[0]) > 0) ? 0 : 1);
  const hu = half(u);
  const hv = half(v);
  if (hu !== hv) return hu - hv;
  return -sign(cross(u, v));
}

/** W4: exterior wedges on exact original local coordinates, orientation independent. */
export function exteriorWedges(mesh: Mesh): readonly ExteriorWedge[] {
  const points = mesh.vertices.map(([x, y]): Q2 => [q(x), q(y)]);
  let orientation = 0;
  const directed = new Set<string>();
  const interior = new Set<string>();
  const neighbours = new Map<number, Set<number>>();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const [p, x, y] = mesh.indices.slice(offset, offset + 3) as [number, number, number];
    const s = sign(cross(minus(points[x]!, points[p]!), minus(points[y]!, points[p]!)));
    if (s === 0 || (orientation !== 0 && s !== orientation))
      throw new Error('input:wedge-orientation');
    orientation = s;
    const ordered: [number, number, number][] =
      s > 0
        ? [
            [p, x, y],
            [x, y, p],
            [y, p, x],
          ]
        : [
            [p, y, x],
            [y, x, p],
            [x, p, y],
          ];
    for (const [v, first, second] of ordered) {
      const key = `${v}>${first}`;
      if (directed.has(key)) throw new Error('input:wedge-nonmanifold');
      directed.add(key);
      interior.add(`${v}:${first}:${second}`);
      for (const [from, to] of [
        [v, first],
        [v, second],
      ] as const) {
        if (!neighbours.has(from)) neighbours.set(from, new Set());
        neighbours.get(from)!.add(to);
      }
    }
  }
  const result: ExteriorWedge[] = [];
  for (const vertex of [...neighbours.keys()].sort((left, right) => left - right)) {
    const rays = [...neighbours.get(vertex)!].map((other) => ({
      other,
      ray: minus(points[other]!, points[vertex]!),
    }));
    rays.sort((left, right) => angularCompare(left.ray, right.ray) || left.other - right.other);
    for (let index = 0; index < rays.length; index += 1) {
      const current = rays[index]!;
      const next = rays[(index + 1) % rays.length]!;
      if (sign(cross(current.ray, next.ray)) === 0 && sign(dot(current.ray, next.ray)) > 0)
        throw new Error('input:wedge-degenerate');
      if (!interior.has(`${vertex}:${current.other}:${next.other}`))
        result.push({ vertex, a: current.other, b: next.other });
    }
  }
  return result;
}

/** W2/W3: both margins per exterior wedge in exact physical space. */
export function wedgeTerm(input: ProjectionInput, delta2: Rational): WedgeResult {
  const wedges = exteriorWedges(input.mesh);
  const [la, lb, lc, ld] = input.affine.map(q) as [Rational, Rational, Rational, Rational];
  const scale = mul(q(input.zoom), q(input.dpr));
  const s2 = mul(scale, scale);
  const sigmaMax = sqrtUp(
    mul(s2, add(add(mul(la, la), mul(lb, lb)), add(mul(lc, lc), mul(ld, ld)))),
  );
  const deltaBar = sqrtUp(delta2);
  const delta2Bar = mul(deltaBar, deltaBar);
  const points = input.mesh.vertices.map(([x, y]): Q2 => [q(x), q(y)]);
  const map = (u: Q2): Q2 => [
    mul(scale, add(mul(la, u[0]), mul(lc, u[1]))),
    mul(scale, add(mul(lb, u[0]), mul(ld, u[1]))),
  ];
  let term: 'wedge' | null = null;
  let worst: WedgeResult['worst'] = null;
  for (const wedge of wedges) {
    const u = minus(points[wedge.a]!, points[wedge.vertex]!);
    const v = minus(points[wedge.b]!, points[wedge.vertex]!);
    const a = map(u);
    const b = map(v);
    const aa = dot(a, a);
    const bb = dot(b, b);
    const ab = dot(a, b);
    const lengthA = minRational(sqrtUp(aa), mul(sigmaMax, l1(u)));
    const lengthB = minRational(sqrtUp(bb), mul(sigmaMax, l1(v)));
    const lengths = add(lengthA, lengthB);
    const c = absolute(cross(a, b));
    const wLo =
      sign(ab) <= 0
        ? sub(maxRational(sqrtDown(mul(aa, bb)), sub(ZERO, ab)), ab)
        : div(mul(c, c), mul(TWO, sqrtUp(mul(aa, bb))));
    const crossSlack = sub(c, add(mul(mul(TWO, deltaBar), lengths), mul(FOUR, delta2Bar)));
    const wSlack = sub(wLo, add(mul(mul(FOUR, deltaBar), lengths), mul(EIGHT, delta2Bar)));
    const slack = maxRational(crossSlack, wSlack);
    const pass = sign(slack) > 0;
    const margin: WedgeMargin | null = pass
      ? compare(crossSlack, wSlack) >= 0
        ? 'cross'
        : 'W'
      : null;
    if (!pass) term = 'wedge';
    if (worst === null || compare(slack, worst.slack) < 0) worst = { ...wedge, margin, slack };
  }
  return { term, worst };
}

function baseTerm(input: ProjectionInput, delta2: Rational): C2Term | null {
  const base = clearanceAtDelta(input, delta2).term;
  return base === 'fan' ? null : base;
}

/** Pointwise C2: guards, position, then vertex, edge, triangle, wedge. */
export function certifyC2(input: ProjectionInput, origin: ProjectionPoint): C2Certificate {
  const p31m = certifyPosition(input, origin);
  if (p31m.reason === 'lane-range' || p31m.reason === 'singular')
    return {
      status: 'NOT_ADMITTED',
      reason: p31m.reason,
      delta2Max: p31m.delta2Max,
      clearance: { term: null },
      wedge: null,
      p31mFan: p31m.reason,
    };
  const base = baseTerm(input, p31m.delta2Max);
  const wedge = wedgeTerm(input, p31m.delta2Max);
  const term: C2Term | null = base ?? wedge.term;
  const reason = p31m.reason?.startsWith('position:')
    ? p31m.reason
    : term === null
      ? null
      : `clearance:${term}`;
  return {
    status: reason === null ? 'ADMITTED' : 'NOT_ADMITTED',
    reason,
    delta2Max: p31m.delta2Max,
    clearance: { term },
    wedge: wedge.worst,
    p31mFan: p31m.reason,
  };
}

/** Window C2 with the R3 window delta: max over referenced vertices of ewx^2 + ewy^2. */
export function certifyC2Window(
  input: ProjectionInput,
  origin: ProjectionPoint,
  halfWidth: number,
): C2WindowCertificate {
  const window = certifyWindow(input, origin, halfWidth);
  let delta2 = ZERO;
  window.ewx.forEach((x, vertex) => {
    const y = window.ewy[vertex];
    if (x === null || y === null || y === undefined) return;
    const value = add(mul(x, x), mul(y, y));
    if (compare(value, delta2) > 0) delta2 = value;
  });
  if (window.reason === 'lane-range' || window.reason === 'singular')
    return { windowAdmitted: false, delta2, clearance: { term: null }, wedge: null };
  const base = baseTerm(input, delta2);
  const wedge = wedgeTerm(input, delta2);
  const term: C2Term | null = base ?? wedge.term;
  return {
    windowAdmitted: window.windowAdmitted && term === null,
    delta2,
    clearance: { term },
    wedge: wedge.worst,
  };
}
