// D9 E16 cause diagnostic: writes the failed fill requests of an A01 corpus sweep record
// (`pnpm p3-exit:sweep --corpus`, `corpus.json`) as the native fill diagnostic's input
// (packages/geometry-wasm/kernel/src/e14_fill_limit_diag_tests.rs), with a sidecar of each
// request's sweep outcome and source sizes. Run through `pnpm e16:fill-diag`, never in CI.
// The corpus is read only after its freeze record exists, as the sweep requires.
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import type { A04Case } from '../../../packages/geometry-reference/src/a04-region.js';
import {
  computePathBuckets,
  E_MAX,
  E_MIN,
} from '../../../packages/renderer-core/src/path-buckets.js';
import { iterateA04Corpus } from '../e3-a04/corpus.js';
import { decodeCase } from '../e3-a04/harness.js';

const VERB_CODE = { move: 0, line: 1, cubic: 2, close: 3 } as const;

const hex = (value: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

type Rejection = { id: string; outcome: string; e14SelfCrossingOverE: boolean };

test('E16 fill diagnostic input', () => {
  const record = process.env.E16_SWEEP_RECORD;
  const out = process.env.E16_FILL_INPUT_OUT;
  expect(record, 'E16_SWEEP_RECORD is required').toBeTruthy();
  expect(out, 'E16_FILL_INPUT_OUT is required').toBeTruthy();
  const sweep = JSON.parse(readFileSync(record!, 'utf8')) as {
    phase: string;
    fillRejections: Rejection[];
  };
  expect(sweep.phase).toBe('corpus');
  const wanted = new Map(
    sweep.fillRejections.filter((r) => r.outcome.startsWith('failed:')).map((r) => [r.id, r]),
  );
  const rows: string[] = [];
  const sidecar: Record<string, unknown> = {};
  for (const kase of iterateA04Corpus() as Iterable<A04Case>) {
    const d = decodeCase(kase);
    const rejection = wanted.get(d.id);
    if (rejection === undefined || d.paint !== 'fill') continue;
    // The served request, as the sweep makes it (V3 section c).
    const [a, c, b, dd] = d.transform;
    const buckets = computePathBuckets([a, c, b, dd], d.zoom, d.dpr);
    if (buckets.singular) throw new Error(`${d.id}: a rejected request cannot be singular`);
    const unclamped = buckets.e - d.servedOffset;
    expect(unclamped >= E_MIN, d.id).toBe(true);
    const e = Math.min(unclamped, E_MAX);
    rows.push(
      [
        d.id,
        e,
        d.fillRule,
        d.verbs.map((v) => VERB_CODE[v]).join(','),
        d.points.map(hex).join(','),
      ].join('\t'),
    );
    sidecar[d.id] = {
      outcome: rejection.outcome,
      e14: rejection.e14SelfCrossingOverE,
      contours: d.verbs.filter((v) => v === 'move').length,
      segments: d.verbs.filter((v) => v === 'line' || v === 'cubic').length,
    };
    wanted.delete(d.id);
  }
  expect([...wanted.keys()], 'rejections not found in the corpus').toEqual([]);
  writeFileSync(`${out}.tsv`, `${rows.join('\n')}\n`);
  writeFileSync(`${out}.side.json`, JSON.stringify(sidecar));
});
