import type { Page, TestInfo } from '@playwright/test';

/**
 * Collects console messages, page errors, failed requests and HTTP error responses
 * from before the first navigation, so an unexplained fixture-load failure is diagnosable.
 * It observes only; it never alters what a test asserts.
 */
export interface P1PageDiagnostics {
  readonly entries: string[];
  readonly pageErrors: string[];
  /**
   * Returns at once when the fixture global is defined. Otherwise waits (bounded) only to collect
   * late diagnostics, then always throws with the log, saying whether the global appeared late.
   */
  waitForFixture(timeoutMs?: number): Promise<void>;
  /** Attaches the collected log to the test report (on failure unless `always`). */
  attach(info: TestInfo, always?: boolean): Promise<void>;
}

export function collectP1Diagnostics(page: Page): P1PageDiagnostics {
  const entries: string[] = [];
  const pageErrors: string[] = [];
  const stamp = () => new Date().toISOString();
  page.on('console', (message) => {
    const location = message.location();
    entries.push(
      `${stamp()} console.${message.type()}: ${message.text()} (${location.url}:${location.lineNumber})`,
    );
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    entries.push(`${stamp()} pageerror: ${error.stack ?? error.message}`);
  });
  page.on('requestfailed', (request) => {
    entries.push(
      `${stamp()} requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    );
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      entries.push(`${stamp()} response ${response.status()}: ${response.url()}`);
  });
  return {
    entries,
    pageErrors,
    async waitForFixture(timeoutMs = 15_000) {
      const defined = () =>
        page.evaluate(
          () =>
            (window as unknown as { __vectorStudioP1?: unknown }).__vectorStudioP1 !== undefined,
        );
      // The normal path: the global is defined once `goto` resolves, so this returns at once and
      // a passing run behaves as before this helper existed.
      let present: boolean;
      try {
        present = await defined();
      } catch (error) {
        // For example "Execution context was destroyed": fail as before, with the log attached.
        throw new Error(
          `checking window.__vectorStudioP1 after navigation threw (url ${page.url()}): ` +
            `${error instanceof Error ? error.message : String(error)}\n` +
            `Collected diagnostics (${entries.length}):\n${entries.join('\n') || '(none)'}`,
          { cause: error },
        );
      }
      if (present) return;
      // Otherwise the test fails, as its first `evaluate` would have before. The bounded wait only
      // collects late console, network and page-error entries and tells a late appearance apart
      // from none; a late appearance never turns the failure into a pass.
      const started = Date.now();
      let outcome: string;
      try {
        await page.waitForFunction(
          () =>
            (window as unknown as { __vectorStudioP1?: unknown }).__vectorStudioP1 !== undefined,
          undefined,
          { timeout: timeoutMs },
        );
        outcome = `appeared ${Date.now() - started} ms after navigation resolved`;
      } catch (error) {
        outcome = `never appeared within ${timeoutMs} ms (${error instanceof Error ? error.message : String(error)})`;
      }
      throw new Error(
        `window.__vectorStudioP1 was undefined when navigation resolved; it ${outcome} (url ${page.url()}).\n` +
          `Collected diagnostics (${entries.length}):\n${entries.join('\n') || '(none)'}`,
      );
    },
    async attach(info, always = false) {
      if (!always && info.status === info.expectedStatus) return;
      await info.attach('p1-page-diagnostics.log', {
        body: entries.join('\n') || '(no console, page error, failed request or error response)',
        contentType: 'text/plain',
      });
    },
  };
}
