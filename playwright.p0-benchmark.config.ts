import { defineConfig, devices } from '@playwright/test';

const webGpuArguments = ['--enable-unsafe-webgpu'];
const smoke = process.env.P0_BENCHMARK_PROFILE === 'smoke';

export default defineConfig({
  testDir: './tests/benchmark',
  testMatch: 'p0-foundation.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: smoke ? 120_000 : 900_000,
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    viewport: { width: 1280, height: 720 },
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
      'pnpm --filter @vector-studio/playground exec vite preview --host 127.0.0.1 --port 4176 --strictPort',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
