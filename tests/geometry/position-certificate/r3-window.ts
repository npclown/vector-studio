import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import {
  absolute,
  add,
  compare,
  div,
  mul,
  rational,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import { clearanceSummary, q, sqrtUp, type ClearanceTerm } from './certificate.js';

/**
 * P3.1m R3 (docs/plans/p3-r3-origin-window-contract.md): O-PX(T) origin family, M04 clearance
 * at a supplied δ² with exact slack, and the deterministic rebase-count trajectories.
 */

export const R3_TARGETS = [1024, 512, 256, 128, 64] as const;

const f = Math.fround;
const FOUR = rational(4n);
const TWO = rational(2n);
const pow2 = (exponent: number): Rational =>
  exponent >= 0 ? rational(1n << BigInt(exponent)) : rational(1n, 1n << BigInt(-exponent));

/** O-PX with the 1024-pixel target replaced by `target`; g computed exactly from the lanes. */
export function originPXTarget(
  camera: ProjectionPoint,
  zoom: number,
  dpr: number,
  target: number,
  previous?: Readonly<{ origin: ProjectionPoint; g: number }>,
): { origin: ProjectionPoint; g: number } {
  const ratio = div(rational(BigInt(target)), mul(q(f(zoom)), q(f(dpr))));
  let exponent = 0;
  while (compare(pow2(exponent), ratio) > 0) exponent -= 1;
  while (compare(pow2(exponent + 1), ratio) <= 0) exponent += 1;
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

export type ClearanceAtDelta = Readonly<{
  term: ClearanceTerm | null;
  /** Smallest LHS - RHS over the evaluated M04 terms (null when no term applies). */
  slack: Rational | null;
  slackTerm: ClearanceTerm | null;
}>;

/** M04 clearance with an explicit δ² (pointwise or window), terms in check order. */
export function clearanceAtDelta(input: ProjectionInput, delta2: Rational): ClearanceAtDelta {
  const summary = clearanceSummary(input.mesh);
  const [a, b, c, d] = input.affine.map(q) as [Rational, Rational, Rational, Rational];
  const scale = mul(q(input.zoom), q(input.dpr));
  const s2 = mul(scale, scale);
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
  const checks: [ClearanceTerm, Rational | null][] = [];
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
  let term: ClearanceTerm | null = null;
  let slack: Rational | null = null;
  let slackTerm: ClearanceTerm | null = null;
  for (const [name, value] of checks) {
    if (term === null && (value === null || value.n <= 0n)) term = name;
    if (value !== null && (slack === null || compare(value, slack) < 0)) {
      slack = value;
      slackTerm = name;
    }
  }
  return { term, slack, slackTerm };
}

export type Trajectory = Readonly<{
  id: string;
  frames: readonly Readonly<{ camera: ProjectionPoint; zoom: number; dpr: number }>[];
}>;

/** TR-PAN, TR-ZOOM and TR-N03 (N03 camera x sequences, y = 0, zoom 1, DPR 1). */
export function trajectories(
  n03: readonly Readonly<{ id: string; cameras: readonly number[] }>[],
): Trajectory[] {
  const pans = (
    [
      [0.01, 1],
      [1, 1],
      [1, 2],
      [64, 2],
    ] as const
  ).map(([zoom, dpr]) => ({
    id: `TR-PAN/${zoom}x${dpr}`,
    frames: Array.from({ length: 1024 }, (_, k) => ({
      camera: [(k * 4) / (zoom * dpr), 0] as const,
      zoom,
      dpr,
    })),
  }));
  const zoomRamp = {
    id: 'TR-ZOOM',
    frames: Array.from({ length: 512 }, (_, k) => ({
      camera: [1000.5, -300.25] as const,
      zoom: f(2 ** (-7 + (13 * k) / 511)),
      dpr: 1,
    })),
  };
  const sequences = n03.map((sequence) => ({
    id: `TR-N03/${sequence.id}`,
    frames: sequence.cameras.map((x) => ({ camera: [x, 0] as const, zoom: 1, dpr: 1 })),
  }));
  return [...pans, zoomRamp, ...sequences];
}

/** Origin and g changes after frame 0 (frame 0 derives with no previous state and is not counted). */
export function rebaseCounts(
  trajectory: Trajectory,
  policy: (
    camera: ProjectionPoint,
    zoom: number,
    dpr: number,
    previous?: { origin: ProjectionPoint; g: number },
  ) => {
    origin: ProjectionPoint;
    g: number;
  },
): { originChanges: number; gChanges: number } {
  let previous: { origin: ProjectionPoint; g: number } | undefined;
  let originChanges = 0;
  let gChanges = 0;
  for (const frame of trajectory.frames) {
    const next = policy(frame.camera, frame.zoom, frame.dpr, previous);
    if (previous !== undefined) {
      if (next.origin[0] !== previous.origin[0] || next.origin[1] !== previous.origin[1])
        originChanges += 1;
      if (next.g !== previous.g) gChanges += 1;
    }
    previous = next;
  }
  return { originChanges, gChanges };
}
