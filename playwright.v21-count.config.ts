import { defineConfig, devices } from '@playwright/test';

// V21-U1 (V-21 contract, section 4): the headless font-load counting spec. It serves the
// next-host production build (`pnpm build`) with `?bench=1&ui=1&doc=m9-v2`, registers the test
// font through `window.__e26Bench` (alone, and during the edit drag) and records the bench's
// text probe: each text-dom generation bump and the editor's split of the relayout it caused.
// Counts and main-thread times only, run by hand and not in CI. The editor projects only with a
// live renderer, so Chromium runs WebGPU on SwiftShader, as the M1 smoke project does; its
// submit times are SwiftShader's, not the reference GPU's.
//
// V21_CHROMIUM names a Chromium executable; without it Playwright's own Chromium runs. Records go
// to `test-results/v21-count/` (or V21_RESULTS_DIR).
const chromium = process.env.V21_CHROMIUM;

export default defineConfig({
  testDir: './tests/v21',
  testMatch: 'v21-count.spec.ts',
  outputDir: './test-results/v21',
  globalSetup: './tests/e26/setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 300_000,
  use: {
    baseURL: 'http://127.0.0.1:4196',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium-count',
      use: {
        ...devices['Desktop Chrome'],
        // The v2 window (tests/e26/scenarios.ts, M9_WINDOW).
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: 1,
        headless: true,
        launchOptions: {
          ...(chromium === undefined ? {} : { executablePath: chromium }),
          args: [
            '--enable-unsafe-webgpu',
            '--enable-unsafe-swiftshader',
            '--use-webgpu-adapter=swiftshader',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4196',
    url: 'http://127.0.0.1:4196',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
