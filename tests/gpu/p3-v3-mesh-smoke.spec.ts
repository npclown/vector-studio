import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { P3V3MeshFixtureApi } from '../../apps/playground/src/p3-v3-mesh.js';
import { p1Source } from '../support/p1-evidence.js';
import {
  SMOKE_CAMERA,
  SMOKE_VARIANTS,
  V3C_EVIDENCE_LABEL,
  inspectSmoke,
  observeEdges,
  smokeSnapshot,
} from '../support/v3c-mesh-smoke.js';

declare global {
  interface Window {
    __vectorStudioP3V3Mesh: P3V3MeshFixtureApi;
  }
}

// P3 V3 contract, section l, V3-A14: the headed functional smoke of unit V3c, labelled
// UNVERIFIED. Precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04
// evidence; this spec claims no Q4 coverage threshold and closes no A01-A08 criterion. Edge
// pixels (within 3 physical px of a boundary) are captured in the artifacts and never gated.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.P3_V3_MESH_OUTPUT_DIR ?? 'artifacts/p3-v3-mesh',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

for (const samples of [1, 4] as const) {
  test(`P3 V3c mesh smoke samples${samples} (UNVERIFIED precision)`, async ({
    browser,
    page,
  }, info) => {
    test.setTimeout(300_000);
    const directory = path.join(runRoot, info.project.name, `samples${samples}`);
    mkdirSync(directory, { recursive: true });
    // V3-A17: every headed artifact directory carries the evidence label.
    writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${V3C_EVIDENCE_LABEL}\n`, {
      flag: 'wx',
    });
    const write = (name: string, data: string | Uint8Array) =>
      writeFileSync(path.join(directory, name), data, { flag: 'wx' });
    const source = p1Source();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`/p3-v3-mesh.html?samples=${samples}`);
    const capability = await page.evaluate(() => window.__vectorStudioP3V3Mesh.ready);
    expect(capability.supported, JSON.stringify(capability)).toBe(true);
    if (capability.supported) expect(capability.capabilities.sampleCount).toBe(samples);

    const failures: string[] = [];
    const observations: unknown[] = [];
    let revision = 1;
    let recovery: unknown = null;
    for (const dpr of [1, 2]) {
      for (const variant of SMOKE_VARIANTS) {
        const snapshot = smokeSnapshot(variant, revision++);
        const frame = await page.evaluate(
          ({ snapshot, camera, dpr }) =>
            window.__vectorStudioP3V3Mesh.render(snapshot, camera, dpr),
          { snapshot, camera: SMOKE_CAMERA, dpr },
        );
        const pixels = Buffer.from(frame.rgbaBase64, 'base64');
        const report = inspectSmoke(variant, dpr, frame.width, frame.height, pixels);
        const name = `${variant.id}-dpr${dpr}`;
        write(`${name}.png`, Buffer.from(frame.png.split(',')[1]!, 'base64'));
        write(`${name}.rgba.gz`, gzipSync(pixels));
        failures.push(...report.failures);
        if (frame.packet.meshDraws !== 4)
          failures.push(`${name}: ${frame.packet.meshDraws} mesh draws, expected 4`);
        // Paint order: f02-nonzero, f02-evenodd, rect-below, path-between, rect-above,
        // rect-under-half, path-half gives analytic draws [rect-below], [rect-above, rect-under-half].
        if (frame.packet.analyticDraws !== 2)
          failures.push(`${name}: ${frame.packet.analyticDraws} analytic draws, expected 2`);
        observations.push({
          variant,
          dpr,
          width: frame.width,
          height: frame.height,
          packet: frame.packet,
          portCalls: frame.portCalls,
          report: { ...report, probed: undefined },
          // Not gated: edge pixels against the O02 rule (identity and 30 degree variants only).
          edgeObservation: observeEdges(variant, dpr, frame.width, frame.height, pixels),
        });

        // Device loss once per sample count: the identity scene at DPR 2.
        if (variant.id === 'identity' && dpr === 2) {
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
          let frameMismatches = 0;
          for (let pixel = 0; pixel < after.length / 4; pixel += 1) {
            for (let channel = 0; channel < 4; channel += 1) {
              if (after[4 * pixel + channel] !== pixels[4 * pixel + channel]) {
                frameMismatches += 1;
                break;
              }
            }
          }
          recovery = {
            generation: [frame.packet.generation, recovered.packet.generation],
            portCalls: [frame.portCalls, recovered.portCalls],
            probedPixels: report.probed.length,
            probedMismatches,
            // Observation only: edge pixels are not gated.
            frameMismatches,
            packet: recovered.packet,
          };
          if (recovered.packet.generation <= frame.packet.generation)
            failures.push('recovery: no new generation');
          if (recovered.portCalls !== frame.portCalls)
            failures.push(`recovery: ${recovered.portCalls - frame.portCalls} new port calls`);
          if (probedMismatches !== 0)
            failures.push(`recovery: ${probedMismatches} probed pixels differ from pre-loss`);
        }
      }
    }

    const state = await page.evaluate(() => window.__vectorStudioP3V3Mesh.snapshot());
    const disposed = await page.evaluate(() => window.__vectorStudioP3V3Mesh.dispose());
    const sourceAtEnd = p1Source();
    write(
      'observations.json',
      JSON.stringify(
        {
          schema: 'p3-v3c-mesh-smoke-v1',
          evidence: V3C_EVIDENCE_LABEL,
          criterion: 'V3-A14',
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
            'Static test-double fill-mesh port (no WASM), opaque black clear, COPY_SRC usage, explicit 4x rejection for the 1x fallback, post-submit staging copies; production shaders and packet path unmodified',
          gates:
            'pixel centers >= 3 physical px from every boundary within 2/255 of the analytic composite; overlap pixels > 20/255 from the double-opacity value; probed pixels equal after device loss with zero new port calls',
          observations,
          recovery,
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
    const unexpected = state.diagnostics.filter(
      (event) =>
        (event.severity === 'error' && event.code !== 'device-loss.detected') ||
        event.code === 'render.path-mesh-interim-failure',
    );
    expect(unexpected).toEqual([]);
    expect(state.port.calls).toBeGreaterThan(0);
    expect(disposed.resources.live).toBe(0);
  });
}
