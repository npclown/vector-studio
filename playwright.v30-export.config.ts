import { defineConfig, devices, type Project } from '@playwright/test';
import { headedReporter, headedWorkers } from './tooling/headed-run.mjs';

// V-30 export contract (docs/plans/viz-v30-export-contract.md), V30-A04 and V30-A05: the studio's
// Export section on the next-host page (`?test=1&layout=studio`), in headed Chrome and Edge at
// 1280 × 900. The studio is not the M8 layout, so the M8-N3 budget (which the next-host configs
// check) does not apply and this config is not one of them. Needs `pnpm build`. The export paints
// with Canvas 2D, so the renderer is not needed: M8_NEXT_HOST_CHROMIUM names a Chromium
// executable for one headless smoke project, as in the M8 config.
const viewport = { width: 1280, height: 900 };
const chromium = process.env.M8_NEXT_HOST_CHROMIUM;
const webGpuArguments = ['--enable-unsafe-webgpu'];

const headed: Project[] = [
  {
    name: 'chrome',
    use: {
      ...devices['Desktop Chrome'],
      viewport,
      channel: 'chrome',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'edge',
    use: {
      ...devices['Desktop Edge'],
      viewport,
      channel: 'msedge',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
];

const smoke: Project[] = [
  {
    name: 'smoke',
    use: {
      ...devices['Desktop Chrome'],
      viewport,
      headless: true,
      launchOptions: { executablePath: chromium, args: webGpuArguments },
    },
  },
];

export default defineConfig({
  testDir: './tests/v30-export',
  outputDir: './test-results/v30-export',
  fullyParallel: false,
  workers: headedWorkers(),
  retries: 0,
  reporter: headedReporter,
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4194',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4194',
    url: 'http://127.0.0.1:4194',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
