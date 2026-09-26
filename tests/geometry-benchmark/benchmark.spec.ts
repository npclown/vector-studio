import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import type { P2Capture, P2ProfileName } from './types.js';
import { p2Hash } from '../support/p2-benchmark-record.js';

const profile = process.env.P2_PROFILE as P2ProfileName;
const directory = process.env.P2_RUN_DIR;
const expectedWasmSha256 = process.env.P2_WASM_SHA256;
if (!directory || !expectedWasmSha256 || (profile !== 'functional' && profile !== 'reference')) {
  throw new Error('Run through pnpm benchmark:p2.');
}
const invocation = JSON.parse(readFileSync(path.join(directory, 'invocation.json'), 'utf8')) as {
  source: { sha256: string };
};
const build = JSON.parse(readFileSync(path.join(directory, 'build.json'), 'utf8')) as {
  sha256: string;
};
for (let repetition = 1; repetition <= (profile === 'reference' ? 5 : 1); repetition++) {
  test(`P2 ${profile} repetition ${repetition}`, async ({ page, browser }, info) => {
    let capture: P2Capture | null = null;
    let error: string | null = null;
    let launchFlags: string[] = [];
    try {
      const cdp = await browser.newBrowserCDPSession();
      try {
        const command = await cdp.send('Browser.getBrowserCommandLine');
        launchFlags = command.arguments;
      } finally {
        await cdp.detach();
      }
      await page.goto('/');
      await page.waitForFunction(() => typeof window.runP2Benchmark === 'function');
      capture = await page.evaluate((options) => window.runP2Benchmark(options), {
        profile,
        repetition,
        expectedWasmSha256,
      });
    } catch (failure) {
      error = String(failure);
    } finally {
      const record = {
        schema: 'p2-record/v1',
        project: info.project.name,
        browserVersion: browser.version(),
        launchFlags,
        profile,
        repetition,
        recordedAt: new Date().toISOString(),
        instrumentation: {
          headed: profile === 'reference',
          tracing: false,
          video: false,
          devtools: false,
        },
        sourceSha256: invocation.source.sha256,
        buildSha256: build.sha256,
        wasmSha256: expectedWasmSha256,
        configurationSha256:
          capture === null
            ? null
            : p2Hash({
                configuration: capture.configuration,
                profile: capture.profile,
                viewport: capture.environment.viewport,
              }),
        capture,
        error,
      };
      writeFileSync(
        path.join(directory, `${info.project.name}-r${repetition}.json`),
        JSON.stringify(record, null, 2) + '\n',
        { flag: 'wx' },
      );
    }
    if (error) throw new Error(error);
  });
}
