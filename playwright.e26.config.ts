import { defineConfig, devices, type Project } from '@playwright/test';

// E26-U1c (E26 contract, sections 3.3 and 3.5): the headed harness of the five E26 scenarios on
// `apps/next-host` with `?bench=1`, in headed Chrome and Edge at DPR 1 and 2, each test one
// repetition of one scenario in a fresh context (so `persist=1` starts from an empty IndexedDB).
// Needs `pnpm build` (the next-host production build). The global setup writes the scenario
// documents to `.tools/e26/docs/`. Per-run records go to `test-results/e26-runs/` (or
// E26_RESULTS_DIR); only reference-PC runs are evidence.
//
// E26_REPETITIONS (default 5) sets the repetitions, E26_SCENARIOS a comma-separated list of
// scenario IDs or ID prefixes. E26_CHROMIUM names a Chromium executable instead: the spec then
// runs in one headless SwiftShader project at DPR 1 with one repetition by default, a functional
// smoke run that is not evidence.
//
// M9-U1 (M9 contract, section 4): each project has a `-v2` twin at 1600 x 1000, so the right
// column of `ui=1` fits beside the 1280 x 720 canvas; the M9 scenarios run only there and the v1
// ones only in the original projects (the spec skips the others).
const webGpuArguments = ['--enable-unsafe-webgpu'];
/** Room for the 1280 x 720 canvas, the toolbar and the status without a scroll. */
const viewport = { width: 1400, height: 1000 };
/** M9-U1: the v2 projects' viewport (tests/e26/scenarios.ts, M9_WINDOW). */
const viewportV2 = { width: 1600, height: 1000 };
const chromium = process.env.E26_CHROMIUM;

const browsers = [
  { name: 'chrome', device: devices['Desktop Chrome'], channel: 'chrome' },
  { name: 'edge', device: devices['Desktop Edge'], channel: 'msedge' },
] as const;

const headed: Project[] = browsers.flatMap(({ name, device, channel }) =>
  [1, 2].map((deviceScaleFactor) => ({
    name: `${name}-dpr${deviceScaleFactor}`,
    use: {
      ...device,
      viewport,
      deviceScaleFactor,
      channel,
      headless: false,
      launchOptions: { args: webGpuArguments },
    },
  })),
);
const headedV2: Project[] = headed.map((project) => ({
  ...project,
  name: `${project.name}-v2`,
  use: { ...project.use, viewport: viewportV2 },
}));

const smoke: Project[] = [
  {
    name: 'chromium-smoke-dpr1',
    use: {
      ...devices['Desktop Chrome'],
      viewport,
      deviceScaleFactor: 1,
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
const smokeV2: Project[] = smoke.map((project) => ({
  ...project,
  name: `${project.name}-v2`,
  use: { ...project.use, viewport: viewportV2 },
}));

export default defineConfig({
  testDir: './tests/e26',
  testMatch: 'e26-harness.spec.ts',
  outputDir: './test-results/e26',
  globalSetup: './tests/e26/setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 240_000,
  use: {
    baseURL: 'http://127.0.0.1:4191',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: chromium === undefined ? [...headed, ...headedV2] : [...smoke, ...smokeV2],
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4191',
    url: 'http://127.0.0.1:4191',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
