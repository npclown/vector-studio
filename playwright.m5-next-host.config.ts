import { defineConfig, devices, type Project } from '@playwright/test';

// M5-U5 (MVP M5 contract, M5-A10): the next-host page's `?persist=1` composition with the
// browser's own IndexedDB (reload restore, Save file and Open file, corrupt entries, the fixture
// precedence and the test hook's `persistence.flush`) in headed Chrome and Edge. Needs `pnpm
// build` (the next-host production build). Each test gets a fresh browser context, so it starts
// from an empty IndexedDB.
//
// M5_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project, a functional smoke run of the spec for machines without the branded browsers, where
// the renderer may fail to start (persistence and input do not need it). It is not M5-A10
// evidence, which needs the headed Chrome and Edge projects.
const webGpuArguments = ['--enable-unsafe-webgpu'];
/** After the device presets, which set 1280 x 720: the page with its status fits without a scroll. */
const viewport = { width: 1280, height: 900 };
const chromium = process.env.M5_NEXT_HOST_CHROMIUM;

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
  testDir: './tests/m5-next-host',
  outputDir: './test-results/m5-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4184',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4184',
    url: 'http://127.0.0.1:4184',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
