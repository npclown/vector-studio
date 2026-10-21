import { defineConfig, devices } from '@playwright/test';

// AL-OB5 browser leg (docs/plans/p3-al-ob5-workload-scenario-proposal.md section 3.1), placed
// as AL-S2's configuration: installed stable Chrome, then Edge; headed in both profiles; one
// worker; a fresh page per repetition; no tracing, video or DevTools.
const profile = process.env.P3_AL_OB5_PROFILE;
if ((profile !== 'functional' && profile !== 'reference') || !process.env.P3_AL_OB5_RUN_DIR) {
  throw new Error('Run through pnpm benchmark:p3-al-ob5 with an explicit profile.');
}
const viewport = { width: 1280, height: 720 };
export default defineConfig({
  testDir: './tests/geometry-benchmark/p3-al-ob5',
  testMatch: 'benchmark.spec.ts',
  outputDir: './test-results/p3-al-ob5',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60 * 60_000,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4182',
    viewport,
    deviceScaleFactor: 1,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    // As P2.5: lets the spec record the browser's launch flags through CDP.
    launchOptions: { args: ['--enable-automation'] },
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: false, viewport },
    },
    {
      name: 'edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge', headless: false, viewport },
    },
  ],
  webServer: {
    command:
      'pnpm exec vite preview --config tests/geometry-benchmark/p3-al-ob5/vite.config.ts --host 127.0.0.1 --port 4182 --strictPort',
    url: 'http://127.0.0.1:4182',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
