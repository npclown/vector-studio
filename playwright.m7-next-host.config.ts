import { defineConfig, devices, type Project } from '@playwright/test';

// M7-U6 (MVP M7 contract, M7-A11): the next-host page on the `?fixture=symbols` document (source
// edits reaching instances by pixel probes, an instance resize, detach, the source's delete and
// undo of each, the page row's symbol and instance buttons) and a `?persist=1` reload that keeps
// the instances linked, in headed Chrome and Edge. Needs `pnpm build` (the next-host production
// build) and the geometry kernel WASM from `pnpm test:geometry` (or VECTOR_STUDIO_GEOMETRY_WASM),
// so the headed projects attach the WebGPU renderer and a kernel rejection would show as an
// `editor.scene-rejected` diagnostic.
//
// M7_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project, a functional smoke run of the spec for machines without the branded browsers, where
// the renderer may fail to start (input, commands and persistence do not need it). It is not
// M7-A11 evidence, which needs the headed Chrome and Edge projects.
const webGpuArguments = ['--enable-unsafe-webgpu'];
/** After the device presets, which set 1280 x 720: the page with its status fits without a scroll. */
const viewport = { width: 1280, height: 900 };
const chromium = process.env.M7_NEXT_HOST_CHROMIUM;

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
  testDir: './tests/m7-next-host',
  outputDir: './test-results/m7-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4185',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4185',
    url: 'http://127.0.0.1:4185',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
