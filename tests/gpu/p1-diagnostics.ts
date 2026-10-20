import type { Page, TestInfo } from '@playwright/test';

/**
 * Collects console messages, page errors, failed requests and HTTP error responses
 * from before the first navigation, so an unexplained fixture-load failure is diagnosable.
 * It observes only; it never alters what a test asserts.
 */
export interface P1PageDiagnostics {
  readonly entries: string[];
  readonly pageErrors: string[];
  /** Waits (bounded) for the fixture global; on timeout throws with the collected log. */
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
      try {
        await page.waitForFunction(
          () =>
            (window as unknown as { __vectorStudioP1?: unknown }).__vectorStudioP1 !== undefined,
          undefined,
          { timeout: timeoutMs },
        );
      } catch (error) {
        throw new Error(
          `window.__vectorStudioP1 was not defined within ${timeoutMs} ms (url ${page.url()}).\n` +
            `Collected diagnostics (${entries.length}):\n${entries.join('\n') || '(none)'}\n` +
            `Cause: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
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
