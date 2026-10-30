import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import type { Command, Editor, EditorEvent } from '@vector-studio/editor-core';
import {
  parseEnvelope,
  serializeDocument,
  type DocumentV6,
  type Gradient,
  type NodeV6,
  type Stroke,
} from '@vector-studio/model';
import { expect, test, type Page } from '@playwright/test';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { paintAt } from '../support/e23-gradient-oracle.js';
import { expectedLayeredAt, isolationDepth, type LayerTree } from '../support/e25-layer-oracle.js';
import { sceneLayerTree } from '../support/m4-scene-oracle.js';
import { generateM4A13Document } from '../m4-a13/document.js';

// M4-U4 (MVP M4 contract, section 10): M4-A12, the next-host page on the `?fixture=appearance`
// document (the committed `tests/fixtures/m4-appearance/host.v6.json`) in headed Chrome and Edge
// at DPR 1 and 2. Page `p1` holds H1 to H6 (E23's G1 rectangle, G2 ellipse and G3 path at
// opacity 0.5, a sharp 200 x 120 rectangle with E24 D3's stroke, E24's D1 as a line, and the
// dashed arrow line H6 in fill mode), page `p2` H7 to H9 (E25's O1 as a group, O5 as a mask
// group, O4 as a rotated frame). With the camera at zoom 1 and position (-0.5/DPR, -0.5/DPR),
// every integer page coordinate lies on a physical pixel centre, as the E23, E24 and E25 specs
// place their edges. Every third physical pixel is compared with the E23, E24 and E25 oracles
// evaluated on the scene the editor projects (tests/support/m4-scene-oracle.ts): interior
// probes within 2/255 plus 1/255 per isolation level, edge probes (G1's left and top edges, D1's
// butt dash ends, O1's red left edge in its layer; coverage 0.5) within 4/255 plus the same.
// The only renderer diagnostic allowed is P3's fringe work cap on H3's path (region-only, outside
// the 2 px interior margin; E23 G3's exception), in the probe and persistence tests alike; no
// editor diagnostic is allowed. The panel test drives
// every appearance panel control once through real input (one undo step each, the invalid
// inputs none, a mixed selection replaced by the edited value) and undoes back to the fixture
// byte for byte. A third test loads the fixture under `?persist=1`, flushes, reloads, and checks
// the restored document and its pixels. A fourth test takes M4-A13's frame time (an
// observation, nothing asserted).
//
// The `chromium-smoke` project (M4_NEXT_HOST_CHROMIUM, playwright.m4-next-host.config.ts) runs
// headless on SwiftShader; it runs the probes only when the renderer starts, and its results
// are a functional smoke run of the spec, not M4-A12 evidence.

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
    __nextHostRenderer?: Readonly<{
      capture: () => Promise<
        Readonly<{ width: number; height: number; devicePixelRatio: number; rgba: Uint8Array }>
      >;
      diagnostics: readonly Readonly<{ code: string; severity: string; message: string }>[];
    }>;
  }
}

/** The hook's M5 member (M5 contract, section 5.3), declared apart as in the M5 spec. */
type PersistenceHook = Readonly<{ persistence: Readonly<{ flush(): Promise<void> }> }>;
/** A document node read as JSON. */
type Loose = Readonly<Record<string, unknown>>;
type Box = readonly [number, number, number, number];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_TEXT = readFileSync(
  path.join(root, 'tests/fixtures/m4-appearance/host.v6.json'),
  'utf8',
);
const FIXTURE = JSON.parse(FIXTURE_TEXT) as DocumentV6;

const INTERIOR_TOLERANCE = 2;
const EDGE_TOLERANCE = 4;
const STRIDE = 3;
const CSS = { width: 960, height: 640 } as const;
/** Each H's page box, for the count of decided content probes it must have. */
const CONTENT: Readonly<Record<string, Readonly<Record<string, Box>>>> = {
  p1: {
    H1: [10, 10, 310, 110],
    H2: [330, 10, 530, 110],
    H3: [564, 10, 776, 176],
    H4: [16, 196, 224, 324],
    H5: [260, 215, 560, 226],
    H6: [257, 278, 461, 302],
  },
  p2: {
    H7: [40, 40, 360, 220],
    H8: [450, 30, 820, 280],
    H9: [80, 348, 320, 572],
  },
};

const rendering = () => test.info().project.name !== 'chromium-smoke';

async function open(page: Page, query: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?test=1${query}`);
  return { errors, status: await settled(page) };
}

/** Waits for the hook and the renderer state after a navigation or reload. */
async function settled(page: Page) {
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  if (rendering()) {
    await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
  } else {
    await expect(status).not.toHaveAttribute('data-renderer', 'pending', { timeout: 30_000 });
  }
  return status;
}

async function readDocument(page: Page): Promise<DocumentV6> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'document' })),
  );
  return JSON.parse(text) as DocumentV6;
}

async function serialized(page: Page): Promise<string> {
  return serializeDocument(await readDocument(page));
}

async function run(page: Page, ...commands: Command[]) {
  const results = await page.evaluate(
    (script: string) =>
      (JSON.parse(script) as Command[]).map((command) => {
        const result = window.__p5Host!.editor.execute(command);
        return result.ok ? 'ok' : `${result.code} ${result.path ?? ''}`.trimEnd();
      }),
    JSON.stringify(commands),
  );
  expect(results).toEqual(commands.map(() => 'ok'));
}

const undoDepth = (page: Page) =>
  page.evaluate(() => window.__p5Host!.editor.getSnapshot().history.undoDepth);

/** The pixel-centre camera of this DPR (header). */
const camera = (dpr: number) => ({ position: { x: -0.5 / dpr, y: -0.5 / dpr }, zoom: 1 });

/**
 * The next presented frame, read through the capture hook. In the smoke project a backend that
 * failed (SwiftShader's device can be lost after `ready`) gives null instead of an error.
 */
async function frame(page: Page) {
  let captured;
  try {
    captured = await page.evaluate(async () => {
      const value = await window.__nextHostRenderer!.capture();
      let binary = '';
      for (let index = 0; index < value.rgba.length; index += 0x8000)
        binary += String.fromCharCode(...value.rgba.subarray(index, index + 0x8000));
      return {
        width: value.width,
        height: value.height,
        devicePixelRatio: value.devicePixelRatio,
        base64: btoa(binary),
      };
    });
  } catch (error) {
    if (rendering()) throw error;
    return null;
  }
  return { ...captured, rgba: new Uint8Array(Buffer.from(captured.base64, 'base64')) };
}

type Edge = Readonly<{ x: number; y: number; rgb: readonly number[]; name: string }>;

/** The edge probes of a page at `dpr` (header), from the projected scene and its tree. */
function edges(
  pageId: string,
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
  tree: readonly LayerTree[],
  dpr: number,
): Edge[] {
  const out: Edge[] = [];
  if (pageId === 'p1') {
    // H1 (G1): the left edge x = 10 and the top edge y = 10, coverage 0.5 over black.
    const h1 = nodes.get('h1') as Extract<RenderNodeSnapshot, { kind: 'primitive' }>;
    const fill = h1.style.fill!;
    for (let row = Math.ceil(14 * dpr); row < 106 * dpr; row += 7) {
      const paint = paintAt(fill, 0, row / dpr - 10);
      out.push({
        name: 'H1 left',
        x: 10 * dpr,
        y: row,
        rgb: paint.slice(0, 3).map((v) => v * 127.5),
      });
    }
    for (let column = Math.ceil(14 * dpr); column < 306 * dpr; column += 7) {
      const paint = paintAt(fill, column / dpr - 10, 0);
      out.push({
        name: 'H1 top',
        x: column,
        y: 10 * dpr,
        rgb: paint.slice(0, 3).map((v) => v * 127.5),
      });
    }
    // H5 (D1): each butt dash end, inside the dash's width.
    for (const end of [30, 50, 80, 100, 130, 150, 180, 200, 230, 250, 280]) {
      for (let row = Math.ceil((220.25 - 3) * dpr); row < (220.25 + 3) * dpr; row += 2)
        out.push({ name: 'H5 dash end', x: (260 + end) * dpr, y: row, rgb: [0, 0, 127.5] });
    }
  } else {
    // H7 (O1): the red rectangle's left edge x = 40 inside the layer; where the left side is
    // black the composite is linear in the leaf, so the edge is half the right side.
    for (let row = Math.ceil(44 * dpr); row < 156 * dpr; row += 5) {
      const wy = row / dpr;
      const left = expectedLayeredAt(tree, 40 - 3 / dpr, wy, 1 / dpr);
      const right = expectedLayeredAt(tree, 40 + 3 / dpr, wy, 1 / dpr);
      if (left !== null && right !== null && left.every((value) => value === 0))
        out.push({ name: 'H7 left', x: 40 * dpr, y: row, rgb: right.map((value) => value / 2) });
    }
  }
  return out;
}

/**
 * Compares a page's frame with the oracles; returns the report row and the failures. Without a
 * frame (smoke only) it runs the oracle side alone: the probes, edges and content counts, with
 * no pixel compared.
 */
async function comparePage(page: Page, pageId: string, dpr: number) {
  await run(
    page,
    { type: 'setActivePage', id: pageId },
    { type: 'setViewport', camera: camera(dpr) },
  );
  const captured = await frame(page);
  const document = await readDocument(page);
  const projection = projectPage(document, pageId, () => null);
  const tree = sceneLayerTree(projection);
  const levels = isolationDepth(tree);
  const failures: string[] = [];
  const width = CSS.width * dpr;
  const height = CSS.height * dpr;
  if (captured !== null) {
    expect(captured.devicePixelRatio).toBe(dpr);
    expect([captured.width, captured.height]).toEqual([width, height]);
  }
  const content: Record<string, number> = Object.fromEntries(
    Object.keys(CONTENT[pageId]!).map((name) => [name, 0]),
  );
  let probes = 0;
  let worst = 0;
  const check = (
    x: number,
    y: number,
    expected: readonly number[],
    tolerance: number,
    kind: string,
  ) => {
    probes += 1;
    if (captured === null) return;
    const at = (y * width + x) * 4;
    for (let lane = 0; lane < 3; lane += 1) {
      const difference = Math.abs(captured.rgba[at + lane]! - expected[lane]!);
      worst = Math.max(worst, difference);
      if (difference > tolerance && failures.length < 24) {
        failures.push(
          `${pageId} ${kind} (${x}, ${y}) lane ${lane}: ${captured.rgba[at + lane]} vs ${expected[lane]!.toFixed(2)}`,
        );
      }
    }
  };
  const pixelSize = 1 / dpr;
  const { position } = camera(dpr);
  for (let y = 1; y < height; y += STRIDE) {
    for (let x = 1; x < width; x += STRIDE) {
      const wx = position.x + (x + 0.5) * pixelSize;
      const wy = position.y + (y + 0.5) * pixelSize;
      const expected = expectedLayeredAt(tree, wx, wy, pixelSize);
      if (expected === null) continue;
      check(x, y, expected, INTERIOR_TOLERANCE + levels, 'interior');
      if (expected.some((value) => value !== 0)) {
        for (const [name, box] of Object.entries(CONTENT[pageId]!)) {
          if (wx >= box[0] && wx <= box[2] && wy >= box[1] && wy <= box[3]) content[name]! += 1;
        }
      }
    }
  }
  const edgeList = edges(pageId, projection.nodes, tree, dpr);
  for (const edge of edgeList) check(edge.x, edge.y, edge.rgb, EDGE_TOLERANCE + levels, edge.name);
  for (const [name, count] of Object.entries(content))
    if (count < 10) failures.push(`${pageId} ${name}: only ${count} content probes`);
  return {
    row: {
      page: pageId,
      dpr,
      compared: captured !== null,
      probes,
      edges: edgeList.length,
      content,
      worst,
      levels,
    },
    failures,
  };
}

type RendererDiagnostic = Readonly<{ code: string; severity: string; message: string }>;

/**
 * E23 G3's exception, as the E23 spec applies it: P3's fringe work cap on H3's path (G3) draws
 * that paint region-only, outside the 2 px interior margin. Every other renderer diagnostic is a
 * failure, a fringe cap on any other node included.
 */
function rendererDiagnostics(diagnostics: readonly RendererDiagnostic[]) {
  const caps = diagnostics.filter(
    (diagnostic) =>
      diagnostic.code === 'render.path-mesh-failure' &&
      /^Path (?:\S*:)?h3 is drawn without its coverage fringe \(renderer fringe-work-cap\)\.$/u.test(
        diagnostic.message,
      ),
  );
  const failures = diagnostics
    .filter((diagnostic) => !caps.includes(diagnostic))
    .map((diagnostic) => `diagnostic ${diagnostic.code} ${diagnostic.message}`);
  return { caps, failures };
}

for (const dpr of [1, 2]) {
  test.describe(`DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test(`M4-A12: H1 to H9 against the E23, E24 and E25 oracles at DPR ${dpr}`, async ({
      page,
    }, info) => {
      const { errors, status } = await open(page, '&fixture=appearance');
      await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
      expect(await serialized(page)).toBe(FIXTURE_TEXT);
      const rows: unknown[] = [];
      const failures: string[] = [];
      let compared = true;
      for (const pageId of ['p1', 'p2']) {
        const outcome = await comparePage(page, pageId, dpr);
        rows.push(outcome.row);
        compared &&= outcome.row.compared;
        failures.push(...outcome.failures);
      }
      // Smoke only: with no frame the backend failed, and its diagnostics say why.
      const diagnostics = compared
        ? await page.evaluate(() => [...(window.__nextHostRenderer?.diagnostics ?? [])])
        : [];
      if (!compared) {
        const reason = await page.evaluate(() =>
          (window.__nextHostRenderer?.diagnostics ?? []).map((value) => value.code).join(', '),
        );
        info.annotations.push({
          type: 'smoke',
          description: `no frame (backend failed: ${reason}); oracle side only, no pixel compared`,
        });
      }
      const { caps, failures: unexpected } = rendererDiagnostics(diagnostics);
      failures.push(...unexpected);
      const editorDiagnostics = await page.evaluate(() =>
        window.__p5Host!.events.filter((event) => event.type === 'diagnostic'),
      );
      const report = {
        dpr,
        project: info.project.name,
        compared,
        rows,
        caps,
        editorDiagnostics,
        failures,
      };
      await info.attach('m4-a12-report.json', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      });
      info.annotations.push({ type: 'M4-A12 probes', description: JSON.stringify(rows) });
      expect(editorDiagnostics).toEqual([]);
      expect(failures).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

/** The section 8 linear-angle transform. */
function linear(theta: number): Gradient['transform'] {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const length = Math.abs(cos) + Math.abs(sin);
  // As the model stores it: negative zero is written as 0 (M4-U1 note 3).
  return [
    length * cos,
    length * sin,
    -length * sin,
    length * cos,
    0.5 - (length / 2) * cos,
    0.5 - (length / 2) * sin,
  ].map((value) => value + 0) as unknown as Gradient['transform'];
}
const RADIAL: Gradient['transform'] = [0.5, 0, 0, 0.5, 0.5, 0.5];
const RED = { r: 1, g: 0, b: 0, a: 1 };
const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

test('M4-A12: every panel control once, one undo step each', async ({ page }) => {
  const { errors, status } = await open(page, '&fixture=appearance');
  await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
  await run(page, { type: 'setSelection', ids: ['h1'] });
  const panel = page.getByRole('complementary', { name: 'Appearance' });
  const box = (name: string) => panel.getByRole('textbox', { name, exact: true });
  const select = (name: string) => panel.getByRole('combobox', { name, exact: true });
  const button = (name: string) => panel.getByRole('button', { name, exact: true });
  const node = async (id = 'h1') => (await readDocument(page)).nodes[id] as unknown as Loose;
  let steps = 0;
  /** One committed edit: exactly one more undo step, then the field's value. */
  const step = async (
    label: string,
    action: () => Promise<void>,
    read: (value: Loose) => unknown,
    expected: unknown,
  ) => {
    const before = await undoDepth(page);
    await action();
    await expect.poll(() => undoDepth(page), { message: label }).toBe(before + 1);
    steps += 1;
    expect(read(await node()), label).toEqual(expected);
  };
  const enter = (name: string, value: string) => async () => {
    await box(name).fill(value);
    await box(name).press('Enter');
  };
  const blur = (name: string, value: string) => async () => {
    await box(name).fill(value);
    await box(name).press('Tab');
  };
  const fill = (value: Loose) => value.fill;
  const stroke = (value: Loose) => value.stroke;
  const grad = (value: Loose) => value.fill as Gradient;
  const strokeOf = (value: Loose) => value.stroke as Stroke;
  const strokeGrad = (value: Loose) => (value.stroke as Stroke).color as Gradient;

  // Fill: a linear gradient (E23 G1) on h1.
  await step(
    'fill stop offset',
    enter('Fill stop 1 offset', '0.2'),
    (v) => grad(v).stops[0]!.offset,
    0.2,
  );
  await step(
    'fill stop colour',
    enter('Fill stop 2 colour', '#00ff00'),
    (v) => grad(v).stops[1]!.color,
    GREEN,
  );
  await step(
    'fill stop alpha (blur)',
    blur('Fill stop 2 alpha', '0.5'),
    (v) => grad(v).stops[1]!.color,
    {
      ...GREEN,
      a: 0.5,
    },
  );
  await step(
    'add fill stop',
    () => button('Add fill stop').click(),
    (v) => grad(v).stops,
    [
      { offset: 0.2, color: RED },
      { offset: 0.6, color: RED },
      { offset: 1, color: { ...GREEN, a: 0.5 } },
    ],
  );
  await step(
    'remove fill stop',
    () => button('Remove fill stop 2').click(),
    (v) => grad(v).stops.length,
    2,
  );
  await step(
    'fill angle',
    enter('Fill angle', '90'),
    (v) => grad(v).transform,
    linear(Math.PI / 2),
  );
  await step(
    'fill spread',
    () =>
      select('Fill spread')
        .selectOption('repeat')
        .then(() => {}),
    (v) => grad(v).spread,
    'repeat',
  );
  await step(
    'fill radial',
    () =>
      select('Fill type')
        .selectOption('radial')
        .then(() => {}),
    (v) => fill(v),
    {
      kind: 'radial',
      transform: RADIAL,
      stops: [
        { offset: 0.2, color: RED },
        { offset: 1, color: { ...GREEN, a: 0.5 } },
      ],
      spread: 'repeat',
    },
  );
  await step(
    'fill solid',
    () =>
      select('Fill type')
        .selectOption('solid')
        .then(() => {}),
    fill,
    RED,
  );
  await step('fill colour', enter('Fill colour', '#0000ff'), fill, BLUE);
  await step('fill alpha', enter('Fill alpha', '0.25'), fill, { ...BLUE, a: 0.25 });
  await step(
    'fill none',
    () =>
      select('Fill type')
        .selectOption('none')
        .then(() => {}),
    fill,
    null,
  );

  // Stroke: on (DEFAULT_SHAPE_STROKE, M4-Q4 (a)), its paint as the fill's, then each field.
  const checkbox = panel.getByRole('checkbox', { name: 'Stroke', exact: true });
  await step('stroke on', () => checkbox.click(), stroke, {
    color: BLACK,
    width: 1,
    cap: 'butt',
    join: 'round',
    miterLimit: 4,
    dash: null,
  });
  await step('stroke colour', enter('Stroke colour', '#ff0000'), (v) => strokeOf(v).color, RED);
  await step('stroke alpha', enter('Stroke alpha', '0.5'), (v) => strokeOf(v).color, {
    ...RED,
    a: 0.5,
  });
  await step(
    'stroke linear',
    () =>
      select('Stroke type')
        .selectOption('linear')
        .then(() => {}),
    (v) => strokeOf(v).color,
    {
      kind: 'linear',
      transform: linear(0),
      stops: [
        { offset: 0, color: { ...RED, a: 0.5 } },
        { offset: 1, color: { ...RED, a: 0 } },
      ],
      spread: 'pad',
    },
  );
  await step(
    'stroke stop offset',
    enter('Stroke stop 1 offset', '0.1'),
    (v) => strokeGrad(v).stops[0]!.offset,
    0.1,
  );
  await step(
    'stroke stop colour',
    enter('Stroke stop 1 colour', '#00ff00'),
    (v) => strokeGrad(v).stops[0]!.color,
    {
      ...GREEN,
      a: 0.5,
    },
  );
  await step(
    'stroke stop alpha',
    enter('Stroke stop 1 alpha', '1'),
    (v) => strokeGrad(v).stops[0]!.color,
    GREEN,
  );
  await step(
    'add stroke stop',
    () => button('Add stroke stop').click(),
    (v) => strokeGrad(v).stops.map((entry) => entry.offset),
    [0.1, 0.55, 1],
  );
  await step(
    'remove stroke stop',
    () => button('Remove stroke stop 3').click(),
    (v) => strokeGrad(v).stops,
    [
      { offset: 0.1, color: GREEN },
      { offset: 0.55, color: GREEN },
    ],
  );
  await step(
    'stroke angle',
    enter('Stroke angle', '45'),
    (v) => strokeGrad(v).transform,
    linear(Math.PI / 4),
  );
  await step(
    'stroke spread',
    () =>
      select('Stroke spread')
        .selectOption('reflect')
        .then(() => {}),
    (v) => strokeGrad(v).spread,
    'reflect',
  );
  await step(
    'stroke radial',
    () =>
      select('Stroke type')
        .selectOption('radial')
        .then(() => {}),
    (v) => strokeGrad(v).transform,
    RADIAL,
  );
  await step(
    'stroke solid',
    () =>
      select('Stroke type')
        .selectOption('solid')
        .then(() => {}),
    (v) => strokeOf(v).color,
    GREEN,
  );
  await step('stroke width', enter('Stroke width', '3'), (v) => strokeOf(v).width, 3);
  await step(
    'stroke cap',
    () =>
      select('Stroke cap')
        .selectOption('round')
        .then(() => {}),
    (v) => strokeOf(v).cap,
    'round',
  );
  await step(
    'stroke join',
    () =>
      select('Stroke join')
        .selectOption('miter')
        .then(() => {}),
    (v) => strokeOf(v).join,
    'miter',
  );
  await step('miter limit', enter('Miter limit', '8'), (v) => strokeOf(v).miterLimit, 8);
  await step('dash pattern', enter('Dash pattern', '6, 3'), (v) => strokeOf(v).dash, {
    pattern: [6, 3],
    phase: 0,
  });
  await step('dash phase', enter('Dash phase', '2'), (v) => strokeOf(v).dash, {
    pattern: [6, 3],
    phase: 2,
  });
  // Invalid input marks the field and sends nothing (section 8).
  const depth = await undoDepth(page);
  await box('Dash pattern').fill('0 0');
  await box('Dash pattern').press('Enter');
  await expect(box('Dash pattern')).toHaveAttribute('aria-invalid', 'true');
  await box('Stroke width').fill('-1');
  await box('Stroke width').press('Enter');
  await expect(box('Stroke width')).toHaveAttribute('aria-invalid', 'true');
  expect(await undoDepth(page)).toBe(depth);
  // Nothing was sent: no command ran, so the editor refused none either.
  await expect(page.getByTestId('appearance-error')).toHaveCount(0);
  await step('dash solid', enter('Dash pattern', ''), (v) => strokeOf(v).dash, null);

  // Opacity: the slider commits on `change` (one key press, one step).
  await step(
    'opacity',
    async () => {
      await panel.getByRole('slider', { name: 'Opacity', exact: true }).focus();
      await page.keyboard.press('ArrowLeft');
    },
    (v) => v.opacity,
    0.99,
  );

  // Corner radii: linked, then each other corner unlinked (the link toggle is session state).
  await step(
    'radii linked',
    enter('Corner radius top left', '5'),
    (v) => v.cornerRadii,
    [5, 5, 5, 5],
  );
  const link = button('Link corner radii');
  await expect(link).toHaveAttribute('aria-pressed', 'true');
  await link.click();
  await expect(link).toHaveAttribute('aria-pressed', 'false');
  await step(
    'radius unlinked',
    enter('Corner radius bottom right', '9'),
    (v) => v.cornerRadii,
    [5, 5, 9, 5],
  );
  await step(
    'radius top right',
    enter('Corner radius top right', '6'),
    (v) => v.cornerRadii,
    [5, 6, 9, 5],
  );
  await step(
    'radius bottom left',
    enter('Corner radius bottom left', '7'),
    (v) => v.cornerRadii,
    [5, 6, 9, 7],
  );
  await step('stroke off', () => checkbox.click(), stroke, null);

  // A mixed selection: h1 (fill none) and h2 (radial) show the fill type as mixed; the edited
  // value replaces both in one step.
  await run(page, { type: 'setSelection', ids: ['h1', 'h2'] });
  await expect(select('Fill type')).toHaveAttribute('data-mixed', 'true');
  const h2 = FIXTURE.nodes.h2 as NodeV6 & { fill: Gradient };
  await step(
    'mixed fill type',
    () =>
      select('Fill type')
        .selectOption('linear')
        .then(() => {}),
    fill,
    {
      kind: 'linear',
      transform: linear(0),
      stops: h2.fill.stops,
      spread: 'pad',
    },
  );
  expect((await node('h2')).fill).toEqual((await node('h1')).fill);

  // Every step undoes back to the fixture, byte for byte.
  expect(await undoDepth(page)).toBe(steps);
  for (let index = 0; index < steps; index += 1) await run(page, { type: 'undo' });
  expect(await serialized(page)).toBe(FIXTURE_TEXT);
  test.info().annotations.push({ type: 'M4-A12 panel steps', description: String(steps) });
  await expect(page.getByTestId('error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('M4-A12: a ?persist=1 reload keeps the appearance', async ({ page }) => {
  const { errors } = await open(page, '&persist=1');
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-persist', 'empty', {
    timeout: 30_000,
  });
  // `?persist=1` ignores `?fixture=` (M5 section 5.3), so the fixture is loaded by the command.
  await run(page, { type: 'loadDocument', document: FIXTURE });
  await page.evaluate(() => (window.__p5Host as unknown as PersistenceHook).persistence.flush());
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-persist', 'saved');
  const stored = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('vector-studio-next-host');
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        request.onsuccess = () => {
          const db = request.result;
          const get = db
            .transaction('envelopes', 'readonly')
            .objectStore('envelopes')
            .get('default');
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => reject(get.error ?? new Error('IndexedDB request failed'));
        };
      }),
  );
  const envelope = parseEnvelope(stored as string);
  expect(envelope.ok).toBe(true);
  if (envelope.ok) expect(serializeDocument(envelope.envelope.document)).toBe(FIXTURE_TEXT);
  await page.reload();
  const status = await settled(page);
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-persist', 'restored', {
    timeout: 30_000,
  });
  expect(await serialized(page)).toBe(FIXTURE_TEXT);
  // The restored appearance draws as the fixture does (pixels when there is a frame).
  await expect(status).toHaveAttribute('data-renderer', /ready|error/u);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const failures: string[] = [];
  let compared = true;
  for (const pageId of ['p1', 'p2']) {
    const outcome = await comparePage(page, pageId, dpr);
    compared &&= outcome.row.compared;
    failures.push(...outcome.failures);
  }
  // The A12 renderer diagnostic rule, when there is a frame (smoke: none, the backend failed).
  if (compared) {
    const rendered = await page.evaluate(() => [...(window.__nextHostRenderer?.diagnostics ?? [])]);
    failures.push(...rendererDiagnostics(rendered).failures);
  }
  expect(failures).toEqual([]);
  const diagnostics = await page.evaluate(() =>
    window.__p5Host!.events.filter((event) => event.type === 'diagnostic'),
  );
  expect(diagnostics).toEqual([]);
  expect(errors).toEqual([]);
});

// M4-A13 (observation, no claim): the frame time of the 10,000 stroked rectangles with a `round`
// join (P1 primitives) and a `miter` join (M4-P4 paths), at the fit camera: the time from
// `loadDocument` to the first captured frame, then five captures of a re-presented frame (each
// an invalidation, two animation frames and the next presented frame, so a frame plus about two
// display intervals). Reported as annotations and the attached record; nothing is asserted but
// that the document loads. The Node side (load, projection, `setStyle`) is
// tests/m4-a13/observation.check.ts.
test('M4-A13: frame time of 10,000 stroked rectangles (observation)', async ({ page }, info) => {
  const { errors, status } = await open(page, '');
  const rows: unknown[] = [];
  for (const join of ['round', 'miter'] as const) {
    const document = generateM4A13Document(join);
    const result = await page.evaluate(async (script: string) => {
      const editor = window.__p5Host!.editor;
      const start = performance.now();
      const loaded = editor.execute({ type: 'loadDocument', document: JSON.parse(script) });
      if (!loaded.ok) return { error: `${loaded.code} ${loaded.path ?? ''}` };
      editor.execute({ type: 'zoomTo', target: 'fit' });
      const loadMs = performance.now() - start;
      const hook = window.__nextHostRenderer;
      if (hook === undefined) return { loadMs, error: 'no renderer hook' };
      try {
        await hook.capture();
        const firstFrameMs = performance.now() - start;
        const capturesMs: number[] = [];
        for (let index = 0; index < 5; index += 1) {
          const at = performance.now();
          await hook.capture();
          capturesMs.push(performance.now() - at);
        }
        return { loadMs, firstFrameMs, capturesMs };
      } catch (error) {
        return { loadMs, error: String(error).slice(0, 200) };
      }
    }, JSON.stringify(document));
    rows.push({ join, ...result });
  }
  const renderer = await status.getAttribute('data-renderer');
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const record = { project: info.project.name, renderer, dpr, rows };
  await info.attach('m4-a13-frame-time.json', {
    body: JSON.stringify(record, null, 2),
    contentType: 'application/json',
  });
  info.annotations.push({ type: 'M4-A13 frame time', description: JSON.stringify(record) });
  for (const row of rows as { error?: string }[]) {
    if (rendering()) expect(row.error).toBeUndefined();
    else expect(row.error ?? '').not.toMatch(/^editor\.|^document\./u);
  }
  expect(errors).toEqual([]);
});
