import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { P1_SCENARIOS, type P1Scenario } from '../../apps/playground/src/p1-workloads.js';
import type { P1FunctionalCapture } from '../../apps/playground/src/p1-runner.js';
import { p1Source } from '../support/p1-evidence.js';
import { createP1FunctionalRecord, writeP1FunctionalRecord } from '../support/p1-runner-record.js';

declare global {
  interface Window {
    __vectorStudioP1Runner: { run(scenario: P1Scenario): Promise<P1FunctionalCapture> };
  }
}

test.describe('P1.6a native functional runner (not acceptance)', () => {
  test.describe.configure({ timeout: 60_000 });
  for (const scenario of P1_SCENARIOS) {
    test(scenario, async ({ page, browser }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      page.on('console', (event) => {
        if (event.type() === 'error') errors.push(event.text());
      });
      const source = p1Source();
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto('/p1-runner.html');
      await page.waitForFunction(() => window.__vectorStudioP1Runner !== undefined);
      const capture = await page.evaluate((id) => window.__vectorStudioP1Runner.run(id), scenario);
      const record = createP1FunctionalRecord(
        capture,
        source,
        { name: info.project.name, version: browser.version() },
        errors,
      );
      const root = path.resolve(
        process.env.P1_RUNNER_OUTPUT_DIR ?? `artifacts/p1.6a/browser-${randomUUID()}`,
      );
      const parent = path.resolve('artifacts/p1.6a');
      if (path.dirname(root) !== parent)
        throw new Error('P1 runner evidence must be an immediate child of artifacts/p1.6a.');
      mkdirSync(root, { recursive: true });
      const directory = path.join(root, `${info.project.name}-${scenario.replace('/', '-')}`);
      writeP1FunctionalRecord(directory, record, p1Source());
      await info.attach('functional-record', {
        path: path.join(directory, 'record.json'),
        contentType: 'application/json',
      });
      expect(record.findings, JSON.stringify(record.findings)).toEqual([]);
      expect(record.disposition).toBe('FUNCTIONAL_PASS');
    });
  }
});
