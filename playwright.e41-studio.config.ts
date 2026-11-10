import { defineConfig, devices, type Project } from '@playwright/test';
import { headedReporter, headedWorkers } from './tooling/headed-run.mjs';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), E41-A12: next-host flows on the
// studio page (`?test=1&layout=studio`), in headed Chrome and Edge at 1280 × 900. U3b adds the
// boolean half (context menu, keys, toolbar, panel, undo); U7a the effects half (the panel's
// Effects section, with pixel probes of the presented frame). Not an M8
// layout, so the M8-N3 budget does not apply, and the file name leaves out `next-host` so that
// tooling/m8-n3-configs.mjs does not list it. Needs `pnpm build`. M8_NEXT_HOST_CHROMIUM names a
// Chromium executable for one headless smoke project, as in the M8 config.
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
  testDir: './tests/e41-next-host',
  outputDir: './test-results/e41-next-host',
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
