import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { P3V3MeshFixtureApi } from '../../apps/playground/src/p3-v3-mesh.js';
import { p1Source } from '../support/p1-evidence.js';
import {
  STROKE_FIXTURE_CAMERA,
  STROKE_FIXTURE_MESH_DRAWS,
  ST_U6_EVIDENCE_LABEL,
  inspectStrokeFixture,
  strokeFixtureSnapshot,
} from '../support/st-u6-stroke-gpu.js';

declare global {
  interface Window {
    __vectorStudioP3V3Mesh: P3V3MeshFixtureApi;
  }
}

// B2 stroke contract, ST-A10 (unit ST-U6): headed GPU stroke fixtures, labelled UNVERIFIED. The
// V3 smoke fixture page runs in its `?stroke=1` mode with static test-double fill and stroke
// ports (no WASM). It checks the approved example's stroke-only, overlap and fill-only pixels at
// opacity 1, single-paint paths at opacity 0.5, and the interim composition-unsupported failure
// for both paints at opacity 0.5, plus device-loss reconstruction with no port call. Precision is
// UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence; no Q4 coverage
// threshold is claimed and no A01-A08 criterion is closed. Edge pixels are captured, not gated.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.P3_ST_U6_STROKE_OUTPUT_DIR ?? 'artifacts/p3-st-u6-stroke',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

for (const samples of [1, 4] as const) {
  test(`P3 ST-U6 stroke fixtures samples${samples} (UNVERIFIED precision)`, async ({
    browser,
    page,
  }, info) => {
    test.setTimeout(300_000);
    const directory = path.join(runRoot, info.project.name, `samples${samples}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${ST_U6_EVIDENCE_LABEL}\n`, {
      flag: 'wx',
    });
    const write = (name: string, data: string | Uint8Array) =>
      writeFileSync(path.join(directory, name), data, { flag: 'wx' });
    const source = p1Source();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`/p3-v3-mesh.html?samples=${samples}&stroke=1`);
    const capability = await page.evaluate(() => window.__vectorStudioP3V3Mesh.ready);
    expect(capability.supported, JSON.stringify(capability)).toBe(true);

    const failures: string[] = [];
    const observations: unknown[] = [];
    let recovery: unknown = null;
    let revision = 1;
    for (const dpr of [1, 2]) {
      const frame = await page.evaluate(
        ({ snapshot, camera, dpr }) => window.__vectorStudioP3V3Mesh.render(snapshot, camera, dpr),
        { snapshot: strokeFixtureSnapshot(revision++), camera: STROKE_FIXTURE_CAMERA, dpr },
      );
      const pixels = Buffer.from(frame.rgbaBase64, 'base64');
      const report = inspectStrokeFixture(dpr, frame.width, frame.height, pixels);
      const name = `strokes-dpr${dpr}`;
      write(`${name}.png`, Buffer.from(frame.png.split(',')[1]!, 'base64'));
      write(`${name}.rgba.gz`, gzipSync(pixels));
      failures.push(...report.failures);
      // both-opaque draws fill then stroke, fill-half one fill, stroke-half one stroke, and the
      // composition-unsupported both-half draws nothing.
      if (frame.packet.meshDraws !== STROKE_FIXTURE_MESH_DRAWS)
        failures.push(`${name}: ${frame.packet.meshDraws} mesh draws, expected 4`);
      if (frame.packet.analyticDraws !== 0)
        failures.push(`${name}: ${frame.packet.analyticDraws} analytic draws, expected 0`);
      observations.push({
        dpr,
        width: frame.width,
        height: frame.height,
        packet: frame.packet,
        portCalls: frame.portCalls,
        strokePortCalls: frame.strokePortCalls,
        report: { ...report, probed: undefined },
      });

      if (dpr === 2) {
        const recovered = await page.evaluate(() => window.__vectorStudioP3V3Mesh.recover());
        const after = Buffer.from(recovered.rgbaBase64, 'base64');
        write(`${name}-recovered.png`, Buffer.from(recovered.png.split(',')[1]!, 'base64'));
        let probedMismatches = 0;
        for (const pixel of report.probed) {
          for (let channel = 0; channel < 4; channel += 1) {
            if (after[4 * pixel + channel] !== pixels[4 * pixel + channel]) {
              probedMismatches += 1;
              break;
            }
          }
        }
        recovery = {
          generation: [frame.packet.generation, recovered.packet.generation],
          portCalls: [frame.portCalls, recovered.portCalls],
          strokePortCalls: [frame.strokePortCalls, recovered.strokePortCalls],
          probedPixels: report.probed.length,
          probedMismatches,
          packet: recovered.packet,
        };
        if (recovered.packet.generation <= frame.packet.generation)
          failures.push('recovery: no new generation');
        if (
          recovered.portCalls !== frame.portCalls ||
          recovered.strokePortCalls !== frame.strokePortCalls
        )
          failures.push('recovery: new port calls');
        if (probedMismatches !== 0)
          failures.push(`recovery: ${probedMismatches} probed pixels differ from pre-loss`);
      }
    }

    const state = await page.evaluate(() => window.__vectorStudioP3V3Mesh.snapshot());
    const disposed = await page.evaluate(() => window.__vectorStudioP3V3Mesh.dispose());
    const sourceAtEnd = p1Source();
    const interim = state.diagnostics.filter(
      (event) => event.code === 'render.path-mesh-interim-failure',
    );
    write(
      'observations.json',
      JSON.stringify(
        {
          schema: 'p3-st-u6-stroke-fixtures-v1',
          evidence: ST_U6_EVIDENCE_LABEL,
          criterion: 'ST-A10',
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
            'Static test-double fill-mesh and stroke-mesh ports (no WASM), opaque black clear, COPY_SRC usage, explicit 4x rejection for the 1x fallback, post-submit staging copies; production shaders and packet path unmodified',
          gates:
            'pixel centers >= 3 physical px from every boundary within 2/255 of the analytic two-draw composite; the both-paints-at-0.5 node draws nothing and reports composition-unsupported once with paint null; probed pixels equal after device loss with zero new port calls',
          observations,
          recovery,
          interim: interim.map((event) => event.context),
          state,
          disposed,
          pageErrors,
          failures,
        },
        null,
        2,
      ),
    );
    expect(failures, failures.slice(0, 8).join('\n')).toHaveLength(0);
    expect(recovery).not.toBeNull();
    expect(sourceAtEnd.manifestSha256).toBe(source.manifestSha256);
    expect(pageErrors).toEqual([]);
    // The interim failure of the overlap case: once, on its transition, with paint null.
    expect(interim.map((event) => event.context)).toEqual([
      {
        interim: 'd8',
        nodeId: 'both-half',
        failureScope: 'renderer',
        failureCode: 'composition-unsupported',
        toleranceExponent: null,
        paint: null,
      },
    ]);
    const errors = state.diagnostics.filter(
      (event) => event.severity === 'error' && event.code !== 'device-loss.detected',
    );
    expect(errors).toEqual([]);
    // One batch per port at each DPR: DPR 2 needs a finer bucket (e = -7 after -6).
    expect(state.port).toMatchObject({ calls: 2, requests: 4 });
    expect(state.strokePort).toMatchObject({ calls: 2, requests: 4 });
    expect(disposed.resources.live).toBe(0);
  });
}
