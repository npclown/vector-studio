import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import type { RenderChangeSet } from '@vector-studio/contracts';
import type { P1FixtureApi } from '../../apps/playground/src/p1-fixture.js';
import {
  invalidContainerSnapshot,
  precisionFixtures,
  visualFixtures,
  visualCullingFixture,
  type VisualFixture,
} from '../support/p1-visual-corpus.js';
import { inspectPixels } from '../support/p1-visual-oracle.js';
import { p1EvidenceDirectory, p1Source, p1Write } from '../support/p1-evidence.js';
import { inspectNativePositions } from '../support/p1-position-oracle.js';

declare global {
  interface Window {
    __vectorStudioP1: P1FixtureApi;
  }
}

// Full images, raw readbacks, source manifests and numeric reports are retained
// explicitly. Avoid duplicating thousands of multi-megabyte protocol results in a trace.
test.use({ trace: 'off' });

async function render(page: Page, fixture: VisualFixture, dpr: number) {
  return page.evaluate(
    ({ fixture, dpr }) =>
      window.__vectorStudioP1.render(
        fixture.snapshot,
        fixture.camera,
        dpr,
        fixture.transparent,
        fixture.id.startsWith('N02-'),
      ),
    { fixture, dpr },
  );
}

for (const samples of [1, 4] as const) {
  for (const dpr of [1, 1.5, 2]) {
    for (const family of ['visual', 'precision'] as const) {
      test(`P1 ${family} samples${samples} dpr${dpr}`, async ({ browser, page }, info) => {
        test.setTimeout(600_000);
        const directory = p1EvidenceDirectory(info);
        const source = p1Source();
        p1Write(directory, 'source.json', JSON.stringify(source, null, 2));
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(`/p1-fixture.html?samples=${samples}`);
        const capability = await page.evaluate(() => window.__vectorStudioP1.ready);
        expect(capability.supported, JSON.stringify(capability)).toBe(true);
        if (capability.supported) expect(capability.capabilities.sampleCount).toBe(samples);
        const observations = [];
        const failures: string[] = [];
        const fixtures = family === 'visual' ? visualFixtures() : precisionFixtures(dpr);
        for (const fixture of fixtures) {
          const image = await render(page, fixture, dpr);
          const rawPixels = Buffer.from(image.rgbaBase64, 'base64');
          const report = inspectPixels(fixture, dpr, image.width, image.height, rawPixels);
          const positionReport =
            family === 'precision' ? inspectNativePositions(fixture, dpr, image.positions) : null;
          if (fixture.id.startsWith('V07-')) {
            const actualIds = image.packet.orderSlots.map(
              (slot) => fixture.snapshot.rootOrder[slot],
            );
            if (
              JSON.stringify(actualIds) !==
              JSON.stringify(visualCullingFixture().expectedVisibleIds)
            )
              failures.push(
                `${fixture.id}: guarded inclusive culling order mismatch ${JSON.stringify(actualIds)}`,
              );
          }
          p1Write(directory, `${fixture.id}.png`, Buffer.from(image.png.split(',')[1]!, 'base64'));
          p1Write(directory, `${fixture.id}.rgba.gz`, gzipSync(rawPixels));
          observations.push({
            fixture,
            width: image.width,
            height: image.height,
            packet: image.packet,
            nativeVertices: image.positions,
            report,
            positionReport,
          });
          if (!report.pass) failures.push(`${fixture.id}: ${report.failures.join('; ')}`);
          if (positionReport !== null && !positionReport.pass)
            failures.push(
              `${fixture.id}: native position error ${positionReport.maximumError}: ${positionReport.reason}`,
            );
        }
        const state = await page.evaluate(() => window.__vectorStudioP1.snapshot());
        const disposed = await page.evaluate(() => window.__vectorStudioP1.dispose());
        const sourceAtEnd = p1Source();
        p1Write(
          directory,
          'observations.json',
          JSON.stringify(
            {
              schema: 'p1-functional-v1',
              timestampUtc: new Date().toISOString(),
              command: 'pnpm test:gpu',
              source,
              sourceAtEnd,
              headed: true,
              build: 'development',
              browser: { channel: info.project.name, version: browser.version() },
              operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
              capability,
              dpr,
              samples,
              readback:
                'GPU COPY_SRC canvas texture, BGRA swizzled to raw premultiplied RGBA; PNG separately unpremultiplied',
              injection:
                'Only transparent clear, COPY_SRC usage, explicit 4x rejection for 1x fallback, and post-submit staging copies; production shader and packet path unmodified',
              observations,
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
        expect(sourceAtEnd.manifestSha256).toBe(source.manifestSha256);
        expect(pageErrors).toEqual([]);
        expect(state.diagnostics.filter((event) => event.severity === 'error')).toEqual([]);
        expect(disposed.resources.live).toBe(0);
      });
    }
  }

  test(`P1 latest-scene recovery samples${samples}`, async ({ page, browser }, info) => {
    const directory = p1EvidenceDirectory(info);
    const source = p1Source();
    p1Write(directory, 'source.json', JSON.stringify(source, null, 2));
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`/p1-fixture.html?samples=${samples}`);
    const capability = await page.evaluate(() => window.__vectorStudioP1.ready);
    expect(capability.supported, JSON.stringify(capability)).toBe(true);
    if (capability.supported) expect(capability.capabilities.sampleCount).toBe(samples);
    const fixture = visualFixtures()[0]!;
    const before = await render(page, fixture, 1);
    const beforeState = await page.evaluate(() => window.__vectorStudioP1.snapshot());
    const warmPackets = [];
    for (let index = 0; index < 3; index++) {
      const warm = await page.evaluate(() => window.__vectorStudioP1.redraw());
      expect(warm.packet.writes).toEqual([]);
      expect(warm.rgbaBase64).toBe(before.rgbaBase64);
      warmPackets.push(warm.packet);
    }
    const original = fixture.snapshot.nodes[0]!;
    const updated = { ...original, transform: [1, 0, 0, 1, 140, 100] as const };
    const changes: RenderChangeSet = {
      identity: fixture.snapshot.identity,
      baseRevision: before.packet.revision,
      revision: before.packet.revision + 1,
      inserted: [],
      removed: [],
      updated: [updated],
      orders: [],
    };
    const edited = await page.evaluate((delta) => window.__vectorStudioP1.edit(delta), changes);
    const warmState = await page.evaluate(() => window.__vectorStudioP1.snapshot());
    expect(warmState.statistics.pipelinesCreated).toBe(beforeState.statistics.pipelinesCreated);
    expect(warmState.statistics.shaderModulesCreated).toBe(
      beforeState.statistics.shaderModulesCreated,
    );
    expect(warmState.statistics.framesSubmitted).toBe(beforeState.statistics.framesSubmitted + 4);
    expect(edited.packet.writes).toEqual([{ resource: 'transforms', offset: 0, bytes: 32 }]);
    const recoveredNode = { ...updated, transform: [1, 0, 0, 1, 300, 180] as const };
    const recoveryChanges = {
      ...changes,
      baseRevision: changes.revision,
      revision: changes.revision + 1,
      updated: [recoveredNode],
    };
    const recovered = await page.evaluate(
      (delta) => window.__vectorStudioP1.recoverWithEdit(delta),
      recoveryChanges,
    );
    const expectedFixture = {
      ...fixture,
      snapshot: { ...fixture.snapshot, nodes: [recoveredNode] },
    };
    const report = inspectPixels(
      expectedFixture,
      1,
      recovered.width,
      recovered.height,
      Buffer.from(recovered.rgbaBase64, 'base64'),
    );
    const rejection = await page.evaluate((snapshot) => window.__vectorStudioP1.reject(snapshot), {
      ...invalidContainerSnapshot(),
      revision: recoveryChanges.revision + 1,
    });
    const afterRejection = await page.evaluate(() => window.__vectorStudioP1.redraw());
    const finalState = await page.evaluate(() => window.__vectorStudioP1.snapshot());
    const disposed = await page.evaluate(() => window.__vectorStudioP1.dispose());
    const sourceAtEnd = p1Source();
    for (const [name, frame] of [
      ['before', before],
      ['edited', edited],
      ['recovered', recovered],
    ] as const) {
      p1Write(directory, `${name}.png`, Buffer.from(frame.png.split(',')[1]!, 'base64'));
      p1Write(directory, `${name}.rgba.gz`, gzipSync(Buffer.from(frame.rgbaBase64, 'base64')));
    }
    p1Write(
      directory,
      'observations.json',
      JSON.stringify(
        {
          source,
          sourceAtEnd,
          timestampUtc: new Date().toISOString(),
          command: 'pnpm test:gpu',
          headed: true,
          browser: { channel: info.project.name, version: browser.version() },
          operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
          capability,
          samples,
          dpr: 1,
          expectedFixture,
          beforeState,
          warmState,
          warmPackets,
          finalState,
          disposed,
          report,
          rejection,
          beforePacket: before.packet,
          editedPacket: edited.packet,
          recoveredPacket: recovered.packet,
          pageErrors,
        },
        null,
        2,
      ),
    );
    expect(report.failures).toEqual([]);
    expect(recovered.packet).toMatchObject({
      revision: recoveryChanges.revision,
      generation: before.packet.generation + 1,
      mode: 'reconstruct',
    });
    expect(finalState.statistics.recoveryAttempts).toBe(1);
    expect(finalState.statistics.pipelinesCreated).toBe(
      beforeState.statistics.pipelinesCreated + 1,
    );
    expect(finalState.statistics.pendingFrameCallbacks).toBe(0);
    const oldGeneration = beforeState.statistics.generation;
    const newGeneration = oldGeneration + 1;
    const lifecycleCodes = ['device-loss.detected', 'recovery.started', 'recovery.succeeded'];
    const lifecycle = finalState.diagnostics.filter((event) => lifecycleCodes.includes(event.code));
    expect(
      lifecycle.map(({ code, severity, generation }) => ({ code, severity, generation })),
    ).toEqual([
      { code: 'device-loss.detected', severity: 'error', generation: oldGeneration },
      { code: 'recovery.started', severity: 'info', generation: newGeneration },
      { code: 'recovery.succeeded', severity: 'info', generation: newGeneration },
    ]);
    expect(lifecycle[0]!.context).toMatchObject({ reason: 'destroyed' });
    expect(lifecycle[1]!.context).toEqual({ lostGeneration: oldGeneration });
    expect(lifecycle[2]!.context).toEqual({ lostGeneration: oldGeneration });
    expect(finalState.diagnostics.filter((event) => event.severity === 'error')).toEqual([
      lifecycle[0],
    ]);
    expect(finalState.statistics).toMatchObject({
      lifecycle: 'ready',
      generation: newGeneration,
      recoveryAttempts: 1,
      staleGenerationSubmissions: 0,
    });
    expect(rejection).toMatchObject({ status: 'invalid-scene', reason: 'unsupported-feature' });
    expect(afterRejection.rgbaBase64).toBe(recovered.rgbaBase64);
    expect(disposed.resources.live).toBe(0);
    expect(pageErrors).toEqual([]);
    expect(sourceAtEnd.manifestSha256).toBe(source.manifestSha256);
  });
}
