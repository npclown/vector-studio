import { createHash } from 'node:crypto';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { P3CoveragePageApi } from '../../apps/playground/src/p3-coverage.js';
import { P3_COVERAGE_SHADERS } from '../../apps/playground/src/p3-coverage-shaders.js';
import { p3CoverageLaunchArguments } from '../../playwright.p3-coverage.config.js';
import { cropFor } from '../geometry/coverage-oracle/crop.js';
import { coverageCorpus, coverageRowGeometry } from '../geometry/coverage-oracle/positions.js';
import { encodeInput } from '../geometry/position-certificate/corpus.js';
import { buildRow, wordsOf } from '../support/p3-coverage-build.js';
import {
  caseDirectory,
  contractIdentity,
  sameManifest,
  sourceManifest,
  type SourceManifest,
  writeExclusiveJson,
} from '../support/p3-coverage-evidence.js';

declare global {
  interface Window {
    __vectorStudioP3Coverage: P3CoveragePageApi;
  }
}

// P3.1o O01 runner (docs/plans/p3-o01-coverage-experiment-contract.md): runner gates only.
const INIT_TIMEOUT = 15_000;
const RENDER_TIMEOUT = 10_000;
const DISPOSE_TIMEOUT = 5_000;
const CASE_LIMIT = 1_200_000;
const PART_LIMIT = 25 * 1024 * 1024;
const CANDIDATES = ['A1', 'A2', 'A5'] as const;

type CaseStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'INTERRUPTED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'DEVICE_ERROR'
  | 'DEVICE_LOST'
  | 'RUNNER_ERROR';

class BoundExceeded extends Error {}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

async function runCase(page: Page, browser: Browser, info: TestInfo) {
  const started = Date.now();
  const directory = caseDirectory(info);
  let status: CaseStatus | null = null;
  const reasons: string[] = [];
  let sourceStart: SourceManifest | null = null;
  let identity: ReturnType<typeof contractIdentity> | null = null;
  let init: Awaited<ReturnType<P3CoveragePageApi['init']>> | null = null;
  let cleanup: unknown;
  let cleanupPass = false;
  let userAgent: string | null = null;
  const rows: Record<string, unknown>[] = [];
  const shaderSha256 = Object.fromEntries(
    CANDIDATES.map((candidate) => [candidate, sha256(P3_COVERAGE_SHADERS[candidate])]),
  );

  try {
    sourceStart = sourceManifest();
    identity = contractIdentity(sourceStart.baseCommit);
    if (
      !identity.ancestorOfBase ||
      identity.blobIdAtCommit === null ||
      identity.noteSha256AtCommit !== identity.workingTreeNoteSha256
    )
      throw new Error('contract-identity');
    await bounded(page.goto('/p3-coverage.html'), INIT_TIMEOUT, 'goto');
    userAgent = await bounded(
      page.evaluate(() => navigator.userAgent),
      INIT_TIMEOUT,
      'user-agent',
    );
    init = await bounded(
      page.evaluate(() => window.__vectorStudioP3Coverage.init()),
      INIT_TIMEOUT,
      'init',
    );
    if (init.status !== 'READY') {
      status = init.status;
      reasons.push(init.reason ?? init.status);
    } else if (JSON.stringify(init.shaderSha256) !== JSON.stringify(shaderSha256)) {
      status = 'RUNNER_ERROR';
      reasons.push('shader-sha256');
    }
    for (const row of coverageCorpus()) {
      if (status !== null) break;
      if (Date.now() - started > CASE_LIMIT) {
        status = 'INTERRUPTED';
        reasons.push('case-limit');
        break;
      }
      const base = {
        rowIndex: row.rowIndex,
        id: row.id,
        kind: row.kind,
        input: encodeInput(row.input),
        width: row.input.width,
        height: row.input.height,
      };
      const geometry = coverageRowGeometry(row.input);
      if ('unsupported' in geometry) {
        rows.push({
          ...base,
          status: 'INPUT_UNSUPPORTED',
          reason: geometry.unsupported,
          crop: null,
          crops: [],
        });
        continue;
      }
      const crop = cropFor(geometry);
      if (crop === null) {
        rows.push({ ...base, status: 'EMPTY_CROP', reason: null, crop: null, crops: [] });
        continue;
      }
      const built = buildRow(geometry, crop);
      const expectedUpload = {
        soup: sha256(built.soup),
        fringe: sha256(built.fringe),
        uniform: sha256(
          new Uint8Array(new Float32Array([built.origin[0], built.origin[1], 0, 0]).buffer),
        ),
      };
      const result = await bounded(
        page.evaluate((request) => window.__vectorStudioP3Coverage.render(request), {
          rowIndex: row.rowIndex,
          width: geometry.width,
          height: geometry.height,
          crop,
          origin: built.origin,
          soupBase64: base64(built.soup),
          fringeBase64: base64(built.fringe),
        }),
        RENDER_TIMEOUT,
        `render:${row.rowIndex}`,
      );
      if (result.status !== 'RENDERED') {
        status = result.status === 'ABORTED' ? 'INTERRUPTED' : result.status;
        reasons.push(`${result.status}:${result.reason}`);
        rows.push({ ...base, status: result.status, reason: result.reason, crop, crops: [] });
        break;
      }
      if (JSON.stringify(result.uploadSha256) !== JSON.stringify(expectedUpload)) {
        status = 'RUNNER_ERROR';
        reasons.push(`upload-digest:${row.rowIndex}`);
        rows.push({
          ...base,
          status: 'UPLOAD_MISMATCH',
          reason: null,
          crop,
          uploadSha256: expectedUpload,
          uploadEcho: result.uploadSha256,
          crops: [],
        });
        break;
      }
      rows.push({
        ...base,
        status: 'RENDERED',
        uploadSha256: expectedUpload,
        uploadEcho: result.uploadSha256,
        reason: null,
        crop,
        origin: built.origin,
        ndcBits: geometry.ndcBits,
        edges: built.edges.map(wordsOf),
        crops: result.crops,
      });
    }
  } catch (error) {
    if (status === null) {
      status = error instanceof BoundExceeded ? 'INTERRUPTED' : 'RUNNER_ERROR';
      reasons.push(message(error));
    }
  } finally {
    try {
      await bounded(
        page.evaluate(() => window.__vectorStudioP3Coverage.dispose()),
        DISPOSE_TIMEOUT,
        'dispose',
      );
      const snapshot = await bounded(
        page.evaluate(() => window.__vectorStudioP3Coverage.snapshot()),
        DISPOSE_TIMEOUT,
        'snapshot',
      );
      cleanup = snapshot;
      cleanupPass =
        snapshot.state === 'DISPOSED' &&
        snapshot.texturesCreated === snapshot.texturesDestroyed &&
        snapshot.buffersCreated === snapshot.buffersDestroyed &&
        snapshot.deviceDestroyed;
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
  const corpusSize = coverageCorpus().length;
  if (status === null) {
    const partial: string[] = [];
    if (!sourceSame) partial.push('source-changed');
    if (rows.length !== corpusSize) partial.push('rows-incomplete');
    if (!cleanupPass) partial.push('cleanup');
    status = partial.length === 0 ? 'COMPLETE' : 'PARTIAL';
    reasons.push(...partial);
  } else if (!sourceSame) reasons.push('source-changed');

  const header = {
    schema: 'p3-coverage-capture-v1',
    contract: { ...identity, shaderSha256 },
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    project: info.project.name,
    browserVersion: browser.version(),
    userAgent,
    launchArguments: p3CoverageLaunchArguments,
    adapter: init?.adapter ?? null,
    limits: init?.limits ?? null,
    pageShaderSha256: init?.shaderSha256 ?? null,
    status,
    reasons,
    sourceStart,
    sourceEnd,
    cleanup,
  };
  const whole = `${JSON.stringify({ ...header, rows }, null, 2)}\n`;
  if (Buffer.byteLength(whole) <= PART_LIMIT)
    writeExclusiveJson(directory, 'capture.json', { ...header, rows });
  else {
    const partsFor = (head: typeof header) =>
      CANDIDATES.map((candidate) => ({
        candidate,
        name: `capture-${candidate}.json`,
        part: {
          ...head,
          rows: rows.map((row) => ({
            ...row,
            crops: (row.crops as { candidate: string }[]).filter(
              (crop) => crop.candidate === candidate,
            ),
          })),
        },
      }));
    const oversize = partsFor(header).filter(
      ({ part }) =>
        Buffer.byteLength(`${JSON.stringify(part, null, 2)}
`) > PART_LIMIT,
    );
    let finalHeader = header;
    if (oversize.length > 0) {
      reasons.push(...oversize.map(({ candidate }) => `part-over-limit:${candidate}`));
      status = 'PARTIAL';
      finalHeader = { ...header, status, reasons: [...reasons] };
    }
    const parts = partsFor(finalHeader).map(({ name, part }) => ({
      path: name,
      sha256: writeExclusiveJson(directory, name, part),
    }));
    writeExclusiveJson(directory, 'capture-index.json', {
      schema: 'p3-coverage-capture-index-v1',
      parts,
    });
  }
  return { status, reasons, cleanupPass, rows, corpusSize };
}

test('coverage corpus', async ({ page, browser }, info) => {
  const result = await runCase(page, browser, info);
  expect(result.reasons).toEqual([]);
  expect(result.status).toBe('COMPLETE');
  expect(result.cleanupPass).toBe(true);
  expect(result.rows).toHaveLength(result.corpusSize);
  for (const row of result.rows)
    expect(['RENDERED', 'INPUT_UNSUPPORTED', 'EMPTY_CROP'], String(row.id)).toContain(row.status);
});
