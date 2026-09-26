import { defineConfig, devices } from '@playwright/test';

const webGpuArguments = ['--enable-unsafe-webgpu'];
// Preserve the actual Playwright invocation in direct functional-run records.
process.env.P1_RUNNER_COMMAND ??= JSON.stringify([process.execPath, ...process.argv.slice(1)]);

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: true,
        launchOptions: { args: webGpuArguments },
      },
    },
    {
      name: 'edge',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
        headless: true,
        launchOptions: { args: webGpuArguments },
      },
    },
  ],
  webServer: {
    command:
      'pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
