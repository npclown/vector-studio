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
    expect(ref.betaC).toBeGreaterThan(0);
    expect(ref.betaC).toBeLessThan(1e-3);
    expect(ref.betaC).toBeGreaterThanOrEqual(ref.betaVertex);
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

  it('gives the 1x crack zone a width of 2β_c, centres on the edge only', () => {
    const base = ruleRenderingForTesting(tjReference(), 1);
    const m = tjJudge(base, 1);
    expect(m.judgment).toBe('PASS');
    expect(m.crack.zoneWidth).toBeLessThan(1e-3);
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

type Tweak = (c: A08Case, variant: VizV4Variant, o: Observation) => Observation | null;

function syntheticRun(tweak: Tweak = (_c, _v, o) => o): LoadedRun {
  const groups: RunGroup[] = VIZ_V4_VARIANTS.map((variant) => ({
    project: 'chromium',
    variant,
    dpr: 1,
    meta: { label: 'PRE-FREEZE', complete: true, variant, dpr: 1 },
    observations: SUBSET.flatMap((c) => {
      const o = tweak(c, variant, observation(c, variant, goodCapture(c, variant)));
      return o === null ? [] : [o];
    }),
  }));
  return { projects: ['chromium'], groups, files: {} };
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
    expect(body.cases).toHaveLength(6);
    expect(body.cases.map((c) => c.judgment)).toEqual(['PASS', 'PASS', 'PASS', null, null, 'PASS']);
    const report = body.report as { groups: { variant: string }[]; difference1x4x: unknown[] };
    expect(report.groups.map((g) => g.variant)).toEqual(['fringe-1x', 'fringe-4x', 'msaa-4x']);
    expect(report.difference1x4x).toHaveLength(1);
  });

  it('FAILS a run with an interior pixel 3/255 off', () => {
    const body = evaluate(
      syntheticRun((c, variant, o) =>
        c === RECT_CASE && variant === 'fringe-1x'
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
      { project: 'chromium', key: RECT_CASE.key, variant: 'fringe-1x', gates: ['G1'] },
    ]);
    expect(body.criteria['VZ4-A6']!.result).toBe('FAIL');
    expect(body.criteria['VZ4-A7']!.result).toBe('PASS');
  });

  it('FAILS VZ4-A5 when the fringe is left on in msaa-4x', () => {
    const body = evaluate(
      syntheticRun((c, variant, o) =>
        variant === 'msaa-4x' && c === RECT_CASE
          ? observation(c, variant, goodCapture(c, variant), {
              record: DRAW_RECORD(c.key, 'built', 8),
            })
          : o,
      ),
    );
    expect(body.criteria['VZ4-A5']).toMatchObject({
      result: 'FAIL',
      recordFailures: [`chromium/msaa-4x/dpr1:${RECT_CASE.key}`],
    });
    expect(body.result).toBe('FAIL');
  });

  it('FAILS VZ4-A5 when an msaa-4x interior pixel is not 255', () => {
    const body = evaluate(
      syntheticRun((c, variant, o) =>
        variant === 'msaa-4x' && c === RECT_CASE
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

  it('FAILS VZ4-A4 on a one-byte mesh change (MESH-MISMATCH)', () => {
    const positions = Float64Array.from(RECT.positions);
    const bytes = new Uint8Array(positions.buffer);
    bytes[2 * 8] = bytes[2 * 8]! ^ 1; // the lowest byte of x of vertex 1
    const changed = ports((tag) => (tag === 10 ? { ...RECT, positions } : TJUNCTION));
    const body = evaluate(
      syntheticRun((c, variant, o) =>
        c === RECT_CASE && variant === 'fringe-4x'
          ? observation(c, variant, goodCapture(c, variant), { browserPorts: changed })
          : o,
      ),
    );
    expect(body.criteria['VZ4-A4']).toMatchObject({
      result: 'FAIL',
      mismatches: [`chromium/fringe-4x/dpr1:${RECT_CASE.key}`],
    });
    const entry = body.cases.find((c) => c.key === RECT_CASE.key && c.variant === 'fringe-4x')!;
    expect(entry.status).toBe('MESH-MISMATCH');
    expect(entry.metrics).toBeNull();
    expect(body.result).toBe('FAIL');
  });

  it('FAILS VZ4-A3 on a missing case', () => {
    const body = evaluate(
      syntheticRun((c, variant, o) => (c === TJ_CASE && variant === 'fringe-1x' ? null : o)),
    );
    expect(body.criteria['VZ4-A3']).toMatchObject({
      result: 'FAIL',
      missingCases: [`chromium/fringe-1x/dpr1:${TJ_CASE.key}`],
    });
    expect(body.result).toBe('FAIL');
  });

  it('is INCONCLUSIVE when a gated case is UNDECIDED', () => {
    const body = evaluate(
      syntheticRun((c, variant, o) =>
        c === RECT_CASE && variant === 'fringe-4x'
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
    project: 'chromium',
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
    // One case of twenty not RENDERED, as expected: 5 %, not more.
    const one = { expected: { status: 'KERNEL-REJECTED' as const, reason: 'failed:work-limit' } };
    const atLimit = twenty({
      0: { headed: 'KERNEL-REJECTED', judgment: null, ...one },
    });
    expect(decideVerdict(atLimit, ['chromium']).result).toBe('PASS');
    // Two of twenty expected RENDERED and headed MESH-MISMATCH: more than 5 %.
    const over = twenty({
      0: { headed: 'MESH-MISMATCH', judgment: null },
      1: { headed: 'MESH-MISMATCH', judgment: null },
    });
    const v = decideVerdict(over, ['chromium']);
    expect(v.result).toBe('INCONCLUSIVE');
    expect(v.inconclusive).toContain('more than 5 % not RENDERED');
    expect(v.notRendered[0]).toMatchObject({ expectedRendered: 20, notRendered: 2, exceeds: true });
    // One of nineteen expected RENDERED headed otherwise is 5.3 %: also more than 5 %.
    const nineteen = twenty({
      0: { headed: 'KERNEL-REJECTED', judgment: null, ...one },
      1: { headed: 'REGION-ONLY', headedReason: 'fringe-work-cap', judgment: null },
    });
    expect(decideVerdict(nineteen, ['chromium']).notRendered[0]).toMatchObject({
      expectedRendered: 19,
      notRendered: 1,
      exceeds: true,
    });
  });

  it('is INCONCLUSIVE on a deviation from the expected list, even of an ungated case', () => {
    const v = decideVerdict(
      [entry(0), entry(1, { gated: false, headed: 'REGION-ONLY', judgment: null })],
      ['chromium'],
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
      ['chromium'],
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
        ['chromium'],
      ).inconclusive,
    ).toEqual(['gated RENDERER-FAILED or port-empty']);
    // Ungated, the same statuses are only reported.
    expect(
      decideVerdict(
        [
          entry(0),
          entry(32, { gated: false, expected: failed, headed: 'RENDERER-FAILED', judgment: null }),
        ],
        ['chromium'],
      ).result,
    ).toBe('PASS');
  });

  it('FAILS on a failing gated case and lets INCONCLUSIVE take precedence', () => {
    const failing = twenty({ 3: { judgment: 'FAIL', reasons: ['G2'] } });
    expect(decideVerdict(failing, ['chromium'])).toMatchObject({
      result: 'FAIL',
      failing: [{ key: 'C1/r3@dpr1', gates: ['G2'] }],
    });
    const both = twenty({ 3: { judgment: 'FAIL', reasons: ['G2'] }, 4: { judgment: 'UNDECIDED' } });
    const v = decideVerdict(both, ['chromium']);
    expect(v.result).toBe('INCONCLUSIVE');
    expect(v.failing).toHaveLength(1);
    // msaa-4x and DPR 3 are never gated.
    expect(
      decideVerdict([entry(0, { variant: 'msaa-4x', judgment: 'FAIL' })], ['chromium']).result,
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
    const parsed = JSON.parse(text) as { provenance: Record<string, string>; body: unknown };
    expect(parsed.provenance).toEqual({
      runDir: 'run',
      wasm: 'kernel.wasm',
      expected: 'expected.json',
    });
    expect(canonicalJson(parsed.body)).toBe(canonicalJson(body));
    expect(Object.keys(body.inputs['run'] as object)).toEqual(['projects', 'files']);
    const md = readFileSync(path.join(out, 'record.md'), 'utf8');
    expect(md).toMatch(/^# V-4 A08 metrics record \(PRE-FREEZE\)/u);
    expect(md).toContain('PRE-FREEZE, not counted');

    const replay = await replayRecord({ ...options(root), recordDir: out });
    expect(replay).toMatchObject({ identical: true, reason: null });
    expect(replay.text).toBe(text);

    // A changed capture byte changes the inputs, and the replay says so.
    const file = path.join(root, 'run/chromium/fringe-1x/dpr1/observations.ndjson');
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
