import { defineConfig, devices, type Project } from '@playwright/test';
import { headedReporter, headedWorkers } from './tooling/headed-run.mjs';

// P5-U6 (P5 plan, P5-A09 headed half and P5-A12): the Next.js host in headed Chrome and Edge.
// Needs `pnpm build` (the next-host production build) and the geometry kernel WASM from
// `pnpm test:geometry` (or VECTOR_STUDIO_GEOMETRY_WASM).
//
// P5_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project on SwiftShader WebGPU, a functional smoke run (as playwright.m1-next-host.config.ts).
// It is not P5-A09 or P5-A12 evidence, which needs the headed Chrome and Edge projects.
const webGpuArguments = ['--enable-unsafe-webgpu'];
// M8-U6 (MVP M8 contract, M8-N3): each project states its viewport. It is the 1280 × 720 the
// Desktop Chrome and Edge presets always gave these projects, which overrode the config-level
// 1100 × 800 this config named until M8-U6 (M6b exit, follow-up 9).
const viewport = { width: 1280, height: 720 };
const chromium = process.env.P5_NEXT_HOST_CHROMIUM;

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
    name: 'chromium-swiftshader',
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
  testDir: './tests/p5-next-host',
  outputDir: './test-results/p5-next-host',
  fullyParallel: false,
  workers: headedWorkers(),
  retries: 0,
  reporter: headedReporter,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4176',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4176',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
