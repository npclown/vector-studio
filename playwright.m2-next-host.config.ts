import { defineConfig, devices, type Project } from '@playwright/test';

// M2-U8 (MVP M2 contract, M2-A13): the next-host page's M2 interactions (system clipboard, the
// default keymap, Alt-drag and Alt-click, frame entry, zoom controls, snap overlay, scope
// indicator and rotate cursor) in headed Chrome and Edge. Needs `pnpm build` (the next-host
// production build) and the geometry kernel WASM from `pnpm test:geometry` (or
// VECTOR_STUDIO_GEOMETRY_WASM), so the headed projects attach the WebGPU renderer.
//
// M2_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project, a functional smoke run of the spec for machines without the branded browsers, where
// the renderer may fail to start (input does not need it). It is not M2-A13 evidence, which needs
// the headed Chrome and Edge projects.
const webGpuArguments = ['--enable-unsafe-webgpu'];
/** After the device presets, which set 1280 x 720: the page with its status fits without a scroll. */
const viewport = { width: 1280, height: 900 };
const chromium = process.env.M2_NEXT_HOST_CHROMIUM;

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
  testDir: './tests/m2-next-host',
  outputDir: './test-results/m2-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4178',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
