import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import {
  absolute,
  add,
  bitsOf,
  compare,
  div,
  exactInteger,
  mul,
  rational,
  sign,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';

/**
 * P3.1m N01: test-only sufficient position certificate for K's mesh-local carrier
 * (docs/plans/p3-position-certificate-contract.md). It never adopts runtime behavior.
 */

export type ClearanceTerm = 'vertex' | 'edge' | 'triangle' | 'fan';

export type PositionCertificate = Readonly<{
  status: 'ADMITTED' | 'NOT_ADMITTED';
  reason: string | null;
  ex: readonly (Rational | null)[];
  ey: readonly (Rational | null)[];
  delta2Max: Rational;
  worstVertex: number;
  clearance: Readonly<{ term: ClearanceTerm | null; collinear: boolean | null }>;
  pack: readonly (readonly [Rational, Rational] | null)[];
}>;

export type WindowCertificate = PositionCertificate &
  Readonly<{
    ewx: readonly (Rational | null)[];
    ewy: readonly (Rational | null)[];
    windowAdmitted: boolean;
  }>;

export type ClearanceSummary = Readonly<{
  dV2: Rational | null;
  dE2: Rational | null;
  rhoBar: Rational | null;
  kappaBar: Rational | null;
  lambdaBar: Rational | null;
  /** Minimum L-infinity length sum over triangle and fan pairs (the conservative shared Plo). */
  plo: Rational | null;
  /** True when two incident edges overlap in the same direction (never certifiable). */
  overlappingFan: boolean;
}>;

type Overrides = Readonly<{ gamma?: Rational; packZero?: boolean }>;
type Mesh = ProjectionInput['mesh'];
type Q2 = readonly [Rational, Rational];

const f = Math.fround;
const ZERO = rational(0n);
const ONE = rational(1n);
const TWO = rational(2n);
const FOUR = rational(4n);
const pow2 = (exponent: number): Rational =>
  exponent >= 0 ? rational(1n << BigInt(exponent)) : rational(1n, 1n << BigInt(-exponent));

function gamma(additions: number): Rational {
  let product = add(ONE, mul(rational(5n, 2n), pow2(-23)));
  for (let index = 0; index < additions; index += 1) product = mul(product, add(ONE, pow2(-23)));
  return sub(product, ONE);
}

export const GAMMA8 = gamma(8);
export const GAMMA9 = gamma(9);
export const PHI = pow2(-40);
const LIMIT = rational(1n, 256n);
const LANE_MAX = pow2(20);
const SCALE_MIN = pow2(-20);
const SCALE_MAX = pow2(10);
const INPUT_MAX = pow2(60);
const A_MAX = pow2(1000);
const F_LANE_REL = add(pow2(-24), pow2(-52));
const F_LANE_ABS = pow2(-149);

/** Unscaled exact value of a finite binary64 number (binary32 lanes are binary64 values). */
export function q(value: number): Rational {
  return rational(exactInteger(bitsOf(value)), 1n << 1074n);
}

function maxOf(values: readonly Rational[]): Rational {
  return values.reduce((best, value) => (compare(value, best) > 0 ? value : best));
}

function minOf(left: Rational | null, right: Rational): Rational {
  return left === null || compare(right, left) < 0 ? right : left;
}

/** Smallest k / 2^64 whose square is at least `value` (upward rational square root). */
export function sqrtUp(value: Rational): Rational {
  if (value.n <= 0n) return ZERO;
  const scaled = (value.n * (1n << 128n) + value.d - 1n) / value.d;
  let root = 1n << BigInt(Math.ceil(scaled.toString(2).length / 2));
  for (;;) {
    const next = (root + scaled / root) / 2n;
    if (next >= root) break;
    root = next;
  }
  while (root * root > scaled) root -= 1n;
  while (root * root < scaled) root += 1n;
  return rational(root, 1n << 64n);
}

type Lanes = Readonly<{
  local: readonly ProjectionPoint[];
  linear: readonly [number, number, number, number];
  anchor: ProjectionPoint;
  frame: ProjectionPoint;
  z: number;
  dpr: number;
}>;

/** K's frozen CPU graph (binary64 then Math.fround), with the supplied origin. */
function packLanes(input: ProjectionInput, origin: ProjectionPoint): Lanes {
  const vertices = input.mesh.vertices;
  const xs = vertices.map((point) => point[0]);
  const ys = vertices.map((point) => point[1]);
  const mx = Math.min(...xs) / 2 + Math.max(...xs) / 2;
  const my = Math.min(...ys) / 2 + Math.max(...ys) / 2;
  const [a, b, c, d, e, g] = input.affine;
  return {
    local: vertices.map(([x, y]) => [f(x - mx), f(y - my)] as const),
    linear: [f(a), f(b), f(c), f(d)],
    anchor: [f(a * mx + c * my + e - origin[0]), f(b * mx + d * my + g - origin[1])],
    frame: [f(origin[0] - input.camera[0]), f(origin[1] - input.camera[1])],
    z: f(input.zoom),
    dpr: f(input.dpr),
  };
}

function referencedVertices(mesh: Mesh): number[] {
  return [...new Set(mesh.indices)].sort((left, right) => left - right);
}

function originalsWithin(input: ProjectionInput): boolean {
  const values = [
    ...input.mesh.vertices.flat(),
    ...input.affine,
    ...input.camera,
    input.zoom,
    input.dpr,
  ];
  return values.every(
    (value) => Number.isFinite(value) && compare(absolute(q(value)), INPUT_MAX) <= 0,
  );
}

function laneRangeOk(input: ProjectionInput, lanes: Lanes): boolean {
  const laneValues = [...lanes.linear, ...lanes.local.flat(), ...lanes.anchor, ...lanes.frame];
  if (
    !laneValues.every(
      (value) => Number.isFinite(value) && compare(absolute(q(value)), LANE_MAX) <= 0,
    )
  )
    return false;
  for (const scale of [lanes.z, lanes.dpr]) {
    if (!Number.isFinite(scale)) return false;
    const value = q(scale);
    if (compare(value, SCALE_MIN) < 0 || compare(value, SCALE_MAX) > 0) return false;
  }
  for (const size of [input.width, input.height])
    if (!Number.isSafeInteger(size) || size < 1 || size > 16_384) return false;
  return originalsWithin(input);
}

type AxisTerms = Readonly<{ pack: Rational; absSum: Rational; a: Rational }>;

/** Exact Pack, Shader absolute monomial sum (without W/2) and Pack64's A, per axis. */
function axisTerms(
  input: ProjectionInput,
  lanes: Lanes,
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
  const [x0, y0] = input.mesh.vertices[vertex]!.map(q) as [Rational, Rational];
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

function shader(gamma: Rational, absSum: Rational, size: number): Rational {
  return mul(gamma, add(absSum, rational(BigInt(size), 2n)));
}

function cross(u: Q2, v: Q2): Rational {
  return sub(mul(u[0], v[1]), mul(u[1], v[0]));
}

function dot(u: Q2, v: Q2): Rational {
  return add(mul(u[0], v[0]), mul(u[1], v[1]));
}

function l1(u: Q2): Rational {
  return add(absolute(u[0]), absolute(u[1]));
}

function linf(u: Q2): Rational {
  return compare(absolute(u[0]), absolute(u[1])) >= 0 ? absolute(u[0]) : absolute(u[1]);
}

function minus(a: Q2, b: Q2): Q2 {
  return [sub(a[0], b[0]), sub(a[1], b[1])];
}

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

/** Geometry-owned exact clearance summaries over original local coordinates (M04). */
export function clearanceSummary(mesh: Mesh): ClearanceSummary {
  const points = mesh.vertices.map(([x, y]): Q2 => [q(x), q(y)]);
  const used = referencedVertices(mesh);
  let dV2: Rational | null = null;
  for (let i = 0; i < used.length; i += 1)
    for (let j = i + 1; j < used.length; j += 1) {
      const delta = minus(points[used[i]!]!, points[used[j]!]!);
      dV2 = minOf(dV2, dot(delta, delta));
    }
  const edgeKeys = new Map<string, readonly [number, number]>();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const tri = mesh.indices.slice(offset, offset + 3);
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
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const [i, j, k] = mesh.indices.slice(offset, offset + 3) as [number, number, number];
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
        // Conservative shared Plo: the fan pairs also bound the perturbation denominator.
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

function clearanceTerm(
  input: ProjectionInput,
  summary: ClearanceSummary,
  delta2Max: Rational,
): { term: ClearanceTerm | null; collinear: boolean | null } {
  const [a, b, c, d] = input.affine.map(q) as [Rational, Rational, Rational, Rational];
  const s2 = mul(mul(q(input.zoom), q(input.dpr)), mul(q(input.zoom), q(input.dpr)));
  const detS = absolute(mul(s2, sub(mul(a, d), mul(b, c))));
  const sigmaMax = sqrtUp(mul(s2, add(add(mul(a, a), mul(b, b)), add(mul(c, c), mul(d, d)))));
  const sigmaLo = div(detS, sigmaMax);
  const sigmaLo2 = mul(sigmaLo, sigmaLo);
  const deltaBar = sqrtUp(delta2Max);
  const delta2Bar = mul(deltaBar, deltaBar);
  if (summary.dV2 !== null && compare(mul(sigmaLo2, summary.dV2), mul(FOUR, delta2Bar)) <= 0)
    return { term: 'vertex', collinear: null };
  if (summary.dE2 !== null && compare(mul(sigmaLo2, summary.dE2), mul(FOUR, delta2Bar)) <= 0)
    return { term: 'edge', collinear: null };
  const rhs =
    summary.plo === null || summary.plo.n === 0n
      ? null
      : add(mul(mul(TWO, deltaBar), sigmaMax), div(mul(FOUR, delta2Bar), summary.plo));
  if (summary.rhoBar !== null && (rhs === null || compare(mul(detS, summary.rhoBar), rhs) <= 0))
    return { term: 'triangle', collinear: null };
  if (summary.overlappingFan) return { term: 'fan', collinear: true };
  if (summary.kappaBar !== null && (rhs === null || compare(mul(detS, summary.kappaBar), rhs) <= 0))
    return { term: 'fan', collinear: false };
  if (
    summary.lambdaBar !== null &&
    (rhs === null || compare(mul(sigmaLo2, summary.lambdaBar), rhs) <= 0)
  )
    return { term: 'fan', collinear: true };
  return { term: null, collinear: null };
}

function rejected(reason: string, count: number): PositionCertificate {
  const nulls = Array.from({ length: count }, () => null);
  return {
    status: 'NOT_ADMITTED',
    reason,
    ex: nulls,
    ey: nulls,
    delta2Max: ZERO,
    worstVertex: -1,
    clearance: { term: null, collinear: null },
    pack: nulls,
  };
}

function singular(input: ProjectionInput): boolean {
  const [a, b, c, d] = input.affine.map(q) as [Rational, Rational, Rational, Rational];
  return sub(mul(a, d), mul(b, c)).n === 0n;
}

/** Pointwise certificate at the input's camera with the supplied origin (M01/M03/M04). */
export function certifyPosition(
  input: ProjectionInput,
  origin: ProjectionPoint,
  overrides: Overrides = {},
): PositionCertificate {
  const count = input.mesh.vertices.length;
  const lanes = packLanes(input, origin);
  if (!laneRangeOk(input, lanes)) return rejected('lane-range', count);
  const gamma = overrides.gamma ?? GAMMA8;
  const ex: (Rational | null)[] = Array.from({ length: count }, () => null);
  const ey: (Rational | null)[] = Array.from({ length: count }, () => null);
  const pack: ([Rational, Rational] | null)[] = Array.from({ length: count }, () => null);
  const cameras = input.camera.map(q) as [Rational, Rational];
  for (const vertex of referencedVertices(input.mesh)) {
    const terms = ([0, 1] as const).map((axis) =>
      axisTerms(input, lanes, vertex, axis, q(lanes.frame[axis]), cameras[axis]),
    );
    if (terms.some((term) => compare(term.a, A_MAX) > 0)) return rejected('lane-range', count);
    pack[vertex] = [terms[0]!.pack, terms[1]!.pack];
    const packX = overrides.packZero ? ZERO : terms[0]!.pack;
    const packY = overrides.packZero ? ZERO : terms[1]!.pack;
    ex[vertex] = add(add(packX, shader(gamma, terms[0]!.absSum, input.width)), PHI);
    ey[vertex] = add(add(packY, shader(gamma, terms[1]!.absSum, input.height)), PHI);
  }
  if (singular(input)) return rejected('singular', count);
  let delta2Max = ZERO;
  let worstVertex = -1;
  let firstFailure: number | null = null;
  for (const vertex of referencedVertices(input.mesh)) {
    const delta2 = add(mul(ex[vertex]!, ex[vertex]!), mul(ey[vertex]!, ey[vertex]!));
    if (worstVertex < 0 || compare(delta2, delta2Max) > 0) {
      delta2Max = delta2;
      worstVertex = vertex;
    }
    if (firstFailure === null && compare(delta2, LIMIT) > 0) firstFailure = vertex;
  }
  const clearance = clearanceTerm(input, clearanceSummary(input.mesh), delta2Max);
  const reason =
    firstFailure !== null
      ? `position:${firstFailure}`
      : clearance.term !== null
        ? `clearance:${clearance.term}`
        : null;
  return {
    status: reason === null ? 'ADMITTED' : 'NOT_ADMITTED',
    reason,
    ex,
    ey,
    delta2Max,
    worstVertex,
    clearance,
    pack,
  };
}

/** Window-uniform certificate over [O - D, O + D]^2 (M02, proof obligation P4). */
export function certifyWindow(
  input: ProjectionInput,
  origin: ProjectionPoint,
  halfWidth: number,
): WindowCertificate {
  const point = certifyPosition(input, origin);
  const count = input.mesh.vertices.length;
  const ewx: (Rational | null)[] = Array.from({ length: count }, () => null);
  const ewy: (Rational | null)[] = Array.from({ length: count }, () => null);
  if (point.reason === 'lane-range' || point.reason === 'singular')
    return { ...point, ewx, ewy, windowAdmitted: false };
  const lanes = packLanes(input, origin);
  const zq = mul(q(lanes.z), q(lanes.dpr));
  const d = q(halfWidth);
  const fmax = mul(d, add(ONE, pow2(-23)));
  if (compare(fmax, LANE_MAX) > 0) return { ...point, ewx, ewy, windowAdmitted: false };
  const laneRounding = mul(add(mul(F_LANE_REL, d), F_LANE_ABS), zq);
  const origins = origin.map(q) as [Rational, Rational];
  let admitted = true;
  for (const vertex of referencedVertices(input.mesh)) {
    const bounds = ([0, 1] as const).map((axis) => {
      const corners = [sub(origins[axis], d), add(origins[axis], d)].map(
        (camera) => axisTerms(input, lanes, vertex, axis, sub(origins[axis], camera), camera).pack,
      );
      const size = axis === 0 ? input.width : input.height;
      const withFmax = axisTerms(input, lanes, vertex, axis, ZERO, ZERO).absSum;
      const shaderTerm = shader(GAMMA8, add(withFmax, mul(fmax, zq)), size);
      return add(add(add(maxOf(corners), laneRounding), shaderTerm), PHI);
    });
    ewx[vertex] = bounds[0]!;
    ewy[vertex] = bounds[1]!;
    if (compare(add(mul(bounds[0]!, bounds[0]!), mul(bounds[1]!, bounds[1]!)), LIMIT) > 0)
      admitted = false;
  }
  return { ...point, ewx, ewy, windowAdmitted: admitted };
}

/** P1's origin rule with hysteresis 512 on both axes. */
export function originP1(camera: ProjectionPoint, previous?: ProjectionPoint): ProjectionPoint {
  if (
    previous !== undefined &&
    Math.abs(camera[0] - previous[0]) <= 512 &&
    Math.abs(camera[1] - previous[1]) <= 512
  )
    return previous;
  return [256 * Math.floor(camera[0] / 256), 256 * Math.floor(camera[1] / 256)];
}

/** Test-only physical-window origin, g = 2^floor(log2(1024 / (z * q))) document units. */
export function originPX(
  camera: ProjectionPoint,
  zoom: number,
  dpr: number,
  previous?: Readonly<{ origin: ProjectionPoint; g: number }>,
): { origin: ProjectionPoint; g: number } {
  const target = div(rational(1024n), mul(q(f(zoom)), q(f(dpr))));
  let exponent = 0;
  while (compare(pow2(exponent), target) > 0) exponent -= 1;
  while (compare(pow2(exponent + 1), target) <= 0) exponent += 1;
  const g = 2 ** exponent;
  if (
    previous !== undefined &&
    previous.g === g &&
    Math.abs(camera[0] - previous.origin[0]) <= 2 * g &&
    Math.abs(camera[1] - previous.origin[1]) <= 2 * g
  )
    return { origin: previous.origin, g };
  return { origin: [g * Math.floor(camera[0] / g), g * Math.floor(camera[1] / g)], g };
}

/** Runtime-feasible Pack upper bound (M01 Pack64), exact rational per referenced vertex. */
export function pack64(
  input: ProjectionInput,
  origin: ProjectionPoint,
): (readonly [Rational, Rational] | null)[] {
  const lanes = packLanes(input, origin);
  const [a, b, c, d] = lanes.linear;
  const [a0, b0, c0, d0, e0, f0] = input.affine;
  const result: ([Rational, Rational] | null)[] = input.mesh.vertices.map(() => null);
  const cameras = input.camera.map(q) as [Rational, Rational];
  for (const vertex of referencedVertices(input.mesh)) {
    const [ux, uy] = lanes.local[vertex]!;
    const [x, y] = input.mesh.vertices[vertex]!;
    const t1x = (a * ux + c * uy + lanes.anchor[0] + lanes.frame[0]) * lanes.z * lanes.dpr;
    const t2x = (a0 * x + c0 * y + e0 - input.camera[0]) * input.zoom * input.dpr;
    const t1y = (b * ux + d * uy + lanes.anchor[1] + lanes.frame[1]) * lanes.z * lanes.dpr;
    const t2y = (b0 * x + d0 * y + f0 - input.camera[1]) * input.zoom * input.dpr;
    result[vertex] = ([0, 1] as const).map((axis) => {
      const fl = axis === 0 ? t1x - t2x : t1y - t2y;
      const terms = axisTerms(input, lanes, vertex, axis, q(lanes.frame[axis]), cameras[axis]);
      return add(add(absolute(q(fl)), mul(pow2(-49), terms.a)), pow2(-1000));
    }) as [Rational, Rational];
  }
  return result;
}
