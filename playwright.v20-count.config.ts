import { defineConfig, devices } from '@playwright/test';

// V20-U1 (V-20 contract, section 5): the headless render-counting spec. It serves the next-host
// production build (`pnpm build`) with `?bench=1&ui=1`, drives the camera and the edit drag
// through `window.__e26Bench` without waiting for the renderer, and records how often the right
// column's components render per step from `@vector-studio/ui`'s render probe. Counts only: no
// timing claim, and the renderer may fail to start (WebGPU is not needed for the counts).
//
// V20_CHROMIUM names a Chromium executable; without it Playwright's own Chromium runs. Records go
// to `test-results/v20-count/` (or V20_RESULTS_DIR).
const chromium = process.env.V20_CHROMIUM;

export default defineConfig({
  testDir: './tests/v20',
  testMatch: 'v20-render-count.spec.ts',
  outputDir: './test-results/v20',
  globalSetup: './tests/e26/setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 300_000,
  use: {
    baseURL: 'http://127.0.0.1:4195',
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
        launchOptions: chromium === undefined ? {} : { executablePath: chromium },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4195',
    url: 'http://127.0.0.1:4195',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
