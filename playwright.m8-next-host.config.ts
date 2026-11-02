import { defineConfig, devices, type Project } from '@playwright/test';
import { headedReporter, headedWorkers } from './tooling/headed-run.mjs';

// M8-U7 (MVP M8 contract, M8-A14): the next-host page composed from `@vector-studio/ui` (layer
// panel, page list, property panel, the `ext.star` sample panel and, under `?test=1&faults=1`,
// the `test.ui` fault panels) with real input, in headed Chrome and Edge at 1280 × 720 and
// 1280 × 900, each project checking the M8-N3 layout budget against the 17a2b0a rows that
// `BASELINE_SOURCES` (tests/support/m8-n3-budget.ts) names for its viewport: the M1 config's at
// 1280 × 720 and the M2 config's at 1280 × 900. Needs `pnpm build` (the next-host production
// build) and the geometry kernel WASM from `pnpm test:geometry` (or VECTOR_STUDIO_GEOMETRY_WASM),
// so the headed projects attach the WebGPU renderer; and `M8_N3_BASELINE`, this machine's
// headed 17a2b0a measurement (`pnpm measure:m8-n3 --root <17a2b0a checkout> --headed --json`).
//
// M8_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in two headless
// projects, one per viewport, a functional smoke run of the spec for machines without the
// branded browsers, where the renderer may fail to start (the panels and commands do not need
// it). They read the committed headless 17a2b0a rows, or `M8_N3_HEADLESS_BASELINE`. They are not
// M8-A14 evidence, which needs the headed Chrome and Edge projects.
const webGpuArguments = ['--enable-unsafe-webgpu'];
// M8-N3: each project states its viewport, after the device presets (which set 1280 × 720).
const small = { width: 1280, height: 720 };
const large = { width: 1280, height: 900 };
const chromium = process.env.M8_NEXT_HOST_CHROMIUM;

const headed: Project[] = [
  {
    name: 'chrome-720',
    use: {
      ...devices['Desktop Chrome'],
      viewport: small,
      channel: 'chrome',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'chrome-900',
    use: {
      ...devices['Desktop Chrome'],
      viewport: large,
      channel: 'chrome',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'edge-720',
    use: {
      ...devices['Desktop Edge'],
      viewport: small,
      channel: 'msedge',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'edge-900',
    use: {
      ...devices['Desktop Edge'],
      viewport: large,
      channel: 'msedge',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
];

const smokeLaunch = {
  executablePath: chromium,
  args: [...webGpuArguments, '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader'],
};

const smoke: Project[] = [
  {
    name: 'smoke-720',
    use: {
      ...devices['Desktop Chrome'],
      viewport: small,
      headless: true,
      launchOptions: smokeLaunch,
    },
  },
  {
    name: 'smoke-900',
    use: {
      ...devices['Desktop Chrome'],
      viewport: large,
      headless: true,
      launchOptions: smokeLaunch,
    },
  },
];

export default defineConfig({
  testDir: './tests/m8-next-host',
  outputDir: './test-results/m8-next-host',
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
