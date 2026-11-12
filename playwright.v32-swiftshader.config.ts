import { defineConfig, devices } from '@playwright/test';

// V-32 contract (docs/plans/viz-v32-image-contract.md), U3: the image paint spec
// (tests/gpu/v32-image-paint.spec.ts) on SwiftShader, headless, as the software check of V32-A06
// before the headed reference-PC run. `pnpm test:gpu` runs the same spec
// headed. V32_CHROMIUM names a Chromium executable; without it Playwright's own Chromium runs.
const chromium = process.env.V32_CHROMIUM;

export default defineConfig({
  testDir: './tests/gpu',
  testMatch: 'v32-image-paint.spec.ts',
  outputDir: './test-results/v32-swiftshader',
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
