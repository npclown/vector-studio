import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controlPorts, fan, meshFromTriangles, RECT } from './e3-a04/controls.js';
import { fill, polygon, rect } from './e3-a04/oracle-cases.js';
import {
  clipCheck,
  emulatedReadback,
  isNamedReadbackCase,
  modelCheck,
  perturbedReadback,
  readbackPayload,
} from './e3-a04/readback.js';
import { combineGpuChecks, type GpuBrowserCheck } from './e3-a04/record.js';
import { mapPoint, tJunctionTriples } from './e3-a04/harness.js';
import { harnessCase } from './e3-a04/smoke.js';

// D9 E3 unit E3-U4: the GPU model check's Node side (contract section 16), without a GPU. A CPU
// binary32 stand-in for the page shows that the check accepts a conforming readback and rejects
// E3-PC12 (one position at p* + 2β), a vertex mapped differently by two invocations, other mesh
// bytes and another shader source. The page itself runs in tests/gpu/e3-a04-readback.spec.ts.

const ports = controlPorts({ status: 'ok', mesh: meshFromTriangles(fan(RECT)) });
const cases = [
  harnessCase({ id: 'unit/rect/T0/z1-d1', ...polygon(RECT), paint: fill() }),
  harnessCase({
    id: 'unit/rect-far/T0/z64-d3',
    ...polygon(rect(0, 0, 4, 2)),
    paint: fill(),
    t: [2 ** 24, -(2 ** 24)],
    zoom: 64,
    dpr: 3,
  }),
];
const payload = readbackPayload(cases, ports);

describe('E3-U4 GPU model check, Node side (section 16)', () => {
  it('accepts a binary32 readback of every point within β', () => {
    expect(payload.draws.length).toBe(2);
    const check = modelCheck(payload, emulatedReadback(payload));
    expect(check.failures).toEqual([]);
    expect(check.points).toBe(payload.draws.reduce((n, d) => n + d.expected.length, 0));
    expect(check.maxVertexRatio).toBeLessThan(1);
    expect(check.maxFeatureRatio).toBeLessThan(1);
  });

  it('E3-PC12: one read-back position at p* + 2β(p) fails the check on both paths', () => {
    for (let d = 0; d < payload.draws.length; d += 1) {
      const check = modelCheck(
        payload,
        perturbedReadback(payload, emulatedReadback(payload), d, 1),
      );
      expect(check.passed).toBe(false);
      expect(check.failures.some((f) => f.includes('#1: vertex path'))).toBe(true);
      expect(check.failures.some((f) => f.includes('#1: feature path'))).toBe(true);
    }
  });

  it('rejects a vertex mapped differently by two invocations, other mesh bytes and another shader', () => {
    const good = emulatedReadback(payload);
    const n = payload.draws[0]!.expected.length;
    const split = {
      ...good,
      results: good.results.map((r, d) => {
        if (d !== 0) return r;
        const ndc = [...r.ndc];
        ndc[4 * n] = ndc[4 * n]! ^ 1;
        return { ...r, ndc };
      }),
    };
    expect(modelCheck(payload, split).failures).toContain(
      `${payload.draws[0]!.id}#0: NDC bits differ between invocations`,
    );
    const bytes = { ...good, results: good.results.map((r) => ({ ...r, meshSha256: '00' })) };
    expect(modelCheck(payload, bytes).failures.some((f) => f.includes('mesh bytes'))).toBe(true);
    expect(modelCheck(payload, { ...good, shaderSha256: '00' }).passed).toBe(false);
  });

  it('E3-A6 needs Chrome and Edge, on this shader and WASM, on a hardware adapter', () => {
    const expected = { shaderSha256: payload.shaderSha256, wasmSha256: 'w' };
    const check = (project: string, extra: Partial<GpuBrowserCheck> = {}): GpuBrowserCheck => ({
      schema: 'e3-a04-gpu-check/v1',
      passed: true,
      browser: { project, adapter: { software: false } },
      shaderSha256: payload.shaderSha256,
      wasmSha256: 'w',
      ...extra,
    });
    expect(combineGpuChecks([check('chrome'), check('edge')], expected, 'r').passed).toBe(true);
    expect(combineGpuChecks([check('chrome')], expected, 'r').passed).toBe(false);
    expect(
      combineGpuChecks([check('chrome'), check('edge', { wasmSha256: 'x' })], expected, 'r').passed,
    ).toBe(false);
    expect(
      combineGpuChecks(
        [
          check('chrome'),
          check('edge', { browser: { project: 'edge', adapter: { software: true } } }),
        ],
        expected,
        'r',
      ).passed,
    ).toBe(false);
  });

  it('the page evaluates the shader’s own helpers on the source it is given', () => {
    const page = readFileSync('apps/playground/src/e3-a04-readback.ts', 'utf8');
    expect(page).toContain('meshPositionNdc(instance.vertexBase + vertexIndex, instance)');
    expect(page).toContain('toPhysical(positions[instance.vertexBase + input.local], instance)');
    expect(page).toContain('createShaderModule({ code: shader + E3_A04_READBACK_ENTRY_POINTS })');
    expect(payload.shader).toContain('fn meshPositionNdc(');
  });

  it('E3-U5: the clip readback accepts exact strip coverage and catches one flipped pixel', () => {
    const edge = readbackPayload(
      [
        harnessCase({
          id: 'unit/rect-edge/T0/z1-d1',
          ...polygon(RECT),
          paint: fill(),
          // The rectangle [0, 96] × [0, 48] maps to [−93.5 − 2^-11, 2.5 − 2^-11] × [−46, 2]: its
          // right and bottom edges run inside the strip, the rest of it is clipped. The right
          // edge passes 2^-11 px from the pixel centres of column 2, which are left out.
          c: [93.5 + 2 ** -11, 46],
        }),
      ],
      ports,
    );
    const draw = edge.draws[0]!;
    expect(draw.clip).toBe(true);
    const good = emulatedReadback(edge);
    const check = modelCheck(edge, good);
    expect(check.failures).toEqual([]);
    expect(check.clip.draws).toBe(1);
    expect(check.clip.compared).toBeGreaterThan(1000);
    expect(check.clip.excluded).toBe(2);
    // Pixel 0 of the strip is (0, 0), the top-left corner: flip the first compared pixel.
    const coverage = [...good.results[0]!.coverage!];
    const bad = clipCheck(
      draw,
      coverage.map((w, i) => (i === 0 ? (w ^ 1) >>> 0 : w)),
    );
    expect(bad.mismatches.length).toBe(1);
    // A draw that is not clipped carries no coverage and is not compared.
    expect(payload.draws[0]!.clip).toBe(false);
    expect(emulatedReadback(payload).results[0]!.coverage).toBeUndefined();
  });

  it('E3-U5: T-junctions are found exactly, and the crack width is read from the readback', () => {
    // A square whose diagonal carries a T-vertex at its midpoint on one side only.
    const at = (x: number, y: number) =>
      mapPoint(x, y, {
        linear: [1, 0, 0, 1],
        anchor: [0, 0],
        frame: { originMinusCamera: [0, 0], zoom: 1, dpr: 1, width: 640, height: 360 },
      });
    const points = [at(0, 0), at(128, 0), at(0, 128), at(128, 128), at(64, 64)];
    const mapped = { points, indices: [0, 1, 2, 1, 3, 4, 4, 3, 2], width: 640, height: 360 };
    expect(tJunctionTriples(mapped)).toEqual([[4, 2, 1]]);
    const off = [...points.slice(0, 4), at(64, 64 + 2 ** -10)];
    expect(tJunctionTriples({ ...mapped, points: off })).toEqual([]);
    // The crack width is the read-back distance of v from the line ab: here the corner (1) of
    // the rectangle from its diagonal (0, 2), 96·48 / hypot(96, 48).
    const draw = { ...payload.draws[0]!, junctions: [1, 0, 2] };
    const one = { ...payload, draws: [draw] };
    const check = modelCheck(one, emulatedReadback(one));
    expect(check.junctions).toBe(1);
    expect(check.maxCrackWidth).toBeCloseTo((96 * 48) / Math.hypot(96, 48), 3);
    expect(check.maxCrackDraw).toBe(draw.id);
  });

  it('E3-U5: the named subset is the named rows of C1, C3, C5, C6, C9 and C12', () => {
    const named = (id: string) => isNamedReadbackCase({ id });
    expect(named('C1/s01-I/T0/z0.01-d1/center/k0')).toBe(true);
    expect(named('C9/k01/T0/z0.01-d1/center/k0')).toBe(true);
    expect(named('C6/s01-I/T0/z0.01-d1/partial/k0')).toBe(true);
    expect(named('C9/g0150/T1/z0.01-d1/center/k0')).toBe(false);
    expect(named('C2/g0000/T7/z0.01-d1/center/k0')).toBe(false);
    expect(named('C4/n01/T0/z0.01-d1/center/k0')).toBe(false);
  });
});
