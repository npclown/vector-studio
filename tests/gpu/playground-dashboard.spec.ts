import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import {
  captureEvidenceScreenshot,
  evidenceSource,
  writeEvidenceJson,
} from '../support/evidence-output.js';
import '../support/playground-api.js';

test('captures a functional dashboard smoke artifact', async ({ browser, page }, testInfo) => {
  const source = evidenceSource(testInfo);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__vectorStudioP0 !== undefined);
  await page.evaluate(() => window.__vectorStudioP0.waitForInitializationMilestones());

  await page.locator('#measurement-toggle').click();
  await page.locator('#continuous-toggle').click();
  await page.waitForFunction(
    () => window.__vectorStudioP0.getFrameMeasurements().frameIntervalsMs.length >= 5,
  );
  await page.locator('#continuous-toggle').click();
  await page.locator('#measurement-toggle').click();
  await page.locator('#validation-error').click();
  await page.waitForFunction(() =>
    window.__vectorStudioP0
      .snapshot()
      .diagnostics.some(({ code }) => code === 'validation.uncaptured-error'),
  );
  await page.locator('#refresh-dashboard').click();

  const snapshot = await page.evaluate(() => window.__vectorStudioP0.snapshot());
  const timing = await page.evaluate(() => window.__vectorStudioP0.getInitializationTiming());
  await expect(page.locator('#backend-state')).toHaveText('ready');
  await expect(page.locator('#adapter-identity')).not.toHaveText('unavailable');
  await expect(page.locator('#surface-size')).toContainText('640');
  await expect(page.locator('#sample-count')).toHaveText(/^[14]$/u);
  await expect(page.locator('#frame-counters')).toContainText('submitted');
  await expect(page.locator('#timing-summary')).toContainText('stopped');
  await expect(page.locator('#diagnostics-list')).toContainText('validation.uncaptured-error');
  expect(pageErrors).toEqual([]);

  const screenshotName = `dashboard-${testInfo.project.name}.png`;
  const screenshot = await captureEvidenceScreenshot(
    testInfo,
    screenshotName,
    page.locator('#app'),
  );
  writeEvidenceJson(testInfo, `dashboard-${testInfo.project.name}.json`, {
    timestampUtc: new Date().toISOString(),
    command: 'pnpm test:gpu',
    ...source,
    headed: true,
    operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
    browser: {
      channel: testInfo.project.name,
      version: browser.version(),
    },
    adapter: snapshot.capability.capabilities?.adapter ?? {},
    screenshot: path.basename(screenshot),
    snapshot,
    initializationTiming: timing,
    pageErrors,
  });
});
