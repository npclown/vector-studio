import { createHash } from 'node:crypto';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { P3O02PageApi } from '../../apps/playground/src/p3-o02.js';
import { P3_O02_SHADERS } from '../../apps/playground/src/p3-o02-shaders.js';
import { p3O02LaunchArguments } from '../../playwright.p3-o02.config.js';
import { O02_DPRS, o02Variants, variantStatus } from '../geometry/coverage-oracle/variants.js';
import { encodeInput } from '../geometry/position-certificate/corpus.js';
import { buildO02 } from '../support/p3-o02-build.js';
import {
  caseDirectory,
  contractIdentity,
  sameManifest,
  sourceManifest,
  type SourceManifest,
  writeExclusiveJson,
} from '../support/p3-o02-evidence.js';

declare global {
  interface Window {
    __vectorStudioP3O02: P3O02PageApi;
  }
}

// P3.1o O02 runner (docs/plans/p3-o02-a5-coverage-contract.md): runner gates only; G1-G3 are
// evaluated offline by `pnpm coverage:p3-o02`.
const INIT_TIMEOUT = 15_000;
const RENDER_TIMEOUT = 10_000;
const DISPOSE_TIMEOUT = 5_000;
const CASE_LIMIT = 1_200_000;
const PART_LIMIT = 25 * 1024 * 1024;
const SHADER_NAMES = ['main', 'count', 'readout'] as const;
const ROW_STATUSES = [
  'RENDERED',
  'INPUT_UNSUPPORTED',
  'NOT_ADMITTED',
  'EMPTY_CROP',
  'FRAME_DEFERRED',
  'VERTEX_UNSUPPORTED',
  'EXTERIOR_NONCONFORMING',
];

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

/** Splits a DPR's rows by row range until every part fits the archive limit. */
function partsOf(
  header: Record<string, unknown>,
  dpr: number,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const part = { ...header, dpr, rows };
  if (rows.length <= 1 || Buffer.byteLength(`${JSON.stringify(part, null, 2)}\n`) <= PART_LIMIT)
    return [part];
  const middle = Math.ceil(rows.length / 2);
  return [
    ...partsOf(header, dpr, rows.slice(0, middle)),
    ...partsOf(header, dpr, rows.slice(middle)),
  ];
}

async function runCase(page: Page, browser: Browser, info: TestInfo) {
  const started = Date.now();
  const directory = caseDirectory(info);
  let status: CaseStatus | null = null;
  const reasons: string[] = [];
  let sourceStart: SourceManifest | null = null;
  let identity: ReturnType<typeof contractIdentity> | null = null;
  let init: Awaited<ReturnType<P3O02PageApi['init']>> | null = null;
  let cleanup: unknown;
  let cleanupPass = false;
  let userAgent: string | null = null;
  const rows: Record<string, unknown>[] = [];
  const variants = o02Variants();
  const shaderSha256 = Object.fromEntries(
    SHADER_NAMES.map((name) => [name, sha256(P3_O02_SHADERS[name])]),
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
    await bounded(page.goto('/p3-o02.html'), INIT_TIMEOUT, 'goto');
    userAgent = await bounded(
      page.evaluate(() => navigator.userAgent),
      INIT_TIMEOUT,
      'user-agent',
    );
    init = await bounded(
      page.evaluate(() => window.__vectorStudioP3O02.init()),
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
    for (const variant of variants) {
      if (status !== null) break;
      if (Date.now() - started > CASE_LIMIT) {
        status = 'INTERRUPTED';
        reasons.push('case-limit');
        break;
      }
      const base = {
        rowIndex: variant.rowIndex,
        id: variant.id,
        kind: variant.kind,
        dpr: variant.dpr,
        identity: variant.identity,
        input: encodeInput(variant.input),
        width: variant.input.width,
        height: variant.input.height,
      };
      const resolved = variantStatus(variant.input);
      if (resolved.status !== 'RENDERED') {
        rows.push({
          ...base,
          status: resolved.status,
          reason: resolved.reason,
          crop: resolved.crop,
          origin: resolved.crop === null ? null : [resolved.crop.x, resolved.crop.y],
          crops: [],
        });
        continue;
      }
      const { crop, exterior } = resolved;
      const built = buildO02(exterior, crop);
      const expectedUpload = {
        soup: sha256(built.soup),
        features: sha256(built.features),
        uniform: sha256(
          new Uint8Array(new Float32Array([built.origin[0], built.origin[1], 0, 0]).buffer),
        ),
      };
      const result = await bounded(
        page.evaluate((request) => window.__vectorStudioP3O02.render(request), {
          variant: { rowIndex: variant.rowIndex, dpr: variant.dpr },
          width: variant.input.width,
          height: variant.input.height,
          crop,
          origin: built.origin,
          soupBase64: base64(built.soup),
          featuresBase64: base64(built.features),
          regionDraw: built.regionDraw,
          exteriorDraw: built.exteriorDraw,
        }),
        RENDER_TIMEOUT,
        `render:${variant.rowIndex}@${variant.dpr}`,
      );
      if (result.status !== 'RENDERED') {
        status = result.status === 'ABORTED' ? 'INTERRUPTED' : result.status;
        reasons.push(`${result.status}:${result.reason}`);
        rows.push({
          ...base,
          status: result.status,
          reason: result.reason,
          crop,
          origin: built.origin,
          crops: [],
        });
        break;
      }
      if (JSON.stringify(result.uploadSha256) !== JSON.stringify(expectedUpload)) {
        status = 'RUNNER_ERROR';
        reasons.push(`upload-digest:${variant.rowIndex}@${variant.dpr}`);
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
        reason: null,
        crop,
        origin: built.origin,
        uploadSha256: expectedUpload,
        uploadEcho: result.uploadSha256,
        ndcBits: exterior.ndcBits,
        regionTriangles: exterior.regionTriangles,
        exteriorTriangles: exterior.exteriorTriangles,
        drawStats: built.stats,
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
        page.evaluate(() => window.__vectorStudioP3O02.dispose()),
        DISPOSE_TIMEOUT,
        'dispose',
      );
      const snapshot = await bounded(
        page.evaluate(() => window.__vectorStudioP3O02.snapshot()),
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
  if (status === null) {
    const partial: string[] = [];
    if (!sourceSame) partial.push('source-changed');
    if (rows.length !== variants.length) partial.push('rows-incomplete');
    if (!cleanupPass) partial.push('cleanup');
    status = partial.length === 0 ? 'COMPLETE' : 'PARTIAL';
    reasons.push(...partial);
  } else if (!sourceSame) reasons.push('source-changed');

  const header = {
    schema: 'p3-o02-capture-v1',
    contract: { ...identity, notePath: identity?.path ?? null, shaderSha256 },
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    project: info.project.name,
    browserVersion: browser.version(),
    userAgent,
    launchArguments: p3O02LaunchArguments,
    adapter: init?.adapter ?? null,
    limits: init?.limits ?? null,
    pageShaderSha256: init?.shaderSha256 ?? null,
    status,
    reasons,
    sourceStart,
    sourceEnd,
    cleanup,
  };
  const parts: { path: string; sha256: string; dpr: number }[] = [];
  for (const dpr of O02_DPRS) {
    const dprRows = rows.filter((row) => row.dpr === dpr);
    partsOf(header, dpr, dprRows).forEach((part, index) => {
      const name = `capture-dpr${String(dpr).replace('.', '_')}-${index}.json`;
      parts.push({ path: name, sha256: writeExclusiveJson(directory, name, part), dpr });
    });
  }
  writeExclusiveJson(directory, 'capture-index.json', {
    schema: 'p3-o02-capture-index-v1',
    parts,
  });
  return { status, reasons, cleanupPass, rows, expected: variants.length };
}

test('o02 corpus', async ({ page, browser }, info) => {
  const result = await runCase(page, browser, info);
  expect(result.reasons).toEqual([]);
  expect(result.status).toBe('COMPLETE');
  expect(result.cleanupPass).toBe(true);
  expect(result.rows).toHaveLength(result.expected);
  for (const row of result.rows)
    expect(ROW_STATUSES, `${String(row.id)}@${String(row.dpr)}`).toContain(row.status);
});
