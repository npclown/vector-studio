import { defineConfig } from '@playwright/test';
import browser from './playwright.config.js';
process.env.P1_RUNNER_BUILD_MODE = 'production';
const reference = process.env.P1_RUNNER_PROFILE === 'reference';

export default defineConfig({
  ...browser,
  testMatch: 'p1-runner.spec.ts',
  outputDir: './test-results/p1-runner',
  workers: 1,
  retries: 0,
  globalSetup: './tests/support/p1-runner-setup.ts',
  globalTeardown: './tests/support/p1-runner-teardown.ts',
  timeout: 60_000,
  use: {
    ...browser.use,
    baseURL: 'http://127.0.0.1:4178',
    viewport: { width: 1280, height: 720 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: (browser.projects ?? []).map((project) => ({
    ...project,
    use: { ...project.use, headless: reference ? false : true },
  })),
  webServer: {
    command:
      'pnpm --filter @vector-studio/playground exec vite preview --host 127.0.0.1 --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
