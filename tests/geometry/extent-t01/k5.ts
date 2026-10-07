import type { ProjectionPoint } from '../mesh-projection/model.js';
import { q } from '../position-certificate/certificate.js';
import { absolute, add, mul, rational, sub, type Rational } from '../rounded-fill/exact.js';
import { A_MAX, PHI, type CoreInput } from './core.js';

/**
 * P3.1p T01 K5-ASSUMED (docs/plans/p3-t01-extent-experiment-contract.md, "K5-ASSUMED"): a
 * hypothetical f32-pair transform model. It is never a certificate.
 */

const f = Math.fround;
const ONE = rational(1n);
const pow2 = (exponent: number): Rational =>
  exponent >= 0 ? rational(1n << BigInt(exponent)) : rational(1n, 1n << BigInt(-exponent));

/** Γ_p = (1 + 2^-44)^9 − 1. */
export const GAMMA_PAIR = (() => {
  let product = ONE;
  for (let index = 0; index < 9; index += 1) product = mul(product, add(ONE, pow2(-44)));
  return sub(product, ONE);
})();

export type PairLanes = Readonly<{
  midpoint: ProjectionPoint;
  local: readonly ProjectionPoint[];
  linear: readonly [number, number, number, number];
  /** Exact hi + lo of the binary64 anchor and frame values. */
  anchor: readonly [Rational, Rational];
  frame: readonly [Rational, Rational];
  z: number;
  dpr: number;
}>;

function pair(value: number): Rational {
  const hi = f(value);
  const lo = f(value - hi);
  return add(q(hi), q(lo));
}

/** K's graph with B and F carried as f32 pairs (hi = RN32(x), lo = RN32(x − hi)). */
export function packPairLanes(
  vertices: readonly ProjectionPoint[],
  affine: CoreInput['affine'],
  camera: ProjectionPoint,
  zoom: number,
  dpr: number,
  midpoint: ProjectionPoint,
  origin: ProjectionPoint,
): PairLanes {
  const [mx, my] = midpoint;
  const [a, b, c, d, e, g] = affine;
  return {
    midpoint,
    local: vertices.map(([x, y]) => [f(x - mx), f(y - my)] as const),
    linear: [f(a), f(b), f(c), f(d)],
    anchor: [pair(a * mx + c * my + e - origin[0]), pair(b * mx + d * my + g - origin[1])],
    frame: [pair(origin[0] - camera[0]), pair(origin[1] - camera[1])],
    z: f(zoom),
    dpr: f(dpr),
  };
}

export type K5Error = Readonly<{
  ex: Rational;
  ey: Rational;
  /** Pack5 per axis, and the part of it due to the f32 local offset u alone. */
  pack: readonly [Rational, Rational];
  uTerm: readonly [Rational, Rational];
}>;

/**
 * E5 per axis: Pack5 + Γ_p·(absSum + size/2) + ndcUnit·(|P* − size/2| + Pack5 + Γ_p·(absSum +
 * size/2)) + Phi, with ndcUnit = 2^-23 (faithful) or 2^-24 (the RN sensitivity case).
 */
export function k5Errors(
  input: CoreInput,
  lanes: PairLanes,
  vertices: readonly number[],
  rn = false,
): Map<number, K5Error> | 'lane-range' {
  const ndcUnit = pow2(rn ? -24 : -23);
  const [la, lb, lc, ld] = lanes.linear.map(q) as [Rational, Rational, Rational, Rational];
  const zq = mul(q(lanes.z), q(lanes.dpr));
  const affine = input.affine.map(q);
  const s0 = mul(q(input.zoom), q(input.dpr));
  const cameras = input.camera.map(q) as [Rational, Rational];
  const [mx, my] = lanes.midpoint.map(q) as [Rational, Rational];
  const result = new Map<number, K5Error>();
  for (const vertex of vertices) {
    const [ux, uy] = lanes.local[vertex]!.map(q) as [Rational, Rational];
    const [x0, y0] = input.points[vertex]!;
    const errors = ([0, 1] as const).map((axis) => {
      const [p, r] = axis === 0 ? [la, lc] : [lb, ld];
      const [p0, r0, t0] =
        axis === 0 ? [affine[0]!, affine[2]!, affine[4]!] : [affine[1]!, affine[3]!, affine[5]!];
      const size = axis === 0 ? input.width : input.height;
      const half = rational(BigInt(size), 2n);
      const anchor = lanes.anchor[axis];
      const frame = lanes.frame[axis];
      const carrier = mul(add(add(add(mul(p, ux), mul(r, uy)), anchor), frame), zq);
      const reference = mul(sub(add(add(mul(p0, x0), mul(r0, y0)), t0), cameras[axis]), s0);
      const pack = absolute(sub(carrier, reference));
      const exactU = [sub(x0, mx), sub(y0, my)] as const;
      const uTerm = absolute(mul(add(mul(p, sub(ux, exactU[0])), mul(r, sub(uy, exactU[1]))), zq));
      const absSum = mul(
        add(
          add(add(absolute(mul(p, ux)), absolute(mul(r, uy))), absolute(anchor)),
          absolute(frame),
        ),
        zq,
      );
      const shader = mul(GAMMA_PAIR, add(absSum, half));
      const ndc = mul(ndcUnit, add(add(absolute(sub(reference, half)), pack), shader));
      return { e: add(add(add(pack, shader), ndc), PHI), pack, uTerm, a: absSum };
    });
    if (errors.some((error) => error.a.n * A_MAX.d > A_MAX.n * error.a.d)) return 'lane-range';
    result.set(vertex, {
      ex: errors[0]!.e,
      ey: errors[1]!.e,
      pack: [errors[0]!.pack, errors[1]!.pack],
      uTerm: [errors[0]!.uTerm, errors[1]!.uTerm],
    });
  }
  return result;
}
