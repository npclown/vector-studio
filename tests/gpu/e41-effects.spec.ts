import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneClip,
  SceneColor,
  SceneEffect,
  ScenePaint,
  PathStroke,
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

/** U7b: a mesh path (a five-point star, nonzero) at `[x, y]`, `size` across. */
function star(
  id: string,
  parentId: string | null,
  [x, y]: readonly [number, number],
  size: number,
  fill: ScenePaint,
  effects?: readonly SceneEffect[],
  extra: Partial<{ opacity: number; stroke: PathStroke }> = {},
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
    opacity: extra.opacity ?? 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: ['move', ...Array.from({ length: 9 }, () => 'line' as const), 'close'],
      points,
      fillRule: 'nonzero',
    },
    style: { fill, stroke: extra.stroke ?? null },
    ...(effects === undefined ? {} : { effects }),
  };
}

/** U7b: a linear gradient over a star `size` across (E23). */
const starGradient = (size: number): ScenePaint => ({
  kind: 'linear',
  transform: [size, 0, 0, size, 0, 0],
  stops: [
    { offset: 0, color: RED },
    { offset: 1, color: BLUE },
  ],
  spread: 'pad',
});

/** U7b (F7): one text run through the glyph atlas (the page's canvas raster port). */
function text(
  id: string,
  [x, y]: readonly [number, number],
  value: string,
  size: number,
  color: SceneColor,
  effects: readonly SceneEffect[],
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: 1,
    kind: 'text',
    generation: 1,
    lang: 'en',
    runs: [
      {
        fontList: 'Arial, sans-serif',
        size,
        color,
        clusters: [...value].map((character, index) => ({
          text: character,
          x: index * size * 0.6,
          y: size,
          advance: size * 0.6,
        })),
      },
    ],
    effects,
  };
}

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

function container(
  id: string,
  children: readonly string[],
  effects: readonly SceneEffect[],
  extra: Partial<{ parentId: string; opacity: number; clip: SceneClip | null }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId: extra.parentId ?? null,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'container',
    clip: extra.clip ?? null,
    children,
    ...(effects.length === 0 ? {} : { effects }),
  };
}

type Fixture = Readonly<{
  name: string;
  nodes: readonly RenderNodeSnapshot[];
  /** The root's effects; at DPR 1 and zoom 1 device units are scene units. */
  effects: readonly SceneEffect[];
  /** A leaf root's opacity (c), 1 for a container root. */
  contentOpacity: number;
  /**
   * U5b: how far the content capture's camera moves the scene (device pixels), so that `L`'s
   * part past the target is on the capture too; zero for content inside the target.
   */
  shift: readonly [number, number];
  /**
   * U5c (E41-K2b): the root's ancestors' clip, a rect on whole pixels (so its coverage is 0 or
   * 1) applied once to `R`; `contentNodes` is the scene whose content capture is the root's
   * unclipped `L` (the same scene without that clip).
   */
  clip?: readonly [number, number, number, number];
  contentNodes?: readonly RenderNodeSnapshot[];
  /** U7b: the view (F9's zoom); the home camera when absent. */
  camera?: RenderCamera;
  /**
   * U7b (E41-S9): the root's linear scene transform `[a, b, c, d]`, which maps its offsets and
   * scales σ by its largest singular value (F2's rotation); the identity when absent.
   */
  linear?: readonly [number, number, number, number];
  /** U7b: what the frame draws below the root, captured alone; nothing when absent. */
  under?: readonly RenderNodeSnapshot[];
}>;

function fixture(
  name: string,
  root: RenderNodeSnapshot,
  children: RenderNodeSnapshot[] = [],
  shift: readonly [number, number] = [0, 0],
) {
  return {
    name,
    nodes: [root, ...children],
    effects: root.effects ?? [],
    contentOpacity: root.kind === 'container' ? 1 : root.opacity,
    shift,
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
  // U5b (F10): casters past the target's edges whose shadows and blur reach into it.
  fixture(
    'caster past the left edge',
    shape('l', null, 'rectangle', [-70, 200, 80, 60], RED, {
      effects: [dropShadow(90, 4, 6)],
    }),
    [],
    [120, 0],
  ),
  fixture(
    'container past the top edge, nested isolated group, layer blur',
    container('t', ['t1', 'tg'], [dropShadow(0, 46, 8), layerBlur(4)]),
    [
      shape('t1', 't', 'rectangle', [380, -60, 100, 76], AMBER),
      container('tg', ['t2'], [], { parentId: 't', opacity: 0.5 }),
      shape('t2', 'tg', 'ellipse', [420, -50, 64, 64], BLUE),
    ],
    [0, 120],
  ),
  // U5c (E41-K2b): roots under clips and masks; the shadow is built from the unclipped content
  // and clipped once, at the composite.
  clipped('F6 shadow past a clipping frame', [40, 150, 200, 100], (clip) => [
    container('f6', ['f6r'], [], { clip }),
    shape('f6r', 'f6', 'rectangle', [150, 120, 80, 70], RED, {
      effects: [dropShadow(40, 20, 5)],
    }),
  ]),
  clipped('F11 shadowed child of a mask group', [260, 40, 180, 140], (clip) =>
    clip === null
      ? [
          shape('f11c', null, 'ellipse', [300, 70, 90, 70], TEAL, {
            effects: [dropShadow(30, 25, 6)],
          }),
        ]
      : [
          container('f11', ['f11s', 'f11c'], [], { clip: { kind: 'mask' } }),
          shape('f11s', 'f11', 'rectangle', [260, 40, 180, 140], WHITE),
          shape('f11c', 'f11', 'ellipse', [300, 70, 90, 70], TEAL, {
            effects: [dropShadow(30, 25, 6)],
          }),
        ],
  ),
  clipped('F12 mask group in a shadowed group in a clipping frame', [20, 20, 260, 130], (clip) => [
    container('f12', ['f12g'], [], { clip }),
    container('f12g', ['f12m'], [dropShadow(25, 30, 4)], { parentId: 'f12' }),
    container('f12m', ['f12s', 'f12c'], [], { parentId: 'f12g', clip: { kind: 'mask' } }),
    shape('f12s', 'f12m', 'rectangle', [60, 40, 150, 90], WHITE),
    shape('f12c', 'f12m', 'ellipse', [100, 60, 180, 120], AMBER),
  ]),
  // U7b: the fixtures U5 left to the headed run.
  {
    ...fixture('F2 shadow on a rectangle rotated 30 degrees', {
      ...shape('f2', null, 'rectangle', [0, 0, 90, 50], RED, {
        effects: [dropShadow(24, 18, 5)],
      }),
      transform: [COS30, SIN30, -SIN30, COS30, 200, 80],
    }),
    linear: [COS30, SIN30, -SIN30, COS30],
  },
  fixture(
    'F7 shadow on text',
    text('f7', [150, 120], 'Shadow', 40, TEAL, [dropShadow(4, 5, 3, { ...SHADE, a: 0.7 })]),
  ),
  fixture(
    'mesh path past the right edge in a shifted pass, shadow and blur',
    star('mp', null, [440, 120], 120, AMBER, [dropShadow(-70, 10, 6), layerBlur(2)]),
    [],
    [-150, 0],
  ),
  // Draws U5b left to U7 in a shifted pass: a joint draw (a gradient-filled, stroked star at
  // opacity 0.6) under a rect clip inside a shadowed container root past the bottom edge.
  fixture(
    'joint draw, gradient and inner clip in a shifted pass',
    container('jr', ['jc'], [dropShadow(30, -60, 4)]),
    [
      container('jc', ['js'], [], {
        parentId: 'jr',
        clip: { kind: 'rect', x: 150, y: 240, width: 200, height: 110 },
      }),
      star('js', 'jc', [180, 230], 140, starGradient(140), undefined, {
        opacity: 0.6,
        stroke: { color: TEAL, width: 6, cap: 'round', join: 'round', miterLimit: 4 },
      }),
    ],
    [0, -150],
  ),
  // The frame also holds a mesh path below the root, a winding stencil-and-cover draw in the
  // same pass as the root's clipped composite (every pass on this page has the stencil
  // attachment); the expected frame is R over that path's own capture (`under`).
  {
    ...clipped(
      'stencil-pass clip composite: shadowed mesh path beside a mesh path in a clipping frame',
      [100, 60, 260, 160],
      (clip) =>
        clip === null
          ? [
              container('sc', ['scs'], [], { clip }),
              star('scs', 'sc', [240, 90], 110, RED, [dropShadow(60, 40, 5)]),
            ]
          : [
              container('sc', ['scp', 'scs'], [], { clip }),
              star('scp', 'sc', [120, 80], 130, BLUE),
              star('scs', 'sc', [240, 90], 110, RED, [dropShadow(60, 40, 5)]),
            ],
    ),
    under: [
      container('sc', ['scp'], [], {
        clip: { kind: 'rect', x: 100, y: 60, width: 260, height: 160 },
      }),
      star('scp', 'sc', [120, 80], 130, BLUE),
    ],
  },
  {
    ...fixture(
      'F9 zoom 8, radius 40 (sigma 160 px)',
      shape('f9', null, 'rectangle', [20, 12, 16, 12], TEAL, {
        effects: [dropShadow(2, 2, 20)],
      }),
    ),
    camera: { position: { x: 0, y: 0 }, zoom: 8 },
  },
];

/**
 * A fixture whose root is under a rect clip (or a mask whose source is that rect): `build(clip)`
 * gives the scene, `build(null)` the scene whose capture is the root's unclipped `L`.
 */
function clipped(
  name: string,
  [x, y, width, height]: readonly [number, number, number, number],
  build: (clip: SceneClip | null) => RenderNodeSnapshot[],
): Fixture {
  const nodes = build({ kind: 'rect', x, y, width, height });
  const root = nodes.find((node) => node.effects !== undefined)!;
  return {
    name,
    nodes,
    effects: root.effects!,
    contentOpacity: root.kind === 'container' ? 1 : root.opacity,
    shift: [0, 0],
    clip: [x, y, width, height],
    contentNodes: build(null),
  };
}

/** A node without its effects. */
const withoutEffects = (node: RenderNodeSnapshot) =>
  Object.fromEntries(
    Object.entries(node).filter(([key]) => key !== 'effects'),
  ) as RenderNodeSnapshot;

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
    // U7b: text leaves draw (F7); the same option on every page, so captures stay comparable.
    text: 'atlas',
  });
  if (options.effects) query.set('effects', 'v0');
  if (options.content === true) query.set('effectcontent', '1');
  await page.goto(`/e23-gradient-paint.html?${query.toString()}`);
  const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
  expect(ready.supported, JSON.stringify(ready)).toBe(true);
  return { ready, pageErrors };
}

async function render(
  page: Page,
  nodes: readonly RenderNodeSnapshot[],
  camera: RenderCamera = HOME,
) {
  const result = await page.evaluate(
    ([scene, view]) => window.__vectorStudioE23.render(scene, view),
    [snapshot(nodes), camera] as const,
  );
  expect(result.status).toBe('applied');
  return { result, rgba: decodeFrame(result.frame.rgbaBase64) };
}

// It reaches past the target on every side, so its edges stay off every capture.
const backdrop = (width: number, height: number) =>
  shape('backdrop', null, 'rectangle', [-200, -200, width + 400, height + 400], WHITE);

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
  // E41-S9: offsets map through the root's linear transform and the camera's zoom; σ scales by
  // the largest singular value (1 for a rotation) times the zoom.
  const zoom = fixture.camera?.zoom ?? 1;
  const [a, b, c, d] = fixture.linear ?? [1, 0, 0, 1];
  const p = (a * a + b * b + c * c + d * d) / 2;
  const q = Math.sqrt(Math.max(p * p - (a * d - b * c) ** 2, 0));
  const scale = zoom * Math.sqrt(p + q);
  let blurSigmaPx: number | null = null;
  const shadows: OracleEffect['shadows'][number][] = [];
  for (const effect of fixture.effects) {
    if (effect.kind === 'layerBlur') blurSigmaPx = effect.sigma * scale;
    else
      shadows.push({
        color: effect.color,
        dx: zoom * (a * effect.offsetX + c * effect.offsetY),
        dy: zoom * (b * effect.offsetX + d * effect.offsetY),
        sigmaPx: effect.sigma * scale,
      });
  }
  return { shadows, blurSigmaPx, contentOpacity: fixture.contentOpacity };
}

/**
 * Zeroes the image outside a rect on whole pixels (the image is at the target's origin). The
 * rect is in device pixels at the home camera: a fixture with both `clip` and `camera` is not
 * supported (the spec asserts it).
 */
function clipImage(
  image: OracleImage,
  [x, y, width, height]: readonly [number, number, number, number],
) {
  for (let row = 0; row < image.height; row += 1)
    for (let column = 0; column < image.width; column += 1) {
      if (column >= x && column < x + width && row >= y && row < y + height) continue;
      image.data.fill(0, (row * image.width + column) * 4, (row * image.width + column) * 4 + 4);
    }
}

/** The frame against `R₁ × scale` over the backdrop (0 black, 1 white). */
/**
 * U7b: whether a pixel lies within 1 px of a corner of the ancestors' clip rect. P4's clip
 * coverage there comes from `fwidth` of the distance to the rect, which depends on the device's
 * derivative mode (SwiftShader's coarse derivatives give the corner's inner 2 × 2 pixels 0.75
 * and its outer diagonal neighbour 0.25), so the hard 0 or 1 of `clipImage` holds off the
 * corners only. Content drawn under a clip has the same corners; they are not the effect's.
 */
function nearClipCorner(
  x: number,
  y: number,
  clip: readonly [number, number, number, number] | undefined,
) {
  if (clip === undefined) return false;
  const [cx, cy, width, height] = clip;
  return [cx, cx + width].some(
    (cornerX) =>
      Math.abs(x + 0.5 - cornerX) <= 1.5 &&
      [cy, cy + height].some((cornerY) => Math.abs(y + 0.5 - cornerY) <= 1.5),
  );
}

function compare(
  actual: Uint8Array,
  expected: OracleImage,
  scale: number,
  backdrop: 0 | 1 | Uint8Array,
  clip?: readonly [number, number, number, number],
) {
  let worst = 0;
  let at: [number, number] = [0, 0];
  let over3 = 0;
  let detail: Readonly<{ actual: number; expected: number; alpha: number; lane: number }> | null =
    null;
  for (let y = 0; y < expected.height; y += 1)
    for (let x = 0; x < expected.width; x += 1) {
      if (nearClipCorner(x, y, clip)) continue;
      const index = (y * expected.width + x) * 4;
      for (let lane = 0; lane < 3; lane += 1) {
        const alpha = expected.data[index + 3]! * scale;
        const below = typeof backdrop === 'number' ? backdrop : backdrop[index + lane]! / 255;
        const value = expected.data[index + lane]! * scale + below * (1 - alpha);
        const difference = Math.abs(actual[index + lane]! - value * 255);
        if (difference > worst) {
          worst = difference;
          at = [x, y];
          detail = { actual: actual[index + lane]!, expected: value * 255, alpha, lane };
        }
        if (difference > 3) over3 += 1;
      }
    }
  return { worst, at, over3, detail };
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
      expect(fixture.clip === undefined || fixture.camera === undefined, fixture.name).toBe(true);
      const view = fixture.camera ?? HOME;
      const drawn = await render(effectsPage, fixture.nodes, view);
      const { width, height } = drawn.result.frame;
      const drawnWhite = await render(
        effectsPage,
        [backdrop(width, height), ...fixture.nodes],
        view,
      );
      // L from a camera that moves it by `shift` (device pixels), placed back at its own pixels.
      const [sx, sy] = fixture.shift;
      const camera: RenderCamera = {
        position: {
          x: view.position.x - sx / view.zoom,
          y: view.position.y - sy / view.zoom,
        },
        zoom: view.zoom,
      };
      const contentNodes = fixture.contentNodes ?? fixture.nodes;
      const black = await render(contentPage, contentNodes, camera);
      const white = await render(contentPage, [backdrop(width, height), ...contentNodes], camera);
      const l = { ...contentOf(black.rgba, white.rgba, width, height), x: -sx, y: -sy };
      const effect = oracleEffect(fixture);
      const expected = effectOracle(l, { x: 0, y: 0, width, height }, effect);
      // U5c: the ancestors' clip, once, on R.
      if (fixture.clip !== undefined) clipImage(expected, fixture.clip);
      const downsampled = [effect.blurSigmaPx ?? 0, ...effect.shadows.map((s) => s.sigmaPx)].some(
        (sigma) => oracleLevels(sigma) > 0,
      );
      const tolerance = downsampled ? 6 : 3;
      // U7b: what the frame draws below the root (`under`), over black and over white.
      const under =
        fixture.under === undefined
          ? null
          : [
              (await render(effectsPage, fixture.under, view)).rgba,
              (await render(effectsPage, [backdrop(width, height), ...fixture.under], view)).rgba,
            ];
      const clip = fixture.clip;
      const overBlack = compare(drawn.rgba, expected, effect.contentOpacity, under?.[0] ?? 0, clip);
      const overWhite = compare(
        drawnWhite.rgba,
        expected,
        effect.contentOpacity,
        under?.[1] ?? 1,
        clip,
      );
      const result = overBlack.worst >= overWhite.worst ? overBlack : overWhite;
      const counters = drawn.result.counters;
      // The effects show: pixels over white where the frame differs from L alone by over 8/255
      // (with `under`, from the same frame drawn without the root's effects).
      const reference =
        fixture.under === undefined
          ? white.rgba
          : (
              await render(
                effectsPage,
                [backdrop(width, height), ...fixture.nodes.map(withoutEffects)],
                view,
              )
            ).rgba;
      let changed = 0;
      for (let index = 0; index < width * height; index += 1) {
        const at = index * 4;
        if (
          [0, 1, 2].some(
            (lane) => Math.abs(drawnWhite.rgba[at + lane]! - reference[at + lane]!) > 8,
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
      const plain = fixture.nodes.map(withoutEffects);
      const a = await render(withOption, plain, fixture.camera);
      const b = await render(without, plain, fixture.camera);
      const identical = Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;
      rows.push({ samples, fixture: fixture.name, identical });
      expect(identical, `${fixture.name} at ${samples}x`).toBe(true);
      expect(a.result.counters.effectPasses).toBe(0);
    }
  }
  writeReport('a06', { rows });
});
