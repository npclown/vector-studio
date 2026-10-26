// A03 stroke rejection diagnostic: writes the failed stroke requests of an A01 corpus sweep
// record (`pnpm p3-exit:sweep --corpus`, `corpus.json`) as `P3STKIN1` input of the native
// stroke dump (packages/geometry-wasm/kernel/src/stroke_dump_tests.rs), with a sidecar of each
// request's sweep outcome and corpus source, and the source of every named row with any non-ok
// stroke result (E11 section 7.2 lists named known defects row by row). Run through `pnpm a03:stroke-diag`, never in CI.
// The corpus is read only after its freeze record exists, as the sweep requires.
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import {
  computePathBuckets,
  E_MAX,
  STROKE_E_MIN,
} from '../../../packages/renderer-core/src/path-buckets.js';
import { iterateA04Corpus } from '../e3-a04/corpus.js';
import { decodeCase } from '../e3-a04/harness.js';

const VERB_CODE = { move: 0, line: 1, cubic: 2, close: 3 } as const;

const hex = (value: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

type Rejection = { id: string; outcome: string };

test('A03 stroke diagnostic input', () => {
  const record = process.env.A03_SWEEP_RECORD;
  const out = process.env.A03_STROKE_INPUT_OUT;
  expect(record, 'A03_SWEEP_RECORD is required').toBeTruthy();
  expect(out, 'A03_STROKE_INPUT_OUT is required').toBeTruthy();
  const sweep = JSON.parse(readFileSync(record!, 'utf8')) as {
    phase: string;
    strokeRejections?: Rejection[];
  };
  expect(sweep.phase).toBe('corpus');
  expect(sweep.strokeRejections, 'a sweep record with strokeRejections').toBeDefined();
  // `work-limit` is the closed-list class already; only the other failures are diagnosed,
  // unless A03_STROKE_ALL asks for every failed request.
  const all = process.env.A03_STROKE_ALL === '1';
  const wanted = new Map(
    sweep
      .strokeRejections!.filter(
        (r) => r.outcome.startsWith('failed:') && (all || r.outcome !== 'failed:work-limit'),
      )
      .map((r) => [r.id, r]),
  );
  // `<stratum>/<row>` of every named row with a non-ok stroke result, to its corpus source.
  const rowOf = (id: string) => id.split('/').slice(0, 2).join('/');
  const namedSources: Record<string, string> = Object.fromEntries(
    sweep
      .strokeRejections!.map((r) => rowOf(r.id))
      .filter((row) => !/\/g\d+$/u.test(row))
      .map((row) => [row, '']),
  );
  const rows = ['P3STKIN1'];
  const sidecar: Record<string, unknown> = {};
  for (const kase of iterateA04Corpus() as Iterable<A04Case>) {
    const d = decodeCase(kase);
    if (namedSources[rowOf(d.id)] === '')
      namedSources[rowOf(d.id)] = (kase as { source?: string }).source ?? '';
    const rejection = wanted.get(d.id);
    if (rejection === undefined || d.stroke === null) continue;
    // The served request, as the sweep makes it (V3 section c).
    const [a, c, b, dd] = d.transform;
    const buckets = computePathBuckets([a, c, b, dd], d.zoom, d.dpr);
    if (buckets.singular) throw new Error(`${d.id}: a rejected request cannot be singular`);
    const unclamped = buckets.e - d.servedOffset;
    expect(unclamped >= STROKE_E_MIN, d.id).toBe(true);
    const e = Math.min(unclamped, E_MAX);
    // name, exponent, width, cap, join, miter limit, verb digits, points (stroke_dump_tests.rs).
    rows.push(
      [
        d.id,
        e,
        hex(d.stroke.width),
        d.stroke.cap,
        d.stroke.join,
        hex(d.stroke.miterLimit),
        d.verbs.map((v) => VERB_CODE[v]).join(''),
        d.points.map(hex).join(','),
      ].join('\t'),
    );
    sidecar[d.id] = {
      outcome: rejection.outcome,
      source: (kase as { source?: string }).source ?? '',
      segments: d.verbs.filter((v) => v === 'line' || v === 'cubic').length,
    };
    wanted.delete(d.id);
  }
  expect([...wanted.keys()], 'rejections not found in the corpus').toEqual([]);
  writeFileSync(`${out}.txt`, `${rows.join('\n')}\n`);
  writeFileSync(`${out}.side.json`, JSON.stringify(sidecar));
  writeFileSync(`${out}.named.json`, JSON.stringify(namedSources));
});
