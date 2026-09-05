import { expect, test } from '@playwright/test';
import '../support/playground-api.js';

test('initializes and resizes a real WebGPU canvas', async ({ page, browserName }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.waitForFunction(() => window.__vectorStudioP0 !== undefined);

  const initial = await page.evaluate(() => window.__vectorStudioP0.snapshot());
  expect(initial.capability, `${browserName}: ${JSON.stringify(initial)}`).toMatchObject({
    supported: true,
  });
  expect(initial.state).toBe('ready');
  expect(initial.presentationFormat).toMatch(/^(?:bgra8unorm|rgba8unorm)$/u);
  expect(initial.surfaceSize).toMatchObject({
    physical: { width: 640, height: 360 },
    suspended: false,
  });
  expect(initial.capability.capabilities?.limits.maxTextureDimension2D).toBeGreaterThan(0);
  expect([1, 4]).toContain(initial.capability.capabilities?.sampleCount);
  await page.waitForFunction(
    () => window.__vectorStudioP0.snapshot().statistics.framesPresented === 1,
  );
  const presented = await page.evaluate(() => window.__vectorStudioP0.snapshot());
  expect(presented.statistics).toMatchObject({
    framesSubmitted: 1,
    framesPresented: 1,
    shaderModulesCreated: 1,
  });
  expect(presented.statistics.pipelinesCreated).toBeGreaterThanOrEqual(1);

  const resized = await page.evaluate(() => {
    window.__vectorStudioP0.resize(320, 180, 2);
    return window.__vectorStudioP0.snapshot();
  });
  expect(resized.surfaceSize).toMatchObject({
    physical: { width: 640, height: 360 },
    suspended: false,
  });

  const suspended = await page.evaluate(() => {
    window.__vectorStudioP0.resize(0, 180, 2);
    return window.__vectorStudioP0.snapshot();
  });
  expect(suspended.state).toBe('ready');
  expect(suspended.surfaceSize).toMatchObject({
    physical: { width: 0, height: 360 },
    suspended: true,
  });
  expect(pageErrors).toEqual([]);
});

test('coalesces invalidation, remains idle, and renders the foundation scene', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.waitForFunction(
    () => window.__vectorStudioP0?.snapshot().statistics.framesPresented === 1,
  );

  const before = await page.evaluate(() => window.__vectorStudioP0.snapshot().statistics);
  await page.evaluate(() => {
    for (let index = 0; index < 100; index += 1) {
      window.__vectorStudioP0.invalidate();
    }
  });
  await page.waitForFunction(
    (submitted) => window.__vectorStudioP0.snapshot().statistics.framesSubmitted === submitted + 1,
    before.framesSubmitted,
  );
  await page.waitForTimeout(250);

  const afterIdle = await page.evaluate(() => window.__vectorStudioP0.snapshot().statistics);
  expect(afterIdle.framesSubmitted - before.framesSubmitted).toBe(1);
  expect(afterIdle.invalidationsRequested - before.invalidationsRequested).toBe(100);
  expect(afterIdle.pendingFrameCallbacks).toBe(0);
  expect(afterIdle.pipelinesCreated).toBe(before.pipelinesCreated);
  expect(afterIdle.shaderModulesCreated).toBe(before.shaderModulesCreated);

  await page.locator('#webgpu-surface').screenshot({
    path: testInfo.outputPath('foundation.png'),
  });
});

test('continuous mode submits until explicitly disabled and disposal cancels RAF', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(
    () => window.__vectorStudioP0?.snapshot().statistics.framesPresented === 1,
  );
  const baseline = await page.evaluate(() => {
    window.__vectorStudioP0.setMode('continuous');
    return window.__vectorStudioP0.snapshot().statistics.framesSubmitted;
  });
  await page.waitForFunction(
    (submitted) => window.__vectorStudioP0.snapshot().statistics.framesSubmitted >= submitted + 3,
    baseline,
  );
  await page.evaluate(() => window.__vectorStudioP0.setMode('on-demand'));
  await page.waitForTimeout(100);
  const stopped = await page.evaluate(() => window.__vectorStudioP0.snapshot().statistics);
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => window.__vectorStudioP0.snapshot().statistics.framesSubmitted),
  ).toBe(stopped.framesSubmitted);

  await page.evaluate(() => window.__vectorStudioP0.dispose());
  expect(
    await page.evaluate(() => window.__vectorStudioP0.snapshot().statistics.pendingFrameCallbacks),
  ).toBe(0);
});

test('dashboard controls reflect measurement, recovery, disposal, and a fresh backend', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(
    () => window.__vectorStudioP0?.snapshot().statistics.framesPresented === 1,
  );

  await expect(page.locator('#backend-instance')).toHaveText('1');
  await expect(page.locator('#backend-state')).toHaveText('ready');
  await expect(page.locator('#backend-generation')).toHaveText('1');
  await expect(page.locator('#adapter-identity')).not.toHaveText('unavailable');
  await expect(page.locator('#surface-size')).toContainText('640×360 @ DPR 1');
  await expect(page.locator('#sample-count')).toHaveText(/^[14]$/u);

  const beforeBurst = await page.evaluate(
    () => window.__vectorStudioP0.snapshot().statistics.framesSubmitted,
  );
  await page.locator('#invalidate-burst').click();
  await page.waitForFunction(
    (submitted) => window.__vectorStudioP0.snapshot().statistics.framesSubmitted === submitted + 1,
    beforeBurst,
  );

  await page.locator('#measurement-toggle').click();
  await page.locator('#continuous-toggle').click();
  await page.waitForFunction(
    () => window.__vectorStudioP0.getFrameMeasurements().encodeAndSubmitMs.length >= 3,
  );
  await page.locator('#continuous-toggle').click();
  await page.locator('#measurement-toggle').click();
  await expect(page.locator('#timing-summary')).toContainText('stopped · frame n=');
  await expect(page.locator('#timing-summary')).not.toContainText('frame n=0');

  await page.locator('#device-loss').click();
  await page.waitForFunction(() => {
    const snapshot = window.__vectorStudioP0.snapshot();
    return snapshot.state === 'ready' && snapshot.statistics.generation === 2;
  });
  await page.locator('#refresh-dashboard').click();
  await expect(page.locator('#backend-generation')).toHaveText('2');
  await expect(page.locator('#adapter-identity')).not.toHaveText('unavailable');
  await expect(page.locator('#sample-count')).toHaveText(/^[14]$/u);
  await expect(page.locator('#diagnostics-list')).toContainText('recovery.succeeded');

  await page.locator('#dispose-backend').click();
  await expect(page.locator('#backend-state')).toHaveText('disposed');
  await page.locator('#reinitialize-backend').click();
  await page.waitForFunction(() => {
    const snapshot = window.__vectorStudioP0.snapshot();
    return snapshot.backendInstance === 2 && snapshot.state === 'ready';
  });
  await expect(page.locator('#backend-instance')).toHaveText('2');
  await expect(page.locator('#backend-generation')).toHaveText('1');
  await expect(page.locator('#backend-state')).toHaveText('ready');

  await page.evaluate(() => {
    const control = document.querySelector<HTMLButtonElement>('#reinitialize-backend');
    if (!control) throw new Error('Reinitialize control is missing.');
    control.click();
    control.click();
  });
  await page.waitForFunction(() => {
    const snapshot = window.__vectorStudioP0.snapshot();
    return snapshot.backendInstance === 3 && snapshot.state === 'ready';
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__vectorStudioP0.snapshot().backendInstance)).toBe(3);
});

test('resize storm control applies 120 deterministic changes and restores the reference surface', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__vectorStudioP0?.snapshot().state === 'ready');
  const revision = await page.evaluate(() => window.__vectorStudioP0.snapshot().surfaceRevision);

  await page.locator('#resize-storm').click();
  await expect(page.locator('#resize-storm')).toBeDisabled();
  await expect(page.locator('#resize-storm')).toBeEnabled({ timeout: 5000 });
  const snapshot = await page.evaluate(() => window.__vectorStudioP0.snapshot());
  expect(snapshot.surfaceRevision).toBeGreaterThanOrEqual(revision + 120);
  expect(snapshot.surfaceSize).toMatchObject({
    physical: { width: 640, height: 360 },
    devicePixelRatio: 1,
    suspended: false,
  });
  await expect(page.locator('#surface-size')).toContainText('640×360 @ DPR 1');
});
