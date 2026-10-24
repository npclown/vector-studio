// V-4 unit VZ4-U1: Node-side case handling for the A08 corpus page
// (docs/plans/viz-v4-a08-corpus-contract.md, sections 4.4 and 5.1): the page input of a subset
// case, the E3 freeze guard, the expected status from the product CPU path, and the headed status
// of a page result. Gates are not evaluated here (VZ4-U2).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { FillMeshPort, StrokeMeshPort } from '@vector-studio/contracts';

import {
  meshDigestBytes,
  type VizV4CaseInput,
  type VizV4MeshCall,
} from '../../../apps/playground/src/viz-v4-a08-cases.js';
import { decodeCase, drawCase, type HarnessPorts } from '../../geometry/e3-a04/harness.js';
import type { A08Case } from './subset.js';

/** The statuses of section 4.4; PASS, FAIL and UNDECIDED are offline judgments, not statuses. */
export type VizV4Status =
  'RENDERED' | 'KERNEL-REJECTED' | 'REGION-ONLY' | 'EMPTY-CROP' | 'MESH-MISMATCH';

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

const REGION_ONLY_CODES = new Set(['fringe-work-cap', 'fringe-unsupported']);

/**
 * The expected status of a case under a fringe variant, from the product CPU path (E3's
 * `drawCase`, which wires the mirror, the scene source and PathMeshPipeline with the exact fringe
 * builder as PrimitiveRendererService does). Under `msaa-4x` there is no fringe, so REGION-ONLY
 * becomes RENDERED. MESH-MISMATCH is never expected.
 */
export function expectedStatus(
  c: A08Case,
  ports: HarnessPorts,
  variant: VizV4Variant,
): VizV4Status {
  const outcome = drawCase(c.kase, ports);
  const regionOnly = outcome.notices.some((notice) =>
    REGION_ONLY_CODES.has(notice.slice(notice.indexOf(':') + 1)),
  );
  if (outcome.kind === 'rejected') return 'KERNEL-REJECTED';
  if (outcome.kind === 'empty' || outcome.kind === 'culled') return 'EMPTY-CROP';
  return regionOnly && variant !== 'msaa-4x' ? 'REGION-ONLY' : 'RENDERED';
}

/** The page's result fields this module reads. */
export type PageResultView = Readonly<{
  notices: readonly string[];
  meshTriangles: number;
  meshCalls: readonly VizV4MeshCall[];
}>;

/** Port failure codes; a notice with one of them means the kernel rejected the path. */
const PORT_FAILURES = new Set([
  'invalid-path',
  'invalid-tolerance',
  'numeric-range',
  'work-limit',
  'unsupported-geometry',
  'invalid-stroke',
]);

/** The digest outcome Node's own port gives for a request the page made. */
export function nodeOutcome(
  call: VizV4MeshCall,
  ports: Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>,
): string {
  const r = call.request;
  const result =
    r.paint === 'fill'
      ? ports.fill.buildFillMeshes([
          {
            requestId: 1,
            verbs: Uint8Array.from(r.verbs),
            points: Float64Array.from(r.points),
            fillRule: r.fillRule,
            toleranceExponent: r.toleranceExponent,
          },
        ])
      : ports.stroke.buildStrokeMeshes([
          {
            requestId: 1,
            verbs: Uint8Array.from(r.verbs),
            points: Float64Array.from(r.points),
            width: r.width,
            cap: r.cap as 'butt' | 'round' | 'square',
            join: r.join as 'miter' | 'round' | 'bevel',
            miterLimit: r.miterLimit,
            toleranceExponent: r.toleranceExponent,
          },
        ]);
  if (result.status !== 'ok') return `batch:${result.status}`;
  const one = result.results[0]!;
  if (one.status === 'ok')
    return `ok:${createHash('sha256').update(meshDigestBytes(one.mesh)).digest('hex')}`;
  return one.status === 'empty' ? 'empty' : `failed:${one.code}`;
}

/** The headed status of a page result (section 4.4), with its reason. */
export function headedStatus(
  result: PageResultView,
  ports: Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }>,
): Readonly<{ status: VizV4Status; reason: string }> {
  for (const call of result.meshCalls) {
    const node = nodeOutcome(call, ports);
    if (node !== call.outcome)
      return { status: 'MESH-MISMATCH', reason: `browser ${call.outcome}, node ${node}` };
  }
  // A port failure, or any other failure that left nothing drawn (E3's drawCase "rejected").
  const rejected =
    result.notices.find((code) => PORT_FAILURES.has(code)) ??
    (result.meshTriangles === 0
      ? result.notices.find((code) => !REGION_ONLY_CODES.has(code))
      : undefined);
  if (rejected !== undefined) return { status: 'KERNEL-REJECTED', reason: rejected };
  const regionOnly = result.notices.find((code) => REGION_ONLY_CODES.has(code));
  if (regionOnly !== undefined) return { status: 'REGION-ONLY', reason: regionOnly };
  if (result.meshTriangles === 0) return { status: 'EMPTY-CROP', reason: 'no mesh triangle drawn' };
  return { status: 'RENDERED', reason: '' };
}
