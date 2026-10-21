import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { P3B2StrokesApi } from '../../apps/playground/src/p3-b2-strokes.js';
import {
  B2_BACKGROUND,
  B2_EVIDENCE_LABEL,
  B2_PATHS,
  B2_SURFACE,
  B2_VIEWS,
  worldToSurface,
  type B2View,
} from '../../apps/playground/src/p3-b2-strokes-scene.js';
import { p1Source } from '../support/p1-evidence.js';

declare global {
  interface Window {
    __vectorStudioP3B2Strokes: P3B2StrokesApi;
  }
}

// B2 stroke contract, unit ST-U8: headed screenshots of the playground stroke page with the real
// geometry-wasm fill-mesh and stroke-mesh ports, in Chrome and Edge. Functional evidence only:
// precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and
// no Q4 coverage threshold is claimed. The gates are what the contract requires of the page: it
// renders through both real ports, no page error and no error diagnostic occur, the D8-interim
// notices of each view are exactly the expected set (work-limit is the open ST-U9 decision, and
// composition-unsupported is the open ST-U7 decision; both are shown, never hidden), the mesh
// draw count equals the expected count, and a few probes far from every edge show the paint
// each path implies. Pixels near an edge are captured, not gated. Console errors are recorded,
// not gated (one 404 for the favicon is expected).
//
// Known defect, gated as a tripwire: `join-round` (a 90-degree round join) is
// `unsupported-geometry` (`Rounded(TopologyAmbiguous)`), because its join disk has a vertex 1 ulp
// away from the sweep's offset point. It is tracked as follow-up ST-U3c in the plan; its fix
// re-baselines every expectation that names `join-round`.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.P3_B2_STROKES_OUTPUT_DIR ?? 'artifacts/p3-b2-strokes',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

/** Views per device pixel ratio: zoom 0.01, 1 and 64 at DPR 1; the contract's DPR 2 and 3 too. */
const DPR_VIEWS: Readonly<Record<number, readonly string[]>> = {
  1: B2_VIEWS.map((view) => view.id),
  2: ['overview-zoom-1', 'zoom-0.01', 'zoom-64-extreme-miter-tip'],
  3: ['overview-zoom-1', 'zoom-0.01', 'zoom-64-extreme-miter-tip'],
};

type Expectation = Readonly<{
  /** Sorted `nodeId paint failureCode` of every D8-interim notice. */
  notices: readonly string[];
  /** Mesh draws of the last submitted packet. */
  meshDraws: number;
}>;

/**
 * Observed literals, fixed at the first headed run (2026-10-21, ST-U8) and identical in Chrome and
 * Edge. They are current-kernel observations (revision 2, production limits): a limit raise or
 * ST-U9's fast rung may re-baseline them, and so does the ST-U3c fix of the `join-round` defect.
 * Keyed `dpr/view`.
 */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  '1/overview-zoom-1': {
    notices: [
      'both-half null composition-unsupported',
      'cap-round stroke fringe-work-cap',
      'cusp-f16-large stroke work-limit',
      'cusp-f16p stroke fringe-work-cap',
      'fill-stroke-circle stroke work-limit',
      'join-round stroke unsupported-geometry',
      'wide-cubic stroke work-limit',
    ],
    meshDraws: 16,
  },
  '1/zoom-0.01': {
    notices: ['both-half null composition-unsupported', 'join-round stroke unsupported-geometry'],
    meshDraws: 20,
  },
  '1/zoom-0.25': {
    notices: [
      'both-half null composition-unsupported',
      'cusp-f16-large stroke work-limit',
      'fill-stroke-circle stroke fringe-work-cap',
      'join-round stroke unsupported-geometry',
      'wide-cubic stroke work-limit',
    ],
    meshDraws: 18,
  },
  '1/zoom-2-cusp': {
    notices: [
      'both-half null composition-unsupported',
      'cusp-f16p stroke fringe-work-cap',
      'fill-stroke-circle stroke work-limit',
      'wide-cubic stroke work-limit',
    ],
    meshDraws: 6,
  },
  '1/zoom-4-joins': {
    notices: ['cap-round stroke fringe-work-cap', 'join-round stroke unsupported-geometry'],
    meshDraws: 4,
  },
  '1/zoom-64-cusp': {
    notices: ['cusp-f16p stroke work-limit'],
    meshDraws: 0,
  },
  '1/zoom-64-extreme-miter-tip': {
    notices: [],
    meshDraws: 1,
  },
  '1/zoom-64-thin': {
    notices: [],
    meshDraws: 2,
  },
  '2/overview-zoom-1': {
    notices: [
      'both-half null composition-unsupported',
      'cap-round stroke fringe-work-cap',
      'cusp-f16-large stroke work-limit',
      'cusp-f16p stroke fringe-work-cap',
      'fill-stroke-circle stroke work-limit',
      'join-round stroke unsupported-geometry',
      'wide-cubic stroke work-limit',
    ],
    meshDraws: 16,
  },
  '2/zoom-0.01': {
    notices: [
      'both-half null composition-unsupported',
      'join-round stroke unsupported-geometry',
      'wide-cubic stroke fringe-work-cap',
    ],
    meshDraws: 20,
  },
  '2/zoom-64-extreme-miter-tip': {
    notices: [],
    meshDraws: 1,
  },
  '3/overview-zoom-1': {
    notices: [
      'both-half null composition-unsupported',
      'cap-round stroke fringe-work-cap',
      'cusp-f16-large stroke work-limit',
      'cusp-f16p stroke work-limit',
      'cusp-shared-a stroke fringe-work-cap',
      'fill-stroke-circle stroke work-limit',
      'join-round stroke unsupported-geometry',
      'thin-one-px stroke fringe-work-cap',
      'wide-cubic stroke work-limit',
    ],
    meshDraws: 15,
  },
  '3/zoom-0.01': {
    notices: [
      'both-half null composition-unsupported',
      'join-round stroke unsupported-geometry',
      'wide-cubic stroke fringe-work-cap',
    ],
    meshDraws: 20,
  },
  '3/zoom-64-extreme-miter-tip': {
    notices: [],
    meshDraws: 1,
  },
};

/** Channel tolerance for probes, in 8-bit steps; functional, not a precision gate. */
const PROBE_TOLERANCE = 12;
const PROBE_MARGIN = 4;
const to8 = (value: number) => Math.round(value * 255);

function expectedColor(
  kind: 'fill' | 'stroke' | 'background' | 'stroke-half',
  pathIndex: number,
): readonly number[] {
  const background = B2_BACKGROUND.color;
  const spec = B2_PATHS[pathIndex]!;
  const mix = (color: { r: number; g: number; b: number }, alpha: number) => [
    to8(alpha * color.r + (1 - alpha) * background.r),
    to8(alpha * color.g + (1 - alpha) * background.g),
    to8(alpha * color.b + (1 - alpha) * background.b),
  ];
  if (kind === 'background') return mix(background, 1);
  if (kind === 'stroke') return mix(spec.stroke!.color, 1);
  if (kind === 'stroke-half') return mix(spec.stroke!.color, spec.opacity);
  return mix(spec.fill!, spec.opacity);
}

for (const dpr of [1, 2, 3]) {
  test.describe(`DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test(`P3 B2 stroke page screenshots at DPR ${dpr} (UNVERIFIED precision)`, async ({
      browser,
      page,
    }, info) => {
      test.setTimeout(600_000);
      const directory = path.join(runRoot, info.project.name, `dpr${dpr}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${B2_EVIDENCE_LABEL}\n`, {
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
      await page.setViewportSize({ width: 1200, height: 760 });

      const failures: string[] = [];
      const observations: unknown[] = [];
      let wasmSha256: string | null = null;
      for (const id of DPR_VIEWS[dpr]!) {
        const view: B2View = B2_VIEWS.find((candidate) => candidate.id === id)!;
        // A fresh page per view: notices are emitted on transitions, so a view's notice set is
        // only absolute when nothing was drawn before it.
        await page.goto(`/p3-b2-strokes.html?view=${id}`);
        const capability = await page.evaluate(() => window.__vectorStudioP3B2Strokes.ready);
        expect(capability.supported, JSON.stringify(capability)).toBe(true);
        const state = await page.evaluate(() => window.__vectorStudioP3B2Strokes.settle());
        wasmSha256 = state.wasmSha256;
        const png = await page.locator('#p3-b2-surface').screenshot();
        write(`${id}.png`, png);

        const interim = state.diagnostics.filter(
          (event) => event.code === 'render.path-mesh-interim-failure',
        );
        const notices = interim
          .map((event) => {
            const context = event.context as {
              nodeId: string | null;
              paint: string | null;
              failureCode: string;
            };
            return `${context.nodeId} ${context.paint} ${context.failureCode}`;
          })
          .sort();
        const errors = state.diagnostics.filter((event) => event.severity === 'error');
        const key = `${dpr}/${id}`;
        const expected = EXPECTED[key];
        if (errors.length > 0)
          failures.push(`${key}: ${errors.length} error diagnostics: ${JSON.stringify(errors)}`);
        if (expected === undefined) failures.push(`${key}: no expectation`);
        else {
          if (JSON.stringify(notices) !== JSON.stringify(expected.notices))
            failures.push(
              `${key}: notices ${JSON.stringify(notices)}, expected ${JSON.stringify(expected.notices)}`,
            );
          if (state.draws.meshDraws !== expected.meshDraws)
            failures.push(
              `${key}: ${state.draws.meshDraws} mesh draws, expected ${expected.meshDraws}`,
            );
        }
        if (state.ports?.fill.operationId !== 'geometry-wasm/fill-v0+r2')
          failures.push(`${key}: unexpected fill port ${JSON.stringify(state.ports)}`);
        if (state.ports?.stroke.operationId !== 'geometry-wasm/stroke-v0+r2')
          failures.push(`${key}: unexpected stroke port ${JSON.stringify(state.ports)}`);

        // Probes, far from every edge, in the zoom 1 overview only (decoded in the page).
        const probes =
          id === 'overview-zoom-1'
            ? B2_PATHS.flatMap((spec, pathIndex) =>
                spec.probes.map(([x, y, kind]) => {
                  const surface = worldToSurface(view, { x, y });
                  return { pathId: spec.id, kind, x: surface.x, y: surface.y, pathIndex };
                }),
              ).filter(
                (probe) =>
                  probe.x >= PROBE_MARGIN &&
                  probe.y >= PROBE_MARGIN &&
                  probe.x < B2_SURFACE.width - PROBE_MARGIN &&
                  probe.y < B2_SURFACE.height - PROBE_MARGIN,
              )
            : [];
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
            points: probes.map((probe) => [probe.x, probe.y] as const),
            width: B2_SURFACE.width,
          },
        );
        const probeReports = probes.map((probe, index) => {
          const observed = sampled[index]!;
          const expectedRgb = expectedColor(probe.kind, probe.pathIndex);
          const deviation = Math.max(
            ...observed.map((value, lane) => Math.abs(value - expectedRgb[lane]!)),
          );
          return { ...probe, observed, expected: expectedRgb, deviation };
        });
        if (id === 'overview-zoom-1' && probes.length !== 5)
          failures.push(`${key}: ${probes.length} probes in bounds, expected 5`);
        for (const report of probeReports) {
          if (report.deviation > PROBE_TOLERANCE)
            failures.push(
              `${key}: ${report.pathId} ${report.kind} probe at (${report.x}, ${report.y}) is ` +
                `${JSON.stringify(report.observed)}, expected ${JSON.stringify(report.expected)}`,
            );
        }
        observations.push({
          dpr,
          view,
          notices,
          meshDraws: state.draws.meshDraws,
          analyticDraws: state.draws.analyticDraws,
          meshTriangles: state.draws.meshTriangles,
          framesSubmitted: state.statistics.framesSubmitted,
          pathMesh: state.pathMesh,
          errorDiagnostics: errors.length,
          probes: probeReports,
        });
        await page.evaluate(() => window.__vectorStudioP3B2Strokes.dispose());
      }
      if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
      write(
        'observations.json',
        `${JSON.stringify(
          {
            label: B2_EVIDENCE_LABEL,
            browser: { project: info.project.name, version: browser.version() },
            host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model },
            source: p1Source(),
            wasmSha256,
            deviceScaleFactor: dpr,
            probeTolerance: PROBE_TOLERANCE,
            observations,
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
