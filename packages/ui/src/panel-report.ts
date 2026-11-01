import type { PanelError, UiExtension } from './panel-resolve.js';

// MVP M8 contract, M8-P1 and M8-P3: the pure parts of `PanelProvider`'s error bookkeeping,
// internal to the package (not on its entry) and unit-tested as functions. `onPanelError`
// receives each error, by code and panel, once; on mount the rejections come first, then the
// failures that boundaries caught in the same commit; after that, errors go out as they occur.

/** The identity of a panel error for deduplication: its code and panel. */
export function panelErrorKey(error: PanelError): string {
  return `${error.code} ${error.panel}`;
}

/**
 * What the provider has delivered to `onPanelError` in one composition (one editor and one set
 * of contributions, `generation`): the keys delivered or queued, whether the rejections were
 * reported yet, and the failures caught before that, waiting for them.
 */
export type PanelReporter = Readonly<{
  generation: number;
  reported: ReadonlySet<string>;
  ready: boolean;
  queue: readonly PanelError[];
}>;

/** One step of the reporter: its next state and the errors to deliver now, in order. */
export type PanelReportStep = Readonly<{ reporter: PanelReporter; deliver: readonly PanelError[] }>;

/** A reporter that has delivered nothing, for composition `generation`. */
export function initialReporter(generation: number): PanelReporter {
  return { generation, reported: new Set(), ready: false, queue: [] };
}

/**
 * The provider's effect after a render with the rejections `rejected`: delivers each rejection
 * not delivered before (by code and panel, once even if the list repeats it), then the queued
 * failures, and marks the reporter ready.
 */
export function reportRejections(
  reporter: PanelReporter,
  rejected: readonly PanelError[],
): PanelReportStep {
  const reported = new Set(reporter.reported);
  const deliver: PanelError[] = [];
  for (const error of rejected) {
    const key = panelErrorKey(error);
    if (reported.has(key)) continue;
    reported.add(key);
    deliver.push(error);
  }
  deliver.push(...reporter.queue);
  return { reporter: { ...reporter, reported, ready: true, queue: [] }, deliver };
}

/**
 * A boundary caught a failure: a new one is queued until the rejections were reported, else
 * delivered now; one already delivered or queued for that code and panel is dropped.
 */
export function reportFailure(reporter: PanelReporter, error: PanelError): PanelReportStep {
  const key = panelErrorKey(error);
  if (reporter.reported.has(key)) return { reporter, deliver: [] };
  const reported = new Set(reporter.reported).add(key);
  return reporter.ready
    ? { reporter: { ...reporter, reported }, deliver: [error] }
    : { reporter: { ...reporter, reported, queue: [...reporter.queue, error] }, deliver: [] };
}

/**
 * The failures `usePanelErrors` lists after a boundary reported `error`: appended once per
 * panel, so the same list object comes back when that panel already failed.
 */
export function addFailure(
  failures: readonly PanelError[],
  error: PanelError,
): readonly PanelError[] {
  return failures.some((other) => other.panel === error.panel) ? failures : [...failures, error];
}

/**
 * Whether two contribution lists describe the same panels: the same extensions, panel IDs,
 * titles and components, in order. A host that passes an equal inline array on each render
 * keeps its panels mounted and their failures recorded.
 */
export function contributionsEqual(a: readonly UiExtension[], b: readonly UiExtension[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((entry, index) => {
        const other = b[index]!;
        return (
          entry.extension === other.extension &&
          entry.panels.length === other.panels.length &&
          entry.panels.every((panel, at) => {
            const twin = other.panels[at]!;
            return (
              panel.id === twin.id &&
              panel.title === twin.title &&
              panel.component === twin.component
            );
          })
        );
      }))
  );
}
