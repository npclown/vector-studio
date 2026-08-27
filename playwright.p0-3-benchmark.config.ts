import { defineConfig, devices } from '@playwright/test';

const webGpuArguments = ['--enable-unsafe-webgpu'];

export default defineConfig({
  testDir: './tests/benchmark',
  fullyParallel: false,
  // Headed benchmark windows must remain foreground-visible; parallel browsers are throttled.
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4174',
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
      'pnpm --filter @vector-studio/playground exec vite preview --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
