import { defineConfig, devices, type Project } from '@playwright/test';

// M2-U6 (MVP M2 contract, section 6 and M2-Q4): the headed clipboard-event probe. It records
// whether Chrome and Edge fire the DOM `copy`, `cut` and `paste` events for Ctrl+C, Ctrl+X and
// Ctrl+V on a focused, non-editable `<canvas>`, which decides between the canvas listeners and
// the hidden `<textarea>` sink. Self-contained: the page is served by a route, no app or build.
//
// M2_CLIPBOARD_PROBE_CHROMIUM names a Chromium executable instead: the spec then runs in one
// headless project, a smoke run of the spec itself. It is not probe evidence, which needs the
// headed Chrome and Edge projects.
const chromium = process.env.M2_CLIPBOARD_PROBE_CHROMIUM;

const headed: Project[] = [
  {
    name: 'chrome',
    use: { ...devices['Desktop Chrome'], channel: 'chrome', headless: false },
  },
  {
    name: 'edge',
    use: { ...devices['Desktop Edge'], channel: 'msedge', headless: false },
  },
];

const smoke: Project[] = [
  {
    name: 'chromium-smoke',
    use: {
      ...devices['Desktop Chrome'],
      headless: true,
      launchOptions: { executablePath: chromium },
    },
  },
];

export default defineConfig({
  testDir: './tests/m2-clipboard-probe',
  outputDir: './test-results/m2-clipboard-probe',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  timeout: 30_000,
  projects: chromium === undefined ? headed : smoke,
});
