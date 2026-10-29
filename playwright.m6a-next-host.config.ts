import { defineConfig, devices, type Project } from '@playwright/test';

// M6a-U6 (MVP M6a contract, M6a-A11 and A12): text-dom on the next-host page with
// `?fixture=text` (the committed test font, the layout fixtures against unprobed reference
// blocks, the font-load case, fallback, segmentation, sizes, DPR emulation and size linearity),
// in headed Chrome and Edge. Needs `pnpm build` (the next-host production build). The carry-list
// case (h), one registered-font cluster through the renderer with `text: 'atlas'`, runs on the
// playground's E23 check page, so the playground's Vite server starts too and needs the geometry
// kernel WASM from `pnpm test:geometry` (or VECTOR_STUDIO_GEOMETRY_WASM).
//
// M6A_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project, a functional smoke run of the spec for machines without the branded browsers. It is
// not M6a-A11 or A12 evidence, which needs the headed Chrome and Edge projects on the main PC.
const webGpuArguments = ['--enable-unsafe-webgpu'];
const viewport = { width: 1280, height: 900 };
const chromium = process.env.M6A_NEXT_HOST_CHROMIUM;

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
  testDir: './tests/m6a-next-host',
  outputDir: './test-results/m6a-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4186',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: [
    {
      command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4186',
      url: 'http://127.0.0.1:4186',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        'pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4187 --strictPort',
      url: 'http://127.0.0.1:4187',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
