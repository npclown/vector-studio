import { expect, test } from '@playwright/test';

interface BrowserSnapshot {
  readonly capability: {
    readonly supported: boolean;
    readonly capabilities?: {
      readonly adapter: Record<string, string>;
      readonly limits: Record<string, number>;
    };
    readonly diagnostic?: { readonly code: string };
  };
  readonly diagnostics: readonly unknown[];
  readonly presentationFormat?: string;
  readonly state: string;
  readonly surfaceRevision: number;
  readonly surfaceSize?: {
    readonly physical: { readonly width: number; readonly height: number };
    readonly suspended: boolean;
  };
}

declare global {
  interface Window {
    __vectorStudioP0: {
      resize(width: number, height: number, devicePixelRatio: number): unknown;
      snapshot(): BrowserSnapshot;
    };
  }
}

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
