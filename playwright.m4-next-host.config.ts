import { defineConfig, devices, type Project } from '@playwright/test';

// M4-U4 (MVP M4 contract, M4-A12): the next-host page on the `?fixture=appearance` document (H1
// to H9: E23's G1 to G3, E24's D3 and D1, a dashed arrow line, and E25's O1, O5 and O4 as a
// group, a mask group and a rotated frame) at DPR 1 and 2, its pixels against the E23, E24 and
// E25 oracles evaluated on the projected scene (tests/support/m4-scene-oracle.ts); every
// appearance panel control once, one undo step each; and a `?persist=1` reload that keeps the
// appearance, in headed Chrome and Edge. Needs `pnpm build` (the next-host production build)
// and the geometry kernel WASM from `pnpm test:geometry` (or VECTOR_STUDIO_GEOMETRY_WASM), so
// the headed projects attach the WebGPU renderer with `paints: 'gradient'` and
// `groups: 'isolated'` (M4-P7).
//
// M4_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project (SwiftShader WebGPU), a functional smoke run of the spec for machines without the
// branded browsers. It is not M4-A12 evidence, which needs the headed Chrome and Edge projects.
const webGpuArguments = ['--enable-unsafe-webgpu'];
/** After the device presets, which set 1280 x 720: the page with its status fits without a scroll. */
const viewport = { width: 1280, height: 900 };
const chromium = process.env.M4_NEXT_HOST_CHROMIUM;

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
  testDir: './tests/m4-next-host',
  outputDir: './test-results/m4-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 300_000,
  use: {
    baseURL: 'http://127.0.0.1:4188',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4188',
    url: 'http://127.0.0.1:4188',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
