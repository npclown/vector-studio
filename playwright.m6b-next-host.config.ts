import { defineConfig, devices, type Project } from '@playwright/test';

// M6b-U9 (MVP M6b contract, M6b-A12 and A13): the next-host page on `?fixture=text-edit` (the
// committed edit fixture with the committed test font registered as `Noto Sans KR`): caret
// segments and selection rectangles from `textEditOverlay` against the port's clusters, click
// placement and Up and Down (A12); real keys for the edit-mode rules 1 to 6 and Tab, the DOM
// clipboard events and a paste of `text/plain` with HTML, the focus and prevention of presses
// in edit mode, and the synthetic IME traces replayed through CDP (A13), in headed Chrome and
// Edge. Needs `pnpm build` (the next-host production build). Reports are written under
// test-results/m6b-next-host/.
//
// M6B_NEXT_HOST_CHROMIUM names a Chromium executable instead: the spec then runs in one headless
// project, a functional smoke run of the spec for machines without the branded browsers. It is
// not M6b-A12 or A13 evidence, which needs the headed Chrome and Edge projects on the main PC.
const webGpuArguments = ['--enable-unsafe-webgpu'];
/** After the device presets, which set 1280 x 720: the page with its status fits without a scroll. */
const viewport = { width: 1280, height: 900 };
const chromium = process.env.M6B_NEXT_HOST_CHROMIUM;

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
  testDir: './tests/m6b-next-host',
  outputDir: './test-results/m6b-next-host',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:4189',
    trace: 'retain-on-failure',
  },
  projects: chromium === undefined ? headed : smoke,
  webServer: {
    command: 'pnpm --filter @vector-studio/next-host exec next start -H 127.0.0.1 -p 4189',
    url: 'http://127.0.0.1:4189',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
