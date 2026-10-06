import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { P3ProjectionPageApi } from '../../apps/playground/src/p3-native-projection.js';
import { P3_NATIVE_PROJECTION_WGSL } from '../../apps/playground/src/p3-native-projection-shader.js';
import { p3NativeProjectionLaunchArguments } from '../../playwright.p3-native-projection.config.js';
import {
  fixedProjectionFixtures,
  type ProjectionFixture,
} from '../geometry/mesh-projection/fixtures.js';
import {
  auditPackedRow,
  checkArchivedInputs,
  encodeArchivedInput,
  inputSha256,
} from '../geometry/native-projection/byte-audit.js';
import { classifyNativeProjection } from '../geometry/native-projection/classify.js';
import { decodeCapture } from '../geometry/native-projection/decode.js';
import {
  CONTROL_CAPTURE_TAG,
  CORPUS_CAPTURE_TAG_BASE,
  packNativeProjectionRow,
} from '../geometry/native-projection/pack.js';
import {
  caseDirectory,
  contractIdentity,
  contractWgslBlock,
  K_ARCHIVE,
  sameManifest,
  sha256OfFile,
  sourceManifest,
  type SourceManifest,
  writeExclusiveJson,
} from '../support/p3-native-projection-evidence.js';

declare global {
  interface Window {
    __vectorStudioP3Projection: P3ProjectionPageApi;
  }
}

const INIT_TIMEOUT = 15_000;
const CAPTURE_TIMEOUT = 3_000;
const DISPOSE_TIMEOUT = 5_000;
const CASE_LIMIT = 540_000;
const CLASSIFIER_SOURCES = [
  'tests/geometry/native-projection/decode.ts',
  'tests/geometry/native-projection/classify.ts',
  'tests/geometry/conforming-mesh/oracle.ts',
  'tests/geometry/rounded-fill/exact.ts',
  'tests/geometry/mesh-projection/audit.ts',
] as const;

type CaseStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'INTERRUPTED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'DEVICE_ERROR'
  | 'DEVICE_LOST'
  | 'RUNNER_ERROR';

type Mode = 'control' | 'corpus';

interface RowRecord {
  id: string;
  rowIndex: number;
  kDispositionHistorical: string;
  input: unknown;
  inputSha256: string;
  vertexCount: number;
  drawCount: number;
  captureTag: number;
  pack: string;
  uniformBase64: string | null;
  uniformSha256: string | null;
  verticesBase64: string | null;
  verticesSha256: string | null;
  uploadEcho: unknown;
  readbackBase64: string | null;
  readbackSha256: string | null;
  capture: string;
}

class BoundExceeded extends Error {}

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BoundExceeded(label)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function runCase(page: Page, browser: Browser, info: TestInfo, mode: Mode) {
  const started = Date.now();
  // Only an unusable case directory may be fatal; every later failure is recorded.
  const directory = caseDirectory(info);
  let status: CaseStatus | null = null;
  const reasons: string[] = [];
  let init: Awaited<ReturnType<P3ProjectionPageApi['init']>> | null = null;
  let cleanup: unknown;
  let cleanupPass = false;
  let userAgent: string | null = null;
  let sourceStart: SourceManifest | null = null;
  let identity: ReturnType<typeof contractIdentity> | null = null;
  let fixtures: readonly ProjectionFixture[] = [];
  let rows: RowRecord[] = [];
  const clipWords = new Map<number, readonly (readonly [number, number])[]>();

  try {
    sourceStart = sourceManifest();
    identity = contractIdentity(sourceStart.baseCommit);
    if (
      !identity.ancestorOfBase ||
      identity.blobIdAtCommit === null ||
      identity.noteSha256AtCommit !== identity.workingTreeNoteSha256
    )
      throw new Error('contract-identity');
    if (contractWgslBlock() !== `${P3_NATIVE_PROJECTION_WGSL}\n`)
      throw new Error('contract-shader-text');
    const archive = JSON.parse(readFileSync(K_ARCHIVE, 'utf8')) as {
      rows: { kind: string; candidate: unknown }[];
    };
    const archivedMesh = archive.rows.filter((row) => row.kind === 'mesh');
    fixtures = fixedProjectionFixtures();
    const selected = mode === 'corpus' ? fixtures.map((_, index) => index) : [0];
    const digests = await Promise.all(
      selected.map((rowIndex) => inputSha256(fixtures[rowIndex]!.input)),
    );
    rows = selected.map((rowIndex, position): RowRecord => {
      const fixture = fixtures[rowIndex]!;
      const captureTag =
        mode === 'corpus' ? CORPUS_CAPTURE_TAG_BASE + rowIndex : CONTROL_CAPTURE_TAG;
      const vertexCount = fixture.input.mesh.vertices.length;
      return {
        id: fixture.id,
        rowIndex,
        kDispositionHistorical: fixture.disposition,
        input: encodeArchivedInput(fixture.input),
        inputSha256: digests[position]!,
        vertexCount,
        drawCount: mode === 'corpus' ? vertexCount : vertexCount - 1,
        captureTag,
        pack: 'NOT_RUN',
        uniformBase64: null,
        uniformSha256: null,
        verticesBase64: null,
        verticesSha256: null,
        uploadEcho: null,
        readbackBase64: null,
        readbackSha256: null,
        capture: 'NOT_RUN',
      };
    });
    checkArchivedInputs(fixtures, archive);
    for (const row of rows) {
      const input = fixtures[row.rowIndex]!.input;
      const packed = packNativeProjectionRow(input, row.rowIndex, row.captureTag);
      if (packed.status !== 'PACKED') throw new Error(`provenance:pack:${packed.stage}`);
      auditPackedRow(
        input,
        row.rowIndex,
        row.captureTag,
        packed.uniform,
        packed.vertices,
        archivedMesh[row.rowIndex]!.candidate,
      );
      row.pack = 'PACKED';
      row.uniformBase64 = base64(packed.uniform);
      row.uniformSha256 = sha256(packed.uniform);
      row.verticesBase64 = base64(packed.vertices);
      row.verticesSha256 = sha256(packed.vertices);
    }
  } catch (error) {
    status = 'RUNNER_ERROR';
    reasons.push(message(error));
  }

  try {
    if (status === null) {
      await bounded(page.goto('/p3-native-projection.html'), INIT_TIMEOUT, 'goto');
      userAgent = await bounded(
        page.evaluate(() => navigator.userAgent),
        INIT_TIMEOUT,
        'user-agent',
      );
      init = await bounded(
        page.evaluate(() => window.__vectorStudioP3Projection.init()),
        INIT_TIMEOUT,
        'init',
      );
      if (init.status !== 'READY') {
        status = init.status;
        reasons.push(init.reason ?? init.status);
      } else if (init.shaderSha256 !== sha256(P3_NATIVE_PROJECTION_WGSL)) {
        status = 'RUNNER_ERROR';
        reasons.push('shader-sha256');
      }
    }
    for (const row of rows) {
      if (status !== null) break;
      if (Date.now() - started > CASE_LIMIT) {
        status = 'INTERRUPTED';
        reasons.push('case-limit');
        break;
      }
      const request = {
        rowIndex: row.rowIndex,
        captureTag: row.captureTag,
        drawCount: row.drawCount,
        uniformBase64: row.uniformBase64!,
        verticesBase64: row.verticesBase64!,
      };
      const result = await bounded(
        page.evaluate((value) => window.__vectorStudioP3Projection.capture(value), request),
        CAPTURE_TIMEOUT,
        `capture:${row.rowIndex}`,
      );
      if (result.status !== 'CAPTURED') {
        row.capture = `${result.status}:${result.reason}`;
        status = result.status === 'ABORTED' ? 'INTERRUPTED' : result.status;
        reasons.push(row.capture);
        break;
      }
      row.uploadEcho = result.uploadSha256;
      if (
        result.uploadSha256.uniform !== row.uniformSha256 ||
        result.uploadSha256.vertices !== row.verticesSha256
      ) {
        status = 'RUNNER_ERROR';
        reasons.push(`upload-digest:${row.rowIndex}`);
        row.capture = 'UPLOAD_MISMATCH';
        break;
      }
      const readback = new Uint8Array(Buffer.from(result.readbackBase64, 'base64'));
      row.readbackBase64 = result.readbackBase64;
      row.readbackSha256 = sha256(readback);
      const decoded = decodeCapture(readback, {
        rowIndex: row.rowIndex,
        expectedCount: row.vertexCount,
        captureTag: row.captureTag,
      });
      if (decoded.status === 'CAPTURED') {
        row.capture = 'CAPTURED';
        clipWords.set(row.rowIndex, decoded.clipWords);
      } else {
        row.capture = `CAPTURE_INVALID:${decoded.reason}`;
      }
    }
  } catch (error) {
    if (status === null) {
      status = error instanceof BoundExceeded ? 'INTERRUPTED' : 'RUNNER_ERROR';
      reasons.push(message(error));
    }
  } finally {
    try {
      await bounded(
        page.evaluate(() => window.__vectorStudioP3Projection.dispose()),
        DISPOSE_TIMEOUT,
        'dispose',
      );
      const snapshot = await bounded(
        page.evaluate(() => window.__vectorStudioP3Projection.snapshot()),
        DISPOSE_TIMEOUT,
        'snapshot',
      );
      cleanup = snapshot;
      cleanupPass =
        snapshot.state === 'DISPOSED' &&
        snapshot.buffersCreated === 3 &&
        snapshot.buffersDestroyed === 3 &&
        snapshot.texturesCreated === 2 &&
        snapshot.texturesDestroyed === 2 &&
        snapshot.deviceDestroyed &&
        snapshot.readbackMapState !== 'mapped';
    } catch (error) {
      cleanup = { status: 'UNAVAILABLE', reason: message(error) };
      if (status === null && error instanceof BoundExceeded) {
        status = 'INTERRUPTED';
        reasons.push(`${message(error)}-timeout`);
      }
    }
  }

  let sourceEnd: SourceManifest | null = null;
  try {
    sourceEnd = sourceManifest();
  } catch (error) {
    reasons.push(`source-end:${message(error)}`);
  }
  const sourceSame =
    sourceStart !== null && sourceEnd !== null && sameManifest(sourceStart, sourceEnd);
  if (status === null) {
    const partial: string[] = [];
    if (!sourceSame) partial.push('source-changed');
    if (mode === 'corpus' && rows.some((row) => row.capture.startsWith('CAPTURE_INVALID')))
      partial.push('capture-invalid');
    if (
      mode === 'control' &&
      rows[0]!.capture !== `CAPTURE_INVALID:capture:missing:${rows[0]!.vertexCount - 1}`
    )
      partial.push('control-mismatch');
    if (!cleanupPass) partial.push('cleanup');
    status = partial.length === 0 ? 'COMPLETE' : 'PARTIAL';
    reasons.push(...partial);
  } else if (!sourceSame) {
    reasons.push('source-changed');
  }

  const capture = {
    schema: 'p3-native-projection-capture-v1',
    contract: {
      ...identity,
      shaderSha256: sha256(P3_NATIVE_PROJECTION_WGSL),
      wgsl: P3_NATIVE_PROJECTION_WGSL,
    },
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    mode,
    project: info.project.name,
    browserVersion: browser.version(),
    userAgent,
    launchArguments: p3NativeProjectionLaunchArguments,
    adapter: init?.adapter ?? null,
    limits: init?.limits ?? null,
    compilationMessages: init?.compilationMessages ?? null,
    pageShaderSha256: init?.shaderSha256 ?? null,
    status,
    reasons,
    sourceStart,
    sourceEnd,
    cleanup,
    rows,
  };
  const captureSha256 = writeExclusiveJson(directory, 'capture.json', capture);

  let classificationErrors = 0;
  if (mode === 'corpus') {
    const classification = {
      schema: 'p3-native-projection-classification-v1',
      captureSha256,
      classifierSources: CLASSIFIER_SOURCES.map((file) => {
        try {
          return { path: file, sha256: sha256OfFile(file) };
        } catch (error) {
          return { path: file, error: message(error) };
        }
      }),
      rows: rows.map((row) => {
        const words = clipWords.get(row.rowIndex);
        if (words === undefined)
          return { id: row.id, rowIndex: row.rowIndex, capture: row.capture };
        try {
          return {
            id: row.id,
            rowIndex: row.rowIndex,
            result: classifyNativeProjection(fixtures[row.rowIndex]!.input, words),
          };
        } catch (error) {
          classificationErrors += 1;
          return { id: row.id, rowIndex: row.rowIndex, error: message(error) };
        }
      }),
    };
    writeExclusiveJson(directory, 'classification.json', classification);
  }
  return { status, reasons, cleanupPass, classificationErrors, rows };
}

test('native capture control', async ({ page, browser }, info) => {
  const result = await runCase(page, browser, info, 'control');
  expect(result.reasons).toEqual([]);
  expect(result.status).toBe('COMPLETE');
  expect(result.cleanupPass).toBe(true);
});

test('native projection corpus', async ({ page, browser }, info) => {
  const result = await runCase(page, browser, info, 'corpus');
  expect(result.reasons).toEqual([]);
  expect(result.status).toBe('COMPLETE');
  expect(result.cleanupPass).toBe(true);
  expect(result.rows.filter((row) => row.capture === 'CAPTURED')).toHaveLength(158);
  expect(result.classificationErrors).toBe(0);
});
