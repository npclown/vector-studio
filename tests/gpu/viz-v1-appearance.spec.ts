import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { VizV1AppearanceApi } from '../../apps/playground/src/viz-v1-appearance.js';
import {
  VIZ_V1_BACKGROUND,
  VIZ_V1_EVIDENCE_LABEL,
  VIZ_V1_SURFACE,
  VIZ_V1_VIEWS,
  targetById,
  worldToSurface,
} from '../../apps/playground/src/viz-v1-appearance-scene.js';
import { p1Source } from '../support/p1-evidence.js';

declare global {
  interface Window {
    __vectorStudioVizV1Appearance: VizV1AppearanceApi;
  }
}

// Visualization track V-1 (docs/plans/viz-v1-path-appearance-contract.md): headed checks of the
// path appearance page with the real geometry-wasm fill-mesh and stroke-mesh ports, in Chrome and
// Edge at device pixel ratios 1 and 2. Functional evidence only: precision is UNVERIFIED against
// the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold or
// performance claim is made. The helpers below are copied from tests/gpu/p3-b2-strokes.spec.ts
// (V1-A15: that spec stays unedited): the per-run evidence directory, the in-page PNG probe
// decoding, PROBE_TOLERANCE, the background-mix expected colors and the settle() definition.
//
// Probe positions, colors A to D and the switch ratio of v1-chevron are fixed from the scene
// geometry below, by the probe rule, and not from reading any run's pixels. Only the notice sets
// (EXPECTED) are fixed from the first headed run. A fresh page is loaded per scenario, because
// notices are emitted on transitions.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.VIZ_V1_OUTPUT_DIR ?? 'artifacts/viz-v1-appearance',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

/** The operation ids the expected literals were fixed with (V1-A1, V1-A9). */
const OPERATION_IDS = {
  fill: 'geometry-wasm/fill-v0+r3',
  stroke: 'geometry-wasm/stroke-v0+r6',
} as const;

/**
 * Sorted `nodeId paint failureCode` of every path notice, per `dpr/scenario`. Observed
 * literals, fixed at the first headed run of V-1 (2026-10-22) with the operation ids above and
 * identical in Chrome and Edge. They are current-kernel observations (production limits): a
 * limit raise, an operation-id bump or ST-U9's fast rung may re-baseline them, in the PR that
 * changes the outcome and with a dated note here (contract section 4.1).
 */
const OBSERVED_NOTICES: Readonly<Record<string, readonly string[]>> = {
  // N0: the initial scene; v1-circle fill-only meshes and v1-circle has no notice.
  n0: [],
  s1: [],
  s2: [],
  s3: [],
  s4: ['v1-zigzag stroke fringe-work-cap'],
  s5: [],
  // N1: v1-circle fill only, stroke on, stroke off (the log keeps its entry), stroke on again
  // (the stroke is rebuilt and a second notice arrives). Since 2026-10-25 N1 strokes at
  // width 48: at the initial width 8 the circle stroke meshes at stroke revision 6 and reports
  // `fringe-work-cap`, so N1 would no longer exercise a path that is not drawn.
  'n1.a-fill-only': [],
  'n1.b-stroke-on': ['v1-circle stroke work-limit'],
  'n1.c-stroke-off': ['v1-circle stroke work-limit'],
  'n1.d-stroke-on-again': ['v1-circle stroke work-limit', 'v1-circle stroke work-limit'],
  // N2: v1-zigzag cap butt, then round.
  'n2.a-butt': [],
  'n2.b-round': ['v1-zigzag stroke fringe-work-cap'],
  a10: [],
  a6: [],
  blur: [],
  a7: [],
  a11: [],
  a12: [],
};
// Observed identical at DPR 1 and DPR 2; the literals are kept per DPR (V1-Q7).
const EXPECTED: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [1, 2].flatMap((dpr) =>
    Object.entries(OBSERVED_NOTICES).map(([key, notices]) => [`${dpr}/${key}`, notices] as const),
  ),
);

/** Channel tolerance for probes, in 8-bit steps; functional, not a precision gate. */
const PROBE_TOLERANCE = 12;
const to8 = (value: number) => Math.round(value * 255);
const hex8 = (value: number) => to8(value).toString(16).padStart(2, '0');
const hexOf = (c: { r: number; g: number; b: number }) => `#${hex8(c.r)}${hex8(c.g)}${hex8(c.b)}`;

type Rgb = readonly [number, number, number];
type Color = { r: number; g: number; b: number };
const bg = VIZ_V1_BACKGROUND.color;
const mix = (color: Color, alpha: number): Rgb => [
  to8(alpha * color.r + (1 - alpha) * bg.r),
  to8(alpha * color.g + (1 - alpha) * bg.g),
  to8(alpha * color.b + (1 - alpha) * bg.b),
];
const solid = (color: Color) => mix(color, 1);
const backdrop = solid(bg);
const fromHex = (text: string): Color => ({
  r: Number.parseInt(text.slice(1, 3), 16) / 255,
  g: Number.parseInt(text.slice(3, 5), 16) / 255,
  b: Number.parseInt(text.slice(5, 7), 16) / 255,
});
const separation = (a: Rgb, b: Rgb) =>
  Math.max(...a.map((value, lane) => Math.abs(value - b[lane]!)));

const VIEW = VIZ_V1_VIEWS[0]!;
const SQUARE = targetById('v1-square')!;
const STAR = targetById('v1-star')!;
const ZIGZAG = targetById('v1-zigzag')!;
const CHEVRON = targetById('v1-chevron')!;
const CIRCLE = targetById('v1-circle')!;
const at = (target: { center: readonly [number, number] }, dx: number, dy: number) =>
  [target.center[0] + dx, target.center[1] + dy] as const;

type Probe = { name: string; at: readonly [number, number]; expected: Rgb };

// Geometry of the probes (world == surface at zoom 1, scene center (360, 300)).
// v1-square: a 60 x 60 square, stroke band width 10 straddling each edge. Fill-only area |x| < 25,
// stroke over fill 25 < |x| < 30, stroke only 30 < |x| < 35; every probe is >= 2.5 from a boundary.
const SQUARE_FILL_ONLY = at(SQUARE, 0, 0);
const SQUARE_STROKE_BAND = at(SQUARE, -30, 0);
const SQUARE_STROKE_OVER_FILL = at(SQUARE, 27.5, 0);
const SQUARE_STROKE_ONLY = at(SQUARE, 32.5, 0);
// v1-star: pentagram of radius 45; its center is filled under nonzero and empty under evenodd.
const STAR_CENTER = at(STAR, 0, 0);
const STAR_ARM = at(STAR, 0, -30);
// v1-zigzag: the second segment runs (-18, -22) to (14, 22). A probe at perpendicular distance 9.5
// from its midpoint lies in the width 24 band (half width 12) and outside the width 14 band
// (half width 7): 2.5 from both boundaries.
const ZIGZAG_MID = { x: -2, y: 0 };
const ZIGZAG_DIRECTION = (() => {
  const dx = 14 + 18;
  const dy = 22 + 22;
  const length = Math.hypot(dx, dy);
  return { x: dx / length, y: dy / length };
})();
const ZIGZAG_NORMAL = { x: -ZIGZAG_DIRECTION.y, y: ZIGZAG_DIRECTION.x };
const ZIGZAG_BAND_PROBE = at(
  ZIGZAG,
  ZIGZAG_MID.x + 9.5 * ZIGZAG_NORMAL.x,
  ZIGZAG_MID.y + 9.5 * ZIGZAG_NORMAL.y,
);
const ZIGZAG_CENTERLINE = at(ZIGZAG, ZIGZAG_MID.x, ZIGZAG_MID.y);
// End cap: the last segment ends at (46, -22) heading (32, -44). At width 14 (r = 7) a probe on the
// end tangent at r / 2 = 3.5 beyond the end is backdrop for butt and stroke for square and round.
const ZIGZAG_END_DIRECTION = (() => {
  const dx = 46 - 14;
  const dy = -22 - 22;
  const length = Math.hypot(dx, dy);
  return { x: dx / length, y: dy / length };
})();
const ZIGZAG_CAP_PROBE = at(
  ZIGZAG,
  46 + 3.5 * ZIGZAG_END_DIRECTION.x,
  -22 + 3.5 * ZIGZAG_END_DIRECTION.y,
);
// v1-chevron: apex (0, -30), half angle 15 degrees, width 12: the miter tip reaches 6 / sin 15
// = 23.2 above the apex and the bevel edge 1.55 above it. The switch ratio is 1 / sin 15 = 3.864.
const CHEVRON_SWITCH_RATIO = 1 / Math.sin((15 * Math.PI) / 180);
const CHEVRON_TIP_PROBE = at(CHEVRON, 0, -30 - 12);
// v1-circle: the center of the cubic circle.
const CIRCLE_CENTER = at(CIRCLE, 0, 0);
// N1's stroke width: the radius-30 circle meshes up to width 24 and ends at work-limit from 32
// at stroke revision 6 (every tolerance exponent from -6 to -2); 48 is inside that range.
const N1_STROKE_WIDTH = '48';

function sortedNotices(
  notices: ReadonlyArray<{ nodeId: string | null; paint: string | null; failureCode: string }>,
): string[] {
  return notices.map((n) => `${n.nodeId} ${n.paint} ${n.failureCode}`).sort();
}

type Controls = ReturnType<typeof controlsOf>;
function controlsOf(page: Page) {
  const radio = (group: string, name: string) =>
    page.getByRole('group', { name: group, exact: true }).getByRole('radio', { name, exact: true });
  return {
    target: (id: string) => page.getByRole('radio', { name: id, exact: true }),
    fillOn: page.getByRole('checkbox', { name: 'Fill', exact: true }),
    fillColor: page.getByLabel('Fill color', { exact: true }),
    fillAlpha: page.getByLabel('Fill alpha', { exact: true }),
    fillRule: (rule: string) => radio('Fill rule', rule),
    strokeOn: page.getByRole('checkbox', { name: 'Stroke', exact: true }),
    strokeColor: page.getByLabel('Stroke color', { exact: true }),
    strokeAlpha: page.getByLabel('Stroke alpha', { exact: true }),
    widthSlider: page.getByRole('slider', { name: 'Stroke width', exact: true }),
    widthNumber: page.getByRole('spinbutton', { name: 'Stroke width value', exact: true }),
    cap: (cap: string) => radio('Cap', cap),
    join: (join: string) => radio('Join', join),
    miterSlider: page.getByRole('slider', {
      name: 'Miter limit (applies to miter joins)',
      exact: true,
    }),
    miterNumber: page.getByRole('spinbutton', { name: 'Miter limit value', exact: true }),
    opacitySlider: page.getByRole('slider', { name: 'Opacity', exact: true }),
    opacityNumber: page.getByRole('spinbutton', { name: 'Opacity value', exact: true }),
    resetTarget: page.getByRole('button', { name: 'Reset target', exact: true }),
    resetAll: page.getByRole('button', { name: 'Reset all', exact: true }),
  };
}

/** Types into a number field and commits it with Enter. */
async function commit(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.press('Enter');
}

for (const dpr of [1, 2]) {
  test.describe(`DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test(`V-1 path appearance page at DPR ${dpr} (UNVERIFIED precision)`, async ({
      browser,
      page,
    }, info) => {
      test.setTimeout(900_000);
      const directory = path.join(runRoot, info.project.name, `dpr${dpr}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${VIZ_V1_EVIDENCE_LABEL}\n`, {
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
      const latencies: unknown[] = [];
      let wasmSha256: string | null = null;

      const settle = () => page.evaluate(() => window.__vectorStudioVizV1Appearance.settle());
      const snapshot = () => page.evaluate(() => window.__vectorStudioVizV1Appearance.snapshot());
      type Snapshot = Awaited<ReturnType<typeof snapshot>>;

      async function open(
        scenario: string,
        query = '',
      ): Promise<{ state: Snapshot; controls: Controls }> {
        // A fresh page per scenario: notices are emitted on transitions.
        await page.goto(`/viz-v1-appearance.html${query}`);
        // One earlier run found the hook undefined right after goto, with no page error logged
        // and a transient resource failure (net::ERR_NO_BUFFER_SPACE) and a 404 in the console.
        // The cause is unexplained. This bounded wait does not claim to recover from it: on a
        // timeout the run records the failure and goes on, so observations.json is still written.
        try {
          await page.waitForFunction(() => window.__vectorStudioVizV1Appearance !== undefined, {
            timeout: 60_000,
          });
        } catch {
          fail(
            'hook-not-installed',
            `${scenario}: console errors ${JSON.stringify(consoleErrors)}`,
          );
          throw new Error('the page hook was not installed within 60 s');
        }
        const capability = await page.evaluate(() => window.__vectorStudioVizV1Appearance.ready);
        if (!capability.supported) fail(scenario, `capability ${JSON.stringify(capability)}`);
        const state = await settle();
        wasmSha256 = state.wasmSha256;
        // V1-A1: both real ports, with the operation ids the literals were fixed with.
        if (state.ports?.fill.operationId !== OPERATION_IDS.fill)
          fail(scenario, `unexpected fill port ${JSON.stringify(state.ports)}`);
        if (state.ports?.stroke.operationId !== OPERATION_IDS.stroke)
          fail(scenario, `unexpected stroke port ${JSON.stringify(state.ports)}`);
        return { state, controls: controlsOf(page) };
      }

      /** Screenshot the surface, decode the probes in the page and compare. */
      async function check(scenario: string, stage: string, probes: readonly Probe[]) {
        const png = await page.locator('#viz-v1-surface').screenshot();
        write(`${scenario}-${stage}.png`, png);
        const surfacePoints = probes.map((probe) =>
          worldToSurface(VIEW, { x: probe.at[0], y: probe.at[1] }),
        );
        for (const [index, point] of surfacePoints.entries()) {
          // Probe rule: at least 2 CSS px inside the surface; edge margins are fixed by geometry.
          if (
            point.x < 2 ||
            point.y < 2 ||
            point.x > VIZ_V1_SURFACE.width - 2 ||
            point.y > VIZ_V1_SURFACE.height - 2
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
            points: surfacePoints.map((point) => [point.x, point.y] as const),
            width: VIZ_V1_SURFACE.width,
          },
        );
        const reports = probes.map((probe, index) => {
          const observed = sampled[index]!;
          const deviation = Math.max(
            ...observed.map((value, lane) => Math.abs(value - probe.expected[lane]!)),
          );
          return { ...probe, observed, deviation };
        });
        for (const report of reports) {
          if (report.deviation > PROBE_TOLERANCE)
            fail(
              scenario,
              `${stage}: probe ${report.name} at (${report.at[0].toFixed(2)}, ${report.at[1].toFixed(2)}) is ` +
                `${JSON.stringify(report.observed)}, expected ${JSON.stringify(report.expected)}`,
            );
        }
        return reports;
      }

      function separated(scenario: string, label: string, a: Rgb, b: Rgb) {
        if (separation(a, b) <= 2 * PROBE_TOLERANCE)
          fail(
            scenario,
            `${label}: candidate colors ${JSON.stringify(a)} and ${JSON.stringify(b)} are not separated`,
          );
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

      async function scenario(name: string, body: () => Promise<void>) {
        try {
          await body();
        } catch (error) {
          fail(name, `threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // -------------------------------------------------------------------------------------
      // V1-A1, V1-A2, V1-A9 N0: the initial page.
      await scenario('n0', async () => {
        const { state, controls: c } = await open('n0');
        scenarios.n0 = { revision: state.revision, draws: state.draws };
        noticeSet('n0', '', state);
        // V1-A1: the UNVERIFIED label is visible on the page and written to the directory.
        await expect(page.locator('#viz-v1-label')).toContainText('UNVERIFIED');
        if (state.revision !== 1) fail('n0', `initial revision ${state.revision}`);
        // V1-A2: every control is found by role and accessible name; initial values equal the
        // default target's initial scene values.
        const initial = SQUARE.initial;
        await expect(c.target('v1-square')).toBeChecked();
        for (const other of ['v1-star', 'v1-zigzag', 'v1-chevron', 'v1-circle'])
          await expect(c.target(other)).not.toBeChecked();
        await expect(c.fillOn).toBeChecked();
        await expect(c.fillColor).toHaveValue(hexOf(initial.fill));
        await expect(c.fillAlpha).toHaveValue(String(initial.fill.a));
        await expect(c.fillRule('nonzero')).toBeChecked();
        await expect(c.fillRule('evenodd')).not.toBeChecked();
        await expect(c.strokeOn).toBeChecked();
        await expect(c.strokeColor).toHaveValue(hexOf(initial.stroke.color));
        await expect(c.strokeAlpha).toHaveValue(String(initial.stroke.color.a));
        await expect(c.widthSlider).toHaveValue(String(initial.stroke.width));
        await expect(c.widthNumber).toHaveValue(String(initial.stroke.width));
        await expect(c.cap(initial.stroke.cap)).toBeChecked();
        await expect(c.join(initial.stroke.join)).toBeChecked();
        await expect(c.miterSlider).toHaveValue(String(initial.stroke.miterLimit));
        await expect(c.miterNumber).toHaveValue(String(initial.stroke.miterLimit));
        await expect(c.opacitySlider).toHaveValue(String(initial.opacity));
        await expect(c.opacityNumber).toHaveValue(String(initial.opacity));
        await expect(c.resetTarget).toBeVisible();
        await expect(c.resetAll).toBeVisible();
        for (const radio of ['butt', 'round', 'square']) await expect(c.cap(radio)).toBeVisible();
        for (const radio of ['miter', 'round', 'bevel']) await expect(c.join(radio)).toBeVisible();
        // The initial scene draws: fill-only and stroke probes of v1-square.
        await check('n0', 'initial', [
          { name: 'square fill', at: SQUARE_FILL_ONLY, expected: solid(initial.fill) },
          { name: 'square stroke', at: SQUARE_STROKE_BAND, expected: solid(initial.stroke.color) },
        ]);
        // V1-A12 (static part): the live region and the canvas label.
        await expect(page.locator('#viz-v1-target-status')).toHaveAttribute('aria-live', 'polite');
        await expect(page.locator('#viz-v1-surface')).toHaveAttribute('aria-label', /.+/);
      });

      // -------------------------------------------------------------------------------------
      // V1-A8 S1: fill and stroke color on v1-square.
      await scenario('s1', async () => {
        const { controls: c } = await open('s1');
        const fillA = solid(SQUARE.initial.fill);
        const fillB = solid(fromHex('#33cc4d'));
        const strokeC = solid(SQUARE.initial.stroke.color);
        const strokeD = solid(fromHex('#ffcc00'));
        separated('s1', 'fill A/B', fillA, fillB);
        separated('s1', 'stroke C/D', strokeC, strokeD);
        await check('s1', 'a-c', [
          { name: 'fill A', at: SQUARE_FILL_ONLY, expected: fillA },
          { name: 'stroke C', at: SQUARE_STROKE_BAND, expected: strokeC },
        ]);
        await c.fillColor.fill('#33cc4d');
        await settle();
        await check('s1', 'b', [
          { name: 'fill B', at: SQUARE_FILL_ONLY, expected: fillB },
          { name: 'stroke C', at: SQUARE_STROKE_BAND, expected: strokeC },
        ]);
        await c.strokeColor.fill('#ffcc00');
        const state = await settle();
        await check('s1', 'b-d', [
          { name: 'fill B', at: SQUARE_FILL_ONLY, expected: fillB },
          { name: 'stroke D', at: SQUARE_STROKE_BAND, expected: strokeD },
        ]);
        noticeSet('s1', '', state);
      });

      // V1-A8 S2: fill rule on v1-star.
      await scenario('s2', async () => {
        const { controls: c } = await open('s2', '?target=v1-star');
        await expect(c.target('v1-star')).toBeChecked();
        const fill = solid(STAR.initial.fill);
        separated('s2', 'fill/backdrop', fill, backdrop);
        await check('s2', 'nonzero', [
          { name: 'star center (nonzero)', at: STAR_CENTER, expected: fill },
          { name: 'star arm', at: STAR_ARM, expected: fill },
        ]);
        await c.fillRule('evenodd').check();
        const state = await settle();
        await check('s2', 'evenodd', [
          { name: 'star center (evenodd)', at: STAR_CENTER, expected: backdrop },
          { name: 'star arm', at: STAR_ARM, expected: fill },
        ]);
        noticeSet('s2', '', state);
      });

      // V1-A8 S3: stroke width 14 to 24 on v1-zigzag.
      await scenario('s3', async () => {
        const { controls: c } = await open('s3', '?target=v1-zigzag');
        const stroke = solid(ZIGZAG.initial.stroke.color);
        separated('s3', 'stroke/backdrop', stroke, backdrop);
        await check('s3', 'width-14', [
          { name: 'centerline', at: ZIGZAG_CENTERLINE, expected: stroke },
          { name: 'new band only', at: ZIGZAG_BAND_PROBE, expected: backdrop },
        ]);
        await commit(c.widthNumber, '24');
        const state = await settle();
        await check('s3', 'width-24', [
          { name: 'centerline', at: ZIGZAG_CENTERLINE, expected: stroke },
          { name: 'new band only', at: ZIGZAG_BAND_PROBE, expected: stroke },
        ]);
        noticeSet('s3', '', state);
      });

      // V1-A8 S4: caps on v1-zigzag (round gives fringe-work-cap and still draws).
      await scenario('s4', async () => {
        const { controls: c } = await open('s4', '?target=v1-zigzag');
        const stroke = solid(ZIGZAG.initial.stroke.color);
        await check('s4', 'butt', [
          { name: 'end tangent r/2 (butt)', at: ZIGZAG_CAP_PROBE, expected: backdrop },
        ]);
        await c.cap('round').check();
        await settle();
        await check('s4', 'round', [
          { name: 'end tangent r/2 (round)', at: ZIGZAG_CAP_PROBE, expected: stroke },
        ]);
        await c.cap('square').check();
        const state = await settle();
        await check('s4', 'square', [
          { name: 'end tangent r/2 (square)', at: ZIGZAG_CAP_PROBE, expected: stroke },
        ]);
        noticeSet('s4', '', state);
      });

      // V1-A8 S5: miter limit above and below the switch ratio on v1-chevron.
      await scenario('s5', async () => {
        const { controls: c } = await open('s5', '?target=v1-chevron');
        const stroke = solid(CHEVRON.initial.stroke.color);
        const below = (CHEVRON_SWITCH_RATIO - 0.06).toFixed(2);
        const above = (CHEVRON_SWITCH_RATIO + 0.04).toFixed(2);
        if (!(Number(below) < CHEVRON_SWITCH_RATIO && Number(above) > CHEVRON_SWITCH_RATIO))
          fail('s5', `limits ${below}, ${above} do not straddle ${CHEVRON_SWITCH_RATIO}`);
        await check('s5', 'limit-4', [
          { name: 'miter tip (limit 4)', at: CHEVRON_TIP_PROBE, expected: stroke },
        ]);
        await commit(c.miterNumber, below);
        await settle();
        await check('s5', `limit-${below}`, [
          { name: 'miter tip (below switch)', at: CHEVRON_TIP_PROBE, expected: backdrop },
        ]);
        await commit(c.miterNumber, above);
        const state = await settle();
        await check('s5', `limit-${above}`, [
          { name: 'miter tip (above switch)', at: CHEVRON_TIP_PROBE, expected: stroke },
        ]);
        noticeSet('s5', '', state);
      });

      // -------------------------------------------------------------------------------------
      // V1-A9 N1: v1-circle stroke on, off, on again.
      await scenario('n1', async () => {
        const { controls: c } = await open('n1', '?target=v1-circle');
        const fill = solid(CIRCLE.initial.fill);
        const circleNotices = (state: Snapshot) =>
          state.notices.filter((n) => n.nodeId === 'v1-circle' && n.failureCode === 'work-limit');
        await expect(page.locator('#viz-v1-target-status')).toBeVisible();
        const statusText = () => page.locator('#viz-v1-target-status').innerText();
        // Fill only: expected to mesh.
        await check('n1', 'fill-only', [
          { name: 'circle interior', at: CIRCLE_CENTER, expected: fill },
        ]);
        noticeSet('n1', 'a-fill-only', await snapshot());
        // Stroke on at width 48 (butt, round): the whole path is not drawn. Width 8 meshes at stroke
        // revision 6 (2026-10-25), so N1 sets a width that still ends at work-limit.
        await commit(c.widthNumber, N1_STROKE_WIDTH);
        await settle();
        await c.strokeOn.check();
        let state = await settle();
        await check('n1', 'stroke-on', [
          { name: 'circle interior (not drawn)', at: CIRCLE_CENTER, expected: backdrop },
        ]);
        noticeSet('n1', 'b-stroke-on', state);
        if (circleNotices(state).length !== 1)
          fail('n1', `b: ${circleNotices(state).length} v1-circle work-limit notices`);
        const entries = page.locator(
          '#viz-v1-notices li[data-node="v1-circle"][data-code="work-limit"]',
        );
        await expect(entries).toHaveCount(1);
        await expect(entries.first()).toBeVisible();
        if (!(await statusText()).includes('stroke: not drawn'))
          fail('n1', `b: status ${await statusText()}`);
        // Stroke off again: the fill draws; the log entry remains; the status drops the failure.
        await c.strokeOn.uncheck();
        state = await settle();
        await check('n1', 'stroke-off', [
          { name: 'circle interior (fill)', at: CIRCLE_CENTER, expected: fill },
        ]);
        noticeSet('n1', 'c-stroke-off', state);
        await expect(entries).toHaveCount(1);
        await expect(entries.first()).toBeVisible();
        const off = await statusText();
        if (off.includes('stroke: not drawn') || !off.includes('stroke: off'))
          fail('n1', `c: status still shows the stroke failure: ${off}`);
        // Stroke on once more: rebuilt, a second notice arrives, and the status shows not drawn.
        await c.strokeOn.check();
        state = await settle();
        await check('n1', 'stroke-on-again', [
          { name: 'circle interior (not drawn)', at: CIRCLE_CENTER, expected: backdrop },
        ]);
        noticeSet('n1', 'd-stroke-on-again', state);
        if (circleNotices(state).length !== 2)
          fail('n1', `d: ${circleNotices(state).length} v1-circle work-limit notices, expected 2`);
        await expect(entries).toHaveCount(2);
        if (!(await statusText()).includes('stroke: not drawn'))
          fail('n1', `d: status ${await statusText()}`);
        const shown = await page.evaluate(
          () =>
            Array.from(document.querySelectorAll('#viz-v1-status dt')).find(
              (term) => term.textContent === 'Path notices',
            )?.nextElementSibling?.textContent,
        );
        if (shown !== String(state.notices.length))
          fail(
            'n1',
            `d: status panel shows ${shown} notices, the hook has ${state.notices.length}`,
          );
      });

      // V1-A9 N2: v1-zigzag cap butt to round.
      await scenario('n2', async () => {
        const { controls: c } = await open('n2', '?target=v1-zigzag');
        noticeSet('n2', 'a-butt', await snapshot());
        await c.cap('round').check();
        const state = await settle();
        noticeSet('n2', 'b-round', state);
        const stroke = solid(ZIGZAG.initial.stroke.color);
        await check('n2', 'round', [
          { name: 'centerline (still drawn)', at: ZIGZAG_CENTERLINE, expected: stroke },
        ]);
        if (
          !state.notices.some(
            (n) =>
              n.nodeId === 'v1-zigzag' &&
              n.paint === 'stroke' &&
              n.failureCode === 'fringe-work-cap',
          )
        )
          fail('n2', 'no v1-zigzag stroke fringe-work-cap notice');
      });

      // -------------------------------------------------------------------------------------
      // V1-A10: opacity with both paints uses the joint draw once.
      await scenario('a10', async () => {
        const base = await open('a10');
        const baseline = sortedNotices(base.state.notices);
        const { controls: c } = base;
        await commit(c.opacityNumber, '0.5');
        const state = await settle();
        noticeSet('a10', '', state);
        if (JSON.stringify(sortedNotices(state.notices)) !== JSON.stringify(baseline))
          fail('a10', `opacity 0.5 added notices: ${JSON.stringify(sortedNotices(state.notices))}`);
        const o = 0.5;
        const fill = SQUARE.initial.fill;
        const stroke = SQUARE.initial.stroke.color;
        const single = mix(stroke, o);
        const doubleOpacity: Rgb = [
          to8(o * stroke.r + (1 - o) * (o * fill.r + (1 - o) * bg.r)),
          to8(o * stroke.g + (1 - o) * (o * fill.g + (1 - o) * bg.g)),
          to8(o * stroke.b + (1 - o) * (o * fill.b + (1 - o) * bg.b)),
        ];
        separated('a10', 'single/double opacity', single, doubleOpacity);
        await check('a10', 'half', [
          { name: 'fill only', at: SQUARE_FILL_ONLY, expected: mix(fill, o) },
          { name: 'stroke only', at: SQUARE_STROKE_ONLY, expected: single },
          { name: 'stroke over fill', at: SQUARE_STROKE_OVER_FILL, expected: single },
        ]);
      });

      // -------------------------------------------------------------------------------------
      // V1-A7: mesh work follows the paint keys. V1-A13 latencies come from the same edits.
      await scenario('a7', async () => {
        const { controls: c } = await open('a7');
        type Rule = 'zero' | 'atLeast1' | 'record';
        const steps: Array<{
          name: string;
          act: () => Promise<unknown>;
          fill: Rule;
          stroke: Rule;
        }> = [
          {
            name: 'fill color',
            act: () => c.fillColor.fill('#33cc4d'),
            fill: 'zero',
            stroke: 'zero',
          },
          {
            name: 'stroke color',
            act: () => c.strokeColor.fill('#ffcc00'),
            fill: 'zero',
            stroke: 'zero',
          },
          {
            name: 'opacity 0.5',
            act: () => commit(c.opacityNumber, '0.5'),
            fill: 'zero',
            stroke: 'zero',
          },
          { name: 'fill off', act: () => c.fillOn.uncheck(), fill: 'zero', stroke: 'zero' },
          { name: 'fill on', act: () => c.fillOn.check(), fill: 'zero', stroke: 'zero' },
          {
            name: 'fill rule evenodd',
            act: () => c.fillRule('evenodd').check(),
            fill: 'atLeast1',
            stroke: 'zero',
          },
          {
            name: 'width 12',
            act: () => commit(c.widthNumber, '12'),
            fill: 'zero',
            stroke: 'atLeast1',
          },
          {
            name: 'miter limit 3',
            act: () => commit(c.miterNumber, '3'),
            fill: 'zero',
            stroke: 'atLeast1',
          },
          {
            name: 'cap square',
            act: () => c.cap('square').check(),
            fill: 'zero',
            stroke: 'atLeast1',
          },
          {
            name: 'join bevel',
            act: () => c.join('bevel').check(),
            fill: 'zero',
            stroke: 'atLeast1',
          },
          { name: 'width 0', act: () => commit(c.widthNumber, '0'), fill: 'zero', stroke: 'zero' },
          {
            name: 'width 5 (from 0)',
            act: () => commit(c.widthNumber, '5'),
            fill: 'zero',
            stroke: 'record',
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
              fail('a7', `${step.name}: ${label} delta ${delta}, expected 0`);
            if (rule === 'atLeast1' && delta < 1)
              fail('a7', `${step.name}: ${label} delta ${delta}, expected >= 1`);
          };
          verdict(step.fill, fillDelta, 'fill');
          verdict(step.stroke, strokeDelta, 'stroke');
          if (now.revision !== previous.revision + 1)
            fail('a7', `${step.name}: revision ${previous.revision} to ${now.revision}`);
          previous = now;
        }
        scenarios.a7 = deltas;
        // V1-A13: edit latency, a FUNCTIONAL observation with no performance claim or threshold.
        const final = await snapshot();
        const measured = final.latencies.filter((latency) => latency.toFrameMs !== null);
        latencies.push(...final.latencies);
        if (measured.length === 0) fail('a7', 'V1-A13: no edit latency was observed');
        for (const latency of final.latencies) {
          for (const value of [latency.toFrameMs, latency.toSettleMs]) {
            if (value !== null && !(Number.isFinite(value) && value >= 0))
              fail(
                'a7',
                `V1-A13: latency ${JSON.stringify(latency)} is not finite and non-negative`,
              );
          }
        }
        noticeSet('a7', '', final);
      });

      // -------------------------------------------------------------------------------------
      // V1-A6 (GPU part): an invalid width is not applied.
      await scenario('a6', async () => {
        const { controls: c } = await open('a6');
        const before = (await snapshot()).revision;
        await commit(c.widthNumber, '-1');
        await page.waitForTimeout(100);
        const state = await settle();
        if (state.revision !== before)
          fail('a6', `revision ${before} to ${state.revision} after width -1`);
        await expect(c.widthNumber).toHaveAttribute('aria-invalid', 'true');
        const message = page.locator('#viz-v1-width-message');
        await expect(message).toBeVisible();
        await expect(message).not.toBeEmpty();
        await expect(c.widthNumber).toHaveAttribute('aria-describedby', 'viz-v1-width-message');
        // Out-of-range opacity and an empty width are refused the same way.
        await commit(c.opacityNumber, '1.01');
        await c.widthNumber.fill('');
        await c.widthNumber.press('Enter');
        const after = await settle();
        if (after.revision !== before)
          fail('a6', `revision ${before} to ${after.revision} after invalid values`);
        await expect(c.opacityNumber).toHaveAttribute('aria-invalid', 'true');
        // A valid value clears the flag and applies.
        await commit(c.widthNumber, '12');
        const valid = await settle();
        if (valid.revision !== before + 1)
          fail('a6', `valid width gave revision ${valid.revision}, expected ${before + 1}`);
        await expect(c.widthNumber).not.toHaveAttribute('aria-invalid', 'true');
        noticeSet('a6', '', valid);
      });

      // V1-A5 on the page: a blur commits a number field, and the miter slider commits on change.
      await scenario('blur', async () => {
        const { controls: c } = await open('blur', '?target=v1-chevron');
        const start = (await snapshot()).revision;
        await c.widthNumber.fill('16');
        // No commit yet: typing alone changes nothing.
        let state = await settle();
        if (state.revision !== start)
          fail('blur', `typing alone moved the revision to ${state.revision}`);
        await c.widthNumber.blur();
        state = await settle();
        const width = (state.states as Record<string, { stroke: { width: number } }>)['v1-chevron']!
          .stroke.width;
        if (width !== 16 || state.revision !== start + 1)
          fail('blur', `blur: width ${width}, revision ${start} to ${state.revision}`);
        await page.evaluate(() => {
          const slider = document.querySelector<HTMLInputElement>('#viz-v1-miter-slider')!;
          slider.value = '3.5';
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        });
        state = await settle();
        if (state.revision !== start + 1)
          fail('blur', `miter input moved the revision to ${state.revision}`);
        await page.evaluate(() => {
          document
            .querySelector<HTMLInputElement>('#viz-v1-miter-slider')!
            .dispatchEvent(new Event('change', { bubbles: true }));
        });
        state = await settle();
        const limit = (state.states as Record<string, { stroke: { miterLimit: number } }>)[
          'v1-chevron'
        ]!.stroke.miterLimit;
        if (limit !== 3.5 || state.revision !== start + 2)
          fail('blur', `miter change: limit ${limit}, revision ${start} to ${state.revision}`);
        noticeSet('blur', '', state);
      });

      // V1-A11: coalescing and the commit rule.
      await scenario('a11', async () => {
        await open('a11', '?target=v1-zigzag');
        const startRevision = (await snapshot()).revision;
        // 20 input events on the opacity slider in one task: exactly one apply, the last value.
        await page.evaluate(() => {
          const slider = document.querySelector<HTMLInputElement>('#viz-v1-opacity-slider')!;
          for (let step = 0; step < 20; step += 1) {
            slider.value = String(0.9 - step * 0.01);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        let state = await settle();
        if (state.revision !== startRevision + 1)
          fail('a11', `opacity: revision ${startRevision} to ${state.revision}, expected +1`);
        const opacity = (state.states as Record<string, { opacity: number }>)['v1-zigzag']!.opacity;
        if (Math.abs(opacity - 0.71) > 1e-9)
          fail('a11', `opacity ${opacity}, expected the last value 0.71`);
        // 20 input events on the width slider in one task: no apply; the change event: exactly one.
        const widthRevision = state.revision;
        await page.evaluate(() => {
          const slider = document.querySelector<HTMLInputElement>('#viz-v1-width-slider')!;
          for (let step = 0; step < 20; step += 1) {
            slider.value = String(15 + step * 0.5);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        state = await settle();
        if (state.revision !== widthRevision)
          fail('a11', `width input: revision ${widthRevision} to ${state.revision}, expected +0`);
        await check('a11', 'before-change', [
          { name: 'new band only (before change)', at: ZIGZAG_BAND_PROBE, expected: backdrop },
        ]);
        await page.evaluate(() => {
          document
            .querySelector<HTMLInputElement>('#viz-v1-width-slider')!
            .dispatchEvent(new Event('change', { bubbles: true }));
        });
        state = await settle();
        if (state.revision !== widthRevision + 1)
          fail('a11', `width change: revision ${widthRevision} to ${state.revision}, expected +1`);
        const width = (state.states as Record<string, { stroke: { width: number } }>)['v1-zigzag']!
          .stroke.width;
        if (width !== 24.5) fail('a11', `width ${width}, expected the last value 24.5`);
        await check('a11', 'after-change', [
          {
            name: 'new band only (after change)',
            at: ZIGZAG_BAND_PROBE,
            expected: mix(ZIGZAG.initial.stroke.color, 0.71),
          },
        ]);
        noticeSet('a11', '', state);
      });

      // V1-A12: keyboard and accessibility.
      await scenario('a12', async () => {
        const { controls: c } = await open('a12');
        const focusFirst = () => c.target('v1-square').focus();
        const tabTo = async (id: string) => {
          await focusFirst();
          for (let tabs = 0; tabs < 80; tabs += 1) {
            if (await page.evaluate((target) => document.activeElement?.id === target, id)) return;
            await page.keyboard.press('Tab');
          }
          throw new Error(`Tab never reached #${id}`);
        };
        const outlineStyle = () =>
          page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
        // Opacity slider: ArrowLeft five times lowers the opacity and advances the revision.
        await tabTo('viz-v1-opacity-slider');
        if ((await outlineStyle()) === 'none')
          fail('a12', 'the focused opacity slider has no outline');
        const startRevision = (await snapshot()).revision;
        for (let key = 0; key < 5; key += 1) await page.keyboard.press('ArrowLeft');
        let state = await settle();
        const opacity = (state.states as Record<string, { opacity: number }>)['v1-square']!.opacity;
        if (!(opacity < 1 && Math.abs(opacity - 0.95) < 1e-9))
          fail('a12', `opacity ${opacity}, expected 0.95`);
        if (state.revision <= startRevision)
          fail('a12', `opacity: revision ${startRevision} to ${state.revision}`);
        // Width slider: ArrowRight once commits one step (this assumes that Chromium fires change
        // on each keyboard step of a range input; a failure here is browser behavior first).
        await tabTo('viz-v1-width-slider');
        if ((await outlineStyle()) === 'none')
          fail('a12', 'the focused width slider has no outline');
        const widthRevision = (await snapshot()).revision;
        await page.keyboard.press('ArrowRight');
        state = await settle();
        const width = (state.states as Record<string, { stroke: { width: number } }>)['v1-square']!
          .stroke.width;
        if (width !== 10.5) fail('a12', `width ${width}, expected 10.5 after one ArrowRight`);
        if (state.revision !== widthRevision + 1)
          fail(
            'a12',
            `width key: revision ${widthRevision} to ${state.revision}, expected +1 (does this Chromium fire change per keyboard step?)`,
          );
        // Typing a width and pressing Enter commits it.
        await tabTo('viz-v1-width-number');
        await page.keyboard.press('Control+A');
        await page.keyboard.type('18');
        await page.keyboard.press('Enter');
        state = await settle();
        const typed = (state.states as Record<string, { stroke: { width: number } }>)['v1-square']!
          .stroke.width;
        if (typed !== 18) fail('a12', `typed width ${typed}, expected 18`);
        await expect(page.locator('#viz-v1-target-status')).toHaveAttribute('aria-live', 'polite');
        await expect(page.locator('#viz-v1-surface')).toHaveAttribute('aria-label', /.+/);
        await expect(page.getByRole('group', { name: 'Edit target', exact: true })).toBeVisible();
        await expect(page.getByRole('group', { name: 'Fill', exact: true })).toBeVisible();
        await expect(page.getByRole('group', { name: 'Stroke', exact: true })).toBeVisible();
        await expect(page.getByRole('group', { name: 'Opacity', exact: true })).toBeVisible();
        noticeSet('a12', '', state);
      });

      if (pageErrors.length > 0) fail('page', `page errors: ${pageErrors.join('; ')}`);
      write(
        'observations.json',
        `${JSON.stringify(
          {
            label: VIZ_V1_EVIDENCE_LABEL,
            latencyLabel:
              'FUNCTIONAL observation; no performance claim; no threshold (V1-A13). Milliseconds from the control event to the first frame submitted after the change, and to the last frame before the page settled.',
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
