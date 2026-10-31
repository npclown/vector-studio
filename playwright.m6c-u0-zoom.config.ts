import { defineConfig, devices } from '@playwright/test';

// M6c-U0 (MVP M6c contract, section 3; docs/evidence/m6c-u0/README.md): text-dom's cancelling of
// the layout zoom, end to end on the next-host `?fixture=text` page. The spec launches its own
// Chromium under `--force-device-scale-factor` 1.25 and 1.875 (a real device scale, which lays
// the page out at that zoom, unlike CDP emulation) and compares the port's layouts with the same
// port's at DPR 1, within 1/64 px. Headless; needs `pnpm build` (the next-host production build)
// but not the geometry kernel WASM. M6C_U0_ZOOM_CHROMIUM names a Chromium executable instead of
// Playwright's own build. Not in CI (no next-host headed spec is).
const executablePath = process.env.M6C_U0_ZOOM_CHROMIUM;

export default defineConfig({
  testDir: './tests/m6c-u0-zoom',
  outputDir: './test-results/m6c-u0-zoom',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4186',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-headless',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        headless: true,
        launchOptions: executablePath === undefined ? {} : { executablePath },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4186',
      url: 'http://127.0.0.1:4186',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
