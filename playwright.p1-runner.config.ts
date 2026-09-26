import { defineConfig } from '@playwright/test';
import browser from './playwright.config.js';
process.env.P1_RUNNER_BUILD_MODE = 'production';

export default defineConfig({
  ...browser,
  testMatch: 'p1-runner.spec.ts',
  outputDir: './test-results/p1-runner',
  workers: 1,
  timeout: 60_000,
  use: {
    ...browser.use,
    baseURL: 'http://127.0.0.1:4178',
    viewport: { width: 1280, height: 720 },
    trace: 'off',
  },
  webServer: {
    command:
      'pnpm --filter @vector-studio/playground exec vite preview --host 127.0.0.1 --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
