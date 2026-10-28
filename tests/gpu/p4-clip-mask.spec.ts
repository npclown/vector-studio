import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { RendererStatistics } from '@vector-studio/contracts';
import type { P4ClipMaskApi } from '../../apps/playground/src/p4-clip-mask.js';
import { p1Source } from '../support/p1-evidence.js';
import {
  IDENTITY,
  classify,
  container,
  decodeFrame,
  drawnLeaves,
  ellipse,
  leaf,
  levelReference,
  multiply,
  oracle,
  polygon,
  rect,
  rectCoverage,
  rotate,
  scale,
  snapshotOf,
  transformPoint,
  translate,
  worldToPixel,
  type Affine,
  type ClipLevel,
  type DrawnLeaf,
  type P4Item,
  type P4Leaf,
  type View,
} from '../support/p4-clip-oracle.js';
import {
  CENTRE,
  FAILURE_CASES,
  MASK_CASES,
  NESTING_CASES,
  OPACITY_CASE,
  RECT_CASES,
  alternatingChain,
  cover,
  viewOf,
  type ImageCase,
} from './p4-clip-mask-cases.js';

declare global {
  interface Window {
    __vectorStudioP4: P4ClipMaskApi;
  }
}

// P4 contract, unit U5 (docs/plans/p4-clip-mask.md, section 6): the headed GPU spec of clips and
// masks on the P4 check page, which injects the real geometry-wasm ports. Image checks compare
// the readback to the section 3 CPU oracle at interior probes (at least 2 physical px from every
// edge, within 2/255) and, on the edge ramps, to the product of the levels' coverages: a rect
// level is P4-K1 evaluated on the CPU, a mask level is its source's own fill draw rendered as an
// opaque white shape (P4-K2), within 4/255 plus 1/255 per mask level at depth 32. A P1
// rectangle of each rect level's placement is also rendered, for the `p1Rectangle` observation
// only (U5 record in the contract).
// Counter checks cover invalidation (A06), culling and batching (A07) and resources (A08);
// A11 is an observation with no threshold. Each test writes its report under
// artifacts/p4-clip-mask (or P4_CLIP_MASK_OUTPUT_DIR).

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.P4_CLIP_MASK_OUTPUT_DIR ?? 'artifacts/p4-clip-mask',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

const INTERIOR_TOLERANCE = 2;
const EDGE_TOLERANCE = 4;
/** P4-A05: a counter-oracle must differ from the product by more than this on named probes. */
const COUNTER_ORACLE_MARGIN = 24;
const INTERIOR_STRIDE = 3;
const MAX_EXAMPLES = 8;

type Frame = Readonly<{ rgba: Uint8Array; width: number; height: number }>;
type Rendered = Awaited<ReturnType<P4ClipMaskApi['render']>>;

function reporter(name: string, info: { project: { name: string } }) {
  const directory = path.join(runRoot, info.project.name, name);
  mkdirSync(directory, { recursive: true });
  return (file: string, data: string | Uint8Array) =>
    writeFileSync(path.join(directory, file), data, { flag: 'wx' });
}

async function open(page: Page, samples: 1 | 4, dpr: number) {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`/p4-clip-mask.html?samples=${samples}&dpr=${dpr}`);
  const ready = await page.evaluate(() => window.__vectorStudioP4.ready);
  expect(ready.supported, JSON.stringify(ready)).toBe(true);
  return { ready, pageErrors };
}

async function render(page: Page, items: readonly P4Item[], view: View) {
  const result: Rendered = await page.evaluate(
    ([snapshot, camera]) => window.__vectorStudioP4.render(snapshot, camera),
    [snapshotOf(items), view.camera] as const,
  );
  const frame: Frame = {
    rgba: decodeFrame(result.frame.rgbaBase64),
    width: result.frame.width,
    height: result.frame.height,
  };
  return { result, frame };
}

async function show(page: Page, items: readonly P4Item[], view: View) {
  return page.evaluate(([snapshot, camera]) => window.__vectorStudioP4.show(snapshot, camera), [
    snapshotOf(items),
    view.camera,
  ] as const);
}

const diagnosticCount = (page: Page) =>
  page.evaluate(() => window.__vectorStudioP4.diagnostics().length);
const diagnosticsSince = (page: Page, from: number) =>
  page.evaluate((start) => window.__vectorStudioP4.diagnostics().slice(start), from);

function pixel(frame: Frame, x: number, y: number): readonly [number, number, number] {
  const offset = (y * frame.width + x) * 4;
  return [frame.rgba[offset]!, frame.rgba[offset + 1]!, frame.rgba[offset + 2]!];
}

const deviation = (observed: readonly number[], expected: readonly number[]) =>
  Math.max(...observed.map((value, lane) => Math.abs(value - expected[lane]!)));

type Check = {
  probes: number;
  maxDeviation: number;
  failures: number;
  examples: unknown[];
};
const newCheck = (): Check => ({ probes: 0, maxDeviation: 0, failures: 0, examples: [] });

function record(check: Check, value: number, tolerance: number, example: () => unknown) {
  check.probes += 1;
  check.maxDeviation = Math.max(check.maxDeviation, value);
  if (value > tolerance) {
    check.failures += 1;
    if (check.examples.length < MAX_EXAMPLES) check.examples.push(example());
  }
}

/** Interior probes on a grid: the section 3 oracle within 2/255. */
function checkInterior(
  view: View,
  leaves: readonly DrawnLeaf[],
  frame: Frame,
  stride = INTERIOR_STRIDE,
): Check {
  const check = newCheck();
  const start = stride === 1 ? 0 : 1;
  for (let y = start; y < frame.height; y += stride) {
    for (let x = start; x < frame.width; x += stride) {
      const expected = oracle(view, leaves, x, y);
      if (expected === null) continue;
      const observed = pixel(frame, x, y);
      record(check, deviation(observed, expected), INTERIOR_TOLERANCE, () => ({
        x,
        y,
        observed,
        expected: expected.map((value) => Math.round(value)),
      }));
    }
  }
  return check;
}

/** Renders the P4-K1/K2 reference of each level, cached per level and view. */
class References {
  readonly #cache = new Map<string, Frame>();
  public renders = 0;
  constructor(readonly page: Page) {}

  async of(level: ClipLevel, view: View): Promise<Frame> {
    const key = JSON.stringify([level.shape, level.world, view]);
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const items = levelReference(level);
    let frame: Frame;
    if (items === null) {
      frame = {
        rgba: new Uint8Array(view.width * view.height * 4),
        width: view.width,
        height: view.height,
      };
    } else {
      const rendered = await render(this.page, items, view);
      if (rendered.result.status !== 'applied') {
        throw new Error(`reference rejected: ${JSON.stringify(rendered.result.result)}`);
      }
      frame = rendered.frame;
      this.renders += 1;
    }
    this.#cache.set(key, frame);
    return frame;
  }
}

/**
 * Edge pixels of the content leaf's chain: wherever some level is on its ramp, the content
 * covers and no other drawn leaf does, the product equals the content colour times the product
 * of the levels' coverages. A rect level's coverage is P4-K1 on the CPU, with `fwidth` taken
 * coarse or fine as WGSL allows (the closer of the two counts); a mask level's is its source's
 * GPU reference (P4-K2). For rect levels the P1 rectangle of the same placement is also rendered
 * and its difference recorded as an observation (`p1Rectangle`), not checked.
 */
async function checkEdges(
  references: References,
  view: View,
  leaves: readonly DrawnLeaf[],
  contentId: string,
  frame: Frame,
  allowance: number,
  options: Readonly<{ tolerance?: number; everyPixel?: boolean }> = {},
): Promise<Check & { p1Rectangle: { probes: number; maxDeviation: number } }> {
  const check = { ...newCheck(), p1Rectangle: { probes: 0, maxDeviation: 0 } };
  const content = leaves.find((drawn) => drawn.leaf.id === contentId);
  if (content === undefined) return check;
  // Serial: the page renders one scene at a time.
  const refs: Frame[] = [];
  for (const level of content.levels) refs.push(await references.of(level, view));
  const others = leaves.filter((drawn) => drawn !== content);
  const fill = content.leaf.fill!;
  const colour = [fill.r * 255, fill.g * 255, fill.b * 255];
  const tolerance = (options.tolerance ?? EDGE_TOLERANCE) + allowance;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4;
      let ramp = false;
      const products = { coarse: 1, fine: 1, p1: 1 };
      content.levels.forEach((level, index) => {
        const reference = refs[index]!.rgba[offset]! / 255;
        if (level.kind === 'mask') {
          if (reference > 0 && reference < 1) ramp = true;
          products.coarse *= reference;
          products.fine *= reference;
          products.p1 *= reference;
          return;
        }
        const coarse = rectCoverage(view, level, x, y, 'coarse');
        const fine = rectCoverage(view, level, x, y, 'fine');
        if (coarse > 0.5 / 255 && coarse < 254.5 / 255) ramp = true;
        if (fine > 0.5 / 255 && fine < 254.5 / 255) ramp = true;
        products.coarse *= coarse;
        products.fine *= fine;
        products.p1 *= reference;
      });
      // E22-A5: `everyPixel` checks the product off the ramps too, where it is exact.
      if (!ramp && options.everyPixel !== true) continue;
      if (classify(view, content.leaf.shape, content.leaf.world, x, y) !== 'in') continue;
      if (
        others.some((other) => classify(view, other.leaf.shape, other.leaf.world, x, y) !== 'out')
      )
        continue;
      const observed = pixel(frame, x, y);
      const coarse = colour.map((value) => value * products.coarse);
      const fine = colour.map((value) => value * products.fine);
      const best = Math.min(deviation(observed, coarse), deviation(observed, fine));
      record(check, best, tolerance, () => ({
        x,
        y,
        observed,
        coarse: coarse.map((value) => Math.round(value * 10) / 10),
        fine: fine.map((value) => Math.round(value * 10) / 10),
        references: refs.map((ref) => ref.rgba[offset]),
      }));
      if (content.levels.some((level) => level.kind === 'rect')) {
        check.p1Rectangle.probes += 1;
        check.p1Rectangle.maxDeviation = Math.max(
          check.p1Rectangle.maxDeviation,
          deviation(
            observed,
            colour.map((value) => value * products.p1),
          ),
        );
      }
    }
  }
  return check;
}

/** Mask sources are coloured and content is white or grey, so a coloured pixel is a source. */
function checkGrey(frame: Frame): Check {
  const check = newCheck();
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const [r, g, b] = pixel(frame, x, y);
      record(check, Math.max(Math.abs(g - r), Math.abs(b - r)), 2, () => ({
        x,
        y,
        rgb: [r, g, b],
      }));
    }
  }
  return check;
}

function maskLevels(levels: readonly ClipLevel[]): number {
  return levels.filter((level) => level.kind === 'mask').length;
}

async function runImageCase(
  page: Page,
  references: References,
  item: ImageCase,
  dpr: number,
  failures: string[],
  options: Readonly<{
    view?: View;
    interiorStride?: number;
    /** E22-A5: the edge check over every pixel at this tolerance. */
    everyPixelTolerance?: number;
  }> = {},
) {
  const view = options.view ?? viewOf(item.zoom, dpr, item.centre);
  const before = await diagnosticCount(page);
  const { result, frame } = await render(page, item.items, view);
  const added = await diagnosticsSince(page, before);
  const report: Record<string, unknown> = {
    id: item.id,
    criterion: item.criterion,
    status: result.status,
    packet: result.frame.packet,
    diagnostics: added.map((event) => ({ code: event.code, context: event.context ?? null })),
  };
  if (result.status !== 'applied') {
    failures.push(`${item.id}: scene ${result.status} ${JSON.stringify(result.result)}`);
    return { report, frame };
  }
  const leaves = drawnLeaves(item.expectedItems ?? item.items);
  const interior = checkInterior(view, leaves, frame, options.interiorStride);
  report.interior = interior;
  if (interior.probes === 0) failures.push(`${item.id}: no interior probe`);
  if (interior.failures > 0)
    failures.push(
      `${item.id}: ${interior.failures} interior probes over ${INTERIOR_TOLERANCE}/255`,
    );
  if (
    item.edgeContent === undefined &&
    item.interiorOnly !== true &&
    leaves.some((drawn) => drawn.levels.length > 0)
  )
    failures.push(`${item.id}: clipped content without an edge check`);
  report.edgeCheck = item.edgeContent === undefined ? 'interior only' : item.edgeContent;
  if (item.edgeContent !== undefined) {
    const content = leaves.find((drawn) => drawn.leaf.id === item.edgeContent);
    const allowance = (content?.levels.length ?? 0) >= 32 ? maskLevels(content!.levels) : 0;
    const tolerance = options.everyPixelTolerance ?? EDGE_TOLERANCE;
    const edges = await checkEdges(references, view, leaves, item.edgeContent, frame, allowance, {
      tolerance,
      everyPixel: options.everyPixelTolerance !== undefined,
    });
    report.edges = { ...edges, tolerance: tolerance + allowance };
    if ((content?.levels.length ?? 0) > 0 && edges.probes === 0 && !item.id.includes('line'))
      failures.push(`${item.id}: no edge probe`);
    if (edges.failures > 0)
      failures.push(`${item.id}: ${edges.failures} edge probes over ${tolerance + allowance}/255`);
  }
  if (item.grey === true) {
    const grey = checkGrey(frame);
    report.grey = {
      failures: grey.failures,
      maxDeviation: grey.maxDeviation,
      examples: grey.examples,
    };
    if (grey.failures > 0) failures.push(`${item.id}: a mask source painted (${grey.failures} px)`);
  }
  const expectedDiagnostics = item.diagnostics ?? [];
  const observed = added.map((event) => ({
    code: event.code,
    nodeId: (event.context as { nodeId?: string } | undefined)?.nodeId ?? null,
  }));
  if (JSON.stringify(observed) !== JSON.stringify(expectedDiagnostics))
    failures.push(
      `${item.id}: diagnostics ${JSON.stringify(observed)}, expected ${JSON.stringify(expectedDiagnostics)}`,
    );
  if (item.named !== undefined) {
    report.named = item.named.map((probe) => {
      const [px, py] = worldToPixel(view, probe.x, probe.y).map(Math.floor) as [number, number];
      const observedColour = pixel(frame, px, py);
      const expected = oracle(view, leaves, px, py);
      return {
        ...probe,
        px,
        py,
        observed: observedColour,
        expected,
        doubleOpacity: oracle(view, leaves, px, py, { doubleOpacity: true }),
        reversed: oracle(view, leaves, px, py, { reversed: true }),
      };
    });
  }
  return { report, frame };
}

const CONFIGS = [
  { samples: 1, dpr: 1 },
  { samples: 4, dpr: 1 },
  { samples: 1, dpr: 2 },
  { samples: 4, dpr: 2 },
] as const;

for (const config of CONFIGS) {
  test(`P4 U5 images (P4-A02 to A05, A10), ${config.samples}x, DPR ${config.dpr}`, async ({
    browser,
    page,
  }, info) => {
    test.setTimeout(900_000);
    const write = reporter(`images-${config.samples}x-dpr${config.dpr}`, info);
    const { ready, pageErrors } = await open(page, config.samples, config.dpr);
    const references = new References(page);
    const failures: string[] = [];
    const cases: unknown[] = [];
    const cases32: { frame?: Frame } = {};
    for (const item of [
      ...RECT_CASES,
      ...MASK_CASES,
      ...NESTING_CASES,
      OPACITY_CASE,
      ...FAILURE_CASES,
    ]) {
      const { report, frame } = await runImageCase(page, references, item, config.dpr, failures);
      cases.push(report);
      if (item.id === 'a04-depth-32-with-sibling') cases32.frame = frame;
      if (item.named !== undefined) {
        for (const probe of report.named as {
          name: string;
          observed: number[];
          expected: number[] | null;
          doubleOpacity: number[] | null;
          reversed: number[] | null;
        }[]) {
          if (probe.expected === null) {
            failures.push(`${item.id}: named probe ${probe.name} is not interior`);
            continue;
          }
          const off = deviation(probe.observed, probe.expected);
          if (off > INTERIOR_TOLERANCE)
            failures.push(`${item.id}: named probe ${probe.name} off by ${off}/255`);
        }
        if (item === OPACITY_CASE) {
          const named = report.named as {
            observed: number[];
            doubleOpacity: number[];
            reversed: number[];
          }[];
          for (const key of ['doubleOpacity', 'reversed'] as const) {
            const margin = Math.max(...named.map((probe) => deviation(probe.observed, probe[key])));
            if (margin <= COUNTER_ORACLE_MARGIN)
              failures.push(`${item.id}: the ${key} counter-oracle differs by only ${margin}/255`);
          }
        }
      }
    }
    // P4-A04: depth 33 is rejected with unsupported-feature; the previous revision keeps drawing.
    const view = viewOf(1, config.dpr);
    const depth33 = await render(page, [alternatingChain(33, cover('c', 1))], view);
    const isRejected = (attempt: typeof depth33) =>
      attempt.result.status === 'invalid-scene' &&
      (attempt.result.result as { reason?: string }).reason === 'unsupported-feature';
    const previous = await render(page, NESTING_CASES.at(-1)!.items, view);
    const again = await render(page, [alternatingChain(33, cover('c', 1))], view);
    const rejected = isRejected(depth33) && isRejected(again);
    const keptDrawing =
      Buffer.compare(Buffer.from(again.frame.rgba), Buffer.from(previous.frame.rgba)) === 0 &&
      cases32.frame !== undefined &&
      Buffer.compare(Buffer.from(previous.frame.rgba), Buffer.from(cases32.frame.rgba)) === 0;
    if (!rejected)
      failures.push(`depth 33: ${JSON.stringify([depth33.result.result, again.result.result])}`);
    if (!keptDrawing) failures.push('depth 33: the previous revision did not keep drawing');
    if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
    write(
      'report.json',
      `${JSON.stringify(
        {
          criteria: ['P4-A02', 'P4-A03', 'P4-A04', 'P4-A05', 'P4-A10'],
          browser: { project: info.project.name, version: browser.version() },
          host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model },
          source: p1Source(),
          ready,
          config,
          tolerances: {
            interior: INTERIOR_TOLERANCE,
            edge: EDGE_TOLERANCE,
            counterOracleMargin: COUNTER_ORACLE_MARGIN,
          },
          referenceRenders: references.renders,
          cases,
          depth33: { result: depth33.result.result, rejected, keptDrawing },
          failures,
        },
        null,
        2,
      )}\n`,
    );
    await page.evaluate(() => window.__vectorStudioP4.dispose());
    expect(failures).toEqual([]);
  });
}

// --- P4-A06 to A08: invalidation, culling, batching and resources (4x, DPR 1) ---

const WHITE_ISH = { r: 0.95, g: 0.95, b: 0.95, a: 1 };
const GREEN = { r: 0.2, g: 0.8, b: 0.3, a: 1 };

/** Children of the rect-clip group G, in G's local space (G's world is applied to each). */
function groupChildren(world: Affine, leafShift = 0): P4Leaf[] {
  const place = (local: Affine) => multiply(world, local);
  return [
    leaf(
      'g-star',
      polygon([
        [0, -50, 15, -15, 50, -10, 20, 15, 30, 50, 0, 30, -30, 50, -20, 15, -50, -10, -15, -15],
      ]),
      place(translate(-60, 0)),
      { r: 0.9, g: 0.4, b: 0.2, a: 1 },
    ),
    leaf(
      'g-ring',
      polygon([
        [-40, -30, 40, -30, 40, 30, -40, 30],
        [-15, -10, -15, 10, 15, 10, 15, -10],
      ]),
      place(translate(60, 0)),
      { r: 0.3, g: 0.5, b: 0.9, a: 1 },
    ),
    leaf('g-rect', rect(30, 20), place(translate(-15 + leafShift, 45)), GREEN),
  ];
}

type GroupState = Readonly<{
  world: Affine;
  clip: { x: number; y: number; width: number; height: number } | null;
  leafShift?: number;
}>;

const OCTAGON = Array.from({ length: 8 }, (_, index) => {
  const angle = (index / 8) * 2 * Math.PI;
  return [55 * Math.cos(angle), 40 * Math.sin(angle)];
}).flat();

function invalidationScene(group: GroupState, sourcePoints: readonly number[] = OCTAGON) {
  const g = container(
    'g',
    group.world,
    group.clip === null ? null : { kind: 'rect', ...group.clip },
    groupChildren(group.world, group.leafShift),
  );
  const m = container('m', IDENTITY, { kind: 'mask' }, [
    leaf('m-source', polygon([sourcePoints]), translate(CENTRE.x + 70, CENTRE.y + 40), null),
    leaf(
      'm-content',
      polygon([[0, 0, 160, 0, 160, 110, 0, 110]]),
      translate(CENTRE.x + 10, CENTRE.y - 10),
      WHITE_ISH,
    ),
  ]);
  return [g, m];
}

const BASE_GROUP: GroupState = {
  world: multiply(translate(CENTRE.x - 60, CENTRE.y - 30), rotate(10)),
  clip: { x: -110, y: -70, width: 220, height: 140 },
};

type Counters = Awaited<ReturnType<P4ClipMaskApi['counters']>>;
function delta(before: Counters, after: Counters) {
  return {
    fillPortCalls: (after.pathMesh?.portCalls ?? 0) - (before.pathMesh?.portCalls ?? 0),
    strokePortCalls:
      (after.pathMesh?.strokePortCalls ?? 0) - (before.pathMesh?.strokePortCalls ?? 0),
    overlayBuilds: after.overlayBuilds - before.overlayBuilds,
    clipStateWrites: after.clipStateWrites - before.clipStateWrites,
    maskPasses: after.maskPasses - before.maskPasses,
  };
}

function resources(statistics: RendererStatistics) {
  const by = statistics.resources.byCategory;
  return {
    textures: { live: by.texture.live, bytes: by.texture.liveBytes },
    buffers: { live: by.buffer.live, bytes: by.buffer.liveBytes },
    bindGroups: by['bind-group'].live,
  };
}

/** A conservative bound of a mask's device rect: source bounds plus guard and rounding. */
function maskBoundBytes(view: View, shape: { width: number; height: number }, world: Affine) {
  const corners = [
    [0, 0],
    [shape.width, 0],
    [shape.width, shape.height],
    [0, shape.height],
  ].map(([x, y]) => {
    const [wx, wy] = transformPoint(world, x!, y!);
    return worldToPixel(view, wx, wy);
  });
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const left = Math.max(0, Math.floor(Math.min(...xs) - 3));
  const top = Math.max(0, Math.floor(Math.min(...ys) - 3));
  const right = Math.min(view.width, Math.ceil(Math.max(...xs) + 3));
  const bottom = Math.min(view.height, Math.ceil(Math.max(...ys) + 3));
  return right > left && bottom > top ? (right - left) * (bottom - top) : 0;
}

test('P4 U5 invalidation, culling, batching and resources (P4-A06 to A08), 4x, DPR 1', async ({
  browser,
  page,
}, info) => {
  test.setTimeout(600_000);
  const write = reporter('counters-4x-dpr1', info);
  const { ready, pageErrors } = await open(page, 4, 1);
  const failures: string[] = [];
  const view = viewOf(1, 1);
  const expectDelta = (
    name: string,
    observed: Record<string, number>,
    expected: Record<string, number>,
  ) => {
    for (const [key, value] of Object.entries(expected)) {
      if (observed[key] !== value)
        failures.push(`${name}: ${key} ${observed[key]}, expected ${value}`);
    }
  };
  const steps: unknown[] = [];
  const counters = () => page.evaluate(() => window.__vectorStudioP4.counters());
  const step = async (name: string, items: readonly P4Item[], at: View = view) => {
    const before = await counters();
    const shown = await show(page, items, at);
    // A second frame settles any work a first frame deferred.
    const settled = await show(page, items, at);
    const observed = delta(before, settled.counters);
    steps.push({ name, status: shown.status, delta: observed, packet: settled.packet });
    return observed;
  };

  // P4-A06, geometry and GPU work.
  await step('base', invalidationScene(BASE_GROUP));
  await step('base again', invalidationScene(BASE_GROUP));
  const clipEdited = { ...BASE_GROUP, clip: { ...BASE_GROUP.clip!, x: -100, width: 200 } };
  expectDelta('edit rect clip', await step('edit rect clip', invalidationScene(clipEdited)), {
    fillPortCalls: 0,
    strokePortCalls: 0,
    overlayBuilds: 0,
    clipStateWrites: 1,
    maskPasses: 0,
  });
  const translated = { ...clipEdited, world: multiply(translate(7, 4), clipEdited.world) };
  expectDelta(
    'translate container',
    await step('translate container', invalidationScene(translated)),
    {
      fillPortCalls: 0,
      strokePortCalls: 0,
      overlayBuilds: 0,
      clipStateWrites: 1,
      maskPasses: 0,
    },
  );
  const rotated = {
    ...translated,
    world: multiply(
      rotate(12, CENTRE.x - 60, CENTRE.y - 30),
      multiply(translate(-(CENTRE.x - 60), -(CENTRE.y - 30)), translated.world),
    ),
  };
  expectDelta('rotate container', await step('rotate container', invalidationScene(rotated)), {
    fillPortCalls: 0,
    strokePortCalls: 0,
    overlayBuilds: 0,
    clipStateWrites: 1,
    maskPasses: 0,
  });
  const moved = { ...rotated, leafShift: 6 };
  expectDelta(
    'edit outside the mask chain',
    await step('edit outside the mask chain', invalidationScene(moved)),
    {
      fillPortCalls: 0,
      clipStateWrites: 0,
      maskPasses: 0,
    },
  );
  const sourceEdited = OCTAGON.map((value, index) => (index === 0 ? value + 9 : value));
  expectDelta(
    'edit mask source path',
    await step('edit mask source path', invalidationScene(moved, sourceEdited)),
    {
      fillPortCalls: 1,
      maskPasses: 1,
    },
  );
  const panned = viewOf(1, 1, { x: CENTRE.x + 3, y: CENTRE.y });
  expectDelta(
    'camera pan',
    await step('camera pan', invalidationScene(moved, sourceEdited), panned),
    {
      fillPortCalls: 0,
      clipStateWrites: 0,
      maskPasses: 1,
    },
  );
  // Scaling costs exactly the port calls of the same change without clips; each sequence runs
  // on a freshly loaded page, so neither finds the other's meshes in the cache.
  const scaled = (state: GroupState) => ({
    ...state,
    world: multiply(state.world, scale(1.5)),
  });
  const scaleCost = async (state: GroupState) => {
    await open(page, 4, 1);
    await step(
      `scale base (clip ${state.clip === null ? 'none' : 'rect'})`,
      invalidationScene(state, sourceEdited),
    );
    await step(
      `scale base again (clip ${state.clip === null ? 'none' : 'rect'})`,
      invalidationScene(state, sourceEdited),
    );
    return step(
      `scale container (clip ${state.clip === null ? 'none' : 'rect'})`,
      invalidationScene(scaled(state), sourceEdited),
    );
  };
  const withoutClips = await scaleCost({ ...moved, clip: null });
  const withClips = await scaleCost(moved);
  // 1.5x crosses a tolerance bucket, so the comparison is not vacuous at 0 port calls.
  if (withoutClips.fillPortCalls === 0)
    failures.push('scale: the unclipped sequence made no port call');
  if (withClips.fillPortCalls !== withoutClips.fillPortCalls)
    failures.push(
      `scale: ${withClips.fillPortCalls} port calls clipped, ${withoutClips.fillPortCalls} without`,
    );
  // DPR change and resize re-render the visible mask at the new size and match the oracle. The
  // camera is set first (centred for the new surface), so the resize alone changes the key. At
  // each size, removing the clips returns the resources to that size's unclipped baseline, and
  // back at 512 x 320 to the baseline taken before the first resize.
  const flat = (items: readonly P4Item[]): P4Item[] =>
    drawnLeaves(items).map((drawn) => drawn.leaf);
  const sizeBaseline = resources(
    (await render(page, flat(invalidationScene(moved, sourceEdited)), view)).result.counters
      .statistics,
  );
  const resized: unknown[] = [];
  for (const [cssWidth, cssHeight, dpr] of [
    [256, 160, 2],
    [400, 250, 1],
    [512, 320, 1],
  ] as const) {
    const width = cssWidth * dpr;
    const height = cssHeight * dpr;
    const at: View = {
      camera: {
        position: { x: CENTRE.x - width / 2 / dpr, y: CENTRE.y - height / 2 / dpr },
        zoom: 1,
      },
      devicePixelRatio: dpr,
      width,
      height,
    };
    const scene = invalidationScene(moved, sourceEdited);
    await show(page, scene, at);
    await show(page, scene, at);
    const before = await counters();
    const out = await page.evaluate(([w, h, d]) => window.__vectorStudioP4.resize(w, h, d), [
      cssWidth,
      cssHeight,
      dpr,
    ] as const);
    const frame: Frame = {
      rgba: decodeFrame(out.frame.rgbaBase64),
      width: out.frame.width,
      height: out.frame.height,
    };
    const interior = checkInterior(at, drawnLeaves(scene), frame);
    const passes = out.counters.maskPasses - before.maskPasses;
    const unclipped = resources((await render(page, flat(scene), at)).result.counters.statistics);
    const clippedAgain = resources((await render(page, scene, at)).result.counters.statistics);
    const removed = resources((await render(page, flat(scene), at)).result.counters.statistics);
    if (JSON.stringify(removed) !== JSON.stringify(unclipped))
      failures.push(
        `resize ${cssWidth}x${cssHeight}@${dpr}: resources ${JSON.stringify({ unclipped, removed })}`,
      );
    if (clippedAgain.textures.bytes <= unclipped.textures.bytes)
      failures.push(`resize ${cssWidth}x${cssHeight}@${dpr}: no mask texture in accounting`);
    if (cssWidth === 512 && dpr === 1 && JSON.stringify(removed) !== JSON.stringify(sizeBaseline))
      failures.push(`resize back: resources ${JSON.stringify({ sizeBaseline, removed })}`);
    resized.push({
      cssWidth,
      cssHeight,
      dpr,
      physical: [frame.width, frame.height],
      maskPasses: passes,
      interior,
      resources: { unclipped, clipped: clippedAgain, removed },
    });
    if (frame.width !== width || frame.height !== height)
      failures.push(`resize ${cssWidth}x${cssHeight}@${dpr}: frame ${frame.width}x${frame.height}`);
    if (passes !== 1)
      failures.push(`resize ${cssWidth}x${cssHeight}@${dpr}: ${passes} mask passes, expected 1`);
    if (interior.failures > 0 || interior.probes === 0)
      failures.push(
        `resize ${cssWidth}x${cssHeight}@${dpr}: ${interior.failures}/${interior.probes} interior probes off`,
      );
  }

  // P4-A07: culling, batching and paint order.
  const clipBox = { x: -80, y: -50, width: 160, height: 100 };
  const inside = leaf('in', rect(40, 30), translate(CENTRE.x - 20, CENTRE.y - 15), GREEN);
  const outsideRect = leaf(
    'out-rect',
    rect(40, 30),
    translate(CENTRE.x + 120, CENTRE.y - 15),
    GREEN,
  );
  const outsidePath = leaf(
    'out-path',
    polygon([[0, 0, 30, 0, 15, 25]]),
    translate(CENTRE.x - 160, CENTRE.y),
    GREEN,
  );
  const culled = await render(
    page,
    [
      container('g', translate(CENTRE.x, CENTRE.y), { kind: 'rect', ...clipBox }, [
        inside,
        outsideRect,
        outsidePath,
      ]),
    ],
    view,
  );
  const alone = await render(
    page,
    [container('g', translate(CENTRE.x, CENTRE.y), { kind: 'rect', ...clipBox }, [inside])],
    view,
  );
  const instances = (packet: Rendered['frame']['packet']) =>
    packet === null ? -1 : packet.analytic.reduce((sum, run) => sum + run.count, 0);
  const culling = {
    withOutside: culled.result.frame.packet,
    insideOnly: alone.result.frame.packet,
  };
  if (
    instances(culled.result.frame.packet) !== instances(alone.result.frame.packet) ||
    culled.result.frame.packet?.analytic.length !== alone.result.frame.packet?.analytic.length ||
    culled.result.frame.packet?.mesh.length !== alone.result.frame.packet?.mesh.length
  )
    failures.push(`culling: ${JSON.stringify(culling)}`);
  const row = Array.from({ length: 10 }, (_, index) =>
    leaf(`r${index}`, rect(10, 10), translate(CENTRE.x - 70 + index * 14, CENTRE.y - 5), GREEN),
  );
  const ordered = [
    leaf('before', rect(60, 40), translate(CENTRE.x - 100, CENTRE.y - 30), {
      r: 0.9,
      g: 0.2,
      b: 0.2,
      a: 1,
    }),
    container(
      'g',
      translate(CENTRE.x, CENTRE.y),
      { kind: 'rect', ...clipBox },
      row.map((item) => ({ ...item, world: item.world })),
    ),
    leaf('after', rect(60, 40), translate(CENTRE.x + 40, CENTRE.y - 10), {
      r: 0.2,
      g: 0.3,
      b: 0.9,
      a: 0.7,
    }),
  ];
  const batched = await render(page, ordered, view);
  const runs = batched.result.frame.packet?.analytic ?? [];
  const batching = {
    runs,
    interior: checkInterior(view, drawnLeaves(ordered), batched.frame),
  };
  if (
    runs.length !== 3 ||
    runs[0]!.clipState !== 0 ||
    runs[1]!.clipState === 0 ||
    runs[1]!.count !== 10 ||
    runs[2]!.clipState !== 0
  )
    failures.push(`batching: ${JSON.stringify(runs)}`);
  if (batching.interior.failures > 0) failures.push(`batching: paint order probes off`);

  // P4-A08: resources return to the unclipped baseline; recovery; pan residency.
  const clipped = invalidationScene(moved, sourceEdited);
  const baseline = await render(page, flat(clipped), view);
  const withMasks = await render(page, clipped, view);
  const afterRemoval = await render(page, flat(clipped), view);
  const lifecycle = {
    baseline: resources(baseline.result.counters.statistics),
    clipped: resources(withMasks.result.counters.statistics),
    afterRemoval: resources(afterRemoval.result.counters.statistics),
  };
  // The clipped scene's mask texture and clip buffers must be in accounting, or the return to
  // the baseline below would hold trivially.
  if (
    lifecycle.clipped.textures.live <= lifecycle.baseline.textures.live ||
    lifecycle.clipped.textures.bytes <= lifecycle.baseline.textures.bytes ||
    lifecycle.clipped.buffers.bytes <= lifecycle.baseline.buffers.bytes
  )
    failures.push(`clip resources not in accounting: ${JSON.stringify(lifecycle)}`);
  if (JSON.stringify(lifecycle.afterRemoval) !== JSON.stringify(lifecycle.baseline))
    failures.push(`resources after removal: ${JSON.stringify(lifecycle)}`);
  const preLoss = await render(page, clipped, view);
  const recovered = await page.evaluate(() => window.__vectorStudioP4.recover());
  const recoveredFrame = decodeFrame(recovered.frame.rgbaBase64);
  const recoveryEqual =
    Buffer.compare(Buffer.from(recoveredFrame), Buffer.from(preLoss.frame.rgba)) === 0;
  if (!recoveryEqual)
    failures.push('device loss: the recovered frame differs from the pre-loss capture');
  const afterRecovery = await render(page, flat(clipped), view);
  if (
    JSON.stringify(resources(afterRecovery.result.counters.statistics)) !==
    JSON.stringify(lifecycle.baseline)
  )
    failures.push(
      `resources after recovery: ${JSON.stringify(resources(afterRecovery.result.counters.statistics))}`,
    );
  // Pan sequence: resident mask bytes stay within the visible masks' bytes.
  const spread = Array.from({ length: 6 }, (_, index) => {
    const x = CENTRE.x + (index - 2.5) * 220;
    const sourceWorld = translate(x - 75, CENTRE.y - 50);
    return {
      sourceWorld,
      item: container(`pm${index}`, IDENTITY, { kind: 'mask' }, [
        leaf(`pm${index}-source`, ellipse(150, 100), sourceWorld, null),
        leaf(`pm${index}-content`, rect(170, 120), translate(x - 85, CENTRE.y - 60), WHITE_ISH),
      ]),
    };
  });
  const pans: unknown[] = [];
  for (let index = 0; index < 8; index += 1) {
    const at = viewOf(1, 1, { x: CENTRE.x - 420 + index * 120, y: CENTRE.y });
    const empty = await render(page, [], at);
    const masked = await render(
      page,
      spread.map((entry) => entry.item),
      at,
    );
    const resident =
      masked.result.counters.statistics.resources.byCategory.texture.liveBytes -
      empty.result.counters.statistics.resources.byCategory.texture.liveBytes;
    const bound = spread.reduce(
      (sum, entry) => sum + maskBoundBytes(at, { width: 150, height: 100 }, entry.sourceWorld),
      0,
    );
    pans.push({ camera: at.camera, resident, bound });
    if (resident > bound)
      failures.push(`pan ${index}: resident ${resident} B over the visible bound ${bound} B`);
  }
  if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  const disposed = await page.evaluate(() => window.__vectorStudioP4.dispose());
  const disposedResources = resources(disposed);
  if (disposedResources.textures.live !== 0 || disposedResources.buffers.live !== 0)
    failures.push(`dispose: ${JSON.stringify(disposedResources)}`);
  write(
    'report.json',
    `${JSON.stringify(
      {
        criteria: ['P4-A06', 'P4-A07', 'P4-A08'],
        browser: { project: info.project.name, version: browser.version() },
        host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model },
        source: p1Source(),
        ready,
        steps,
        scale: { withClips, withoutClips },
        resized,
        culling,
        batching,
        lifecycle,
        recovery: { equal: recoveryEqual, generation: recovered.counters.statistics.generation },
        pans,
        disposed: disposedResources,
        failures,
      },
      null,
      2,
    )}\n`,
  );
  expect(failures).toEqual([]);
});

test('P4 U5 mask texture budget (P4-A08), 1x', async ({ browser, page }, info) => {
  test.setTimeout(300_000);
  const write = reporter('budget-1x', info);
  const { ready, pageErrors } = await open(page, 1, 1);
  const failures: string[] = [];
  // A capture needs a scene, so the empty scene comes first. 2048 x 2048 physical: each
  // full-surface mask texture is 4 MiB at 1x, so 20 exceed 64 MiB.
  await render(page, [], viewOf(1, 1));
  const resizedTo = await page.evaluate(() => window.__vectorStudioP4.resize(1024, 1024, 2));
  const view: View = {
    camera: { position: { x: 0, y: 0 }, zoom: 1 },
    devicePixelRatio: 2,
    width: resizedTo.frame.width,
    height: resizedTo.frame.height,
  };
  const count = 20;
  const stripe = 1024 / count;
  const masks = Array.from({ length: count }, (_, index) =>
    container(`b${index}`, IDENTITY, { kind: 'mask' }, [
      leaf(`b${index}-source`, rect(1100, 1100), translate(-30, -30), null),
      leaf(`b${index}-content`, rect(1024, stripe), translate(0, index * stripe), WHITE_ISH),
    ]),
  );
  const empty = await render(page, [], view);
  const before = await diagnosticCount(page);
  const budget = await render(page, masks, view);
  const notices = (await diagnosticsSince(page, before)).filter(
    (event) => event.code === 'render.clip-resource-limit',
  );
  const over = new Set(notices.map((event) => (event.context as { nodeId: string }).nodeId));
  const stripes = masks.map((_, index) => {
    const y = Math.floor((index + 0.5) * stripe * 2);
    const [r] = pixel(budget.frame, 1024, y);
    return { index, drawn: r > 200, over: over.has(`b${index}`), r };
  });
  const resident =
    budget.result.counters.statistics.resources.byCategory.texture.liveBytes -
    empty.result.counters.statistics.resources.byCategory.texture.liveBytes;
  if (notices.length === 0) failures.push('no render.clip-resource-limit notice');
  for (const entry of stripes) {
    if (entry.drawn === entry.over)
      failures.push(`stripe ${entry.index}: ${JSON.stringify(entry)}`);
  }
  const firstOver = stripes.findIndex((entry) => entry.over);
  if (firstOver >= 0 && stripes.slice(firstOver).some((entry) => !entry.over))
    failures.push('over-budget masks are not a suffix in paint order');
  for (const event of notices) {
    const context = event.context as { bytes: number; limit: number };
    if (context.limit !== 64 * 1024 * 1024) failures.push(`notice limit ${context.limit}`);
  }
  if (resident > 64 * 1024 * 1024) failures.push(`resident mask bytes ${resident} over 64 MiB`);
  if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  write(
    'report.json',
    `${JSON.stringify(
      {
        criteria: ['P4-A08'],
        browser: { project: info.project.name, version: browser.version() },
        source: p1Source(),
        ready,
        surface: { width: view.width, height: view.height },
        notices: notices.map((event) => event.context ?? null),
        stripes,
        resident,
        failures,
      },
      null,
      2,
    )}\n`,
  );
  await page.evaluate(() => window.__vectorStudioP4.dispose());
  expect(failures).toEqual([]);
});

/** P4-A11: 20 masks of 498 leaves each, plus the containers and sources: 10,000 nodes. */
function observationScene(): P4Item[] {
  const items: P4Item[] = [];
  for (let mask = 0; mask < 20; mask += 1) {
    const x0 = (mask % 5) * 400;
    const y0 = Math.floor(mask / 5) * 300;
    const leaves: P4Item[] = [];
    for (let index = 0; index < 498; index += 1) {
      const lx = x0 + 20 + (index % 30) * 12;
      const ly = y0 + 20 + Math.floor(index / 30) * 15;
      leaves.push(
        leaf(`o${mask}-${index}`, rect(9, 9), translate(lx, ly), {
          r: (index % 7) / 7,
          g: (mask % 5) / 5,
          b: 0.6,
          a: 0.8,
        }),
      );
    }
    items.push(
      container(`o${mask}`, IDENTITY, { kind: 'mask' }, [
        leaf(`o${mask}-source`, ellipse(360, 260), rotate(mask * 9, x0 + 20, y0 + 20), null),
        ...leaves,
      ]),
    );
  }
  return items;
}

for (const samples of [4, 1] as const) {
  test(`P4 U5 frame-time observation (P4-A11), ${samples}x`, async ({ browser, page }, info) => {
    test.setTimeout(300_000);
    const write = reporter(`observation-${samples}x`, info);
    const { ready } = await open(page, samples, 1);
    const scene = observationScene();
    const nodes = snapshotOf(scene).nodes.length;
    const camera = { position: { x: -40, y: -30 }, zoom: 0.25 };
    const result = await page.evaluate(
      ([snapshot, at]) => window.__vectorStudioP4.measure(snapshot, at, 100, { x: 1, y: 0.5 }),
      [snapshotOf(scene), camera] as const,
    );
    const summarize = (values: readonly number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      return { count: sorted.length, median: at(0.5), p95: at(0.95), max: sorted.at(-1) };
    };
    write(
      'observations.json',
      `${JSON.stringify(
        {
          criterion: 'P4-A11',
          label: 'FUNCTIONAL observation only: no performance claim or threshold.',
          browser: { project: info.project.name, version: browser.version() },
          host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model },
          source: p1Source(),
          ready,
          scene: { nodes, masks: 20, frames: 100, zoom: camera.zoom },
          framesSubmitted: result.framesSubmitted,
          maskPasses: result.maskPasses,
          encodeAndSubmitMs: summarize(result.measurements.encodeAndSubmitMs),
          frameIntervalsMs: summarize(result.measurements.frameIntervalsMs),
          measurements: result.measurements,
        },
        null,
        2,
      )}\n`,
    );
    await page.evaluate(() => window.__vectorStudioP4.dispose());
    expect(nodes).toBe(10_000);
    expect(result.framesSubmitted).toBeGreaterThanOrEqual(100);
  });
}

// --- E22-A5: tiled mask passes at 3840 x 2160 (E22 contract, unit U3) ---

const SOURCE = { r: 0.9, g: 0.3, b: 0.2, a: 1 };

function star(cx: number, cy: number, inner: number, outer: number): number[] {
  const points: number[] = [];
  for (let index = 0; index < 14; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = (index * Math.PI) / 7 + 0.13;
    points.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
  return points;
}

/**
 * World units at DPR 2: the surface is 1920 x 1080 units (3840 x 2160 device pixels).
 * Tile seams fall every 1024 device pixels from each level's own device origin, not
 * from the surface origin; the nested star level spans about 2 x 2 tiles.
 */
const E22_CASES: readonly ImageCase[] = [
  {
    id: 'e22-full-screen-mask',
    criterion: 'P4-A03',
    zoom: 1,
    items: [
      container('full', IDENTITY, { kind: 'mask' }, [
        leaf('full-source', ellipse(1880, 1040), translate(20, 20), SOURCE),
        leaf('full-content', rect(1920, 1080), IDENTITY),
      ]),
    ],
    edgeContent: 'full-content',
    grey: true,
  },
  {
    id: 'e22-nested-mesh-mask-over-seams',
    criterion: 'P4-A03',
    zoom: 1,
    items: [
      container('outer', IDENTITY, { kind: 'mask' }, [
        leaf('outer-source', ellipse(1100, 700), translate(410, 190), SOURCE),
        container('inner', IDENTITY, { kind: 'mask' }, [
          leaf('inner-source', polygon([star(960, 540, 260, 520)]), IDENTITY, SOURCE),
          leaf('inner-content', rect(1920, 1080), IDENTITY),
        ]),
      ]),
    ],
    edgeContent: 'inner-content',
    grey: true,
  },
];

test('E22 U3 tiled mask passes at 3840 x 2160 (E22-A5), 4x, DPR 2', async ({
  browser,
  page,
}, info) => {
  test.setTimeout(1_800_000);
  const write = reporter('e22-uhd-4x-dpr2', info);
  const { ready, pageErrors } = await open(page, 4, 2);
  const failures: string[] = [];
  // A capture needs a scene, so the empty scene comes first.
  await render(page, [], viewOf(1, 2));
  const resized = await page.evaluate(() => window.__vectorStudioP4.resize(1920, 1080, 2));
  const view: View = {
    camera: { position: { x: 0, y: 0 }, zoom: 1 },
    devicePixelRatio: 2,
    width: resized.frame.width,
    height: resized.frame.height,
  };
  if (view.width !== 3840 || view.height !== 2160)
    failures.push(`surface ${view.width} x ${view.height}`);
  if (resized.frame.sampleCount !== 4) failures.push(`sample count ${resized.frame.sampleCount}`);
  const references = new References(page);
  const cases: unknown[] = [];
  for (const item of E22_CASES) {
    // Every pixel is probed at the interior tolerance: the stride-1 interior against the oracle,
    // and every pixel the content covers against the product of the levels' references, so
    // every pixel on a tile seam is checked.
    const { report } = await runImageCase(page, references, item, 2, failures, {
      view,
      interiorStride: 1,
      everyPixelTolerance: INTERIOR_TOLERANCE,
    });
    const levels = (report.packet as { maskLevels?: number } | undefined)?.maskLevels;
    report.maskLevels = levels;
    const expected = item.id === 'e22-full-screen-mask' ? 1 : 2;
    if (levels !== expected)
      failures.push(`${item.id}: ${levels} mask levels, expected ${expected}`);
    cases.push(report);
  }
  if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  write(
    'report.json',
    `${JSON.stringify(
      {
        criteria: ['E22-A5'],
        browser: { project: info.project.name, version: browser.version() },
        host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model },
        source: p1Source(),
        ready,
        surface: { width: view.width, height: view.height, sampleCount: resized.frame.sampleCount },
        tolerances: { interior: INTERIOR_TOLERANCE, everyPixel: INTERIOR_TOLERANCE },
        referenceRenders: references.renders,
        cases,
        failures,
      },
      null,
      2,
    )}\n`,
  );
  await page.evaluate(() => window.__vectorStudioP4.dispose());
  expect(failures).toEqual([]);
});
