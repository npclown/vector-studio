import type {
  FillMesh,
  FillMeshPort,
  FillMeshRequest,
  StrokeMeshPort,
} from '@vector-studio/contracts';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { encodeRleBase64 } from '../geometry/coverage-oracle/rle.js';
import { hex } from '../geometry/e3-a04/corpus.js';
import { dNum, drawCase } from '../geometry/e3-a04/harness.js';
import { ScriptedFillMeshPort } from '../support/v3a-path-harness.js';
import {
  expectedEntry,
  recordingPorts,
  VIZ_V4_VARIANTS,
  variantQuery,
  type VizV4Variant,
} from '../visual/viz-v4/cases.js';
import {
  buildReference,
  evaluateCapture,
  pixelClassForTesting,
  SIGMA,
  ruleRenderingForTesting,
  type Capture,
  type Reference,
} from '../visual/viz-v4/metrics.js';
import {
  canonicalJson,
  decideVerdict,
  evaluateRun,
  groupPath,
  replayRecord,
  runMetrics,
  type ExpectedFile,
  type LoadedRun,
  type Observation,
  type RunGroup,
  type VerdictEntry,
} from '../visual/viz-v4/runner.js';
import { summarizeA08Subset, type A08Case } from '../visual/viz-v4/subset.js';

// V-4 unit VZ4-U2 (docs/plans/viz-v4-a08-corpus-contract.md, sections 5 and 6): the VZ4-A8
// controls on synthetic captures and records, the β_c margins, the crack exclusion, the section
// 5.3 verdict and the VZ4-A9 replay. No kernel runs on corpus cases (E3 section 5.5): every port
// is a ScriptedFillMeshPort and every case is a synthetic case in the A04 canonical form, with the
// identity transform, camera at the origin, zoom 1 and DPR 1, so p* is the port position.

// ---------------------------------------------------------------------------------------------
// Synthetic cases and ports

function synthCase(id: string, first: number): A08Case {
  const kase = {
    id,
    stratum: 'C1',
    row: id,
    transform: 'T0',
    placement: 'center',
    servedOffset: 0,
    path: { verbs: 'MLLLZ', points: [first, 10, 50, 10, 50, 30, first, 30].map(hex) },
    world: { l: [1, 0, 0, 1].map(hex), t: [0, 0].map(hex) },
    camera: { c: [0, 0].map(hex), dpr: hex(1), zoom: hex(1) },
    paint: { kind: 'fill', rule: 'nonzero' },
  };
  return { key: `${id}@dpr1`, a04Id: id, part: 'C1-named-fill-lines', gated: true, dpr: 1, kase };
}

/** A rectangle [10.5, 50] × [10, 30] px in two triangles. */
const RECT: FillMesh = {
  positions: Float64Array.from([10.5, 10, 50, 10, 50, 30, 10.5, 30]),
  indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  boundaryEdges: Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 0]),
  bounds: { minX: 10.5, minY: 10, maxX: 50, maxY: 30 },
};

/**
 * [100, 140] × [10, 30] px with a T-junction: the left half is two triangles over the edge
 * (120.5, 10)-(120.5, 30), the right half three triangles fanned at (120.5, 20) on that edge.
 */
const TJUNCTION: FillMesh = {
  positions: Float64Array.from([
    100, 10, 120.5, 10, 140, 10, 140, 30, 120.5, 30, 100, 30, 120.5, 20,
  ]),
  indices: Uint32Array.from([0, 1, 4, 0, 4, 5, 1, 2, 6, 2, 3, 6, 3, 4, 6]),
  boundaryEdges: Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 0]),
  bounds: { minX: 100, minY: 10, maxX: 140, maxY: 30 },
};

const RECT_CASE = synthCase('TEST/rect/T0/z1-d1', 10);
const TJ_CASE = synthCase('TEST/tjunction/T0/z1-d1', 100);
const SUBSET: readonly A08Case[] = [RECT_CASE, TJ_CASE];

type Ports = Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>;

function ports(
  meshFor: (tag: number) => FillMesh = (tag) => (tag === 10 ? RECT : TJUNCTION),
): Ports {
  return {
    fill: new ScriptedFillMeshPort({
      request: (request: FillMeshRequest, tag: number) => ({
        requestId: request.requestId,
        toleranceExponent: request.toleranceExponent,
        status: 'ok',
        mesh: meshFor(tag),
      }),
    }),
    stroke: {
      portVersion: 0,
      operationId: 'test/viz-v4-stroke',
      buildStrokeMeshes: () => ({ status: 'batch-failed', code: 'internal-error' }),
    },
  };
}

const PORTS = ports();

function reference(c: A08Case, variant: VizV4Variant, p: Ports = PORTS): Reference {
  const outcome = drawCase(c.kase, p, { fringe: variantQuery(variant).fringe });
  if (outcome.kind !== 'drawn') throw new Error(`not drawn: ${outcome.kind}`);
  return buildReference(outcome.draw, outcome.frame);
}

const samplesOf = (variant: VizV4Variant) => variantQuery(variant).samples;

function good(c: A08Case, variant: VizV4Variant): Capture {
  return ruleRenderingForTesting(reference(c, variant), samplesOf(variant));
}

function edit(capture: Capture, change: (red: Uint8Array, counts: Uint16Array) => void): Capture {
  const red = Uint8Array.from(capture.red);
  const counts = Uint16Array.from(capture.counts);
  change(red, counts);
  return { ...capture, red, counts };
}

function judge(c: A08Case, variant: VizV4Variant, capture: Capture) {
  return evaluateCapture(reference(c, variant), capture, samplesOf(variant)).metrics;
}

const W = 640;
const at = (i: number, j: number) => j * W + i;

// ---------------------------------------------------------------------------------------------

describe('reference (section 5.1)', () => {
  it('maps the port mesh by E3’s model: exact p*, β_c and T-junction edges', () => {
    const ref = reference(RECT_CASE, 'fringe-4x');
    expect(ref.width).toBe(640);
    expect(ref.height).toBe(360);
    const scale = Number(ref.scale);
    expect(ref.points.map(([x, y]) => [Number(x) / scale, Number(y) / scale])).toEqual([
      [10.5, 10],
      [50, 10],
      [50, 30],
      [10.5, 30],
    ]);
    // β_c is E3's bound (below 1e-3 px here) plus σ = √2·2^-5 (contract section 17).
    expect(ref.betaSnap).toBe(SIGMA);
    expect(SIGMA).toBeGreaterThanOrEqual(Math.SQRT2 * 2 ** -5);
    expect(ref.betaC).toBeGreaterThan(SIGMA);
    expect(ref.betaC).toBeLessThan(SIGMA + 1e-3);
    expect(ref.betaC).toBeGreaterThanOrEqual(ref.betaVertex + SIGMA);
    expect(ref.noFlip.failed).toBe(0);
    expect(ref.sectors.status).toBe('OK');
    expect(ref.tJunctionEdges).toEqual([]);
    // The product fringe builder refuses this mesh (partition `edge-use:1:4`), so its reference
    // is taken from the fringe-off draw; the reference is the mapped port mesh either way.
    expect(reference(TJ_CASE, 'msaa-4x').tJunctionEdges).toEqual([[1, 4]]);
  });

  it('decides inside at p* by the exact winding of the mapped boundary', () => {
    const ref = reference(RECT_CASE, 'fringe-1x');
    expect(pixelClassForTesting(ref, 10, 20, 0).inside).toBe(true); // centre 10.5, on the edge
    expect(pixelClassForTesting(ref, 9, 20, 0).inside).toBe(false);
    expect(pixelClassForTesting(ref, 49, 29, 0).inside).toBe(true);
    expect(pixelClassForTesting(ref, 50, 20, 0).inside).toBe(false);
    expect(pixelClassForTesting(ref, 12, 20, 2).within).toBe(true); // d = 2 exactly
    expect(pixelClassForTesting(ref, 13, 20, 2).within).toBe(false);
  });

  it('keeps the region on the left of the boundary under a negative determinant', () => {
    // x' = −x: the rectangle maps to [50, 89.5] × [10, 30] px with the camera at (−100, 0).
    const c = synthCase('TEST/rect-mirror/T5/z1-d1', 10);
    const kase = {
      ...c.kase,
      world: { l: [-1, 0, 0, 1].map(hex), t: [0, 0].map(hex) },
      camera: { c: [-100, 0].map(hex), dpr: hex(1), zoom: hex(1) },
    };
    const outcome = drawCase(kase, PORTS, { fringe: 'off' });
    if (outcome.kind !== 'drawn') throw new Error('not drawn');
    const ref = buildReference(outcome.draw, outcome.frame);
    expect(ref.orientation).toBe(-1);
    expect(ref.sectors.status).toBe('OK');
    const capture = ruleRenderingForTesting(ref, 4);
    expect([capture.red[at(49, 20)], capture.red[at(50, 20)], capture.red[at(89, 20)]]).toEqual([
      0, 255, 128,
    ]);
    expect(evaluateCapture(ref, capture, 4).metrics.judgment).toBe('PASS');
  });

  it('agrees with mapPoint on a translated camera', () => {
    const c = synthCase('TEST/rect-camera/T0/z1-d1', 10);
    const kase = { ...c.kase, camera: { c: [-3, -2].map(hex), dpr: hex(1), zoom: hex(1) } };
    const outcome = drawCase(kase, PORTS, {});
    if (outcome.kind !== 'drawn') throw new Error('not drawn');
    const ref = buildReference(outcome.draw, outcome.frame);
    expect(Number(ref.points[0]![0]) / Number(ref.scale)).toBe(13.5);
    expect(dNum({ n: ref.points[0]![1], e: -ref.shift })).toBe(12);
  });
});

describe('VZ4-A8 controls on synthetic captures', () => {
  for (const variant of ['fringe-1x', 'fringe-4x'] as const) {
    it(`${variant}: a known-good rendering of the rule PASSES`, () => {
      const m = judge(RECT_CASE, variant, good(RECT_CASE, variant));
      expect(m.judgment).toBe('PASS');
      expect(m.reasons).toEqual([]);
      expect(m.g1.decided).toBeGreaterThan(200_000);
      expect(m.g3.fullPixels).toBeGreaterThan(700);
    });

    it(`${variant}: a 2/255 interior deviation PASSES, 3/255 FAILS G1`, () => {
      const base = good(RECT_CASE, variant);
      expect(
        judge(
          RECT_CASE,
          variant,
          edit(base, (r) => (r[at(30, 20)] = 253)),
        ).judgment,
      ).toBe('PASS');
      const off = judge(
        RECT_CASE,
        variant,
        edit(base, (r) => (r[at(30, 20)] = 252)),
      );
      expect(off.judgment).toBe('FAIL');
      expect(off.reasons).toEqual(['G1']);
      expect(off.g1.fail).toBe(1);
      expect(off.pixels[0]).toEqual({ gate: 'G1', i: 30, j: 20, obs: 252 });
    });

    it(`${variant}: a readback from a cleared texture FAILS G1`, () => {
      const cleared = edit(good(RECT_CASE, variant), (r, k) => {
        r.fill(0);
        k.fill(0);
      });
      const m = judge(RECT_CASE, variant, cleared);
      expect(m.judgment).toBe('FAIL');
      expect(m.reasons).toContain('G1');
      expect(m.g1.maxInsideError).toBe(255);
    });

    it(`${variant}: a 2 px boundary shift FAILS G2`, () => {
      const base = good(RECT_CASE, variant);
      const s = samplesOf(variant);
      const shifted = edit(base, (r, k) => {
        r.fill(0);
        k.fill(0);
        for (let j = 0; j < 360; j += 1)
          for (let i = 2; i < W; i += 1) {
            r[at(i, j)] = base.red[at(i - 2, j)]!;
            for (let q = 0; q < s; q += 1) k[at(i, j) * s + q] = base.counts[at(i - 2, j) * s + q]!;
          }
      });
      const m = judge(RECT_CASE, variant, shifted);
      expect(m.judgment).toBe('FAIL');
      expect(m.reasons).toContain('G2');
      expect(m.g2.fail).toBeGreaterThan(0);
    });

    it(`${variant}: a doubled exterior draw FAILS G3 (count 2)`, () => {
      const ref = reference(RECT_CASE, variant);
      const s = samplesOf(variant);
      const doubled = edit(good(RECT_CASE, variant), (_r, k) => {
        for (let j = 0; j < 360; j += 1)
          for (let i = 0; i < W; i += 1) {
            // Outside, within 1 px but beyond G3's 0.708 px "equal to 1" class.
            const c = pixelClassForTesting(ref, i, j, 1);
            const close = pixelClassForTesting(ref, i, j, 0.75).within;
            if (!c.inside && c.within && !close) k.fill(2, at(i, j) * s, (at(i, j) + 1) * s);
          }
      });
      const m = judge(RECT_CASE, variant, doubled);
      expect(m.judgment).toBe('FAIL');
      expect(m.reasons).toEqual(['G3-at-most']);
      expect(m.g3.maxCount).toBe(2);
    });

    it(`${variant}: a dropped region triangle FAILS G3 (count 0, no T-junction)`, () => {
      const s = samplesOf(variant);
      const dropped = edit(good(RECT_CASE, variant), (_r, k) => {
        // Pixels of the lower-left triangle (10.5, 10), (50, 30), (10.5, 30), clear of its edges.
        for (let j = 25; j <= 28; j += 1)
          for (let i = 15; i <= 20; i += 1) k.fill(0, at(i, j) * s, (at(i, j) + 1) * s);
      });
      const m = judge(RECT_CASE, variant, dropped);
      expect(m.tJunctionEdges).toBe(0);
      expect(m.judgment).toBe('FAIL');
      expect(m.reasons).toEqual(['G3-equal']);
      expect(m.g3.fullFail).toBe(24);
    });

    it(`${variant}: a G1 violation inside the β_c band is UNDECIDED, not FAIL`, () => {
      // Pixel (12, 20): centre 12.5, exactly 2 px from the edge x = 10.5, so d − β_c < 2 ≤ d + β_c.
      const m = judge(
        RECT_CASE,
        variant,
        edit(good(RECT_CASE, variant), (r) => (r[at(12, 20)] = 250)),
      );
      expect(m.judgment).toBe('UNDECIDED');
      expect(m.g1.fail).toBe(0);
      expect(m.g1.undecided).toBe(1);
      expect(m.reasons).toEqual(['G1-undecided']);
    });
  }

  // The product fringe builder refuses the T-junction mesh (partition `edge-use:1:4`), so these
  // judge captures against the reference of its fringe-off draw, at the fringe sample counts.
  const tjReference = () => reference(TJ_CASE, 'msaa-4x');
  const tjJudge = (capture: Capture, samples: 1 | 4) =>
    evaluateCapture(tjReference(), capture, samples).metrics;

  it('excludes a crack at a T-junction edge from "equal to 1" but not from "at most 1"', () => {
    const base = ruleRenderingForTesting(tjReference(), 4);
    expect(tjJudge(base, 4).judgment).toBe('PASS');
    // Pixel (120, 20): centre (120.5, 20.5), on the mapped T-junction edge x = 120.5.
    const cracked = edit(base, (r, k) => {
      r[at(120, 20)] = 190;
      k[at(120, 20) * 4 + 1] = 0;
    });
    const m = tjJudge(cracked, 4);
    expect(m.tJunctionEdges).toBe(1);
    expect(m.crack.pixels).toBe(1);
    expect(m.crack.zoneWidth).toBeGreaterThan(0.3953);
    expect(m.crack.zonePixels).toBe(20);
    expect(m.judgment).toBe('PASS');
    // The same deficit away from the T-junction edge is a G1 and G3 failure.
    const away = tjJudge(
      edit(base, (r, k) => {
        r[at(110, 20)] = 190;
        k[at(110, 20) * 4 + 1] = 0;
      }),
      4,
    );
    expect(away.judgment).toBe('FAIL');
    expect(away.reasons).toEqual(['G1', 'G3-equal']);
    // A count of 2 in the crack zone still fails "at most 1".
    const over = tjJudge(
      edit(base, (r, k) => {
        r[at(120, 25)] = 190;
        k[at(120, 25) * 4 + 2] = 2;
      }),
      4,
    );
    expect(over.crack.pixels).toBe(1);
    expect(over.judgment).toBe('FAIL');
    expect(over.reasons).toEqual(['G3-at-most']);
  });

  it('never excuses an outside pixel near a T-junction edge that ends on the boundary', () => {
    // The T-junction mesh with its top at y = 9.75: the T-junction edge (120.5, 9.75)-(120.5, 30)
    // ends on the boundary, and pixel (120, 9), centre (120.5, 9.5), is outside at d = 0.25,
    // 0.25 px from the edge's end, so inside the 4x crack zone and in G3's 0.708 px class.
    const top = Float64Array.from(TJUNCTION.positions);
    for (const v of [0, 1, 2]) top[2 * v + 1] = 9.75;
    const c = synthCase('TEST/tjunction-top/T0/z1-d1', 300);
    const p = ports(() => ({
      ...TJUNCTION,
      positions: top,
      bounds: { ...TJUNCTION.bounds, minY: 9.75 },
    }));
    const outcome = drawCase(c.kase, p, { fringe: 'off' });
    if (outcome.kind !== 'drawn') throw new Error('not drawn');
    const ref = buildReference(outcome.draw, outcome.frame);
    expect(ref.tJunctionEdges).toEqual([[1, 4]]);
    expect(pixelClassForTesting(ref, 120, 9, 0.25)).toEqual({ inside: false, within: true });
    const base = ruleRenderingForTesting(ref, 4);
    expect(evaluateCapture(ref, base, 4).metrics.judgment).toBe('PASS');
    const m = evaluateCapture(
      ref,
      edit(base, (_r, k) => k.fill(0, at(120, 9) * 4, at(120, 9) * 4 + 4)),
      4,
    ).metrics;
    expect(m.crack.zonePixels).toBe(21); // rows 10 to 29 on the edge, and pixel (120, 9)
    expect(m.crack.pixels).toBe(0);
    expect(m.judgment).toBe('FAIL');
    expect(m.reasons).toEqual(['G3-equal']);
  });

  it('gives the 1x crack zone a width of 2β_c, centres on the edge only', () => {
    const base = ruleRenderingForTesting(tjReference(), 1);
    const m = tjJudge(base, 1);
    expect(m.judgment).toBe('PASS');
    expect(m.crack.zoneWidth).toBeGreaterThan(2 * SIGMA);
    expect(m.crack.zoneWidth).toBeLessThan(2 * SIGMA + 2e-3);
    expect(m.crack.zonePixels).toBe(20);
    // A centre count of 0 on the edge is a crack, excluded from "equal to 1".
    const cracked = tjJudge(
      edit(base, (r, k) => {
        r[at(120, 15)] = 0;
        k[at(120, 15)] = 0;
      }),
      1,
    );
    expect(cracked.crack.pixels).toBe(1);
    expect(cracked.judgment).toBe('PASS');
  });
});

describe('contract section 17: count above 1, no-flip zone, σ, pairing, case reasons', () => {
  // Pixel (30, 20): centre (30.5, 20.5), decided interior of RECT (d = 9.5 px), 0.333 px from
  // the diagonal (10.5, 10)-(50, 30) shared by RECT's two triangles: inside the 4x zone of
  // triangle [0, 1, 2] (r = β_c + σ + 0.3953 ≈ 0.48 px), outside the 1x zone (r ≈ 0.089 px).
  // Pixel (20, 27): centre (20.5, 27.5), more than 7 px from every edge of [0, 1, 2].
  const withFlip = (ref: Reference): Reference => ({ ...ref, flipped: [[0, 1, 2]] });

  it('FAILS a count above 1 whatever β, the certificate or the zone', () => {
    const ref = reference(RECT_CASE, 'fringe-4x');
    const base = ruleRenderingForTesting(ref, 4);
    const doubled = edit(base, (_r, k) => (k[at(30, 20) * 4 + 1] = 2));
    // A full-class pixel: both "equal to 1" and "at most 1" fail; a separate counter.
    const plain = evaluateCapture(ref, doubled, 4).metrics;
    expect(plain.judgment).toBe('FAIL');
    expect(plain.reasons).toEqual(['G3-equal', 'G3-at-most']);
    expect(plain.g3).toMatchObject({ fullFail: 1, otherFail: 0, overCount: 1, maxCount: 2 });
    // In the no-flip zone: still FAIL, the in-zone "equal to 1" violation is only UNDECIDED.
    const zoned = evaluateCapture(withFlip(ref), doubled, 4).metrics;
    expect(zoned.judgment).toBe('FAIL');
    expect(zoned.reasons).toEqual(['G3-at-most', 'no-flip zone']);
    expect(zoned.g3.overCount).toBe(1);
    expect(zoned.zone).toMatchObject({ triangles: 1, g3: 1 });
    // β_c ≥ 1 px makes every other gate open, but not "at most 1".
    const wide: Reference = { ...ref, betaC: 1.5 };
    expect(evaluateCapture(wide, base, 4).metrics).toMatchObject({
      judgment: 'UNDECIDED',
      caseUndecided: ['beta ≥ 1 px'],
      zone: { triangles: 0, pixels: 0 },
    });
    const wideDoubled = evaluateCapture(wide, doubled, 4).metrics;
    expect(wideDoubled.judgment).toBe('FAIL');
    expect(wideDoubled.reasons).toContain('G3-at-most');
    expect(wideDoubled.reasons).toContain('beta ≥ 1 px');
  });

  it('is UNDECIDED with E3’s reasons when β_c ≥ 1 px or the clip bound ≥ 0.25 px', () => {
    const ref = reference(RECT_CASE, 'fringe-1x');
    const base = ruleRenderingForTesting(ref, 1);
    const clipped = evaluateCapture({ ...ref, betaClip: 0.25 }, base, 1).metrics;
    expect(clipped.judgment).toBe('UNDECIDED');
    expect(clipped.reasons).toEqual(['clip bound ≥ 0.25 px']);
    // A decided G1 failure does not outrank a case-level reason (E3 measures no such case).
    const off = edit(base, (r) => (r[at(30, 20)] = 252));
    const both = evaluateCapture({ ...ref, betaC: 1, betaClip: 0.3 }, off, 1).metrics;
    expect(both.judgment).toBe('UNDECIDED');
    expect(both.caseUndecided).toEqual(['beta ≥ 1 px', 'clip bound ≥ 0.25 px']);
    // The gate failure that does not decide is labelled open.
    expect(both.reasons).toEqual(['open:G1', 'beta ≥ 1 px', 'clip bound ≥ 0.25 px']);
    expect(evaluateCapture({ ...ref, betaClip: 0.2499 }, base, 1).metrics.judgment).toBe('PASS');
  });

  it('makes only in-zone violations UNDECIDED and leaves compliant zone pixels uncounted', () => {
    const ref = reference(RECT_CASE, 'fringe-4x');
    const base = ruleRenderingForTesting(ref, 4);
    const clean = evaluateCapture(ref, base, 4).metrics;
    const zoned = evaluateCapture(withFlip(ref), base, 4).metrics;
    expect(zoned.judgment).toBe('PASS');
    expect(zoned.zone.pixels).toBeGreaterThan(30);
    expect(zoned.zone.radius).toBeGreaterThan(0.3953 + SIGMA);
    expect(zoned.zone.radius).toBeLessThan(0.3953 + SIGMA + 2e-3);
    expect(zoned.g1.decided).toBeLessThan(clean.g1.decided);
    expect(zoned.g3.fullPixels).toBeLessThan(clean.g3.fullPixels);
    expect(zoned.a5.zoneExcluded).toBeGreaterThan(0);
    // G1 in the zone: UNDECIDED; the same deviation away from it: FAIL.
    const near = evaluateCapture(
      withFlip(ref),
      edit(base, (r) => (r[at(30, 20)] = 250)),
      4,
    );
    expect(near.metrics).toMatchObject({
      judgment: 'UNDECIDED',
      reasons: ['no-flip zone'],
      g1: { fail: 0 },
      zone: { g1: 1, g2: 0, g3: 0 },
    });
    const far = evaluateCapture(
      withFlip(ref),
      edit(base, (r) => (r[at(20, 27)] = 250)),
      4,
    );
    expect(far.metrics.judgment).toBe('FAIL');
    expect(far.metrics.reasons).toEqual(['G1']);
    // G3's "equal to 1" in the zone (a count-0 sample): UNDECIDED.
    const hole = evaluateCapture(
      withFlip(ref),
      edit(base, (_r, k) => (k[at(30, 20) * 4] = 0)),
      4,
    );
    expect(hole.metrics).toMatchObject({ judgment: 'UNDECIDED', zone: { g3: 1 } });
    // G2 in the zone: a misclassified interior pixel.
    const flipped = evaluateCapture(
      withFlip(ref),
      edit(base, (r) => (r[at(30, 20)] = 0)),
      4,
    );
    expect(flipped.metrics).toMatchObject({ judgment: 'UNDECIDED', zone: { g1: 1, g2: 1 } });
    // A decided failure elsewhere outranks the zone.
    const mixed = evaluateCapture(
      withFlip(ref),
      edit(base, (r) => {
        r[at(30, 20)] = 250;
        r[at(20, 27)] = 250;
      }),
      4,
    ).metrics;
    expect(mixed.judgment).toBe('FAIL');
    expect(mixed.reasons).toEqual(['G1', 'no-flip zone']);
    // At 1x the zone has no sample term: pixel (30, 20) is outside it.
    const ref1 = reference(RECT_CASE, 'fringe-1x');
    const one = evaluateCapture(
      withFlip(ref1),
      edit(ruleRenderingForTesting(ref1, 1), (r) => (r[at(30, 20)] = 250)),
      1,
    ).metrics;
    expect(one.judgment).toBe('FAIL');
    expect(one.zone.radius).toBeLessThan(2 * SIGMA + 2e-3);
  });

  it('adds every edge of a clipped triangle, and a border strip, to the zone', () => {
    // RECT extended to x = −20, off the canvas: both region triangles cross the guard band.
    // Pixel (30, 24): centre (30.5, 24.5), 0.069 px from the clipped diagonal (−20, 10)-(50, 30)
    // and 5.5 px from the boundary, so decided interior, inside the 4x zone (r ≈ 0.44 px).
    const wide: FillMesh = {
      positions: Float64Array.from([-20, 10, 50, 10, 50, 30, -20, 30]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      boundaryEdges: Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 0]),
      bounds: { minX: -20, minY: 10, maxX: 50, maxY: 30 },
    };
    const c = synthCase('TEST/clipped/T0/z1-d1', -20);
    const outcome = drawCase(
      c.kase,
      ports(() => wide),
      { fringe: 'off' },
    );
    if (outcome.kind !== 'drawn') throw new Error('not drawn');
    const ref = buildReference(outcome.draw, outcome.frame);
    expect(ref.clipped).toHaveLength(2);
    expect(ref.flipped).toEqual([]);
    expect(ref.betaClip).toBeGreaterThan(0);
    const base = ruleRenderingForTesting(ref, 4);
    const clean = evaluateCapture(ref, base, 4).metrics;
    expect(clean.judgment).toBe('PASS');
    expect(clean.zone).toMatchObject({ triangles: 0, clipped: 2, border: 0 });
    expect(clean.zone.pixels).toBeGreaterThan(0);
    const near = evaluateCapture(
      ref,
      edit(base, (r) => (r[at(30, 24)] = 250)),
      4,
    ).metrics;
    expect(near).toMatchObject({ judgment: 'UNDECIDED', reasons: ['no-flip zone'] });
    expect(near.g1.fail).toBe(0);
    // A count above 1 at a clipped edge still FAILS.
    const over = evaluateCapture(
      ref,
      edit(base, (_r, k) => (k[at(30, 24) * 4] = 2)),
      4,
    ).metrics;
    expect(over.judgment).toBe('FAIL');
    expect(over.reasons).toContain('G3-at-most');
    // The border strip: centres within betaClip + 0.3953 px of the canvas border (one ring when
    // that is in [0.5, 1.5)); at 1x the same clip bound reaches no centre.
    const strip = evaluateCapture({ ...ref, betaClip: 0.2 }, base, 4).metrics;
    expect(strip.zone.border).toBe(2 * 640 + 2 * 360 - 4);
    const ref1 = { ...ref, betaClip: 0.2 };
    expect(evaluateCapture(ref1, ruleRenderingForTesting(ref, 1), 1).metrics.zone.border).toBe(0);
    // Without a clipped triangle there is no strip.
    const rect = reference(RECT_CASE, 'msaa-4x');
    expect(rect.clipped).toEqual([]);
    const noStrip = { ...rect, betaClip: 0.2 };
    expect(evaluateCapture(noStrip, ruleRenderingForTesting(rect, 4), 4).metrics.zone.border).toBe(
      0,
    );
  });

  it('builds the zone under a case-level reason, so VZ4-A5 never fails on in-zone pixels', () => {
    // msaa-4x with β_c ≥ 1: the sliver's certificate fails and its zone is built.
    const eps = 2 ** -12;
    const sliver: FillMesh = {
      positions: Float64Array.from([10, 10, 50, 10, 50, 30, 10, 30, 30, 10 - eps]),
      indices: Uint32Array.from([0, 4, 1, 0, 1, 2, 0, 2, 3]),
      boundaryEdges: Uint32Array.from([0, 4, 4, 1, 1, 2, 2, 3, 3, 0]),
      bounds: { minX: 10, minY: 10 - eps, maxX: 50, maxY: 30 },
    };
    const outcome = drawCase(
      synthCase('TEST/sliver-a5/T0/z1-d1', 10).kase,
      ports(() => sliver),
      {
        fringe: 'off',
      },
    );
    if (outcome.kind !== 'drawn') throw new Error('not drawn');
    const sliverRef = buildReference(outcome.draw, outcome.frame);
    const sliverWide: Reference = { ...sliverRef, betaC: 1.5 };
    const sliverBase = ruleRenderingForTesting(sliverRef, 4);
    const m = evaluateCapture(sliverWide, sliverBase, 4).metrics;
    expect(m.judgment).toBe('UNDECIDED');
    expect(m.zone.triangles).toBe(1);
    expect(m.zone.pixels).toBeGreaterThan(0);
    // An A5 deviation at a decided interior pixel in a zone (RECT's diagonal flipped, β_c 1.5:
    // pixel (30, 20) has d − β_c = 8 ≥ 2) is excluded, not a violation.
    const ref = reference(RECT_CASE, 'msaa-4x');
    const flipped: Reference = { ...ref, betaC: 1.5, flipped: [[0, 1, 2]] };
    const off = edit(ruleRenderingForTesting(ref, 4), (r) => (r[at(30, 20)] = 250));
    const a5 = evaluateCapture(flipped, off, 4).metrics;
    expect(a5.a5.violations).toBe(0);
    expect(a5.a5.zoneExcluded).toBeGreaterThan(0);
    expect(a5.judgment).toBe('UNDECIDED');
    // The same deviation without the zone is an A5 violation.
    expect(evaluateCapture({ ...ref, betaC: 1.5 }, off, 4).metrics.a5.violations).toBe(1);
  });

  it('reports VZ4-A5 violations as undecided under a reference winding anomaly', () => {
    // RECT with its boundary loop listed twice: winding 2 inside, not a region boundary.
    const doubled: FillMesh = {
      ...RECT,
      boundaryEdges: Uint32Array.from([...RECT.boundaryEdges, ...RECT.boundaryEdges]),
    };
    const outcome = drawCase(
      synthCase('TEST/winding/T0/z1-d1', 10).kase,
      ports(() => doubled),
      {
        fringe: 'off',
      },
    );
    if (outcome.kind !== 'drawn') throw new Error('not drawn');
    const ref = buildReference(outcome.draw, outcome.frame);
    const capture = edit(ruleRenderingForTesting(reference(RECT_CASE, 'msaa-4x'), 4), (r) => {
      r[at(30, 20)] = 250;
    });
    const m = evaluateCapture(ref, capture, 4).metrics;
    expect(m.windingAnomalies).toBeGreaterThan(0);
    expect(m.caseUndecided).toEqual(['reference winding']);
    expect(m.judgment).toBe('UNDECIDED');
    expect(m.a5).toMatchObject({ violations: 0, undecided: 1 });
  });

  it('certifies every drawn triangle: region, exterior fringe triangles and frame corners', () => {
    const fringe = reference(RECT_CASE, 'fringe-4x');
    expect(fringe.drawnPoints).toHaveLength(8);
    expect(fringe.noFlip.exteriorChecked).toBeGreaterThan(0);
    expect(fringe.noFlip.checked).toBe(2 + fringe.noFlip.exteriorChecked);
    expect(fringe.noFlip.failed).toBe(0);
    // The corners lie outside the region's bounds.
    const scale = Number(fringe.scale);
    for (const [x, y] of fringe.drawnPoints.slice(4)) {
      const px = Number(x) / scale;
      const py = Number(y) / scale;
      expect(px < 10.5 || px > 50 || py < 10 || py > 30).toBe(true);
    }
    const off = reference(RECT_CASE, 'msaa-4x');
    expect(off.drawnPoints).toHaveLength(4);
    expect(off.noFlip).toMatchObject({ checked: 2, exteriorChecked: 0 });
  });

  it('decides a case whose only failing triangle is a sliver with an empty zone', () => {
    // RECT with a boundary vertex 2^-12 px above its top edge: region triangle [0, 4, 1] is a
    // sliver that fails the certificate. Its zone holds no pixel centre (they are 0.5 px from
    // y = 10), so the case is decided; E3's whole-case veto made it UNDECIDED.
    const eps = 2 ** -12;
    const sliver: FillMesh = {
      positions: Float64Array.from([10, 10, 50, 10, 50, 30, 10, 30, 30, 10 - eps]),
      indices: Uint32Array.from([0, 4, 1, 0, 1, 2, 0, 2, 3]),
      boundaryEdges: Uint32Array.from([0, 4, 4, 1, 1, 2, 2, 3, 3, 0]),
      bounds: { minX: 10, minY: 10 - eps, maxX: 50, maxY: 30 },
    };
    const c = synthCase('TEST/sliver/T0/z1-d1', 10);
    for (const [fringe, samples] of [
      ['on', 1],
      ['on', 4],
    ] as const) {
      const outcome = drawCase(
        c.kase,
        ports(() => sliver),
        { fringe },
      );
      if (outcome.kind !== 'drawn') throw new Error('not drawn');
      const ref = buildReference(outcome.draw, outcome.frame);
      expect(ref.flipped).toEqual([[0, 4, 1]]);
      const base = ruleRenderingForTesting(ref, samples);
      const m = evaluateCapture(ref, base, samples).metrics;
      expect(m.noFlip.failed).toBe(1);
      expect(m.zone).toMatchObject({ triangles: 1, pixels: 0 });
      expect(m.judgment).toBe('PASS');
      // A count above 1 next to the sliver still FAILS.
      const over = evaluateCapture(
        ref,
        edit(base, (_r, k) => (k[at(30, 10) * samples] = 2)),
        samples,
      ).metrics;
      expect(over.judgment).toBe('FAIL');
      expect(over.g3.overCount).toBe(1);
    }
  });

  it('merges vertices of equal p* before pairing (no VERTEX_UNSUPPORTED:duplicate)', () => {
    // Vertex 4 is 1 ulp right of vertex 0 in node-local f64; both round to the same f32 offset
    // fround(v − m), so they have the same p*. Triangle [0, 4, 3] is collapsed at p*.
    const dup: FillMesh = {
      positions: Float64Array.from([10.5, 10, 50, 10, 50, 30, 10.5, 30, 10.5 + 2 ** -49, 10]),
      indices: Uint32Array.from([4, 1, 2, 4, 2, 3, 0, 4, 3]),
      boundaryEdges: Uint32Array.from([0, 4, 4, 1, 1, 2, 2, 3, 3, 0]),
      bounds: { minX: 10.5, minY: 10, maxX: 50, maxY: 30 },
    };
    const c = synthCase('TEST/duplicate/T0/z1-d1', 10);
    for (const fringe of ['on', 'off'] as const) {
      const outcome = drawCase(
        c.kase,
        ports(() => dup),
        { fringe },
      );
      if (outcome.kind !== 'drawn') throw new Error('not drawn');
      const ref = buildReference(outcome.draw, outcome.frame);
      expect(ref.points[4]).toEqual(ref.points[0]);
      expect(ref.merge).toEqual({ vertices: 1, droppedEdges: 1 });
      expect(ref.sectors.status).toBe('OK');
      expect(ref.directed).toHaveLength(4);
      // [0, 4, 3], and on the fringe draw also the exterior triangle on the edge 0-4.
      expect(ref.noFlip.collapsed).toBe(fringe === 'off' ? 1 : 2);
      expect(ref.noFlip.failed).toBe(0);
      const m = evaluateCapture(ref, ruleRenderingForTesting(ref, 4), 4).metrics;
      expect(m.pairing).toBe('OK');
      expect(m.judgment).toBe('PASS');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Synthetic runs

const DRAW_RECORD = (key: string, fringe: 'built' | 'region-only-off', exterior: number) => ({
  prepareSerial: 1,
  draws: [
    {
      nodeId: key,
      paint: 'fill' as const,
      composite: 'plain' as const,
      fringe,
      triangleCount: 2 + exterior,
      regionTriangles: 2,
      exteriorTriangles: exterior,
    },
  ],
});

function observation(
  c: A08Case,
  variant: VizV4Variant,
  capture: Capture,
  options: Readonly<{ browserPorts?: Ports; record?: Observation['record'] }> = {},
): Observation {
  const recorder = recordingPorts(options.browserPorts ?? PORTS);
  drawCase(c.kase, recorder.ports, { fringe: variantQuery(variant).fringe });
  const samples = samplesOf(variant);
  const want = expectedEntry(c, PORTS, variant);
  return {
    key: c.key,
    a04Id: c.a04Id,
    part: c.part,
    gated: c.gated,
    status: want.status,
    reason: want.reason,
    expected: want.status,
    width: capture.width,
    height: capture.height,
    sampleCount: samples,
    devicePixelRatio: c.dpr,
    meshTriangles: 2,
    record:
      options.record !== undefined
        ? options.record
        : DRAW_RECORD(
            c.key,
            variant === 'msaa-4x' ? 'region-only-off' : 'built',
            variant === 'msaa-4x' ? 0 : 8,
          ),
    notices: [],
    meshCalls: recorder.take(),
    notGreyPixels: 0,
    red: encodeRleBase64(capture.red),
    counts: { samples, rle: encodeRleBase64(capture.counts) },
  };
}

/** Rule renderings of every case and variant, computed once. */
const GOOD = new Map<string, Capture>();
function goodCapture(c: A08Case, variant: VizV4Variant): Capture {
  const k = `${c.key}|${variant}`;
  if (!GOOD.has(k)) {
    // A REGION-ONLY case draws nothing under the fringe variants: a black capture.
    const drawn = expectedEntry(c, PORTS, variant).status === 'RENDERED';
    const s = samplesOf(variant);
    GOOD.set(
      k,
      drawn
        ? good(c, variant)
        : {
            width: W,
            height: 360,
            red: new Uint8Array(W * 360),
            counts: new Uint16Array(W * 360 * s),
            samples: s,
          },
    );
  }
  return GOOD.get(k)!;
}

type Tweak = (
  c: A08Case,
  variant: VizV4Variant,
  o: Observation,
  project: string,
) => Observation | null;

/** A run of both headed browsers, `chrome` and `edge` (playwright.gpu.config.ts). */
function syntheticRun(
  tweak: Tweak = (_c, _v, o) => o,
  projects: readonly string[] = ['chrome', 'edge'],
): LoadedRun {
  const groups: RunGroup[] = projects.flatMap((project) =>
    VIZ_V4_VARIANTS.map((variant) => ({
      project,
      variant,
      dpr: 1 as const,
      meta: { label: 'PRE-FREEZE', complete: true, variant, dpr: 1 },
      observations: SUBSET.flatMap((c) => {
        const o = tweak(c, variant, observation(c, variant, goodCapture(c, variant)), project);
        return o === null ? [] : [o];
      }),
    })),
  );
  return { projects, groups, files: {} };
}

const WASM_SHA = createHash('sha256').update('test-wasm').digest('hex');

function expectedFile(): ExpectedFile {
  const statuses: Record<string, Record<VizV4Variant, ReturnType<typeof expectedEntry>>> = {};
  for (const c of SUBSET)
    statuses[c.key] = Object.fromEntries(
      VIZ_V4_VARIANTS.map((variant) => [variant, expectedEntry(c, PORTS, variant)]),
    ) as Record<VizV4Variant, ReturnType<typeof expectedEntry>>;
  return {
    version: 'a08-expected-status/v1',
    subsetKeysSha256: summarizeA08Subset(SUBSET).keysSha256,
    wasmSha256: WASM_SHA,
    statuses,
  };
}

function evaluate(run: LoadedRun) {
  return evaluateRun({
    run,
    expected: expectedFile(),
    expectedSha256: 'test',
    subset: SUBSET,
    ports: PORTS,
    wasmSha256: WASM_SHA,
    label: 'PRE-FREEZE',
  });
}

describe('runner (sections 4.4, 5.3, VZ4-A3 to A7)', () => {
  it('expects the rectangle RENDERED, and the T-junction mesh REGION-ONLY under the fringe', () => {
    for (const variant of VIZ_V4_VARIANTS)
      expect(expectedEntry(RECT_CASE, PORTS, variant).status).toBe('RENDERED');
    expect(VIZ_V4_VARIANTS.map((v) => expectedEntry(TJ_CASE, PORTS, v))).toMatchObject([
      { status: 'REGION-ONLY', reason: 'fringe-unsupported' },
      { status: 'REGION-ONLY', reason: 'fringe-unsupported' },
      { status: 'RENDERED' },
    ]);
  });

  it('PASSES a known-good run, labelled PRE-FREEZE', () => {
    const body = evaluate(syntheticRun());
    expect(body.label).toBe('PRE-FREEZE');
    expect(body.result).toBe('PASS');
    expect(body.verdict.result).toBe('PASS');
    for (const id of ['VZ4-A3', 'VZ4-A4', 'VZ4-A5', 'VZ4-A6', 'VZ4-A7'])
      expect(body.criteria[id]!.result, id).toBe('PASS');
    expect(body.cases).toHaveLength(12);
    expect(body.cases.map((c) => c.judgment)).toEqual([
      ...['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS'],
      ...[null, null, null, null, 'PASS', 'PASS'],
    ]);
    expect((body.inputs['run'] as { projects: string[] }).projects).toEqual(['chrome', 'edge']);
    const report = body.report as { groups: { variant: string }[]; difference1x4x: unknown[] };
    expect(report.groups.map((g) => g.variant)).toEqual([
      ...['fringe-1x', 'fringe-1x', 'fringe-4x', 'fringe-4x', 'msaa-4x', 'msaa-4x'],
    ]);
    expect(report.difference1x4x).toHaveLength(2);
  });

  it('FAILS VZ4-A3 when one browser is missing', () => {
    const body = evaluate(syntheticRun(undefined, ['chrome']));
    expect(body.criteria['VZ4-A3']).toMatchObject({ result: 'FAIL', missingProjects: ['edge'] });
    expect(body.result).toBe('FAIL');
  });

  it('FAILS a run with an interior pixel 3/255 off', () => {
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'chrome' && c === RECT_CASE && variant === 'fringe-1x'
          ? observation(
              c,
              variant,
              edit(goodCapture(c, variant), (r) => (r[at(30, 20)] = 252)),
            )
          : o,
      ),
    );
    expect(body.result).toBe('FAIL');
    expect(body.verdict.failing).toEqual([
      { project: 'chrome', key: RECT_CASE.key, variant: 'fringe-1x', gates: ['G1'] },
    ]);
    expect(body.criteria['VZ4-A6']!.result).toBe('FAIL');
    expect(body.criteria['VZ4-A7']!.result).toBe('PASS');
  });

  it('FAILS VZ4-A5 when the fringe is left on in msaa-4x', () => {
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'chrome' && variant === 'msaa-4x' && c === RECT_CASE
          ? observation(c, variant, goodCapture(c, variant), {
              record: DRAW_RECORD(c.key, 'built', 8),
            })
          : o,
      ),
    );
    expect(body.criteria['VZ4-A5']).toMatchObject({
      result: 'FAIL',
      recordFailures: [`chrome/msaa-4x/dpr1:${RECT_CASE.key}`],
    });
    expect(body.result).toBe('FAIL');
  });

  it('FAILS VZ4-A5 when an msaa-4x interior pixel is not 255', () => {
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'chrome' && variant === 'msaa-4x' && c === RECT_CASE
          ? observation(
              c,
              variant,
              edit(goodCapture(c, variant), (r) => (r[at(30, 20)] = 254)),
            )
          : o,
      ),
    );
    expect(body.criteria['VZ4-A5']!.result).toBe('FAIL');
    expect(body.verdict.result).toBe('PASS'); // msaa-4x is never gated
    expect(body.result).toBe('FAIL');
  });

  it('FAILS VZ4-A5 when a RENDERED msaa-4x case has no draw of its node in the record', () => {
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'chrome' && variant === 'msaa-4x' && c === RECT_CASE
          ? observation(c, variant, goodCapture(c, variant), {
              record: { prepareSerial: 1, draws: [] },
            })
          : o,
      ),
    );
    expect(body.criteria['VZ4-A5']).toMatchObject({
      result: 'FAIL',
      recordFailures: [`chrome/msaa-4x/dpr1:${RECT_CASE.key}:no draw of the case`],
    });
    expect(body.result).toBe('FAIL');
  });

  it('keeps VZ4-A5 PASS for an msaa-4x crack at a T-junction edge, and reports it', () => {
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'chrome' && variant === 'msaa-4x' && c === TJ_CASE
          ? observation(
              c,
              variant,
              edit(goodCapture(c, variant), (r, k) => {
                r[at(120, 20)] = 191;
                k[at(120, 20) * 4 + 3] = 0;
              }),
            )
          : o,
      ),
    );
    expect(body.criteria['VZ4-A5']!.result).toBe('PASS');
    const entry = body.cases.find(
      (c) => c.project === 'chrome' && c.key === TJ_CASE.key && c.variant === 'msaa-4x',
    )!;
    expect(entry.metrics!.crack.pixels).toBe(1);
    expect(entry.metrics!.a5).toMatchObject({ violations: 0, crackExcluded: 1 });
    const group = (
      body.report as {
        groups: { project: string; variant: string; part: string; a5: { crackExcluded: number } }[];
      }
    ).groups.find((g) => g.project === 'chrome' && g.variant === 'msaa-4x')!;
    expect(group.a5.crackExcluded).toBe(1);
    expect(body.result).toBe('PASS');
  });

  it('FAILS VZ4-A4 on a one-byte mesh change (MESH-MISMATCH)', () => {
    const positions = Float64Array.from(RECT.positions);
    const bytes = new Uint8Array(positions.buffer);
    bytes[2 * 8] = bytes[2 * 8]! ^ 1; // the lowest byte of x of vertex 1
    const changed = ports((tag) => (tag === 10 ? { ...RECT, positions } : TJUNCTION));
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'chrome' && c === RECT_CASE && variant === 'fringe-4x'
          ? observation(c, variant, goodCapture(c, variant), { browserPorts: changed })
          : o,
      ),
    );
    expect(body.criteria['VZ4-A4']).toMatchObject({
      result: 'FAIL',
      mismatches: [`chrome/fringe-4x/dpr1:${RECT_CASE.key}`],
    });
    const entry = body.cases.find((c) => c.key === RECT_CASE.key && c.variant === 'fringe-4x')!;
    expect(entry.status).toBe('MESH-MISMATCH');
    expect(entry.metrics).toBeNull();
    expect(body.result).toBe('FAIL');
  });

  it('FAILS VZ4-A3 on a missing case', () => {
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'chrome' && c === TJ_CASE && variant === 'fringe-1x' ? null : o,
      ),
    );
    expect(body.criteria['VZ4-A3']).toMatchObject({
      result: 'FAIL',
      missingCases: [`chrome/fringe-1x/dpr1:${TJ_CASE.key}`],
    });
    expect(body.result).toBe('FAIL');
  });

  it('is INCONCLUSIVE when a gated case is UNDECIDED', () => {
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'chrome' && c === RECT_CASE && variant === 'fringe-4x'
          ? observation(
              c,
              variant,
              edit(goodCapture(c, variant), (r) => (r[at(12, 20)] = 250)),
            )
          : o,
      ),
    );
    expect(body.result).toBe('INCONCLUSIVE');
    expect(body.verdict.inconclusive).toEqual(['gated case UNDECIDED']);
    expect(body.criteria['VZ4-A6']!.result).toBe('UNDECIDED');
  });

  it('FAILS VZ4-A7 on a sample count above 1, and reports it per group', () => {
    const body = evaluate(
      syntheticRun((c, variant, o, project) =>
        project === 'edge' && c === RECT_CASE && variant === 'fringe-4x'
          ? observation(
              c,
              variant,
              edit(goodCapture(c, variant), (_r, k) => (k[at(30, 20) * 4 + 2] = 3)),
            )
          : o,
      ),
    );
    expect(body.result).toBe('FAIL');
    expect(body.criteria['VZ4-A7']!.result).toBe('FAIL');
    expect(body.criteria['VZ4-A6']!.result).toBe('PASS');
    const group = (
      body.report as { groups: { project: string; variant: string; g3: { overCount: number } }[] }
    ).groups.find((g) => g.project === 'edge' && g.variant === 'fringe-4x')!;
    expect(group.g3.overCount).toBe(1);
    // The tally reports the zone totals and the A5 zone exclusions.
    expect(group).toMatchObject({
      zone: { cases: 0, pixels: 0, g1: 0, g2: 0, g3: 0 },
      a5: { undecided: 0, zoneExcluded: 0 },
    });
  });

  it('refuses inputs that do not belong together', () => {
    expect(() =>
      evaluateRun({
        run: syntheticRun(),
        expected: { ...expectedFile(), wasmSha256: 'other' },
        expectedSha256: 'test',
        subset: SUBSET,
        ports: PORTS,
        wasmSha256: WASM_SHA,
        label: 'PRE-FREEZE',
      }),
    ).toThrow(/another WASM/u);
  });
});

describe('verdict (section 5.3)', () => {
  const entry = (index: number, overrides: Partial<VerdictEntry> = {}): VerdictEntry => ({
    project: 'chrome',
    key: `C1/r${String(index)}@dpr1`,
    variant: 'fringe-1x',
    dpr: 1,
    gated: true,
    expected: { status: 'RENDERED', reason: '' },
    headed: 'RENDERED',
    headedReason: '',
    judgment: 'PASS',
    reasons: [],
    ...overrides,
  });
  const twenty = (changes: Record<number, Partial<VerdictEntry>>) =>
    Array.from({ length: 20 }, (_, i) => entry(i, changes[i] ?? {}));

  it('applies the 5 % rule per browser and gated DPR', () => {
    // A not-RENDERED case expected RENDERED is also a deviation, so the rule is read from
    // `notRendered` and from whether its condition is among the INCONCLUSIVE ones. The pool is
    // the twenty gated cases expected RENDERED; a case expected KERNEL-REJECTED stays out of it.
    const rejected = {
      expected: { status: 'KERNEL-REJECTED' as const, reason: 'failed:work-limit' },
    };
    const outOfPool = entry(20, { headed: 'KERNEL-REJECTED', judgment: null, ...rejected });
    const rule = 'more than 5 % not RENDERED';
    // One missing of a pool of twenty: exactly 5 %, not more.
    const atLimit = decideVerdict(
      [...twenty({ 0: { headed: 'MESH-MISMATCH', judgment: null } }), outOfPool],
      ['chrome'],
    );
    expect(atLimit.notRendered[0]).toMatchObject({
      project: 'chrome',
      dpr: 1,
      expectedRendered: 20,
      notRendered: 1,
      exceeds: false,
    });
    expect(atLimit.inconclusive).not.toContain(rule);
    // Two missing of twenty: 10 %, INCONCLUSIVE.
    const over = decideVerdict(
      [
        ...twenty({
          0: { headed: 'MESH-MISMATCH', judgment: null },
          1: { headed: 'REGION-ONLY', headedReason: 'fringe-work-cap', judgment: null },
        }),
        outOfPool,
      ],
      ['chrome'],
    );
    expect(over.result).toBe('INCONCLUSIVE');
    expect(over.inconclusive).toContain(rule);
    expect(over.notRendered[0]).toMatchObject({
      expectedRendered: 20,
      notRendered: 2,
      exceeds: true,
    });
    // A complete run inside the pool is PASS.
    expect(decideVerdict([...twenty({}), outOfPool], ['chrome']).result).toBe('PASS');
  });

  it('is INCONCLUSIVE on a deviation from the expected list, even of an ungated case', () => {
    const v = decideVerdict(
      [entry(0), entry(1, { gated: false, headed: 'REGION-ONLY', judgment: null })],
      ['chrome'],
    );
    expect(v.result).toBe('INCONCLUSIVE');
    expect(v.inconclusive).toEqual(['headed status differs from the expected list']);
    expect(v.deviations).toHaveLength(1);
  });

  it('is INCONCLUSIVE on a gated RENDERER-FAILED or port-empty case, expected or headed', () => {
    const failed = { status: 'RENDERER-FAILED' as const, reason: 'packing-range' };
    const v = decideVerdict(
      [
        ...twenty({}),
        entry(30, {
          expected: failed,
          headed: 'RENDERER-FAILED',
          headedReason: 'packing-range',
          judgment: null,
        }),
      ],
      ['chrome'],
    );
    expect(v.result).toBe('INCONCLUSIVE');
    expect(v.inconclusive).toEqual(['gated RENDERER-FAILED or port-empty']);
    expect(v.flagged.map((f) => f.source)).toEqual(['expected', 'headed']);
    const empty = { status: 'EMPTY-CROP' as const, reason: 'port-empty' };
    expect(
      decideVerdict(
        [
          ...twenty({}),
          entry(31, {
            expected: empty,
            headed: 'EMPTY-CROP',
            headedReason: 'port-empty',
            judgment: null,
          }),
        ],
        ['chrome'],
      ).inconclusive,
    ).toEqual(['gated RENDERER-FAILED or port-empty']);
    // Ungated, the same statuses are only reported.
    expect(
      decideVerdict(
        [
          entry(0),
          entry(32, { gated: false, expected: failed, headed: 'RENDERER-FAILED', judgment: null }),
        ],
        ['chrome'],
      ).result,
    ).toBe('PASS');
  });

  it('FAILS on a failing gated case, and FAIL outranks INCONCLUSIVE', () => {
    const failing = twenty({ 3: { judgment: 'FAIL', reasons: ['G2'] } });
    expect(decideVerdict(failing, ['chrome'])).toMatchObject({
      result: 'FAIL',
      failing: [{ key: 'C1/r3@dpr1', gates: ['G2'] }],
    });
    const both = twenty({ 3: { judgment: 'FAIL', reasons: ['G2'] }, 4: { judgment: 'UNDECIDED' } });
    const v = decideVerdict(both, ['chrome']);
    expect(v.result).toBe('FAIL');
    expect(v.failing).toHaveLength(1);
    expect(v.inconclusive).toEqual(['gated case UNDECIDED']);
    expect(decideVerdict(twenty({ 4: { judgment: 'UNDECIDED' } }), ['chrome']).result).toBe(
      'INCONCLUSIVE',
    );
    // msaa-4x and DPR 3 are never gated.
    expect(
      decideVerdict([entry(0, { variant: 'msaa-4x', judgment: 'FAIL' })], ['chrome']).result,
    ).toBe('PASS');
  });
});

describe('record and replay (VZ4-A9, VZ4-A11)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function writeRun(root: string, run: LoadedRun) {
    for (const g of run.groups) {
      const dir = path.join(root, 'run', groupPath(g.project, g.variant, g.dpr));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(g.meta)}\n`);
      writeFileSync(
        path.join(dir, 'observations.ndjson'),
        g.observations.map((o) => `${JSON.stringify(o)}\n`).join(''),
      );
    }
    writeFileSync(path.join(root, 'kernel.wasm'), 'test-wasm');
    writeFileSync(path.join(root, 'expected.json'), JSON.stringify(expectedFile()));
  }

  const options = (root: string) => ({
    root,
    runDir: path.join(root, 'run'),
    wasmPath: path.join(root, 'kernel.wasm'),
    expectedPath: path.join(root, 'expected.json'),
    subset: SUBSET,
    loadPorts: () => Promise.resolve(PORTS),
    freezeRecorded: () => true,
  });

  it('is deterministic and replays byte-identically', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'viz-v4-metrics-'));
    dirs.push(root);
    writeRun(root, syntheticRun());
    const out = path.join(root, 'record');
    const { body, text } = await runMetrics({ ...options(root), outDir: out });
    expect(body.result).toBe('PASS');
    expect(readFileSync(path.join(out, 'record.json'), 'utf8')).toBe(text);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    const parsed = JSON.parse(text) as { provenance: Record<string, unknown>; body: unknown };
    expect(parsed.provenance).toEqual({
      runDir: 'run',
      wasm: 'kernel.wasm',
      expected: 'expected.json',
      node: { version: process.version, v8: process.versions.v8 },
    });
    expect(canonicalJson(parsed.body)).not.toContain(process.version);
    expect(canonicalJson(parsed.body)).toBe(canonicalJson(body));
    expect(Object.keys(body.inputs['run'] as object)).toEqual(['projects', 'files']);
    const md = readFileSync(path.join(out, 'record.md'), 'utf8');
    expect(md).toMatch(/^# V-4 A08 metrics record \(PRE-FREEZE\)/u);
    expect(md).toContain('PRE-FREEZE, not counted');

    const replay = await replayRecord({ ...options(root), recordDir: out });
    expect(replay).toMatchObject({ identical: true, reason: null });
    expect(replay.text).toBe(text);

    // A record evaluated on another Node is refused.
    const recordPath = path.join(out, 'record.json');
    writeFileSync(recordPath, text.replace(`"version":"${process.version}"`, '"version":"v0.0.0"'));
    await expect(replayRecord({ ...options(root), recordDir: out })).rejects.toThrow(
      /evaluated on Node v0\.0\.0/u,
    );
    writeFileSync(recordPath, text);

    // A record of another metrics version (the v1 PRE-FREEZE record) is refused.
    expect(text).toContain('"version":"viz-v4-metrics/v2"');
    writeFileSync(
      recordPath,
      text.replace('"version":"viz-v4-metrics/v2"', '"version":"viz-v4-metrics/v1"'),
    );
    await expect(replayRecord({ ...options(root), recordDir: out })).rejects.toThrow(
      /record is viz-v4-metrics\/v1, this runner writes viz-v4-metrics\/v2/u,
    );
    writeFileSync(recordPath, text);

    // A changed capture byte changes the inputs, and the replay says so.
    const file = path.join(root, 'run/chrome/fringe-1x/dpr1/observations.ndjson');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('"notGreyPixels":0', '"notGreyPixels":1'),
    );
    expect(await replayRecord({ ...options(root), recordDir: out })).toMatchObject({
      identical: false,
      reason: 'the run files differ from the record inputs',
    });
  });

  it('refuses before the E3 freeze record', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'viz-v4-metrics-'));
    dirs.push(root);
    await expect(
      runMetrics({ ...options(root), freezeRecorded: () => false, outDir: path.join(root, 'o') }),
    ).rejects.toThrow(/freeze record/u);
  });
});
