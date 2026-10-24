import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controlPorts, fan, meshFromTriangles, RECT } from './e3-a04/controls.js';
import { fill, polygon, rect } from './e3-a04/oracle-cases.js';
import {
  emulatedReadback,
  modelCheck,
  perturbedReadback,
  readbackPayload,
} from './e3-a04/readback.js';
import { combineGpuChecks, type GpuBrowserCheck } from './e3-a04/record.js';
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
});
