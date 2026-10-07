import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeInput } from '../position-certificate/corpus.js';
import { buildO02 } from '../../support/p3-o02-build.js';
import { rational, type Rational } from '../rounded-fill/exact.js';
import {
  buildO02MetricsFiles,
  loadO02Capture,
  type O02CaptureCrop,
  type O02CaptureRow,
} from './capture-schema-o02.js';
import type { Crop } from './crop.js';
import type { ExteriorMesh } from './exterior.js';
import { distanceFlags, WITHIN_1, type DrawStats } from './metrics-o02.js';
import { coverageOracle } from './oracle.js';
import type { CoverageRowGeometry } from './positions.js';
import { encodeRleBase64, sampleSha256 } from './rle.js';
import { ruleAtPixel, ruleContext } from './rule.js';
import { O02_DPRS, o02Variants, variantStatus } from './variants.js';

/**
 * P3.1o O02 metrics document self-test on a synthetic ideal capture of all 596 variants (about five
 * minutes). Gated by P3_O02_SELFTEST=1 and run with
 * `P3_O02_SELFTEST=1 node node_modules/vitest/vitest.mjs run --config vitest.p3-o02.config.ts`.
 * The ideal capture writes round(255 rule) at 1x and 4x and a count of exactly 1.0 everywhere, so
 * the verdict must be PASS.
 */

const selftest = process.env.P3_O02_SELFTEST === '1';

function idealPasses(geometry: CoverageRowGeometry, crop: Crop, mesh: ExteriorMesh) {
  const context = ruleContext(geometry, mesh.sectors);
  const total = crop.w * crop.h;
  const main = new Uint8Array(total);
  const flags = distanceFlags(geometry, crop);
  const oracle = coverageOracle(geometry, crop);
  for (let index = 0; index < total; index += 1) {
    const i = crop.x + (index % crop.w);
    const j = crop.y + Math.floor(index / crop.w);
    let value: Rational;
    if (flags[index]! & WITHIN_1) value = ruleAtPixel(context, i, j);
    else value = rational(oracle.inside[index] ? 1n : 0n);
    // Round half up to unorm8.
    main[index] = Number((2n * 255n * value.n + value.d) / (2n * value.d));
  }
  const count1 = new Uint16Array(total).fill(0x3c00);
  const count4 = new Uint16Array(4 * total).fill(0x3c00);
  return { main, count1, count4 };
}

describe.skipIf(!selftest)('P3.1o O02 capture reader and metrics document', () => {
  it('writes deterministic metrics with a PASS verdict for an ideal capture', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'p3-o02-'));
    try {
      const variants = o02Variants();
      const parts: { path: string; sha256: string; dpr: number }[] = [];
      for (const dpr of O02_DPRS) {
        const rows: O02CaptureRow[] = [];
        for (const variant of variants.filter((v) => v.dpr === dpr)) {
          const status = variantStatus(variant.input);
          let crops: O02CaptureCrop[] = [];
          let drawStats: DrawStats | undefined;
          if (status.status === 'RENDERED') {
            drawStats = buildO02(status.exterior, status.crop).stats;
            const { main, count1, count4 } = idealPasses(
              status.geometry,
              status.crop,
              status.exterior,
            );
            const entry = (
              pass: 'main' | 'count',
              sampleCount: number,
              samples: Uint8Array | Uint16Array,
            ): O02CaptureCrop => ({
              pass,
              sampleCount,
              format: pass === 'main' ? 'rgba8unorm' : 'rgba16float',
              channels: pass === 'count' && sampleCount === 4 ? 'RGBA' : 'R',
              rleBase64: encodeRleBase64(samples),
              sha256: sampleSha256(samples),
            });
            crops = [
              entry('main', 1, main),
              entry('main', 4, main),
              entry('count', 1, count1),
              entry('count', 4, count4),
            ];
          }
          rows.push({
            rowIndex: variant.rowIndex,
            id: variant.id,
            kind: variant.kind,
            dpr: variant.dpr,
            identity: variant.identity,
            status: status.status,
            reason: status.reason,
            input: encodeInput(variant.input),
            width: variant.input.width,
            height: variant.input.height,
            crop: status.crop,
            origin: status.crop === null ? null : [status.crop.x, status.crop.y],
            crops,
            ...(drawStats ? { drawStats } : {}),
          });
        }
        // Split each DPR into two parts by row range.
        for (const [index, slice] of [rows.slice(0, 70), rows.slice(70)].entries()) {
          const file = `capture-dpr${dpr}-${index}.json`;
          const body = JSON.stringify({
            schema: 'p3-o02-capture-v1',
            contract: { commit: 'test', notePath: 'note', noteSha256AtCommit: 'sha' },
            dpr,
            rows: slice,
          });
          writeFileSync(path.join(directory, file), body);
          parts.push({ path: file, sha256: sampleSha256(Buffer.from(body, 'utf8')), dpr });
        }
      }
      writeFileSync(
        path.join(directory, 'capture-index.json'),
        JSON.stringify({ schema: 'p3-o02-capture-index-v1', parts }),
      );
      const files = buildO02MetricsFiles(directory);
      expect(files.map(([file]) => file)).toEqual(['metrics.json', 'metrics-dpr3.json']);
      const document = JSON.parse(files[0]![1]) as {
        verdict: {
          result: string;
          failures: unknown[];
          inconclusive: unknown[];
          g3FailingVariants: number;
          g3FailingVariantsWithoutClipOutside: number;
        };
        counts: Record<string, Record<string, number>>;
        deficitPixels: { main1: number }[];
        rows: {
          metrics: unknown;
          draw: {
            clipOutside: boolean;
            fragmentFeatureEvaluations: { value: string; sharedEdgeCenters: number };
          } | null;
        }[];
      };
      expect(document.verdict.failures).toEqual([]);
      expect(document.verdict.result).toBe('PASS');
      expect(document.verdict.g3FailingVariants).toBe(0);
      expect(document.verdict.g3FailingVariantsWithoutClipOutside).toBe(0);
      const drawn = document.rows.flatMap((row) => (row.draw ? [row.draw] : []));
      expect(drawn.length).toBe(3 * 143);
      expect(drawn.some((draw) => draw.clipOutside)).toBe(true);
      expect(drawn.some((draw) => !draw.clipOutside)).toBe(true);
      expect(drawn.every((draw) => BigInt(draw.fragmentFeatureEvaluations.value) > 0n)).toBe(true);
      expect(document.counts['1.5']!.RENDERED).toBe(143);
      expect(document.deficitPixels.length).toBe(8);
      expect(document.rows.length).toBe(447);
      expect(files[0]![1].endsWith('}\n')).toBe(true);
      // Byte-identical recomputation, and the acceptance metrics do not depend on DPR 3 parts.
      expect(buildO02MetricsFiles(directory)).toEqual(files);
      for (const part of parts.filter((p) => p.dpr === 3)) rmSync(path.join(directory, part.path));
      const without = buildO02MetricsFiles(directory);
      expect(without.length).toBe(1);
      expect(without[0]![1]).toBe(files[0]![1]);
      expect(loadO02Capture(directory).dprs.map((entry) => entry.dpr)).toEqual([1, 1.5, 2]);
      const dpr3 = JSON.parse(files[1]![1]) as { verdict: unknown };
      expect(dpr3.verdict).toBe('N/A:observation');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 1_200_000);
});
