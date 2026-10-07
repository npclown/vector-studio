import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { encodeInput } from '../position-certificate/corpus.js';
import type { Rational } from '../rounded-fill/exact.js';
import type { Crop } from './crop.js';
import { vertexSectors, type ExteriorMesh } from './exterior.js';
import {
  computeVariantMetrics,
  drawObservations,
  gatesHold,
  type DrawObservations,
  type DrawStats,
  type O02Passes,
  type VariantMetrics,
} from './metrics-o02.js';
import { exactJson, type ExactJson } from './numeric.js';
import { coverageOracle, referenceAt } from './oracle.js';
import { coverageCorpus } from './positions.js';
import { decodeRleBase64, sampleSha256 } from './rle.js';
import { ruleContext } from './rule.js';
import {
  ACCEPTANCE_DPRS,
  O02_DPRS,
  O02_STATUSES,
  o02Variants,
  variantStatus,
  type O02Variant,
} from './variants.js';

/**
 * P3.1o O02 capture reader and offline metrics (docs/plans/p3-o02-a5-coverage-contract.md, "Runner
 * and records", "Oracles and acceptance").
 *
 * capture-index.json, schema `p3-o02-capture-index-v1`:
 *
 *   { "schema": "p3-o02-capture-index-v1", "parts": [{ "path", "sha256", "dpr" }, ...] }
 *
 * One or more parts per DPR; parts with the same dpr are concatenated in index order and must then
 * hold the 149 rows of that DPR in rowIndex order. Every acceptance-DPR part must be present. DPR 3
 * parts are optional (artifacts only): when none of their files exist DPR 3 is skipped; when only
 * some exist the read fails.
 *
 * Part, schema `p3-o02-capture-v1` (fields not listed are ignored):
 *
 *   { "schema": "p3-o02-capture-v1", "contract": { "commit", "notePath", "noteSha256AtCommit", ... },
 *     "dpr": number, "rows": [VariantRow, ...] }
 *
 * VariantRow:
 *
 *   { "rowIndex", "id", "kind", "dpr", "identity",
 *     "status": one of O02_STATUSES, "reason": string | null,
 *     "input": encodeInput(variantInput(row.input, dpr)), "width", "height",
 *     "crop": cropFor(variant geometry) | null, "origin": [crop.x, crop.y] | null,
 *     "crops": [] unless RENDERED; RENDERED rows have exactly, in order:
 *       { "pass": "main",  "sampleCount": 1, "format": "rgba8unorm",  "channels": "R",    "rleBase64", "sha256" },
 *       { "pass": "main",  "sampleCount": 4, "format": "rgba8unorm",  "channels": "R",    "rleBase64", "sha256" },
 *       { "pass": "count", "sampleCount": 1, "format": "rgba16float", "channels": "R",    "rleBase64", "sha256" },
 *       { "pass": "count", "sampleCount": 4, "format": "rgba16float", "channels": "RGBA", "rleBase64", "sha256" } }
 *
 * RLE as O01 (rle.ts). An `RGBA` crop decodes to 4 w h samples, row-major pixels with the channel
 * index fastest. sha256 is over the decoded sample bytes (u8, or u16 little-endian binary16 words).
 *
 * The status, reason and crop of every row are recomputed (variants.ts variantStatus) and must match.
 *
 * RENDERED rows also carry `drawStats` (tests/support/p3-o02-build.ts): `{regionPrimitives,
 * exteriorPrimitives, droppedExterior, maxFeatures, p99Features, featureBytes, perPrimitive:
 * [{triangle, role, count}]}` for the drawn primitives in draw order. The region triangles, then a
 * subsequence of the exterior triangles, are required. They feed the reported draw observations
 * (metrics-o02.ts drawObservations): the crop-limited fragment feature evaluation proxy and
 * `clipOutside`. The verdict additionally counts G3-failing variants without a vertex outside the
 * clip volume.
 *
 * Verdict: INCONCLUSIVE whenever one of its conditions holds, else FAIL on any G1-G3 violation of a
 * RENDERED acceptance variant, else PASS. Both reason lists are always emitted.
 *
 * Outputs: metrics.json (schema `p3-o02-metrics-v1`, acceptance DPRs 1, 1.5, 2, with the verdict) and,
 * when DPR 3 parts are present, metrics-dpr3.json (same schema, DPR 3 only, verdict
 * `N/A:observation`). Neither depends on the other's parts.
 */

export const O02_CAPTURE_SCHEMA = 'p3-o02-capture-v1';
export const O02_CAPTURE_INDEX_SCHEMA = 'p3-o02-capture-index-v1';
export const O02_METRICS_SCHEMA = 'p3-o02-metrics-v1';
export const O02_CONTRACT = 'docs/plans/p3-o02-a5-coverage-contract.md';
export const METRICS_FILE = 'metrics.json';
export const METRICS_DPR3_FILE = 'metrics-dpr3.json';
export const RENDERED_FLOOR = 130;
export const DEFICIT_ROWS = [77, 83, 89, 95] as const;
export const DEFICIT_PIXELS = [
  [150, 8],
  [149, 9],
] as const;

const ORACLE_SOURCES = [
  'tests/geometry/coverage-oracle/capture-schema-o02.ts',
  'tests/geometry/coverage-oracle/crop.ts',
  'tests/geometry/coverage-oracle/exterior.ts',
  'tests/geometry/coverage-oracle/metrics-o02.ts',
  'tests/geometry/coverage-oracle/numeric.ts',
  'tests/geometry/coverage-oracle/oracle.ts',
  'tests/geometry/coverage-oracle/positions.ts',
  'tests/geometry/coverage-oracle/rle.ts',
  'tests/geometry/coverage-oracle/rule.ts',
  'tests/geometry/coverage-oracle/variants.ts',
] as const;

export type O02CaptureCrop = Readonly<{
  pass: 'main' | 'count';
  sampleCount: number;
  format: 'rgba8unorm' | 'rgba16float';
  channels: 'R' | 'RGBA';
  rleBase64: string;
  sha256: string;
}>;

export type O02CaptureRow = Readonly<{
  rowIndex: number;
  id: string;
  kind: 'fixture' | 'literal';
  dpr: number;
  identity: boolean;
  status: string;
  reason: string | null;
  input: unknown;
  width: number;
  height: number;
  crop: Crop | null;
  origin: readonly [number, number] | null;
  crops: readonly O02CaptureCrop[];
  /** RENDERED rows: the builder's draw statistics (drawn primitives only, draw order). */
  drawStats?: DrawStats;
  /** Optional: uint32 NDC words of every drawn vertex; must equal the recomputed words. */
  ndcBits?: readonly (readonly [number, number])[];
}>;

export type O02IndexPart = Readonly<{ path: string; sha256: string; dpr: number }>;

export type O02DprCapture = Readonly<{
  dpr: number;
  parts: readonly O02IndexPart[];
  contract: unknown;
  rows: readonly O02CaptureRow[];
}>;

export type O02LoadedCapture = Readonly<{
  directory: string;
  /** Captures per DPR present, in O02_DPRS order (acceptance DPRs always present). */
  dprs: readonly O02DprCapture[];
}>;

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function parseSchema(text: string, schema: string, label: string): Record<string, unknown> {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.schema !== schema) throw new Error(`capture-o02:${label}:schema`);
  return value;
}

/** Read a directory holding capture-index.json. */
export function loadO02Capture(directory: string): O02LoadedCapture {
  const indexText = readFileSync(path.join(directory, 'capture-index.json'), 'utf8');
  const index = parseSchema(indexText, O02_CAPTURE_INDEX_SCHEMA, 'index') as {
    parts: readonly O02IndexPart[];
  };
  const dprs: O02DprCapture[] = [];
  for (const dpr of O02_DPRS) {
    const parts = index.parts.filter((part) => part.dpr === dpr);
    const present = parts.filter((part) => existsSync(path.join(directory, part.path)));
    const acceptance = (ACCEPTANCE_DPRS as readonly number[]).includes(dpr);
    if (parts.length === 0 || present.length === 0) {
      if (acceptance) throw new Error(`capture-o02:missing-dpr:${dpr}`);
      continue;
    }
    if (present.length !== parts.length) throw new Error(`capture-o02:partial-dpr:${dpr}`);
    let contract: string | null = null;
    let contractValue: unknown = null;
    const rows: O02CaptureRow[] = [];
    for (const part of parts) {
      const bytes = readFileSync(path.join(directory, part.path));
      if (sha256(bytes) !== part.sha256) throw new Error(`capture-o02:part-sha256:${part.path}`);
      const body = parseSchema(bytes.toString('utf8'), O02_CAPTURE_SCHEMA, part.path) as {
        contract: unknown;
        dpr: number;
        rows: readonly O02CaptureRow[];
      };
      if (body.dpr !== dpr) throw new Error(`capture-o02:part-dpr:${part.path}`);
      const text = JSON.stringify(body.contract);
      if (contract !== null && text !== contract)
        throw new Error(`capture-o02:contract:${part.path}`);
      contract = text;
      contractValue = body.contract;
      rows.push(...body.rows);
    }
    dprs.push({ dpr, parts, contract: contractValue, rows });
  }
  const contracts = new Set(dprs.map((entry) => JSON.stringify(entry.contract)));
  if (contracts.size !== 1) throw new Error('capture-o02:contract-mismatch');
  return { directory, dprs };
}

const CROP_ORDER = [
  ['main', 1, 'rgba8unorm', 'R'],
  ['main', 4, 'rgba8unorm', 'R'],
  ['count', 1, 'rgba16float', 'R'],
  ['count', 4, 'rgba16float', 'RGBA'],
] as const;

/** Decode and hash-check the four crops of a RENDERED row. */
export function decodeO02Passes(row: O02CaptureRow, crop: Crop): O02Passes {
  const total = crop.w * crop.h;
  if (row.crops.length !== CROP_ORDER.length)
    throw new Error(`capture-o02:${row.rowIndex}:${row.dpr}:crop-set`);
  const decoded = CROP_ORDER.map(([pass, sampleCount, format, channels], index) => {
    const entry = row.crops[index]!;
    if (
      entry.pass !== pass ||
      entry.sampleCount !== sampleCount ||
      entry.format !== format ||
      entry.channels !== channels
    )
      throw new Error(`capture-o02:${row.rowIndex}:${row.dpr}:crop-order:${index}`);
    const length = channels === 'RGBA' ? 4 * total : total;
    const samples = decodeRleBase64(entry.rleBase64, length, pass === 'main' ? 'u8' : 'u16');
    if (sampleSha256(samples) !== entry.sha256)
      throw new Error(`capture-o02:${row.rowIndex}:${row.dpr}:sha256:${pass}/${sampleCount}`);
    return samples;
  });
  return {
    main1: decoded[0] as Uint8Array,
    main4: decoded[1] as Uint8Array,
    count1: decoded[2] as Uint16Array,
    count4: decoded[3] as Uint16Array,
  };
}

// ---------------------------------------------------------------------------------------------

export type O02MetricsRow = Readonly<{
  rowIndex: number;
  id: string;
  kind: 'fixture' | 'literal';
  dpr: number;
  identity: boolean;
  status: string;
  reason: string | null;
  crop: Crop | null;
  exterior: Readonly<{
    triangles: number;
    frameBox: readonly [number, number, number, number];
    maxFrameNdcMagnitude: string;
    snapUnsafeTriangles: number;
  }> | null;
  /** Builder draw statistics and draw observations (reported only). */
  draw: DrawObservations | null;
  gates: Readonly<{ sample1: boolean; sample4: boolean }> | string;
  metrics: VariantMetrics | string;
}>;

export type DeficitPixel = Readonly<{
  rowIndex: number;
  id: string;
  dpr: number;
  pixel: readonly [number, number];
  main1: number | string;
  main4: number | string;
  rule: ExactJson | string;
  ref: ExactJson | string;
}>;

type Failure = Readonly<{
  rowIndex: number;
  id: string;
  dpr: number;
  sampleCount: 1 | 4;
  gates: readonly string[];
  /** Some drawn vertex lies outside the clip volume in x or y (O01 clipping limit). */
  clipOutside: boolean;
}>;

/** The drawn primitives must be the region triangles, then a subsequence of the exterior ones. */
function checkDrawStats(
  stats: DrawStats | undefined,
  exterior: ExteriorMesh,
  label: string,
): DrawStats {
  const entries: unknown = stats?.perPrimitive;
  if (!stats || !Array.isArray(entries)) throw new Error(`${label}:draw-stats`);
  const key = (t: readonly number[]) => t.join(',');
  const region = exterior.regionTriangles.map(key);
  const outer = exterior.exteriorTriangles.map(key);
  const list = stats.perPrimitive;
  if (stats.regionPrimitives !== region.length) throw new Error(`${label}:draw-stats:region`);
  if (stats.regionPrimitives + stats.exteriorPrimitives !== list.length)
    throw new Error(`${label}:draw-stats:count`);
  if (stats.exteriorPrimitives + stats.droppedExterior !== outer.length)
    throw new Error(`${label}:draw-stats:dropped`);
  let cursor = 0;
  list.forEach((primitive, index) => {
    if (!Number.isInteger(primitive.count) || primitive.count < 0)
      throw new Error(`${label}:draw-stats:feature-count:${index}`);
    if (index < region.length) {
      if (primitive.role !== 0 || key(primitive.triangle) !== region[index])
        throw new Error(`${label}:draw-stats:region-order:${index}`);
      return;
    }
    if (primitive.role !== 1) throw new Error(`${label}:draw-stats:role:${index}`);
    while (cursor < outer.length && outer[cursor] !== key(primitive.triangle)) cursor += 1;
    if (cursor === outer.length) throw new Error(`${label}:draw-stats:exterior-order:${index}`);
    cursor += 1;
  });
  const max = list.reduce((value, primitive) => Math.max(value, primitive.count), 0);
  if (stats.maxFeatures !== max) throw new Error(`${label}:draw-stats:max-features`);
  return stats;
}

function sameCrop(a: Crop | null, b: Crop | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function sourceHashes(): Record<string, string> {
  return Object.fromEntries(
    ORACLE_SOURCES.map((file) => [
      file,
      sha256(readFileSync(path.resolve(file), 'utf8').replace(/\r\n/gu, '\n')),
    ]),
  );
}

function failedGates(sample: VariantMetrics['samples'][number]): string[] {
  const gates: string[] = [];
  if (sample.g1.violations > 0) gates.push('G1');
  if (sample.g2.violations > 0) gates.push('G2');
  if ((sample.g2.thin?.violations ?? 0) > 0) gates.push('G2-THIN');
  if (sample.g3.fullViolations > 0) gates.push('G3-full');
  if (sample.g3.otherViolations > 0) gates.push('G3-other');
  return gates;
}

type Evaluated = Readonly<{
  rows: O02MetricsRow[];
  failures: Failure[];
  deficit: DeficitPixel[];
  counts: Record<string, number>;
}>;

function evaluateDpr(capture: O02DprCapture, variants: readonly O02Variant[]): Evaluated {
  const expected = variants.filter((variant) => variant.dpr === capture.dpr);
  if (capture.rows.length !== expected.length)
    throw new Error(`capture-o02:${capture.dpr}:row-count`);
  const counts: Record<string, number> = Object.fromEntries(
    ([['variants', expected.length]] as [string, number][]).concat(
      O02_STATUSES.map((status): [string, number] => [status, 0]),
    ),
  );
  const failures: Failure[] = [];
  const deficit: DeficitPixel[] = [];
  const rows = capture.rows.map((row, index): O02MetricsRow => {
    const variant = expected[index]!;
    if (
      row.rowIndex !== variant.rowIndex ||
      row.id !== variant.id ||
      row.kind !== variant.kind ||
      row.dpr !== variant.dpr ||
      row.identity !== variant.identity ||
      JSON.stringify(row.input) !== JSON.stringify(encodeInput(variant.input)) ||
      row.width !== variant.input.width ||
      row.height !== variant.input.height
    )
      throw new Error(`capture-o02:${variant.rowIndex}:${variant.dpr}:identity`);
    const label = `capture-o02:${variant.rowIndex}:${variant.dpr}`;
    const status = variantStatus(variant.input);
    if (row.status !== status.status || row.reason !== status.reason)
      throw new Error(`${label}:status:${row.status}:${status.status}`);
    if (!sameCrop(row.crop, status.crop)) throw new Error(`${label}:crop`);
    const origin = status.crop === null ? null : [status.crop.x, status.crop.y];
    if (JSON.stringify(row.origin ?? null) !== JSON.stringify(origin))
      throw new Error(`${label}:origin`);
    if (status.status !== 'RENDERED' && row.crops.length !== 0) throw new Error(`${label}:crops`);
    counts[status.status] = (counts[status.status] ?? 0) + 1;
    const base = {
      rowIndex: variant.rowIndex,
      id: variant.id,
      kind: variant.kind,
      dpr: variant.dpr,
      identity: variant.identity,
      status: row.status,
      reason: row.reason,
      crop: status.crop,
    };
    const deficitRow = (DEFICIT_ROWS as readonly number[]).includes(variant.rowIndex);
    if (status.status !== 'RENDERED') {
      if (deficitRow && variant.identity)
        for (const pixel of DEFICIT_PIXELS)
          deficit.push({
            rowIndex: variant.rowIndex,
            id: variant.id,
            dpr: variant.dpr,
            pixel,
            main1: `N/A:${status.status}`,
            main4: `N/A:${status.status}`,
            rule: `N/A:${status.status}`,
            ref: `N/A:${status.status}`,
          });
      return {
        ...base,
        exterior: null,
        draw: null,
        gates: `N/A:${status.status}`,
        metrics: `N/A:${status.status}`,
      };
    }
    const { geometry, crop, exterior } = status;
    const passes = decodeO02Passes(row, crop);
    const oracle = coverageOracle(geometry, crop);
    const context = ruleContext(geometry, vertexSectors(geometry));
    const { metrics, rule } = computeVariantMetrics(geometry, crop, oracle, context, passes);
    const [sample1, sample4] = metrics.samples;
    if (
      row.ndcBits !== undefined &&
      JSON.stringify(row.ndcBits) !== JSON.stringify(exterior.ndcBits)
    )
      throw new Error(`${label}:ndc-bits`);
    const draw = drawObservations(
      exterior.scaled,
      exterior.scaleExponent,
      exterior.ndcBits,
      crop,
      checkDrawStats(row.drawStats, exterior, label),
    );
    for (const sample of metrics.samples) {
      const gates = failedGates(sample);
      if (gates.length > 0)
        failures.push({
          rowIndex: variant.rowIndex,
          id: variant.id,
          dpr: variant.dpr,
          sampleCount: sample.sampleCount,
          gates,
          clipOutside: draw.clipOutside,
        });
    }
    if (deficitRow && variant.identity)
      for (const pixel of DEFICIT_PIXELS) {
        const [i, j] = pixel;
        const inside = i >= crop.x && i < crop.x + crop.w && j >= crop.y && j < crop.y + crop.h;
        const at = (j - crop.y) * crop.w + (i - crop.x);
        const exact = (value: Rational) => exactJson(value);
        deficit.push({
          rowIndex: variant.rowIndex,
          id: variant.id,
          dpr: variant.dpr,
          pixel,
          main1: inside ? passes.main1[at]! : 'N/A:outside-crop',
          main4: inside ? passes.main4[at]! : 'N/A:outside-crop',
          rule: inside ? exact(rule(at)) : 'N/A:outside-crop',
          ref: inside ? exact(referenceAt(oracle, at)) : 'N/A:outside-crop',
        });
      }
    return {
      ...base,
      exterior: {
        triangles: exterior.exteriorTriangles.length,
        frameBox: exterior.frame.box,
        maxFrameNdcMagnitude: exterior.frame.maxNdcMagnitude.toExponential(5),
        snapUnsafeTriangles: exterior.orientationSlack.filter((slack) => !slack.snapSafe).length,
      },
      draw,
      gates: { sample1: gatesHold(sample1), sample4: gatesHold(sample4) },
      metrics,
    };
  });
  return { rows, failures, deficit, counts };
}

const LITERAL_IDS = ['F07-Z16', 'F07-Z16R15', 'F11-Z8', 'SQ-Z1', 'SQ-Z1R15', 'THIN-Z1'] as const;

/** metrics.json text for the acceptance DPRs, or metrics-dpr3.json text for DPR 3. */
export function buildO02MetricsText(
  capture: O02LoadedCapture,
  scope: 'acceptance' | 'dpr3',
): string {
  const dprs: readonly number[] = scope === 'acceptance' ? ACCEPTANCE_DPRS : [3];
  const selected = capture.dprs.filter((entry) => dprs.includes(entry.dpr));
  if (selected.length !== dprs.length) throw new Error(`capture-o02:${scope}:dprs`);
  const corpus = coverageCorpus();
  const variants = o02Variants(corpus);
  const evaluated = selected.map((entry) => evaluateDpr(entry, variants));
  const perDpr = Object.fromEntries(
    selected.map((entry, index) => [String(entry.dpr), evaluated[index]!.counts]),
  );
  const failures = evaluated.flatMap((entry) => entry.failures);
  let verdict: unknown;
  if (scope === 'dpr3') verdict = 'N/A:observation';
  else {
    const inconclusive: string[] = [];
    const literalIndices = corpus
      .filter((row) => (LITERAL_IDS as readonly string[]).includes(row.id))
      .map((row) => row.rowIndex);
    selected.forEach((entry, index) => {
      const rendered = evaluated[index]!.counts.RENDERED ?? 0;
      if (rendered < RENDERED_FLOOR)
        inconclusive.push(`rendered-floor:${entry.dpr}:${rendered}<${RENDERED_FLOOR}`);
      for (const rowIndex of [...literalIndices, ...DEFICIT_ROWS]) {
        const row = evaluated[index]!.rows[rowIndex]!;
        if (row.status !== 'RENDERED')
          inconclusive.push(`required-row:${entry.dpr}:${rowIndex}:${row.id}:${row.status}`);
      }
    });
    // Contract: INCONCLUSIVE whenever one of its conditions holds; otherwise FAIL on any G1-G3
    // violation of a RENDERED acceptance variant; otherwise PASS. Both reason lists are kept.
    const g3 = new Map<string, boolean>();
    for (const failure of failures)
      if (failure.gates.some((gate) => gate.startsWith('G3')))
        g3.set(`${failure.rowIndex}:${failure.dpr}`, failure.clipOutside);
    verdict = {
      result: inconclusive.length > 0 ? 'INCONCLUSIVE' : failures.length > 0 ? 'FAIL' : 'PASS',
      failures,
      inconclusive,
      g3FailingVariants: g3.size,
      g3FailingVariantsWithoutClipOutside: [...g3.values()].filter((clip) => !clip).length,
    };
  }
  const document = {
    schema: O02_METRICS_SCHEMA,
    contractNote: O02_CONTRACT,
    contract: selected[0]!.contract,
    scope,
    dprs,
    capture: {
      index: 'capture-index.json',
      parts: selected.flatMap((entry) => entry.parts),
    },
    oracleSources: sourceHashes(),
    counts: perDpr,
    verdict,
    deficitPixels: evaluated.flatMap((entry) => entry.deficit),
    rows: evaluated.flatMap((entry) => entry.rows),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The metrics files of a capture directory: [file name, text] pairs. */
export function buildO02MetricsFiles(directory: string): [string, string][] {
  const capture = loadO02Capture(directory);
  const files: [string, string][] = [[METRICS_FILE, buildO02MetricsText(capture, 'acceptance')]];
  if (capture.dprs.some((entry) => entry.dpr === 3))
    files.push([METRICS_DPR3_FILE, buildO02MetricsText(capture, 'dpr3')]);
  return files;
}
