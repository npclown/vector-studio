import type { ProjectionPoint } from '../mesh-projection/model.js';
import { GAMMA8, PHI, q, sqrtUp } from '../position-certificate/certificate.js';
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

/**
 * P3.1p T01 cores (docs/plans/p3-t01-extent-experiment-contract.md, "Cores" and "Implementation
 * details" 1). A verbatim re-implementation of the pinned M01 position terms
 * (position-certificate/certificate.ts), M04 clearance at δ² (r3-window.ts) and the R0a wedge term
 * (wedge.ts), over exact rational reference points and explicit lanes. The pinned files stay
 * byte-unchanged; the identity test asserts equality with them on binary64 inputs.
 */

export type Q2 = readonly [Rational, Rational];
export type Triangle = readonly [number, number, number];

/** Original (reference) data: exact local points plus the original binary64 transform. */
export type CoreInput = Readonly<{
  points: readonly Q2[];
  triangles: readonly Triangle[];
  affine: readonly [number, number, number, number, number, number];
  camera: ProjectionPoint;
  zoom: number;
  dpr: number;
  width: number;
  height: number;
}>;

/** K's binary32 lanes for one carrier (one untiled mesh or one tile). */
export type CoreLanes = Readonly<{
  midpoint: ProjectionPoint;
  local: readonly (ProjectionPoint | null)[];
  linear: readonly [number, number, number, number];
  anchor: ProjectionPoint;
  frame: ProjectionPoint;
  z: number;
  dpr: number;
}>;

const f = Math.fround;
const ZERO = rational(0n);
const ONE = rational(1n);
const TWO = rational(2n);
const FOUR = rational(4n);
const EIGHT = rational(8n);
const pow2 = (exponent: number): Rational =>
  exponent >= 0 ? rational(1n << BigInt(exponent)) : rational(1n, 1n << BigInt(-exponent));

export const LIMIT = rational(1n, 256n);
export const LANE_MAX = pow2(20);
const SCALE_MIN = pow2(-20);
const SCALE_MAX = pow2(10);
export const INPUT_MAX = pow2(60);
export const A_MAX = pow2(1000);
export { GAMMA8, PHI };

/** certificate.ts packLanes's midpoint: binary64 bbox midpoint of the given coordinates. */
export function bboxMidpoint(vertices: readonly ProjectionPoint[]): ProjectionPoint {
  const xs = vertices.map((point) => point[0]);
  const ys = vertices.map((point) => point[1]);
  return [Math.min(...xs) / 2 + Math.max(...xs) / 2, Math.min(...ys) / 2 + Math.max(...ys) / 2];
}

/**
 * K's frozen CPU graph (binary64 then Math.fround) with an explicit midpoint `m`. `stored[i]` is
 * the binary64 value carried for point i (`v64`), or null when the point is not carried here.
 */
export function packLanesCore(
  stored: readonly (ProjectionPoint | null)[],
  affine: CoreInput['affine'],
  camera: ProjectionPoint,
  zoom: number,
  dpr: number,
  midpoint: ProjectionPoint,
  origin: ProjectionPoint,
): CoreLanes {
  const [mx, my] = midpoint;
  const [a, b, c, d, e, g] = affine;
  return {
    midpoint,
    local: stored.map((point) => (point === null ? null : [f(point[0] - mx), f(point[1] - my)])),
    linear: [f(a), f(b), f(c), f(d)],
    anchor: [f(a * mx + c * my + e - origin[0]), f(b * mx + d * my + g - origin[1])],
    frame: [f(origin[0] - camera[0]), f(origin[1] - camera[1])],
    z: f(zoom),
    dpr: f(dpr),
  };
}

/** Contract domain table, original-input checks (OUT_OF_DOMAIN when false). */
export function domainOk(
  stored: readonly (ProjectionPoint | null)[],
  input: Pick<CoreInput, 'affine' | 'camera' | 'zoom' | 'dpr' | 'width' | 'height'>,
): boolean {
  for (const scale of [f(input.zoom), f(input.dpr)]) {
    if (!Number.isFinite(scale)) return false;
    const value = q(scale);
    if (compare(value, SCALE_MIN) < 0 || compare(value, SCALE_MAX) > 0) return false;
  }
  for (const size of [input.width, input.height])
    if (!Number.isSafeInteger(size) || size < 1 || size > 16_384) return false;
  const values = [
    ...stored.flatMap((point) => (point === null ? [] : [...point])),
    ...input.affine,
    ...input.camera,
    input.zoom,
    input.dpr,
  ];
  return values.every(
    (value) => Number.isFinite(value) && compare(absolute(q(value)), INPUT_MAX) <= 0,
  );
}

/** Contract domain table, lane magnitudes (NOT_ADMITTED:lane-range when false). */
export function lanesOk(lanes: CoreLanes): boolean {
  const values = [
    ...lanes.linear,
    ...lanes.local.flatMap((point) => (point === null ? [] : [...point])),
    ...lanes.anchor,
    ...lanes.frame,
  ];
  return values.every(
    (value) => Number.isFinite(value) && compare(absolute(q(value)), LANE_MAX) <= 0,
  );
}

export type AxisTerms = Readonly<{ pack: Rational; absSum: Rational; a: Rational }>;

/** certificate.ts axisTerms with the reference taken from an exact rational point. */
export function axisTermsCore(
  input: CoreInput,
  lanes: CoreLanes,
  vertex: number,
  axis: 0 | 1,
  frameLane: Rational,
  camera: Rational,
): AxisTerms {
  const [ux, uy] = lanes.local[vertex]!.map(q) as [Rational, Rational];
  const [la, lb, lc, ld] = lanes.linear.map(q) as [Rational, Rational, Rational, Rational];
  const [p, r] = axis === 0 ? [la, lc] : [lb, ld];
  const anchor = q(lanes.anchor[axis]);
  const zq = mul(q(lanes.z), q(lanes.dpr));
  const [x0, y0] = input.points[vertex]!;
  const affine = input.affine.map(q);
  const [p0, r0, t0] =
    axis === 0 ? [affine[0]!, affine[2]!, affine[4]!] : [affine[1]!, affine[3]!, affine[5]!];
  const s0 = mul(q(input.zoom), q(input.dpr));
  const carrier = mul(add(add(add(mul(p, ux), mul(r, uy)), anchor), frameLane), zq);
  const reference = mul(sub(add(add(mul(p0, x0), mul(r0, y0)), t0), camera), s0);
  const absSum = mul(
    add(
      add(add(absolute(mul(p, ux)), absolute(mul(r, uy))), absolute(anchor)),
      absolute(frameLane),
    ),
    zq,
  );
  const referenceAbs = mul(
    add(add(add(absolute(mul(p0, x0)), absolute(mul(r0, y0))), absolute(t0)), absolute(camera)),
    s0,
  );
  return { pack: absolute(sub(carrier, reference)), absSum, a: add(absSum, referenceAbs) };
}

export function shaderTerm(gamma: Rational, absSum: Rational, size: number): Rational {
  return mul(gamma, add(absSum, rational(BigInt(size), 2n)));
}

export type VertexError = Readonly<{
  ex: Rational;
  ey: Rational;
  pack: readonly [Rational, Rational];
  absSum: readonly [Rational, Rational];
}>;

/**
 * M01 per-vertex E for the listed vertices (certificate.ts certifyPosition loop body). Returns
 * 'lane-range' when Pack64's A exceeds 2^1000 for any listed vertex.
 */
export function certifyLanesCore(
  input: CoreInput,
  lanes: CoreLanes,
  vertices: readonly number[],
  gamma: Rational = GAMMA8,
): Map<number, VertexError> | 'lane-range' {
  const cameras = input.camera.map(q) as [Rational, Rational];
  const result = new Map<number, VertexError>();
  for (const vertex of vertices) {
    const terms = ([0, 1] as const).map((axis) =>
      axisTermsCore(input, lanes, vertex, axis, q(lanes.frame[axis]), cameras[axis]),
    );
    if (terms.some((term) => compare(term.a, A_MAX) > 0)) return 'lane-range';
    result.set(vertex, {
      ex: add(add(terms[0]!.pack, shaderTerm(gamma, terms[0]!.absSum, input.width)), PHI),
      ey: add(add(terms[1]!.pack, shaderTerm(gamma, terms[1]!.absSum, input.height)), PHI),
      pack: [terms[0]!.pack, terms[1]!.pack],
      absSum: [terms[0]!.absSum, terms[1]!.absSum],
    });
  }
  return result;
}

export function delta2Of(error: Pick<VertexError, 'ex' | 'ey'>): Rational {
  return add(mul(error.ex, error.ex), mul(error.ey, error.ey));
}

export function singularCore(affine: CoreInput['affine']): boolean {
  const [a, b, c, d] = affine.map(q) as [Rational, Rational, Rational, Rational];
  return sub(mul(a, d), mul(b, c)).n === 0n;
}

// ---------------------------------------------------------------------------------------------
// M04 clearance summary and terms (certificate.ts clearanceSummary, r3-window.ts clearanceAtDelta)

const cross = (u: Q2, v: Q2) => sub(mul(u[0], v[1]), mul(u[1], v[0]));
const dot = (u: Q2, v: Q2) => add(mul(u[0], v[0]), mul(u[1], v[1]));
const l1 = (u: Q2) => add(absolute(u[0]), absolute(u[1]));
const linf = (u: Q2) =>
  compare(absolute(u[0]), absolute(u[1])) >= 0 ? absolute(u[0]) : absolute(u[1]);
const minus = (a: Q2, b: Q2): Q2 => [sub(a[0], b[0]), sub(a[1], b[1])];
const minOf = (left: Rational | null, right: Rational): Rational =>
  left === null || compare(right, left) < 0 ? right : left;
const minRational = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxRational = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

function pointSegment2(p: Q2, a: Q2, b: Q2): Rational {
  const ab = minus(b, a);
  const ap = minus(p, a);
  const length2 = dot(ab, ab);
  let t = length2.n === 0n ? ZERO : div(dot(ap, ab), length2);
  if (compare(t, ZERO) < 0) t = ZERO;
  if (compare(t, ONE) > 0) t = ONE;
  const closest: Q2 = [add(a[0], mul(t, ab[0])), add(a[1], mul(t, ab[1]))];
  const delta = minus(p, closest);
  return dot(delta, delta);
}

function segmentsIntersect(a: Q2, b: Q2, c: Q2, d: Q2): boolean {
  const o1 = sign(cross(minus(b, a), minus(c, a)));
  const o2 = sign(cross(minus(b, a), minus(d, a)));
  const o3 = sign(cross(minus(d, c), minus(a, c)));
  const o4 = sign(cross(minus(d, c), minus(b, c)));
  if (o1 !== o2 && o3 !== o4) return true;
  const between = (value: Rational, s: Rational, t: Rational) =>
    compare(value, compare(s, t) < 0 ? s : t) >= 0 &&
    compare(value, compare(s, t) > 0 ? s : t) <= 0;
  const onSegment = (p: Q2, s: Q2, t: Q2) => between(p[0], s[0], t[0]) && between(p[1], s[1], t[1]);
  return (
    (o1 === 0 && onSegment(c, a, b)) ||
    (o2 === 0 && onSegment(d, a, b)) ||
    (o3 === 0 && onSegment(a, c, d)) ||
    (o4 === 0 && onSegment(b, c, d))
  );
}

export type ClearanceSummaryQ = Readonly<{
  dV2: Rational | null;
  dE2: Rational | null;
  rhoBar: Rational | null;
  kappaBar: Rational | null;
  lambdaBar: Rational | null;
  plo: Rational | null;
  overlappingFan: boolean;
}>;

/** certificate.ts clearanceSummary over exact points; indices are flat triangle triples. */
export function clearanceSummaryQ(
  points: readonly Q2[],
  indices: readonly number[],
): ClearanceSummaryQ {
  const used = [...new Set(indices)].sort((left, right) => left - right);
  let dV2: Rational | null = null;
  for (let i = 0; i < used.length; i += 1)
    for (let j = i + 1; j < used.length; j += 1) {
      const delta = minus(points[used[i]!]!, points[used[j]!]!);
      dV2 = minOf(dV2, dot(delta, delta));
    }
  const edgeKeys = new Map<string, readonly [number, number]>();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const tri = indices.slice(offset, offset + 3);
    for (let k = 0; k < 3; k += 1) {
      const a = tri[k]!;
      const b = tri[(k + 1) % 3]!;
      edgeKeys.set(a < b ? `${a},${b}` : `${b},${a}`, a < b ? [a, b] : [b, a]);
    }
  }
  const edges = [...edgeKeys.values()];
  let dE2: Rational | null = null;
  for (let i = 0; i < edges.length; i += 1)
    for (let j = i + 1; j < edges.length; j += 1) {
      const [a, b] = edges[i]!;
      const [c, d] = edges[j]!;
      if (a === c || a === d || b === c || b === d) continue;
      const [pa, pb, pc, pd] = [points[a]!, points[b]!, points[c]!, points[d]!];
      const distance = segmentsIntersect(pa, pb, pc, pd)
        ? ZERO
        : [
            pointSegment2(pa, pc, pd),
            pointSegment2(pb, pc, pd),
            pointSegment2(pc, pa, pb),
            pointSegment2(pd, pa, pb),
          ].reduce((best, value) => (compare(value, best) < 0 ? value : best));
      dE2 = minOf(dE2, distance);
    }
  let rhoBar: Rational | null = null;
  let plo: Rational | null = null;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [i, j, k] = indices.slice(offset, offset + 3) as [number, number, number];
    const u = minus(points[j]!, points[i]!);
    const v = minus(points[k]!, points[i]!);
    rhoBar = minOf(rhoBar, div(absolute(cross(u, v)), add(l1(u), l1(v))));
    plo = minOf(plo, add(linf(u), linf(v)));
  }
  let kappaBar: Rational | null = null;
  let lambdaBar: Rational | null = null;
  let overlappingFan = false;
  for (const vertex of used) {
    const rays = edges
      .filter(([a, b]) => a === vertex || b === vertex)
      .map(([a, b]) => minus(points[a === vertex ? b : a]!, points[vertex]!));
    for (let i = 0; i < rays.length; i += 1)
      for (let j = i + 1; j < rays.length; j += 1) {
        const u = rays[i]!;
        const v = rays[j]!;
        const lengths = add(l1(u), l1(v));
        plo = minOf(plo, add(linf(u), linf(v)));
        const c = cross(u, v);
        if (c.n !== 0n) kappaBar = minOf(kappaBar, div(absolute(c), lengths));
        else if (sign(dot(u, v)) < 0)
          lambdaBar = minOf(lambdaBar, div(absolute(dot(u, v)), lengths));
        else overlappingFan = true;
      }
  }
  return { dV2, dE2, rhoBar, kappaBar, lambdaBar, plo, overlappingFan };
}

export type ClearanceTermQ = 'vertex' | 'edge' | 'triangle' | 'fan';
export type ClearanceAtDeltaQ = Readonly<{
  term: ClearanceTermQ | null;
  slack: Rational | null;
  slackTerm: ClearanceTermQ | null;
  /** Every evaluated check in order: [term, LHS - RHS or null when the RHS is undefined]. */
  checks: readonly (readonly [ClearanceTermQ, Rational | null])[];
}>;

type Scale = Readonly<{ affine: CoreInput['affine']; zoom: number; dpr: number }>;

/** r3-window.ts clearanceAtDelta over exact points (affine linear part, zoom and DPR). */
export function clearanceAtDeltaQ(
  points: readonly Q2[],
  indices: readonly number[],
  scale: Scale,
  delta2: Rational,
): ClearanceAtDeltaQ {
  const summary = clearanceSummaryQ(points, indices);
  const [a, b, c, d] = scale.affine.map(q) as [Rational, Rational, Rational, Rational];
  const s = mul(q(scale.zoom), q(scale.dpr));
  const s2 = mul(s, s);
  const detS = absolute(mul(s2, sub(mul(a, d), mul(b, c))));
  const sigmaMax = sqrtUp(mul(s2, add(add(mul(a, a), mul(b, b)), add(mul(c, c), mul(d, d)))));
  const sigmaLo = div(detS, sigmaMax);
  const sigmaLo2 = mul(sigmaLo, sigmaLo);
  const deltaBar = sqrtUp(delta2);
  const delta2Bar = mul(deltaBar, deltaBar);
  const rhs =
    summary.plo === null || summary.plo.n === 0n
      ? null
      : add(mul(mul(TWO, deltaBar), sigmaMax), div(mul(FOUR, delta2Bar), summary.plo));
  const checks: [ClearanceTermQ, Rational | null][] = [];
  if (summary.dV2 !== null)
    checks.push(['vertex', sub(mul(sigmaLo2, summary.dV2), mul(FOUR, delta2Bar))]);
  if (summary.dE2 !== null)
    checks.push(['edge', sub(mul(sigmaLo2, summary.dE2), mul(FOUR, delta2Bar))]);
  if (summary.rhoBar !== null)
    checks.push(['triangle', rhs === null ? null : sub(mul(detS, summary.rhoBar), rhs)]);
  if (summary.overlappingFan) checks.push(['fan', null]);
  if (summary.kappaBar !== null)
    checks.push(['fan', rhs === null ? null : sub(mul(detS, summary.kappaBar), rhs)]);
  if (summary.lambdaBar !== null)
    checks.push(['fan', rhs === null ? null : sub(mul(sigmaLo2, summary.lambdaBar), rhs)]);
  let term: ClearanceTermQ | null = null;
  let slack: Rational | null = null;
  let slackTerm: ClearanceTermQ | null = null;
  for (const [name, value] of checks) {
    if (term === null && (value === null || value.n <= 0n)) term = name;
    if (value !== null && (slack === null || compare(value, slack) < 0)) {
      slack = value;
      slackTerm = name;
    }
  }
  return { term, slack, slackTerm, checks };
}

// ---------------------------------------------------------------------------------------------
// R0a wedge term (wedge.ts exteriorWedges and wedgeTerm)

export type ExteriorWedgeQ = Readonly<{ vertex: number; a: number; b: number }>;

/** Upper half-plane (including the positive x axis) first, then counterclockwise by cross sign. */
function angularCompare(u: Q2, v: Q2): number {
  const half = (w: Q2) => (sign(w[1]) > 0 || (sign(w[1]) === 0 && sign(w[0]) > 0) ? 0 : 1);
  const hu = half(u);
  const hv = half(v);
  if (hu !== hv) return hu - hv;
  return -sign(cross(u, v));
}

export function exteriorWedgesQ(
  points: readonly Q2[],
  indices: readonly number[],
): readonly ExteriorWedgeQ[] {
  let orientation = 0;
  const directed = new Set<string>();
  const interior = new Set<string>();
  const neighbours = new Map<number, Set<number>>();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [p, x, y] = indices.slice(offset, offset + 3) as [number, number, number];
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
  const result: ExteriorWedgeQ[] = [];
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

/** floor(sqrt(floor(v * 2^128))) / 2^64 (wedge.ts sqrtDown). */
function sqrtDown(value: Rational): Rational {
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

export type WedgeResultQ = Readonly<{
  term: 'wedge' | null;
  worst: Readonly<{
    vertex: number;
    a: number;
    b: number;
    margin: 'cross' | 'W' | null;
    slack: Rational;
  }> | null;
}>;

export function wedgeTermQ(
  points: readonly Q2[],
  indices: readonly number[],
  scale: Scale,
  delta2: Rational,
): WedgeResultQ {
  const wedges = exteriorWedgesQ(points, indices);
  const [la, lb, lc, ld] = scale.affine.map(q) as [Rational, Rational, Rational, Rational];
  const s = mul(q(scale.zoom), q(scale.dpr));
  const s2 = mul(s, s);
  const sigmaMax = sqrtUp(
    mul(s2, add(add(mul(la, la), mul(lb, lb)), add(mul(lc, lc), mul(ld, ld)))),
  );
  const deltaBar = sqrtUp(delta2);
  const delta2Bar = mul(deltaBar, deltaBar);
  const map = (u: Q2): Q2 => [
    mul(s, add(mul(la, u[0]), mul(lc, u[1]))),
    mul(s, add(mul(lb, u[0]), mul(ld, u[1]))),
  ];
  let term: 'wedge' | null = null;
  let worst: WedgeResultQ['worst'] = null;
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
    const margin = pass ? (compare(crossSlack, wSlack) >= 0 ? 'cross' : 'W') : null;
    if (!pass) term = 'wedge';
    if (worst === null || compare(slack, worst.slack) < 0) worst = { ...wedge, margin, slack };
  }
  return { term, worst };
}

export type C2Term = 'vertex' | 'edge' | 'triangle' | 'wedge';
export type C2Q = Readonly<{
  term: C2Term | null;
  /** Per-term smallest slack (null when not evaluated or its RHS is undefined). */
  slacks: Readonly<Record<C2Term, Rational | null>>;
  /** Per-term failure (evaluated and slack ≤ 0 or undefined RHS). */
  failing: Readonly<Record<C2Term, boolean>>;
}>;

/** wedge.ts C2 clearance (vertex, edge, triangle, wedge; the M04 fan term is replaced). */
export function c2Q(
  points: readonly Q2[],
  indices: readonly number[],
  scale: Scale,
  delta2: Rational,
): C2Q {
  const base = clearanceAtDeltaQ(points, indices, scale, delta2);
  const wedge = wedgeTermQ(points, indices, scale, delta2);
  const slacks: Record<C2Term, Rational | null> = {
    vertex: null,
    edge: null,
    triangle: null,
    wedge: wedge.worst?.slack ?? null,
  };
  const failing: Record<C2Term, boolean> = {
    vertex: false,
    edge: false,
    triangle: false,
    wedge: wedge.term === 'wedge',
  };
  for (const [name, value] of base.checks) {
    if (name === 'fan') continue;
    if (value === null || value.n <= 0n) failing[name] = true;
    if (value !== null && (slacks[name] === null || compare(value, slacks[name]) < 0))
      slacks[name] = value;
  }
  const baseTerm = base.term === 'fan' ? null : base.term;
  return { term: baseTerm ?? wedge.term, slacks, failing };
}
