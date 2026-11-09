import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneColor,
  SceneEffect,
} from '@vector-studio/contracts';
import type { E23GradientPaintApi } from '../../apps/playground/src/e23-gradient-paint.js';
import {
  effectOracle,
  oracleImage,
  oracleLevels,
  type OracleEffect,
  type OracleImage,
} from '../support/e41-effect-oracle.js';
import { decodeFrame } from '../support/p4-clip-oracle.js';

declare global {
  interface Window {
    __vectorStudioE23: E23GradientPaintApi;
  }
}

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), U5: the effect passes on a GPU
// against the CPU oracle of tests/support/e41-effect-oracle.ts (section 5.1 with K4), on the
// E23 check page with `groups=isolated&effects=v0`. The oracle reads `L` back through the
// `effectcontent=1` hook (each root composites its content only): once over the page's opaque
// black and once over a white backdrop, which gives L's alpha. Tolerance 3/255 per channel,
// 6/255 for downsampled σ (E41-A05). The identity test renders the same scenes without effects
// under `effects=v0` and without it, and expects identical bytes (E41-A06's capture part).
// SwiftShader runs it in U5 (playwright.e41-swiftshader.config.ts); the headed reference-PC run
// is U7's. Each test writes its report under artifacts/e41-effects (or E41_OUTPUT_DIR).

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E41_OUTPUT_DIR ?? 'artifacts/e41-effects',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);
const HOME: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };
const identity = { documentId: 'e41-u5', pageId: 'page' } as const;

const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const TEAL: SceneColor = { r: 0.1, g: 0.7, b: 0.6, a: 1 };
const AMBER: SceneColor = { r: 0.95, g: 0.65, b: 0.1, a: 0.8 };
const WHITE: SceneColor = { r: 1, g: 1, b: 1, a: 1 };
const SHADE: SceneColor = { r: 0, g: 0, b: 0, a: 0.5 };
const BLUE: SceneColor = { r: 0.1, g: 0.2, b: 0.9, a: 0.8 };

const dropShadow = (
  offsetX: number,
  offsetY: number,
  sigma: number,
  color: SceneColor = SHADE,
): SceneEffect => ({ kind: 'dropShadow', color, offsetX, offsetY, sigma });
const layerBlur = (sigma: number): SceneEffect => ({ kind: 'layerBlur', sigma });

function shape(
  id: string,
  parentId: string | null,
  kind: 'rectangle' | 'ellipse',
  [x, y, width, height]: readonly [number, number, number, number],
  fill: SceneColor,
  extra: Partial<{ effects: readonly SceneEffect[]; opacity: number }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'primitive',
    geometry:
      kind === 'rectangle'
        ? { kind, width, height, cornerRadii: [0, 0, 0, 0] }
        : { kind, width, height },
    style: { fill, stroke: null },
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

function container(
  id: string,
  children: readonly string[],
  effects: readonly SceneEffect[],
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
    kind: 'container',
    clip: null,
    children,
    effects,
  };
}

type Fixture = Readonly<{
  name: string;
  nodes: readonly RenderNodeSnapshot[];
  /** The root's effects; at DPR 1 and zoom 1 device units are scene units. */
  effects: readonly SceneEffect[];
  /** A leaf root's opacity (c), 1 for a container root. */
  contentOpacity: number;
}>;

function fixture(name: string, root: RenderNodeSnapshot, children: RenderNodeSnapshot[] = []) {
  return {
    name,
    nodes: [root, ...children],
    effects: root.effects ?? [],
    contentOpacity: root.kind === 'container' ? 1 : root.opacity,
  } satisfies Fixture;
}

const FIXTURES: readonly Fixture[] = [
  fixture(
    'leaf shadow',
    shape('r', null, 'rectangle', [60, 60, 80, 50], RED, { effects: [dropShadow(8, 6, 6)] }),
  ),
  fixture(
    'translucent leaf, two shadows, fractional offset',
    shape('e', null, 'ellipse', [200, 70, 70, 70], TEAL, {
      opacity: 0.6,
      effects: [dropShadow(3.5, -2.25, 4, BLUE), dropShadow(0, 10, 9)],
    }),
  ),
  fixture(
    'container, shadow and layer blur',
    container('g', ['g1', 'g2'], [dropShadow(-6, 4, 5, { ...RED, a: 0.7 }), layerBlur(3)]),
    [
      shape('g1', 'g', 'rectangle', [320, 50, 60, 70], AMBER),
      shape('g2', 'g', 'ellipse', [350, 90, 70, 50], TEAL),
    ],
  ),
  fixture(
    'downsampled shadow and blur',
    shape('d', null, 'rectangle', [90, 180, 90, 60], AMBER, {
      effects: [dropShadow(10, 10, 30), layerBlur(14)],
    }),
  ),
  fixture(
    'sharp shadow',
    shape('s', null, 'rectangle', [300, 190, 70, 50], TEAL, {
      effects: [dropShadow(5.5, 3.25, 0, BLUE)],
    }),
  ),
];

function snapshot(nodes: readonly RenderNodeSnapshot[]): RenderSceneSnapshot {
  return {
    identity,
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  };
}

type PageOptions = Readonly<{ samples: 1 | 4; effects: boolean; content?: boolean }>;

async function open(page: Page, options: PageOptions) {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 800 });
  const query = new URLSearchParams({
    samples: String(options.samples),
    dpr: '1',
    groups: 'isolated',
  });
  if (options.effects) query.set('effects', 'v0');
  if (options.content === true) query.set('effectcontent', '1');
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
  return { result, rgba: decodeFrame(result.frame.rgbaBase64) };
}

const backdrop = (width: number, height: number) =>
  shape('backdrop', null, 'rectangle', [-8, -8, width + 16, height + 16], WHITE);

/** `L` (premultiplied) from captures over black and over white. */
function contentOf(black: Uint8Array, white: Uint8Array, width: number, height: number) {
  const image = oracleImage({ x: 0, y: 0, width, height });
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4;
    let alpha = 0;
    for (let lane = 0; lane < 3; lane += 1)
      alpha += 1 - (white[at + lane]! - black[at + lane]!) / 255;
    alpha = Math.min(Math.max(alpha / 3, 0), 1);
    image.data.set([black[at]! / 255, black[at + 1]! / 255, black[at + 2]! / 255, alpha], at);
  }
  return image;
}

function oracleEffect(fixture: Fixture): OracleEffect {
  let blurSigmaPx: number | null = null;
  const shadows: OracleEffect['shadows'][number][] = [];
  for (const effect of fixture.effects) {
    if (effect.kind === 'layerBlur') blurSigmaPx = effect.sigma;
    else
      shadows.push({
        color: effect.color,
        dx: effect.offsetX,
        dy: effect.offsetY,
        sigmaPx: effect.sigma,
      });
  }
  return { shadows, blurSigmaPx, contentOpacity: fixture.contentOpacity };
}

/** The frame against `R₁ × scale` over the backdrop (0 black, 1 white). */
function compare(actual: Uint8Array, expected: OracleImage, scale: number, backdrop: 0 | 1) {
  let worst = 0;
  let at: [number, number] = [0, 0];
  let over3 = 0;
  for (let y = 0; y < expected.height; y += 1)
    for (let x = 0; x < expected.width; x += 1) {
      const index = (y * expected.width + x) * 4;
      for (let lane = 0; lane < 3; lane += 1) {
        const alpha = expected.data[index + 3]! * scale;
        const value = expected.data[index + lane]! * scale + backdrop * (1 - alpha);
        const difference = Math.abs(actual[index + lane]! - value * 255);
        if (difference > worst) {
          worst = difference;
          at = [x, y];
        }
        if (difference > 3) over3 += 1;
      }
    }
  return { worst, at, over3 };
}

function writeReport(name: string, report: unknown) {
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(path.join(runRoot, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

for (const samples of [1, 4] as const) {
  test(`E41-A05 effect passes against the oracle at ${samples}x`, async ({ browser }) => {
    test.setTimeout(240_000);
    const effectsPage = await browser.newPage();
    const contentPage = await browser.newPage();
    const effects = await open(effectsPage, { samples, effects: true });
    const content = await open(contentPage, { samples, effects: true, content: true });
    const rows: unknown[] = [];
    for (const fixture of FIXTURES) {
      const drawn = await render(effectsPage, fixture.nodes);
      const { width, height } = drawn.result.frame;
      const drawnWhite = await render(effectsPage, [backdrop(width, height), ...fixture.nodes]);
      const black = await render(contentPage, fixture.nodes);
      const white = await render(contentPage, [backdrop(width, height), ...fixture.nodes]);
      const l = contentOf(black.rgba, white.rgba, width, height);
      const effect = oracleEffect(fixture);
      const expected = effectOracle(l, { x: 0, y: 0, width, height }, effect);
      const downsampled = [effect.blurSigmaPx ?? 0, ...effect.shadows.map((s) => s.sigmaPx)].some(
        (sigma) => oracleLevels(sigma) > 0,
      );
      const tolerance = downsampled ? 6 : 3;
      const overBlack = compare(drawn.rgba, expected, effect.contentOpacity, 0);
      const overWhite = compare(drawnWhite.rgba, expected, effect.contentOpacity, 1);
      const result = overBlack.worst >= overWhite.worst ? overBlack : overWhite;
      const counters = drawn.result.counters;
      // The effects show: pixels over white where the frame differs from L alone by over 8/255.
      let changed = 0;
      for (let index = 0; index < width * height; index += 1) {
        const at = index * 4;
        if (
          [0, 1, 2].some(
            (lane) => Math.abs(drawnWhite.rgba[at + lane]! - white.rgba[at + lane]!) > 8,
          )
        )
          changed += 1;
      }
      rows.push({
        fixture: fixture.name,
        tolerance,
        worstOverBlack: overBlack.worst,
        worstOverWhite: overWhite.worst,
        ...result,
        changed,
        effectPasses: counters.effectPasses,
      });
      expect(changed, fixture.name).toBeGreaterThan(500);
      expect(counters.effectPipelineAvailable, fixture.name).toBe(true);
      expect(result.worst, `${fixture.name} at ${result.at.join(', ')}`).toBeLessThanOrEqual(
        tolerance,
      );
    }
    // One effect root per frame, each frame drawn with its effects.
    const counters = await effectsPage.evaluate(() => window.__vectorStudioE23.counters());
    expect(counters.effectPasses).toBeGreaterThanOrEqual(FIXTURES.length);
    const contentCounters = await contentPage.evaluate(() => window.__vectorStudioE23.counters());
    expect(contentCounters.effectPasses).toBe(0);
    const diagnostics = await effectsPage.evaluate(() => window.__vectorStudioE23.diagnostics());
    writeReport(`a05-${samples}x`, {
      adapter: effects.ready.adapter,
      rows,
      errors: diagnostics.filter((event) => event.severity === 'error').map((event) => event.code),
    });
    expect(effects.pageErrors).toEqual([]);
    expect(content.pageErrors).toEqual([]);
  });
}

test('E41-A06 scenes without effects draw identically under effects v0', async ({ browser }) => {
  test.setTimeout(120_000);
  const rows: unknown[] = [];
  for (const samples of [1, 4] as const) {
    const withOption = await browser.newPage();
    const without = await browser.newPage();
    await open(withOption, { samples, effects: true });
    await open(without, { samples, effects: false });
    for (const fixture of FIXTURES) {
      const plain = fixture.nodes.map(
        (node) =>
          Object.fromEntries(
            Object.entries(node).filter(([key]) => key !== 'effects'),
          ) as RenderNodeSnapshot,
      );
      const a = await render(withOption, plain);
      const b = await render(without, plain);
      const identical = Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;
      rows.push({ samples, fixture: fixture.name, identical });
      expect(identical, `${fixture.name} at ${samples}x`).toBe(true);
      expect(a.result.counters.effectPasses).toBe(0);
    }
  }
  writeReport('a06', { rows });
});
