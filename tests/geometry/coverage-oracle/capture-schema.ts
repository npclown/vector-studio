import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { encodeInput } from '../position-certificate/corpus.js';
import { add, compare, mul, rational, sub, type Rational } from '../rounded-fill/exact.js';
import { cropFor, type Crop } from './crop.js';
import { CANDIDATES, computeRowMetrics, type CandidatePasses, type RowMetrics } from './metrics.js';
import { exactJson, q32Bits, type ExactJson } from './numeric.js';
import { coverageOracle } from './oracle.js';
import { coverageCorpus, coverageRowGeometry, type CoverageRowGeometry } from './positions.js';
import { decodeRleBase64, sampleSha256 } from './rle.js';

/**
 * P3.1o O01 capture reader and offline metrics (docs/plans/p3-o01-coverage-experiment-contract.md,
 * "Runner, records and evidence").
 *
 * capture.json, schema `p3-coverage-capture-v1` (other top-level fields are ignored here):
 *
 *   { "schema": "p3-coverage-capture-v1", ..., "rows": [CaptureRow, ...] }
 *
 * CaptureRow (fields this reader uses; others are ignored):
 *
 *   {
 *     "rowIndex": number,            // coverageCorpus() order: 143 admitted fixtures, then 6 literals
 *     "id": string,                  // coverageCorpus()[rowIndex].id
 *     "kind": "fixture" | "literal",
 *     "status": "RENDERED" | "INPUT_UNSUPPORTED" | <other runner status>,
 *     "reason": string | null,       // INPUT_UNSUPPORTED:<reason> from coverageRowGeometry()
 *     "input": <encodeInput(input) of corpus.ts: binary64 values as 16-digit hex>,
 *     "width": number, "height": number,
 *     "crop": { "x", "y", "w", "h" } | null,        // must equal cropFor(geometry)
 *     "origin": [ox, oy],            // optional; edge-coefficient origin, default [crop.x, crop.y]
 *     "ndcBits": [[xWord, yWord], ...],             // optional; uint32 words, all vertices
 *     "edges": [{ "a", "b", "third", "n": [xWord, yWord], "c": word }, ...],
 *                                    // optional; boundary edges with binary32 coefficient words
 *     "crops": [                     // RENDERED rows: 12 entries, for each candidate A1, A2, A5:
 *       { "candidate", "sampleCount": 1, "pass": "main",    "format": "rgba8unorm",  "rleBase64", "sha256" },
 *       { "candidate", "sampleCount": 4, "pass": "main",    "format": "rgba8unorm",  "rleBase64", "sha256" },
 *       { "candidate", "sampleCount": 1, "pass": "diagMax", "format": "rgba16float", "rleBase64", "sha256" },
 *       { "candidate", "sampleCount": 1, "pass": "diagAdd", "format": "rgba16float", "rleBase64", "sha256" }
 *     ]
 *   }
 *
 * Split captures: capture-index.json, schema `p3-coverage-capture-index-v1`,
 *   { "schema": "p3-coverage-capture-index-v1", "parts": [{ "path": "<relative file>", "sha256" }] }
 * Each part is a `p3-coverage-capture-v1` file. Rows with the same rowIndex in several parts are
 * merged: every field except `crops` must be identical, and the crops are concatenated, then
 * ordered as above.
 */

export const CAPTURE_SCHEMA = 'p3-coverage-capture-v1';
export const CAPTURE_INDEX_SCHEMA = 'p3-coverage-capture-index-v1';
export const METRICS_SCHEMA = 'p3-coverage-metrics-v1';
export const CONTRACT = 'docs/plans/p3-o01-coverage-experiment-contract.md';

export type CaptureCrop = Readonly<{
  candidate: string;
  sampleCount: number;
  pass: 'main' | 'diagMax' | 'diagAdd';
  format: 'rgba8unorm' | 'rgba16float';
  rleBase64: string;
  sha256: string;
}>;

export type CaptureEdge = Readonly<{
  a: number;
  b: number;
  third: number;
  n: readonly [number, number];
  c: number;
}>;

export type CaptureRow = Readonly<{
  rowIndex: number;
  id: string;
  kind: 'fixture' | 'literal';
  status: string;
  reason: string | null;
  input: unknown;
  width: number;
  height: number;
  crop: Crop | null;
  origin?: readonly [number, number];
  ndcBits?: readonly (readonly [number, number])[];
  edges?: readonly CaptureEdge[];
  crops: readonly CaptureCrop[];
}>;

export type LoadedCapture = Readonly<{
  file: string;
  sha256: string;
  rows: readonly CaptureRow[];
}>;

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const ORACLE_SOURCES = [
  'tests/geometry/coverage-oracle/capture-schema.ts',
  'tests/geometry/coverage-oracle/crop.ts',
  'tests/geometry/coverage-oracle/metrics.ts',
  'tests/geometry/coverage-oracle/numeric.ts',
  'tests/geometry/coverage-oracle/oracle.ts',
  'tests/geometry/coverage-oracle/positions.ts',
  'tests/geometry/coverage-oracle/rle.ts',
] as const;

function parseSchema(text: string, schema: string, label: string): Record<string, unknown> {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.schema !== schema) throw new Error(`capture:${label}:schema`);
  return value;
}

const CROP_ORDER = CANDIDATES.flatMap((candidate) =>
  (
    [
      [1, 'main'],
      [4, 'main'],
      [1, 'diagMax'],
      [1, 'diagAdd'],
    ] as const
  ).map(([sampleCount, pass]) => `${candidate}:${sampleCount}:${pass}`),
);
const cropKey = (crop: CaptureCrop) => `${crop.candidate}:${crop.sampleCount}:${crop.pass}`;

function mergeRows(parts: readonly (readonly CaptureRow[])[]): CaptureRow[] {
  const merged = new Map<number, CaptureRow>();
  for (const rows of parts)
    for (const row of rows) {
      const previous = merged.get(row.rowIndex);
      if (!previous) {
        merged.set(row.rowIndex, row);
        continue;
      }
      const { crops: previousCrops, ...previousMeta } = previous;
      const { crops, ...meta } = row;
      if (JSON.stringify(previousMeta) !== JSON.stringify(meta))
        throw new Error(`capture:merge:${row.rowIndex}`);
      merged.set(row.rowIndex, { ...previous, crops: [...previousCrops, ...crops] });
    }
  return [...merged.values()]
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .map((row) => ({
      ...row,
      crops: [...row.crops].sort(
        (a, b) => CROP_ORDER.indexOf(cropKey(a)) - CROP_ORDER.indexOf(cropKey(b)),
      ),
    }));
}

/** Read capture-index.json when present, else capture.json, from a capture directory. */
export function loadCaptureDirectory(directory: string): LoadedCapture {
  const indexPath = path.join(directory, 'capture-index.json');
  if (existsSync(indexPath)) {
    const indexText = readFileSync(indexPath, 'utf8');
    const index = parseSchema(indexText, CAPTURE_INDEX_SCHEMA, 'index') as {
      parts: readonly { path: string; sha256: string }[];
    };
    const parts = index.parts.map((part) => {
      const bytes = readFileSync(path.join(directory, part.path));
      if (sha256(bytes) !== part.sha256) throw new Error(`capture:part-sha256:${part.path}`);
      return (
        parseSchema(bytes.toString('utf8'), CAPTURE_SCHEMA, part.path) as {
          rows: readonly CaptureRow[];
        }
      ).rows;
    });
    return { file: 'capture-index.json', sha256: sha256(indexText), rows: mergeRows(parts) };
  }
  const bytes = readFileSync(path.join(directory, 'capture.json'));
  const capture = parseSchema(bytes.toString('utf8'), CAPTURE_SCHEMA, 'capture') as {
    rows: readonly CaptureRow[];
  };
  return { file: 'capture.json', sha256: sha256(bytes), rows: mergeRows([capture.rows]) };
}

/** Decode and hash-check the 12 crops of a RENDERED row. */
export function decodePasses(row: CaptureRow, crop: Crop): CandidatePasses[] {
  const total = crop.w * crop.h;
  if (row.crops.map(cropKey).join() !== CROP_ORDER.join())
    throw new Error(`capture:${row.rowIndex}:crop-set`);
  const decoded = row.crops.map((entry) => {
    const main = entry.pass === 'main';
    if (entry.format !== (main ? 'rgba8unorm' : 'rgba16float'))
      throw new Error(`capture:${row.rowIndex}:format`);
    const samples = decodeRleBase64(entry.rleBase64, total, main ? 'u8' : 'u16');
    if (sampleSha256(samples) !== entry.sha256)
      throw new Error(`capture:${row.rowIndex}:sha256:${cropKey(entry)}`);
    return samples;
  });
  return CANDIDATES.map((candidate, index) => ({
    candidate,
    main1: decoded[index * 4] as Uint8Array,
    main4: decoded[index * 4 + 1] as Uint8Array,
    diagMax: decoded[index * 4 + 2] as Uint16Array,
    diagAdd: decoded[index * 4 + 3] as Uint16Array,
  }));
}

// ---------------------------------------------------------------------------------------------
// Edge-coefficient displacement: max over the preimage edge clipped to the closed crop of the
// distance to the line n . (p - o) + c = 0 of the binary32 coefficients, reported squared.

const LIMIT_SQUARED = rational(1n, 255n * 255n);

function clipToCrop(
  a: readonly [Rational, Rational],
  b: readonly [Rational, Rational],
  crop: Crop,
) {
  let t0 = rational(0n);
  let t1 = rational(1n);
  const bounds = [
    [rational(BigInt(crop.x)), rational(BigInt(crop.x + crop.w))],
    [rational(BigInt(crop.y)), rational(BigInt(crop.y + crop.h))],
  ] as const;
  for (const axis of [0, 1] as const) {
    const delta = sub(b[axis], a[axis]);
    const [low, high] = bounds[axis];
    if (delta.n === 0n) {
      if (compare(a[axis], low) < 0 || compare(a[axis], high) > 0) return null;
      continue;
    }
    let ta = mul(sub(low, a[axis]), rational(delta.d, delta.n));
    let tb = mul(sub(high, a[axis]), rational(delta.d, delta.n));
    if (compare(ta, tb) > 0) [ta, tb] = [tb, ta];
    if (compare(ta, t0) > 0) t0 = ta;
    if (compare(tb, t1) < 0) t1 = tb;
  }
  if (compare(t0, t1) > 0) return null;
  const at = (t: Rational) =>
    [add(a[0], mul(t, sub(b[0], a[0]))), add(a[1], mul(t, sub(b[1], a[1])))] as const;
  return [at(t0), at(t1)] as const;
}

export type EdgeDisplacement = Readonly<{ a: number; b: number; maxSquared: ExactJson | string }>;

export function edgeDisplacements(
  geometry: CoverageRowGeometry,
  crop: Crop,
  origin: readonly [number, number],
  edges: readonly CaptureEdge[],
): { edges: EdgeDisplacement[]; over: { a: number; b: number; maxSquared: ExactJson }[] } {
  const expected = geometry.boundaryEdges.map((edge) => `${edge.a}:${edge.b}:${edge.third}`);
  if (edges.map((edge) => `${edge.a}:${edge.b}:${edge.third}`).join() !== expected.join())
    throw new Error(`capture:${geometry.id}:edges`);
  const o = [rational(BigInt(origin[0])), rational(BigInt(origin[1]))] as const;
  const out: EdgeDisplacement[] = [];
  const over: { a: number; b: number; maxSquared: ExactJson }[] = [];
  for (const edge of edges) {
    const nx = q32Bits(edge.n[0]);
    const ny = q32Bits(edge.n[1]);
    const c = q32Bits(edge.c);
    const norm = add(mul(nx, nx), mul(ny, ny));
    const clipped = clipToCrop(geometry.preimage[edge.a]!, geometry.preimage[edge.b]!, crop);
    if (clipped === null || norm.n === 0n) {
      out.push({
        a: edge.a,
        b: edge.b,
        maxSquared: clipped === null ? 'N/A:outside-crop' : 'N/A:zero-normal',
      });
      continue;
    }
    let max = rational(0n);
    for (const p of clipped) {
      const value = add(add(mul(nx, sub(p[0], o[0])), mul(ny, sub(p[1], o[1]))), c);
      const squared = mul(mul(value, value), rational(norm.d, norm.n));
      if (compare(squared, max) > 0) max = squared;
    }
    out.push({ a: edge.a, b: edge.b, maxSquared: exactJson(max) });
    if (compare(max, LIMIT_SQUARED) > 0)
      over.push({ a: edge.a, b: edge.b, maxSquared: exactJson(max) });
  }
  return { edges: out, over };
}

// ---------------------------------------------------------------------------------------------

export type MetricsRow = Readonly<{
  rowIndex: number;
  id: string;
  kind: 'fixture' | 'literal';
  status: string;
  reason: string | null;
  crop: Crop | null;
  preimageError: Readonly<{ maxSquared: ExactJson; maxAxis: ExactJson; vertex: number }> | null;
  displacement: readonly EdgeDisplacement[] | string;
  metrics: RowMetrics | string;
}>;

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

/** metrics.json text (fixed key order, two-space JSON, final newline) from a loaded capture. */
export function buildMetricsText(capture: LoadedCapture): string {
  const corpus = coverageCorpus();
  if (capture.rows.length !== corpus.length) throw new Error('capture:row-count');
  const unsupported: { rowIndex: number; id: string; reason: string }[] = [];
  const over: { rowIndex: number; id: string; a: number; b: number; maxSquared: ExactJson }[] = [];
  const counts = { rows: corpus.length, rendered: 0, inputUnsupported: 0, other: 0 };
  const rows = capture.rows.map((row, index): MetricsRow => {
    const expected = corpus[index]!;
    if (
      row.rowIndex !== index ||
      row.id !== expected.id ||
      row.kind !== expected.kind ||
      JSON.stringify(row.input) !== JSON.stringify(encodeInput(expected.input)) ||
      row.width !== expected.input.width ||
      row.height !== expected.input.height
    )
      throw new Error(`capture:${index}:identity`);
    const base = {
      rowIndex: index,
      id: row.id,
      kind: row.kind,
      status: row.status,
      reason: row.reason,
    };
    const geometry = coverageRowGeometry(expected.input);
    if ('unsupported' in geometry) {
      if (
        row.status !== 'INPUT_UNSUPPORTED' ||
        (row.reason !== geometry.unsupported &&
          `INPUT_UNSUPPORTED:${row.reason}` !== geometry.unsupported)
      )
        throw new Error(`capture:${index}:unsupported-mismatch`);
      counts.inputUnsupported += 1;
      unsupported.push({ rowIndex: index, id: row.id, reason: geometry.unsupported });
      return {
        ...base,
        crop: null,
        preimageError: null,
        displacement: 'N/A:INPUT_UNSUPPORTED',
        metrics: 'N/A:INPUT_UNSUPPORTED',
      };
    }
    if (row.status === 'INPUT_UNSUPPORTED')
      throw new Error(`capture:${index}:unsupported-mismatch`);
    if (row.ndcBits && JSON.stringify(row.ndcBits) !== JSON.stringify(geometry.ndcBits))
      throw new Error(`capture:${index}:ndc-bits`);
    const crop = cropFor(geometry);
    if (!sameCrop(row.crop, crop)) throw new Error(`capture:${index}:crop`);
    const preimageError = {
      maxSquared: exactJson(geometry.maxPreimageError.squared),
      maxAxis: exactJson(geometry.maxPreimageError.axis),
      vertex: geometry.maxPreimageError.vertex,
    };
    if (row.status === 'RENDERED') counts.rendered += 1;
    else counts.other += 1;
    if (crop === null)
      return { ...base, crop, preimageError, displacement: 'N/A:empty', metrics: 'N/A:empty' };
    let displacement: MetricsRow['displacement'] = 'N/A:not-captured';
    if (row.edges) {
      const result = edgeDisplacements(geometry, crop, row.origin ?? [crop.x, crop.y], row.edges);
      displacement = result.edges;
      for (const entry of result.over) over.push({ rowIndex: index, id: row.id, ...entry });
    }
    if (row.status !== 'RENDERED')
      return { ...base, crop, preimageError, displacement, metrics: `N/A:${row.status}` };
    const passes = decodePasses(row, crop);
    const metrics = computeRowMetrics(geometry, crop, coverageOracle(geometry, crop), passes);
    return { ...base, crop, preimageError, displacement, metrics };
  });
  const document = {
    schema: METRICS_SCHEMA,
    contract: CONTRACT,
    capture: { file: capture.file, sha256: capture.sha256 },
    oracleSources: sourceHashes(),
    counts,
    inputUnsupported: unsupported,
    displacementOver1_255: over,
    rows,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
