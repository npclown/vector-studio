import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// P3.1o O01: the evidence root is chosen once per command, before workers start, so a
// worker restart keeps writing into the same root.
const repositoryRoot = import.meta.dirname;
process.env.P3_COVERAGE_OUTPUT_DIR ??= path.resolve(
  repositoryRoot,
  'artifacts/p3.1o',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

export const p3CoverageLaunchArguments = ['--enable-unsafe-webgpu'];

export default defineConfig({
  testDir: './tests/gpu-p3-coverage',
  outputDir: './test-results/gpu-p3-coverage',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 1_500_000,
  use: {
    baseURL: 'http://127.0.0.1:4179',
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
        launchOptions: { args: p3CoverageLaunchArguments },
      },
    },
    {
      name: 'edge',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
        headless: false,
        launchOptions: { args: p3CoverageLaunchArguments },
      },
    },
  ],
  webServer: {
    command:
      'pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
