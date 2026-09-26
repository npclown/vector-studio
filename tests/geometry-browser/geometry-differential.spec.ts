import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { BrowserDifferentialSummary } from './main.js';

test('release WASM agrees with the independent P2 oracle', async ({
  page,
  browserName,
}, testInfo) => {
  const expectedSha256 = process.env.P2_WASM_SHA256;
  if (!expectedSha256) throw new Error('P2_WASM_SHA256 is required');
  const browserVersion = page.context().browser()?.version() ?? 'unavailable';
  try {
    if (browserVersion === 'unavailable')
      throw new Error('Playwright did not report a browser version');
    await page.goto('/');
    const summary = await page.evaluate(
      (hash) => window.runP2GeometryDifferential(hash),
      expectedSha256,
    );
    expect(summary.corpusCount).toBe(10_000);
    expect(summary.positiveControls.rejected).toBe(summary.positiveControls.attempted);
    expect(summary.exactSizeRetries).toBeGreaterThan(0);
    const evidence = {
      ...summary,
      project: testInfo.project.name,
      browserName,
      browserVersion,
    } satisfies BrowserDifferentialSummary & {
      project: string;
      browserName: string;
      browserVersion: string;
    };
    const body = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(testInfo.outputPath('geometry-differential.json'), body, { flag: 'wx' });
    await testInfo.attach('geometry-differential-summary', {
      body,
      contentType: 'application/json',
    });
  } catch (error) {
    const failure = {
      scenario: 'p2-geometry/v1',
      disposition: 'FAIL',
      project: testInfo.project.name,
      browserName,
      browserVersion,
      wasmSha256: expectedSha256.toLowerCase(),
      error: error instanceof Error ? error.message : String(error),
    };
    const body = Buffer.from(`${JSON.stringify(failure, null, 2)}\n`);
    await writeFile(testInfo.outputPath('geometry-differential-failure.json'), body, {
      flag: 'wx',
    });
    await testInfo.attach('geometry-differential-failure', {
      body,
      contentType: 'application/json',
    });
    throw error;
  }
});
