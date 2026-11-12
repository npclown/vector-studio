import { defineConfig, devices } from '@playwright/test';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), U4: the blend spec
// (tests/gpu/v35-blend.spec.ts) on SwiftShader, headless, for V35-A05 to A07's container check
// before the headed reference-PC run (`pnpm test:gpu`). V35_CHROMIUM names a Chromium
// executable; without it Playwright's own Chromium runs. The flags are E41's.
const chromium = process.env.V35_CHROMIUM;

export default defineConfig({
  testDir: './tests/gpu',
  testMatch: 'v35-blend.spec.ts',
  outputDir: './test-results/v35-swiftshader',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 600_000,
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
