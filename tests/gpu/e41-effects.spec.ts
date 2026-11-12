import { createHash } from 'node:crypto';
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
  backgroundBlurOracle,
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
/** V-36 (V36-S3): an inner shadow, fields as `dropShadow`'s. */
const innerShadow = (
  offsetX: number,
  offsetY: number,
  sigma: number,
  color: SceneColor = SHADE,
): SceneEffect => ({ kind: 'innerShadow', color, offsetX, offsetY, sigma });

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
 * V-36 contract (docs/plans/viz-v36-inner-shadow-background-blur-contract.md), V36-A04's inner
 * shadow fixtures (U2): G1 to G4 and G8, drawn on `effects=v1` pages with E41's.
 */
const V36_FIXTURES: readonly Fixture[] = [
  fixture(
    'G1 inner shadow on a rectangle',
    shape('g1', null, 'rectangle', [60, 60, 120, 80], WHITE, {
      effects: [innerShadow(6, 8, 5, { ...SHADE, a: 0.8 })],
    }),
  ),
  {
    ...fixture('G2 inner shadow on a rectangle rotated 30 degrees', {
      ...shape('g2', null, 'rectangle', [0, 0, 110, 60], AMBER, {
        effects: [innerShadow(10, 6, 4, BLUE)],
      }),
      transform: [COS30, SIN30, -SIN30, COS30, 280, 60],
    }),
    linear: [COS30, SIN30, -SIN30, COS30],
  },
  fixture(
    'G3 two inner shadows and a drop shadow on a 50 % fill, leaf at opacity 0.7',
    shape(
      'g3',
      null,
      'ellipse',
      [80, 190, 140, 90],
      { ...TEAL, a: 0.5 },
      {
        opacity: 0.7,
        effects: [
          dropShadow(6, 6, 4),
          innerShadow(0, 7, 3),
          innerShadow(-5, -3, 0, { ...RED, a: 0.9 }),
        ],
      },
    ),
  ),
  fixture(
    'G4 inner shadow on text',
    text('g4', [280, 200], 'Inset', 56, AMBER, [innerShadow(2, 3, 1.5, { ...SHADE, a: 0.9 })]),
  ),
  // G8 (V36-K1b): the root holds a mask group, so its layer is cut at the target's left edge;
  // the content runs on unchanged past the cut, so a clamped read equals the uncut `L`.
  fixture(
    'G8 inner-shadowed group with a mask group, cut at the target edge',
    container('g8', ['g8m'], [innerShadow(14, 4, 4, { ...SHADE, a: 0.9 })]),
    [
      container('g8m', ['g8s', 'g8c'], [], { parentId: 'g8', clip: { kind: 'mask' } }),
      shape('g8s', 'g8m', 'rectangle', [-120, 220, 300, 70], WHITE),
      shape('g8c', 'g8m', 'rectangle', [-120, 220, 300, 70], TEAL),
    ],
    [140, 0],
  ),
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

/** `effects`: false for none, true for E41's 'v0', or 'v1' (V-36, V36-S4). */
type PageOptions = Readonly<{ samples: 1 | 4; effects: boolean | 'v1'; content?: boolean }>;

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
  if (options.effects !== false) query.set('effects', options.effects === 'v1' ? 'v1' : 'v0');
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
  const innerShadows: OracleEffect['shadows'][number][] = [];
  for (const effect of fixture.effects) {
    if (effect.kind === 'layerBlur') blurSigmaPx = effect.sigma * scale;
    else if (effect.kind === 'dropShadow' || effect.kind === 'innerShadow')
      (effect.kind === 'dropShadow' ? shadows : innerShadows).push({
        color: effect.color,
        dx: zoom * (a * effect.offsetX + c * effect.offsetY),
        dy: zoom * (b * effect.offsetX + d * effect.offsetY),
        sigmaPx: effect.sigma * scale,
      });
  }
  return {
    shadows,
    ...(innerShadows.length === 0 ? {} : { innerShadows }),
    blurSigmaPx,
    contentOpacity: fixture.contentOpacity,
  };
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
  backdrop: 0 | 1 | Uint8Array | Float64Array,
  clip?: readonly [number, number, number, number],
  skip?: (x: number, y: number) => boolean,
) {
  let worst = 0;
  let at: [number, number] = [0, 0];
  let over3 = 0;
  let detail: Readonly<{ actual: number; expected: number; alpha: number; lane: number }> | null =
    null;
  for (let y = 0; y < expected.height; y += 1)
    for (let x = 0; x < expected.width; x += 1) {
      if (nearClipCorner(x, y, clip) || skip?.(x, y) === true) continue;
      const index = (y * expected.width + x) * 4;
      for (let lane = 0; lane < 3; lane += 1) {
        const alpha = expected.data[index + 3]! * scale;
        const below =
          typeof backdrop === 'number'
            ? backdrop
            : backdrop instanceof Float64Array
              ? backdrop[index + lane]!
              : backdrop[index + lane]! / 255;
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
    // V-36: 'v1' pages, so the inner-shadow fixtures draw beside E41's (whose captures V36-A05
    // checks are byte-identical to 'v0').
    const effects = await open(effectsPage, { samples, effects: 'v1' });
    const content = await open(contentPage, { samples, effects: 'v1', content: true });
    const rows: unknown[] = [];
    for (const fixture of [...FIXTURES, ...V36_FIXTURES]) {
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
      const downsampled = [
        effect.blurSigmaPx ?? 0,
        ...effect.shadows.map((s) => s.sigmaPx),
        ...(effect.innerShadows ?? []).map((s) => s.sigmaPx),
      ].some((sigma) => oracleLevels(sigma) > 0);
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
    expect(counters.effectPasses).toBeGreaterThanOrEqual(FIXTURES.length + V36_FIXTURES.length);
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

// V-36 (V36-A05) adds the 'v1' page: scenes without effects draw as on 'none' there too.
test('E41-A06 scenes without effects draw identically under effects v0 and v1', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const rows: unknown[] = [];
  for (const samples of [1, 4] as const) {
    const without = await browser.newPage();
    await open(without, { samples, effects: false });
    const levels = [true, 'v1'] as const;
    const pages = [];
    for (const effects of levels) {
      const page = await browser.newPage();
      await open(page, { samples, effects });
      pages.push(page);
    }
    for (const fixture of FIXTURES) {
      const plain = fixture.nodes.map(withoutEffects);
      const b = await render(without, plain, fixture.camera);
      for (const [i, page] of pages.entries()) {
        const a = await render(page, plain, fixture.camera);
        const identical = Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;
        const level = levels[i] === true ? 'v0' : 'v1';
        rows.push({ samples, fixture: fixture.name, level, identical });
        expect(identical, `${fixture.name} at ${samples}x on ${level}`).toBe(true);
        expect(a.result.counters.effectPasses).toBe(0);
      }
    }
  }
  writeReport('a06', { rows });
});

// V-36 contract, V36-A05, the module re-pin half: the SHA-256 of every E41 fixture capture with
// its effects ('v0' page) and without them ('none' page). The same test, run on a build from
// before the re-pin, must write the same digests (docs/evidence/v36/u2-swiftshader.md).
test('V36-A05 capture digests of the E41 fixtures', async ({ browser }) => {
  test.setTimeout(180_000);
  const digests: Record<string, string> = {};
  for (const samples of [1, 4] as const) {
    const withEffects = await browser.newPage();
    const without = await browser.newPage();
    await open(withEffects, { samples, effects: true });
    await open(without, { samples, effects: false });
    for (const fixture of FIXTURES) {
      const a = await render(withEffects, fixture.nodes, fixture.camera);
      const b = await render(without, fixture.nodes.map(withoutEffects), fixture.camera);
      const sha = (rgba: ArrayLike<number>) =>
        createHash('sha256')
          .update(Buffer.from(rgba as Uint8Array))
          .digest('hex');
      digests[`${fixture.name}@${samples}x effects`] = sha(a.rgba);
      digests[`${fixture.name}@${samples}x plain`] = sha(b.rgba);
    }
  }
  writeReport('v36-a05-digests', { digests });
});

// V-36 contract, V36-A05: E41's fixtures, with their effects, draw byte-identically under 'v0'
// and 'v1' (the module re-pin to e41-effect-v1 keeps every E41 pass's arithmetic).
test('V36-A05 E41 effects draw identically under effects v0 and v1', async ({ browser }) => {
  test.setTimeout(120_000);
  const rows: unknown[] = [];
  for (const samples of [1, 4] as const) {
    const v0 = await browser.newPage();
    const v1 = await browser.newPage();
    await open(v0, { samples, effects: true });
    await open(v1, { samples, effects: 'v1' });
    for (const fixture of FIXTURES) {
      const a = await render(v0, fixture.nodes, fixture.camera);
      const b = await render(v1, fixture.nodes, fixture.camera);
      const identical = Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;
      rows.push({ samples, fixture: fixture.name, identical });
      expect(identical, `${fixture.name} at ${samples}x`).toBe(true);
    }
  }
  writeReport('v36-a05', { rows });
});

// --- U7c: the headed counters (E41-A07 to A09) on the same page. ---

type Counters = Awaited<ReturnType<Window['__vectorStudioE23']['counters']>>;

const counters = (page: Page) => page.evaluate(() => window.__vectorStudioE23.counters());

async function show(page: Page, nodes: readonly RenderNodeSnapshot[], camera = HOME) {
  const shown = await page.evaluate(([scene, view]) => window.__vectorStudioE23.show(scene, view), [
    snapshot(nodes),
    camera,
  ] as const);
  expect(shown.status).toBe('applied');
  return shown;
}

async function edit(page: Page, updated: readonly RenderNodeSnapshot[]) {
  const edited = await page.evaluate(
    ([scene, nodes]) => window.__vectorStudioE23.edit(scene, nodes),
    [identity, updated] as const,
  );
  expect(edited.status).toBe('applied');
  return edited;
}

async function pan(page: Page, camera: RenderCamera) {
  return page.evaluate((view) => window.__vectorStudioE23.pan(view), camera);
}

/** K6's cost: fill and stroke port calls and geometry builds between two counter readings. */
const cost = (before: Counters, after: Counters) => ({
  portCalls: (after.pathMesh?.portCalls ?? 0) - (before.pathMesh?.portCalls ?? 0),
  strokePortCalls: (after.pathMesh?.strokePortCalls ?? 0) - (before.pathMesh?.strokePortCalls ?? 0),
  geometryBuilds: after.preparation.geometryBuilds - before.preparation.geometryBuilds,
});

/** Live textures and their bytes, the resource accounting E41-A09 reads. */
const textures = (value: Counters) => {
  const entry = value.statistics.resources.byCategory.texture;
  return { live: entry.live, liveBytes: entry.liveBytes };
};

/** Three effect roots: a shadowed card group with a star path, a blurred star, a shadowed rect. */
function countersScene(effects = true, p = 'a07'): RenderNodeSnapshot[] {
  const nodes = [
    container(`${p}-card`, [`${p}-card-bg`, `${p}-card-star`], [dropShadow(0, 8, 4)]),
    shape(`${p}-card-bg`, `${p}-card`, 'rectangle', [40, 40, 160, 120], WHITE),
    star(`${p}-card-star`, `${p}-card`, [80, 60], 80, RED, undefined, {
      stroke: { color: BLUE, width: 3, cap: 'round', join: 'round', miterLimit: 4 },
    }),
    star(`${p}-blurred`, null, [260, 60], 100, TEAL, [layerBlur(3)]),
    shape(`${p}-rect`, null, 'rectangle', [400, 80, 80, 80], AMBER, {
      effects: [dropShadow(6, 6, 2, SHADE)],
    }),
  ];
  return effects ? nodes : nodes.map(withoutEffects);
}

test('E41-A07 and V36-A07 effect edits, pan and zoom cost no geometry; effectPasses per frame', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  // On 'v1' (V-36), which draws E41's kinds as 'v0' does (V36-A05), so the inner-shadow edits
  // (V36-A07) run on the same page.
  const { pageErrors } = await open(page, { samples: 4, effects: 'v1' });
  const failures: string[] = [];
  const rows: Record<string, unknown> = {};
  const scene = countersScene();
  const free = (value: ReturnType<typeof cost>) =>
    value.portCalls === 0 && value.strokePortCalls === 0 && value.geometryBuilds === 0;
  // K6: an effect edit (offset and σ, a new shadow, removal) changes composite records only.
  await show(page, scene);
  const card = scene[0]!;
  const edits: Record<string, readonly SceneEffect[]> = {
    offsetAndSigma: [dropShadow(4, 12, 6)],
    secondShadow: [dropShadow(4, 12, 6), dropShadow(-3, -3, 1, BLUE)],
    withBlur: [dropShadow(4, 12, 6), layerBlur(2)],
    removed: [],
    // V36-A07: an inner shadow added, its offset and σ edited, a second one, removed.
    innerAdded: [innerShadow(0, 4, 2)],
    innerOffsetAndSigma: [innerShadow(-5, 9, 7)],
    innerSecond: [innerShadow(-5, 9, 7), innerShadow(3, 3, 1, BLUE)],
    innerRemoved: [],
  };
  for (const [name, effects] of Object.entries(edits)) {
    const before = await counters(page);
    const edited = await edit(page, [
      { ...withoutEffects(card), ...(effects.length === 0 ? {} : { effects }) },
    ]);
    const value = cost(before, edited.counters);
    rows[`edit-${name}`] = value;
    if (!free(value)) failures.push(`edit ${name}: ${JSON.stringify(value)}`);
  }
  // Pan and zoom cost the same with effects as without; a pan alone costs nothing. Each run has
  // its own node ids, so neither finds the other's meshes in the cache.
  const panCost = async (effects: boolean) => {
    await show(page, countersScene(effects, effects ? 'pan-on' : 'pan-off'));
    const before = await counters(page);
    await pan(page, { position: { x: 13, y: -7 }, zoom: 1 });
    const panned = await counters(page);
    await pan(page, { position: { x: 13, y: -7 }, zoom: 1.5 });
    return { pan: cost(before, panned), zoom: cost(panned, await counters(page)) };
  };
  const withEffects = await panCost(true);
  const withoutEffectsCost = await panCost(false);
  rows.pan = { withEffects, withoutEffects: withoutEffectsCost };
  if (!free(withEffects.pan)) failures.push(`pan with effects ${JSON.stringify(withEffects.pan)}`);
  if (JSON.stringify(withEffects) !== JSON.stringify(withoutEffectsCost))
    failures.push(`pan and zoom ${JSON.stringify(rows.pan)}`);
  // effectPasses: one per drawn root per submitted frame (three roots).
  await show(page, scene);
  const before = await counters(page);
  for (const x of [5, 10, 15]) await pan(page, { position: { x, y: 0 }, zoom: 1 });
  const after = await counters(page);
  const frames = after.statistics.framesSubmitted - before.statistics.framesSubmitted;
  const passes = after.effectPasses - before.effectPasses;
  rows.passes = { frames, passes };
  if (frames < 3 || passes !== 3 * frames)
    failures.push(`effect passes ${passes} over ${frames} frames, expected 3 per frame`);
  writeReport('a07', { rows, failures });
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

test('E41-A08 over the budget: one notice per transition, content drawn without effects', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await browser.newPage();
  const { pageErrors } = await open(page, { samples: 4, effects: true });
  const failures: string[] = [];
  // A 2000 × 1300 surface at DPR 2 (4000 × 2600 device px): a shadowed rectangle that nearly fills
  // it needs R (≈ 41.6 MB) and the scratch chain (≈ 111 MB), over the 96 MiB layer budget.
  const white = shape('a08-white', null, 'rectangle', [-50, -50, 2100, 1400], WHITE);
  await show(page, [white]);
  await page.evaluate(() => window.__vectorStudioE23.resize(2000, 1300, 2));
  const big = (sigma: number) =>
    shape('a08-big', null, 'rectangle', [100, 100, 1700, 1000], RED, {
      effects: [dropShadow(0, 40, sigma)],
    });
  const small = shape('a08-small', null, 'rectangle', [100, 100, 300, 200], RED, {
    effects: [dropShadow(0, 40, 4)],
  });
  const notices = async () =>
    (await page.evaluate(() => window.__vectorStudioE23.diagnostics())).filter(
      (event) => event.code === 'render.effect-resource-limit',
    ).length;
  /** The pixel at CSS (200, y), below the rectangle, from a frame at DPR 2. */
  const probe = async (nodes: readonly RenderNodeSnapshot[], y: number) => {
    const drawn = await render(page, nodes);
    const { width } = drawn.result.frame;
    const at = (Math.round(y * 2) * width + 400) * 4;
    return {
      rgb: [drawn.rgba[at]!, drawn.rgba[at + 1]!, drawn.rgba[at + 2]!],
      effectPasses: drawn.result.counters.effectPasses,
    };
  };
  const rows: Record<string, unknown> = {};
  const start = await notices();
  const over = await probe([white, big(4)], 1120);
  const overAgain = await probe([white, big(6)], 1120);
  const afterOver = await notices();
  const under = await probe([white, small], 320);
  const overOnceMore = await probe([white, big(4)], 1120);
  const afterReturn = await notices();
  rows.over = over;
  rows.overAgain = overAgain;
  rows.under = under;
  rows.overOnceMore = overOnceMore;
  rows.notices = { start, afterOver, afterReturn };
  // Over budget: the rectangle draws (red inside), the shadow does not (white below it).
  const isWhite = (rgb: readonly number[]) => rgb.every((value) => value >= 250);
  if (!isWhite(over.rgb)) failures.push(`over budget, below the rectangle ${over.rgb.join(',')}`);
  if (!isWhite(overAgain.rgb)) failures.push(`still over, below it ${overAgain.rgb.join(',')}`);
  if (!isWhite(overOnceMore.rgb))
    failures.push(`over again, below it ${overOnceMore.rgb.join(',')}`);
  if (afterOver - start !== 1)
    failures.push(`notices on the first transition ${afterOver - start}`);
  // Under budget the shadow draws; going over again raises one more notice.
  if (isWhite(under.rgb)) failures.push('under budget, no shadow below the small rectangle');
  if (afterReturn - afterOver !== 1)
    failures.push(`notices on the second transition ${afterReturn - afterOver}`);
  const inside = await render(page, [white, big(4)]);
  const centre = (Math.round(600 * 2) * inside.result.frame.width + 1000 * 2) * 4;
  rows.inside = [inside.rgba[centre], inside.rgba[centre + 1], inside.rgba[centre + 2]];
  if (inside.rgba[centre]! < 250 || inside.rgba[centre + 1]! > 5)
    failures.push(`over budget, the content ${JSON.stringify(rows.inside)}`);
  writeReport('a08', { rows, failures });
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

test('E41-A09 effect textures in accounting, released, back to baseline', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await browser.newPage();
  const { pageErrors } = await open(page, { samples: 4, effects: true });
  const failures: string[] = [];
  const rows: Record<string, unknown> = {};
  const plain = countersScene(false);
  const effects = countersScene(true);
  const baselineFrame = await render(page, plain);
  const baseline = textures(baselineFrame.result.counters);
  const createdBefore = baselineFrame.result.counters.statistics.resources.byCategory.texture;
  const drawn = await render(page, effects);
  const created = drawn.result.counters.statistics.resources.byCategory.texture;
  rows.baseline = baseline;
  rows.effects = { created: created.created, peakLiveBytes: created.peakLiveBytes };
  // Each root's L and R and the scratch pair are accounted while the frame is encoded.
  if (created.created < createdBefore.created + 3)
    failures.push(
      `effect textures not in accounting: ${createdBefore.created} → ${created.created}`,
    );
  if (created.peakLiveBytes <= createdBefore.peakLiveBytes)
    failures.push(`texture peak ${created.peakLiveBytes} not above ${createdBefore.peakLiveBytes}`);
  // Released after submission.
  if (JSON.stringify(textures(drawn.result.counters)) !== JSON.stringify(baseline))
    failures.push(`after the effects frame ${JSON.stringify(textures(drawn.result.counters))}`);
  const removed = textures((await render(page, plain)).result.counters);
  if (JSON.stringify(removed) !== JSON.stringify(baseline))
    failures.push(`after removal ${JSON.stringify(removed)}`);
  // On resize: the effects frame at the new size releases its textures too.
  await page.evaluate(() => window.__vectorStudioE23.resize(800, 500, 2));
  const resizedPlainFrame = await render(page, plain);
  const resizedBaseline = textures(resizedPlainFrame.result.counters);
  const resizedFrame = await render(page, effects);
  const resizedEffects = textures(resizedFrame.result.counters);
  const resizedCreated = [
    resizedPlainFrame.result.counters.statistics.resources.byCategory.texture.created,
    resizedFrame.result.counters.statistics.resources.byCategory.texture.created,
  ];
  if (resizedCreated[1]! < resizedCreated[0]! + 3)
    failures.push(`resized, effect textures not in accounting: ${resizedCreated.join(' → ')}`);
  const resizedRemoved = textures((await render(page, plain)).result.counters);
  rows.resized = { resizedBaseline, resizedEffects, resizedRemoved };
  if (JSON.stringify(resizedEffects) !== JSON.stringify(resizedBaseline))
    failures.push(`resized, after the effects frame ${JSON.stringify(rows.resized)}`);
  if (JSON.stringify(resizedRemoved) !== JSON.stringify(resizedBaseline))
    failures.push(`resized, after removal ${JSON.stringify(rows.resized)}`);
  // Device loss: the recovered generation draws the same frame and returns to the baseline.
  const preLoss = await render(page, effects);
  const recovered = await page.evaluate(() => window.__vectorStudioE23.recover());
  const sameFrame =
    Buffer.compare(
      Buffer.from(decodeFrame(recovered.frame.rgbaBase64)),
      Buffer.from(preLoss.rgba),
    ) === 0;
  rows.sameFrame = sameFrame;
  if (!sameFrame) failures.push('device loss: the recovered frame differs from the pre-loss one');
  if (recovered.counters.effectPipelineAvailable !== true)
    failures.push('device loss: no effect pipeline after recovery');
  const afterRecovery = textures((await render(page, plain)).result.counters);
  rows.afterRecovery = afterRecovery;
  if (JSON.stringify(afterRecovery) !== JSON.stringify(resizedBaseline))
    failures.push(`after recovery ${JSON.stringify(afterRecovery)}`);
  const disposed = await page.evaluate(() => window.__vectorStudioE23.dispose());
  rows.disposedLive = disposed.resources.live;
  if (disposed.resources.live !== 0) failures.push(`live after dispose ${disposed.resources.live}`);
  writeReport('a09', { rows, failures });
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- V-36 U3: background blur (V36-A04 G5 to G7 and G9, A06's nested case, A07). ---

const backgroundBlur = (sigma: number): SceneEffect => ({ kind: 'backgroundBlur', sigma });
const STRIPE_A: SceneColor = { r: 0.95, g: 0.35, b: 0.1, a: 1 };
const STRIPE_B: SceneColor = { r: 0.1, g: 0.25, b: 0.85, a: 1 };
const GLASS: SceneColor = { r: 1, g: 1, b: 1, a: 0.3 };

/** Vertical stripes past every edge of the 512 × 320 target: the backdrop `D`. */
const stripes = (): RenderNodeSnapshot[] =>
  Array.from({ length: 36 }, (_, index) =>
    shape(
      `stripe-${index}`,
      null,
      'rectangle',
      [-40 + index * 16, -40, 8, 400],
      index % 3 === 0 ? STRIPE_B : STRIPE_A,
    ),
  );

type GlassFixture = Readonly<{
  name: string;
  /** The root's subtree (and its clipping frame), drawn over the stripes. */
  nodes: readonly RenderNodeSnapshot[];
  /** The root's subtree without the ancestors' clip: its `L` capture. */
  contentNodes: readonly RenderNodeSnapshot[];
  /** The stripes and anything else drawn without the root: `D`'s capture. */
  under: readonly RenderNodeSnapshot[];
  effects: readonly SceneEffect[];
  contentOpacity: number;
  clip?: readonly [number, number, number, number];
}>;

const glassCard = (
  id: string,
  parentId: string | null,
  rect: readonly [number, number, number, number],
  effects: readonly SceneEffect[],
  fill: SceneColor = GLASS,
  opacity = 1,
) => shape(id, parentId, 'rectangle', rect, fill, { effects, opacity });

const G5 = glassCard('g5', null, [120, 70, 180, 120], [backgroundBlur(10)]);
const GLASS_FIXTURES: readonly GlassFixture[] = [
  {
    name: 'G5 background blur radius 20 of a 30 % fill over stripes',
    nodes: [G5],
    contentNodes: [G5],
    under: stripes(),
    effects: G5.effects!,
    contentOpacity: 1,
  },
  {
    name: 'G6 G5 in a clipping frame',
    nodes: [
      container('g6f', ['g6'], [], {
        clip: { kind: 'rect', x: 160, y: 100, width: 110, height: 70 },
      }),
      glassCard('g6', 'g6f', [120, 70, 180, 120], [backgroundBlur(10)]),
    ],
    contentNodes: [glassCard('g6', null, [120, 70, 180, 120], [backgroundBlur(10)])],
    under: stripes(),
    effects: [backgroundBlur(10)],
    contentOpacity: 1,
    clip: [160, 100, 110, 70],
  },
  {
    name: 'G7 G5 at the target edge, radius 40 (downsampled, clamp)',
    nodes: [glassCard('g7', null, [-30, 180, 200, 160], [backgroundBlur(20)])],
    contentNodes: [glassCard('g7', null, [-30, 180, 200, 160], [backgroundBlur(20)])],
    under: stripes(),
    effects: [backgroundBlur(20)],
    contentOpacity: 1,
  },
  {
    name: 'G9 background blur with a drop shadow on a leaf at opacity 0.5',
    nodes: [
      glassCard(
        'g9',
        null,
        [300, 140, 140, 100],
        [dropShadow(12, 10, 6), backgroundBlur(8)],
        { ...TEAL, a: 0.4 },
        0.5,
      ),
    ],
    contentNodes: [
      glassCard(
        'g9',
        null,
        [300, 140, 140, 100],
        [dropShadow(12, 10, 6), backgroundBlur(8)],
        { ...TEAL, a: 0.4 },
        0.5,
      ),
    ],
    under: stripes(),
    effects: [dropShadow(12, 10, 6), backgroundBlur(8)],
    contentOpacity: 0.5,
  },
];

/** A frame's bytes as premultiplied colour in [0, 1] (the frame is opaque). */
function imageOf(rgba: Uint8Array, width: number, height: number): OracleImage {
  const image = oracleImage({ x: 0, y: 0, width, height });
  for (let index = 0; index < width * height * 4; index += 1)
    image.data[index] = rgba[index]! / 255;
  return image;
}

for (const samples of [1, 4] as const) {
  test(`V36-A04 background blur against the oracle at ${samples}x`, async ({ browser }) => {
    test.setTimeout(240_000);
    const effectsPage = await browser.newPage();
    const contentPage = await browser.newPage();
    const effects = await open(effectsPage, { samples, effects: 'v1' });
    const content = await open(contentPage, { samples, effects: 'v1', content: true });
    const rows: unknown[] = [];
    for (const fixture of GLASS_FIXTURES) {
      const drawn = await render(effectsPage, [...fixture.under, ...fixture.nodes]);
      const { width, height } = drawn.result.frame;
      const target = { x: 0, y: 0, width, height };
      // D: the frame without the root.
      const d = imageOf((await render(effectsPage, fixture.under)).rgba, width, height);
      // L: the root's content alone, over black and over white.
      const black = await render(contentPage, fixture.contentNodes);
      const white = await render(contentPage, [backdrop(width, height), ...fixture.contentNodes]);
      const l = contentOf(black.rgba, white.rgba, width, height);
      const c = fixture.contentOpacity;
      const sigmaPx = fixture.effects.find((effect) => effect.kind === 'backgroundBlur')!.sigma;
      const r = effectOracle(l, target, {
        shadows: fixture.effects.flatMap((effect) =>
          effect.kind === 'dropShadow'
            ? [
                {
                  color: effect.color,
                  dx: effect.offsetX,
                  dy: effect.offsetY,
                  sigmaPx: effect.sigma,
                },
              ]
            : [],
        ),
        blurSigmaPx: null,
        contentOpacity: c,
      });
      // P ← B × o over D, then R × o over that (the root's opacity o is c for a leaf).
      const b = backgroundBlurOracle(d, target, target, sigmaPx, l, c);
      if (fixture.clip !== undefined) {
        clipImage(b, fixture.clip);
        clipImage(r, fixture.clip);
      }
      const glassed = new Float64Array(width * height * 4);
      for (let index = 0; index < width * height; index += 1) {
        const at = index * 4;
        const alpha = b.data[at + 3]! * c;
        for (let lane = 0; lane < 4; lane += 1)
          glassed[at + lane] = b.data[at + lane]! * c + d.data[at + lane]! * (1 - alpha);
      }
      // V36-A04: texels where 0 < α(L) < 2/255 are left out (the 127× gain of `h`).
      const faint = (x: number, y: number) => {
        const alpha = l.data[(y * width + x) * 4 + 3]!;
        return alpha > 0 && alpha < 2 / 255;
      };
      const result = compare(drawn.rgba, r, c, glassed, fixture.clip, faint);
      const tolerance = oracleLevels(sigmaPx) > 0 ? 6 : 3;
      // The blur shows: pixels that differ from the frame with the root drawn without it.
      const plain = await render(effectsPage, [
        ...fixture.under,
        ...fixture.nodes.map((node) =>
          node.effects === undefined
            ? node
            : {
                ...node,
                effects: node.effects.map((effect) =>
                  effect.kind === 'backgroundBlur' ? backgroundBlur(0) : effect,
                ),
              },
        ),
      ]);
      let changed = 0;
      for (let index = 0; index < width * height; index += 1) {
        const at = index * 4;
        if ([0, 1, 2].some((lane) => Math.abs(drawn.rgba[at + lane]! - plain.rgba[at + lane]!) > 8))
          changed += 1;
      }
      const counters = drawn.result.counters;
      rows.push({
        fixture: fixture.name,
        tolerance,
        ...result,
        changed,
        effectPasses: counters.effectPasses,
        blendSplits: counters.blendSplits,
        backgroundBlurSkipped: counters.backgroundBlurSkipped,
      });
      expect(changed, fixture.name).toBeGreaterThan(500);
      expect(counters.backgroundBlurSkipped, fixture.name).toBe(0);
      expect(result.worst, `${fixture.name} at ${result.at.join(', ')}`).toBeLessThanOrEqual(
        tolerance,
      );
    }
    const diagnostics = await effectsPage.evaluate(() => window.__vectorStudioE23.diagnostics());
    writeReport(`v36-a04-background-${samples}x`, {
      adapter: effects.ready.adapter,
      rows,
      errors: diagnostics.filter((event) => event.severity === 'error').map((event) => event.code),
    });
    expect(effects.pageErrors).toEqual([]);
    expect(content.pageErrors).toEqual([]);
  });
}

test('V36-A06 a nested background blur draws without its blur and is counted', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  const { pageErrors } = await open(page, { samples: 4, effects: 'v1' });
  const nested = (sigma: number) => [
    ...stripes(),
    container('n', ['nc'], [], { opacity: 0.5 }),
    glassCard('nc', 'n', [120, 70, 180, 120], [backgroundBlur(sigma)]),
  ];
  const before = await counters(page);
  const blurred = await render(page, nested(10));
  const skipped = blurred.result.counters.backgroundBlurSkipped - before.backgroundBlurSkipped;
  const splits = blurred.result.counters.blendSplits - before.blendSplits;
  // The same frame with a σ below the epsilon: no blur, no skip; identical bytes.
  const tiny = await render(page, nested(1e-4));
  const identical = Buffer.compare(Buffer.from(blurred.rgba), Buffer.from(tiny.rgba)) === 0;
  writeReport('v36-a06-nested', { skipped, splits, identical });
  expect(skipped).toBeGreaterThanOrEqual(1);
  expect(splits).toBe(0);
  expect(tiny.result.counters.backgroundBlurSkipped).toBe(
    blurred.result.counters.backgroundBlurSkipped,
  );
  expect(identical).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('V36-A07 background-blur edits cost no port calls or geometry; textures released', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  const { pageErrors } = await open(page, { samples: 4, effects: 'v1' });
  const failures: string[] = [];
  const rows: Record<string, unknown> = {};
  const card = glassCard('a07g', null, [120, 70, 180, 120], [backgroundBlur(10)]);
  const scene = [...stripes(), star('a07s', null, [140, 90], 80, RED), card];
  const baseline = textures((await render(page, scene.slice(0, -1))).result.counters);
  await show(page, scene);
  const edits: Record<string, readonly SceneEffect[]> = {
    sigma: [backgroundBlur(16)],
    withShadow: [dropShadow(4, 6, 3), backgroundBlur(16)],
    removed: [],
    added: [backgroundBlur(6)],
  };
  for (const [name, effects] of Object.entries(edits)) {
    const before = await counters(page);
    const edited = await edit(page, [
      { ...withoutEffects(card), ...(effects.length === 0 ? {} : { effects }) },
    ]);
    const value = cost(before, edited.counters);
    rows[`edit-${name}`] = value;
    if (value.portCalls !== 0 || value.strokePortCalls !== 0 || value.geometryBuilds !== 0)
      failures.push(`edit ${name}: ${JSON.stringify(value)}`);
  }
  // D, B and the scratch are transient: after the frame the live textures are the baseline's.
  const drawn = await render(page, scene);
  rows.textures = { baseline, after: textures(drawn.result.counters) };
  if (JSON.stringify(textures(drawn.result.counters)) !== JSON.stringify(baseline))
    failures.push(`textures after the frame ${JSON.stringify(rows.textures)}`);
  writeReport('v36-a07-background', { rows, failures });
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});
