import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { VizV2PathDataApi } from '../../apps/playground/src/viz-v2-path-data.js';
import { VIZ_V2_EVIDENCE_LABEL } from '../../apps/playground/src/viz-v2-path-data-state.js';
import { p1Source } from '../support/p1-evidence.js';

declare global {
  interface Window {
    __vectorStudioVizV2PathData: VizV2PathDataApi;
  }
}

// Visualization track V-2 (docs/plans/viz-v2-path-data-contract.md): headed checks of the SVG
// path-data page with the real geometry-wasm fill-mesh and stroke-mesh ports, in Chrome and Edge at
// device pixel ratios 1 and 2. Functional evidence only: precision is UNVERIFIED against the 0.25
// physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold or performance
// claim is made. The helpers below are copied from tests/gpu/viz-v1-appearance.spec.ts (that spec
// stays unedited, V2-A17): the per-run evidence directory, the in-page PNG probe decoding,
// PROBE_TOLERANCE and the settle() definition.
//
// Probe positions are fixed from the path data and an independent copy of the fit rule of contract
// section 3.4, by the probe rule, and not from reading any run's pixels. Only the notice sets
// (OBSERVED_NOTICES) are fixed from the first headed run. A fresh page is loaded per scenario,
// because notices are emitted on transitions.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.VIZ_V2_OUTPUT_DIR ?? 'artifacts/viz-v2-path-data',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

/** The operation ids the expected literals were fixed with (V2-A1). */
const OPERATION_IDS = {
  fill: 'geometry-wasm/fill-v0+r2',
  stroke: 'geometry-wasm/stroke-v0+r4',
} as const;

/**
 * Sorted `nodeId paint failureCode` of every D8-interim notice, per scenario and stage. Observed
 * literals, fixed at the first headed run of V-2 with the operation ids above and identical in
 * Chrome and Edge. They are current-kernel observations (production limits): a limit raise, an
 * operation-id bump or ST-U9's fast rung may re-baseline them, in the PR that changes the outcome
 * and with a dated note (contract section 4.1). Fixed 2026-10-22 from the first headed runs (Chrome
 * 155 and Edge 155, DPR 1 and 2, all four identical): p3q, p3s, a13 and t include the fringe-work-cap
 * of the two curved paths (drawn without fringe), t also the W1 work-limit.
 */
const OBSERVED_NOTICES: Readonly<Record<string, readonly string[]>> = {
  n0: [],
  flow: [],
  p1: [],
  p2: [],
  p3q: ['v2-path fill fringe-work-cap'],
  p3s: ['v2-path fill fringe-work-cap'],
  p3qc: ['v2-path fill unsupported-geometry'],
  p3sc: ['v2-path fill unsupported-geometry'],
  p4: [],
  r: [],
  'w.a-w1': ['v2-path fill work-limit'],
  'w.b-w2': ['v2-path fill work-limit'],
  a7: [],
  a12: [],
  a13: ['v2-path fill fringe-work-cap'],
  a14: [],
  t: ['v2-path fill fringe-work-cap', 'v2-path fill fringe-work-cap', 'v2-path fill work-limit'],
};
// Observed identical at DPR 1 and DPR 2; the literals are kept per DPR.
const EXPECTED: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [1, 2].flatMap((dpr) =>
    Object.entries(OBSERVED_NOTICES).map(([key, notices]) => [`${dpr}/${key}`, notices] as const),
  ),
);

/** Channel tolerance for probes, in 8-bit steps; functional, not a precision gate. */
const PROBE_TOLERANCE = 12;
const SURFACE = { width: 720, height: 600 } as const;
const to8 = (value: number) => Math.round(value * 255);

type Rgb = readonly [number, number, number];
// The fixed paints of contract section 3.2, copied here as literals.
const FILL: Rgb = [to8(0.86), to8(0.2), to8(0.2)];
const STROKE: Rgb = [to8(0.2), to8(0.4), to8(0.9)];
const separation = (a: Rgb, b: Rgb) =>
  Math.max(...a.map((value, lane) => Math.abs(value - b[lane]!)));

// ---------------------------------------------------------------------------------------------
// The independent copy of the fit rule (contract section 3.4)
// ---------------------------------------------------------------------------------------------

type Camera = { position: { x: number; y: number }; zoom: number };

function expectedFit(points: readonly number[], stroke: { on: boolean; width: number }): Camera {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  const [minX, maxX, minY, maxY] =
    points.length === 0
      ? [0, 0, 0, 0]
      : [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const half = stroke.on && stroke.width > 0 ? stroke.width / 2 : 0;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const halfX = (maxX - minX) / 2 + half;
  const halfY = (maxY - minY) / 2 + half;
  const quotient = (numerator: number, extent: number) =>
    extent > 0 ? Math.min(Math.max(numerator / extent, 2 ** -20), 2 ** 20) : Infinity;
  let zoom = Math.min(quotient(336, halfX), quotient(276, halfY));
  if (zoom === Infinity) zoom = 1;
  return { position: { x: centerX - 360 / zoom, y: centerY - 300 / zoom }, zoom };
}

const toSurface = (camera: Camera, world: readonly [number, number]) =>
  [
    (world[0] - camera.position.x) * camera.zoom,
    (world[1] - camera.position.y) * camera.zoom,
  ] as const;

// ---------------------------------------------------------------------------------------------
// Paths of the scenarios, with their probes (world coordinates), fixed before the first run
// ---------------------------------------------------------------------------------------------

const DEFAULT_TEXT = 'M 40 40 H 280 V 200 Q 160 280 40 200 Z';
// The literal mapping of the default path: Q 160 280 40 200 from (280, 200) is elevated with the
// binary64 formula of section 1.3.
const DEFAULT_VERBS = ['move', 'line', 'line', 'cubic', 'close'];
const DEFAULT_POINTS = [
  40,
  40,
  280,
  40,
  280,
  200,
  (280 + 2 * 160) / 3,
  (200 + 2 * 280) / 3,
  (40 + 2 * 160) / 3,
  (200 + 2 * 280) / 3,
  40,
  200,
];

const P1 = 'm 100 100 h 200 v 200 h -200 z';
const P2 = 'M 0 0 H 300 V 300 H 0 Z M 100 100 H 200 V 200 H 100 Z';
// DEVIATION D1 (reported to the Primary, 2026-10-22): the contract's P3 paths (V2-A9) draw nothing on
// the current kernel. On the first headed run both give `v2-path fill unsupported-geometry` (the
// exact cascade fails on two adjacent cubics with generic or tangent-aligned knots; see
// p3-fill-stroke-meshes.md on "generic coordinates"), so no interior probe can be fill. They are
// kept below as P3Q_CONTRACT and P3S_CONTRACT and their observed outcome is gated (scenarios p3qc,
// p3sc). The probe scenarios p3q and p3s use these variants, which keep the intent (a Q followed by
// a T that reflects its control, and a C followed by an S that reflects its control) and draw:
//  - P3Q: the Q control points are chosen so that the elevation is exact in binary64.
//  - P3S: the first cubic is not vertical at its start.
const P3Q = 'M 0 0 L 0 -90 Q 90 -180 180 -90 T 360 -90 L 360 0 Z';
const P3S = 'M 0 0 C 20 -100 80 -100 100 -40 S 180 20 200 -40 L 200 50 L 0 50 Z';
const P3Q_CONTRACT = 'M 0 0 L 0 -100 Q 100 -200 200 -100 T 400 -100 L 400 0 Z';
const P3S_CONTRACT = 'M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50 L 200 50 L 0 50 Z';
const P4 = 'M 0 0 H 200 V 200';

/** Five disjoint 40 x 40 squares: five contours, one more than the fill kernel's cap of four. */
const squares = (count: number) =>
  Array.from({ length: count }, (_, index) => `M ${index * 60} 0 h 40 v 40 h -40 z`).join(' ');

function sortedNotices(
  notices: ReadonlyArray<{ nodeId: string | null; paint: string | null; failureCode: string }>,
): string[] {
  return notices.map((n) => `${n.nodeId} ${n.paint} ${n.failureCode}`).sort();
}

type Probe = {
  name: string;
  /** World position, or a surface position in CSS px. */
  world?: readonly [number, number];
  surface?: readonly [number, number];
  expected: Rgb | 'backdrop';
};

function controlsOf(page: Page) {
  const radio = (group: string, name: string) =>
    page.getByRole('group', { name: group, exact: true }).getByRole('radio', { name, exact: true });
  return {
    text: page.getByLabel('Path data (SVG d)', { exact: true }),
    apply: page.getByRole('button', { name: 'Apply path data', exact: true }),
    fit: page.getByRole('button', { name: 'Fit to path', exact: true }),
    zoomIn: page.getByRole('button', { name: 'Zoom in', exact: true }),
    fillOn: page.getByRole('checkbox', { name: 'Fill', exact: true }),
    fillRule: (rule: string) => radio('Fill rule', rule),
    strokeOn: page.getByRole('checkbox', { name: 'Stroke', exact: true }),
    width: page.getByRole('spinbutton', { name: 'Stroke width', exact: true }),
    cap: (cap: string) => radio('Cap', cap),
    join: (join: string) => radio('Join', join),
    error: page.getByRole('alert'),
  };
}
type Controls = ReturnType<typeof controlsOf>;

for (const dpr of [1, 2]) {
  test.describe(`DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test(`V-2 path-data page at DPR ${dpr} (UNVERIFIED precision)`, async ({
      browser,
      page,
    }, info) => {
      test.setTimeout(900_000);
      const directory = path.join(runRoot, info.project.name, `dpr${dpr}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${VIZ_V2_EVIDENCE_LABEL}\n`, {
        flag: 'wx',
      });
      const write = (name: string, data: string | Uint8Array) =>
        writeFileSync(path.join(directory, name), data, { flag: 'wx' });
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.setViewportSize({ width: 1280, height: 900 });

      const failures: string[] = [];
      const fail = (scenario: string, text: string) => failures.push(`${dpr}/${scenario}: ${text}`);
      const scenarios: Record<string, unknown> = {};
      const noticeSets: Record<string, string[]> = {};
      let latencies: unknown[] = [];
      let applyTimings: unknown[] = [];
      let wasmSha256: string | null = null;

      const settle = () => page.evaluate(() => window.__vectorStudioVizV2PathData.settle());
      const snapshot = () => page.evaluate(() => window.__vectorStudioVizV2PathData.snapshot());
      type Snapshot = Awaited<ReturnType<typeof snapshot>>;

      async function open(scenario: string): Promise<{ state: Snapshot; controls: Controls }> {
        // A fresh page per scenario: notices are emitted on transitions. No query is passed: the
        // page reads none.
        await page.goto('/viz-v2-path-data.html');
        try {
          await page.waitForFunction(() => window.__vectorStudioVizV2PathData !== undefined, {
            timeout: 60_000,
          });
        } catch {
          fail(
            'hook-not-installed',
            `${scenario}: console errors ${JSON.stringify(consoleErrors)}`,
          );
          throw new Error('the page hook was not installed within 60 s');
        }
        const capability = await page.evaluate(() => window.__vectorStudioVizV2PathData.ready);
        if (!capability.supported) fail(scenario, `capability ${JSON.stringify(capability)}`);
        const state = await settle();
        wasmSha256 = state.wasmSha256;
        // V2-A1: both real ports, with the operation ids the literals were fixed with.
        if (state.ports?.fill.operationId !== OPERATION_IDS.fill)
          fail(scenario, `unexpected fill port ${JSON.stringify(state.ports)}`);
        if (state.ports?.stroke.operationId !== OPERATION_IDS.stroke)
          fail(scenario, `unexpected stroke port ${JSON.stringify(state.ports)}`);
        return { state, controls: controlsOf(page) };
      }

      /** Types `text` into the text area and presses Apply, then waits for the page to settle. */
      async function applyText(c: Controls, text: string): Promise<Snapshot> {
        await c.text.fill(text);
        await c.apply.click();
        return settle();
      }

      /** The camera of the fit rule for the page's current appearance. */
      const fitFor = (state: Snapshot): Camera =>
        expectedFit(state.points, {
          on: state.appearance?.strokeOn ?? false,
          width: state.appearance?.strokeWidth ?? 0,
        });

      /** Screenshot the surface, decode the probes in the page and compare. */
      async function check(
        scenario: string,
        stage: string,
        state: Snapshot,
        probes: readonly Probe[],
      ) {
        const png = await page.locator('#viz-v2-surface').screenshot();
        write(`${scenario}-${stage}.png`, png);
        // The backdrop is the surface's clear color, read inside the fit margin and outside the
        // box (the corner), then checked against the two paints.
        const backdropAt = [8, 8] as const;
        const surfacePoints = probes.map((probe) =>
          probe.surface !== undefined
            ? probe.surface
            : toSurface(state.camera, probe.world ?? [0, 0]),
        );
        for (const [index, point] of surfacePoints.entries()) {
          if (
            point[0] < 2 ||
            point[1] < 2 ||
            point[0] > SURFACE.width - 2 ||
            point[1] > SURFACE.height - 2
          )
            fail(scenario, `${stage}: probe ${probes[index]!.name} is outside the surface`);
        }
        const sampled = await page.evaluate(
          async ({ base64, points, width }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const scratch = document.createElement('canvas');
            scratch.width = image.naturalWidth;
            scratch.height = image.naturalHeight;
            const context = scratch.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const scale = image.naturalWidth / width;
            return points.map(([x, y]) =>
              Array.from(
                context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data,
              ).slice(0, 3),
            );
          },
          {
            base64: png.toString('base64'),
            points: [backdropAt, ...surfacePoints].map((point) => [point[0], point[1]] as const),
            width: SURFACE.width,
          },
        );
        const backdrop = sampled[0] as unknown as Rgb;
        for (const [name, paint] of [
          ['fill', FILL],
          ['stroke', STROKE],
        ] as const) {
          if (separation(backdrop, paint) <= 2 * PROBE_TOLERANCE)
            fail(
              scenario,
              `${stage}: backdrop ${JSON.stringify(backdrop)} is not separated from the ${name} color`,
            );
        }
        const reports = probes.map((probe, index) => {
          const observed = sampled[index + 1]!;
          const expected = probe.expected === 'backdrop' ? backdrop : probe.expected;
          const deviation = Math.max(
            ...observed.map((value, lane) => Math.abs(value - expected[lane]!)),
          );
          return { name: probe.name, at: surfacePoints[index], observed, expected, deviation };
        });
        for (const report of reports) {
          if (report.deviation > PROBE_TOLERANCE)
            fail(
              scenario,
              `${stage}: probe ${report.name} at (${report.at![0].toFixed(2)}, ${report.at![1].toFixed(2)}) is ` +
                `${JSON.stringify(report.observed)}, expected ${JSON.stringify(report.expected)}`,
            );
        }
        return reports;
      }

      /** Gates the sorted notice set against its literal; records it either way. */
      function noticeSet(scenario: string, stage: string, state: Snapshot) {
        const key = stage === '' ? scenario : `${scenario}.${stage}`;
        const notices = sortedNotices(state.notices);
        noticeSets[key] = notices;
        const errors = state.diagnostics.filter((event) => event.severity === 'error');
        if (errors.length > 0)
          fail(scenario, `${stage}: error diagnostics ${JSON.stringify(errors)}`);
        const expected = EXPECTED[`${dpr}/${key}`];
        if (expected === undefined)
          fail(scenario, `${stage}: no expectation (observed ${JSON.stringify(notices)})`);
        else if (JSON.stringify(notices) !== JSON.stringify(expected))
          fail(
            scenario,
            `${stage}: notices ${JSON.stringify(notices)}, expected ${JSON.stringify(expected)}`,
          );
        if (state.pathMesh?.noticesDropped !== 0)
          fail(scenario, `${stage}: noticesDropped ${state.pathMesh?.noticesDropped}`);
        if (state.noticesOnPage !== state.notices.length)
          fail(
            scenario,
            `${stage}: page lists ${state.noticesOnPage} notices, hook has ${state.notices.length}`,
          );
      }

      function sameCamera(scenario: string, stage: string, actual: Camera, expected: Camera) {
        if (
          actual.zoom !== expected.zoom ||
          actual.position.x !== expected.position.x ||
          actual.position.y !== expected.position.y
        )
          fail(
            scenario,
            `${stage}: camera ${JSON.stringify(actual)}, expected the fit ${JSON.stringify(expected)}`,
          );
      }

      async function scenario(name: string, body: () => Promise<void>) {
        try {
          await body();
        } catch (error) {
          fail(name, `threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      /** A known path: Apply, fit, probes and the notice set. */
      async function knownPath(
        name: string,
        text: string,
        prepare: (c: Controls) => Promise<void>,
        probes: Probe[],
        after?: (c: Controls, state: Snapshot) => Promise<void>,
      ) {
        await scenario(name, async () => {
          const { controls: c } = await open(name);
          await prepare(c);
          const state = await applyText(c, text);
          if (state.lastParseError !== null)
            fail(name, `parse error ${JSON.stringify(state.lastParseError)}`);
          const camera = fitFor(state);
          sameCamera(name, 'fit', state.camera, camera);
          await check(name, 'applied', state, probes);
          if (after !== undefined) await after(c, state);
          noticeSet(name, '', await snapshot());
        });
      }

      // -------------------------------------------------------------------------------------
      // V2-A1, V2-A2: the initial page.
      await scenario('n0', async () => {
        const { state, controls: c } = await open('n0');
        scenarios.n0 = { revision: state.revision, draws: state.draws, camera: state.camera };
        noticeSet('n0', '', state);
        await expect(page.locator('#viz-v2-label')).toContainText('UNVERIFIED');
        // The default path is applied at load: revision 1 or above, hook data equals the literal.
        if (state.revision < 1) fail('n0', `initial revision ${state.revision}`);
        if (JSON.stringify(state.verbs) !== JSON.stringify(DEFAULT_VERBS))
          fail('n0', `verbs ${JSON.stringify(state.verbs)}`);
        if (JSON.stringify(state.points) !== JSON.stringify(DEFAULT_POINTS))
          fail('n0', `points ${JSON.stringify(state.points)}`);
        if (state.appliedText !== DEFAULT_TEXT) fail('n0', `applied text ${state.appliedText}`);
        sameCamera('n0', 'initial fit', state.camera, fitFor(state));
        // V2-A2: every control is found by role and accessible name; initial values.
        await expect(c.text).toHaveValue(DEFAULT_TEXT);
        await expect(c.apply).toBeVisible();
        await expect(c.fit).toBeVisible();
        await expect(c.fillOn).toBeChecked();
        await expect(c.fillRule('nonzero')).toBeChecked();
        await expect(c.fillRule('evenodd')).not.toBeChecked();
        await expect(c.strokeOn).not.toBeChecked();
        await expect(c.width).toHaveValue('4');
        await expect(c.cap('butt')).toBeChecked();
        await expect(c.join('miter')).toBeChecked();
        for (const radio of ['butt', 'round', 'square']) await expect(c.cap(radio)).toBeVisible();
        for (const radio of ['miter', 'round', 'bevel']) await expect(c.join(radio)).toBeVisible();
        // The error region and the status region exist with their roles (section 3.6).
        await expect(c.error).toBeAttached();
        await expect(page.locator('#viz-v2-path-status')).toHaveAttribute('aria-live', 'polite');
        await expect(page.locator('#viz-v2-surface')).toHaveAttribute('aria-label', /.+/);
        await expect(page.getByRole('group', { name: 'Path data', exact: true })).toBeVisible();
        await expect(page.getByRole('group', { name: 'Fill', exact: true })).toBeVisible();
        await expect(page.getByRole('group', { name: 'Stroke', exact: true })).toBeVisible();
        // The applied path's counts are printed as text.
        await expect(page.locator('#viz-v2-applied')).toContainText('5 verbs, 6 points');
        // The default path draws: an interior probe is fill, a margin probe is backdrop.
        await check('n0', 'initial', state, [
          { name: 'default interior', world: [160, 100], expected: FILL },
          { name: 'margin', surface: [20, 300], expected: 'backdrop' },
        ]);
      });

      // -------------------------------------------------------------------------------------
      // V2-A8 on the page: typing and blur never parse; Apply does; equal data is Unchanged.
      await scenario('flow', async () => {
        const { state: start, controls: c } = await open('flow');
        await c.text.fill(P1);
        await page.waitForTimeout(150);
        let state = await settle();
        if (state.revision !== start.revision)
          fail('flow', `typing moved the revision to ${state.revision}`);
        await expect(page.locator('#viz-v2-edit-state')).toHaveText('Edited, not applied');
        await c.text.blur();
        await page.waitForTimeout(150);
        state = await settle();
        if (state.revision !== start.revision)
          fail('flow', `blur moved the revision to ${state.revision}`);
        if (state.appliedText !== DEFAULT_TEXT) fail('flow', 'blur applied the text');
        await c.apply.click();
        state = await settle();
        if (state.revision !== start.revision + 1)
          fail('flow', `Apply: revision ${start.revision} to ${state.revision}`);
        await expect(page.locator('#viz-v2-edit-state')).toHaveText('');
        // The same path with other whitespace: no change, no new revision, "Unchanged".
        const equal = 'm100,100 h200 v200 h-200 z';
        state = await applyText(c, equal);
        if (state.revision !== start.revision + 1)
          fail('flow', `equal data moved the revision to ${state.revision}`);
        await expect(page.locator('#viz-v2-edit-state')).toHaveText('Unchanged');
        if (state.lastOutcome !== 'unchanged') fail('flow', `outcome ${state.lastOutcome}`);
        noticeSet('flow', '', state);
      });

      // -------------------------------------------------------------------------------------
      // V2-A9: known paths render.
      // P1: an interior probe is fill, a margin probe is backdrop.
      await knownPath('p1', P1, async () => {}, [
        { name: 'P1 interior', world: [200, 200], expected: FILL },
        { name: 'P1 margin', surface: [40, 300], expected: 'backdrop' },
      ]);

      // P2: the inner square is fill under nonzero and backdrop under evenodd.
      await scenario('p2', async () => {
        const { controls: c } = await open('p2');
        let state = await applyText(c, P2);
        const camera = fitFor(state);
        sameCamera('p2', 'fit', state.camera, camera);
        await check('p2', 'nonzero', state, [
          { name: 'inner center (nonzero)', world: [150, 150], expected: FILL },
          { name: 'ring', world: [50, 150], expected: FILL },
        ]);
        await c.fillRule('evenodd').check();
        state = await settle();
        await check('p2', 'evenodd', state, [
          { name: 'inner center (evenodd)', world: [150, 150], expected: 'backdrop' },
          { name: 'ring', world: [50, 150], expected: FILL },
        ]);
        noticeSet('p2', '', state);
      });

      // P3: Q and T; and S.
      // The curve rises to y = -135 at x = 90 and dips to y = -45 at x = 270 (T control (270, 0)).
      await knownPath('p3q', P3Q, async () => {}, [
        { name: 'just inside the peak', world: [90, -125], expected: FILL },
        { name: 'just outside the peak', world: [90, -145], expected: 'backdrop' },
        { name: 'just inside the dip', world: [270, -35], expected: FILL },
        { name: 'just outside the dip', world: [270, -55], expected: 'backdrop' },
      ]);
      // The first cubic peaks near (57.6, -81); the S control reflects to (120, 20), so the second
      // cubic dips to y = 5 at x = 150.
      await knownPath('p3s', P3S, async () => {}, [
        { name: 'just inside the first peak', world: [58, -65], expected: FILL },
        { name: 'just outside the first peak', world: [58, -95], expected: 'backdrop' },
        { name: 'just inside the dip', world: [150, 15], expected: FILL },
        { name: 'just outside the dip', world: [150, -10], expected: 'backdrop' },
      ]);
      // The paths as the contract wrote them: gated as the observed outcome, not hidden. See
      // DEVIATION D1 above. Note, 2026-10-23 (E8-U1, E8-Q4 (a), D9-Q8): the exact-rung direction
      // hint of docs/plans/p3-rounded-knot-topology-contract.md E8.3 admits P3Q_CONTRACT, so p3qc
      // draws. The Q peaks at (100, -150); p3sc (M1', E8.5) stays not drawn.
      await knownPath('p3qc', P3Q_CONTRACT, async () => {}, [
        { name: 'contract P3Q interior (drawn)', world: [100, -140], expected: FILL },
        { name: 'contract P3Q outside the peak', world: [100, -160], expected: 'backdrop' },
      ]);
      await knownPath('p3sc', P3S_CONTRACT, async () => {}, [
        { name: 'contract P3S interior (not drawn)', world: [62, -70], expected: 'backdrop' },
      ]);

      // P4: an open path with the fill off and the stroke on, width 16, butt.
      // The geometry is applied first (the default cubic is never stroked), then the appearance,
      // then Fit, which includes the half stroke width.
      await scenario('p4', async () => {
        const { controls: c } = await open('p4');
        await applyText(c, P4);
        await c.fillOn.uncheck();
        await c.strokeOn.check();
        await c.width.fill('16');
        await c.width.press('Enter');
        await settle();
        await c.fit.click();
        const state = await settle();
        if (state.lastParseError !== null)
          fail('p4', `parse error ${JSON.stringify(state.lastParseError)}`);
        sameCamera('p4', 'fit', state.camera, fitFor(state));
        await check('p4', 'applied', state, [
          { name: 'P4 stroke band', world: [100, 0], expected: STROKE },
          { name: 'P4 off the band', world: [100, 40], expected: 'backdrop' },
        ]);
        noticeSet('p4', '', state);
      });

      // -------------------------------------------------------------------------------------
      // V2-A10: invalid input is rejected and nothing is applied.
      await scenario('r', async () => {
        const { controls: c } = await open('r');
        let state = await applyText(c, P1);
        const camera = fitFor(state);
        await check('r', 'p1', state, [{ name: 'P1 interior', world: [200, 200], expected: FILL }]);
        const before = { revision: state.revision, notices: state.notices.length };
        // R1: M 10 10 L 20 gives expected-number at the end (offset 12, line 1, column 13).
        const bad = 'M 10 10 L 20';
        await c.text.fill(bad);
        await c.apply.click();
        state = await settle();
        await expect(c.error).toContainText('expected-number');
        await expect(c.error).toContainText('line 1, column 13');
        await expect(c.text).toHaveAttribute('aria-invalid', 'true');
        await expect(c.text).toHaveAttribute('aria-describedby', /viz-v2-error/);
        const caret = await c.text.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
        if (caret !== 12) fail('r', `R1: caret at ${caret}, expected 12`);
        const focused = await page.evaluate(() => document.activeElement?.id);
        if (focused !== 'viz-v2-path-text') fail('r', `R1: focus on #${focused}`);
        if (state.revision !== before.revision) fail('r', `R1: revision ${state.revision}`);
        if (state.notices.length !== before.notices) fail('r', 'R1: a new notice arrived');
        if (state.lastParseError?.code !== 'expected-number' || state.lastParseError.offset !== 12)
          fail('r', `R1: error ${JSON.stringify(state.lastParseError)}`);
        sameCamera('r', 'R1 camera unchanged', state.camera, camera);
        await check('r', 'r1', state, [{ name: 'P1 interior', world: [200, 200], expected: FILL }]);
        // R2: an arc.
        await c.text.fill('M 0 0 A 10 10 0 0 1 20 20');
        await c.apply.click();
        state = await settle();
        await expect(c.error).toContainText('unsupported-command');
        await expect(c.error).toContainText(
          'Arc commands (A/a) are not supported on this page. Convert arcs to curves first.',
        );
        const caret2 = await c.text.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
        if (caret2 !== 6) fail('r', `R2: caret at ${caret2}, expected 6`);
        if (state.lastParseError?.offset !== 6) fail('r', 'R2: offset is not 6');
        if (state.revision !== before.revision) fail('r', `R2: revision ${state.revision}`);
        // R3: a valid Apply clears the error and aria-invalid.
        state = await applyText(c, P2);
        await expect(c.text).not.toHaveAttribute('aria-invalid', 'true');
        await expect(c.error).toHaveText('');
        if (state.revision !== before.revision + 1) fail('r', `R3: revision ${state.revision}`);
        noticeSet('r', '', state);
      });

      // -------------------------------------------------------------------------------------
      // V2-A11: a kernel limit is shown, not hidden.
      await scenario('w', async () => {
        const { controls: c } = await open('w');
        let state = await applyText(c, squares(5));
        const w1 = fitFor(state);
        sameCamera('w', 'W1 fit', state.camera, w1);
        await check('w', 'w1', state, [
          { name: 'W1 square interior (not drawn)', world: [20, 20], expected: 'backdrop' },
        ]);
        noticeSet('w', 'a-w1', state);
        const status = await page.locator('#viz-v2-path-status').innerText();
        if (!status.includes('fill: not drawn')) fail('w', `W1: status ${status}`);
        const logged = await page.locator('#viz-v2-notices li').count();
        if (logged < 1) fail('w', 'W1: the notice is not in the page log');
        // W2: four of the squares: drawn, the W1 log entry remains, the status drops the failure.
        state = await applyText(c, squares(4));
        sameCamera('w', 'W2 fit', state.camera, fitFor(state));
        await check('w', 'w2', state, [
          { name: 'W2 square interior (drawn)', world: [20, 20], expected: FILL },
        ]);
        noticeSet('w', 'b-w2', state);
        const status2 = await page.locator('#viz-v2-path-status').innerText();
        if (status2.includes('not drawn'))
          fail('w', `W2: status still shows a failure: ${status2}`);
        if ((await page.locator('#viz-v2-notices li').count()) !== logged)
          fail('w', 'W2: the W1 log entry did not remain');
      });

      // -------------------------------------------------------------------------------------
      // V2-A7 (GPU): 65,536 characters parse; 65,537 give input-too-long and change nothing.
      await scenario('a7', async () => {
        const { controls: c } = await open('a7');
        const long = (total: number) => 'M 0 0 L 100 100' + ' '.repeat(total - 15);
        let state = await applyText(c, long(65_536));
        if (state.lastParseError !== null)
          fail('a7', `65,536 characters: ${JSON.stringify(state.lastParseError)}`);
        const revision = state.revision;
        state = await applyText(c, long(65_537));
        if (
          state.lastParseError?.code !== 'input-too-long' ||
          state.lastParseError.offset !== 65_536
        )
          fail('a7', `65,537 characters: ${JSON.stringify(state.lastParseError)}`);
        await expect(c.error).toContainText('input-too-long');
        if (state.revision !== revision)
          fail('a7', `revision ${revision} to ${state.revision} after the long input`);
        noticeSet('a7', '', state);
      });

      // -------------------------------------------------------------------------------------
      // V2-A12: mesh work follows the geometry revision and the paint keys.
      await scenario('a12', async () => {
        const { controls: c } = await open('a12');
        type Rule = 'zero' | 'atLeast1' | 'record';
        const canvas = page.locator('#viz-v2-surface');
        const steps: Array<{
          name: string;
          act: () => Promise<unknown>;
          fill: Rule;
          stroke: Rule;
          revision: 0 | 1;
        }> = [
          {
            name: 'apply new geometry (stroke off)',
            act: async () => {
              await c.text.fill('M 40 40 H 280 V 200 H 40 Z');
              await c.apply.click();
            },
            fill: 'atLeast1',
            stroke: 'record',
            revision: 1,
          },
          {
            name: 'stroke on',
            act: () => c.strokeOn.check(),
            fill: 'zero',
            stroke: 'atLeast1',
            revision: 1,
          },
          {
            name: 'apply new geometry (fill on, stroke on)',
            act: async () => {
              await c.text.fill('M 40 40 H 280 V 160 H 40 Z');
              await c.apply.click();
            },
            fill: 'atLeast1',
            stroke: 'atLeast1',
            revision: 1,
          },
          {
            name: 'fit (camera already equals the fit)',
            act: () => c.fit.click(),
            fill: 'zero',
            stroke: 'zero',
            revision: 0,
          },
          {
            name: 'apply equal data',
            act: async () => {
              await c.text.fill('M40 40 H280 V160 H40 Z');
              await c.apply.click();
            },
            fill: 'zero',
            stroke: 'zero',
            revision: 0,
          },
          {
            name: 'fill rule evenodd',
            act: () => c.fillRule('evenodd').check(),
            fill: 'atLeast1',
            stroke: 'zero',
            revision: 1,
          },
          {
            name: 'width 12',
            act: async () => {
              await c.width.fill('12');
              await c.width.press('Enter');
            },
            fill: 'zero',
            stroke: 'atLeast1',
            revision: 1,
          },
          {
            name: 'cap round',
            act: () => c.cap('round').check(),
            fill: 'zero',
            stroke: 'atLeast1',
            revision: 1,
          },
          {
            name: 'join bevel',
            act: () => c.join('bevel').check(),
            fill: 'zero',
            stroke: 'atLeast1',
            revision: 1,
          },
          {
            name: 'pan',
            act: async () => {
              const box = (await canvas.boundingBox())!;
              await page.mouse.move(box.x + 360, box.y + 300);
              await page.mouse.down();
              await page.mouse.move(box.x + 380, box.y + 312, { steps: 4 });
              await page.mouse.up();
            },
            fill: 'zero',
            stroke: 'zero',
            revision: 0,
          },
          {
            name: 'fit after the pan',
            act: () => c.fit.click(),
            fill: 'record',
            stroke: 'record',
            revision: 0,
          },
        ];
        const deltas: unknown[] = [];
        let previous = await snapshot();
        for (const step of steps) {
          await step.act();
          const now = await settle();
          const fillDelta = (now.pathMesh?.portCalls ?? 0) - (previous.pathMesh?.portCalls ?? 0);
          const strokeDelta =
            (now.pathMesh?.strokePortCalls ?? 0) - (previous.pathMesh?.strokePortCalls ?? 0);
          deltas.push({
            step: step.name,
            fillPortCalls: fillDelta,
            strokePortCalls: strokeDelta,
            revision: now.revision,
          });
          const verdict = (rule: Rule, delta: number, label: string) => {
            if (rule === 'zero' && delta !== 0)
              fail('a12', `${step.name}: ${label} delta ${delta}, expected 0`);
            if (rule === 'atLeast1' && delta < 1)
              fail('a12', `${step.name}: ${label} delta ${delta}, expected >= 1`);
          };
          verdict(step.fill, fillDelta, 'fill');
          verdict(step.stroke, strokeDelta, 'stroke');
          if (now.revision !== previous.revision + step.revision)
            fail('a12', `${step.name}: revision ${previous.revision} to ${now.revision}`);
          previous = now;
        }
        scenarios.a12 = deltas;
        noticeSet('a12', '', previous);
      });

      // -------------------------------------------------------------------------------------
      // V2-A13: fit.
      await scenario('a13', async () => {
        const { controls: c } = await open('a13');
        let state = await applyText(c, P1);
        sameCamera('a13', 'P1', state.camera, fitFor(state));
        // A manual zoom and pan set the label "may differ"; Fit restores the fit camera.
        await c.zoomIn.click();
        await page.waitForTimeout(100);
        state = await settle();
        if (state.camera.zoom !== fitFor(state).zoom * 2)
          fail('a13', `zoom in gave ${state.camera.zoom}`);
        if (!state.targetStatus.label.includes('may differ'))
          fail('a13', 'the status label does not say "may differ" after a zoom');
        const box = (await page.locator('#viz-v2-surface').boundingBox())!;
        await page.mouse.move(box.x + 300, box.y + 300);
        await page.mouse.down();
        await page.mouse.move(box.x + 340, box.y + 330, { steps: 5 });
        await page.mouse.up();
        await settle();
        await c.fit.click();
        state = await settle();
        sameCamera('a13', 'Fit after zoom and pan', state.camera, fitFor(state));
        // A one-point path gives zoom 1 centered on (5, 5) and no error.
        state = await applyText(c, 'M 5 5');
        if (state.lastParseError !== null) fail('a13', 'M 5 5 gave an error');
        sameCamera('a13', 'M 5 5', state.camera, { position: { x: 5 - 360, y: 5 - 300 }, zoom: 1 });
        if (state.camera.zoom !== 1) fail('a13', `M 5 5 zoom ${state.camera.zoom}`);
        if (state.targetStatus.label.includes('may differ'))
          fail('a13', 'the label survived a geometry-changing Apply');
        // A geometry-changing Apply with the stroke on includes the half stroke width.
        await c.strokeOn.check();
        await c.width.fill('16');
        await c.width.press('Enter');
        await settle();
        state = await applyText(c, P4);
        sameCamera('a13', 'P4 with stroke', state.camera, fitFor(state));
        // The control points of curves are in the box: Q and T with the stroke off.
        await c.strokeOn.uncheck();
        state = await applyText(c, P3Q);
        sameCamera('a13', 'P3Q', state.camera, fitFor(state));
        noticeSet('a13', '', await snapshot());
      });

      // -------------------------------------------------------------------------------------
      // V2-A14: keyboard and accessibility.
      await scenario('a14', async () => {
        const { state: start, controls: c } = await open('a14');
        await c.text.focus();
        await page.keyboard.press('Control+A');
        await page.keyboard.type(P1);
        await page.keyboard.press('Tab');
        const afterTab = await page.evaluate(() => document.activeElement?.id);
        if (afterTab === 'viz-v2-path-text') fail('a14', 'Tab did not leave the text area');
        const outline = () =>
          page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
        if ((await outline()) === 'none') fail('a14', 'the focused control has no outline');
        // The focused control after one Tab is Apply; Enter applies.
        const focusedApply = await page.evaluate(() => document.activeElement?.id);
        if (focusedApply !== 'viz-v2-apply') fail('a14', `Tab reached #${focusedApply}, not Apply`);
        await page.keyboard.press('Enter');
        let state = await settle();
        if (state.revision !== start.revision + 1)
          fail('a14', `keyboard Apply: revision ${start.revision} to ${state.revision}`);
        // Space on the focused button applies too (an edit first, so the data differs).
        await c.text.focus();
        await page.keyboard.press('Control+A');
        await page.keyboard.type(P2);
        await page.keyboard.press('Tab');
        await page.keyboard.press('Space');
        state = await settle();
        if (state.revision !== start.revision + 2)
          fail('a14', `Space Apply: revision ${state.revision}`);
        // A parse error moves the focus to the text area.
        await c.text.focus();
        await page.keyboard.press('Control+A');
        await page.keyboard.type('M 1');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await settle();
        const afterError = await page.evaluate(() => document.activeElement?.id);
        if (afterError !== 'viz-v2-path-text') fail('a14', `focus after an error: #${afterError}`);
        await expect(c.error).toHaveAttribute('role', 'alert');
        const describedBy = await c.text.getAttribute('aria-describedby');
        const errorId = await c.error.getAttribute('id');
        if (describedBy === null || errorId === null || !describedBy.split(/\s+/).includes(errorId))
          fail('a14', `aria-describedby ${describedBy} does not reference #${errorId}`);
        await expect(page.locator('#viz-v2-path-status')).toHaveAttribute('aria-live', 'polite');
        await expect(page.locator('#viz-v2-surface')).toHaveAttribute('aria-label', /.+/);
        if ((await outline()) === 'none') fail('a14', 'the focused text area has no outline');
        // V2-A16 on the page: nothing is stored and no query parameter is read or written.
        const stored = await page.evaluate(async () => ({
          local: localStorage.length,
          session: sessionStorage.length,
          databases: (await indexedDB.databases()).length,
          search: location.search,
          hash: location.hash,
        }));
        if (stored.local !== 0 || stored.session !== 0 || stored.databases !== 0)
          fail('a14', `page storage ${JSON.stringify(stored)}`);
        if (stored.search !== '' || stored.hash !== '')
          fail('a14', `URL ${JSON.stringify(stored)}`);
        noticeSet('a14', '', await snapshot());
      });

      // -------------------------------------------------------------------------------------
      // V2-A15: Apply latency, a FUNCTIONAL observation with no performance claim or threshold.
      await scenario('t', async () => {
        const { controls: c } = await open('t');
        const long = 'M 0 0 L 100 0 L 100 100 Z' + ' '.repeat(65_536 - 25);
        const run: Array<[string, string]> = [
          ['P1', P1],
          ['P2', P2],
          ['P3Q', P3Q],
          ['P3S', P3S],
          ['P4', P4],
          ['W1', squares(5)],
          ['65,536 characters', long],
        ];
        for (const [, text] of run) await applyText(c, text);
        const state = await snapshot();
        latencies = state.latencies;
        applyTimings = state.applyTimings;
        const measured = state.latencies.filter((latency) => latency.toFrameMs !== null);
        if (measured.length === 0) fail('t', 'V2-A15: no latency was observed');
        for (const latency of state.latencies) {
          if (latency.toFrameMs === null)
            fail('t', `V2-A15: no frame after ${latency.control} ${JSON.stringify(latency)}`);
          for (const value of [latency.toFrameMs, latency.toSettleMs, latency.parseMs]) {
            if (value !== null && !(Number.isFinite(value) && value >= 0))
              fail(
                't',
                `V2-A15: latency ${JSON.stringify(latency)} is not finite and non-negative`,
              );
          }
        }
        for (const timing of state.applyTimings) {
          if (!(Number.isFinite(timing.parseMs) && timing.parseMs >= 0))
            fail('t', `V2-A15: apply timing ${JSON.stringify(timing)}`);
        }
        // The load entry plus one per Apply above (the long text parses and changes the data).
        if (state.latencies.length < run.length + 1)
          fail('t', `V2-A15: ${state.latencies.length} latencies for ${run.length + 1} applies`);
        noticeSet('t', '', state);
      });

      if (pageErrors.length > 0) fail('page', `page errors: ${pageErrors.join('; ')}`);
      write(
        'observations.json',
        `${JSON.stringify(
          {
            label: VIZ_V2_EVIDENCE_LABEL,
            latencyLabel:
              'FUNCTIONAL observation; no performance claim; no threshold (V2-A15). Per Apply: the parse time and the time from the Apply to the first frame submitted after the change, and to the last frame before the page settled, in milliseconds.',
            browser: { project: info.project.name, version: browser.version() },
            host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model },
            source: p1Source(),
            wasmSha256,
            operationIds: OPERATION_IDS,
            deviceScaleFactor: dpr,
            probeTolerance: PROBE_TOLERANCE,
            noticeSets,
            scenarios,
            latencies,
            applyTimings,
            consoleErrors,
            pageErrors,
            failures,
          },
          null,
          2,
        )}\n`,
      );
      expect(failures).toEqual([]);
    });
  });
}
