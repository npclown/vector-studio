import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneColor,
  SceneEffect,
  SceneImagePaint,
  ScenePaint,
} from '@vector-studio/contracts';
import type { E23GradientPaintApi } from '../../apps/playground/src/e23-gradient-paint.js';
import {
  IDENTITY,
  decodeFrame,
  invert,
  multiply,
  rotate,
  translate,
  type Affine,
} from '../support/p4-clip-oracle.js';

declare global {
  interface Window {
    __vectorStudioE23: E23GradientPaintApi;
  }
}

// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U3, V32-A06: the headed GPU spec of
// image paints on the E23 check page with `paints=image`, whose scripted image port the spec
// fills. The 64 × 32 test image has four flat quadrants (one half transparent, for the
// premultiply); fixtures are drawn at DPR 1 and 2 with 4x samples. Interior probes sit at least 2
// texels of the sampled level from every colour change of the image and 2 physical px from every
// shape, clip and mask edge, and must be within 3 per channel of the quadrant colour over the
// page's opaque black (V32-K1). Edge probes compare a band across a shape edge with the same
// scene drawn with a solid fill of the edge's colour, within the E23 edge tolerance. A minified
// checker is compared with its box-filtered grey; pending then ready, a failed key and device
// loss follow (V32-K3, K5). Each test writes its report under artifacts/v32-image-paint (or
// V32_OUTPUT_DIR).

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.V32_OUTPUT_DIR ?? 'artifacts/v32-image-paint',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

const INTERIOR_TOLERANCE = 3;
const EDGE_TOLERANCE = 4;
const IMAGE = Object.freeze({ width: 64, height: 32 });
/** Straight RGBA8 quadrant colours: top left, top right, bottom left, bottom right. */
const QUADRANTS = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 128],
] as const;
const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };

function quadrantImage(): Uint8Array {
  const pixels = new Uint8Array(IMAGE.width * IMAGE.height * 4);
  for (let y = 0; y < IMAGE.height; y += 1) {
    for (let x = 0; x < IMAGE.width; x += 1) {
      const quadrant = (y < IMAGE.height / 2 ? 0 : 2) + (x < IMAGE.width / 2 ? 0 : 1);
      pixels.set(QUADRANTS[quadrant]!, (y * IMAGE.width + x) * 4);
    }
  }
  return pixels;
}

/** A 64 × 64 checker of 1 px black and white cells. */
function checkerImage(): Uint8Array {
  const pixels = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const value = (x + y) % 2 === 0 ? 255 : 0;
      pixels.set([value, value, value, 255], (y * 64 + x) * 4);
    }
  }
  return pixels;
}

/** The premultiplied quadrant colour over opaque black, times `opacity`. */
function quadrantOverBlack(quadrant: number, opacity = 1): readonly number[] {
  const [r, g, b, a] = QUADRANTS[quadrant]!;
  return [r, g, b].map((channel) => Math.round((channel * a) / 255) * opacity);
}

function imagePaint(
  key: string,
  transform: Affine,
  wrapX: SceneImagePaint['wrapX'] = 'extend',
  wrapY: SceneImagePaint['wrapY'] = wrapX,
): SceneImagePaint {
  return { kind: 'image', image: key, transform, wrapX, wrapY };
}

type Shape =
  | Readonly<{ kind: 'rectangle'; width: number; height: number }>
  | Readonly<{ kind: 'ellipse'; width: number; height: number }>;

function primitive(
  id: string,
  transform: Affine,
  shape: Shape,
  fill: ScenePaint,
  extra: Partial<{ parentId: string; opacity: number; effects: readonly SceneEffect[] }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId: extra.parentId ?? null,
    transform,
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'primitive',
    geometry: shape.kind === 'rectangle' ? { ...shape, cornerRadii: [0, 0, 0, 0] } : { ...shape },
    style: { fill, stroke: null },
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

/** A 200 × 120 rectangle with an 80 × 40 hole, even-odd. */
function holedPath(id: string, transform: Affine, fill: ScenePaint): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform,
    visible: true,
    opacity: 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: ['move', 'line', 'line', 'line', 'close', 'move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 200, 0, 200, 120, 0, 120, 60, 40, 140, 40, 140, 80, 60, 80],
      fillRule: 'evenodd',
    },
    style: { fill, stroke: null },
  };
}

function snapshotOf(nodes: readonly RenderNodeSnapshot[]): RenderSceneSnapshot {
  return {
    identity: { documentId: 'v32-u3', pageId: 'page' },
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  };
}

/** A probe region: node-local points of a shape, with that shape's world map and paint map. */
type Region = Readonly<{
  /** Node-local world map. */
  world: Affine;
  /** The paint's transform: image space [0, 1]² to node-local space. */
  paint: Affine;
  wrap: Readonly<{ x: SceneImagePaint['wrapX']; y: SceneImagePaint['wrapY'] }>;
  /** Whether a node-local point is inside the shape at least `margin` local units from its edge. */
  inside: (x: number, y: number, margin: number) => boolean;
  opacity?: number;
  /** Probed quadrants; all when absent (a drop shadow shows through the translucent one). */
  quadrants?: readonly number[];
}>;

type Fixture = Readonly<{
  name: string;
  nodes: readonly RenderNodeSnapshot[];
  regions: readonly Region[];
  /** Edge bands: the same scene with a solid fill of the edge colour, and the band's pixels. */
  edges?: Readonly<{
    solid: readonly RenderNodeSnapshot[];
    band: (dpr: number) => readonly (readonly [number, number])[];
  }>;
}>;

const rectInside =
  (width: number, height: number) =>
  (x: number, y: number, margin: number): boolean =>
    x >= margin && y >= margin && x <= width - margin && y <= height - margin;

const ellipseInside =
  (width: number, height: number) =>
  (x: number, y: number, margin: number): boolean => {
    const rx = width / 2 - margin;
    const ry = height / 2 - margin;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (x - width / 2) / rx;
    const dy = (y - height / 2) / ry;
    return dx * dx + dy * dy <= 1;
  };

const holedInside = (x: number, y: number, margin: number): boolean =>
  rectInside(200, 120)(x, y, margin) &&
  !(x >= 60 - margin && x <= 140 + margin && y >= 40 - margin && y <= 80 + margin);

const apply = (m: Affine, x: number, y: number): readonly [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** The expected colour at image point (u, v), or null when within 2 texels of a colour change. */
function expectedAt(region: Region, u: number, v: number): readonly number[] | null | 'clear' {
  const axis = (value: number, mode: SceneImagePaint['wrapX'], size: number) => {
    if (mode === 'decal' && (value < 0 || value > 1)) {
      // Transparent outside; 2 texels from the image edge.
      return value * size < -2 || value * size > size + 2 ? 'clear' : null;
    }
    if (mode === 'decal' && (value * size < 2 || value * size > size - 2)) return null;
    const wrapped = mode === 'repeat' ? value - Math.floor(value) : Math.min(1, Math.max(0, value));
    const texel = wrapped * size;
    // Repeat seams and the quadrant split are colour changes.
    if (mode === 'repeat' && (texel < 2 || texel > size - 2)) return null;
    if (Math.abs(texel - size / 2) < 2) return null;
    return texel < size / 2 ? 0 : 1;
  };
  const column = axis(u, region.wrap.x, IMAGE.width);
  const row = axis(v, region.wrap.y, IMAGE.height);
  if (column === 'clear' || row === 'clear') return 'clear';
  if (column === null || row === null) return null;
  const quadrant = row * 2 + column;
  if (region.quadrants !== undefined && !region.quadrants.includes(quadrant)) return null;
  return quadrantOverBlack(quadrant, region.opacity ?? 1);
}

function fixtures(): Fixture[] {
  const list: Fixture[] = [];
  // Stretch: a rotated rectangle, with an edge band across its left edge in the top-left quadrant.
  {
    const world = multiply(translate(60, 30), rotate(15));
    const paint: Affine = [200, 0, 0, 100, 0, 0];
    const node = (fill: ScenePaint) =>
      primitive('stretch', world, { kind: 'rectangle', width: 200, height: 100 }, fill);
    list.push({
      name: 'stretch rotated rectangle',
      nodes: [node(imagePaint('quadrants', paint))],
      regions: [{ world, paint, wrap: { x: 'extend', y: 'extend' }, inside: rectInside(200, 100) }],
      edges: {
        solid: [node(RED)],
        band: (dpr) => edgeBand(world, [0, 8], [0, 42], dpr),
      },
    });
  }
  // Fill: a rotated ellipse, the image scaled to cover it and centred.
  {
    const world = multiply(translate(120, 40), rotate(30));
    const paint: Affine = [240, 0, 0, 120, -40, 0];
    list.push({
      name: 'fill rotated ellipse',
      nodes: [
        primitive(
          'fill',
          world,
          { kind: 'ellipse', width: 160, height: 120 },
          imagePaint('quadrants', paint),
        ),
      ],
      regions: [
        { world, paint, wrap: { x: 'extend', y: 'extend' }, inside: ellipseInside(160, 120) },
      ],
    });
  }
  // Fit: a path with a hole, the image letterboxed on y (decal), with an edge band across the
  // path's left edge, the axis the image spans.
  {
    const world = translate(40, 40);
    const paint: Affine = [200, 0, 0, 100, 0, 10];
    const node = (fill: ScenePaint) => holedPath('fit', world, fill);
    list.push({
      name: 'fit path with a hole',
      nodes: [node(imagePaint('quadrants', paint, 'extend', 'decal'))],
      regions: [{ world, paint, wrap: { x: 'extend', y: 'decal' }, inside: holedInside }],
      edges: {
        solid: [node(RED)],
        band: (dpr) => edgeBand(world, [0, 15], [0, 50], dpr),
      },
    });
  }
  // Tile at scale 0.5: 32 × 16 tiles across a 200 × 100 frame-sized rectangle.
  {
    const world = translate(30, 30);
    const paint: Affine = [32, 0, 0, 16, 0, 0];
    list.push({
      name: 'tile at 0.5',
      nodes: [
        primitive(
          'tile',
          world,
          { kind: 'rectangle', width: 200, height: 100 },
          imagePaint('quadrants', paint, 'repeat'),
        ),
      ],
      regions: [{ world, paint, wrap: { x: 'repeat', y: 'repeat' }, inside: rectInside(200, 100) }],
    });
  }
  // Under a mask (an ellipse source), at opacity 0.5, and with a drop shadow.
  {
    const maskWorld = translate(20, 20);
    const contentWorld = translate(20, 20);
    const paint: Affine = [200, 0, 0, 120, 0, 0];
    const opacityWorld = translate(240, 20);
    const shadowWorld = translate(240, 170);
    const small: Affine = [120, 0, 0, 80, 0, 0];
    list.push({
      name: 'mask, opacity and drop shadow',
      nodes: [
        {
          id: 'mask',
          parentId: null,
          transform: IDENTITY,
          visible: true,
          opacity: 1,
          kind: 'container',
          clip: { kind: 'mask' },
          children: ['mask-source', 'mask-content'],
        },
        primitive('mask-source', maskWorld, { kind: 'ellipse', width: 200, height: 120 }, RED, {
          parentId: 'mask',
        }),
        primitive(
          'mask-content',
          contentWorld,
          { kind: 'rectangle', width: 200, height: 120 },
          imagePaint('quadrants', paint),
          { parentId: 'mask' },
        ),
        primitive(
          'half',
          opacityWorld,
          { kind: 'rectangle', width: 120, height: 80 },
          imagePaint('quadrants', small),
          { opacity: 0.5 },
        ),
        primitive(
          'shadowed',
          shadowWorld,
          { kind: 'rectangle', width: 120, height: 80 },
          imagePaint('quadrants', small),
          {
            effects: [
              {
                kind: 'dropShadow',
                color: { r: 1, g: 1, b: 1, a: 1 },
                offsetX: 12,
                offsetY: 12,
                sigma: 3,
              },
            ],
          },
        ),
      ],
      regions: [
        {
          world: contentWorld,
          paint,
          wrap: { x: 'extend', y: 'extend' },
          inside: ellipseInside(200, 120),
        },
        {
          world: opacityWorld,
          paint: small,
          wrap: { x: 'extend', y: 'extend' },
          inside: rectInside(120, 80),
          opacity: 0.5,
        },
        {
          world: shadowWorld,
          paint: small,
          wrap: { x: 'extend', y: 'extend' },
          inside: rectInside(120, 80),
          quadrants: [0, 1, 2],
        },
      ],
    });
  }
  return list;
}

/**
 * The device pixels within 1.5 px of the local edge segment from `from` to `to` (a left edge at
 * x = from[0]), for local y in [from[1], to[1]].
 */
function edgeBand(
  world: Affine,
  from: readonly [number, number],
  to: readonly [number, number],
  dpr: number,
): (readonly [number, number])[] {
  const inverse = invert(world);
  const pixels: (readonly [number, number])[] = [];
  const corners = [apply(world, from[0], from[1]), apply(world, to[0], to[1])];
  const minX = Math.floor(Math.min(...corners.map((c) => c[0])) * dpr) - 4;
  const maxX = Math.ceil(Math.max(...corners.map((c) => c[0])) * dpr) + 4;
  const minY = Math.floor(Math.min(...corners.map((c) => c[1])) * dpr) - 4;
  const maxY = Math.ceil(Math.max(...corners.map((c) => c[1])) * dpr) + 4;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const [lx, ly] = apply(inverse, (x + 0.5) / dpr, (y + 0.5) / dpr);
      if (Math.abs(lx - from[0]) * dpr <= 1.5 && ly >= from[1] + 2 && ly <= to[1] - 2) {
        pixels.push([x, y]);
      }
    }
  }
  return pixels;
}

function reporter(name: string, info: { project: { name: string } }) {
  const directory = path.join(runRoot, info.project.name, name);
  mkdirSync(directory, { recursive: true });
  return (file: string, data: string) =>
    writeFileSync(path.join(directory, file), data, { flag: 'wx' });
}

const HOME: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };

async function open(page: Page, dpr: number) {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(
    `/e23-gradient-paint.html?samples=4&dpr=${dpr}&paints=image&groups=isolated&effects=v0`,
  );
  const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
  expect(ready.supported, JSON.stringify(ready)).toBe(true);
  return { ready, pageErrors };
}

async function setImage(page: Page, key: string, width: number, pixels: Uint8Array) {
  const height = pixels.length / (4 * width);
  await page.evaluate(([k, w, h, data]) => window.__vectorStudioE23.setImage(k, w, h, data), [
    key,
    width,
    height,
    Buffer.from(pixels).toString('base64'),
  ] as const);
}

async function render(
  page: Page,
  nodes: readonly RenderNodeSnapshot[],
  camera: RenderCamera = HOME,
) {
  const result = await page.evaluate(
    ([snapshot, view]) => window.__vectorStudioE23.render(snapshot, view),
    [snapshotOf(nodes), camera] as const,
  );
  expect(result.status).toBe('applied');
  return { result, rgba: decodeFrame(result.frame.rgbaBase64) };
}

type Rendered = Awaited<ReturnType<typeof render>>;

function pixel(rendered: Rendered, x: number, y: number): readonly number[] {
  const at = (y * rendered.result.frame.width + x) * 4;
  return [rendered.rgba[at]!, rendered.rgba[at + 1]!, rendered.rgba[at + 2]!];
}

/** Interior probes of every region on a grid of physical pixels. */
function probeInterior(rendered: Rendered, fixture: Fixture, dpr: number) {
  const failures: string[] = [];
  let probes = 0;
  let clear = 0;
  let worst = 0;
  const { width, height } = rendered.result.frame;
  for (const region of fixture.regions) {
    const inverseWorld = invert(region.world);
    const inversePaint = invert(region.paint);
    for (let y = 1; y < height; y += 3) {
      for (let x = 1; x < width; x += 3) {
        const [lx, ly] = apply(inverseWorld, (x + 0.5) / dpr, (y + 0.5) / dpr);
        if (!region.inside(lx, ly, 2 / dpr + 1e-9)) continue;
        const [u, v] = apply(inversePaint, lx, ly);
        const expected = expectedAt(region, u, v);
        if (expected === null) continue;
        const want = expected === 'clear' ? [0, 0, 0] : expected;
        if (expected === 'clear') clear += 1;
        probes += 1;
        const got = pixel(rendered, x, y);
        for (let lane = 0; lane < 3; lane += 1) {
          const difference = Math.abs(got[lane]! - want[lane]!);
          worst = Math.max(worst, difference);
          if (difference > INTERIOR_TOLERANCE && failures.length < 12) {
            failures.push(
              `${fixture.name} (${x}, ${y}) uv (${u.toFixed(3)}, ${v.toFixed(3)}) lane ${lane}: ${got[lane]} vs ${want[lane]!.toFixed(1)}`,
            );
          }
        }
      }
    }
  }
  return { probes, clear, worst, failures };
}

for (const dpr of [1, 2]) {
  test.describe(`V32-A06 image paints at DPR ${dpr}`, () => {
    test('interior probes, edge bands and fit transparency', async ({ page }, info) => {
      test.setTimeout(240_000);
      const write = reporter(`dpr-${dpr}-fixtures`, info);
      const { ready, pageErrors } = await open(page, dpr);
      await setImage(page, 'quadrants', IMAGE.width, quadrantImage());
      const report: unknown[] = [];
      for (const fixture of fixtures()) {
        const rendered = await render(page, fixture.nodes);
        const interior = probeInterior(rendered, fixture, dpr);
        let edge: { probes: number; worst: number; failures: string[] } | null = null;
        if (fixture.edges !== undefined) {
          const solid = await render(page, fixture.edges.solid);
          const failures: string[] = [];
          let worst = 0;
          const band = fixture.edges.band(dpr);
          for (const [x, y] of band) {
            const got = pixel(rendered, x, y);
            const want = pixel(solid, x, y);
            for (let lane = 0; lane < 3; lane += 1) {
              const difference = Math.abs(got[lane]! - want[lane]!);
              worst = Math.max(worst, difference);
              if (difference > EDGE_TOLERANCE && failures.length < 12) {
                failures.push(
                  `${fixture.name} edge (${x}, ${y}) lane ${lane}: ${got[lane]} vs ${want[lane]}`,
                );
              }
            }
          }
          edge = { probes: band.length, worst, failures };
        }
        report.push({
          fixture: fixture.name,
          interior,
          edge,
          packet: rendered.result.frame.packet,
        });
        expect(interior.probes, fixture.name).toBeGreaterThan(50);
        expect(interior.failures, fixture.name).toEqual([]);
        if (fixture.name.startsWith('fit'))
          expect(interior.clear, 'fit letterbox').toBeGreaterThan(0);
        if (edge !== null) {
          expect(edge.probes, `${fixture.name} edge`).toBeGreaterThan(10);
          expect(edge.failures, `${fixture.name} edge`).toEqual([]);
        }
      }
      const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
      write('report.json', JSON.stringify({ ready, report, diagnostics }, null, 2));
      expect(diagnostics.filter((event) => event.code.startsWith('render.image'))).toEqual([]);
      expect(pageErrors).toEqual([]);
    });

    test('a minified checker matches its box-filtered grey', async ({ page }, info) => {
      const write = reporter(`dpr-${dpr}-minified`, info);
      await open(page, dpr);
      await setImage(page, 'checker', 64, checkerImage());
      const node = primitive(
        'checker',
        translate(64, 64),
        { kind: 'rectangle', width: 256, height: 256 },
        imagePaint('checker', [64, 0, 0, 64, 0, 0], 'repeat'),
      );
      const zoom = 0.25;
      const rendered = await render(page, [node], { position: { x: 0, y: 0 }, zoom });
      // The rectangle covers device [16, 80)·dpr; probe 2 px inside.
      const values: number[] = [];
      for (let y = 18 * dpr; y < 78 * dpr; y += 2) {
        for (let x = 18 * dpr; x < 78 * dpr; x += 2) values.push(...pixel(rendered, x, y));
      }
      const worst = Math.max(...values.map((value) => Math.abs(value - 127.5)));
      const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
      const requests = await page.evaluate(() => window.__vectorStudioE23.imageRequests());
      write(
        'report.json',
        JSON.stringify(
          {
            probes: values.length / 3,
            worst,
            packet: rendered.result.frame.packet,
            diagnostics,
            requests,
            sample: pixel(rendered, 40 * dpr, 40 * dpr),
          },
          null,
          2,
        ),
      );
      expect(values.length).toBeGreaterThan(300);
      expect(worst).toBeLessThanOrEqual(INTERIOR_TOLERANCE);
    });

    test('pending then ready, a failed key, and device loss', async ({ page }, info) => {
      test.setTimeout(120_000);
      const write = reporter(`dpr-${dpr}-lifecycle`, info);
      await open(page, dpr);
      const nodes = [
        primitive(
          'late',
          translate(20, 20),
          { kind: 'rectangle', width: 120, height: 80 },
          imagePaint('late', [120, 0, 0, 80, 0, 0]),
        ),
        primitive(
          'broken',
          translate(200, 20),
          { kind: 'rectangle', width: 120, height: 80 },
          imagePaint('broken', [120, 0, 0, 80, 0, 0]),
        ),
      ];
      await page.evaluate(() => {
        window.__vectorStudioE23.setImageStatus('late', 'pending');
        window.__vectorStudioE23.setImageStatus('broken', 'failed');
      });
      const probe = (rendered: Rendered, x: number, y: number) =>
        pixel(rendered, Math.round(x * dpr), Math.round(y * dpr));
      const pending = await render(page, nodes);
      expect(probe(pending, 40, 40)).toEqual([0, 0, 0]);
      expect(probe(pending, 220, 40)).toEqual([0, 0, 0]);
      // Ready, then the port's notification alone submits a new frame.
      await setImage(page, 'late', IMAGE.width, quadrantImage());
      const before = await page.evaluate(
        () => window.__vectorStudioE23.counters().statistics.framesSubmitted,
      );
      await page.evaluate(() => window.__vectorStudioE23.notifyImages(['late']));
      await page.waitForFunction(
        (count) => window.__vectorStudioE23.counters().statistics.framesSubmitted > count,
        before,
      );
      const drawn = await render(page, nodes);
      const red = probe(drawn, 40, 40);
      for (const [lane, value] of quadrantOverBlack(0).entries()) {
        expect(Math.abs(red[lane]! - value)).toBeLessThanOrEqual(INTERIOR_TOLERANCE);
      }
      expect(probe(drawn, 220, 40)).toEqual([0, 0, 0]);
      await render(page, nodes);
      const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
      const unavailable = diagnostics.filter((event) => event.code === 'render.image-unavailable');
      expect(unavailable).toHaveLength(1);
      // Device loss: the recovered generation requests the images again and redraws identically.
      const requestsBefore = await page.evaluate(() =>
        window.__vectorStudioE23.imageRequests().filter((key) => key === 'late'),
      );
      const recovered = await page.evaluate(() => window.__vectorStudioE23.recover());
      const requestsAfter = await page.evaluate(() =>
        window.__vectorStudioE23.imageRequests().filter((key) => key === 'late'),
      );
      expect(requestsAfter.length).toBeGreaterThan(requestsBefore.length);
      const same = recovered.frame.rgbaBase64 === drawn.result.frame.rgbaBase64;
      write(
        'report.json',
        JSON.stringify(
          {
            unavailable,
            requestsBefore: requestsBefore.length,
            requestsAfter: requestsAfter.length,
            same,
          },
          null,
          2,
        ),
      );
      expect(same).toBe(true);
    });
  });
}
