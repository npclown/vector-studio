import { defineConfig, devices } from '@playwright/test';

// AL-S2 browser leg (docs/plans/p3-alt-a1-fill-ladder-contract.md section 5.2), placed as the
// P2.5 runner places its configuration: installed stable Chrome, then Edge; headed in both
// profiles; one worker; a fresh page per repetition; no tracing, video or DevTools.
const profile = process.env.P3_B0_WASM_PROFILE;
if ((profile !== 'functional' && profile !== 'reference') || !process.env.P3_B0_WASM_RUN_DIR) {
  throw new Error('Run through pnpm benchmark:p3-b0-wasm with an explicit profile.');
}
const viewport = { width: 1280, height: 720 };
export default defineConfig({
  testDir: './tests/geometry-benchmark/p3-b0-wasm',
  testMatch: 'benchmark.spec.ts',
  outputDir: './test-results/p3-b0-wasm',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45 * 60_000,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4181',
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
      'pnpm exec vite preview --config tests/geometry-benchmark/p3-b0-wasm/vite.config.ts --host 127.0.0.1 --port 4181 --strictPort',
    url: 'http://127.0.0.1:4181',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
