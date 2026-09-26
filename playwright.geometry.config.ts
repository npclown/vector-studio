import { defineConfig, devices } from '@playwright/test';

const wasmPath = process.env.P2_WASM_PATH;
const wasmSha256 = process.env.P2_WASM_SHA256;
if (!wasmPath) throw new Error('P2_WASM_PATH is required');
if (!wasmSha256) throw new Error('P2_WASM_SHA256 is required');

export default defineConfig({
  testDir: './tests/geometry-browser',
  outputDir: './test-results/geometry-browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: true },
    },
    {
      name: 'edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge', headless: true },
    },
  ],
  webServer: {
    command:
      'pnpm exec vite --config tests/geometry-browser/vite.config.ts --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
