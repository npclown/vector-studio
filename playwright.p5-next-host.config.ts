import { defineConfig, devices } from '@playwright/test';

// P5-U6 (P5 plan, P5-A09 headed half and P5-A12): the Next.js host in headed Chrome and Edge.
// Needs `pnpm build` (the next-host production build) and the geometry kernel WASM from
// `pnpm test:geometry` (or VECTOR_STUDIO_GEOMETRY_WASM).
const webGpuArguments = ['--enable-unsafe-webgpu'];

export default defineConfig({
  testDir: './tests/p5-next-host',
  outputDir: './test-results/p5-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'retain-on-failure',
    viewport: { width: 1100, height: 800 },
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
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4176',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
