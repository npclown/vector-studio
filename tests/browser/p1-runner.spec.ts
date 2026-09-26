import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { P1_PROFILES, type P1ProfileName } from '../../apps/playground/src/p1-run-profiles.js';
import { P1_SCENARIOS, type P1Scenario } from '../../apps/playground/src/p1-workloads.js';
import type { P1FunctionalCapture } from '../../apps/playground/src/p1-runner.js';
import { p1Source } from '../support/p1-evidence.js';
import { createP1FunctionalRecord, writeP1FunctionalRecord } from '../support/p1-runner-record.js';

declare global {
  interface Window {
    __vectorStudioP1Runner: {
      run(scenario: P1Scenario, profileName?: P1ProfileName): Promise<P1FunctionalCapture>;
    };
  }
}

const profileName = (process.env.P1_RUNNER_PROFILE ?? 'functional') as P1ProfileName;
const repetitions = P1_PROFILES[profileName].repetitions;

test.describe(`P1 observed ${profileName} runner`, () => {
  test.describe.configure({ timeout: profileName === 'reference' ? 90_000 : 60_000 });
  for (const scenario of P1_SCENARIOS)
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      test(`${scenario} repetition ${repetition}`, async ({ page, browser }, info) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (event) => {
          if (event.type() === 'error') errors.push(event.text());
        });
        const source = p1Source();
        const root = path.resolve(
          process.env.P1_RUNNER_OUTPUT_DIR ?? `artifacts/p1.6b/browser-${randomUUID()}`,
        );
        const parent = path.resolve('artifacts/p1.6b');
        if (path.dirname(root) !== parent)
          throw new Error('P1 runner evidence must be an immediate child of artifacts/p1.6b.');
        mkdirSync(root, { recursive: true });
        const directory = path.join(
          root,
          `${info.project.name}-${scenario.replace('/', '-')}-rep-${repetition}`,
        );
        let capture: P1FunctionalCapture;
        try {
          await page.setViewportSize({ width: 1280, height: 720 });
          await page.goto('/p1-runner.html');
          await page.waitForFunction(() => window.__vectorStudioP1Runner !== undefined);
          capture = await page.evaluate(
            ({ scenario: selected, profile }) =>
              window.__vectorStudioP1Runner.run(selected, profile),
            { scenario, profile: profileName },
          );
        } catch (error) {
          // Page/runner failures before a capture exists must survive Playwright cleanup too.
          mkdirSync(directory);
          writeFileSync(
            path.join(directory, 'failure.json'),
            `${JSON.stringify(
              {
                scenario,
                repetition,
                profileName,
                browser: info.project.name,
                browserVersion: browser.version(),
                source,
                errors,
                error: String(error),
              },
              null,
              2,
            )}\n`,
            { flag: 'wx' },
          );
          throw error;
        }
        const record = createP1FunctionalRecord(
          capture,
          source,
          { name: info.project.name, version: browser.version() },
          errors,
          repetition,
        );
        writeP1FunctionalRecord(directory, record, p1Source());
        await info.attach('p1-runner-record', {
          path: path.join(directory, 'record.json'),
          contentType: 'application/json',
        });
        expect(record.findings, JSON.stringify(record.findings)).toEqual([]);
        expect(record.disposition).toBe(
          profileName === 'functional' ? 'FUNCTIONAL_PASS' : 'REFERENCE_CANDIDATE',
        );
      });
    }
});
