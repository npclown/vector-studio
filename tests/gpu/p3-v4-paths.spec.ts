import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { P3V4PathsApi } from '../../apps/playground/src/p3-v4-paths.js';
import {
  SCENE_CENTER,
  V4_BACKGROUND,
  V4_EVIDENCE_LABEL,
  V4_PATHS,
  V4_SURFACE,
  rotationTransform,
  viewAt,
  worldToSurface,
  type V4View,
} from '../../apps/playground/src/p3-v4-paths-scene.js';
import { p1Source } from '../support/p1-evidence.js';

declare global {
  interface Window {
    __vectorStudioP3V4Paths: P3V4PathsApi;
  }
}

// P3 D8 checkpoint V4: headed screenshots of the playground path page with the real
// geometry-wasm fill-mesh port, in Chrome and Edge. Functional evidence only: precision is
// UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4
// coverage threshold is claimed. The gates are functional: the page renders through the real
// port, no error diagnostic and no path notice occur in the gated views, and interior
// probes (far from every edge) show the fill or the hole each fill rule implies.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.P3_V4_PATHS_OUTPUT_DIR ?? 'artifacts/p3-v4-paths',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

/** A world point after the container rotation, the camera space a view focuses in. */
function rotated(point: Readonly<{ x: number; y: number }>, degrees: number) {
  const [a, b, c, d, e, f] = rotationTransform(degrees);
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

/** Gated views: every path meshes with a fringe and no notice (zoom * DPR <= 2, far inside the B1 caps). */
const GATED_VIEWS: readonly V4View[] = [
  viewAt('overview', SCENE_CENTER, 1, 0),
  viewAt('rotate-30', SCENE_CENTER, 1, 30),
  viewAt('zoom-0.75-rotate-minus-60', SCENE_CENTER, 0.75, -60),
  viewAt('zoom-2-pan-holes', { x: 350, y: 120 }, 2, 0),
  viewAt('zoom-2-pan-stars-rotate-45', rotated({ x: 190, y: 320 }, 45), 2, 45),
  viewAt('pan-rotate-minus-15', { x: 300, y: 260 }, 1, -15),
];
/** Observed, not gated: a zoom-3 view. After B1 the paths mesh with no notice; any notice is recorded. */
const OBSERVED_VIEW = viewAt('zoom-3-beyond-kernel-caps', { x: 350, y: 120 }, 3, 0);

/** Channel tolerance for interior probes, in 8-bit steps; functional, not a precision gate. */
const PROBE_TOLERANCE = 12;
/** Probes closer than this to the surface edge (CSS px) are skipped. */
const PROBE_MARGIN = 4;

const to8 = (value: number) => Math.round(value * 255);

function expectedColor(probe: 'fill' | 'hole', pathIndex: number): readonly number[] {
  const background = V4_BACKGROUND.color;
  if (probe === 'hole') return [to8(background.r), to8(background.g), to8(background.b)];
  const { color, opacity } = V4_PATHS[pathIndex]!;
  return [
    to8(opacity * color.r + (1 - opacity) * background.r),
    to8(opacity * color.g + (1 - opacity) * background.g),
    to8(opacity * color.b + (1 - opacity) * background.b),
  ];
}

test('P3 V4 path page screenshots (UNVERIFIED precision)', async ({ browser, page }, info) => {
  test.setTimeout(300_000);
  const directory = path.join(runRoot, info.project.name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${V4_EVIDENCE_LABEL}\n`, { flag: 'wx' });
  const write = (name: string, data: string | Uint8Array) =>
    writeFileSync(path.join(directory, name), data, { flag: 'wx' });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto('/p3-v4-paths.html');
  const capability = await page.evaluate(() => window.__vectorStudioP3V4Paths.ready);
  expect(capability.supported, JSON.stringify(capability)).toBe(true);
  const canvas = page.locator('#p3-v4-surface');

  const failures: string[] = [];
  const observations: unknown[] = [];
  for (const view of [...GATED_VIEWS, OBSERVED_VIEW]) {
    const gated = view !== OBSERVED_VIEW;
    const state = await page.evaluate((next) => window.__vectorStudioP3V4Paths.show(next), view);
    const png = await canvas.screenshot();
    write(`${view.id}.png`, png);
    const interim = state.diagnostics.filter((event) => event.code === 'render.path-mesh-failure');
    const errors = state.diagnostics.filter((event) => event.severity === 'error');
    // Interior probes, decoded from the headed screenshot in the page.
    const probes = V4_PATHS.flatMap((spec, pathIndex) =>
      spec.probes.map(([x, y, kind]) => {
        const surface = worldToSurface(view, { x, y });
        return {
          pathId: spec.id,
          kind,
          x: Math.round(surface.x),
          y: Math.round(surface.y),
          pathIndex,
        };
      }),
    ).filter(
      (probe) =>
        probe.x >= PROBE_MARGIN &&
        probe.y >= PROBE_MARGIN &&
        probe.x < V4_SURFACE.width - PROBE_MARGIN &&
        probe.y < V4_SURFACE.height - PROBE_MARGIN,
    );
    const sampled = await page.evaluate(
      async ({ base64, points }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const scratch = document.createElement('canvas');
        scratch.width = image.naturalWidth;
        scratch.height = image.naturalHeight;
        const context = scratch.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const scale = image.naturalWidth / 720;
        return points.map(([x, y]) =>
          Array.from(
            context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data,
          ).slice(0, 3),
        );
      },
      {
        base64: png.toString('base64'),
        points: probes.map((probe) => [probe.x, probe.y] as const),
      },
    );
    const probeReports = probes.map((probe, index) => {
      const observed = sampled[index]!;
      const expected = expectedColor(probe.kind, probe.pathIndex);
      const deviation = Math.max(
        ...observed.map((value, lane) => Math.abs(value - expected[lane]!)),
      );
      return { ...probe, observed, expected, deviation };
    });
    if (gated) {
      if (errors.length > 0) failures.push(`${view.id}: ${errors.length} error diagnostics`);
      if (interim.length > 0)
        failures.push(`${view.id}: ${interim.length} path notices: ${JSON.stringify(interim)}`);
      if (probeReports.length === 0) failures.push(`${view.id}: no probe is on the surface`);
      for (const report of probeReports) {
        if (report.deviation > PROBE_TOLERANCE)
          failures.push(
            `${view.id}: ${report.pathId} ${report.kind} probe at (${report.x}, ${report.y}) is ` +
              `${JSON.stringify(report.observed)}, expected ${JSON.stringify(report.expected)}`,
          );
      }
    }
    observations.push({
      view,
      gated,
      pathMesh: state.pathMesh,
      framesSubmitted: state.statistics.framesSubmitted,
      interimNotices: interim.map((event) => event.context ?? null),
      errorDiagnostics: errors.length,
      probes: probeReports,
    });
  }
  const final = await page.evaluate(() => window.__vectorStudioP3V4Paths.snapshot());
  // The zoom-3 view is observed, not gated: after B1 no notice is expected, and any one is recorded.
  const observedNotices = final.diagnostics.filter(
    (event) => event.code === 'render.path-mesh-failure',
  );
  if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (final.port?.operationId !== 'geometry-wasm/fill-v0+r2')
    failures.push(`unexpected port ${JSON.stringify(final.port)}`);
  write(
    'observations.json',
    `${JSON.stringify(
      {
        label: V4_EVIDENCE_LABEL,
        browser: { project: info.project.name, version: browser.version() },
        host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model },
        source: p1Source(),
        port: final.port,
        wasmSha256: final.wasmSha256,
        devicePixelRatio: final.devicePixelRatio,
        probeTolerance: PROBE_TOLERANCE,
        observations,
        observedViewNotices: observedNotices.map((event) => event.context ?? null),
        consoleErrors,
        pageErrors,
        failures,
      },
      null,
      2,
    )}\n`,
  );
  await page.evaluate(() => window.__vectorStudioP3V4Paths.dispose());
  expect(failures).toEqual([]);
});
