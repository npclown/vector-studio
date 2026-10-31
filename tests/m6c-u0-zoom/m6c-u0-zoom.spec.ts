import type { TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import type { TextTestHook } from '../../apps/next-host/src/m6a-text-host';
import { A12_CASES, FAMILY, type Case } from '../m6a-next-host/m6a-cases';

// M6c-U0 (MVP M6c contract, section 3; docs/evidence/m6c-u0/README.md): under a real device scale
// the page is laid out at that zoom, and Chromium rounds font metrics to whole layout px there,
// which moved the port's positions by up to 1/32 px before U0. text-dom now reads the layout zoom
// `E` and sets `zoom: 1/E` on its measurement host, multiplying what it reads back by `E`. This
// spec gates that path: the port's layouts under `--force-device-scale-factor` 1.25 and 1.875
// equal the same port's at DPR 1 (lines and clusters identical, every length within 1/64 px).
// The reference is the port, not the page's flowed blocks, which keep the page zoom's rounding
// and differ by up to 1/32 px by design. It also checks that the host carries `zoom: 1/E` and
// that requests at a stable ratio change no host style (no repeated detection).

type TextHolder = Readonly<{ text: TextTestHook }>;
type Port = TextHolder['text']['port'];

const BOUND = 1 / 64;
const SCALES = [1.25, 1.875] as const;
/** Every A12 case in the fixture's family (the others need families this spec does not load). */
const CASES: readonly Case[] = A12_CASES.filter((c) =>
  c.request.runs.every((run) => run.family === FAMILY),
);
const HOST = 'vector-studio-text-measure';
const executablePath = process.env.M6C_U0_ZOOM_CHROMIUM;

async function open(page: Page) {
  await page.goto('/?test=1&fixture=text');
  await page.waitForFunction(
    () => (window as unknown as { __p5Host?: unknown }).__p5Host !== undefined,
  );
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
  await expect(status).toHaveAttribute('data-text-font', 'loaded');
}

function layoutAll(page: Page, requests: readonly TextLayoutRequest[]) {
  return page.evaluate((rs) => {
    const port: Port = (window as unknown as { __p5Host: TextHolder }).__p5Host.text.port;
    return rs.map((r) => port.layout(r));
  }, requests);
}

const shape = (r: TextLayoutResult) =>
  JSON.stringify([
    r.lines.map((l) => [l.start, l.end]),
    r.clusters.map((c) => [c.start, c.end, c.line]),
  ]);
const lengths = (r: TextLayoutResult): [string, number][] => [
  ['width', r.width],
  ['height', r.height],
  ...r.lines.flatMap((l, i) =>
    (['top', 'height', 'baseline', 'left', 'width'] as const).map((k): [string, number] => [
      `line ${i} ${k}`,
      l[k],
    ]),
  ),
  ...r.clusters.flatMap((c, i) =>
    (['x', 'y', 'advance'] as const).map((k): [string, number] => [`cluster ${i} ${k}`, c[k]]),
  ),
];

async function atScale(
  launch: (scale: number) => Promise<Browser>,
  scale: number,
): Promise<{
  results: TextLayoutResult[];
  zoom: string;
  ratio: number;
  mutations: number;
  errors: string[];
}> {
  const scaled = await launch(scale);
  try {
    const context = await scaled.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await open(page);
    const results = await layoutAll(
      page,
      CASES.map((c) => c.request),
    );
    const { zoom, ratio, mutations } = await page.evaluate(
      ({ tag, rs }) => {
        const port: Port = (window as unknown as { __p5Host: TextHolder }).__p5Host.text.port;
        const host = document.querySelector(tag) as HTMLElement;
        const observer = new MutationObserver(() => {});
        observer.observe(host, { attributes: true, attributeFilter: ['style'] });
        for (const r of rs) port.layout(r);
        const count = observer.takeRecords().length;
        observer.disconnect();
        return {
          zoom: host.style.getPropertyValue('zoom'),
          ratio: window.devicePixelRatio,
          mutations: count,
        };
      },
      { tag: HOST, rs: CASES.map((c) => c.request) },
    );
    return { results, zoom, ratio, mutations, errors };
  } finally {
    await scaled.close();
  }
}

test('M6c-U0: a real device scale gives the DPR 1 layouts within 1/64 px', async ({ browser }) => {
  expect(CASES.length).toBeGreaterThan(40);
  const reference = await (async () => {
    const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
    await open(page);
    const results = await layoutAll(
      page,
      CASES.map((c) => c.request),
    );
    const zoom = await page.evaluate(
      (tag) => (document.querySelector(tag) as HTMLElement).style.getPropertyValue('zoom'),
      HOST,
    );
    expect.soft(zoom, 'host zoom at DPR 1').toBe('1');
    await page.context().close();
    return results;
  })();
  const launch = (scale: number) =>
    chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
      args: [`--force-device-scale-factor=${scale}`],
    });
  const worst: Record<string, { delta: number; at: string }> = {};
  const problems: string[] = [];
  for (const scale of SCALES) {
    const { results, zoom, ratio, mutations, errors } = await atScale(launch, scale);
    expect.soft(errors, `page errors at scale ${scale}`).toEqual([]);
    // Playwright's context emulates DPR 1, so the ratio reads 1 while layout stays at `scale`:
    // the case `devicePixelRatio` cannot tell, which the layout unit reading does.
    expect.soft(Math.abs(ratio - 1), `ratio at scale ${scale}`).toBeLessThan(1e-6);
    expect.soft(Number(zoom), `host zoom at scale ${scale}`).toBeCloseTo(1 / scale, 6);
    expect.soft(mutations, `host style changes at a stable ratio, scale ${scale}`).toBe(0);
    let max = { delta: 0, at: '-' };
    results.forEach((result, index) => {
      const name = `scale ${scale}: ${CASES[index]!.name}`;
      if (shape(result) !== shape(reference[index]!)) {
        problems.push(`${name}: other lines or clusters`);
        return;
      }
      const want = lengths(reference[index]!);
      lengths(result).forEach(([field, value], k) => {
        const delta = Math.abs(value - want[k]![1]);
        if (delta > BOUND) problems.push(`${name}: ${field} ${value} against ${want[k]![1]}`);
        if (delta > max.delta) max = { delta, at: `${CASES[index]!.name}, ${field}` };
      });
    });
    worst[String(scale)] = max;
  }
  test.info().annotations.push({ type: 'max delta', description: JSON.stringify(worst) });
  expect(problems).toEqual([]);
});
