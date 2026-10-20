// AL-S2 browser leg (contract section 5.2), run only by `pnpm benchmark:p3-b0-wasm`: one test
// per repetition, each in Playwright's fresh context and page, writing one raw record.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import type { WasmCapture, WasmPageOptions } from './workload.js';

const directory = process.env.P3_B0_WASM_RUN_DIR;
if (!directory) throw new Error('Run through pnpm benchmark:p3-b0-wasm.');
const invocation = JSON.parse(
  readFileSync(path.join(directory, 'browser-options.json'), 'utf8'),
) as {
  readonly repetitions: number;
  readonly options: Omit<WasmPageOptions, 'repetition'>;
};

for (let repetition = 0; repetition < invocation.repetitions; repetition += 1) {
  test(`AL-S2 ${invocation.options.profile} repetition ${repetition}`, async ({
    page,
    browser,
  }, info) => {
    let capture: WasmCapture | null = null;
    let error: string | null = null;
    let launchFlags: string[] = [];
    const startedAt = new Date().toISOString();
    try {
      const cdp = await browser.newBrowserCDPSession();
      try {
        launchFlags = (await cdp.send('Browser.getBrowserCommandLine')).arguments;
      } finally {
        await cdp.detach();
      }
      await page.goto('/');
      await page.waitForFunction(() => typeof window.runP3B0WasmBenchmark === 'function');
      capture = await page.evaluate((options) => window.runP3B0WasmBenchmark(options), {
        ...invocation.options,
        repetition,
      });
      if (capture.errors.length > 0) error = capture.errors.join('; ');
    } catch (failure) {
      error = String(failure);
    } finally {
      const record = {
        schema: 'p3-b0-wasm-browser/v1',
        project: info.project.name,
        channel: info.project.use.channel ?? null,
        browserVersion: browser.version(),
        launchFlags,
        repetition,
        startedAt,
        recordedAt: new Date().toISOString(),
        instrumentation: { headed: true, tracing: false, video: false, devtools: false },
        capture,
        error,
      };
      writeFileSync(
        path.join(directory, `browser-${info.project.name}-r${repetition}.json`),
        `${JSON.stringify(record)}\n`,
        { flag: 'wx' },
      );
    }
    if (error) throw new Error(error);
  });
}
