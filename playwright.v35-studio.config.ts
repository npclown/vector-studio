import { defineConfig, devices, type Project } from '@playwright/test';
import { headedReporter, headedWorkers } from './tooling/headed-run.mjs';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-A08 and V35-A09: the fill list
// and blend menus on the next-host studio page (`?test=1&layout=studio`) and the PNG export of a
// blended fill, in headed Chrome and Edge at 1280 × 900 (`tests/browser/v35-next-host.spec.ts`).
// The file name leaves out the `m8-next-host` pattern, so that tooling/m8-n3-configs.mjs does not
// list it (the studio is not the M8 layout). Needs `pnpm build`. M8_NEXT_HOST_CHROMIUM names a
// Chromium executable for one headless smoke project (SwiftShader WebGPU), as in E41's config.
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
      // SwiftShader WebGPU (the flags of playwright.e41-swiftshader.config.ts), so that the
      // effects spec's pixel probes run in the container too.
      launchOptions: {
        executablePath: chromium,
        args: [
          ...webGpuArguments,
          '--use-vulkan=swiftshader',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
          '--enable-features=Vulkan',
        ],
      },
    },
  },
];

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'v35-next-host.spec.ts',
  outputDir: './test-results/v35-next-host',
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
