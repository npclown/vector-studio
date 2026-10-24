import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { E3A04ReadbackApi } from '../../apps/playground/src/e3-a04-readback.js';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import {
  modelCheck,
  perturbedReadback,
  READBACK_CASES,
  readbackPayload,
} from '../geometry/e3-a04/readback.js';

declare global {
  interface Window {
    __vectorStudioE3A04Readback: E3A04ReadbackApi;
  }
}

// D9 E3 unit E3-U4: the GPU model check of docs/plans/d9-e3-b4-precision-contract.md section 7.1
// (executable form in section 16), headed in Chrome and Edge. Node draws the readback cases
// through the product path on the release WASM, the page evaluates the shader's own mapping for
// every stored point, and every read-back position must lie within β(p) of p* (E3-A6). E3-PC12:
// the same check must fail when one read-back position is replaced by p* + 2β(p). Before the
// corpus freeze the cases are non-corpus cases only (section 16.2). Manual, never CI:
//
//   pnpm exec playwright test -c playwright.gpu.config.ts tests/gpu/e3-a04-readback.spec.ts
//
// Each project writes .tools/e3-a04-readback/<stamp>/<project>.json, which
// `pnpm e3-a04:run --gpu <chrome.json>,<edge.json>` attaches to the record.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E3_A04_READBACK_OUTPUT_DIR ?? '.tools/e3-a04-readback',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);
const wasmPath = path.resolve(
  process.env.VECTOR_STUDIO_GEOMETRY_WASM ??
    '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);

test('E3-U4 GPU model check and E3-PC12', async ({ browser, page }, info) => {
  test.setTimeout(300_000);
  const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasmPath)));
  const ports = {
    fill: await createFillMeshPort(module),
    stroke: await createStrokeMeshPort(module),
  };
  const payload = readbackPayload(READBACK_CASES, ports);
  expect(payload.draws.length, JSON.stringify(payload.skipped)).toBeGreaterThan(0);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(
    `/e3-a04-readback.html${process.env.E3_A04_READBACK_ALLOW_SOFTWARE === '1' ? '?allowSoftware=1' : ''}`,
  );
  const status = await page.evaluate(() => window.__vectorStudioE3A04Readback.ready);
  expect(status.supported, JSON.stringify(status)).toBe(true);
  const draws = payload.draws.map((d) => ({
    id: d.id,
    frame: d.frame,
    linear: d.linear,
    anchor: d.anchor,
    offsets: d.offsets,
  }));
  const readback = await page.evaluate(
    ({ shader, draws }) => window.__vectorStudioE3A04Readback.run(shader, draws),
    { shader: payload.shader, draws },
  );
  const result = { ...readback, adapter: status.adapter };
  const check = modelCheck(payload, result);
  // E3-PC12 on the real readback: the middle point of the first draw moved to p* + 2β.
  const pc12 = modelCheck(
    payload,
    perturbedReadback(payload, result, 0, Math.floor(payload.draws[0]!.expected.length / 2)),
  );

  mkdirSync(runRoot, { recursive: true });
  const record = {
    schema: 'e3-a04-gpu-check/v1',
    passed:
      check.passed && !pc12.passed && pageErrors.length === 0 && status.adapter.software !== true,
    browser: {
      project: info.project.name,
      version: browser.version(),
      launchFlags: ['--enable-unsafe-webgpu'],
      adapter: status.adapter,
    },
    shaderSha256: payload.shaderSha256,
    wasmSha256: createHash('sha256').update(readFileSync(wasmPath)).digest('hex'),
    cases: READBACK_CASES.map((c) => c.id),
    skipped: payload.skipped,
    draws: payload.draws.length,
    points: check.points,
    maxVertexRatio: check.maxVertexRatio,
    maxFeatureRatio: check.maxFeatureRatio,
    failures: check.failures.slice(0, 200),
    pc12: { rejected: !pc12.passed, failures: pc12.failures.slice(0, 5) },
    pageErrors,
  };
  writeFileSync(
    path.join(runRoot, `${info.project.name}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    {
      flag: 'wx',
    },
  );
  expect(pageErrors).toEqual([]);
  expect(check.failures.slice(0, 20)).toEqual([]);
  expect(pc12.passed).toBe(false);
});
