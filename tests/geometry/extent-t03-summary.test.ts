import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PREDICTION, summarize, type ReportRow } from './extent-t03/report.js';

/**
 * P3.1p T03 verdict logic (docs/plans/p3-r2-tiling-rev4-contract.md, "Verdict") on synthetic
 * rows: PASS, FAIL-AS-PREDICTED, and FAIL on a mismatched outcome, an unpredicted failure or a
 * failing afterC2 check.
 */

type Row = Record<string, unknown>;

function baseRows(): Row[] {
  const t01 = JSON.parse(readFileSync('docs/evidence/p3.1p-t01/report.json', 'utf8')) as {
    rows: ReportRow[];
  };
  const admittedO = t01.rows.filter(
    (row) =>
      row.corpus === 'O' &&
      row.candidate === 'K1' &&
      (row.sweep as { gamma: number }).gamma === 4 &&
      (row.sweep as { tTile: number }).tTile === 256 &&
      row.gammaModel === 'G8' &&
      row.dpr !== '3' &&
      row.outcome === 'ADMITTED',
  );
  const rows: Row[] = admittedO.map((row) => ({
    corpus: 'O',
    id: row.id,
    dpr: row.dpr,
    variantOf: null,
    outcome: 'ADMITTED',
    afterC2: null,
  }));
  for (const entry of PREDICTION.filter((p) => p.corpus === 'A'))
    rows.push({
      corpus: 'A',
      id: entry.id,
      dpr: '1',
      variantOf: 'base',
      outcome: 'ADMITTED',
      afterC2: null,
    });
  rows.push({
    corpus: 'A',
    id: 'EXT-65536',
    dpr: '1',
    variantOf: null,
    outcome: 'ADMITTED',
    afterC2: null,
  });
  return rows;
}

const clean = [{ coverageViolations: 0, subBandViolations: 0 }];

function failPredicted(rows: Row[]): Row[] {
  return rows.map((row) => {
    const entry = PREDICTION.find(
      (p) => p.corpus === row.corpus && p.id === row.id && p.dpr === row.dpr,
    );
    return entry === undefined
      ? row
      : { ...row, outcome: entry.outcome, afterC2: { partition: 'ok', lists: 'ok' } };
  });
}

describe('P3.1p T03 verdict', () => {
  it('PASS when every gate holds', () => {
    expect(summarize(baseRows(), clean).verdict).toBe('PASS');
  });

  it('FAIL-AS-PREDICTED when exactly the predicted rows fail with their outcomes', () => {
    const rows = failPredicted(baseRows());
    expect(rows.filter((row) => row.outcome !== 'ADMITTED').length).toBe(PREDICTION.length);
    expect(summarize(rows, clean).verdict).toBe('FAIL-AS-PREDICTED');
  });

  it('FAIL on a mismatched outcome, an unpredicted failure, afterC2 failure or coverage violation', () => {
    const predicted = failPredicted(baseRows());
    const mismatched = predicted.map((row) =>
      row.id === PREDICTION[0]!.id && row.dpr === '1'
        ? { ...row, outcome: 'NOT_ADMITTED:vertex' }
        : row,
    );
    expect(summarize(mismatched, clean).verdict).toBe('FAIL');
    const extra = predicted.map((row, index) =>
      index === 0 && row.corpus === 'O' && row.outcome === 'ADMITTED'
        ? { ...row, outcome: 'NOT_ADMITTED:edge' }
        : row,
    );
    expect(summarize(extra, clean).verdict).toBe('FAIL');
    const residual = predicted.map((row) =>
      row.afterC2 !== null
        ? { ...row, afterC2: { partition: 'edge-use:1:2', lists: 'not-run' } }
        : row,
    );
    expect(summarize(residual, clean).verdict).toBe('FAIL');
    expect(summarize(predicted, [{ coverageViolations: 0, subBandViolations: 1 }]).verdict).toBe(
      'FAIL',
    );
  });
});
