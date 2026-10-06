import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// P3.1l L05: the evidence root is chosen once per command, before workers start, so a
// worker restart keeps writing into the same root.
const repositoryRoot = import.meta.dirname;
process.env.P3_NATIVE_PROJECTION_OUTPUT_DIR ??= path.resolve(
  repositoryRoot,
  'artifacts/p3.1l',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

export const p3NativeProjectionLaunchArguments = ['--enable-unsafe-webgpu'];

export default defineConfig({
  testDir: './tests/gpu-p3-projection',
  outputDir: './test-results/gpu-p3-projection',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 600_000,
  use: {
    baseURL: 'http://127.0.0.1:4177',
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
        launchOptions: { args: p3NativeProjectionLaunchArguments },
      },
    },
    {
      name: 'edge',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
        headless: false,
        launchOptions: { args: p3NativeProjectionLaunchArguments },
      },
    },
  ],
  webServer: {
    command:
      'pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4177 --strictPort',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
