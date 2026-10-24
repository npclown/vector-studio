// V-4 unit VZ4-U1: Node-side case handling for the A08 corpus page
// (docs/plans/viz-v4-a08-corpus-contract.md, sections 4.4 and 5.1): the page input of a subset
// case, the E3 freeze guard, the expected status from the product CPU path, and the headed status
// of a page result. Gates are not evaluated here (VZ4-U2).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  FillMeshBatchResult,
  FillMeshPort,
  FillMeshRequest,
  FillMeshResult,
  StrokeMeshBatchResult,
  StrokeMeshPort,
  StrokeMeshRequest,
  StrokeMeshResult,
} from '@vector-studio/contracts';

import {
  fillRequestRecord,
  meshDigestBytes,
  strokeRequestRecord,
  type VizV4CaseInput,
  type VizV4MeshCall,
  type VizV4MeshRequest,
} from '../../../apps/playground/src/viz-v4-a08-cases.js';
import { decodeCase, drawCase, type HarnessPorts } from '../../geometry/e3-a04/harness.js';
import type { A08Case } from './subset.js';

/** The statuses of section 4.4; PASS, FAIL and UNDECIDED are offline judgments, not statuses. */
export type VizV4Status =
  | 'RENDERED'
  | 'KERNEL-REJECTED'
  | 'REGION-ONLY'
  | 'EMPTY-CROP'
  | 'MESH-MISMATCH'
  | 'RENDERER-FAILED';

export type VizV4Variant = 'fringe-1x' | 'fringe-4x' | 'msaa-4x';
export const VIZ_V4_VARIANTS: readonly VizV4Variant[] = ['fringe-1x', 'fringe-4x', 'msaa-4x'];

export function variantQuery(
  variant: VizV4Variant,
): Readonly<{ samples: 1 | 4; fringe: 'on' | 'off' }> {
  return variant === 'fringe-1x'
    ? { samples: 1, fringe: 'on' }
    : variant === 'fringe-4x'
      ? { samples: 4, fringe: 'on' }
      : { samples: 4, fringe: 'off' };
}

/** The page input of one subset case. Opacity is 1 and the colour white (section 4.3). */
export function caseInput(c: A08Case): VizV4CaseInput {
  const decoded = decodeCase(c.kase);
  return {
    key: c.key,
    verbs: decoded.verbs,
    points: decoded.points,
    transform: decoded.transform,
    camera: decoded.camera,
    zoom: decoded.zoom,
    dpr: c.dpr,
    paint:
      decoded.paint === 'fill'
        ? { kind: 'fill', rule: decoded.fillRule }
        : {
            kind: 'stroke',
            width: decoded.stroke!.width,
            cap: decoded.stroke!.cap as 'butt' | 'round' | 'square',
            join: decoded.stroke!.join as 'miter' | 'round' | 'bevel',
            miterLimit: decoded.stroke!.miterLimit,
          },
  };
}

const E3_CONTRACT = 'docs/plans/d9-e3-b4-precision-contract.md';
const E3_MANIFEST = 'tests/geometry/e3-a04/corpus-v1.manifest.json';

/**
 * E3 section 5.5: the kernel runs on corpus cases only after the freeze record. True when the
 * E3 contract holds a "**Freeze record**" line with the manifest's corpusSha256, the rule
 * `pnpm e3-a04:run` uses.
 */
export function a04FreezeRecorded(root: string): boolean {
  const manifest = JSON.parse(readFileSync(path.join(root, E3_MANIFEST), 'utf8')) as {
    corpusSha256: string;
  };
  return readFileSync(path.join(root, E3_CONTRACT), 'utf8')
    .split('\n')
    .some((line) => line.includes('**Freeze record**') && line.includes(manifest.corpusSha256));
}

/** The renderer codes for a path drawn without its fringe (`fringe-work-cap`) or hidden for it. */
const REGION_ONLY_CODES: ReadonlySet<string> = new Set(['fringe-work-cap', 'fringe-unsupported']);

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One port call as a comparable line: the request's SHA-256 and the outcome. */
export function callKey(call: VizV4MeshCall): string {
  return `${sha256(JSON.stringify(call.request))} ${call.outcome}`;
}

/** The outcome string of one port result, as the page writes it. */
export function resultOutcome(result: FillMeshResult | StrokeMeshResult): string {
  if (result.status === 'ok') return `ok:${sha256(meshDigestBytes(result.mesh))}`;
  return result.status === 'empty' ? 'empty' : `failed:${result.code}`;
}

/** Wraps Node's ports to record every call as the page records it (section 4.4, MESH-MISMATCH). */
export function recordingPorts(
  ports: Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>,
): Readonly<{
  ports: Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>;
  take(): VizV4MeshCall[];
}> {
  const calls: VizV4MeshCall[] = [];
  const record = (
    requests: readonly VizV4MeshRequest[],
    batch: FillMeshBatchResult | StrokeMeshBatchResult,
  ) => {
    requests.forEach((request, index) =>
      calls.push({
        request,
        outcome:
          batch.status === 'ok' ? resultOutcome(batch.results[index]!) : `batch:${batch.code}`,
      }),
    );
  };
  return {
    ports: {
      fill: {
        portVersion: ports.fill.portVersion,
        operationId: ports.fill.operationId,
        buildFillMeshes(requests: readonly FillMeshRequest[]) {
          const batch = ports.fill.buildFillMeshes(requests);
          record(requests.map(fillRequestRecord), batch);
          return batch;
        },
      },
      stroke: {
        portVersion: ports.stroke.portVersion,
        operationId: ports.stroke.operationId,
        buildStrokeMeshes(requests: readonly StrokeMeshRequest[]) {
          const batch = ports.stroke.buildStrokeMeshes(requests);
          record(requests.map(strokeRequestRecord), batch);
          return batch;
        },
      },
    },
    take: () => calls.splice(0),
  };
}

/** What one draw of a case showed, on either side. */
export type CaseObservation = Readonly<{
  calls: readonly VizV4MeshCall[];
  /** Renderer notice codes for the case (`fringe-work-cap`, `tolerance-range`, ...). */
  notices: readonly string[];
  drawn: boolean;
}>;

/**
 * The section 4.4 status of one observation, in this order: a port failure (KERNEL-REJECTED,
 * A01 evidence); a fringe notice (REGION-ONLY); any other renderer notice (RENDERER-FAILED, a
 * renderer defect, never A01 evidence); nothing drawn (EMPTY-CROP, reason `port-empty` when the
 * port answered `empty`); otherwise RENDERED. MESH-MISMATCH is decided by the caller.
 */
export function classify(
  observation: CaseObservation,
): Readonly<{ status: VizV4Status; reason: string }> {
  const failed = observation.calls.find(
    (call) => call.outcome.startsWith('failed:') || call.outcome.startsWith('batch:'),
  );
  if (failed !== undefined) return { status: 'KERNEL-REJECTED', reason: failed.outcome };
  const regionOnly = observation.notices.find((code) => REGION_ONLY_CODES.has(code));
  if (regionOnly !== undefined) return { status: 'REGION-ONLY', reason: regionOnly };
  const renderer = observation.notices[0];
  if (renderer !== undefined) return { status: 'RENDERER-FAILED', reason: renderer };
  if (!observation.drawn)
    return {
      status: 'EMPTY-CROP',
      reason: observation.calls.some((call) => call.outcome === 'empty')
        ? 'port-empty'
        : 'no mesh triangle drawn',
    };
  return { status: 'RENDERED', reason: '' };
}

/** One case and variant of the expected-status list (section 5.1). */
export type ExpectedEntry = Readonly<{
  status: VizV4Status;
  reason: string;
  calls: readonly string[];
}>;

/**
 * The expected status of a case under a variant, from the product CPU path: E3's `drawCase`,
 * which wires the mirror, the scene source and PathMeshPipeline as PrimitiveRendererService does,
 * with the fringe builder for the fringe variants and none for `msaa-4x` (E10 fringe off). The
 * port calls are recorded, so the headed run is held to Node's requests and mesh digests.
 */
export function expectedEntry(
  c: A08Case,
  ports: Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>,
  variant: VizV4Variant,
): ExpectedEntry {
  const recorder = recordingPorts(ports);
  const outcome = drawCase(c.kase, recorder.ports satisfies HarnessPorts, {
    fringe: variantQuery(variant).fringe,
  });
  const calls = recorder.take();
  const { status, reason } = classify({
    calls,
    notices: outcome.notices.map((notice) => notice.slice(notice.indexOf(':') + 1)),
    drawn: outcome.kind === 'drawn',
  });
  return { status, reason, calls: calls.map(callKey).sort() };
}

/** The page's result fields this module reads. */
export type PageResultView = Readonly<{
  notices: readonly string[];
  meshTriangles: number;
  meshCalls: readonly VizV4MeshCall[];
}>;

/**
 * The headed status of a page result (section 4.4), with its reason. MESH-MISMATCH when the
 * browser's port calls (requests and mesh digests) differ from Node's for the same case and
 * variant, which also catches a missing or extra call.
 */
export function headedStatus(
  result: PageResultView,
  expectedCalls: readonly string[],
): Readonly<{ status: VizV4Status; reason: string }> {
  const calls = result.meshCalls.map(callKey).sort();
  if (calls.join('\n') !== expectedCalls.join('\n'))
    return {
      status: 'MESH-MISMATCH',
      reason: `browser [${calls.join(', ')}], node [${expectedCalls.join(', ')}]`,
    };
  return classify({
    calls: result.meshCalls,
    notices: result.notices,
    drawn: result.meshTriangles > 0,
  });
}
