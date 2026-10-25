// X1: the A03 evidence map and the cargo-prefix evaluation it adds, without running the mapped
// tests. The run over the mapped tests is `pnpm p3-exit:a03`.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkMap, evaluate, type EvidenceMap } from '../../tooling/p3-exit-a05-a06.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
const map = JSON.parse(read('tooling/p3-exit-a03-map.json')) as EvidenceMap;
const io = { exists: (p: string) => existsSync(path.join(root, p)), read };

/** The file's source and the shared suites it imports from tests/support. */
function sources(file: string): string {
  const text = read(file);
  const support = [...text.matchAll(/from '\.\.\/support\/([\w-]+)\.js'/gu)].map((m) =>
    read(`tests/support/${m[1]}.ts`),
  );
  return [text, ...support].join('\n');
}

describe('p3-exit A03 map', () => {
  it('passes its own structure check, including every cargo test-function prefix', () => {
    expect(checkMap(map, io)).toEqual([]);
  });

  it('names a test title literally for every vitest each prefix', () => {
    const missing: string[] = [];
    for (const entry of map.criteria.A03!) {
      if (!entry.each || !entry.file) continue;
      const text = sources(entry.file);
      for (const prefix of entry.each)
        if (![`'${prefix}`, `\`${prefix}`, `"${prefix}`].some((open) => text.includes(open)))
          missing.push(`${entry.id}: ${prefix}`);
    }
    expect(missing).toEqual([]);
  });

  it('names every fixture set of the E11 section 7 row A03', () => {
    const ids = (kind: string) => map.criteria.A03!.filter((e) => e.kind === kind).map((e) => e.id);
    expect(ids('required')).toEqual([
      'ST-F1 to ST-F14, ST-F21 to ST-F26 (kernel, line strokes)',
      'ST-F15 to ST-F20 (kernel, cubic strokes)',
      'ST-F1 to ST-F26 with ST-O1 to ST-O5 (dump hand-off)',
      'ST-O1 to ST-O5 oracle, fixtures and positive controls',
      'SC01-SC22 (release WASM)',
      'SC01-SC22 (test double)',
      'ST-A10 probes (scene validation)',
      'ST-A10 probes (stroke pipeline)',
    ]);
    expect(ids('headed').map((id) => id.split(' ')[0])).toEqual(['ST-U6', 'ST-U7', 'B2']);
  });

  it('covers ST-F1 to ST-F26 in the kernel prefixes', () => {
    const covered = new Set<number>();
    for (const entry of map.criteria.A03!.filter((e) => e.runner === 'cargo'))
      for (const prefix of entry.each ?? []) {
        // st_f21_to_f24_ covers 21..24, st_f7_f8_f9_ covers 7, 8 and 9.
        const numbers = [...prefix.matchAll(/f(\d+)/gu)].map((m) => Number(m[1]));
        const range = prefix.includes('_to_');
        for (let n = numbers[0]!; n <= numbers.at(-1)!; n++)
          if (range || numbers.includes(n)) covered.add(n);
      }
    expect([...covered].sort((a, b) => a - b)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
  });

  it('rejects a cargo prefix that names no test function and a criterion of another map', () => {
    const broken: EvidenceMap = {
      ...map,
      criteria: {
        A03: [
          {
            id: 'k',
            source: map.contract.split('#')[0]!,
            kind: 'required',
            runner: 'cargo',
            filter: 'stroke_outline_tests::',
            each: ['st_f99_'],
          },
        ],
        A05: [],
      },
    };
    expect(checkMap(broken, io)).toEqual([
      'A05: not a criterion of p3-exit-a03-map/v1',
      'A03 k: module has no test function st_f99_...',
    ]);
  });

  it('selects cargo tests by the prefix after the module and fails an unmatched prefix', () => {
    const small: EvidenceMap = {
      version: 'p3-exit-a03-map/v1',
      contract: 'c',
      criteria: {
        A03: [
          {
            id: 'k',
            source: 's',
            kind: 'required',
            runner: 'cargo',
            filter: 'm_tests::',
            each: ['st_f1_', 'st_f2_'],
          },
          { id: 'h', source: 's', kind: 'headed', runner: 'headed', file: 'p.spec.ts' },
        ],
      },
    };
    const tests = [
      { name: 'm_tests::st_f1_caps', status: 'passed' },
      { name: 'm_tests::st_f2_joins', status: 'passed' },
      { name: 'm_tests::st_f3_failing', status: 'FAILED' },
      { name: 'other_tests::st_f1_x', status: 'FAILED' },
    ];
    const pass = evaluate(small, { cargo: { ok: true, tests } });
    expect(pass.rows.map((r) => [r.entry.id, r.verdict, r.selected])).toEqual([
      ['k', 'PASS', 2],
      ['h', 'HEADED', 0],
    ]);
    expect(pass.criteria).toEqual({ A03: 'PASS (CI part; headed part cited separately)' });
    const fail = evaluate(small, { cargo: { ok: true, tests: tests.slice(0, 1) } });
    expect(fail.rows[0]!.failures).toEqual(['no test titled "st_f2_..."']);
    expect(fail.criteria.A03).toBe('FAIL');
  });
});
