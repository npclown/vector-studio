import os from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import {
  captureEvidenceScreenshot,
  evidenceSource,
  writeEvidenceJson,
} from '../support/evidence-output.js';
import {
  inspectFoundationPng,
  type FoundationImageMetrics,
  type FoundationImageSample,
} from '../support/foundation-image.js';
import '../support/playground-api.js';

const FIXTURE_ID = 'camera-triangle-v1';
const DOCUMENT_VERTICES = Object.freeze([0, 0, 100, 0, 0, 60]);
const EXPECTED_DIAGNOSTIC_CODES = new Set([
  'capability.msaa-fallback',
  'device-loss.detected',
  'recovery.started',
  'recovery.succeeded',
  'disposal.completed',
]);

interface DprFixture {
  readonly dpr: number;
  readonly slug: string;
  readonly physicalSize: Readonly<{ width: number; height: number }>;
  readonly expectedVertices: readonly number[];
  readonly samples: readonly FoundationImageSample[];
}

const DPR_FIXTURES: readonly DprFixture[] = [
  {
    dpr: 1,
    slug: '1',
    physicalSize: { width: 640, height: 360 },
    expectedVertices: [30, 15, 180, 15, 30, 105],
    samples: [
      { name: 'interior', x: 60, y: 30, expectedForeground: true },
      { name: 'exterior-above', x: 30, y: 5, expectedForeground: false },
      { name: 'exterior-lower-right', x: 170, y: 95, expectedForeground: false },
    ],
  },
  {
    dpr: 1.5,
    slug: '1-5',
    physicalSize: { width: 960, height: 540 },
    expectedVertices: [45, 22.5, 270, 22.5, 45, 157.5],
    samples: [
      { name: 'interior', x: 90, y: 45, expectedForeground: true },
      { name: 'exterior-above', x: 45, y: 8, expectedForeground: false },
      { name: 'exterior-lower-right', x: 255, y: 143, expectedForeground: false },
    ],
  },
  {
    dpr: 2,
    slug: '2',
    physicalSize: { width: 1280, height: 720 },
    expectedVertices: [60, 30, 360, 30, 60, 210],
    samples: [
      { name: 'interior', x: 120, y: 60, expectedForeground: true },
      { name: 'exterior-above', x: 60, y: 10, expectedForeground: false },
      { name: 'exterior-lower-right', x: 340, y: 190, expectedForeground: false },
    ],
  },
] as const;

async function waitForLatestExperimentCompletion(page: Page): Promise<void> {
  const submittedSerial = await page.evaluate(() => {
    const experiment = window.__vectorStudioP0.getFoundationExperimentSnapshot();
    if (experiment === undefined) throw new Error('Foundation experiment is unavailable.');
    return experiment.submittedSerial;
  });
  expect(submittedSerial).toBeGreaterThan(0);
  await page.evaluate(() => window.__vectorStudioP0.waitForSubmittedWork());
  await page.waitForFunction((serial) => {
    const backend = window.__vectorStudioP0.snapshot();
    const experiment = window.__vectorStudioP0.getFoundationExperimentSnapshot();
    return (
      backend.statistics.pendingFrameCallbacks === 0 &&
      experiment !== undefined &&
      experiment.completedSerial >= serial &&
      experiment.completedSerial === experiment.submittedSerial
    );
  }, submittedSerial);
}

function expectLiteralVertices(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(
      Math.abs((actual[index] ?? Number.NaN) - (expected[index] ?? Number.NaN)),
    ).toBeLessThanOrEqual(1);
  }
}

function expectImageOracle(metrics: FoundationImageMetrics, fixture: DprFixture): void {
  expect({ width: metrics.width, height: metrics.height }).toEqual(fixture.physicalSize);
  expect(metrics.foregroundPixelCount).toBeGreaterThan(0);
  expect(metrics.foregroundBounds).toBeDefined();
  expect(metrics.observedVertices).toBeDefined();
  expectLiteralVertices(metrics.observedVertices ?? [], fixture.expectedVertices);
  for (const sample of metrics.samples) {
    expect(sample.foreground, sample.name).toBe(sample.expectedForeground);
  }
}

function expectInitialOwnership(
  backend: ReturnType<Window['__vectorStudioP0']['snapshot']>,
  experiment: NonNullable<
    ReturnType<Window['__vectorStudioP0']['getFoundationExperimentSnapshot']>
  >,
  fixture: DprFixture,
): void {
  expect(backend.state).toBe('ready');
  expect(backend.surfaceSize).toEqual({
    css: { width: 640, height: 360 },
    devicePixelRatio: fixture.dpr,
    physical: fixture.physicalSize,
    suspended: false,
  });
  expect(experiment).toMatchObject({
    disposed: false,
    allocator: {
      generation: 1,
      disposed: false,
      capacityBytes: 256,
      alignment: 4,
      liveAllocationCount: 2,
      liveRequestedBytes: 60,
      liveAllocatedBytes: 60,
      retiredBytes: 0,
      reservedBytes: 60,
      peakReservedBytes: 60,
    },
    allocations: {
      positions: { id: 1, offset: 0, requestedBytes: 24, allocatedBytes: 24 },
      colors: { id: 2, offset: 24, requestedBytes: 36, allocatedBytes: 36 },
    },
    camera: { position: { x: -20, y: -10 }, zoom: 1.5, devicePixelRatio: fixture.dpr },
    physicalSize: fixture.physicalSize,
    documentVertices: DOCUMENT_VERTICES,
    bindingGeneration: 1,
    pendingNativeCreations: 0,
    backingBufferCreations: 1,
    liveBackingBuffers: 1,
    pipelineCreations: 1,
    livePipelines: 1,
    cache: {
      generation: 1,
      disposed: false,
      pendingEntries: 0,
      readyEntries: 1,
      successfulCreations: 1,
    },
  });
  expect(experiment.physicalVertices).toEqual(fixture.expectedVertices);
  expect([2, 4]).toContain(experiment.pipelineRequests);
  expect(experiment.submittedSerial).toBeGreaterThanOrEqual(1);
  expect(experiment.completedSerial).toBe(experiment.submittedSerial);
  expect(backend.statistics.resources.byCategory.buffer).toMatchObject({
    live: 1,
    liveBytes: 256,
    peakLiveBytes: 256,
  });
}

for (const fixture of DPR_FIXTURES) {
  test.describe(`camera triangle at DPR ${fixture.dpr}`, () => {
    test.use({ deviceScaleFactor: fixture.dpr });

    test('preserves camera, shared-buffer, and pipeline-cache evidence through recovery', async ({
      browser,
      page,
    }, testInfo) => {
      const source = evidenceSource(testInfo);
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));

      await page.goto(`/?fixture=${FIXTURE_ID}`);
      await page.waitForFunction(
        () =>
          window.__vectorStudioP0?.snapshot().state === 'ready' &&
          (window.__vectorStudioP0.getFoundationExperimentSnapshot()?.submittedSerial ?? 0) >= 1,
      );
      await waitForLatestExperimentCompletion(page);

      const initial = await page.evaluate(() => ({
        backend: window.__vectorStudioP0.snapshot(),
        experiment: window.__vectorStudioP0.getFoundationExperimentSnapshot(),
        browserDevicePixelRatio: window.devicePixelRatio,
        canvasBackingSize: {
          width: document.querySelector<HTMLCanvasElement>('#webgpu-surface')?.width,
          height: document.querySelector<HTMLCanvasElement>('#webgpu-surface')?.height,
        },
      }));
      if (initial.experiment === undefined)
        throw new Error('Foundation experiment is unavailable.');
      expect(initial.browserDevicePixelRatio).toBe(fixture.dpr);
      expect(initial.canvasBackingSize).toEqual(fixture.physicalSize);
      expectInitialOwnership(initial.backend, initial.experiment, fixture);

      const artifactPrefix = `foundation-${FIXTURE_ID}-dpr-${fixture.slug}-${testInfo.project.name}`;
      const initialScreenshotName = `${artifactPrefix}-initial.png`;
      const initialScreenshot = await captureEvidenceScreenshot(
        testInfo,
        initialScreenshotName,
        page.locator('#webgpu-surface'),
      );
      const initialImage = await inspectFoundationPng(page, initialScreenshot, fixture.samples);
      expectImageOracle(initialImage, fixture);

      await page.evaluate(() => window.__vectorStudioP0.setMode('continuous'));
      await page.waitForFunction(
        (submitted) =>
          (window.__vectorStudioP0.getFoundationExperimentSnapshot()?.submittedSerial ?? 0) >=
          submitted + 5,
        initial.experiment.submittedSerial,
      );
      await page.evaluate(() => window.__vectorStudioP0.setMode('on-demand'));
      await waitForLatestExperimentCompletion(page);
      const steady = await page.evaluate(() => ({
        backend: window.__vectorStudioP0.snapshot(),
        experiment: window.__vectorStudioP0.getFoundationExperimentSnapshot(),
      }));
      if (steady.experiment === undefined) throw new Error('Foundation experiment is unavailable.');
      expect(
        steady.experiment.submittedSerial - initial.experiment.submittedSerial,
      ).toBeGreaterThanOrEqual(5);
      expect(steady.experiment.completedSerial).toBe(steady.experiment.submittedSerial);
      expect(steady.experiment.pipelineRequests).toBe(initial.experiment.pipelineRequests);
      expect(steady.experiment.pipelineCreations).toBe(initial.experiment.pipelineCreations);
      expect(steady.experiment.backingBufferCreations).toBe(
        initial.experiment.backingBufferCreations,
      );
      expect(steady.experiment.cache).toEqual(initial.experiment.cache);
      expect(steady.backend.statistics.pipelinesCreated).toBe(
        initial.backend.statistics.pipelinesCreated,
      );
      expect(steady.backend.statistics.resources.byCategory.buffer).toEqual(
        initial.backend.statistics.resources.byCategory.buffer,
      );

      await page.evaluate(() => window.__vectorStudioP0.destroyDeviceForTesting());
      await page.waitForFunction((generation) => {
        const backend = window.__vectorStudioP0.snapshot();
        const experiment = window.__vectorStudioP0.getFoundationExperimentSnapshot();
        return (
          backend.state === 'ready' &&
          backend.statistics.generation === generation + 1 &&
          experiment?.bindingGeneration === generation + 1 &&
          experiment.submittedSerial >= 1
        );
      }, initial.backend.statistics.generation);
      await waitForLatestExperimentCompletion(page);
      const recovered = await page.evaluate(() => ({
        backend: window.__vectorStudioP0.snapshot(),
        experiment: window.__vectorStudioP0.getFoundationExperimentSnapshot(),
        canvasBackingSize: {
          width: document.querySelector<HTMLCanvasElement>('#webgpu-surface')?.width,
          height: document.querySelector<HTMLCanvasElement>('#webgpu-surface')?.height,
        },
      }));
      if (recovered.experiment === undefined) {
        throw new Error('Recovered foundation experiment is unavailable.');
      }
      expect(recovered.canvasBackingSize).toEqual(fixture.physicalSize);
      expect(recovered.backend.statistics).toMatchObject({
        lifecycle: 'ready',
        generation: initial.backend.statistics.generation + 1,
        recoveryAttempts: 1,
        staleGenerationSubmissions: 0,
        pipelinesCreated: 2,
      });
      expect(recovered.experiment).toMatchObject({
        allocator: {
          generation: 2,
          disposed: false,
          capacityBytes: 256,
          liveAllocationCount: 2,
          liveRequestedBytes: 60,
          liveAllocatedBytes: 60,
          retiredBytes: 0,
          reservedBytes: 60,
          peakReservedBytes: 60,
        },
        allocations: initial.experiment.allocations,
        documentVertices: DOCUMENT_VERTICES,
        physicalVertices: fixture.expectedVertices,
        bindingGeneration: 2,
        pendingNativeCreations: 0,
        backingBufferCreations: 2,
        liveBackingBuffers: 1,
        pipelineCreations: 2,
        livePipelines: 1,
        cache: {
          generation: 2,
          disposed: false,
          pendingEntries: 0,
          readyEntries: 1,
          successfulCreations: 2,
        },
      });
      expect([2, 4]).toContain(
        recovered.experiment.pipelineRequests - initial.experiment.pipelineRequests,
      );
      expect(recovered.experiment.submittedSerial).toBeGreaterThanOrEqual(1);
      expect(recovered.experiment.completedSerial).toBe(recovered.experiment.submittedSerial);
      expect(recovered.backend.statistics.resources.byCategory.buffer).toMatchObject({
        live: 1,
        liveBytes: 256,
        peakLiveBytes: 256,
      });

      const recoveredScreenshotName = `${artifactPrefix}-recovered.png`;
      const recoveredScreenshot = await captureEvidenceScreenshot(
        testInfo,
        recoveredScreenshotName,
        page.locator('#webgpu-surface'),
      );
      const recoveredImage = await inspectFoundationPng(page, recoveredScreenshot, fixture.samples);
      expectImageOracle(recoveredImage, fixture);

      await page.evaluate(() => window.__vectorStudioP0.dispose());
      const disposed = await page.evaluate(() => ({
        backend: window.__vectorStudioP0.snapshot(),
        experiment: window.__vectorStudioP0.getFoundationExperimentSnapshot(),
      }));
      if (disposed.experiment === undefined) throw new Error('Disposed experiment is unavailable.');
      expect(disposed.backend.statistics.resources).toMatchObject({ live: 0, liveBytes: 0 });
      expect(disposed.backend.statistics.resources.byCategory.buffer).toMatchObject({
        live: 0,
        liveBytes: 0,
      });
      expect(disposed.experiment).toMatchObject({
        disposed: true,
        allocator: {
          disposed: true,
          liveAllocationCount: 0,
          liveRequestedBytes: 0,
          liveAllocatedBytes: 0,
          retiredBytes: 0,
          reservedBytes: 0,
          peakReservedBytes: 60,
        },
        pendingNativeCreations: 0,
        liveBackingBuffers: 0,
        livePipelines: 0,
        cache: { disposed: true, pendingEntries: 0, readyEntries: 0 },
      });

      const lifecycleDiagnostics = disposed.backend.diagnostics
        .filter(({ code }) =>
          ['device-loss.detected', 'recovery.started', 'recovery.succeeded'].includes(code ?? ''),
        )
        .map(({ code, generation }) => ({ code, generation }));
      expect(lifecycleDiagnostics).toEqual([
        { code: 'device-loss.detected', generation: 1 },
        { code: 'recovery.started', generation: 2 },
        { code: 'recovery.succeeded', generation: 2 },
      ]);
      const fallbackDiagnostics = disposed.backend.diagnostics.filter(
        ({ code }) => code === 'capability.msaa-fallback',
      );
      expect(fallbackDiagnostics).toHaveLength(
        Number(initial.backend.capability.capabilities?.sampleCount === 1) +
          Number(recovered.backend.capability.capabilities?.sampleCount === 1),
      );
      const unexpectedDiagnostics = disposed.backend.diagnostics.filter(
        ({ code }) => !EXPECTED_DIAGNOSTIC_CODES.has(code ?? ''),
      );
      expect(unexpectedDiagnostics).toEqual([]);
      expect(pageErrors).toEqual([]);

      await writeEvidenceJson(testInfo, `${artifactPrefix}.json`, {
        timestampUtc: new Date().toISOString(),
        command: 'pnpm test:gpu',
        ...source,
        headed: true,
        fixtureId: FIXTURE_ID,
        operatingSystem: `${os.platform()} ${os.release()} ${os.arch()}`,
        browser: { channel: testInfo.project.name, version: browser.version() },
        adapter: initial.backend.capability.capabilities?.adapter ?? {},
        limits: initial.backend.capability.capabilities?.limits ?? {},
        selectedFeatures: initial.backend.capability.capabilities?.selectedFeatures ?? [],
        sampleCount: initial.backend.capability.capabilities?.sampleCount,
        emulatedDevicePixelRatio: fixture.dpr,
        cssSize: { width: 640, height: 360 },
        expectedPhysicalSize: fixture.physicalSize,
        expectedDocumentVertices: DOCUMENT_VERTICES,
        expectedPhysicalVertices: fixture.expectedVertices,
        stages: { initial, steady, recovered, disposed },
        screenshots: {
          initial: path.basename(initialScreenshot),
          recovered: path.basename(recoveredScreenshot),
        },
        imageMetrics: { initial: initialImage, recovered: recoveredImage },
        observedDiagnostics: disposed.backend.diagnostics,
        unexpectedDiagnostics,
        pageErrors,
      });
    });
  });
}
