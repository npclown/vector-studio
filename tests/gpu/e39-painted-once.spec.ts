import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { RenderNodeSnapshot, ScenePaint } from '@vector-studio/contracts';
import type { E39RenderResult, E39Scene } from '../../apps/playground/src/e39-painted-once.js';

// E39 contract (docs/plans/d9-e39-gpu-stencil-path-contract.md), unit E39-U5, criterion E39-A6:
// painted once and no stencil leak, headed, on the `e39-painted-once.html` check page with the
// release WASM. Manual, never CI; it needs `pnpm build` and the release WASM:
//
//   pnpm exec playwright test -c playwright.gpu.config.ts tests/gpu/e39-painted-once.spec.ts
//
// At 1x and 4x, DPR 1 and 2, zoom 1, 4 and 8:
// 1. Winding (nonzero and evenodd star fills), union (a self-crossing round-capped stroke) and
//    joint (a star filled and stroked) fixtures, one path each: every sample counts at most 1,
//    and every pixel at least 1 device pixel inside the reference region counts 1 at every
//    sample and has the paint's colour, every pixel at least 1 device pixel outside counts 0
//    and is the black clear. The joint's stroke-only and fill-only pixels have their own paint,
//    and the stroke wins where both cover.
// 2. Leak: a star with a fully transparent fill, then a rectangle with a zero-alpha gradient,
//    then an opaque rectangle over the same pixels: every pixel 1 device pixel inside the last
//    rectangle has its colour, so neither transparent path left stencil behind.
// Each test writes .tools/e39-painted-once/<stamp>/<project>/<name>.json. Functional evidence.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E39_OUTPUT_DIR ?? '.tools/e39-painted-once',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

type Point = readonly [number, number];
type Rgb = readonly [number, number, number];

const RED = { r: 1, g: 0, b: 0, a: 1 };
const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };
const CLEAR = { r: 1, g: 1, b: 1, a: 0 };
const CENTRE: Point = [50, 40];

/** A five-pointed star drawn in star order, so its centre has winding 2. */
const STAR: readonly Point[] = Array.from({ length: 5 }, (_, i) => {
  const angle = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
  return [CENTRE[0] + 36 * Math.cos(angle), CENTRE[1] + 36 * Math.sin(angle)] as const;
});
/** An open polyline that crosses itself, stroked with round caps and joins. */
const CROSSING: readonly Point[] = [
  [10, 10],
  [90, 70],
  [90, 10],
  [10, 70],
];
const RECT: readonly Point[] = [
  [0, 0],
  [100, 0],
  [100, 80],
  [0, 80],
];

function pathNode(
  id: string,
  points: readonly Point[],
  closed: boolean,
  fillRule: 'nonzero' | 'evenodd',
  fill: ScenePaint | null,
  stroke: Readonly<{ color: ScenePaint; width: number }> | null,
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: [
        'move',
        ...points.slice(1).map(() => 'line' as const),
        ...(closed ? (['close'] as const) : []),
      ],
      points: points.flat(),
      fillRule,
    },
    style: {
      fill,
      stroke:
        stroke === null
          ? null
          : {
              color: stroke.color,
              width: stroke.width,
              cap: 'round',
              join: 'round',
              miterLimit: 4,
            },
    },
  };
}

function winding(polygon: readonly Point[], x: number, y: number): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [ax, ay] = polygon[i]!;
    const [bx, by] = polygon[(i + 1) % polygon.length]!;
    const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y && by > y && cross > 0) total += 1;
    else if (ay > y && by <= y && cross < 0) total -= 1;
  }
  return total;
}

function segmentDistance(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

function polylineDistance(points: readonly Point[], closed: boolean, x: number, y: number) {
  let best = Infinity;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i += 1)
    best = Math.min(best, segmentDistance(x, y, points[i]!, points[(i + 1) % points.length]!));
  return best;
}

/** 'in', 'out' or 'edge' for a world point, with `margin` world units of slack either side. */
type Region = (x: number, y: number, margin: number) => 'in' | 'out' | 'edge';

function fillRegion(polygon: readonly Point[], rule: 'nonzero' | 'evenodd'): Region {
  return (x, y, margin) => {
    if (polylineDistance(polygon, true, x, y) <= margin) return 'edge';
    const w = winding(polygon, x, y);
    return (rule === 'nonzero' ? w !== 0 : w % 2 !== 0) ? 'in' : 'out';
  };
}

function strokeRegion(points: readonly Point[], closed: boolean, width: number): Region {
  return (x, y, margin) => {
    const d = polylineDistance(points, closed, x, y);
    if (d < width / 2 - margin) return 'in';
    if (d > width / 2 + margin) return 'out';
    return 'edge';
  };
}

type Fixture = Readonly<{
  id: string;
  nodes: readonly RenderNodeSnapshot[];
  /** Colour regions, last wins; the union of all is the painted region. */
  regions: readonly Readonly<{ region: Region; colour: Rgb }>[];
  /** Count checks apply to single-path fixtures only. */
  counted: boolean;
}>;

const FIXTURES: readonly Fixture[] = [
  {
    id: 'winding-nonzero',
    nodes: [pathNode('star', STAR, true, 'nonzero', RED, null)],
    regions: [{ region: fillRegion(STAR, 'nonzero'), colour: [255, 0, 0] }],
    counted: true,
  },
  {
    id: 'winding-evenodd',
    nodes: [pathNode('star', STAR, true, 'evenodd', RED, null)],
    regions: [{ region: fillRegion(STAR, 'evenodd'), colour: [255, 0, 0] }],
    counted: true,
  },
  {
    id: 'union-stroke',
    nodes: [pathNode('crossing', CROSSING, false, 'nonzero', null, { color: RED, width: 12 })],
    regions: [{ region: strokeRegion(CROSSING, false, 12), colour: [255, 0, 0] }],
    counted: true,
  },
  {
    id: 'joint',
    nodes: [pathNode('star', STAR, true, 'nonzero', RED, { color: GREEN, width: 8 })],
    regions: [
      { region: fillRegion(STAR, 'nonzero'), colour: [255, 0, 0] },
      { region: strokeRegion(STAR, true, 8), colour: [0, 255, 0] },
    ],
    counted: true,
  },
  {
    id: 'leak',
    nodes: [
      pathNode('clear-star', STAR, true, 'nonzero', CLEAR, { color: CLEAR, width: 8 }),
      pathNode(
        'clear-gradient',
        RECT,
        true,
        'nonzero',
        {
          kind: 'linear',
          transform: [100, 0, 0, 1, 0, 0],
          stops: [
            { offset: 0, color: CLEAR },
            { offset: 1, color: { r: 0, g: 1, b: 0, a: 0 } },
          ],
          spread: 'pad',
        },
        null,
      ),
      pathNode('opaque', RECT, true, 'nonzero', BLUE, null),
    ],
    regions: [{ region: fillRegion(RECT, 'nonzero'), colour: [0, 0, 255] }],
    counted: false,
  },
];

const VIEWPORT = { width: 160, height: 120 };

function sceneOf(fixture: Fixture, zoom: number): E39Scene {
  return {
    nodes: fixture.nodes,
    camera: {
      position: {
        x: CENTRE[0] - VIEWPORT.width / 2 / zoom,
        y: CENTRE[1] - VIEWPORT.height / 2 / zoom,
      },
      zoom,
    },
  };
}

function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const favicon =
      message.location().url.endsWith('/favicon.ico') && message.text().includes('404');
    if (message.type() === 'error' && !favicon) errors.push(message.text());
  });
  return errors;
}

function check(
  fixture: Fixture,
  scene: E39Scene,
  result: E39RenderResult,
): Readonly<{ inside: number; outside: number; failures: string[] }> {
  const rgba = new Uint8Array(Buffer.from(result.rgbaBase64, 'base64'));
  const bytes = Buffer.from(result.counts.base64, 'base64');
  const counts = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const samples = result.counts.samples;
  const scale = scene.camera.zoom * result.devicePixelRatio;
  const margin = 1 / scale;
  const failures: string[] = [];
  const fail = (message: string) => {
    if (failures.length < 12) failures.push(message);
  };
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) {
      const pixel = y * result.width + x;
      const sampleCounts = Array.from(counts.subarray(pixel * samples, (pixel + 1) * samples));
      if (fixture.counted && sampleCounts.some((count) => count > 1))
        fail(`(${x},${y}) counts ${sampleCounts.join(',')}`);
      const wx = (x + 0.5) / scale + scene.camera.position.x;
      const wy = (y + 0.5) / scale + scene.camera.position.y;
      const classes = fixture.regions.map(({ region }) => region(wx, wy, margin));
      const observed = [rgba[pixel * 4]!, rgba[pixel * 4 + 1]!, rgba[pixel * 4 + 2]!];
      let expected: Rgb | null = null;
      let expectedCount: number | null = null;
      if (classes.every((c) => c === 'out')) {
        expected = [0, 0, 0];
        expectedCount = 0;
        outside += 1;
      } else if (classes.every((c) => c !== 'edge') || classes[classes.length - 1] === 'in') {
        // Every region decided, or the last (winning) region covers the pixel outright.
        const winner = classes.lastIndexOf('in');
        expected = fixture.regions[winner]!.colour;
        expectedCount = 1;
        inside += 1;
      }
      if (expected === null) continue;
      if (expected.some((value, i) => Math.abs(value - observed[i]!) > 2))
        fail(`(${x},${y}) rgb ${observed.join(',')} expected ${expected.join(',')}`);
      if (fixture.counted && sampleCounts.some((count) => count !== expectedCount))
        fail(`(${x},${y}) counts ${sampleCounts.join(',')} expected ${String(expectedCount)}`);
    }
  }
  return { inside, outside, failures };
}

for (const samples of [1, 4] as const) {
  for (const dpr of [1, 2] as const) {
    test(`E39-A6 painted once and no stencil leak, ${String(samples)}x, DPR ${String(dpr)}`, async ({
      browser,
      page,
    }, info) => {
      test.setTimeout(300_000);
      const errors = errorsOf(page);
      await page.goto(`/e39-painted-once.html?samples=${String(samples)}&dpr=${String(dpr)}`);
      await page.waitForFunction(() => window.__vectorStudioE39 !== undefined, undefined, {
        timeout: 60_000,
      });
      const ready = await page.evaluate(() => window.__vectorStudioE39.ready);
      expect(ready.supported, String(ready.reason)).toBe(true);
      const failures: Record<string, string[]> = {};
      const report: Record<string, unknown> = {};
      for (const fixture of FIXTURES) {
        for (const zoom of [1, 4, 8]) {
          const key = `${fixture.id} z${String(zoom)}`;
          const scene = sceneOf(fixture, zoom);
          const result = await page.evaluate(
            (input) => window.__vectorStudioE39.render(input),
            scene,
          );
          expect(result.sampleCount, key).toBe(samples);
          const outcome = check(fixture, scene, result);
          if (result.diagnostics.length > 0)
            outcome.failures.push(`diagnostics ${result.diagnostics.join(',')}`);
          if (outcome.inside === 0) outcome.failures.push('no pixel inside');
          if (outcome.failures.length > 0) failures[key] = outcome.failures;
          report[key] = {
            inside: outcome.inside,
            outside: outcome.outside,
            draws: result.record?.draws.length ?? null,
            diagnostics: result.diagnostics,
          };
        }
      }
      const directory = path.join(runRoot, info.project.name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, `samples${String(samples)}-dpr${String(dpr)}.json`),
        `${JSON.stringify(
          {
            schema: 'e39-painted-once/v1',
            browser: { name: info.project.name, version: browser.version() },
            samples,
            dpr,
            report,
            failures,
            errors,
          },
          null,
          2,
        )}\n`,
      );
      expect(errors).toEqual([]);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual({});
    });
  }
}
