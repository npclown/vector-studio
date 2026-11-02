import { defineConfig, devices } from '@playwright/test';

const webGpuArguments = ['--enable-unsafe-webgpu'];

// The V-4 A08 corpus spec takes about 2 h of a full run (Edge 1.1 h, Chrome 1 h), and its
// captures matter mainly when the geometry kernel or the renderer changes. `pnpm test:gpu` leaves
// it out; `pnpm test:gpu:viz-v4` (and so `pnpm test:gpu:full`) runs it by setting VS_GPU_CORPUS=1.
// A spec path on the command line does not override testIgnore. See docs/validation.md,
// "Headed run tiers".
const includeCorpus = process.env.VS_GPU_CORPUS === '1';

export default defineConfig({
  testDir: './tests/gpu',
  testIgnore: includeCorpus ? [] : ['**/viz-v4-a08-corpus.spec.ts'],
  outputDir: './test-results/gpu',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
    viewport: { width: 800, height: 500 },
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: false,
        launchOptions: { args: webGpuArguments },
      },
    },
    {
      name: 'edge',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
        headless: false,
        launchOptions: { args: webGpuArguments },
      },
    },
  ],
  webServer: {
    command:
      'pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
