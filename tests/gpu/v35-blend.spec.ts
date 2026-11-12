import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneBlendMode,
  SceneClip,
  SceneColor,
  SceneEffect,
} from '@vector-studio/contracts';
import type { E23GradientPaintApi } from '../../apps/playground/src/e23-gradient-paint.js';
import { decodeFrame } from '../support/p4-clip-oracle.js';
import { blendOracle, compareBlend, cornerPixels } from '../support/v35-blend-oracle.js';

declare global {
  interface Window {
    __vectorStudioE23: E23GradientPaintApi;
  }
}

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), U4: blend roots on a GPU against
// the CPU oracle of tests/support/v35-blend-oracle.ts (V35-R2 to R4), on the E23 check page with
// `groups=isolated&effects=v0&blend=v0` (V35-A05, within 2/255 per channel). The scenes are
// rectangles on whole device pixels, so every pixel is fully in or out at 1x and 4x. A06: a scene
// without blend modes renders the same bytes under `blend=v0` and without it, with no split.
// A07: the splits per frame equal the sum over blend roots of the tile passes they composite in.
// `capture=0` keeps the production canvas usage (no E10 capture hook; at 1x the main pass draws
// into the canvas, which `blend: 'v0'` configures with TEXTURE_BINDING) and reads the presented
// frame back through a 2D canvas. SwiftShader runs it in the container
// (playwright.v35-swiftshader.config.ts); `pnpm test:gpu` runs it headed on the reference PC.
// Each test writes its report under artifacts/v35-blend (or V35_OUTPUT_DIR).

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.V35_OUTPUT_DIR ?? 'artifacts/v35-blend',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);
const HOME: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };
const identity = { documentId: 'v35-u4', pageId: 'page' } as const;
const WIDTH = 512;
const HEIGHT = 320;
const TOLERANCE = 2;

const MODES: readonly SceneBlendMode[] = [
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'colorDodge',
  'colorBurn',
  'hardLight',
  'softLight',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];
const BANDS: readonly SceneColor[] = [
  { r: 0.9, g: 0.25, b: 0.15, a: 1 },
  { r: 0.15, g: 0.55, b: 0.85, a: 1 },
  { r: 0.95, g: 0.85, b: 0.35, a: 1 },
  { r: 0.35, g: 0.3, b: 0.4, a: 1 },
];
const SOURCE_A: SceneColor = { r: 0.3, g: 0.7, b: 0.45, a: 0.75 };
const SOURCE_B: SceneColor = { r: 0.85, g: 0.4, b: 0.65, a: 0.9 };
const SHADE: SceneColor = { r: 0, g: 0, b: 0, a: 0.5 };

function rect(
  id: string,
  parentId: string | null,
  [x, y, width, height]: readonly [number, number, number, number],
  fill: SceneColor,
  extra: Partial<{ opacity: number; blendMode: SceneBlendMode }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width, height, cornerRadii: [0, 0, 0, 0] },
    style: { fill, stroke: null },
    ...(extra.blendMode === undefined ? {} : { blendMode: extra.blendMode }),
  };
}

function group(
  id: string,
  parentId: string | null,
  children: readonly string[],
  extra: Partial<{
    opacity: number;
    blendMode: SceneBlendMode;
    clip: SceneClip;
    effects: readonly SceneEffect[];
  }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'container',
    clip: extra.clip ?? null,
    children,
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
    ...(extra.blendMode === undefined ? {} : { blendMode: extra.blendMode }),
  };
}

/** The 4-colour backdrop: eight bands of 40 pixels, reaching past the target's sides. */
const backdrop = (): RenderNodeSnapshot[] =>
  Array.from({ length: 8 }, (_, index) =>
    rect(
      `band${index}`,
      null,
      [-8, index === 0 ? -8 : index * 40, WIDTH + 16, index === 0 || index === 7 ? 48 : 40],
      BANDS[index % 4]!,
    ),
  );

/** One column per mode, two leaf blend roots each (A at α 0.75; B at α 0.9 and opacity 0.8). */
function columns(prefix: string, parentId: string | null): RenderNodeSnapshot[] {
  return MODES.flatMap((mode, index) => [
    rect(`${prefix}${index}a`, parentId, [8 + index * 33, 16, 28, 136], SOURCE_A, {
      blendMode: mode,
    }),
    rect(`${prefix}${index}b`, parentId, [8 + index * 33, 168, 28, 136], SOURCE_B, {
      blendMode: mode,
      opacity: 0.8,
    }),
  ]);
}
const ids = (nodes: readonly RenderNodeSnapshot[]) => nodes.map((node) => node.id);

/** A V35-P2 fill container: three fills over one rectangle, the node's mode on the container. */
function multiFill(
  id: string,
  [x, y, width, height]: readonly [number, number, number, number],
  extra: Partial<{
    opacity: number;
    effects: readonly SceneEffect[];
    blendMode: SceneBlendMode;
  }> = {},
): RenderNodeSnapshot[] {
  const fills = [
    rect(`${id}\u0000fill0`, id, [x, y, width, height], { r: 0.2, g: 0.5, b: 0.9, a: 0.4 }),
    rect(
      `${id}\u0000fill1`,
      id,
      [x, y, width, height],
      { r: 0.9, g: 0.6, b: 0.2, a: 0.8 },
      {
        blendMode: 'multiply',
      },
    ),
    rect(
      `${id}\u0000fill2`,
      id,
      [x + width / 2, y, width / 2, height],
      { r: 0.4, g: 0.1, b: 0.6, a: 0.7 },
      {
        blendMode: 'screen',
      },
    ),
  ];
  return [group(id, null, ids(fills), extra), ...fills];
}

type Fixture = Readonly<{
  name: string;
  nodes: readonly RenderNodeSnapshot[];
  /** A07: the expected splits per frame, when the case checks them. */
  splits?: (tile: number | null) => number;
}>;

const tilePasses = (
  bound: readonly [number, number, number, number],
  leaves: readonly RenderNodeSnapshot[],
  tile: number | null,
) =>
  leaves.reduce((sum, leaf) => {
    if (tile === null) return sum + 1;
    const [x, y] = [leaf.transform[4], leaf.transform[5]];
    const geometry =
      leaf.kind === 'primitive' && leaf.geometry.kind === 'rectangle' ? leaf.geometry : null;
    const columnsHit =
      Math.floor((x + geometry!.width - 1 - bound[0]) / tile) -
      Math.floor((x - bound[0]) / tile) +
      1;
    const rowsHit =
      Math.floor((y + geometry!.height - 1 - bound[1]) / tile) -
      Math.floor((y - bound[1]) / tile) +
      1;
    return sum + columnsHit * rowsHit;
  }, 0);

function fixtures(): Fixture[] {
  const main = columns('m', null);
  const layerInner = rect('li', 'l', [4, 4, 250, 312], { r: 0.2, g: 0.8, b: 0.3, a: 0.6 });
  const layerColumns = columns('l', 'l');
  const effectColumns = columns('e', 'e');
  const clipColumns = columns('c', 'c');
  const rootChildren = [
    rect('cr1', 'cr', [300, 40, 150, 120], { r: 0.8, g: 0.2, b: 0.6, a: 0.9 }),
    rect(
      'cr2',
      'cr',
      [360, 100, 150, 140],
      { r: 0.1, g: 0.9, b: 0.9, a: 0.7 },
      { blendMode: 'exclusion' },
    ),
  ];
  const maskColumns = columns('k', 'k');
  return [
    {
      // P1's own corner coverage, without blending: its report keeps the unexcluded comparison.
      name: 'normal control',
      nodes: [
        ...backdrop(),
        ...main.map((node) =>
          Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'blendMode')),
        ),
      ] as RenderNodeSnapshot[],
      splits: () => 0,
    },
    {
      name: 'main target',
      nodes: [...backdrop(), ...main],
      splits: () => main.length,
    },
    {
      name: 'E25 layer',
      nodes: [
        ...backdrop(),
        group('l', null, ['li', ...ids(layerColumns)], { opacity: 0.8 }),
        layerInner,
        ...layerColumns,
      ],
      // The layer's bound is its content's: x from 4 (the inner rectangle), y from 4.
      splits: (tile) => tilePasses([4, 4, 498, 316], layerColumns, tile),
    },
    {
      name: 'effect root',
      nodes: [
        ...backdrop(),
        group('e', null, ['ei', ...ids(effectColumns)], {
          effects: [{ kind: 'dropShadow', color: SHADE, offsetX: 6, offsetY: 5, sigma: 0 }],
        }),
        rect('ei', 'e', [4, 4, 250, 300], { r: 0.2, g: 0.8, b: 0.3, a: 0.6 }),
        ...effectColumns,
      ],
    },
    {
      // E41 U5b: L reaches past the target's left side, so its shadow is drawn from shifted
      // passes, and the blend roots there composite with the shifted variants.
      name: 'effect root past the target',
      nodes: [
        ...backdrop(),
        group('s', null, ['si', 's1', 's2'], {
          effects: [{ kind: 'dropShadow', color: SHADE, offsetX: 40, offsetY: 0, sigma: 0 }],
        }),
        rect('si', 's', [-48, 40, 120, 220], { r: 0.2, g: 0.8, b: 0.3, a: 0.6 }),
        rect('s1', 's', [-40, 60, 60, 80], SOURCE_A, { blendMode: 'hardLight' }),
        rect('s2', 's', [-36, 160, 70, 80], SOURCE_B, { blendMode: 'color', opacity: 0.8 }),
      ],
    },
    {
      name: 'clip',
      nodes: [
        ...backdrop(),
        group('c', null, [...ids(clipColumns), 'cr'], {
          clip: { kind: 'rect', x: 20, y: 30, width: 400, height: 250 },
        }),
        ...clipColumns,
        group('cr', 'c', ids(rootChildren), { blendMode: 'difference', opacity: 0.9 }),
        ...rootChildren,
      ],
    },
    {
      name: 'mask',
      nodes: [
        ...backdrop(),
        group('k', null, ['ks', ...ids(maskColumns)], { clip: { kind: 'mask' } }),
        rect('ks', 'k', [40, 50, 380, 200], { r: 1, g: 1, b: 1, a: 1 }),
        ...maskColumns,
      ],
    },
    {
      // R3: a multi-fill node blending through; isolated under opacity 0.5; under a drop shadow.
      // R4: the children of a passThrough versus a normal container.
      name: 'R3 and R4',
      nodes: [
        ...backdrop(),
        ...multiFill('f1', [16, 16, 150, 130]),
        ...multiFill('f2', [180, 16, 150, 130], { opacity: 0.5 }),
        ...multiFill('f3', [344, 16, 150, 130], {
          effects: [{ kind: 'dropShadow', color: SHADE, offsetX: 4, offsetY: 6, sigma: 0 }],
        }),
        group('p', null, ['p1', 'p2']),
        rect('p1', 'p', [16, 170, 180, 120], { r: 0.95, g: 0.95, b: 0.2, a: 0.6 }),
        rect(
          'p2',
          'p',
          [90, 200, 180, 100],
          { r: 0.2, g: 0.4, b: 0.9, a: 0.85 },
          { blendMode: 'colorBurn' },
        ),
        group('n', null, ['n1', 'n2'], { blendMode: 'normal' }),
        rect('n1', 'n', [290, 170, 180, 120], { r: 0.95, g: 0.95, b: 0.2, a: 0.6 }),
        rect(
          'n2',
          'n',
          [330, 200, 170, 100],
          { r: 0.2, g: 0.4, b: 0.9, a: 0.85 },
          { blendMode: 'colorBurn' },
        ),
      ],
    },
  ];
}

function snapshot(nodes: readonly RenderNodeSnapshot[]): RenderSceneSnapshot {
  return {
    identity,
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  };
}

type PageOptions = Readonly<{
  samples: 1 | 4;
  blend: boolean;
  tile?: number;
  /** false: the production canvas usage, read back through a 2D canvas. */
  capture?: boolean;
}>;

async function open(page: Page, options: PageOptions) {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 800 });
  const query = new URLSearchParams({
    samples: String(options.samples),
    dpr: '1',
    groups: 'isolated',
    effects: 'v0',
  });
  if (options.blend) query.set('blend', 'v0');
  if (options.tile !== undefined) query.set('tile', String(options.tile));
  if (options.capture === false) query.set('capture', '0');
  await page.goto(`/e23-gradient-paint.html?${query.toString()}`);
  const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
  expect(ready.supported, JSON.stringify(ready)).toBe(true);
  return { ready, pageErrors };
}

async function render(page: Page, nodes: readonly RenderNodeSnapshot[]) {
  const result = await page.evaluate(
    ([scene, view]) => window.__vectorStudioE23.render(scene, view),
    [snapshot(nodes), HOME] as const,
  );
  expect(result.status).toBe('applied');
  expect([result.frame.width, result.frame.height]).toEqual([WIDTH, HEIGHT]);
  return { result, rgba: decodeFrame(result.frame.rgbaBase64) };
}

/** A07: the splits of one frame, from two renders of the same scene (counters are totals). */
async function splitsPerFrame(page: Page, nodes: readonly RenderNodeSnapshot[]) {
  const first = await render(page, nodes);
  const second = await render(page, nodes);
  const frames =
    second.result.counters.statistics.framesSubmitted -
    first.result.counters.statistics.framesSubmitted;
  const splits = second.result.counters.blendSplits - first.result.counters.blendSplits;
  return { frames, splits, perFrame: frames > 0 ? splits / frames : Number.NaN };
}

function writeReport(name: string, report: unknown) {
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(path.join(runRoot, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

for (const samples of [1, 4] as const) {
  test(`V35-A05 and A07 blend roots against the oracle at ${samples}x`, async ({ browser }) => {
    test.setTimeout(600_000);
    const pages = {
      plain: await browser.newPage(),
      tiled: await browser.newPage(),
      production: await browser.newPage(),
    };
    const plain = await open(pages.plain, { samples, blend: true });
    const tiled = await open(pages.tiled, { samples, blend: true, tile: 64 });
    const production = await open(pages.production, { samples, blend: true, capture: false });
    const report: Record<string, unknown> = { samples, adapter: plain.ready.adapter, cases: [] };
    const failures: string[] = [];
    for (const fixture of fixtures()) {
      const expected = blendOracle(fixture.nodes, WIDTH, HEIGHT);
      const corners = cornerPixels(fixture.nodes, WIDTH, HEIGHT);
      for (const [variant, page, tile] of [
        ['capture', pages.plain, null],
        ['tile 64', pages.tiled, 64],
        ['production usage', pages.production, null],
      ] as const) {
        // The production check covers the main target and R3/R4 (the canvas as parent target).
        if (
          variant === 'production usage' &&
          !['main target', 'R3 and R4'].includes(fixture.name)
        ) {
          continue;
        }
        const { result, rgba } = await render(page, fixture.nodes);
        expect(result.counters.blendPipelineAvailable).toBe(true);
        const comparison = compareBlend(rgba, expected, TOLERANCE, corners);
        const entry: Record<string, unknown> = {
          fixture: fixture.name,
          variant,
          comparison,
          cornerPixels: corners.reduce((sum, value) => sum + value, 0),
          ...(fixture.name === 'normal control'
            ? { withCorners: compareBlend(rgba, expected, TOLERANCE) }
            : {}),
          packetBlends: result.frame.packet?.layers?.layers.filter((layer) => layer.blend !== null)
            .length,
          parentLayers: result.frame.packet?.layers?.layers
            .filter((layer) => layer.blend === null)
            .map((layer) => ({ nodeId: layer.nodeId, bound: layer.bound })),
          blendNotices: result.frame.packet?.layers?.blendNotices,
        };
        if (fixture.splits !== undefined && variant !== 'production usage') {
          const measured = await splitsPerFrame(page, fixture.nodes);
          entry.splits = { ...measured, expected: fixture.splits(tile) };
          if (measured.perFrame !== fixture.splits(tile)) {
            failures.push(`${fixture.name} (${variant}): ${measured.perFrame} splits per frame`);
          }
        }
        (report.cases as unknown[]).push(entry);
        if (comparison.worst > TOLERANCE) {
          failures.push(
            `${fixture.name} (${variant}): worst ${comparison.worst} at ${JSON.stringify(comparison.at)}`,
          );
        }
      }
    }
    report.pageErrors = [...plain.pageErrors, ...tiled.pageErrors, ...production.pageErrors];
    report.failures = failures;
    writeReport(`a05-${samples}x`, report);
    expect(report.pageErrors).toEqual([]);
    expect(failures, JSON.stringify(report.cases, null, 2)).toEqual([]);
    await Promise.all(Object.values(pages).map((page) => page.close()));
  });

  test(`V35-A06 no blend root draws the same bytes without a split at ${samples}x`, async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const blendPage = await browser.newPage();
    const nonePage = await browser.newPage();
    await open(blendPage, { samples, blend: true });
    await open(nonePage, { samples, blend: false });
    const nodes = [
      ...backdrop(),
      group('g', null, ['g1', 'g2'], { opacity: 0.6 }),
      rect('g1', 'g', [30, 30, 200, 150], SOURCE_A),
      rect('g2', 'g', [120, 90, 200, 150], SOURCE_B),
      group('e', null, ['e1'], {
        effects: [{ kind: 'dropShadow', color: SHADE, offsetX: 8, offsetY: 6, sigma: 3 }],
      }),
      rect('e1', 'e', [330, 60, 140, 200], SOURCE_A),
    ];
    const withBlend = await render(blendPage, nodes);
    const without = await render(nonePage, nodes);
    const measured = await splitsPerFrame(blendPage, nodes);
    writeReport(`a06-${samples}x`, {
      samples,
      identical: Buffer.compare(Buffer.from(withBlend.rgba), Buffer.from(without.rgba)) === 0,
      splits: measured,
      noneSplits: without.result.counters.blendSplits,
      nonePipeline: without.result.counters.blendPipelineAvailable,
    });
    expect(Buffer.compare(Buffer.from(withBlend.rgba), Buffer.from(without.rgba))).toBe(0);
    expect(measured.splits).toBe(0);
    expect(without.result.counters.blendSplits).toBe(0);
    expect(without.result.counters.blendPipelineAvailable).toBe(false);
    await blendPage.close();
    await nonePage.close();
  });
}

/** U4 (K8): a five-point star path at `[x, y]`, so that the scene has a mesh to build. */
function star(
  id: string,
  parentId: string | null,
  [x, y]: readonly [number, number],
  size: number,
  fill: SceneColor,
  blendMode?: SceneBlendMode,
): RenderNodeSnapshot {
  const points: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = (index % 2 === 0 ? 0.5 : 0.22) * size;
    points.push(size / 2 + radius * Math.cos(angle), size / 2 + radius * Math.sin(angle));
  }
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: ['move', ...Array.from({ length: 9 }, () => 'line' as const), 'close'],
      points,
      fillRule: 'nonzero',
    },
    style: { fill, stroke: null },
    ...(blendMode === undefined ? {} : { blendMode }),
  };
}

test('V35-A07 blend-mode and fill edits cost no geometry build', async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await browser.newPage();
  const { pageErrors } = await open(page, { samples: 4, blend: true });
  const fills = multiFill('f', [40, 40, 160, 120]);
  const nodes = [
    ...backdrop(),
    ...fills,
    group('g', null, ['g1', 'g2']),
    star('g1', 'g', [240, 40], 140, SOURCE_A, 'multiply'),
    rect('g2', 'g', [300, 120, 160, 120], SOURCE_B),
  ];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const node = (id: string) => byId.get(id)!;
  const withMode = (id: string, blendMode?: SceneBlendMode) => {
    const rest = Object.fromEntries(
      Object.entries(node(id)).filter(([key]) => key !== 'blendMode'),
    ) as RenderNodeSnapshot;
    return blendMode === undefined ? rest : { ...rest, blendMode };
  };
  const shown = await page.evaluate(([scene, view]) => window.__vectorStudioE23.show(scene, view), [
    snapshot(nodes),
    HOME,
  ] as const);
  expect(shown.status).toBe('applied');
  const edits: Record<string, readonly RenderNodeSnapshot[]> = {
    // A node mode edit on a path leaf (a leaf blend root to another mode, then to normal).
    leafMode: [withMode('g1', 'screen')],
    leafNormal: [withMode('g1')],
    leafBack: [withMode('g1', 'difference')],
    // A container mode: passThrough to a blend root, then an isolating container.
    containerMode: [withMode('g', 'overlay')],
    containerNormal: [withMode('g', 'normal')],
    // A fill's mode, opacity and paint inside a P2 container.
    fillMode: [withMode('f\u0000fill1', 'hardLight')],
    fillOpacity: [{ ...node('f\u0000fill2'), opacity: 0.5 }],
    fillPaint: [
      {
        ...node('f\u0000fill0'),
        style: { fill: { r: 0.6, g: 0.1, b: 0.2, a: 0.4 }, stroke: null },
      } as RenderNodeSnapshot,
    ],
  };
  let before = shown.counters;
  const rows: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const [name, updated] of Object.entries(edits)) {
    const edited = await page.evaluate(
      ([scene, changed]) => window.__vectorStudioE23.edit(scene, changed),
      [identity, updated] as const,
    );
    expect(edited.status, name).toBe('applied');
    const after = edited.counters;
    const cost = {
      portCalls: (after.pathMesh?.portCalls ?? 0) - (before.pathMesh?.portCalls ?? 0),
      geometryBuilds: after.preparation.geometryBuilds - before.preparation.geometryBuilds,
    };
    rows[name] = cost;
    if (cost.portCalls !== 0 || cost.geometryBuilds !== 0) failures.push(name);
    for (const changed of updated) byId.set(changed.id, changed);
    before = after;
  }
  writeReport('a07-edits', { rows, failures, pageErrors });
  expect(pageErrors).toEqual([]);
  expect(failures, JSON.stringify(rows)).toEqual([]);
  await page.close();
});
