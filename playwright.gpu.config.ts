import { defineConfig, devices } from '@playwright/test';
import { headedReporter, headedWorkers } from './tooling/headed-run.mjs';

const webGpuArguments = ['--enable-unsafe-webgpu'];

// The V-4 A08 corpus spec takes about 2 h of a full run (Edge 1.1 h, Chrome 1 h), and its
// captures matter mainly when the geometry kernel or the renderer changes. `pnpm test:gpu` leaves
// it out; `pnpm test:gpu:viz-v4` (and so `pnpm test:gpu:full`) runs it by setting VS_GPU_CORPUS=1.
// A spec path on the command line does not override testIgnore. See docs/validation.md,
// "Headed run tiers".
const includeCorpus = process.env.VS_GPU_CORPUS === '1';
// The E3 A04 readback spec's named cases take about 10 min per browser in one test. Like the
// corpus they matter when the kernel or the renderer changes, so they run at tier 3 only
// (VS_GPU_TIER=3, which `pnpm test:headed --tier 3` and `pnpm test:gpu:full` set); below tier 3
// the spec checks its non-corpus cases. E3_A04_READBACK_NON_CORPUS_ONLY=0 forces the full check.
// Set here, the default reaches the workers too, which load this config again.
if (process.env.VS_GPU_TIER !== '3') process.env.E3_A04_READBACK_NON_CORPUS_ONLY ??= '1';
const workers = headedWorkers();
// Edge in the gpu stage: headed Chrome and Edge drive the same Chromium WebGPU stack, so Edge adds
// most where the renderer or the kernel changed, which is tier 3. Below tier 3 the stage runs
// Chrome only (decided 2026-11-02, docs/validation.md "Headed run tiers"). Edge comes back with
// VS_GPU_TIER=3, the corpus (VS_GPU_CORPUS=1, whose counted runs need both browsers), the full
// E3 readback (E3_A04_READBACK_NON_CORPUS_ONLY=0, whose E3-A6 needs both), or VS_GPU_EDGE=1.
const includeEdge =
  process.env.VS_GPU_TIER === '3' ||
  includeCorpus ||
  process.env.E3_A04_READBACK_NON_CORPUS_ONLY !== '1' ||
  process.env.VS_GPU_EDGE === '1';

export default defineConfig({
  testDir: './tests/gpu',
  testIgnore: includeCorpus ? [] : ['**/viz-v4-a08-corpus.spec.ts'],
  outputDir: './test-results/gpu',
  // With more than one worker, the tests of one file spread over workers too: p1-primitives and
  // p4-clip-mask take about 10 min per browser each, longer than the rest of a parallel run's
  // share. No gpu spec shares state between its tests. Most write their evidence under a run root
  // named by the worker's process id (the corpus under VIZ_V4_RUN_ID, p1 under
  // P1_EVIDENCE_OUTPUT_DIR when set), so one file's evidence can span several run roots.
  fullyParallel: workers > 1,
  workers,
  retries: 0,
  reporter: headedReporter,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
    viewport: { width: 800, height: 500 },
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: false,
        launchOptions: { args: webGpuArguments },
      },
    },
    ...(includeEdge
      ? [
          {
            name: 'edge',
            use: {
              ...devices['Desktop Edge'],
              channel: 'msedge' as const,
              headless: false,
              launchOptions: { args: webGpuArguments },
            },
          },
        ]
      : []),
  ],
  webServer: {
    command:
      'pnpm --filter @vector-studio/playground exec vite --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
