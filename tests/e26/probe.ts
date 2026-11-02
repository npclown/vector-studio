// E26-U1c and M9-U1 (E26 contract, section 3.5): the page probe of the headed harness, installed
// before the page loads (`page.addInitScript(installPageProbe)` in e26-harness.spec.ts). It
// records the press and release times of the latency drag, focus losses and visibility changes.
//
// Only presses and releases on the canvas count (M9-U1 pre-run fix): an M9 run clicks
// `layer-toggle-<id>` buttons in the layer tree before the drag, and those clicks are pointer
// events too. Counted, they made `downs[0]` a toggle click, so no latency sample fell in the
// press window, and the "one press" check failed. A press elsewhere goes to `otherDowns` (its
// target's test ID or tag), so the record shows it and the canvas-only invariant stays exact.
//
// `installPageProbe` runs in the page: Playwright serializes its source, so it must not use
// anything from this module's scope. tests/unit/m9-u1-probe.test.ts runs it against a stub.

/** The probe's state on `window.__e26Probe`. */
export type Probe = {
  /** Canvas press and release event timestamps (when the browser received the input). */
  downs: number[];
  ups: number[];
  /** When the capture listener handled each canvas press and release (`performance.now()`). */
  downsHandled: number[];
  upsHandled: number[];
  /** Presses and releases outside the canvas: the target's `data-testid`, or its tag name. */
  otherDowns: string[];
  otherUps: string[];
  visibilityChanges: number;
  blurs: number;
  /**
   * Uncaught errors and unhandled rejections with their stack and page time (`performance.now()`),
   * so a record can place a page error against the run's own marks (the M9-U1 pre-run's React
   * error #185 came during the font-load change).
   */
  pageErrors: {
    kind: 'error' | 'rejection';
    message: string;
    stack: string | null;
    atMs: number;
  }[];
};

/** Installs `window.__e26Probe`. Self-contained: it runs in the page (see the header). */
export function installPageProbe(): void {
  const probe: Probe = {
    downs: [],
    ups: [],
    downsHandled: [],
    upsHandled: [],
    otherDowns: [],
    otherUps: [],
    visibilityChanges: 0,
    blurs: 0,
    pageErrors: [],
  };
  (window as unknown as { __e26Probe: Probe }).__e26Probe = probe;
  // A capture listener on the window runs before the canvas handles the event, so these are the
  // events' own timestamps, not a later evaluate (U1c review S1). The canvas keeps pointer
  // capture through the drag, so its release targets the canvas too.
  const describe = (target: EventTarget | null): string => {
    const element = target as { tagName?: string; getAttribute?(name: string): string | null };
    return element?.getAttribute?.('data-testid') ?? element?.tagName ?? 'unknown';
  };
  // The editor's canvas is the one inside next-host's canvas host; a canvas elsewhere (a panel's)
  // is not an editor press.
  const onCanvas = (event: Event) =>
    event.target instanceof HTMLCanvasElement &&
    (event.target.closest?.('[data-testid="canvas-host"]') ?? null) !== null;
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!onCanvas(event)) {
        probe.otherDowns.push(describe(event.target));
        return;
      }
      probe.downs.push(event.timeStamp);
      probe.downsHandled.push(performance.now());
    },
    { capture: true },
  );
  window.addEventListener(
    'pointerup',
    (event) => {
      if (!onCanvas(event)) {
        probe.otherUps.push(describe(event.target));
        return;
      }
      probe.ups.push(event.timeStamp);
      probe.upsHandled.push(performance.now());
    },
    { capture: true },
  );
  const pageError = (kind: 'error' | 'rejection', value: unknown, fallback: string) => {
    const error = value as { message?: unknown; stack?: unknown } | null;
    probe.pageErrors.push({
      kind,
      message: typeof error?.message === 'string' ? error.message : fallback,
      stack: typeof error?.stack === 'string' ? error.stack : null,
      atMs: performance.now(),
    });
  };
  window.addEventListener('error', (event) => pageError('error', event.error, event.message));
  window.addEventListener('unhandledrejection', (event) =>
    pageError('rejection', event.reason, String(event.reason)),
  );
  window.addEventListener('blur', () => (probe.blurs += 1));
  document.addEventListener('visibilitychange', () => (probe.visibilityChanges += 1));
}
