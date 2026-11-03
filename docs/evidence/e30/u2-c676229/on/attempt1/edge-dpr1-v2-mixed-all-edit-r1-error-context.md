# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e26-harness.spec.ts >> e26-mixed-all-edit-10k/v2 r1
- Location: tests\e26\e26-harness.spec.ts:757:5

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator: getByTestId('status')
Expected: "bench-loaded"
Timeout: 90000ms
Error: element(s) not found

Call log:
  - Expect "toHaveAttribute" with timeout 90000ms
  - waiting for getByTestId('status')

```

```yaml
- main:
  - paragraph: loading editor
```

# Test source

```ts
  341 |   fontLoads: readonly {
  342 |     family: string;
  343 |     startMs: number;
  344 |     settledMs: number | null;
  345 |     endMs: number | null;
  346 |     status: string | null;
  347 |     generationBefore: number;
  348 |     generationAfter: number | null;
  349 |     bumps: number;
  350 |     lastBumpMs: number | null;
  351 |     revisionBefore: number;
  352 |     revisionAfter: number | null;
  353 |   }[];
  354 |   enterTextEdit(id: string, offset: number): { ok: boolean; code?: string };
  355 |   /** V20-U1: renders per counted component (`tests/v20/v20-render-count.spec.ts`). */
  356 |   renders(): Readonly<Record<string, number>>;
  357 |   /** V21-U1: the text probe's records (`tests/v21/v21-count.spec.ts`). */
  358 |   textDispatches(): readonly Readonly<Record<string, unknown>>[];
  359 | };
  360 | declare global {
  361 |   interface Window {
  362 |     __e26Bench?: PageHook;
  363 |     __e26Probe?: Probe;
  364 |   }
  365 | }
  366 | 
  367 | /** Page errors fail a run; console errors (a missing favicon, for one) are only recorded. */
  368 | async function installProbe(page: Page) {
  369 |   const errors: string[] = [];
  370 |   const consoleErrors: string[] = [];
  371 |   page.on('pageerror', (error) => errors.push(String(error)));
  372 |   page.on('console', (message) => {
  373 |     if (message.type() === 'error') consoleErrors.push(message.text());
  374 |   });
  375 |   await page.addInitScript(installPageProbe);
  376 |   return { errors, consoleErrors };
  377 | }
  378 | 
  379 | /** The page's environment: DPR, canvas, screen, an idle refresh estimate and the GPU adapter. */
  380 | async function environment(page: Page) {
  381 |   return page.evaluate(async () => {
  382 |     const canvas = document.querySelector('canvas')!;
  383 |     const stamps: number[] = [];
  384 |     await new Promise<void>((resolve) => {
  385 |       const step = (time: number) => {
  386 |         stamps.push(time);
  387 |         if (stamps.length < 61) requestAnimationFrame(step);
  388 |         else resolve();
  389 |       };
  390 |       requestAnimationFrame(step);
  391 |     });
  392 |     const intervals = stamps
  393 |       .slice(1)
  394 |       .map((time, index) => time - stamps[index]!)
  395 |       .sort((a, b) => a - b);
  396 |     let adapter: Record<string, string> | null = null;
  397 |     try {
  398 |       const gpu = (navigator as { gpu?: GPU }).gpu;
  399 |       const info = (await gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info;
  400 |       if (info !== undefined) {
  401 |         adapter = {
  402 |           vendor: info.vendor,
  403 |           architecture: info.architecture,
  404 |           device: info.device,
  405 |           description: info.description,
  406 |         };
  407 |       }
  408 |     } catch {
  409 |       adapter = null;
  410 |     }
  411 |     return {
  412 |       devicePixelRatio: window.devicePixelRatio,
  413 |       canvas: { width: canvas.width, height: canvas.height },
  414 |       screen: { width: screen.width, height: screen.height },
  415 |       idleRafMedianMs: intervals[Math.floor(intervals.length / 2)] ?? null,
  416 |       adapter,
  417 |       userAgent: navigator.userAgent,
  418 |     };
  419 |   });
  420 | }
  421 | 
  422 | /** Visibility and focus at a point of the run, with the probe's counts so far. */
  423 | async function presence(page: Page) {
  424 |   return page.evaluate(() => ({
  425 |     visibilityState: document.visibilityState,
  426 |     hasFocus: document.hasFocus(),
  427 |     visibilityChanges: window.__e26Probe!.visibilityChanges,
  428 |     blurs: window.__e26Probe!.blurs,
  429 |   }));
  430 | }
  431 | 
  432 | async function open(
  433 |   page: Page,
  434 |   query: string,
  435 |   errors: readonly string[],
  436 |   ui = false,
  437 |   budget = !ui,
  438 | ): Promise<void> {
  439 |   await page.goto(`/?bench=1&${query}${ui ? '&ui=1' : ''}`);
  440 |   const status = page.getByTestId('status');
> 441 |   await expect(status).toHaveAttribute('data-fixture', 'bench-loaded', { timeout: 90_000 });
      |                        ^ Error: expect(locator).toHaveAttribute(expected) failed
  442 |   await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 90_000 });
  443 |   expect(errors).toEqual([]);
  444 |   // M8-N3 (M8-U6): the layout budget against the 17a2b0a measurement of this project. M9-U1:
  445 |   // 17a2b0a had no 1600 x 1000 bench project, so a `ui=1` run checks the column itself.
  446 |   // V-20 `ui=0` runs in the v2 projects, which have no 17a2b0a row: no budget check (`budget`).
  447 |   if (ui) await expectM9Column(page);
  448 |   else if (budget) await expectLayoutBudget(page, { bench: true });
  449 |   // M9-U1: the v2 document never runs on system fallback fonts (the page also fails its load).
  450 |   if (query.includes('doc=m9-v2')) {
  451 |     await expect(status, 'the committed test font').toHaveAttribute('data-text-font', 'loaded');
  452 |   }
  453 |   // The loaded scene reached the GPU: one more submission after both are set, and its work done.
  454 |   await page.evaluate(async () => {
  455 |     const backend = window.__e26Bench!.backend()!;
  456 |     const before = backend.getStatistics().framesSubmitted;
  457 |     backend.invalidate({ reason: 'scene' });
  458 |     while (backend.getStatistics().framesSubmitted === before) {
  459 |       await new Promise((resolve) => requestAnimationFrame(resolve));
  460 |     }
  461 |     // A lost device rejects here; the run goes on so its record shows it (expectValidRun).
  462 |     await backend.waitForSubmittedWork().catch(() => undefined);
  463 |   });
  464 | }
  465 | 
  466 | /** The canvas content box (CSS px) and its backing size, and the side column's box. */
  467 | async function canvasGeometry(page: Page) {
  468 |   return page.evaluate(() => {
  469 |     const canvas = document.querySelector('canvas')!;
  470 |     const rect = canvas.getBoundingClientRect();
  471 |     const box = (testId: string) => {
  472 |       const element = document.querySelector(`[data-testid="${testId}"]`);
  473 |       if (element === null) return null;
  474 |       const value = element.getBoundingClientRect();
  475 |       return { left: value.left, top: value.top, width: value.width, height: value.height };
  476 |     };
  477 |     return {
  478 |       origin: { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop },
  479 |       size: { width: canvas.clientWidth, height: canvas.clientHeight },
  480 |       rightColumn: box('right-column'),
  481 |       // The bench's own aside: an Appearance panel outside the right column.
  482 |       aside:
  483 |         document
  484 |           .querySelector('[data-testid="appearance-panel"]')
  485 |           ?.closest('[data-testid="right-column"]') === null
  486 |           ? box('appearance-panel')
  487 |           : null,
  488 |       innerWidth: window.innerWidth,
  489 |       innerHeight: window.innerHeight,
  490 |       scrollWidth: document.documentElement.scrollWidth,
  491 |       clientWidth: document.documentElement.clientWidth,
  492 |       bench: window.__e26Bench !== undefined,
  493 |     };
  494 |   });
  495 | }
  496 | 
  497 | /** M9-U1 (section 4): with `ui=1`, the right column beside the 1280 x 720 canvas, all in view. */
  498 | async function expectM9Column(page: Page): Promise<void> {
  499 |   expect(page.viewportSize(), 'the v2 viewport').toEqual(M9_WINDOW);
  500 |   const live = await canvasGeometry(page);
  501 |   expect(live.size, 'canvas CSS size').toEqual({ width: 1280, height: 720 });
  502 |   expect(live.aside, 'no bench aside with ui=1').toBeNull();
  503 |   const column = live.rightColumn;
  504 |   expect(column, 'the right column').not.toBeNull();
  505 |   expect(column!.left + column!.width, 'the column fits the window').toBeLessThanOrEqual(
  506 |     live.innerWidth,
  507 |   );
  508 |   expect(column!.top + column!.height, 'the column fits the window').toBeLessThanOrEqual(
  509 |     live.innerHeight,
  510 |   );
  511 |   expect(live.scrollWidth, 'no horizontal scroll').toBeLessThanOrEqual(live.clientWidth);
  512 | }
  513 | 
  514 | /**
  515 |  * M9-U1 (section 4): clicks `layer-toggle-<id>` for each ID, page down, and returns the rows the
  516 |  * layer tree then shows. V-20 (contract, section 4): the list is windowed, so each toggle's row is
  517 |  * scrolled into view first, and the count is the rows' `aria-setsize`.
  518 |  */
  519 | async function expandLayers(page: Page, ids: readonly string[]): Promise<number> {
  520 |   await expandLayerRows(page, ids);
  521 |   return layerRowCount(page);
  522 | }
  523 | 
  524 | /** Runs editor commands in the page and checks each result. */
  525 | async function execute(page: Page, commands: readonly unknown[]): Promise<void> {
  526 |   const results = await page.evaluate((list) => {
  527 |     const editor = window.__e26Bench!.editor()!;
  528 |     return list.map((command) => editor.execute(command));
  529 |   }, commands as unknown[]);
  530 |   for (const [index, result] of results.entries()) {
  531 |     expect(result.ok, `command ${index}: ${result.code ?? ''}`).toBe(true);
  532 |   }
  533 | }
  534 | 
  535 | /** The client point of a world point at a camera, as CanvasInput inverts it. */
  536 | async function clientPoint(
  537 |   page: Page,
  538 |   camera: E26Camera,
  539 |   world: { x: number; y: number },
  540 | ): Promise<{ x: number; y: number }> {
  541 |   const origin = await page.evaluate(() => {
```