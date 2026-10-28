import { defineConfig, devices, type Project } from '@playwright/test';

// M1-U5 (MVP M1 contract, M1-A12): the next-host page renders and edits the M1 containers
// fixture in headed Chrome and Edge. Needs `pnpm build` (the next-host production build) and the
// geometry kernel WASM from `pnpm test:geometry` (or VECTOR_STUDIO_GEOMETRY_WASM).
//
// M1_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project on SwiftShader WebGPU, a functional smoke run for machines without a GPU or the branded
// browsers. It is not M1-A12 evidence, which needs the headed Chrome and Edge projects.
const webGpuArguments = ['--enable-unsafe-webgpu'];
const chromium = process.env.M1_NEXT_HOST_CHROMIUM;

const headed: Project[] = [
  {
    name: 'chrome',
    use: {
      ...devices['Desktop Chrome'],
      channel: 'chrome',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
  {
    name: 'edge',
    use: {
      ...devices['Desktop Edge'],
      channel: 'msedge',
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  },
];

const smoke: Project[] = [
  {
    name: 'chromium-swiftshader',
    use: {
      ...devices['Desktop Chrome'],
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
  testDir: './tests/m1-next-host',
  outputDir: './test-results/m1-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4177',
    trace: 'retain-on-failure',
    viewport: { width: 1100, height: 800 },
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4177',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
