import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareRecords,
  identityCheck,
  parseArguments,
  renderMarkdown,
} from '../../tooling/compare-p3-b0-records.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const OLD_RECORD = path.join(
  root,
  'docs/benchmarks/results/2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.json',
);
// The fields these tests tamper with; analysis.ts owns the full record schema.
interface TestRecord {
  scenario: { configHash: string };
  run: { runId: string };
  environment: { cpu: string };
  corpus: { sha256: string };
  repetitions: {
    cells: { cell: string; checksums: string[]; pathNs: number[] }[];
    admission: { cell: string; paths: { status: string }[] }[];
  }[];
  diagnostic: { observations: { paths: { status: string }[] }[] };
}
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing record field');
  return value;
}
const load = (): TestRecord => JSON.parse(readFileSync(OLD_RECORD, 'utf8')) as TestRecord;

describe('P3 B0 record comparison (B0R U8)', () => {
  it('passes the identity check for a record against itself', () => {
    const result = identityCheck(load(), load());
    expect(result.differences).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('reports a changed checksum and a changed admission by field', () => {
    const tampered = load();
    const rep = need(tampered.repetitions[1]);
    const timed = need(rep.cells[3]);
    const sums = timed.checksums;
    sums[0] = `${need(sums[0])}00`;
    const admission = need(need(tampered.repetitions[0]).admission[0]);
    need(admission.paths[0]).status = 'Topology(Tampered)';
    const result = identityCheck(load(), tampered);
    expect(result.pass).toBe(false);
    const fields = result.differences.map((item) => item.field);
    expect(fields).toContain(`repetitions[1].cells[${timed.cell}].checksums`);
    expect(fields).toContain(`repetitions[0].admission[${admission.cell}]`);
    expect(fields).toContain('firstAdmissionHash');
  });

  it('reports configuration, corpus and observation differences and ignores timings', () => {
    const changed = load();
    changed.scenario.configHash = '0'.repeat(64);
    changed.corpus.sha256 = '1'.repeat(64);
    need(need(changed.diagnostic.observations[0]).paths[0]).status = 'OK2';
    changed.run.runId = 'other';
    changed.environment.cpu = 'other';
    const timings = need(need(need(changed.repetitions[0]).cells[0]).pathNs);
    timings[0] = need(timings[0]) + 1;
    const fields = identityCheck(load(), changed).differences.map((item) => item.field);
    expect(fields).toEqual(expect.arrayContaining(['scenario.configHash', 'corpus.sha256']));
    expect(fields.some((field) => field.startsWith('diagnostic.observations['))).toBe(true);
    expect(fields.some((field) => /run.|environment|pathNs/.test(field))).toBe(false);
  });

  it('yields ratio 1 everywhere when a record is compared with itself', () => {
    const record = load();
    const report = compareRecords(record, record);
    const pairs = [
      ...report.cells.flatMap((cell) => [cell.batchMedianNs, cell.pathMedianNs]),
      ...report.fits.flatMap((fit) => [fit.slope, fit.estimateNs]),
      ...Object.values(report.estimates),
      ...report.stages.flatMap((stage) => [
        stage.flatten,
        stage.topology,
        stage.tessellation,
        stage.total,
        stage.exactShare,
        stage.overhead,
      ]),
    ];
    expect(report.cells).toHaveLength(34);
    expect(pairs.length).toBeGreaterThan(100);
    for (const item of pairs) {
      if (item.old === null) expect(item.ratio).toBeNull();
      else expect(item.ratio).toBe(1);
    }
    expect(report.verdict).toEqual({ old: 'INFEASIBLE', new: 'INFEASIBLE' });
    const markdown = renderMarkdown(report, identityCheck(record, record));
    expect(markdown).toContain('**PASS**');
    expect(markdown).toContain('not comparable with the first record');
  });

  it('parses the arguments', () => {
    expect(parseArguments(['--old', 'a', '--new', 'b', '--markdown', 'c'])).toEqual({
      old: 'a',
      new: 'b',
      markdown: 'c',
    });
    expect(() => parseArguments(['--old', 'a'])).toThrow(/usage/);
    expect(() => parseArguments(['--bogus'])).toThrow(/unknown/);
  });
});
