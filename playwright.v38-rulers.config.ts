import { defineConfig, devices, type Project } from '@playwright/test';
import { headedReporter, headedWorkers } from './tooling/headed-run.mjs';

// V-38 contract (docs/plans/viz-v38-rulers-guides-grids-contract.md), V38-A07: rulers, guides
// and layout grids in the studio on the next-host page (`?test=1&layout=studio`), in headed Chrome
// and Edge at 1280 × 900. The studio is not the M8 layout, so the M8-N3 budget does not apply and
// this config is not one of the next-host configs. Needs `pnpm build`. The spec reads the editor
// and the DOM overlay only, so the renderer is not needed: M8_NEXT_HOST_CHROMIUM names a Chromium
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
  testDir: './tests/v38-rulers',
  outputDir: './test-results/v38-rulers',
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
