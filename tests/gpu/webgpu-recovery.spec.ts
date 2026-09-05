import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import '../support/playground-api.js';

const lifecycleCodes = ['device-loss.detected', 'recovery.started', 'recovery.succeeded'] as const;

test('surfaces validation error and recovers once after deliberate device destruction', async ({
  browser,
  page,
}, testInfo) => {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceChanges = execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((entry) => entry !== '' && !entry.slice(3).startsWith('docs/evidence/p0.4a/'));
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await page.waitForFunction(
    () => window.__vectorStudioP0?.snapshot().statistics.framesPresented >= 1,
  );
  const before = await page.evaluate(() => window.__vectorStudioP0.snapshot());

  await page.evaluate(() => window.__vectorStudioP0.triggerValidationErrorForTesting());
  await page.waitForFunction(() =>
    window.__vectorStudioP0
      .snapshot()
      .diagnostics.some(({ code }) => code === 'validation.uncaptured-error'),
  );

  await page.evaluate(() => window.__vectorStudioP0.destroyDeviceForTesting());
  await page.waitForFunction(
    ({ generation, presented }) => {
      const snapshot = window.__vectorStudioP0.snapshot();
      return (
        snapshot.state === 'ready' &&
        snapshot.statistics.generation === generation + 1 &&
        snapshot.statistics.framesPresented > presented
      );
    },
    { generation: before.statistics.generation, presented: before.statistics.framesPresented },
  );

  const recovered = await page.evaluate(() => window.__vectorStudioP0.snapshot());
  const orderedLifecycle = recovered.diagnostics
    .filter(({ code }) => lifecycleCodes.includes(code as (typeof lifecycleCodes)[number]))
    .map(({ code, generation }) => ({ code, generation }));
  expect(orderedLifecycle).toEqual([
    { code: 'device-loss.detected', generation: before.statistics.generation },
    { code: 'recovery.started', generation: before.statistics.generation + 1 },
    { code: 'recovery.succeeded', generation: before.statistics.generation + 1 },
  ]);
  expect(recovered.statistics).toMatchObject({
    lifecycle: 'ready',
    generation: before.statistics.generation + 1,
    recoveryAttempts: 1,
    staleGenerationSubmissions: 0,
    pendingFrameCallbacks: 0,
    deviceListeners: 2,
    resources: { live: 4 },
  });
  expect(
    recovered.diagnostics.find(({ code }) => code === 'validation.uncaptured-error'),
  ).toMatchObject({
    generation: before.statistics.generation,
    context: { errorType: 'validation' },
  });
  expect(
    recovered.diagnostics.filter(({ code }) => code === 'validation.uncaptured-error'),
  ).toHaveLength(1);
  expect(pageErrors).toEqual([]);

  const evidenceDirectory = path.resolve('docs/evidence/p0.4a');
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    path.join(evidenceDirectory, `recovery-${testInfo.project.name}.json`),
    `${JSON.stringify(
      {
        timestampUtc: new Date().toISOString(),
        command: 'pnpm test:gpu',
        revision,
        sourceWorktree: sourceChanges.length === 0 ? 'clean' : 'dirty',
        headed: true,
        operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
        browser: {
          channel: testInfo.project.name,
          version: browser.version(),
        },
        adapter: before.capability.capabilities?.adapter ?? {},
        before: before.statistics,
        recovered: recovered.statistics,
        observedDiagnostics: recovered.diagnostics.filter(({ code }) =>
          ['validation.uncaptured-error', ...lifecycleCodes].includes(code ?? ''),
        ),
        pageErrors,
      },
      null,
      2,
    )}\n`,
  );

  await page.locator('#webgpu-surface').screenshot({
    path: `docs/evidence/p0.4a/recovered-${testInfo.project.name}.png`,
  });
});
