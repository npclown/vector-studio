import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import { physicalSize } from '../../apps/playground/src/viz-v4-a08-cases.js';
import type {
  VizV4CorpusApi,
  VizV4RenderResult,
} from '../../apps/playground/src/viz-v4-a08-corpus.js';
import { encodeRleBase64 } from '../geometry/coverage-oracle/rle.js';
import {
  a04FreezeRecorded,
  caseInput,
  headedStatus,
  type ExpectedEntry,
  VIZ_V4_VARIANTS,
  variantQuery,
  type VizV4Variant,
} from '../visual/viz-v4/cases.js';
import { A08_DPRS, a08Subset, summarizeA08Subset } from '../visual/viz-v4/subset.js';

declare global {
  interface Window {
    __vectorStudioVizV4: VizV4CorpusApi;
  }
}

// V-4 unit VZ4-U1 (docs/plans/viz-v4-a08-corpus-contract.md, sections 4 and 6): the A08 headed
// corpus capture, in Chrome and Edge, for the three variants at DPR 1, 1.5, 2 and 3. It renders
// every subset case of the DPR on the page, asserts the capture identity (one frame and one
// prepare per capture, triangle totals equal to the draw record, capture size equal to the case's
// physical size), assigns each case its section 4.4 status, and writes the captures for the
// offline runner (VZ4-U2). It asserts completeness only (VZ4-A3); no gate is evaluated here.
// It refuses before the E3 corpus freeze record (E3 section 5.5). Manual, never CI:
//
//   pnpm test:gpu:viz-v4   (tooling/run-viz-v4-gpu.mjs: one run id, dist revision check)
//
// Each test writes artifacts/viz-v4-a08/<run>/<project>/<variant>/dpr<D>/ with meta.json,
// observations.ndjson (one line per case: status, reason, identity fields, notices, mesh calls,
// the red channel and the counts as O02 RLE) and UNVERIFIED.txt. Every run is PRE-FREEZE until
// C03-C05 are complete (section 1.2), and precision stays UNVERIFIED until A04 evidence exists.

test.use({ trace: 'off' });

const root = path.resolve(import.meta.dirname, '../..');
// `pnpm test:gpu:viz-v4` (tooling/run-viz-v4-gpu.mjs) sets one VIZ_V4_RUN_ID for the whole run,
// so both browsers write under one run directory even when Playwright restarts its worker.
const runRoot = path.resolve(
  process.env.VIZ_V4_OUTPUT_DIR ?? 'artifacts/viz-v4-a08',
  process.env.VIZ_V4_RUN_ID ??
    `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);
const wasmPath = path.resolve(
  process.env.VECTOR_STUDIO_GEOMETRY_WASM ??
    '.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);
const expectedPath = path.join(root, 'tests/visual/viz-v4/a08-expected-status.json');
const subset = a08Subset();

type Expected = Readonly<{
  subsetKeysSha256: string;
  wasmSha256: string;
  statuses: Record<string, Record<VizV4Variant, ExpectedEntry>>;
}>;

for (const variant of VIZ_V4_VARIANTS) {
  for (const dpr of A08_DPRS) {
    test(`A08 corpus ${variant} dpr ${String(dpr)}`, async ({ browser, page }, info) => {
      test.setTimeout(3_600_000);
      test.skip(
        !a04FreezeRecorded(root),
        'E3 section 5.5: no kernel run on corpus cases before the a04-corpus/v1 freeze record',
      );
      expect(existsSync(expectedPath), 'run pnpm viz-v4:expected first (section 5.1)').toBe(true);
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected;
      expect(expected.subsetKeysSha256).toBe(summarizeA08Subset(subset).keysSha256);
      const wasmBytes = new Uint8Array(readFileSync(wasmPath));
      const wasmSha256 = createHash('sha256').update(wasmBytes).digest('hex');
      expect(wasmSha256, 'the expected statuses were taken on another WASM').toBe(
        expected.wasmSha256,
      );
      const cases = subset.filter((c) => c.dpr === dpr);
      // VZ4-A3: the expected list covers exactly the subset.
      expect(Object.keys(expected.statuses).sort()).toEqual(subset.map((c) => c.key).sort());

      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const { samples, fringe } = variantQuery(variant);
      await page.goto(
        `/viz-v4-a08-corpus.html?samples=${String(samples)}&fringe=${fringe}&dpr=${String(dpr)}`,
      );
      await page.waitForFunction(() => window.__vectorStudioVizV4 !== undefined, undefined, {
        timeout: 60_000,
      });
      const ready = await page.evaluate(() => window.__vectorStudioVizV4.ready);
      // VZ4-A1: the page runs only with the E10 hooks; initialization fails otherwise.
      expect(ready.supported, String(ready.reason)).toBe(true);
      expect(ready.wasmSha256).toBe(wasmSha256);

      const out = path.join(runRoot, info.project.name, variant, `dpr${String(dpr)}`);
      mkdirSync(out, { recursive: true });
      const observations = path.join(out, 'observations.ndjson');
      writeFileSync(observations, '');
      // Written first, so a run that stops early still carries its labels.
      writeFileSync(
        path.join(out, 'UNVERIFIED.txt'),
        'PRE-FREEZE: A08 evidence counts only after C03-C05 (V-4 section 1.2). Precision UNVERIFIED until A04 evidence.\n',
      );
      writeFileSync(
        path.join(out, 'meta.json'),
        `${JSON.stringify({ label: 'PRE-FREEZE', complete: false, variant, dpr }, null, 2)}\n`,
      );
      const physical = physicalSize(dpr);
      const seen = new Set<string>();
      // Section 15: a port `empty` on a centred named row is suspect (E3-PC11); listed for review.
      const portEmpty: string[] = [];
      const counts: Record<string, number> = {};
      const deviations: string[] = [];
      for (const c of cases) {
        const result: VizV4RenderResult = await page.evaluate(
          (input) => window.__vectorStudioVizV4.render(input),
          caseInput(c),
        );
        // Capture identity (E10 section 3.2, carried to VZ4-U1 by E10 section 14).
        expect(result.width, c.key).toBe(physical.width);
        expect(result.height, c.key).toBe(physical.height);
        expect(result.sampleCount, c.key).toBe(samples);
        expect(result.devicePixelRatio, c.key).toBe(dpr);
        expect(result.framesSubmittedDelta, c.key).toBe(1);
        expect(result.prepareSerialDelta, c.key).toBe(1);
        if (result.recordTriangles !== null && !Number.isNaN(result.recordTriangles))
          expect(result.meshTriangles, c.key).toBe(result.recordTriangles);
        const want = expected.statuses[c.key]![variant];
        const { status, reason } = headedStatus(result, want.calls);
        counts[status] = (counts[status] ?? 0) + 1;
        seen.add(result.key);
        if (reason === 'port-empty') portEmpty.push(c.key);
        if (want.status !== status)
          deviations.push(`${c.key}: expected ${want.status}, headed ${status} (${reason})`);
        const rgba = new Uint8Array(Buffer.from(result.rgbaBase64, 'base64'));
        const red = new Uint8Array(rgba.length / 4);
        let notGrey = 0;
        for (let i = 0; i < red.length; i += 1) {
          red[i] = rgba[i * 4]!;
          if (rgba[i * 4 + 1] !== red[i] || rgba[i * 4 + 2] !== red[i] || rgba[i * 4 + 3] !== 255)
            notGrey += 1;
        }
        const countBytes = Buffer.from(result.counts.base64, 'base64');
        const sampleCounts = new Uint16Array(
          countBytes.buffer,
          countBytes.byteOffset,
          countBytes.byteLength / 2,
        );
        appendFileSync(
          observations,
          `${JSON.stringify({
            key: c.key,
            a04Id: c.a04Id,
            part: c.part,
            gated: c.gated,
            status,
            reason,
            expected: want.status,
            width: result.width,
            height: result.height,
            sampleCount: result.sampleCount,
            devicePixelRatio: result.devicePixelRatio,
            meshTriangles: result.meshTriangles,
            record: result.record,
            notices: result.notices,
            meshCalls: result.meshCalls,
            notGreyPixels: notGrey,
            red: encodeRleBase64(red),
            counts: { samples: result.counts.samples, rle: encodeRleBase64(sampleCounts) },
          })}\n`,
        );
      }
      writeFileSync(
        path.join(out, 'meta.json'),
        `${JSON.stringify(
          {
            label: 'PRE-FREEZE',
            complete: true,
            contract: 'docs/plans/viz-v4-a08-corpus-contract.md',
            variant,
            dpr,
            browser: { project: info.project.name, version: browser.version() },
            adapter: ready.adapter,
            wasmSha256,
            subset: summarizeA08Subset(subset),
            cases: cases.length,
            statusCounts: counts,
            deviations,
            portEmpty,
            pageErrors,
          },
          null,
          2,
        )}\n`,
      );
      expect(pageErrors).toEqual([]);
      // VZ4-A3: every case of the DPR was rendered once and has exactly one status.
      expect([...seen].sort()).toEqual(cases.map((c) => c.key).sort());
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(cases.length);
    });
  }
}
