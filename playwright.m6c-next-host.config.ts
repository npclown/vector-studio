import { defineConfig, devices, type Project } from '@playwright/test';

// M6c-U2 (MVP M6c contract, M6c-A04): the next-host page draws text with `text: 'atlas'`: ink
// inside each text leaf's cluster bounds on `?fixture=text`, `?fixture=text-edit` and
// `?fixture=text-gpu` (both pages), no editor diagnostic and no renderer diagnostic other than
// `info`, and the `?test=1` cluster probe (`scene()`, `readCluster()`, the raster counters), in
// headed Chrome and Edge at DPR 1 (the device presets) and at deviceScaleFactor 2 (`chrome-dpr2`,
// `edge-dpr2`). M6c-U3 (M6c-A06, A07): m6c-agreement.spec.ts, the DOM and GPU agreement and
// the font-load case, runs in the same projects. Both need `pnpm build` (the next-host production
// build) and the geometry kernel WASM from `pnpm test:geometry` (or VECTOR_STUDIO_GEOMETRY_WASM), so the headed projects attach
// the WebGPU renderer. Reports are written under test-results/m6c-next-host/.
//
// M6C_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project, a functional smoke run for machines without the branded browsers, where the renderer
// may fail to start; it then checks the fixtures load and skips the drawing checks. It is not
// M6c-A04 evidence, which needs the headed Chrome and Edge projects on the main PC.
const webGpuArguments = ['--enable-unsafe-webgpu'];
/** After the device presets, which set 1280 x 720: the page with its status fits without a scroll. */
const viewport = { width: 1280, height: 900 };
const chromium = process.env.M6C_NEXT_HOST_CHROMIUM;

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
  // Review S5: the same spec at device pixel ratio 2 (A04 holds at every DPR the host runs at).
  {
    name: 'chrome-dpr2',
    use: {
      ...devices['Desktop Chrome'],
      viewport,
      deviceScaleFactor: 2,
      channel: 'chrome',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'edge-dpr2',
    use: {
      ...devices['Desktop Edge'],
      viewport,
      deviceScaleFactor: 2,
      channel: 'msedge',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
];

const smoke: Project[] = [
  {
    name: 'chromium-smoke',
    use: {
      ...devices['Desktop Chrome'],
      viewport,
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
  testDir: './tests/m6c-next-host',
  outputDir: './test-results/m6c-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 180_000,
  use: {
    baseURL: 'http://127.0.0.1:4192',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4192',
    url: 'http://127.0.0.1:4192',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
