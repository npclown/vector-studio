import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { E3A04ReadbackApi } from '../../apps/playground/src/e3-a04-readback.js';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import type { A04Case } from '../../packages/geometry-reference/src/a04-region.js';
import { jointPartners } from '../geometry/e3-a04/harness.js';
import {
  modelCheck,
  namedReadbackCases,
  perturbedReadback,
  READBACK_CASES,
  readbackPayload,
  type ModelCheck,
  type ReadbackPayload,
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
// the same check must fail when one read-back position is replaced by p* + 2β(p). The cases are
// the non-corpus cases of section 16.2 and, after the freeze, the named subset of section 7.1
// (E3-U5, section 19), in chunks. Clipped draws also get the strip coverage readback of
// E3-Q11 (a), and T-junction crack widths are reported (E3-Q10 (b)). Manual, never CI:
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

/** Draws per page call: bounds the payload and the page's buffers. */
const CHUNK = 64;

function* chunks(cases: Iterable<A04Case>): Generator<A04Case[]> {
  let chunk: A04Case[] = [];
  for (const kase of cases) {
    chunk.push(kase);
    if (chunk.length === CHUNK) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length > 0) yield chunk;
}

function* allCases(): Generator<A04Case> {
  yield* READBACK_CASES;
  if (process.env.E3_A04_READBACK_NON_CORPUS_ONLY !== '1') yield* namedReadbackCases();
}

test('E3-U4 GPU model check and E3-PC12', async ({ browser, page }, info) => {
  test.setTimeout(4 * 60 * 60_000);
  const module = await WebAssembly.compile(new Uint8Array(readFileSync(wasmPath)));
  const ports = {
    fill: await createFillMeshPort(module),
    stroke: await createStrokeMeshPort(module),
  };
  const partners = jointPartners();

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(
    `/e3-a04-readback.html${process.env.E3_A04_READBACK_ALLOW_SOFTWARE === '1' ? '?allowSoftware=1' : ''}`,
  );
  const status = await page.evaluate(() => window.__vectorStudioE3A04Readback.ready);
  expect(status.supported, JSON.stringify(status)).toBe(true);

  const ids: string[] = [];
  const skipped: { id: string; kind: string }[] = [];
  const skippedKinds: Record<string, number> = {};
  const failures: string[] = [];
  let shaderSha256 = '';
  let drawCount = 0;
  let points = 0;
  let maxVertexRatio = 0;
  let maxFeatureRatio = 0;
  let junctions = 0;
  let maxCrackWidth = 0;
  let maxCrackDraw: string | null = null;
  const clip = { draws: 0, unmeasurable: 0, compared: 0, excluded: 0, mismatches: 0 };
  const clipFailures: ModelCheck['clipFailures'][number][] = [];
  let pc12: ModelCheck | null = null;
  for (const chunk of chunks(allCases())) {
    for (const kase of chunk) ids.push(String(kase.id));
    const payload: ReadbackPayload = readbackPayload(chunk, ports, partners);
    shaderSha256 = payload.shaderSha256;
    for (const s of payload.skipped) {
      const kind = s.kind.startsWith('error') ? 'error' : s.kind;
      skippedKinds[kind] = (skippedKinds[kind] ?? 0) + 1;
      if (skipped.length < 200) skipped.push(s);
    }
    if (payload.draws.length === 0) continue;
    const draws = payload.draws.map((d) => ({
      id: d.id,
      frame: d.frame,
      linear: d.linear,
      anchor: d.anchor,
      offsets: d.offsets,
      ...(d.clip ? { indices: d.indices } : {}),
    }));
    const readback = await page.evaluate(
      ({ shader, draws }) => window.__vectorStudioE3A04Readback.run(shader, draws),
      { shader: payload.shader, draws },
    );
    const result = { ...readback, adapter: status.adapter };
    const check = modelCheck(payload, result);
    // E3-PC12 on the real readback: the middle point of the first draw moved to p* + 2β.
    pc12 ??= modelCheck(
      payload,
      perturbedReadback(payload, result, 0, Math.floor(payload.draws[0]!.expected.length / 2)),
    );
    drawCount += payload.draws.length;
    points += check.points;
    maxVertexRatio = Math.max(maxVertexRatio, check.maxVertexRatio);
    maxFeatureRatio = Math.max(maxFeatureRatio, check.maxFeatureRatio);
    junctions += check.junctions;
    if (check.maxCrackWidth > maxCrackWidth) {
      maxCrackWidth = check.maxCrackWidth;
      maxCrackDraw = check.maxCrackDraw;
    }
    clip.draws += check.clip.draws;
    clip.unmeasurable += check.clip.unmeasurable;
    clip.compared += check.clip.compared;
    clip.excluded += check.clip.excluded;
    clip.mismatches += check.clip.mismatches;
    clipFailures.push(...check.clipFailures);
    for (const f of check.failures) if (failures.length < 200) failures.push(f);
  }
  expect(drawCount, JSON.stringify(skipped.slice(0, 20))).toBeGreaterThan(0);

  mkdirSync(runRoot, { recursive: true });
  const record = {
    schema: 'e3-a04-gpu-check/v1',
    passed:
      failures.length === 0 &&
      (skippedKinds.error ?? 0) === 0 &&
      pc12 !== null &&
      !pc12.passed &&
      pageErrors.length === 0 &&
      status.adapter.software !== true,
    browser: {
      project: info.project.name,
      version: browser.version(),
      launchFlags: ['--enable-unsafe-webgpu'],
      adapter: status.adapter,
    },
    shaderSha256,
    wasmSha256: createHash('sha256').update(readFileSync(wasmPath)).digest('hex'),
    subset: {
      nonCorpus: READBACK_CASES.map((c) => c.id),
      corpus:
        process.env.E3_A04_READBACK_NON_CORPUS_ONLY === '1'
          ? null
          : 'named rows of C1, C3, C5, C6, C9 and C12 at every transform and pair',
      cases: ids.length,
      idsSha256: createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex'),
    },
    skippedKinds,
    skipped,
    draws: drawCount,
    points,
    maxVertexRatio,
    maxFeatureRatio,
    crack: { junctions, maxWidth: maxCrackWidth, maxWidthDraw: maxCrackDraw },
    clip: { ...clip, failedDraws: clipFailures.length, failures: clipFailures.slice(0, 500) },
    failures,
    pc12: { rejected: pc12 !== null && !pc12.passed, failures: pc12?.failures.slice(0, 5) ?? [] },
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
  expect(skipped.filter((s) => s.kind.startsWith('error'))).toEqual([]);
  expect(failures.slice(0, 20)).toEqual([]);
  expect(pc12?.passed).toBe(false);
});
