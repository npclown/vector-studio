import { defineConfig, devices } from '@playwright/test';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), U5: the effect-pass spec
// (tests/gpu/e41-effects.spec.ts) on SwiftShader, headless, for E41-A05's software check and
// A06's capture part before U7's headed reference-PC run. `pnpm test:gpu` runs the same spec
// headed. E41_CHROMIUM names a Chromium executable; without it Playwright's own Chromium runs.
const chromium = process.env.E41_CHROMIUM;

export default defineConfig({
  testDir: './tests/gpu',
  testMatch: 'e41-effects.spec.ts',
  outputDir: './test-results/e41-swiftshader',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 240_000,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'off',
    viewport: { width: 800, height: 500 },
  },
  projects: [
    {
      name: 'chromium-swiftshader',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        launchOptions: {
          ...(chromium === undefined ? {} : { executablePath: chromium }),
          // The flags of docs/evidence/e23/u3-swiftshader.md; with `--use-webgpu-adapter` alone
          // this container's Chromium loses the device on the first frame.
          args: [
            '--enable-unsafe-webgpu',
            '--use-vulkan=swiftshader',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--enable-features=Vulkan',
          ],
        },
      },
    },
  ],
  webServer: {
    command:
      'pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
