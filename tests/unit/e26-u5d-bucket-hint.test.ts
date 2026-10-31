import { describe, expect, it } from 'vitest';
import {
  bucketHint,
  bucketsHoldAt,
  computePathBuckets,
  type PathBuckets,
  type PathLinearMap,
} from '../../packages/renderer-core/src/path-buckets.js';
import { disablePathReuseForTesting } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { createCountingPort, createPathHarness, pathNode } from '../support/v3a-path-harness.js';

// E26 contract, U5d-3: the bucket hint. Over seeded lanes (rotations, skews, anisotropic and
// isotropic scales, near-singular maps, huge and tiny scales) and zooms that wander, jump, and land
// on bucket boundaries to within a few ulp, `bucketsHoldAt` says yes only where the hint's buckets
// are the exact buckets at that zoom and DPR.

/** mulberry32. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lanes(rng: () => number): PathLinearMap {
  const pick = rng();
  const angle = rng() * 2 * Math.PI;
  const sx = 10 ** (rng() * 12 - 6);
  const sy =
    pick < 0.2
      ? sx
      : pick < 0.3
        ? sx * (1 + 1e-12)
        : pick < 0.4
          ? sx * 1e-9
          : 10 ** (rng() * 6 - 3);
  const skew = rng() < 0.3 ? (rng() - 0.5) * 3 : 0;
  return [
    sx * Math.cos(angle),
    sx * Math.sin(angle),
    sy * (skew - Math.sin(angle)),
    sy * Math.cos(angle),
  ];
}

/** The start estimate can give f = -0 where the hint holds +0, and the reverse. */
function signless(buckets: PathBuckets): PathBuckets {
  return buckets.singular ? buckets : { ...buckets, e: buckets.e + 0, f: buckets.f + 0 };
}

/** sigmaMax and sigmaMin of L in Float64, close enough to aim zooms at bucket boundaries. */
function singular(linear: PathLinearMap): [number, number] {
  const [a, b, c, d] = linear;
  const f = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  const max = Math.sqrt((f + Math.sqrt(Math.max(0, f * f - 4 * det * det))) / 2);
  return [max, Math.abs(det) / max];
}

describe('E26-U5d-3 bucket hint', () => {
  it('says yes only where the hint has the exact buckets', () => {
    const rng = random(0xe26d3);
    let held = 0;
    let checked = 0;
    let boundary = 0;
    for (let path = 0; path < 400; path += 1) {
      const linear = lanes(rng);
      const [max, min] = singular(linear);
      let zoom = 2 ** (rng() * 16 - 8);
      let hint = bucketHint(linear, computePathBuckets(linear, zoom, 1));
      for (let frame = 0; frame < 100; frame += 1) {
        const dpr = [1, 1.5, 2, 3][Math.floor(rng() * 4)]!;
        const step = rng();
        if (step < 0.6) zoom *= 1 + (rng() - 0.5) * 0.1;
        else if (step < 0.7) zoom = 2 ** (rng() * 16 - 8);
        else {
          // A zoom within a few ulp of an e or f boundary: s sigma = 2^k exactly in reals.
          const sigma = step < 0.85 ? max : min;
          const k = Math.round(Math.log2(zoom * dpr * sigma));
          zoom = (2 ** k / (dpr * sigma)) * (1 + (Math.floor(rng() * 9) - 4) * 2 ** -52);
          boundary += 1;
        }
        if (!(zoom > 0 && Number.isFinite(zoom))) continue;
        const exact = computePathBuckets(linear, zoom, dpr);
        checked += 1;
        if (hint !== null && bucketsHoldAt(hint, zoom, dpr)) {
          expect(signless(hint.buckets), JSON.stringify({ linear, zoom, dpr })).toEqual(
            signless(exact),
          );
          held += 1;
        } else {
          hint = bucketHint(linear, exact);
        }
      }
    }
    expect(boundary).toBeGreaterThan(5_000);
    // Half the frames aim at a boundary or jump, and the DPR changes every frame; the rest hold.
    expect(held).toBeGreaterThan(checked / 6);
  });

  it('declines where an intermediate would be subnormal (U5d-3 review B1)', () => {
    // s^2 underflows to the smallest subnormal at both zooms, while the buckets differ.
    const large: PathLinearMap = [
      8.219686415014789e37, 1.8866159004572928e38, -1.8866159004572928e38, 8.219686415014789e37,
    ];
    const hint = bucketHint(large, computePathBuckets(large, 2.389026041289583e-162, 1));
    expect(hint).not.toBeNull();
    expect(bucketsHoldAt(hint!, 1.8377123394535251e-162, 1)).toBe(false);
    // A near-singular map whose s^2 D^2 is subnormal.
    const thin: PathLinearMap = [
      1.565205638536304e-52, 3.130411277072608e-52, 4.709551588012324e-52, 9.391233831217824e-52,
    ];
    const thinHint = bucketHint(thin, computePathBuckets(thin, 9.728252864619843e-56, 1.25));
    expect(thinHint).not.toBeNull();
    expect(bucketsHoldAt(thinHint!, 1.0809169849577602e-55, 1.25)).toBe(false);
  });

  it('declines for singular maps and at boundaries', () => {
    expect(bucketHint([1, 2, 2, 4], computePathBuckets([1, 2, 2, 4], 1, 1))).toBeNull();
    const identity: PathLinearMap = [1, 0, 0, 1];
    const hint = bucketHint(identity, computePathBuckets(identity, 0.75, 1))!;
    expect(bucketsHoldAt(hint, 0.75, 1)).toBe(true);
    expect(bucketsHoldAt(hint, 0.9, 1)).toBe(true);
    // sigma = 1: e changes at s = 1 (2^-3 * 8 ... s sigma = 2^0) and f at s = 0.5 and 1.
    expect(bucketsHoldAt(hint, 1, 1)).toBe(false);
    expect(bucketsHoldAt(hint, 0.5, 1)).toBe(false);
    expect(bucketsHoldAt(hint, 0.375, 2)).toBe(true);
  });

  it('lets the pipeline skip the computation on small zoom steps, and not the twin', () => {
    const computations = (reuse: boolean) => {
      const harness = createPathHarness({ port: createCountingPort(), nodes: [pathNode('a', 0)] });
      if (!reuse) disablePathReuseForTesting(harness.pipeline);
      // Zooms 1.10 to 1.29: s sigma stays inside one e and one f interval (sigma = 1, DPR 1).
      for (let step = 0; step < 20; step += 1) {
        harness.setZoom(1.1 + step * 0.01);
        harness.drawnIds();
      }
      return harness.statistics().bucketComputations;
    };
    expect(computations(true)).toBe(1);
    expect(computations(false)).toBe(20);
  });
});
