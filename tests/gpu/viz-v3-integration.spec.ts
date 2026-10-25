import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { RenderSceneSnapshot } from '@vector-studio/contracts';
import type { VizV3IntegrationApi } from '../../apps/playground/src/viz-v3-integration.js';
import {
  VIZ_V3_CHURN,
  VIZ_V3_CHURN_PROBES,
  VIZ_V3_EVIDENCE_LABEL,
  VIZ_V3_JOINT_BAND_PROBE,
  VIZ_V3_ORDER_PROBES,
  VIZ_V3_SURFACE,
  VIZ_V3_SWAPPED_PROBES,
  buildVizV3Script,
  churnStepId,
  stateScene,
  type VizV3Probe,
} from '../../apps/playground/src/viz-v3-integration-scene.js';
import { p1Source } from '../support/p1-evidence.js';
import { oracleColor, separation, to8 } from '../support/viz-v3-oracle.js';

declare global {
  interface Window {
    __vectorStudioVizV3Integration: VizV3IntegrationApi;
  }
}

// Visualization track V-3 (docs/plans/viz-v3-a07-integration-contract.md): headed checks of the
// A07 integration page with the real geometry-wasm fill-mesh and stroke-mesh ports, in Chrome and
// Edge at device pixel ratios 1 and 2: ordered path/primitive integration against an independent
// painter's-order oracle (VZ3-A3 to VZ3-A6), resource lifetime under scene churn (VZ3-A7 to
// VZ3-A10), latest-scene device recovery (VZ3-A11 to VZ3-A13), disposal (VZ3-A14) and diagnostic
// hygiene (VZ3-A15). Functional evidence only: precision is UNVERIFIED against the 0.25
// physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold or performance
// claim is made. The helpers are copied, not imported, from tests/gpu/viz-v1-appearance.spec.ts
// (that spec stays unedited): the per-run evidence directory, the in-page PNG decoding of an
// element screenshot and PROBE_TOLERANCE.
//
// Probe positions and colors are fixed in the scene module by the probe rule, and expected
// colors come from tests/support/viz-v3-oracle.ts, never from a run's pixels. The predicted
// literals of section 4.1 (port-call deltas, the empty notice set) are fixed before the first run.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.VIZ_V3_OUTPUT_DIR ?? 'artifacts/viz-v3-integration',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

/** The operation ids the predicted literals were fixed with (VZ3-A1, section 4.1). */
const OPERATION_IDS = {
  fill: 'geometry-wasm/fill-v0+r3',
  stroke: 'geometry-wasm/stroke-v0+r7',
} as const;
/** Section 4.1: no path notice is expected anywhere in the run (VZ3-A15). */
const EXPECTED_NOTICES: readonly string[] = [];
/** Section 3.4 and 3.5: predicted port-call deltas (fill, stroke). */
const PREDICTED = {
  orderState: [0, 0],
  warmFrames: [0, 0],
  r1: [0, 0],
  r2X: [1, 0],
  r2Inverse: [1, 0],
  r2Window: [1, 0],
  cycleOdd: [2, 0],
  cycleEven: [2, 1],
  remove: [0, 0],
} as const;

/** Channel tolerance for probes, in 8-bit steps; functional, not a precision gate. */
const PROBE_TOLERANCE = 12;
const LIFECYCLE_CODES = new Set([
  'device-loss.detected',
  'recovery.started',
  'recovery.succeeded',
  'recovery.failed',
]);
const FORBIDDEN_CODES = new Set([
  'recovery.failed',
  'render.submission-failed',
  'allocation.failed',
  'allocation.accounting-error',
  'disposal.failed',
]);

type Rgb = readonly [number, number, number];
const script = buildVizV3Script();
const sceneAfterStep = (id: string): RenderSceneSnapshot =>
  id === 's0' ? script.initial : script.steps.find((step) => step.id === id)!.scene;

for (const dpr of [1, 2]) {
  test.describe(`DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test(`V-3 A07 integration page at DPR ${dpr} (UNVERIFIED precision)`, async ({
      browser,
      page,
    }, info) => {
      // The churn runs 192 change sets with a settle each, plus three recoveries.
      test.setTimeout(1_800_000);
      const directory = path.join(runRoot, info.project.name, `dpr${dpr}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'UNVERIFIED.txt'), `${VIZ_V3_EVIDENCE_LABEL}\n`, {
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
      const observed: Record<string, unknown> = {};

      const hook = () => page.evaluate(() => window.__vectorStudioVizV3Integration.snapshot());
      type Snapshot = Awaited<ReturnType<typeof hook>>;
      const settle = () => page.evaluate(() => window.__vectorStudioVizV3Integration.settle());
      const applyState = (id: string) =>
        page.evaluate((step) => window.__vectorStudioVizV3Integration.applyState(step), id);
      const loseDevice = (inWindow: readonly string[]) =>
        page.evaluate(
          (steps) => window.__vectorStudioVizV3Integration.loseDevice(steps),
          inWindow as string[],
        );
      const recordSample = (label: string) =>
        page.evaluate((text) => window.__vectorStudioVizV3Integration.recordSample(text), label);
      const calls = (state: Pick<Snapshot, 'pathMesh'>) =>
        [state.pathMesh?.portCalls ?? 0, state.pathMesh?.strokePortCalls ?? 0] as const;
      const delta = (
        before: Pick<Snapshot, 'pathMesh'>,
        after: Pick<Snapshot, 'pathMesh'>,
      ): readonly [number, number] => {
        const [f0, s0] = calls(before);
        const [f1, s1] = calls(after);
        return [f1 - f0, s1 - s0];
      };
      const gateDelta = (
        scenario: string,
        label: string,
        actual: readonly [number, number],
        expected: readonly [number, number],
      ) => {
        if (actual[0] !== expected[0] || actual[1] !== expected[1])
          fail(
            scenario,
            `${label}: port-call deltas (fill, stroke) ${JSON.stringify(actual)}, predicted ${JSON.stringify(expected)}`,
          );
      };

      type Capture = { digest: string; probes: Record<string, Rgb>; generation: number };
      /** Screenshot the surface, decode it in the page, hash the RGBA bytes and read the probes. */
      async function capture(
        scenario: string,
        stage: string,
        probes: readonly VizV3Probe[],
      ): Promise<Capture> {
        const before = (await hook()).statistics.generation;
        const png = await page.locator('#viz-v3-surface').screenshot();
        const after = (await hook()).statistics.generation;
        if (before !== after)
          fail(scenario, `${stage}: generation ${before} to ${after} during capture`);
        write(`${scenario}-${stage}.png`, png);
        const decoded = await page.evaluate(
          async ({ base64, points, width }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const scratch = document.createElement('canvas');
            scratch.width = image.naturalWidth;
            scratch.height = image.naturalHeight;
            const context = scratch.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const all = context.getImageData(0, 0, scratch.width, scratch.height).data;
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
            const scale = image.naturalWidth / width;
            return {
              digest: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
              samples: points.map(([x, y]) =>
                Array.from(
                  context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data,
                ).slice(0, 3),
              ),
              size: [scratch.width, scratch.height],
            };
          },
          {
            base64: png.toString('base64'),
            points: probes.map((probe) => [probe.x, probe.y] as const),
            width: VIZ_V3_SURFACE.width,
          },
        );
        const result: Record<string, Rgb> = {};
        probes.forEach((probe, index) => {
          result[probe.name] = decoded.samples[index] as unknown as Rgb;
        });
        return { digest: decoded.digest, probes: result, generation: after };
      }

      /** Compares every probe with the oracle's color for `scene`. */
      function matchOracle(
        scenario: string,
        stage: string,
        scene: RenderSceneSnapshot,
        shot: Capture,
        probes: readonly VizV3Probe[],
      ) {
        const reports: unknown[] = [];
        for (const probe of probes) {
          const expected = to8(oracleColor(scene, probe.x, probe.y));
          const seen = shot.probes[probe.name]!;
          const deviation = separation(seen, expected);
          reports.push({ probe: probe.name, expected, observed: seen, deviation });
          if (deviation > PROBE_TOLERANCE)
            fail(
              scenario,
              `${stage}: probe ${probe.name} at (${probe.x}, ${probe.y}) is ${JSON.stringify(seen)}, expected ${JSON.stringify(expected)}`,
            );
        }
        return reports;
      }

      function identical(scenario: string, label: string, a: Capture, b: Capture) {
        if (a.digest !== b.digest)
          fail(scenario, `${label}: surface bytes differ (${a.digest} vs ${b.digest})`);
        for (const [name, color] of Object.entries(a.probes)) {
          if (separation(color, b.probes[name]!) !== 0)
            fail(
              scenario,
              `${label}: probe ${name} ${JSON.stringify(color)} vs ${JSON.stringify(b.probes[name])}`,
            );
        }
      }

      /** Polls until a frame was presented after the loss, then settles. */
      async function recovered(framesPresentedAtLoss: number): Promise<Snapshot> {
        await page.waitForFunction(
          (frames) =>
            window.__vectorStudioVizV3Integration.snapshot().statistics.framesPresented > frames,
          framesPresentedAtLoss,
          { timeout: 60_000 },
        );
        await settle();
        return hook();
      }

      type LossRecord = Awaited<ReturnType<typeof loseDevice>>;
      const pipelineDeltas: number[] = [];
      /** The checks shared by VZ3-A11, VZ3-A12 and VZ3-A13. */
      function lossChecks(
        scenario: string,
        record: LossRecord,
        inWindow: readonly string[],
        before: Snapshot,
        after: Snapshot,
      ) {
        if (record.applied.length !== inWindow.length)
          fail(
            scenario,
            `${record.applied.length} in-window applications, expected ${inWindow.length} (${inWindow.join(', ')})`,
          );
        const window = after.diagnostics
          .slice(record.diagnosticIndexAtLoss)
          .filter((event) => LIFECYCLE_CODES.has(event.code));
        const shape = window.map((event) => ({ code: event.code, generation: event.generation }));
        const g = record.lostGeneration;
        const expectedShape = [
          { code: 'device-loss.detected', generation: g },
          { code: 'recovery.started', generation: g + 1 },
          { code: 'recovery.succeeded', generation: g + 1 },
        ];
        if (JSON.stringify(shape) !== JSON.stringify(expectedShape))
          fail(scenario, `lifecycle diagnostics ${JSON.stringify(shape)}`);
        const reason = (record.detectedContext as { reason?: unknown } | null)?.reason;
        if (reason !== 'destroyed') fail(scenario, `device-loss.detected reason ${String(reason)}`);
        if (after.statistics.generation !== g + 1)
          fail(scenario, `generation ${after.statistics.generation}, expected ${g + 1}`);
        if (after.statistics.lifecycle !== 'ready')
          fail(scenario, `lifecycle ${after.statistics.lifecycle} after recovery`);
        if (after.statistics.recoveryAttempts !== before.statistics.recoveryAttempts + 1)
          fail(
            scenario,
            `recoveryAttempts ${before.statistics.recoveryAttempts} to ${after.statistics.recoveryAttempts}`,
          );
        const stale =
          (record.staleGenerationSubmissionsAtRecovery ?? Number.NaN) -
          record.staleGenerationSubmissionsAtLoss;
        if (stale !== 0)
          fail(scenario, `staleGenerationSubmissions delta ${stale} across the window`);
        if (after.statistics.pendingFrameCallbacks !== 0)
          fail(
            scenario,
            `pendingFrameCallbacks ${after.statistics.pendingFrameCallbacks} at settle`,
          );
        if (after.statistics.framesPresented <= record.framesPresentedAtLoss)
          fail(scenario, 'no frame presented after the loss');
        pipelineDeltas.push(after.statistics.pipelinesCreated - before.statistics.pipelinesCreated);
        for (const applied of record.applied) {
          const inside =
            record.detectedIndex !== null &&
            applied.afterDiagnosticIndex >= record.detectedIndex &&
            (record.succeededIndex === null ||
              applied.afterDiagnosticIndex < record.succeededIndex);
          if (applied.status !== 'applied') fail(scenario, `${applied.step}: ${applied.status}`);
          if (!inside || !['lost', 'recovering'].includes(applied.lifecycle))
            fail(
              scenario,
              `${applied.step} applied outside the loss window (index ${applied.afterDiagnosticIndex}, lifecycle ${applied.lifecycle})`,
            );
          if (!applied.loseButtonDisabled)
            fail(
              scenario,
              `${applied.step}: "Simulate device loss" enabled while ${applied.lifecycle}`,
            );
        }
        return {
          record,
          lifecycleDiagnostics: shape,
          staleGenerationSubmissions: {
            atLoss: record.staleGenerationSubmissionsAtLoss,
            atRecovery: record.staleGenerationSubmissionsAtRecovery,
            delta: stale,
            after: after.statistics.staleGenerationSubmissions,
          },
          pipelinesCreatedDelta: pipelineDeltas.at(-1),
          shaderModulesCreatedDelta:
            after.statistics.shaderModulesCreated - before.statistics.shaderModulesCreated,
          resources: {
            before: {
              live: before.statistics.resources.live,
              liveBytes: before.statistics.resources.liveBytes,
            },
            after: {
              live: after.statistics.resources.live,
              liveBytes: after.statistics.resources.liveBytes,
            },
          },
          portCalls: { before: calls(before), after: calls(after) },
        };
      }

      async function scenario(name: string, body: () => Promise<void>) {
        try {
          await body();
        } catch (error) {
          fail(name, `threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // -------------------------------------------------------------------------------------
      // VZ3-A1: the page loads.
      let state!: Snapshot;
      await scenario('a1', async () => {
        // The served HTML carries the static disabled attribute, so the button is disabled
        // before the host script runs.
        const html = await (await page.request.get('/viz-v3-integration.html')).text();
        if (!/<button[^>]*id="viz-v3-lose-device"[^>]*\sdisabled[\s>]/u.test(html))
          fail(
            'a1',
            'the served HTML lacks the static disabled attribute on "Simulate device loss"',
          );
        await page.goto('/viz-v3-integration.html');
        const early = await page.evaluate(() => ({
          disabled: document.querySelector<HTMLButtonElement>('#viz-v3-lose-device')!.disabled,
          lifecycle:
            window.__vectorStudioVizV3Integration?.snapshot().statistics.lifecycle ?? 'no hook',
        }));
        observed.a1Early = early;
        if (early.lifecycle !== 'ready' && !early.disabled)
          fail('a1', `"Simulate device loss" enabled while ${early.lifecycle}`);
        await page.waitForFunction(() => window.__vectorStudioVizV3Integration !== undefined, {
          timeout: 60_000,
        });
        const capability = await page.evaluate(() => window.__vectorStudioVizV3Integration.ready);
        if (!capability.supported) fail('a1', `capability ${JSON.stringify(capability)}`);
        state = await settle();
        if (state.ports?.fill.operationId !== OPERATION_IDS.fill)
          fail('a1', `unexpected fill port ${JSON.stringify(state.ports)}`);
        if (state.ports?.stroke.operationId !== OPERATION_IDS.stroke)
          fail('a1', `unexpected stroke port ${JSON.stringify(state.ports)}`);
        if (state.requiresMeshPipeline !== true)
          fail('a1', `requiresMeshPipeline ${String(state.requiresMeshPipeline)}`);
        if (state.revision !== 1) fail('a1', `initial revision ${state.revision}`);
        await expect(page.locator('#viz-v3-label')).toBeVisible();
        await expect(page.locator('#viz-v3-label')).toContainText('UNVERIFIED');
        for (const name of [
          'Run ordered states',
          'Run churn',
          'Simulate device loss',
          'Reset scene',
        ])
          await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Simulate device loss', exact: true }),
        ).toBeEnabled();
        await expect(page.locator('#viz-v3-surface')).toHaveAttribute('aria-label', /test page/i);
        await expect(page.locator('#viz-v3-lifecycle')).toHaveAttribute('aria-live', 'polite');
        observed.a1 = {
          ports: state.ports,
          wasmSha256: state.wasmSha256,
          requiresMeshPipeline: state.requiresMeshPipeline,
          statistics: state.statistics,
          pathMesh: state.pathMesh,
        };
      });

      // -------------------------------------------------------------------------------------
      // VZ3-A3 to VZ3-A5: the ordered states.
      const shots: Record<string, Capture> = {};
      const orderReports: Record<string, unknown> = {};
      const orderDeltas: Record<string, readonly [number, number]> = {};
      await scenario('order', async () => {
        const s0 = script.initial;
        shots.s0 = await capture('order', 's0', VIZ_V3_ORDER_PROBES);
        orderReports.s0 = matchOracle('order', 's0', s0, shots.s0, VIZ_V3_ORDER_PROBES);
        // VZ3-A3: p-joint's stroke-over-fill band is the single application, separated from the
        // double-opacity value (opacity applied to fill and stroke separately).
        const joint = s0.nodes.find((node) => node.id === 'p-joint')!;
        if (joint.kind !== 'path') throw new Error('p-joint');
        const o = joint.opacity;
        const fill = joint.style.fill!;
        const stroke = joint.style.stroke!.color;
        const probe = VIZ_V3_ORDER_PROBES.find((p) => p.name === VIZ_V3_JOINT_BAND_PROBE)!;
        const base = oracleColor(s0, probe.x, probe.y);
        // The destination under p-joint is the opaque white r-jbase.
        const destination = { r: 1, g: 1, b: 1 };
        const doubled: Rgb = [
          Math.round(255 * (o * stroke.r + (1 - o) * (o * fill.r + (1 - o) * destination.r))),
          Math.round(255 * (o * stroke.g + (1 - o) * (o * fill.g + (1 - o) * destination.g))),
          Math.round(255 * (o * stroke.b + (1 - o) * (o * fill.b + (1 - o) * destination.b))),
        ];
        const single = to8(base);
        const jointSeparation = separation(single, doubled);
        if (jointSeparation <= 2 * PROBE_TOLERANCE)
          fail(
            'order',
            `joint single ${JSON.stringify(single)} vs double ${JSON.stringify(doubled)}`,
          );
        if (separation(shots.s0.probes[probe.name]!, doubled) <= 2 * PROBE_TOLERANCE)
          fail(
            'order',
            `the joint band ${JSON.stringify(shots.s0.probes[probe.name])} is near the double-opacity value`,
          );
        observed.jointBand = { single, doubled, separation: jointSeparation };
        let previous = s0;
        let previousShot = shots.s0;
        let before = await hook();
        for (const id of ['s1', 's2', 's3', 's4', 's5']) {
          const step = await applyState(id);
          if (step.result.status !== 'applied') fail('order', `${id}: ${step.result.status}`);
          const after = await hook();
          const scene = stateScene(script, id as 's1');
          if (after.revision !== scene.revision)
            fail('order', `${id}: revision ${after.revision}, script ${scene.revision}`);
          orderDeltas[id] = delta(before, after);
          gateDelta('order', id, orderDeltas[id], PREDICTED.orderState);
          const shot = await capture('order', id, VIZ_V3_ORDER_PROBES);
          shots[id] = shot;
          orderReports[id] = matchOracle('order', id, scene, shot, VIZ_V3_ORDER_PROBES);
          // VZ3-A4: a probe whose top layer changed differs from its previous color.
          for (const p of VIZ_V3_ORDER_PROBES) {
            const a = oracleColor(previous, p.x, p.y);
            const b = oracleColor(scene, p.x, p.y);
            if (a.top === b.top) continue;
            if (separation(to8(a), to8(b)) <= 2 * PROBE_TOLERANCE)
              fail('order', `${id}: ${p.name} candidates are not separated`);
            if (
              separation(previousShot.probes[p.name]!, shot.probes[p.name]!) <=
              2 * PROBE_TOLERANCE
            )
              fail('order', `${id}: ${p.name} did not change (top ${a.top} to ${b.top})`);
          }
          previous = scene;
          previousShot = shot;
          before = after;
        }
        // VZ3-A5: both swapped probes differ from the old order's color.
        const s4 = stateScene(script, 's4');
        for (const name of VIZ_V3_SWAPPED_PROBES) {
          const p = VIZ_V3_ORDER_PROBES.find((candidate) => candidate.name === name)!;
          const old = to8(oracleColor(s4, p.x, p.y));
          if (separation(shots.s5!.probes[name]!, old) <= 2 * PROBE_TOLERANCE)
            fail(
              'order',
              `s5: ${name} ${JSON.stringify(shots.s5!.probes[name])} is near the old order ${JSON.stringify(old)}`,
            );
        }
      });
      observed.orderDeltas = orderDeltas;
      observed.orderReports = orderReports;

      // -------------------------------------------------------------------------------------
      // VZ3-A6: warmed unchanged frames at S5.
      await scenario('a6', async () => {
        const before = await hook();
        for (let frame = 0; frame < 3; frame += 1) {
          await page.evaluate(() => window.__vectorStudioVizV3Integration.invalidate());
          await settle();
        }
        const after = await hook();
        const presented = after.statistics.framesPresented - before.statistics.framesPresented;
        if (presented < 3) fail('a6', `framesPresented +${presented}`);
        gateDelta('a6', 'warm frames', delta(before, after), PREDICTED.warmFrames);
        if (JSON.stringify(after.preparation) !== JSON.stringify(before.preparation))
          fail(
            'a6',
            `preparation ${JSON.stringify(before.preparation)} to ${JSON.stringify(after.preparation)}`,
          );
        for (const key of ['pipelinesCreated', 'shaderModulesCreated'] as const) {
          if (after.statistics[key] !== before.statistics[key])
            fail('a6', `${key} ${before.statistics[key]} to ${after.statistics[key]}`);
        }
        const shot = await capture('a6', 'warm', VIZ_V3_ORDER_PROBES);
        identical('a6', 'warm frames versus S5', shot, shots.s5!);
        observed.a6 = {
          framesPresented: presented,
          framesSubmitted: after.statistics.framesSubmitted - before.statistics.framesSubmitted,
          preparation: after.preparation,
        };
      });

      // -------------------------------------------------------------------------------------
      // VZ3-A11, R1: static recovery at S5.
      await scenario('r1', async () => {
        const before = await hook();
        const pre = await capture('r1', 'pre-loss', VIZ_V3_ORDER_PROBES);
        const record = await loseDevice([]);
        const after = await recovered(record.framesPresentedAtLoss);
        const post = await capture('r1', 'recovered', VIZ_V3_ORDER_PROBES);
        identical('r1', 'recovered versus pre-loss', post, pre);
        gateDelta('r1', 'recovery', delta(before, after), PREDICTED.r1);
        if (
          after.statistics.resources.live !== before.statistics.resources.live ||
          after.statistics.resources.liveBytes !== before.statistics.resources.liveBytes
        )
          fail(
            'r1',
            `resources ${before.statistics.resources.live}/${before.statistics.resources.liveBytes} to ${after.statistics.resources.live}/${after.statistics.resources.liveBytes}`,
          );
        observed.r1 = lossChecks('r1', record, [], before, after);
      });

      // -------------------------------------------------------------------------------------
      // VZ3-A12, R2: edits during loss.
      await scenario('r2', async () => {
        const start = await hook();
        await applyState('r2-x');
        const xState = await hook();
        const deltaX = delta(start, xState);
        gateDelta('r2', 'X (no loss)', deltaX, PREDICTED.r2X);
        const noLoss = await capture('r2', 'no-loss-e', VIZ_V3_ORDER_PROBES);
        const reports = matchOracle(
          'r2',
          'no-loss-e',
          stateScene(script, 'e'),
          noLoss,
          VIZ_V3_ORDER_PROBES,
        );
        await applyState('r2-x-inverse');
        const before = await hook();
        const deltaInverse = delta(xState, before);
        gateDelta('r2', 'X inverse', deltaInverse, PREDICTED.r2Inverse);
        const record = await loseDevice(['r2-x-window']);
        const after = await recovered(record.framesPresentedAtLoss);
        if (after.revision !== sceneAfterStep('r2-x-window').revision)
          fail('r2', `revision ${after.revision} after the window`);
        const post = await capture('r2', 'recovered-e', VIZ_V3_ORDER_PROBES);
        identical('r2', 'recovered E versus no-loss E', post, noLoss);
        const deltaWindow = delta(before, after);
        gateDelta('r2', 'X in the loss window', deltaWindow, PREDICTED.r2Window);
        if (
          after.statistics.resources.live !== before.statistics.resources.live ||
          after.statistics.resources.liveBytes !== before.statistics.resources.liveBytes
        )
          fail(
            'r2',
            `resources ${before.statistics.resources.live}/${before.statistics.resources.liveBytes} to ${after.statistics.resources.live}/${after.statistics.resources.liveBytes}`,
          );
        observed.r2 = {
          ...lossChecks('r2', record, ['r2-x-window'], before, after),
          deltas: { x: deltaX, inverse: deltaInverse, window: deltaWindow },
          noLossE: {
            live: xState.statistics.resources.live,
            liveBytes: xState.statistics.resources.liveBytes,
          },
          noLossReports: reports,
        };
        // Back to S5's content before the churn.
        const restore = await applyState('r2-restore');
        if (restore.result.status !== 'applied') fail('r2', `restore ${restore.result.status}`);
        const restored = await capture('r2', 'restored-s5', VIZ_V3_ORDER_PROBES);
        identical('r2', 'restored S5 versus S5', restored, shots.s5!);
      });

      // -------------------------------------------------------------------------------------
      // VZ3-A7 to VZ3-A10 and VZ3-A13: the churn script with R3 at cycle 32.
      type Sample = Awaited<ReturnType<typeof recordSample>>;
      const churnStart = await recordSample('churn-start');
      const ends = new Map<number, Sample>();
      const stepSamples: Array<{ cycle: number; step: string; sample: Sample }> = [];
      const churnProbeReports: Record<string, unknown> = {};
      await scenario('churn', async () => {
        const probeCycles = new Set([1, 2, 31, 32, 63, 64]);
        for (let c = 1; c <= VIZ_V3_CHURN.cycles; c += 1) {
          const add = await applyState(churnStepId(c, 'add'));
          stepSamples.push({ cycle: c, step: 'add', sample: add.sample });
          if (add.result.status !== 'applied') fail('churn', `${c} add: ${add.result.status}`);
          if (c === VIZ_V3_CHURN.lossCycle) {
            // R3: destroy after step 1 has settled; steps 2 and 3 run inside the loss window.
            const before = await hook();
            const record = await loseDevice([churnStepId(c, 'replace'), churnStepId(c, 'remove')]);
            const after = await recovered(record.framesPresentedAtLoss);
            const end = await recordSample(`${churnStepId(c, 'remove')} (recovered)`);
            ends.set(c, end);
            stepSamples.push({ cycle: c, step: 'remove (recovered)', sample: end });
            observed.r3 = lossChecks(
              'r3',
              record,
              [churnStepId(c, 'replace'), churnStepId(c, 'remove')],
              before,
              after,
            );
            for (const applied of record.applied) {
              if (applied.status !== 'applied') fail('r3', `${applied.step}: ${applied.status}`);
            }
          } else {
            const replace = await applyState(churnStepId(c, 'replace'));
            const remove = await applyState(churnStepId(c, 'remove'));
            stepSamples.push({ cycle: c, step: 'replace', sample: replace.sample });
            stepSamples.push({ cycle: c, step: 'remove', sample: remove.sample });
            for (const [label, step] of [
              ['replace', replace],
              ['remove', remove],
            ] as const) {
              if (step.result.status !== 'applied')
                fail('churn', `${c} ${label}: ${step.result.status}`);
            }
            gateDelta(
              'churn',
              `cycle ${c} remove step`,
              delta(replace.sample, remove.sample),
              PREDICTED.remove,
            );
            ends.set(c, remove.sample);
          }
          if (probeCycles.has(c)) {
            const scene = sceneAfterStep(churnStepId(c, 'remove'));
            const shot = await capture('churn', `cycle-${c}`, [
              ...VIZ_V3_CHURN_PROBES,
              ...VIZ_V3_ORDER_PROBES,
            ]);
            churnProbeReports[c] = matchOracle('churn', `cycle ${c}`, scene, shot, [
              ...VIZ_V3_CHURN_PROBES,
              ...VIZ_V3_ORDER_PROBES,
            ]);
            for (const p of VIZ_V3_ORDER_PROBES) {
              if (separation(shot.probes[p.name]!, shots.s5!.probes[p.name]!) > PROBE_TOLERANCE)
                fail('churn', `cycle ${c}: order probe ${p.name} changed from S5`);
            }
          }
        }
      });

      // VZ3-A7, VZ3-A8, VZ3-A9, VZ3-A10, VZ3-A13 from the samples.
      const churnRecord: unknown[] = [];
      {
        const { cycles, warmup, lossCycle } = VIZ_V3_CHURN;
        const reference = (c: number): number =>
          c <= lossCycle
            ? c % 2 === 0
              ? warmup
              : warmup - 1
            : c % 2 === 0
              ? lossCycle + 2
              : lossCycle + 1;
        let previousEnd: Sample = churnStart;
        for (let c = 1; c <= cycles; c += 1) {
          const end = ends.get(c);
          if (end === undefined) {
            fail('churn', `cycle ${c}: no end-of-cycle sample`);
            continue;
          }
          const cycleDelta = delta(previousEnd, end);
          gateDelta(
            'churn',
            `cycle ${c}`,
            cycleDelta,
            c % 2 === 0 ? PREDICTED.cycleEven : PREDICTED.cycleOdd,
          );
          if (end.revision !== previousEnd.revision + 3)
            fail('churn', `cycle ${c}: revision ${previousEnd.revision} to ${end.revision}`);
          const resources = end.statistics.resources;
          churnRecord.push({
            cycle: c,
            revision: end.revision,
            portCalls: calls(end),
            delta: cycleDelta,
            live: resources.live,
            liveBytes: resources.liveBytes,
            peakLiveBytes: resources.peakLiveBytes,
            created: resources.created,
            bufferCreated: resources.byCategory.buffer.created,
            byCategoryLive: Object.fromEntries(
              Object.entries(resources.byCategory).map(([key, value]) => [key, value.live]),
            ),
            pathMesh: end.pathMesh,
            pipelinesCreated: end.statistics.pipelinesCreated,
            shaderModulesCreated: end.statistics.shaderModulesCreated,
          });
          const mesh = end.pathMesh;
          if (mesh?.evictions !== 0 || mesh.noticesDropped !== 0 || mesh.noticesQueued !== 0)
            fail(
              'churn',
              `cycle ${c}: evictions ${mesh?.evictions}, notices ${mesh?.noticesQueued}/${mesh?.noticesDropped}`,
            );
          // Pipelines and shader modules change only at the R3 recovery.
          const pipelineBase = c < lossCycle ? churnStart : ends.get(lossCycle);
          if (pipelineBase !== undefined) {
            for (const key of ['pipelinesCreated', 'shaderModulesCreated'] as const) {
              if (end.statistics[key] !== pipelineBase.statistics[key])
                fail(
                  'churn',
                  `cycle ${c}: ${key} ${pipelineBase.statistics[key]} to ${end.statistics[key]}`,
                );
            }
          }
          if (c > warmup) {
            const ref = ends.get(reference(c));
            if (ref !== undefined && reference(c) !== c) {
              const r = ref.statistics.resources;
              // VZ3-A8: the only GPU-side leak gate.
              if (resources.live !== r.live || resources.liveBytes !== r.liveBytes)
                fail(
                  'churn',
                  `cycle ${c}: live ${resources.live}/${resources.liveBytes} versus cycle ${reference(c)} ${r.live}/${r.liveBytes}`,
                );
              for (const [key, value] of Object.entries(resources.byCategory)) {
                const refValue = r.byCategory[key as keyof typeof r.byCategory].live;
                if (value.live !== refValue)
                  fail('churn', `cycle ${c}: ${key}.live ${value.live} versus ${refValue}`);
              }
              // VZ3-A9.
              const m = end.pathMesh!;
              const rm = ref.pathMesh!;
              for (const key of [
                'entries',
                'bytes',
                'memoEntries',
                'portLinearMemoryBytes',
                'strokePortLinearMemoryBytes',
              ] as const) {
                if (m[key] !== rm[key])
                  fail(
                    'churn',
                    `cycle ${c}: ${key} ${m[key]} versus cycle ${reference(c)} ${rm[key]}`,
                  );
              }
            }
          }
          previousEnd = end;
        }
      }
      observed.churn = churnRecord;
      observed.churnProbeReports = churnProbeReports;
      observed.churnStepSamples = stepSamples.map(({ cycle, step, sample }) => ({
        cycle,
        step,
        label: sample.label,
        revision: sample.revision,
        inLossWindow: sample.inLossWindow,
        portCalls: calls(sample),
        live: sample.statistics.resources.live,
        liveBytes: sample.statistics.resources.liveBytes,
        peakLiveBytes: sample.statistics.resources.peakLiveBytes,
        bufferCreated: sample.statistics.resources.byCategory.buffer.created,
        entries: sample.pathMesh?.entries,
        bytes: sample.pathMesh?.bytes,
      }));

      // VZ3-A11: pipelinesCreated grows by the same amount at every loss.
      observed.pipelineDeltas = pipelineDeltas;
      if (pipelineDeltas.length !== 3 || new Set(pipelineDeltas).size !== 1)
        fail('losses', `pipelinesCreated deltas ${JSON.stringify(pipelineDeltas)}`);

      // -------------------------------------------------------------------------------------
      // VZ3-A15: diagnostic hygiene over the whole run; then VZ3-A14: disposal.
      const final = await hook();
      {
        const errors = final.diagnostics.filter((event) => event.severity === 'error');
        const unexpected = errors.filter((event) => event.code !== 'device-loss.detected');
        if (unexpected.length > 0) fail('a15', `error diagnostics ${JSON.stringify(unexpected)}`);
        const losses = errors.filter((event) => event.code === 'device-loss.detected').length;
        if (losses !== 3) fail('a15', `${losses} device-loss.detected events, expected 3`);
        const forbidden = final.diagnostics.filter((event) => FORBIDDEN_CODES.has(event.code));
        if (forbidden.length > 0) fail('a15', `forbidden diagnostics ${JSON.stringify(forbidden)}`);
        const notices = final.notices.map(
          (event) =>
            `${String(event.context?.nodeId)} ${String(event.context?.paint)} ${String(event.context?.failureCode)}`,
        );
        if (JSON.stringify(notices) !== JSON.stringify(EXPECTED_NOTICES))
          fail('a15', `notices ${JSON.stringify(notices)}, expected none`);
        observed.notices = notices;
        observed.diagnosticCodes = final.diagnostics.reduce<Record<string, number>>(
          (counts, event) => {
            counts[event.code] = (counts[event.code] ?? 0) + 1;
            return counts;
          },
          {},
        );
      }
      await scenario('a14', async () => {
        const disposed = await page.evaluate(() => window.__vectorStudioVizV3Integration.dispose());
        const s = disposed.statistics;
        if (s.lifecycle !== 'disposed') fail('a14', `lifecycle ${s.lifecycle}`);
        if (s.resources.live !== 0 || s.resources.liveBytes !== 0)
          fail('a14', `resources ${s.resources.live}/${s.resources.liveBytes} after dispose`);
        const completed = disposed.diagnostics.filter(
          (event) => event.code === 'disposal.completed',
        );
        const failed = disposed.diagnostics.filter((event) => event.code === 'disposal.failed');
        if (completed.length !== 1 || failed.length !== 0)
          fail('a14', `disposal.completed ${completed.length}, disposal.failed ${failed.length}`);
        observed.a14 = { lifecycle: s.lifecycle, resources: s.resources };
      });

      if (pageErrors.length > 0) fail('page', `page errors: ${pageErrors.join('; ')}`);
      const samples = await page.evaluate(() => window.__vectorStudioVizV3Integration.samples());
      write('samples.json', `${JSON.stringify(samples, null, 2)}\n`);
      write(
        'observations.json',
        `${JSON.stringify(
          {
            label: VIZ_V3_EVIDENCE_LABEL,
            browser: { project: info.project.name, version: browser.version() },
            host: { platform: os.platform(), release: os.release(), cpus: os.cpus()[0]?.model },
            source: p1Source(),
            operationIds: OPERATION_IDS,
            predicted: PREDICTED,
            deviceScaleFactor: dpr,
            probeTolerance: PROBE_TOLERANCE,
            churn: VIZ_V3_CHURN,
            ...observed,
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
