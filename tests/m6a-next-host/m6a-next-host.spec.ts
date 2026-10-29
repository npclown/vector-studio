import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderCamera, TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';
import type { Editor, EditorEvent } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';
import type { E23GradientPaintApi } from '../../apps/playground/src/e23-gradient-paint.js';
import type { TextTestHook } from '../../apps/next-host/src/m6a-text-host';
import {
  A11_CASES,
  A12_CASES,
  CARRY_CASES,
  CJK_PUNCTUATION,
  EMOJI,
  FAMILY,
  GRAPHEME_40,
  SECOND,
  request,
  run,
  scaled,
  type Case,
} from './m6a-cases';
import { installProbe, type ProbeReport } from './m6a-probe';

// M6a-U6 (MVP M6a contract, sections 10 and 16): M6a-A11 and the emulated part of M6a-A12, the
// text-dom port of the next-host page on `?fixture=text` (the committed `text.v4.json` with the
// committed test font registered as `Noto Sans KR`), in headed Chrome and Edge. Every layout
// fixture, A11's and the M6a-U4 review r3 carry list's, is compared with an unprobed `pre-wrap`
// reference block (tests/m6a-next-host/m6a-probe.ts): line tops, line heights, the block height
// and each cluster's baseline, plus each cluster's canvas ink against its E28-K9 bound. Other
// tests: the fixture's committed structure, the font-load case, fallback with the main PC's
// fonts, A05's segmentation in Chrome, the 128-DEL family, sizes 0.5 and 4096 with the minimum
// font size probe, bidi isolation from the page's direction, one registered-font cluster drawn
// through the renderer with `text: 'atlas'` (the playground's E23 check page), DPR 1, 1.25, 1.5
// and 2 by CDP emulation with the generation bump on each change, and size linearity. Browser
// zoom and monitor scale are manual: docs/evidence/m6a-a12-dpr-manual.md.
//
// The `chromium-smoke` project (M6A_NEXT_HOST_CHROMIUM, playwright.m6a-next-host.config.ts) runs
// headless with SwiftShader and the container's fonts. It is a functional smoke run, not A11 or
// A12 evidence. Headless Chromium fires a `resolution` media query change under emulation only
// when the emulated size changes too, so each emulated DPR change also changes the height by
// 1 px (this explains M6a-U4 note 10's missing later events).

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
    /** The playground E23 check page (apps/playground/src/e23-gradient-paint.ts). */
    __vectorStudioE23: E23GradientPaintApi;
    /** Generation bumps of the page's port, counted by the spec's subscription. */
    __m6aBumps?: number;
  }
}

/** The hook's M6a member, declared apart as the M5 spec does for its member. */
type TextHolder = Readonly<{ text: TextTestHook }>;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FONT_BYTES = readFileSync(
  path.join(root, 'tests/fixtures/m6-text/fonts/NotoSansKR-Regular-subset.otf'),
);
const PLAYGROUND = 'http://127.0.0.1:4187';
/** Line and baseline agreement with the reference block (Chromium's 1/64 px layout unit). */
const TOLERANCE = 0.02;
/** A12: DPR changes keep positions within 1/64 px (M6-S0 found 0). */
const DPR_TOLERANCE = 1 / 64;
/** A12, section 3.2: size linearity within E28's quarter-pixel phase step. */
const LINEARITY_TOLERANCE = 0.25;
const DPRS = [1.25, 1.5, 2] as const;
const FIXTURE_IDS = ['t1', 't2', 't3', 't4', 't5', 't6'] as const;

const isSmoke = () => test.info().project.name === 'chromium-smoke';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&fixture=text');
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
  await expect(status).toHaveAttribute('data-text-font', 'loaded');
  await page.evaluate(installProbe);
  return { errors, status };
}

async function registerSecond(page: Page) {
  const status = await page.evaluate(
    (family) => (window.__p5Host as unknown as TextHolder).text.registerTestFont(family),
    SECOND,
  );
  expect(status).toBe('loaded');
}

function layoutAll(page: Page, values: readonly TextLayoutRequest[]) {
  return page.evaluate(
    (rs) => rs.map((r) => (window.__p5Host as unknown as TextHolder).text.port.layout(r)),
    values,
  );
}

const near = (a: number, b: number, tolerance = TOLERANCE) => Math.abs(a - b) <= tolerance;
const fixed = (value: number) => Number(value.toFixed(3));

/** The reference comparison of one case, as a list of problems (empty when it agrees). */
function referenceProblems(name: string, report: ProbeReport, disclosed: boolean): string[] {
  const problems: string[] = [];
  if (!disclosed && report.fallbacks !== 0) problems.push(`${name}: fallbacks ${report.fallbacks}`);
  if (report.inkOutside.length > 0) {
    problems.push(`${name}: ink outside E28-K9 ${JSON.stringify(report.inkOutside)}`);
  }
  if (disclosed) return problems;
  if (!near(report.height, report.refHeight)) {
    problems.push(`${name}: height ${report.height} against the reference ${report.refHeight}`);
  }
  report.lines.forEach((line, index) => {
    if (!near(line.top, line.refTop) || !near(line.height, line.refHeight)) {
      problems.push(
        `${name}: line ${index} top ${fixed(line.top)} height ${fixed(line.height)} against ${fixed(line.refTop)} ${fixed(line.refHeight)}`,
      );
    }
  });
  report.baselineDeltas.forEach((delta, index) => {
    if (!(Math.abs(delta) <= TOLERANCE)) {
      problems.push(`${name}: cluster ${index} baseline off the reference by ${delta}`);
    }
  });
  return problems;
}

/** Structural summary: line count and the line of each cluster. */
function structure(result: TextLayoutResult) {
  return {
    lines: result.lines.map((line) => [line.start, line.end]),
    clusters: result.clusters.map((cluster) => [cluster.start, cluster.end, cluster.line]),
  };
}

/** The structure in short: lines as `start-end`, and the line of each cluster in text order. */
function compact(result: TextLayoutResult) {
  return {
    lines: result.lines.map((line) => `${line.start}-${line.end}`).join(' '),
    clusterLines: result.clusters.map((cluster) => cluster.line).join(' '),
  };
}

/** Logical order, left to right, one line per vertical position (A11's RTL fixture). */
function orderProblems(name: string, result: TextLayoutResult): string[] {
  const problems: string[] = [];
  result.clusters.forEach((cluster, index) => {
    const line = result.lines[cluster.line]!;
    if (cluster.y !== line.baseline) problems.push(`${name}: cluster ${index} off its baseline`);
    const next = result.clusters[index + 1];
    if (next !== undefined && next.line === cluster.line) {
      if (!near(next.x, cluster.x + cluster.advance, 0.05)) {
        problems.push(
          `${name}: cluster ${index + 1} at ${next.x}, not after cluster ${index} (${cluster.x} + ${cluster.advance})`,
        );
      }
    }
  });
  result.lines.forEach((line, index) => {
    const previous = result.lines[index - 1];
    if (previous !== undefined && !(line.baseline > previous.baseline)) {
      problems.push(`${name}: line ${index} not below line ${index - 1}`);
    }
  });
  return problems;
}

/** Breaks and positions of `b` against `a`, after dividing `b` by `k`. */
function deltaProblems(
  name: string,
  a: TextLayoutResult,
  b: TextLayoutResult,
  k: number,
  tolerance: number,
): string[] {
  if (JSON.stringify(structure(a)) !== JSON.stringify(structure(b))) {
    return [
      `${name}: breaks differ ${JSON.stringify(structure(a))} ${JSON.stringify(structure(b))}`,
    ];
  }
  let worst = 0;
  let where = '';
  const at = (field: string, x: number, y: number) => {
    const delta = Math.abs(x - y / k);
    if (delta > worst) {
      worst = delta;
      where = `${field} ${x} against ${y / k}`;
    }
  };
  at('box width', a.width, b.width);
  at('box height', a.height, b.height);
  a.lines.forEach((line, index) => {
    const other = b.lines[index]!;
    for (const key of ['top', 'height', 'baseline', 'left', 'width'] as const) {
      at(`line ${index} ${key}`, line[key], other[key]);
    }
  });
  a.clusters.forEach((cluster, index) => {
    const other = b.clusters[index]!;
    for (const key of ['x', 'y', 'advance'] as const) {
      at(`cluster ${index} ${key}`, cluster[key], other[key]);
    }
  });
  return worst <= tolerance ? [] : [`${name}: ${where} (${worst})`];
}

test('M6a-A11: the test font registers and the fixture lays out its committed structure', async ({
  page,
}) => {
  const { errors, status } = await open(page);
  await expect(status).toHaveAttribute('data-nodes', /\d+/);
  const state = await page.evaluate(async (ids) => {
    const text = (window.__p5Host as unknown as TextHolder).text;
    const registration = await text.testFont;
    const faces = Array.from(document.fonts)
      .filter((face) => face.family.replaceAll('"', '') === text.family)
      .map((face) => face.status);
    const editor = window.__p5Host!.editor;
    return {
      registration,
      faces,
      generation: text.port.generation,
      fallbacks: text.port.fallbacks,
      bumps: window.__p5Host!.events.filter(
        (event) => event.type === 'session' && event.field === 'textLayout',
      ).length,
      layouts: ids.map((id) => editor.query({ type: 'textLayout', id })),
    };
  }, FIXTURE_IDS);
  expect(state.registration).toBe('loaded');
  expect(state.faces).toEqual(['loaded']);
  // The registration's two bumps (the registry change and the face settling, U5 note 7) on
  // an instance that started at the realm counter's next value (0 for the production page's
  // one instance), so the generation is at least 2.
  expect(state.generation).toBeGreaterThanOrEqual(2);
  expect(state.bumps).toBeGreaterThan(0);
  const layouts = state.layouts.map((value, index) => {
    expect(value, FIXTURE_IDS[index]).not.toBeNull();
    return value!;
  });
  for (const value of layouts) expect(value.generation).toBe(state.generation);
  expect(layouts[0]!.fontLists).toEqual([
    '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  ]);
  const actual = Object.fromEntries(FIXTURE_IDS.map((id, index) => [id, compact(layouts[index]!)]));
  // The committed structure of the nodes whose runs all name the test font (t2's `Inter` runs
  // fall back to a machine's own faces, so only its forced lines are committed below).
  expect({ ...actual, t2: undefined }).toEqual({ ...EXPECTED_STRUCTURE, t2: undefined });
  const t2 = layouts[1]!;
  const lf = '안녕하세요 '.length + 'big'.length;
  expect(t2.lines.some((line) => line.start === lf + 1)).toBe(true);
  expect(
    t2.clusters.filter((cluster) => cluster.end - cluster.start > 1).map((c) => [c.start, c.end]),
  ).toEqual(EXPECTED_T2_LONG_CLUSTERS);
  expect(state.fallbacks).toBe(0);
  test.info().annotations.push({
    type: 'fixture',
    description: JSON.stringify({ generation: state.generation, bumps: state.bumps }),
  });
  expect(errors).toEqual([]);
});

test('M6a-A11: a face loading after the first layout re-lays out with no document event', async ({
  page,
}) => {
  const { errors } = await open(page);
  const family = 'M6a Late Font';
  const created = await page.evaluate(
    (runs) => {
      const editor = window.__p5Host!.editor;
      const result = editor.execute({
        type: 'createText',
        frame: { x: 40, y: 320, width: 0, height: 0 },
        runs,
      });
      return result.ok ? (result.ids[0] ?? null) : null;
    },
    [{ ...run('Hello 한글 late', 20, family), color: { r: 0, g: 0, b: 0, a: 1 } }],
  );
  expect(created).not.toBeNull();
  const id = created!;
  const before = await page.evaluate((nodeId) => {
    const host = window.__p5Host!;
    const node = host.editor.getSnapshot().document.nodes[nodeId]!;
    const text = (host as unknown as TextHolder).text;
    return {
      frame: node.frame,
      generation: text.port.generation,
      events: host.events.length,
      layout: host.editor.query({ type: 'textLayout', id: nodeId })!,
    };
  }, id);
  const status = await page.evaluate(
    (name) => (window.__p5Host as unknown as TextHolder).text.registerTestFont(name),
    family,
  );
  expect(status).toBe('loaded');
  const after = await page.evaluate(
    ({ nodeId, from }) => {
      const host = window.__p5Host!;
      const text = (host as unknown as TextHolder).text;
      return {
        frame: host.editor.getSnapshot().document.nodes[nodeId]!.frame,
        generation: text.port.generation,
        events: host.events.slice(from),
        layout: host.editor.query({ type: 'textLayout', id: nodeId })!,
      };
    },
    { nodeId: id, from: before.events },
  );
  expect(after.generation).toBeGreaterThanOrEqual(before.generation + 2);
  expect(after.layout.generation).toBe(after.generation);
  expect(after.events.length).toBeGreaterThan(0);
  expect(after.events.every((e) => e.type === 'session' && e.field === 'textLayout')).toBe(true);
  expect(after.frame).toEqual(before.frame);
  expect(after.layout.width).not.toBe(before.layout.width);
  const refit = await page.evaluate((nodeId) => {
    const host = window.__p5Host!;
    const from = host.events.length;
    const result = host.editor.execute({ type: 'refitText', ids: [nodeId] });
    return {
      ok: result.ok,
      frame: host.editor.getSnapshot().document.nodes[nodeId]!.frame,
      documentEvents: host.events.slice(from).filter((event) => event.type === 'document').length,
    };
  }, id);
  expect(refit.ok).toBe(true);
  expect(refit.documentEvents).toBe(1);
  expect(refit.frame.width).toBe(after.layout.width);
  expect(refit.frame.height).toBe(after.layout.height);
  expect(errors).toEqual([]);
});

test('M6a-A11: a missing family and Hangul in a Latin-only family fall back', async ({ page }) => {
  const { errors } = await open(page);
  const result = await page.evaluate(
    ({ family, sample, hangul }) => {
      const text = (window.__p5Host as unknown as TextHolder).text;
      const req = (runFamily: string, value: string) => ({
        runs: [{ text: value, family: runFamily, size: 20 }],
        width: null,
        align: 'left' as const,
        letterSpacing: 0,
        lineHeight: 1.2,
      });
      const canvas = new OffscreenCanvas(8, 8).getContext('2d')!;
      const installed = (name: string) =>
        ['monospace', 'serif'].some((generic) => {
          canvas.font = `40px ${generic}`;
          const plain = canvas.measureText('abcdefghijklmnopqrstuvwxyz').width;
          canvas.font = `40px "${name}", ${generic}`;
          return canvas.measureText('abcdefghijklmnopqrstuvwxyz').width !== plain;
        });
      const latin = ['Arial', 'Segoe UI', 'DejaVu Sans', 'Liberation Sans'].find(installed) ?? null;
      const pick = (r: TextLayoutResult) => r.clusters.map((c) => [c.x, c.advance]);
      return {
        latin,
        missing: pick(text.port.layout(req('M6a Missing Family', sample))),
        tail: pick(text.port.layout(req('Malgun Gothic', sample))),
        registered: pick(text.port.layout(req(family, sample))),
        latinOnly: latin === null ? null : text.port.layout(req(latin, hangul)),
        tailHangul: text.port.layout(req('Malgun Gothic', hangul)),
        /** The canvas width of the Latin part, kerning included. */
        canvas:
          latin === null
            ? null
            : (() => {
                canvas.font = `20px "${latin}"`;
                return canvas.measureText(hangul.slice(0, hangul.indexOf('한'))).width;
              })(),
      };
    },
    { family: FAMILY, sample: 'Hello 한글', hangul: 'Vector 한글' },
  );
  // The missing family resolves through the font list's tail, as a run naming its first family.
  expect(result.missing).toEqual(result.tail);
  expect(result.missing).not.toEqual(result.registered);
  test.info().annotations.push({ type: 'latin-only family', description: String(result.latin) });
  expect(result.latin, 'a Latin-only family is installed').not.toBeNull();
  // Latin from the Latin-only face (the first Hangul cluster starts where the Latin face's
  // canvas width ends); each Hangul cluster from the same face as the tail's.
  const latinOnly = result.latinOnly!;
  expect(latinOnly.clusters[7]!.x).toBeCloseTo(result.canvas!, 1);
  expect(latinOnly.clusters.slice(7).map((c) => c.advance)).toEqual(
    result.tailHangul.clusters.slice(7).map((c) => c.advance),
  );
  expect(errors).toEqual([]);
});

test('M6a-A11: every fixture agrees with an unprobed reference block', async ({ page }) => {
  const { errors } = await open(page);
  await registerSecond(page);
  const cases: readonly Case[] = [...A11_CASES, ...CARRY_CASES];
  const reports = await page.evaluate(
    (requests) => requests.map((r) => window.__m6aProbe!.compare(r)),
    cases.map((value) => value.request),
  );
  const byName = new Map(cases.map((value, index) => [value.name, reports[index]!]));
  const get = (name: string) => byName.get(name)!.result;
  const problems = cases.flatMap((value, index) =>
    referenceProblems(value.name, reports[index]!, value.fallbackDisclosed === true),
  );
  await test.info().attach('m6a-a11-reference.json', {
    contentType: 'application/json',
    body: JSON.stringify(
      cases.map((value, index) => {
        const report = reports[index]!;
        return {
          name: value.name,
          fallbacks: report.fallbacks,
          height: report.height,
          refHeight: report.refHeight,
          lines: report.lines,
          maxBaselineDelta: Math.max(0, ...report.baselineDeltas.map(Math.abs)),
        };
      }),
      null,
      1,
    ),
  });
  // Soft, so a mismatch is recorded and every clause below still runs.
  expect.soft(problems).toEqual([]);

  // Soft wrap: several lines, probes keeping every cluster on its line (`fallbacks` 0 above).
  expect(get('soft wrap').lines.length).toBeGreaterThan(1);
  // The zero-size strut: mixed sizes share one baseline in a line 1.2 x 40 tall.
  const mixed = get('mixed sizes (M6-S0)');
  expect(mixed.lines).toHaveLength(1);
  expect(mixed.lines[0]!.height).toBeCloseTo(48, 1);
  expect(new Set(mixed.clusters.map((c) => c.y)).size).toBe(1);
  // Sentinel lines: `lineHeight x size` tall, no cluster on them; their baseline is the
  // fallback face's (U+200B is not in the subset), so it is not compared with the test font.
  const final = get('final LF (sentinel)');
  expect(final.lines).toHaveLength(2);
  expect(final.lines[1]!.height).toBeCloseTo(24, 1);
  expect(final.clusters.every((c) => c.line === 0)).toBe(true);
  const empty = get('empty text');
  expect(empty.lines).toHaveLength(1);
  expect(empty.clusters).toHaveLength(0);
  expect(empty.lines[0]!.height).toBeCloseTo(24, 1);
  expect(get('empty middle line').lines[1]!.height).toBeCloseTo(24, 1);
  expect(get('lineHeight 0.5').lines.length).toBeGreaterThan(1);
  // CJK punctuation: no trimming and no autospace, so each cluster advances by its own width.
  const cjk = get('CJK punctuation');
  const widths = await page.evaluate(
    ({ pieces, fontList }) => pieces.map((p) => window.__m6aProbe!.canvasWidth(p, 20, fontList)),
    {
      pieces: cjk.clusters.map((c) => CJK_PUNCTUATION.slice(c.start, c.end)),
      fontList: cjk.fontLists[0]!,
    },
  );
  cjk.clusters.forEach((cluster, index) => {
    expect(cluster.advance, CJK_PUNCTUATION.slice(cluster.start, cluster.end)).toBeCloseTo(
      widths[index]!,
      1,
    );
  });
  // RTL in logical order, left to right, one line per vertical position.
  const ordered = ['RTL', '(e) RTL run broken by an LF', '(e) RTL over two runs'];
  expect(ordered.flatMap((name) => orderProblems(name, get(name)))).toEqual([]);
  expect(orderProblems('(e) mixed RTL, LF and wrap', get('(e) mixed RTL, LF and wrap'))).toEqual(
    [],
  );
  // Long graphemes (M6a-L1): pieces of 32 units, a cut moved before a surrogate pair.
  const g40 = get('40-unit grapheme').clusters;
  expect(g40.map((c) => [c.start, c.end])).toEqual([
    [0, 31],
    [31, 40],
    [40, 41],
  ]);
  expect(g40[1]!.advance).toBe(0);
  expect(g40[1]!.x).toBe(g40[0]!.x);
  expect(get('70-unit grapheme').clusters.map((c) => [c.start, c.end, c.advance === 0])).toEqual([
    [0, 32, false],
    [32, 64, true],
    [64, 70, true],
  ]);
  expect(GRAPHEME_40).toHaveLength(40);
  // A05's emoji sequences segment in Chrome as in Node.
  expect(get('emoji ZWJ sequences').clusters.map((c) => [c.start, c.end])).toEqual(
    nodeSegments(EMOJI),
  );
  // Alignment and negative spacing (M6a-L1).
  const right = get('right aligned');
  for (const line of right.lines) expect(line.left).toBeCloseTo(Math.max(0, 50 - line.width), 9);
  expect(right.clusters[0]!.x).toBeCloseTo(right.lines[0]!.left, 1);
  const centred = get('centred');
  for (const line of centred.lines) {
    expect(line.left).toBeCloseTo(Math.max(0, (50 - line.width) * 0.5), 9);
  }
  expect(centred.clusters[0]!.x).toBeCloseTo(centred.lines[0]!.left, 1);
  const negative = get('negative letter spacing');
  expect(negative.clusters.every((c) => c.advance < 0)).toBe(true);
  expect(negative.width).toBe(0);
  // (d) the pen re-anchors at a run start; a one-cluster negative run reports advance 0.
  const anchor = get('(d) anchor').clusters[2]!;
  expect(Math.abs(anchor.x)).toBeLessThanOrEqual(TOLERANCE);
  expect(anchor.advance).toBeLessThan(0);
  const one = get('(d) one-cluster negative run').clusters[0]!;
  expect([one.x, one.advance]).toEqual([0, 0]);
  // (g) the zero-size strut's pitch at low lineHeight is at least lineHeight x size.
  const pitches: Record<string, number[]> = {};
  for (const [name, lineHeight] of [
    ['(g) lineHeight 0.1', 0.1],
    ['(g) lineHeight 0.3', 0.3],
    ['(g) lineHeight 0.5', 0.5],
  ] as const) {
    const lines = get(name).lines;
    pitches[name] = lines.map((line) => fixed(line.height));
    for (const line of lines)
      expect(line.height).toBeGreaterThanOrEqual(lineHeight * 20 - TOLERANCE);
  }
  const disclosed = byName.get('(d) disclosed fallback')!;
  test.info().annotations.push(
    { type: '(g) pitches', description: JSON.stringify(pitches) },
    {
      type: '(d) disclosed fallback',
      description: JSON.stringify({
        fallbacks: disclosed.fallbacks,
        lines: disclosed.result.lines.length,
      }),
    },
  );
  // The section 4 disclosure (U4 note 4): this case falls back once; if it stops, the
  // disclosure is stale.
  expect(disclosed.fallbacks).toBe(1);
  expect(errors).toEqual([]);
});

function nodeSegments(value: string) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(value), (s) => [s.index, s.index + s.segment.length]);
}

test("M6a-A11 (A05's Chrome half): grapheme segmentation in Chrome equals Node's", async ({
  page,
}) => {
  const { errors } = await open(page);
  const fixture = JSON.parse(
    readFileSync(path.join(root, 'tests/fixtures/m6-text/text.v4.json'), 'utf8'),
  ) as { nodes: Record<string, { type: string; runs?: { text: string }[] }> };
  const texts = [
    EMOJI,
    '\u{1f469}\u200d\u{1f4bb}',
    GRAPHEME_40,
    CJK_PUNCTUATION,
    'abc אבג def',
    ...Object.values(fixture.nodes)
      .filter((node) => node.type === 'text')
      .map((node) => node.runs!.map((r) => r.text).join('')),
  ];
  const chrome = await page.evaluate((values) => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return values.map((value) =>
      Array.from(segmenter.segment(value), (s) => [s.index, s.index + s.segment.length]),
    );
  }, texts);
  expect(chrome).toEqual(texts.map(nodeSegments));
  expect(errors).toEqual([]);
});

test('M6a-A11 (carry list f): a 128-DEL family registers and lays out', async ({ page }) => {
  const { errors } = await open(page);
  const family = '\u007f'.repeat(128);
  const status = await page.evaluate(
    (name) => (window.__p5Host as unknown as TextHolder).text.registerTestFont(name),
    family,
  );
  expect(status).toBe('loaded');
  const sample = 'Hello 한글';
  const [del, registered, missing] = await layoutAll(page, [
    request([run(sample, 20, family)]),
    request([run(sample, 20, FAMILY)]),
    request([run(sample, 20, 'M6a Missing Family')]),
  ]);
  expect(del!.fontLists[0]!.length).toBeLessThanOrEqual(512);
  const pick = (r: TextLayoutResult) => r.clusters.map((c) => [c.x, c.advance]);
  expect(pick(del!)).toEqual(pick(registered!));
  expect(pick(del!)).not.toEqual(pick(missing!));
  expect(errors).toEqual([]);
});

test('M6a-A11: sizes 0.5 and 4096 lay out, with no minimum font size clamp at 0.5', async ({
  page,
}) => {
  const { errors } = await open(page);
  const sample = 'Vector 한글 Studio';
  const [half, sixteen, huge] = await layoutAll(page, [
    request([run(sample, 0.5)]),
    request([run(sample, 16)]),
    request([run('A가', 4096)]),
  ]);
  expect(half!.lines).toHaveLength(1);
  expect(half!.clusters).toHaveLength(sample.length);
  expect(half!.width).toBeGreaterThan(0);
  expect(huge!.lines).toHaveLength(1);
  expect(huge!.height).toBeCloseTo(1.2 * 4096, 0);
  expect(huge!.width).toBeGreaterThan(4096);
  // M6-S0's minimum font size probe at 0.5: the width against 1/32 of the 16 px width.
  const ratio = half!.width / (sixteen!.width / 32);
  const clampSuspected = ratio > 1.02;
  test.info().annotations.push({
    type: 'minimum font size probe',
    description: JSON.stringify({
      width05: half!.width,
      width16: sixteen!.width,
      ratio,
      clampSuspected,
    }),
  });
  expect(clampSuspected).toBe(false);
  const fallbacks = await page.evaluate(
    () => (window.__p5Host as unknown as TextHolder).text.port.fallbacks,
  );
  expect(fallbacks).toBe(0);
  expect(errors).toEqual([]);
});

test("M6a-A11: the measurement block is isolated from the page's direction", async ({ page }) => {
  const { errors } = await open(page);
  const values = [
    request([run('abc אבג def')]),
    request([run('abc אב', 20), run('גד\nef', 30)], { width: 60 }),
    request([run('Hello wonderful world of text layout')], { width: 120, align: 'right' }),
  ];
  const ltr = await layoutAll(page, values);
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
    document.body.style.direction = 'rtl';
    document.body.style.unicodeBidi = 'bidi-override';
  });
  const rtl = await layoutAll(page, values);
  await page.evaluate(() => {
    document.documentElement.removeAttribute('dir');
    document.body.style.direction = '';
    document.body.style.unicodeBidi = '';
  });
  // Structural only: the same lines and the same clusters on them, in the same order.
  expect(rtl.map(structure)).toEqual(ltr.map(structure));
  for (const [index, result] of rtl.entries()) {
    const xs = result.clusters.map((c) => c.x);
    const ltrXs = ltr[index]!.clusters.map((c) => c.x);
    expect(xs.map((x, i) => Math.sign(x - (xs[i - 1] ?? x)))).toEqual(
      ltrXs.map((x, i) => Math.sign(x - (ltrXs[i - 1] ?? x))),
    );
  }
  expect(errors).toEqual([]);
});

test('M6a-A11 (carry list h): a registered-font cluster draws through the atlas renderer', async ({
  page,
  context,
}) => {
  const { errors } = await open(page);
  const [laid] = await layoutAll(page, [request([run('가', 40)])]);
  const cluster = laid!.clusters[0]!;
  const atlas = await context.newPage();
  const atlasErrors: string[] = [];
  atlas.on('pageerror', (error) => atlasErrors.push(error.message));
  await atlas.goto(`${PLAYGROUND}/e23-gradient-paint.html?text=atlas&samples=1`);
  await atlas.waitForFunction(() => window.__vectorStudioE23 !== undefined);
  await atlas.evaluate(() => window.__vectorStudioE23.ready);
  const registered = await atlas.evaluate(
    async ({ family, bytes }) => {
      const binary = atob(bytes);
      const buffer = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
      const face = new FontFace(family, buffer.buffer);
      document.fonts.add(face);
      await face.load();
      return face.status;
    },
    { family: FAMILY, bytes: FONT_BYTES.toString('base64') },
  );
  expect(registered).toBe('loaded');
  const camera: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };
  const draw = (fontList: string, generation: number) =>
    atlas.evaluate(({ value, view }) => window.__vectorStudioE23.readCluster(value, view), {
      value: {
        text: '가',
        fontList,
        lang: laid!.lang,
        size: 40,
        x: 40 + cluster.x,
        y: 40 + cluster.y,
        generation,
      },
      view: camera,
    });
  const fallbackList = '"M6a Unregistered", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  // The page's canvas raster port draws the registered face, not a fallback.
  const bitmaps = await atlas.evaluate(
    ({ lists, lang }) =>
      lists.map((fontList) =>
        window.__vectorStudioE23.rasterize({
          text: '가',
          fontList,
          lang,
          pixelSize: 40,
          phaseX: 0,
        }),
      ),
    { lists: [laid!.fontLists[0]!, fallbackList], lang: laid!.lang },
  );
  expect(bitmaps[0]!.status).toBe('ok');
  expect(JSON.stringify(bitmaps[0])).not.toBe(JSON.stringify(bitmaps[1]));
  const summary: Record<string, unknown> = {
    bitmap: bitmaps[0]!.status === 'ok' ? [bitmaps[0]!.width, bitmaps[0]!.height] : null,
  };
  if (isSmoke()) {
    // SwiftShader loses its device on present here, so no frame is read back (as M7-U6 notes).
    summary.frame = 'not read in the smoke project';
  } else {
    const face = await draw(laid!.fontLists[0]!, laid!.generation);
    const fallback = await draw(fallbackList, laid!.generation + 1);
    expect(face.status).toBe('applied');
    expect(face.rect).not.toBeNull();
    const ink = (frame: { width: number; rgbaBase64: string }) => {
      const rgba = Buffer.from(frame.rgbaBase64, 'base64');
      const lit: number[] = [];
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i]! > 64) lit.push(i / 4);
      return lit.map((p) => [p % frame.width, Math.floor(p / frame.width)] as const);
    };
    const faceInk = ink(face.frame);
    expect(faceInk.length).toBeGreaterThan(20);
    const rect = face.rect!;
    const outside = faceInk.filter(
      ([x, y]) =>
        x < rect.x - 1 ||
        x > rect.x + rect.width + 1 ||
        y < rect.y - 1 ||
        y > rect.y + rect.height + 1,
    );
    expect(outside).toEqual([]);
    // The frame drawn from the registered face differs from the fallback's.
    expect(JSON.stringify(ink(fallback.frame))).not.toBe(JSON.stringify(faceInk));
    summary.lit = faceInk.length;
    summary.rect = rect;
  }
  const diagnostics = await atlas.evaluate(() => window.__vectorStudioE23.diagnostics());
  test.info().annotations.push({
    type: '(h) atlas',
    description: JSON.stringify({ ...summary, diagnostics }),
  });
  expect(atlasErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test('M6a-A12: DPR 1, 1.25, 1.5 and 2 by emulation give the same layout and bump the generation', async ({
  page,
}) => {
  const { errors } = await open(page);
  await registerSecond(page);
  await page.evaluate(() => {
    window.__m6aBumps = 0;
    (window.__p5Host as unknown as TextHolder).text.port.subscribe(() => {
      window.__m6aBumps! += 1;
    });
  });
  const cdp = await page.context().newCDPSession(page);
  const viewport = page.viewportSize()!;
  const bumps: { dpr: number; bumped: boolean; generation: number }[] = [];
  const emulate = async (dpr: number) => {
    const before = await page.evaluate(() => window.__m6aBumps!);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      // A height that differs at each change: headless Chromium re-evaluates media queries, and
      // fires the `resolution` change, only when the emulated size changes too (checked in the
      // container); the layout requests do not depend on the viewport.
      height: viewport.height - bumps.length - 1,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await page.waitForFunction((value) => window.devicePixelRatio === value, dpr);
    const bumped = await page
      .waitForFunction((count) => window.__m6aBumps! > count, before, { timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    const generation = await page.evaluate(
      () => (window.__p5Host as unknown as TextHolder).text.port.generation,
    );
    bumps.push({ dpr, bumped, generation });
  };
  const requests = A12_CASES.map((value) => value.request);
  const initial = await page.evaluate(() => window.devicePixelRatio);
  if (initial !== 1) await emulate(1);
  const base = await layoutAll(page, requests);
  const problems: string[] = [];
  for (const dpr of [...DPRS, 1]) {
    await emulate(dpr);
    const results = await layoutAll(page, requests);
    results.forEach((result, index) => {
      problems.push(
        ...deltaProblems(
          `DPR ${dpr}: ${A12_CASES[index]!.name}`,
          base[index]!,
          result,
          1,
          DPR_TOLERANCE,
        ),
      );
      if (result.generation !== bumps.at(-1)!.generation) {
        problems.push(`DPR ${dpr}: ${A12_CASES[index]!.name} not at the current generation`);
      }
    });
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  test.info().annotations.push({ type: 'DPR bumps', description: JSON.stringify(bumps) });
  expect(problems).toEqual([]);
  // Each change raises the generation, so the listener is re-armed after each one.
  expect(bumps.filter((entry) => !entry.bumped)).toEqual([]);
  const textEvents = await page.evaluate(
    () =>
      window.__p5Host!.events.filter((e) => e.type === 'session' && e.field === 'textLayout')
        .length,
  );
  expect(textEvents).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('M6a-A12: size linearity, s and 4s at width 4w, within a quarter pixel', async ({ page }) => {
  const { errors } = await open(page);
  await registerSecond(page);
  const base = await layoutAll(
    page,
    A12_CASES.map((value) => value.request),
  );
  const large = await layoutAll(
    page,
    A12_CASES.map((value) => scaled(value.request, 4)),
  );
  const problems = A12_CASES.flatMap((value, index) =>
    deltaProblems(value.name, base[index]!, large[index]!, 4, LINEARITY_TOLERANCE),
  );
  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
});

/** Lines `[start, end]` and clusters `[start, end, line]` of the fixture's test-font nodes. */
const EXPECTED_STRUCTURE: Record<string, ReturnType<typeof compact> | undefined> = {
  t1: { lines: '0-5', clusterLines: '0 0 0 0 0' },
  t3: { lines: '0-0', clusterLines: '' },
  t4: { lines: '0-13 14-14 15-15', clusterLines: '0 0 0 0 0 0 0 0 0 0 0 0 0' },
  t5: { lines: '0-16 16-21', clusterLines: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 1 1 1 1' },
  t6: { lines: '0-15', clusterLines: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' },
};
/** t2's multi-unit clusters: the ZWJ sequence `👩\u200d💻`. */
const EXPECTED_T2_LONG_CLUSTERS: number[][] = [[16, 21]];
