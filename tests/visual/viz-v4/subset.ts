// V-4 unit VZ4-U1: the A08 corpus subset (docs/plans/viz-v4-a08-corpus-contract.md, section 3).
// The subset is a declared selection of the named rows of `a04-corpus/v1` at z = 1 with the
// centre placement and no served offset. A case key is the A04 case id of the row, transform
// and z = 1 pair plus the V-4 DPR. DPR 2 and 3 take the A04 case at that DPR; DPR 1 and 1.5 take
// the DPR 1 case, re-projected for 1.5 by changing only `camera.dpr` (O02's rule: geometry,
// transform, camera and origin are unchanged). No kernel runs here.
import { createHash } from 'node:crypto';

import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import {
  A04_CORPUS_VERSION,
  hex,
  iterateA04Corpus,
  namedRows,
  serializeCase,
  type CanonicalCase,
  type Stratum,
  type TransformId,
} from '../../geometry/e3-a04/corpus.js';

export const A08_SUBSET_VERSION = 'a08-subset/v1';

/** The V-4 DPRs: 1, 1.5 and 2 are gated; 3 is observed only (V3 section k). */
export const A08_DPRS = [1, 1.5, 2, 3] as const;
export type A08Dpr = (typeof A08_DPRS)[number];
export const A08_GATED_DPRS: readonly A08Dpr[] = [1, 1.5, 2];

export type A08Role = 'gated' | 'reported';

/** One part of the section 3 table. */
export type A08Part = Readonly<{
  id: string;
  strata: readonly Stratum[];
  transforms: readonly TransformId[];
  role: A08Role;
}>;

export const A08_PARTS: readonly A08Part[] = [
  {
    id: 'C1-named-fill-lines',
    strata: ['C1'],
    transforms: ['T0', 'T2', 'T5', 'T7'],
    role: 'gated',
  },
  {
    id: 'C3-named-fill-cubics',
    strata: ['C3'],
    transforms: ['T0', 'T2', 'T5', 'T7'],
    role: 'gated',
  },
  { id: 'C4-near-coincidence', strata: ['C4'], transforms: ['T0', 'T2'], role: 'gated' },
  { id: 'C12-t-junction-fills', strata: ['C12'], transforms: ['T2', 'T6'], role: 'gated' },
  { id: 'C11-region-only-fills', strata: ['C11'], transforms: ['T0'], role: 'reported' },
  { id: 'C5-C9-named-strokes', strata: ['C5', 'C9'], transforms: ['T0', 'T3'], role: 'reported' },
];

export type A08Case = Readonly<{
  /** `<A04 case id>@dpr<D>`, the A08 case key. */
  key: string;
  /** The A04 case id this case is taken from (the DPR 1 id for DPR 1.5). */
  a04Id: string;
  part: string;
  /** Gated only at a gated DPR of a gated part; DPR 3 is observed. */
  gated: boolean;
  dpr: A08Dpr;
  kase: A04Case;
}>;

export function a08CaseKey(a04Id: string, dpr: A08Dpr): string {
  return `${a04Id}@dpr${String(dpr)}`;
}

function field<T>(value: CanonicalCase, key: string): T {
  if (!(key in value)) throw new Error(`a04 case lacks ${key}`);
  return value[key] as T;
}

/** The DPR 1 case at d = 1.5: only `camera.dpr` changes. */
function reproject(kase: CanonicalCase, dpr: number): CanonicalCase {
  const camera = field<Record<string, unknown>>(kase, 'camera');
  return { ...kase, camera: { ...camera, dpr: hex(dpr) } };
}

function namedRowIds(): ReadonlySet<string> {
  const rows = namedRows();
  const ids = new Set<string>();
  for (const list of Object.values(rows))
    for (const row of list) ids.add(`${row.stratum}/${row.row}`);
  return ids;
}

/**
 * Every A08 case in corpus order, as section 3 defines. The corpus emits a row's z = 1 pairs
 * d = 1, 2, 3 consecutively, so a row-transform's cases come out as DPR 1, 1.5, 2, 3.
 */
export function a08Subset(): A08Case[] {
  const named = namedRowIds();
  const partOf = new Map<string, A08Part>();
  for (const part of A08_PARTS) for (const stratum of part.strata) partOf.set(stratum, part);
  const out: A08Case[] = [];
  for (const kase of iterateA04Corpus()) {
    const stratum = field<Stratum>(kase, 'stratum');
    const part = partOf.get(stratum);
    if (part === undefined) continue;
    // C11 and C12 have named rows only; the other strata mix named and generated rows.
    if (
      stratum !== 'C11' &&
      stratum !== 'C12' &&
      !named.has(`${stratum}/${field<string>(kase, 'row')}`)
    )
      continue;
    if (!part.transforms.includes(field<TransformId>(kase, 'transform'))) continue;
    if (field<string>(kase, 'placement') !== 'center' || field<number>(kase, 'servedOffset') !== 0)
      continue;
    const id = field<string>(kase, 'id');
    const camera = field<{ zoom: string; dpr: string }>(kase, 'camera');
    if (camera.zoom !== hex(1)) continue;
    const pick = (dpr: A08Dpr, source: CanonicalCase) =>
      out.push({
        key: a08CaseKey(id, dpr),
        a04Id: id,
        part: part.id,
        gated: part.role === 'gated' && A08_GATED_DPRS.includes(dpr),
        dpr,
        kase: source,
      });
    if (camera.dpr === hex(1)) {
      pick(1, kase);
      pick(1.5, reproject(kase, 1.5));
    } else if (camera.dpr === hex(2)) pick(2, kase);
    else if (camera.dpr === hex(3)) pick(3, kase);
  }
  return out;
}

export type A08SubsetSummary = Readonly<{
  version: string;
  a04CorpusVersion: string;
  cases: number;
  gatedCases: number;
  byPart: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** SHA-256 of the case keys, one per line with LF, in subset order. */
  keysSha256: string;
  /** SHA-256 of the cases' canonical serialization (E3 section 5.1), one per line, in order. */
  casesSha256: string;
}>;

export function summarizeA08Subset(cases: readonly A08Case[]): A08SubsetSummary {
  const byPart: Record<string, Record<string, number>> = {};
  for (const part of A08_PARTS)
    byPart[part.id] = Object.fromEntries(A08_DPRS.map((dpr) => [`dpr${String(dpr)}`, 0]));
  for (const c of cases) byPart[c.part]![`dpr${String(c.dpr)}`]! += 1;
  const sha = (lines: readonly string[]) =>
    createHash('sha256')
      .update(lines.map((line) => `${line}\n`).join(''))
      .digest('hex');
  return {
    version: A08_SUBSET_VERSION,
    a04CorpusVersion: A04_CORPUS_VERSION,
    cases: cases.length,
    gatedCases: cases.filter((c) => c.gated).length,
    byPart,
    keysSha256: sha(cases.map((c) => c.key)),
    casesSha256: sha(cases.map((c) => `${c.key} ${serializeCase(c.kase)}`)),
  };
}
