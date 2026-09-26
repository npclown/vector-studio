import { defineConfig, devices } from '@playwright/test';

const profile = process.env.P2_PROFILE;
if ((profile !== 'functional' && profile !== 'reference') || !process.env.P2_RUN_DIR) {
  throw new Error('Run through pnpm benchmark:p2 with an explicit profile.');
}
export default defineConfig({
  testDir: './tests/geometry-benchmark',
  testMatch: 'benchmark.spec.ts',
  outputDir: './test-results/p2-benchmark',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4176',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    trace: 'off',
    video: 'off',
    launchOptions: { args: ['--enable-automation'] },
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: profile === 'functional',
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'edge',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
        headless: profile === 'functional',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
  webServer: {
    command:
      'pnpm exec vite preview --config tests/geometry-benchmark/vite.config.ts --host 127.0.0.1 --port 4176 --strictPort',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
