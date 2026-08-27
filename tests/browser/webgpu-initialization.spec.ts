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
    path: `docs/evidence/p0.3/foundation-${testInfo.project.name}.png`,
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
