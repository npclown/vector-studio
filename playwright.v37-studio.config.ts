import { defineConfig, devices, type Project } from '@playwright/test';
import { headedReporter, headedWorkers } from './tooling/headed-run.mjs';

// V-37 contract (docs/plans/viz-v37-variants-overrides-contract.md), V37-A13: the studio page
// (`?test=1&layout=studio&fixture=v37-variants`) in headed Chrome and Edge at 1280 × 900: combine
// three symbols as variants, switch an instance's variant from its dropdown, focus a layer by a
// double-click, override its fill and reset it. The studio is not the M8 layout, so the M8-N3
// budget does not apply and the file name leaves out `next-host`, as the E41 and V-30 configs do.
// Needs `pnpm build` and the geometry kernel WASM (`pnpm test:geometry`, or
// VECTOR_STUDIO_GEOMETRY_WASM). M8_NEXT_HOST_CHROMIUM names a Chromium executable for one
// headless smoke project, as in the M8 config; the spec has no pixel probes. Not V37-A13
// evidence, which needs the headed projects on the main PC.
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
  testDir: './tests/v37-next-host',
  outputDir: './test-results/v37-next-host',
  fullyParallel: false,
  workers: headedWorkers(),
  retries: 0,
  reporter: headedReporter,
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4197',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4197',
    url: 'http://127.0.0.1:4197',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
