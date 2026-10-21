import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import type { P3V3MeshFixtureApi } from '../../apps/playground/src/p3-v3-mesh.js';
import { p1Source } from '../support/p1-evidence.js';
import {
  JOINT_CAMERA,
  JOINT_VIEWS,
  ST_U7_EVIDENCE_LABEL,
  excludedBand,
  inspectStA11,
  inspectStA16,
  jointMeshTable,
  jointSnapshot,
  layoutFrames,
  type SceneRequest,
  type St16Report,
} from '../support/st-u7-joint-gpu.js';

declare global {
  interface Window {
    __vectorStudioP3V3Mesh: P3V3MeshFixtureApi;
  }
}

// P3 B2 ST-U7 addendum, unit ST-U7d: headed GPU joint-coverage fixtures, labelled UNVERIFIED.
// The V3 smoke fixture page runs in its `?joint=1` mode with static test-double fill and stroke
// ports (no WASM) and the test's hand-made meshes. ST-A11: the approved example at opacity 0.5
// and the opaque-stroke node at 0.25 match the single-opacity composite at interior pixel
// centers within 2/255 and differ from the double-opacity value by more than 20/255; the
// half-opacity path over an opaque primitive matches at its overlap center. ST-A16: each
// fixture rendered at o in {0.5, 0.25} equals o times its o = 1 rendering within 2/255 in every
// RGB channel, under four views, outside the excluded band, which is reported. ST-A17: after an
// injected device loss the probed pixels equal the pre-loss capture exactly with zero new port
// calls and zero overlay builds. Seeded defects ST7-D1, ST7-D2, ST7-D8 and ST7-D10 must fail
// their checks. Precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04
// evidence; no Q4 coverage threshold is claimed and no A01-A08 criterion is closed.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.P3_ST_U7_JOINT_OUTPUT_DIR ?? 'artifacts/p3-st-u7-joint',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

type Frame = Awaited<ReturnType<P3V3MeshFixtureApi['render']>>;

async function openPage(page: Page, query: string, pageErrors: string[]) {
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`/p3-v3-mesh.html?${query}`);
  const capability = await page.evaluate(() => window.__vectorStudioP3V3Mesh.ready);
  expect(capability.supported, JSON.stringify(capability)).toBe(true);
  await page.evaluate(
    (table) => window.__vectorStudioP3V3Mesh.setStaticMeshes(table),
    jointMeshTable(),
  );
  let revision = 1;
  const render = (request: SceneRequest, dpr: number): Promise<Frame> =>
    page.evaluate(
      ({ snapshot, camera, dpr }) => window.__vectorStudioP3V3Mesh.render(snapshot, camera, dpr),
      { snapshot: jointSnapshot(request, revision++), camera: JOINT_CAMERA, dpr },
    );
  return { capability, render };
}

const pixelsOf = (frame: Frame) => new Uint8Array(Buffer.from(frame.rgbaBase64, 'base64'));
const pngOf = (frame: Frame) => Buffer.from(frame.png.split(',')[1]!, 'base64');

/** ST-A16 views in render order; the identity view is last, so its meshes are the most recent. */
const VIEW_ORDER = ['scale-3x0.5', 'rotate-30', 'reflect', 'identity'];
const OPACITIES = [0.5, 0.25] as const;

for (const samples of [1, 4] as const) {
  test(`P3 ST-U7 joint fixtures samples${samples} (UNVERIFIED precision)`, async ({
    browser,
    page,
  }, info) => {
    test.setTimeout(900_000);
    const directory = path.join(runRoot, info.project.name, `samples${samples}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${ST_U7_EVIDENCE_LABEL}\n`, {
      flag: 'wx',
    });
    const write = (name: string, data: string | Uint8Array) =>
      writeFileSync(path.join(directory, name), data, { flag: 'wx' });
    const source = p1Source();
    const pageErrors: string[] = [];
    const { capability, render } = await openPage(page, `samples=${samples}&joint=1`, pageErrors);

    const failures: string[] = [];
    const stA11: unknown[] = [];
    const stA16: St16Report[] = [];
    const packets: unknown[] = [];
    let recovery: unknown = null;
    for (const dpr of [1, 2]) {
      const a11 = await render({ kind: 'st-a11' }, dpr);
      const a11Pixels = pixelsOf(a11);
      const a11Report = inspectStA11(dpr, a11.width, a11.height, a11Pixels);
      write(`st-a11-dpr${dpr}.png`, pngOf(a11));
      write(`st-a11-dpr${dpr}.rgba.gz`, gzipSync(a11Pixels));
      failures.push(...a11Report.failures);
      stA11.push({ dpr, ...a11Report, probed: undefined });
      packets.push({ scene: 'st-a11', dpr, packet: a11.packet });
      // Three joint paths: three joint fill draws, each with its stroke draw, and one primitive.
      if (a11.packet.jointDraws !== 3 || a11.packet.meshDraws !== 6)
        failures.push(
          `st-a11 dpr${dpr}: ${a11.packet.jointDraws} joint, ${a11.packet.meshDraws} mesh draws`,
        );
      if (a11.packet.analyticDraws !== 1)
        failures.push(`st-a11 dpr${dpr}: ${a11.packet.analyticDraws} analytic draws, expected 1`);

      const captured = new Map<string, Uint8Array>();
      for (const viewId of VIEW_ORDER) {
        const frames = layoutFrames(JOINT_VIEWS.find((view) => view.id === viewId)!);
        for (let index = 0; index < frames.length; index += 1) {
          const nodes = frames[index]!.length;
          const one = await render({ kind: 'st-a16', view: viewId, frame: index, opacity: 1 }, dpr);
          const onePixels = pixelsOf(one);
          const name = `st-a16-${viewId}-${index}-dpr${dpr}`;
          write(`${name}-o1.png`, pngOf(one));
          if (one.packet.jointDraws !== 0) failures.push(`${name} o=1: joint draws`);
          if (viewId === 'identity') captured.set(`${index}/1`, onePixels);
          for (const opacity of OPACITIES) {
            const atO = await render({ kind: 'st-a16', view: viewId, frame: index, opacity }, dpr);
            const atOPixels = pixelsOf(atO);
            write(`${name}-o${opacity}.png`, pngOf(atO));
            write(`${name}-o${opacity}.rgba.gz`, gzipSync(atOPixels));
            if (atO.packet.jointDraws !== nodes)
              failures.push(
                `${name} o=${opacity}: ${atO.packet.jointDraws} joint draws, expected ${nodes}`,
              );
            const report = inspectStA16(
              viewId,
              index,
              opacity,
              dpr,
              atO.width,
              atO.height,
              atOPixels,
              onePixels,
            );
            failures.push(...report.failures);
            stA16.push(report);
            packets.push({ scene: name, opacity, packet: atO.packet });
            if (viewId === 'identity') captured.set(`${index}/${opacity}`, atOPixels);
          }
        }
      }

      if (dpr === 2) {
        // ST-A17: device loss, then the same scenes again from the CPU state.
        const before = await page.evaluate(() => window.__vectorStudioP3V3Mesh.snapshot());
        const recovered = await page.evaluate(() => window.__vectorStudioP3V3Mesh.recover());
        write('recovered.png', pngOf(recovered));
        let mismatches = 0;
        const again = await render({ kind: 'st-a11' }, dpr);
        const againPixels = pixelsOf(again);
        for (const pixel of a11Report.probed) {
          for (let channel = 0; channel < 4; channel += 1) {
            if (againPixels[4 * pixel + channel] !== a11Pixels[4 * pixel + channel]) {
              mismatches += 1;
              break;
            }
          }
        }
        const identityFrames = layoutFrames(JOINT_VIEWS.find((view) => view.id === 'identity')!);
        let a16Compared = 0;
        for (let index = 0; index < identityFrames.length; index += 1) {
          for (const opacity of [1, ...OPACITIES]) {
            const frame = await render(
              { kind: 'st-a16', view: 'identity', frame: index, opacity },
              dpr,
            );
            const after = pixelsOf(frame);
            const reference = captured.get(`${index}/${opacity}`)!;
            const band = excludedBand(identityFrames[index]!, dpr, frame.width, frame.height);
            for (let pixel = 0; pixel < frame.width * frame.height; pixel += 1) {
              if (band.mask[pixel] === 1) continue;
              a16Compared += 1;
              for (let channel = 0; channel < 4; channel += 1) {
                if (after[4 * pixel + channel] !== reference[4 * pixel + channel]) {
                  mismatches += 1;
                  break;
                }
              }
            }
          }
        }
        const after = await page.evaluate(() => window.__vectorStudioP3V3Mesh.snapshot());
        recovery = {
          generation: [before.statistics.generation, recovered.packet.generation],
          portCalls: [before.port.calls, after.port.calls],
          strokePortCalls: [before.strokePort?.calls, after.strokePort?.calls],
          overlayBuilds: [before.overlayBuilds, after.overlayBuilds],
          comparedPixels: a11Report.probed.length + a16Compared,
          mismatches,
        };
        if (recovered.packet.generation <= before.statistics.generation)
          failures.push('recovery: no new generation');
        if (
          after.port.calls !== before.port.calls ||
          after.strokePort?.calls !== before.strokePort?.calls
        )
          failures.push('recovery: new port calls');
        if (after.overlayBuilds !== before.overlayBuilds) failures.push('recovery: overlay builds');
        if (mismatches !== 0)
          failures.push(`recovery: ${mismatches} probed pixels differ from pre-loss`);
      }
    }

    const state = await page.evaluate(() => window.__vectorStudioP3V3Mesh.snapshot());
    const disposed = await page.evaluate(() => window.__vectorStudioP3V3Mesh.dispose());
    const sourceAtEnd = p1Source();
    const interim = state.diagnostics
      .filter((event) => event.code === 'render.path-mesh-interim-failure')
      .map((event) => event.context!);
    // Only the V4 work cap of the region-only paints is expected: ST7-F7's stroke and ST7-F8's
    // fill and stroke. No overlay-unsupported and no composition-unsupported.
    for (const notice of interim) {
      const node = String(notice.nodeId);
      const expected =
        notice.failureCode === 'fringe-work-cap' &&
        ((node.endsWith('-f7') && notice.paint === 'stroke') || node.endsWith('-f8'));
      if (!expected) failures.push(`unexpected notice ${JSON.stringify(notice)}`);
    }
    const bandTotals = stA16.reduce(
      (sum, report) => ({
        pixels: sum.pixels + report.band.pixels,
        overTolerance: sum.overTolerance + report.band.overTolerance,
      }),
      { pixels: 0, overTolerance: 0 },
    );
    write(
      'observations.json',
      JSON.stringify(
        {
          schema: 'p3-st-u7-joint-fixtures-v1',
          evidence: ST_U7_EVIDENCE_LABEL,
          criteria: ['ST-A11', 'ST-A16', 'ST-A17'],
          timestampUtc: new Date().toISOString(),
          command: 'pnpm test:gpu',
          source,
          sourceAtEnd,
          headed: true,
          build: 'development',
          browser: { channel: info.project.name, version: browser.version() },
          operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
          capability,
          samples,
          readback:
            'GPU COPY_SRC canvas texture, BGRA swizzled to raw premultiplied RGBA over an opaque black clear',
          injection:
            'Static test-double fill-mesh and stroke-mesh ports (no WASM) with test-registered hand-made meshes, opaque black clear, COPY_SRC usage, explicit 4x rejection for the 1x fallback, post-submit staging copies; production shaders and packet path unmodified',
          gates:
            'ST-A11: pixel centers >= 3 physical px from every boundary within 2/255 of the single-opacity composite, overlap > 20/255 from the double-opacity value, the over-primitive overlap center within 2/255; ST-A16: every RGB channel of the render at o within 2/255 of o x the o = 1 render outside the excluded band, the band at most 3 L + 8 E pixels; ST-A17: probed pixels equal after device loss with zero new port calls and zero overlay builds',
          stA11,
          stA16,
          bandTotals,
          recovery,
          interim,
          packets,
          state: { ...state, diagnostics: state.diagnostics.length },
          disposed,
          pageErrors,
          failures,
        },
        null,
        2,
      ),
    );
    expect(failures, failures.slice(0, 12).join('\n')).toHaveLength(0);
    expect(recovery).not.toBeNull();
    expect(sourceAtEnd.manifestSha256).toBe(source.manifestSha256);
    expect(pageErrors).toEqual([]);
    const errors = state.diagnostics.filter(
      (event) => event.severity === 'error' && event.code !== 'device-loss.detected',
    );
    expect(errors).toEqual([]);
    expect(disposed.resources.live).toBe(0);
  });
}

/** Seeded defects of the addendum, section 5.6, injected on the fixture page only. */
const DEFECTS = [
  { id: 'ST7-D1', caughtBy: 'ST-A11' },
  { id: 'ST7-D2', caughtBy: 'ST-A16' },
  { id: 'ST7-D8', caughtBy: 'ST-A16' },
  { id: 'ST7-D10', caughtBy: 'ST-A16 at o = 0.25' },
] as const;

test('P3 ST-U7 seeded defects fail their checks (UNVERIFIED precision)', async ({
  browser,
}, info) => {
  test.setTimeout(600_000);
  const directory = path.join(runRoot, info.project.name, 'defects');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${ST_U7_EVIDENCE_LABEL}\n`, {
    flag: 'wx',
  });
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const defect of DEFECTS) {
    const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const { render } = await openPage(page, `samples=4&joint=1&defect=${defect.id}`, pageErrors);
    const a11 = await render({ kind: 'st-a11' }, 1);
    const a11Failures = inspectStA11(1, a11.width, a11.height, pixelsOf(a11)).failures.length;
    const a16: Record<string, number> = {};
    const frames = layoutFrames(JOINT_VIEWS.find((view) => view.id === 'identity')!);
    for (let index = 0; index < frames.length; index += 1) {
      const one = pixelsOf(
        await render({ kind: 'st-a16', view: 'identity', frame: index, opacity: 1 }, 1),
      );
      for (const opacity of OPACITIES) {
        const atO = await render({ kind: 'st-a16', view: 'identity', frame: index, opacity }, 1);
        const report = inspectStA16(
          'identity',
          index,
          opacity,
          1,
          atO.width,
          atO.height,
          pixelsOf(atO),
          one,
        );
        a16[`o=${opacity}`] = (a16[`o=${opacity}`] ?? 0) + report.overTolerance;
      }
    }
    const caught =
      defect.id === 'ST7-D1'
        ? a11Failures > 0
        : defect.id === 'ST7-D10'
          ? (a16['o=0.25'] ?? 0) > 0
          : (a16['o=0.5'] ?? 0) + (a16['o=0.25'] ?? 0) > 0;
    results.push({
      defect: defect.id,
      caughtBy: defect.caughtBy,
      a11Failures,
      a16OverTolerance: a16,
      caught,
      pageErrors,
    });
    if (!caught) failures.push(`${defect.id} was not caught by ${defect.caughtBy}`);
    await context.close();
  }
  writeFileSync(
    path.join(directory, 'defects.json'),
    JSON.stringify(
      {
        schema: 'p3-st-u7-joint-defects-v1',
        evidence: ST_U7_EVIDENCE_LABEL,
        browser: browser.version(),
        results,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  expect(failures).toEqual([]);
});
