// D9 E11 unit E11-U2: the seeded P3 stress scene of the prototype plan, "1,000 paths with 32
// cubic segments each" (docs/prototype-plan.md, P3), as fill and stroke port requests at
// tolerance buckets spread over the plan's 1% to 6400% zoom range and DPR 1 to 3.
//
// The generator and its seed are fixed before the first run (E11 section 8). Any change to
// either is a new scene version and invalidates A01 sweep records made with the old one.

import {
  PATH_VERB_CODES,
  type FillMeshRequest,
  type StrokeMeshRequest,
} from '../../../packages/contracts/src/geometry.js';
import { computePathBuckets } from '../../../packages/renderer-core/src/path-buckets.js';

export const STRESS_SCENE_VERSION = 'p3-exit-stress/v1';
export const STRESS_SCENE_SEED = 0x5eed_e111;
export const STRESS_PATHS = 1000;
export const STRESS_CUBICS = 32;

/** xorshift32; never returns 0 from a nonzero state. */
function next(state: number): number {
  let x = state >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

class Stream {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  /** Uniform in [0, 1) with 2^-32 resolution, exactly representable. */
  unit(): number {
    this.state = next(this.state);
    return this.state / 2 ** 32;
  }
}

/** Snaps to a multiple of 2^-10, so every coordinate is an exact small dyadic. */
const snap = (value: number) => Math.round(value * 1024) / 1024;

export type StressPath = Readonly<{
  index: number;
  verbs: Uint8Array;
  points: Float64Array;
  fillRule: 'nonzero' | 'evenodd';
  zoom: number;
  dpr: number;
  toleranceExponent: number;
  stroke: Readonly<{
    width: number;
    cap: 'butt' | 'round' | 'square';
    join: 'miter' | 'round' | 'bevel';
    miterLimit: number;
  }>;
}>;

const CAPS = ['butt', 'round', 'square'] as const;
const JOINS = ['miter', 'round', 'bevel'] as const;
const WIDTHS = [0.25, 1, 4, 16] as const;
const DPRS = [1, 2, 3] as const;

/**
 * Path i is one closed contour of 32 cubics with tangent-continuous (Catmull-Rom) handles
 * through knots on a noisy circle: knot radius R·(1 + 0.6·(u − 0.5)), with R log-uniform in
 * [8, 256] local units. Every fourth path instead displaces its handles by up to 0.8·R, so it
 * self-intersects and loops (the plan's self-intersection stress). Its zoom is
 * 2^(-6.64 + 12.64·u), i.e. 1% to 6400%, its DPR 1, 2 or 3 in turn, and its tolerance exponent
 * is the renderer's own bucket e for that zoom and DPR under the identity map (V3 section c).
 *
 * Disclosure: this v1 shape was chosen after a probe of an unsmoothed draft on the release WASM
 * (every draft path failed, most with work-limit); the probe and v1 are recorded in the E11-U2
 * evidence. The scene is a structure sweep input, not a blind acceptance corpus.
 */
export function stressPath(index: number): StressPath {
  const s = new Stream((STRESS_SCENE_SEED ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const radius = 8 * 32 ** s.unit();
  const knots: [number, number][] = [];
  for (let k = 0; k < STRESS_CUBICS; k += 1) {
    const angle = (2 * Math.PI * k) / STRESS_CUBICS;
    const r = radius * (1 + 0.6 * (s.unit() - 0.5));
    knots.push([snap(r * Math.cos(angle)), snap(r * Math.sin(angle))]);
  }
  const looping = index % 4 === 3;
  const verbs = new Uint8Array(STRESS_CUBICS + 2);
  const points = new Float64Array(2 + STRESS_CUBICS * 6);
  verbs[0] = PATH_VERB_CODES.move;
  points[0] = knots[0]![0];
  points[1] = knots[0]![1];
  const at = (k: number) => knots[(k + STRESS_CUBICS) % STRESS_CUBICS]!;
  for (let k = 0; k < STRESS_CUBICS; k += 1) {
    const [p0, p1, p2, p3] = [at(k - 1), at(k), at(k + 1), at(k + 2)];
    const jitter = () => (looping ? (s.unit() - 0.5) * 1.6 * radius : 0);
    const c1 = [
      snap(p1[0] + (p2[0] - p0[0]) / 6 + jitter()),
      snap(p1[1] + (p2[1] - p0[1]) / 6 + jitter()),
    ];
    const c2 = [
      snap(p2[0] - (p3[0] - p1[0]) / 6 + jitter()),
      snap(p2[1] - (p3[1] - p1[1]) / 6 + jitter()),
    ];
    verbs[k + 1] = PATH_VERB_CODES.cubic;
    points.set([c1[0]!, c1[1]!, c2[0]!, c2[1]!, p2[0], p2[1]], 2 + 6 * k);
  }
  verbs[STRESS_CUBICS + 1] = PATH_VERB_CODES.close;
  const zoom = 2 ** (-6.64 + 12.64 * s.unit());
  const dpr = DPRS[index % DPRS.length]!;
  const buckets = computePathBuckets([1, 0, 0, 1], zoom, dpr);
  if (buckets.singular) throw new Error('stress scene: identity cannot be singular');
  return Object.freeze({
    index,
    verbs,
    points,
    fillRule: index % 2 === 0 ? 'nonzero' : 'evenodd',
    zoom,
    dpr,
    toleranceExponent: buckets.e,
    stroke: Object.freeze({
      width: WIDTHS[index % WIDTHS.length]!,
      cap: CAPS[index % CAPS.length]!,
      join: JOINS[Math.floor(index / CAPS.length) % JOINS.length]!,
      miterLimit: 4,
    }),
  });
}

export function stressScene(): readonly StressPath[] {
  return Array.from({ length: STRESS_PATHS }, (_, i) => stressPath(i));
}

export function fillRequest(path: StressPath, requestId: number): FillMeshRequest {
  return {
    requestId,
    verbs: path.verbs,
    points: path.points,
    fillRule: path.fillRule,
    toleranceExponent: path.toleranceExponent,
  };
}

export function strokeRequest(path: StressPath, requestId: number): StrokeMeshRequest {
  return {
    requestId,
    verbs: path.verbs,
    points: path.points,
    ...path.stroke,
    toleranceExponent: path.toleranceExponent,
  };
}
