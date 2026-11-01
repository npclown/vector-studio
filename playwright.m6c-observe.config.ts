import path from 'node:path';
import { defineConfig, devices, type Project } from '@playwright/test';

// M6c-U5 (MVP M6c contract, section 9 and M6c-A10): the two observations of U5's main-PC
// sitting, in one headed run (`pnpm test:m6c-observe`), recorded and not judged:
// - typing: tests/m6c-next-host/m6c-observe.spec.ts, 30 keystrokes into a 16,384-unit node on
//   next-host (M6b-Q15 (a)), in headed Chrome and Edge at DPR 1 (`typing-chrome`, `typing-edge`);
// - raster frame: the E28 spec's raster-cost tests (tests/gpu/e28-text-atlas.spec.ts, "per-cluster
//   readback and raster cost" at DPR 1 and 2), which time one frame of `E28_RASTER_PER_FRAME`
//   (64) distinct calls on the playground page (`raster-chrome`, `raster-edge`; M6c-Q10 (a)).
// Both need what their own configs need: `pnpm build` (the next-host production build and the
// playground) and the geometry kernel WASM from `pnpm test:geometry` (or
// VECTOR_STUDIO_GEOMETRY_WASM). Reports go under artifacts/m6c-u5-observe/<time>/ (the E28 spec's
// through E28_OUTPUT_DIR), and the teardown (tests/m6c-next-host/m6c-observe-teardown.ts) prints
// the summary and saves it there as summary.md. The ports (4193, 4190) differ from the
// m6c-next-host and gpu configs', so this run does not collide with theirs.
//
// M6C_NEXT_HOST_CHROMIUM names a Chromium executable instead: one headless `typing-smoke`
// project, a functional run of the typing spec for machines without the branded browsers (the
// renderer may not start, so raster figures are empty); it is not M6c-A10 evidence.

// Set once in the runner; workers inherit the runner's environment, so they keep its values.
process.env.M6C_OBSERVE_DIR ??= path.resolve(
  'artifacts',
  'm6c-u5-observe',
  new Date().toISOString().replaceAll(/[:.]/gu, '-'),
);
process.env.E28_OUTPUT_DIR ??= path.join(process.env.M6C_OBSERVE_DIR, 'e28');

const webGpuArguments = ['--enable-unsafe-webgpu'];
const chromium = process.env.M6C_NEXT_HOST_CHROMIUM;
const typingUse = { viewport: { width: 1280, height: 900 }, baseURL: 'http://127.0.0.1:4193' };
const typing = {
  testDir: './tests/m6c-next-host',
  testMatch: 'm6c-observe.spec.ts',
  timeout: 600_000,
};
const raster = {
  testDir: './tests/gpu',
  testMatch: 'e28-text-atlas.spec.ts',
  grep: /raster cost/u,
  timeout: 300_000,
};
const rasterUse = { viewport: { width: 800, height: 500 }, baseURL: 'http://127.0.0.1:4190' };

const headed: Project[] = [
  {
    name: 'typing-chrome',
    ...typing,
    use: {
      ...devices['Desktop Chrome'],
      ...typingUse,
      channel: 'chrome',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'typing-edge',
    ...typing,
    use: {
      ...devices['Desktop Edge'],
      ...typingUse,
      channel: 'msedge',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'raster-chrome',
    ...raster,
    use: {
      ...devices['Desktop Chrome'],
      ...rasterUse,
      channel: 'chrome',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'raster-edge',
    ...raster,
    use: {
      ...devices['Desktop Edge'],
      ...rasterUse,
      channel: 'msedge',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
];

const smoke: Project[] = [
  {
    name: 'typing-smoke',
    ...typing,
    use: {
      ...devices['Desktop Chrome'],
      ...typingUse,
      headless: true,
      launchOptions: {
        executablePath: chromium,
        args: [
          ...webGpuArguments,
          '--enable-unsafe-swiftshader',
          '--use-webgpu-adapter=swiftshader',
        ],
      },
    },
  },
];

export default defineConfig({
  outputDir: './test-results/m6c-observe',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  globalTeardown: './tests/m6c-next-host/m6c-observe-teardown.ts',
  use: { trace: 'retain-on-failure' },
  projects: chromium === undefined ? headed : smoke,
  webServer: [
    {
      command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4193',
      url: 'http://127.0.0.1:4193',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    ...(chromium === undefined
      ? [
          {
            command:
              'pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4190 --strictPort',
            url: 'http://127.0.0.1:4190',
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
  ],
});
